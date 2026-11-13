/**
 * Detached companion watchdog for background shells started by `momai-code`.
 *
 * Uses a double-spawn (trampoline -> daemon) so the daemon's `ParentProcessId`
 * belongs to an already-exited launcher process. That keeps the daemon alive
 * when Windows `taskkill /pid <nodeCorePid> /t /f` tears down the Node Core
 * process tree on hot reload or app quit, allowing it to kill every descendant
 * leaf (e.g. `node tools/dev.mjs` on port 4321) bottom-up as soon as the owner
 * process disappears.
 *
 * While the owner process is alive, the daemon also snapshots the OS process
 * table off the worker thread and records discovered descendant PIDs into
 * `processes/<id>.pids` so intermediate shell exits (`powershell` -> `npm` ->
 * `cmd` -> `node`) never break the parent-child chain.
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  killTree,
  collectDescendants,
  listProcessPairs,
  isAlive
} = require('./process-tree.cjs')

const ownerPid = Number(process.argv[2])
const storePath = String(process.argv[3] || '')
const launchId = String(process.argv[4] || '')
const isDaemon = process.argv[5] === '--daemon'

if (!Number.isFinite(ownerPid) || ownerPid <= 0 || !storePath || !launchId) {
  process.exit(0)
}

const storeDir = path.dirname(storePath)
const logDir = path.join(storeDir, 'processes')
const watchdogPidFile = path.join(storeDir, 'watchdog.pid')

function matchesLaunchToken() {
  try {
    if (!fs.existsSync(watchdogPidFile)) return false
    const raw = JSON.parse(fs.readFileSync(watchdogPidFile, 'utf-8'))
    return Boolean(raw && raw.launchId === launchId)
  } catch {
    return false
  }
}

if (!isDaemon) {
  if (!matchesLaunchToken()) {
    process.exit(0)
  }
  try {
    const child = spawn(
      process.execPath,
      [__filename, String(ownerPid), storePath, launchId, '--daemon'],
      {
        cwd: os.tmpdir(),
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      }
    )
    if (child.pid && matchesLaunchToken()) {
      fs.writeFileSync(
        watchdogPidFile,
        JSON.stringify({ pid: child.pid, ownerPid, launchId, startedAt: Date.now() }),
        'utf-8'
      )
    }
    child.unref()
  } catch {
    /* best-effort companion */
  }
  process.exit(0)
}

/** @type {Map<string, { rootPid: number, pids: Set<number>, snapshots: number, lastSnapshotAt: number }>} */
const rememberedByEntry = new Map()
let idleTicks = 0
const MAX_IDLE_TICKS = 6
const TICK_MS = 400
const MAX_SNAPSHOTS_PER_ENTRY = 4
const SNAPSHOT_INTERVAL_MS = 1200

function claimWatchdogPidFile() {
  try {
    if (!matchesLaunchToken()) return false
    fs.writeFileSync(
      watchdogPidFile,
      JSON.stringify({ pid: process.pid, ownerPid, launchId, startedAt: Date.now() }),
      'utf-8'
    )
    return true
  } catch {
    return false
  }
}

function isStillActiveWatchdog() {
  try {
    if (!fs.existsSync(watchdogPidFile)) return false
    const raw = JSON.parse(fs.readFileSync(watchdogPidFile, 'utf-8'))
    return Boolean(raw && raw.launchId === launchId && (raw.pid === process.pid || raw.pid === 0))
  } catch {
    return false
  }
}

function cleanupWatchdogPidFile() {
  try {
    if (!fs.existsSync(watchdogPidFile)) return
    const raw = JSON.parse(fs.readFileSync(watchdogPidFile, 'utf-8'))
    if (!raw || raw.launchId === launchId || raw.pid === process.pid) {
      fs.unlinkSync(watchdogPidFile)
    }
  } catch {
    /* ignore */
  }
}

function pidFilePath(id) {
  return path.join(logDir, `${id}.pids`)
}

function readPidFile(id) {
  try {
    const file = pidFilePath(id)
    if (!fs.existsSync(file)) return []
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)
  } catch {
    return []
  }
}

function writePidFile(id, pids) {
  try {
    fs.mkdirSync(logDir, { recursive: true })
    fs.writeFileSync(pidFilePath(id), JSON.stringify(pids), 'utf-8')
  } catch {
    /* ignore */
  }
}

