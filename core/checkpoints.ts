import type { ToolContext } from './types.ts'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

interface FileCheckpoint {
  id: string
  threadId: string
  messageId?: string
  timestamp: number
  filePath: string
  previousContent: string | null
}

interface RollbackOptions {
  messageId?: string
  timestamp?: string | number
}

const checkpoints: FileCheckpoint[] = []
const MAX_CHECKPOINTS = 500

// Checkpoints must survive worker recycling: the host restarts the background
// worker on every server hot-reload and app restart, so an in-memory-only list
// silently loses the ability to undo edits made before the restart. The store
// is a single JSON file under the extension storage dir, bounded in size so a
// long session cannot grow it without limit.
const STORE_FILE_NAME = 'edit-checkpoints.json'
const MAX_STORE_BYTES = 24 * 1024 * 1024

function resolveStorePath(): string {
  const base =
    process.env.MOMAI_EXTENSION_STORAGE_DIR ||
    (process.env.MOMAI_DATA_DIR
      ? path.join(process.env.MOMAI_DATA_DIR, 'extensions', 'momai-code')
      : path.join(os.tmpdir(), 'momai-code'))
  return path.join(base, STORE_FILE_NAME)
}

let storeLoaded = false

function loadFromDisk(): void {
  if (storeLoaded) return
  storeLoaded = true
  try {
    const storePath = resolveStorePath()
    if (!fs.existsSync(storePath)) return
    const raw = JSON.parse(fs.readFileSync(storePath, 'utf-8'))
    if (!Array.isArray(raw)) return
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue
      if (typeof entry.threadId !== 'string' || typeof entry.filePath !== 'string') continue
      if (typeof entry.timestamp !== 'number') continue
      checkpoints.push({
        id:
          typeof entry.id === 'string'
            ? entry.id
            : `chk_${entry.timestamp}_${Math.random().toString(36).slice(2, 7)}`,
        threadId: entry.threadId,
        messageId: typeof entry.messageId === 'string' ? entry.messageId : undefined,
        timestamp: entry.timestamp,
        filePath: entry.filePath,
        previousContent: typeof entry.previousContent === 'string' ? entry.previousContent : null
      })
    }
    if (checkpoints.length > MAX_CHECKPOINTS) {
      checkpoints.splice(0, checkpoints.length - MAX_CHECKPOINTS)
    }
  } catch {
    // A corrupt or unreadable store must never break the tools; it is
    // rewritten from the current session state on the next persist.
  }
}

function persistToDisk(): void {
  try {
    const storePath = resolveStorePath()
    fs.mkdirSync(path.dirname(storePath), { recursive: true })
    let payload = JSON.stringify(checkpoints)
    // Drop the oldest entries (memory included) until the file fits the cap.
    while (Buffer.byteLength(payload, 'utf-8') > MAX_STORE_BYTES && checkpoints.length > 1) {
      checkpoints.splice(0, Math.max(1, Math.ceil(checkpoints.length * 0.1)))
      payload = JSON.stringify(checkpoints)
    }
    const tmpPath = `${storePath}.tmp`
    fs.writeFileSync(tmpPath, payload, 'utf-8')
    fs.renameSync(tmpPath, storePath)
  } catch {
    // Best-effort durability: an unwritable store degrades to the previous
    // in-memory behavior instead of failing the edit that just happened.
  }
}

function recordCheckpoint(
  threadId: string,
  filePath: string,
  previousContent: string | null,
  messageId?: string
): FileCheckpoint {
  loadFromDisk()
  const entry: FileCheckpoint = {
    id: `chk_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    threadId: threadId || 'default',
    messageId,
    timestamp: Date.now(),
    filePath,
    previousContent
  }

  checkpoints.push(entry)
  if (checkpoints.length > MAX_CHECKPOINTS) {
    checkpoints.splice(0, checkpoints.length - MAX_CHECKPOINTS)
  }
  persistToDisk()

  return entry
}

function getCheckpoints(threadId?: string): FileCheckpoint[] {
  loadFromDisk()
  if (!threadId) return [...checkpoints]
  return checkpoints.filter((c) => c.threadId === threadId)
}

function clearCheckpoints(threadId?: string): void {
  loadFromDisk()
  if (!threadId) {
    checkpoints.length = 0
    persistToDisk()
    return
  }
  for (let i = checkpoints.length - 1; i >= 0; i--) {
    if (checkpoints[i].threadId === threadId) {
      checkpoints.splice(i, 1)
    }
  }
  persistToDisk()
}

function rollbackCheckpoints(
  threadId: string,
  options?: RollbackOptions
): { restoredCount: number; restoredFiles: string[] } {
  loadFromDisk()
  const tid = threadId || 'default'
  const restoredSet = new Set<string>()

  // Determine cutoff timestamp if provided
  let cutoffTimestamp: number | null = null
  if (options?.timestamp) {
    const parsed = new Date(options.timestamp).getTime()
    if (!Number.isNaN(parsed)) {
      cutoffTimestamp = parsed
    }
  }

  // Find checkpoints for this thread in reverse chronological order
  const toRollback: FileCheckpoint[] = []
  for (let i = checkpoints.length - 1; i >= 0; i--) {
    const cp = checkpoints[i]
    if (cp.threadId !== tid) continue

    if (cutoffTimestamp !== null && cp.timestamp < cutoffTimestamp) {
      break
    }

    toRollback.push(cp)
    checkpoints.splice(i, 1)
  }

  // Revert each checkpoint in reverse order
  for (const cp of toRollback) {
    try {
      if (cp.previousContent === null) {
        if (fs.existsSync(cp.filePath)) {
          fs.unlinkSync(cp.filePath)
          restoredSet.add(cp.filePath)
        }
      } else {
        fs.writeFileSync(cp.filePath, cp.previousContent, 'utf-8')
        restoredSet.add(cp.filePath)
      }
    } catch (err) {
      console.error(`[momai-code] Falha ao reverter checkpoint em ${cp.filePath}:`, err)
    }
  }
  persistToDisk()

  const restoredFiles = Array.from(restoredSet)
  return {
    restoredCount: restoredFiles.length,
    restoredFiles
  }
}

module.exports = {
  recordCheckpoint,
  getCheckpoints,
  clearCheckpoints,
  rollbackCheckpoints
}