function readStoreEntries() {
  try {
    if (!fs.existsSync(storePath)) return []
    const raw = JSON.parse(fs.readFileSync(storePath, 'utf-8'))
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

function getOrCreateTracked(entry) {
  let tracked = rememberedByEntry.get(entry.id)
  if (!tracked) {
    tracked = { rootPid: entry.pid, pids: new Set(), snapshots: 0, lastSnapshotAt: 0 }
    rememberedByEntry.set(entry.id, tracked)
  }
  if (Array.isArray(entry.pids)) {
    for (const p of entry.pids) {
      if (typeof p === 'number' && Number.isFinite(p) && p > 0 && p !== entry.pid) {
        tracked.pids.add(p)
      }
    }
  }
  for (const p of readPidFile(entry.id)) {
    if (p !== entry.pid) tracked.pids.add(p)
  }
  return tracked
}

function shouldSnapshotEntry(entry, now) {
  const tracked = getOrCreateTracked(entry)
  if (tracked.snapshots >= MAX_SNAPSHOTS_PER_ENTRY) return false
  if (tracked.snapshots === 0) {
    const age = now - (typeof entry.startedAt === 'number' ? entry.startedAt : 0)
    return !isAlive(entry.pid) || age >= 400
  }
  return now - tracked.lastSnapshotAt >= SNAPSHOT_INTERVAL_MS
}

function recordEntryDescendants(entry, pairs, now) {
  if (!entry || typeof entry.id !== 'string' || typeof entry.pid !== 'number') return false
  const tracked = getOrCreateTracked(entry)
  const beforeSize = tracked.pids.size

  if (Array.isArray(pairs)) {
    const roots = [entry.pid, ...tracked.pids]
    const descendants = collectDescendants(roots, pairs)
    for (const p of descendants) {
      if (p !== entry.pid) tracked.pids.add(p)
    }
    tracked.snapshots += 1
    tracked.lastSnapshotAt = now
  }

  if (tracked.pids.size !== beforeSize) {
    writePidFile(entry.id, [...tracked.pids])
  }

  if (isAlive(entry.pid)) return true
  for (const p of tracked.pids) {
    if (isAlive(p)) return true
  }
  return false
}

function killAllTrackedOnOwnerDeath() {
  const entries = readStoreEntries()
  let pairs
  const handledIds = new Set()
  let dirty = false

  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.pid !== 'number') continue
    handledIds.add(entry.id)
    if (entry.status === 'stopped' && entry.reaped === true) continue

    const tracked = rememberedByEntry.get(entry.id)
    const remembered = [
      ...new Set([
        ...(Array.isArray(entry.pids) ? entry.pids : []),
        ...readPidFile(entry.id),
        ...(tracked ? [...tracked.pids] : [])
      ])
    ].filter((p) => Number.isFinite(p) && p > 0 && p !== entry.pid)

    const needsSnapshot = !isAlive(entry.pid) || remembered.some((p) => !isAlive(p))
    if (needsSnapshot && !pairs) {
      pairs = listProcessPairs()
    }

    const killed = killTree(entry.pid, remembered, needsSnapshot ? pairs : undefined)
    if (killed > 0 || entry.status === 'running' || !entry.reaped) {
      entry.status = 'stopped'
      entry.endedAt = entry.endedAt || Date.now()
      entry.reaped = true
      if (remembered.length > 0) entry.pids = remembered
      dirty = true
    }
  }

  // Also kill any entry remembered in memory that wasn't in the latest store snapshot.
  for (const [id, tracked] of rememberedByEntry.entries()) {
    if (handledIds.has(id)) continue
    const remembered = [...tracked.pids]
    const needsSnapshot = !isAlive(tracked.rootPid) || remembered.some((p) => !isAlive(p))
    if (needsSnapshot && !pairs) {
      pairs = listProcessPairs()
    }
    killTree(tracked.rootPid, remembered, needsSnapshot ? pairs : undefined)
  }

  if (dirty) {
    try {
      fs.writeFileSync(storePath, JSON.stringify(entries), 'utf-8')
    } catch {
      /* ignore */
    }
  }
}

function tick() {
  if (!isStillActiveWatchdog()) {
    process.exit(0)
  }

  if (!isAlive(ownerPid)) {
    killAllTrackedOnOwnerDeath()
    cleanupWatchdogPidFile()
    process.exit(0)
  }

  const entries = readStoreEntries()
  const candidates = entries.filter(
    (entry) =>
      entry &&
      typeof entry.id === 'string' &&
      typeof entry.pid === 'number' &&
      entry.status !== 'stopped' &&
      entry.reaped !== true
  )

  if (candidates.length === 0) {
    idleTicks += 1
    if (idleTicks >= MAX_IDLE_TICKS) {
      cleanupWatchdogPidFile()
      process.exit(0)
    }
    setTimeout(tick, TICK_MS)
    return
  }

  const now = Date.now()
  const wantSnapshot = candidates.some((entry) => shouldSnapshotEntry(entry, now))
  const pairs = wantSnapshot ? listProcessPairs() : undefined
  let anyAlive = false
  for (const entry of candidates) {
    const usePairs = pairs && shouldSnapshotEntry(entry, now) ? pairs : undefined
    if (recordEntryDescendants(entry, usePairs, now)) {
      anyAlive = true
    }
  }

  if (anyAlive) {
    idleTicks = 0
  } else {
    idleTicks += 1
    if (idleTicks >= MAX_IDLE_TICKS) {
      cleanupWatchdogPidFile()
      process.exit(0)
    }
  }

  setTimeout(tick, TICK_MS)
}

if (!claimWatchdogPidFile()) {
  process.exit(0)
}
setTimeout(tick, 300)

