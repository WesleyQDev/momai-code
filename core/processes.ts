const { spawn } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
import type { MomAiCodeSettings } from './types.ts'
const { buildShellInvocation } = require('./shell.ts')
const { killProcessTree, killActiveForegroundProcesses } = require('./process-runner.ts')
const { listProcessPairs, killOne } = require('./process-tree.cjs')

export type BackgroundStatus = 'running' | 'exited' | 'stopped'

export interface BackgroundProcess {
  id: string
  pid: number
  /** Descendant PIDs recorded while running so leaves can be killed after intermediate shells exit. */
  pids?: number[]
  /** Host/worker PID that started this process. */
  ownerPid?: number
  /** True once `reapOrphanedProcesses` has swept this entry. */
  reaped?: boolean
  command: string
  cwd: string
  threadId?: string
  /** Absolute path of the streaming output file. */
  file: string
  startedAt: number
  status: BackgroundStatus
  exitCode?: number | null
  endedAt?: number
  /** `true` when the command outlived its foreground timeout. */
  promoted?: boolean
}

const STORE_FILE_NAME = 'processes.json'
const WATCHDOG_PID_FILE_NAME = 'watchdog.pid'
const LOG_DIR_NAME = 'processes'
const MAX_ENTRIES = 40
/** Bounded sweep: all entries share a single process snapshot per reap call. */
const MAX_REAP_ENTRIES = 8
const MAX_OUTPUT_BYTES = 64 * 1024

const registry = new Map<string, BackgroundProcess>()
let storeLoaded = false
let watchdogLaunchTimer: ReturnType<typeof setTimeout> | null = null

function resolveStorageBase(): string {
  return (
    process.env.MOMAI_EXTENSION_STORAGE_DIR ||
    (process.env.MOMAI_DATA_DIR
      ? path.join(process.env.MOMAI_DATA_DIR, 'extensions', 'momai-code')
      : path.join(os.tmpdir(), 'momai-code'))
  )
}

function resolveLogDir(): string {
  const dir = path.join(resolveStorageBase(), LOG_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function resolveStorePath(): string {
  return path.join(resolveStorageBase(), STORE_FILE_NAME)
}

function resolveWatchdogPidPath(): string {
  return path.join(resolveStorageBase(), WATCHDOG_PID_FILE_NAME)
}

function resolvePidSidecarPath(id: string): string {
  return path.join(resolveLogDir(), `${id}.pids`)
}

function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readPidSidecar(id: string): number[] {
  try {
    const file = resolvePidSidecarPath(id)
    if (!fs.existsSync(file)) return []
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((value) => typeof value === 'number' && Number.isFinite(value) && value > 0)
  } catch {
    return []
  }
}

function getRememberedPids(entry: BackgroundProcess): number[] {
  const fromEntry = Array.isArray(entry.pids) ? entry.pids : []
  const fromSidecar = readPidSidecar(entry.id)
  const merged = [...new Set([...fromEntry, ...fromSidecar])].filter(
    (pid) => typeof pid === 'number' && Number.isFinite(pid) && pid > 0 && pid !== entry.pid
  )
  if (merged.length > 0) {
    entry.pids = merged
  }
  return merged
}

function isEntryAlive(entry: BackgroundProcess): boolean {
  if (isAlive(entry.pid)) return true
  const remembered = getRememberedPids(entry)
  return remembered.some((pid) => isAlive(pid))
}

function hasActiveRunningEntry(): boolean {
  for (const entry of registry.values()) {
    if (entry.status === 'running' && isEntryAlive(entry)) return true
  }
  return false
}

function spawnWatchdogNow(): void {
  try {
    if (!hasActiveRunningEntry()) return
    const pidFile = resolveWatchdogPidPath()
    if (fs.existsSync(pidFile)) {
      const info = JSON.parse(fs.readFileSync(pidFile, 'utf-8'))
      if (
        info &&
        info.ownerPid === process.pid &&
        typeof info.pid === 'number' &&
        (info.pid === 0 || isAlive(info.pid))
      ) {
        return
      }
    }
    const watchdogScript = [
      path.join(__dirname, 'process-watchdog.cjs'),
      path.join(__dirname, '..', 'core', 'process-watchdog.cjs')
    ].find((candidate) => fs.existsSync(candidate))
    if (!watchdogScript) return

    const launchId = crypto.randomBytes(6).toString('hex')
    fs.mkdirSync(path.dirname(pidFile), { recursive: true })
    fs.writeFileSync(
      pidFile,
      JSON.stringify({ pid: 0, ownerPid: process.pid, launchId, startedAt: Date.now() }),
      'utf-8'
    )

    const child = spawn(
      process.execPath,
      [watchdogScript, String(process.pid), resolveStorePath(), launchId],
      {
        cwd: os.tmpdir(),
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      }
    )
    child.unref()
  } catch {
    // Watchdog is a safety net; never fail process startup if spawning it fails.
  }
}

function ensureWatchdogRunning(): void {
  if (watchdogLaunchTimer) return
  watchdogLaunchTimer = setTimeout(() => {
    watchdogLaunchTimer = null
    spawnWatchdogNow()
  }, 150)
  if (typeof (watchdogLaunchTimer as any)?.unref === 'function') {
    ;(watchdogLaunchTimer as any).unref()
  }
}

function stopWatchdogIfIdle(force = false): void {
  try {
    if (!force && hasActiveRunningEntry()) return
    if (watchdogLaunchTimer) {
      clearTimeout(watchdogLaunchTimer)
      watchdogLaunchTimer = null
    }
    const pidFile = resolveWatchdogPidPath()
    if (!fs.existsSync(pidFile)) return
    const info = JSON.parse(fs.readFileSync(pidFile, 'utf-8'))
    try {
      fs.unlinkSync(pidFile)
    } catch {
      /* already removed */
    }
    if (info && typeof info.pid === 'number' && info.pid > 0) {
      killOne(info.pid)
    }
  } catch {
    /* best-effort cleanup */
  }
}

function save(): void {
  try {
    const storePath = resolveStorePath()
    fs.mkdirSync(path.dirname(storePath), { recursive: true })
    const entries = [...registry.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, MAX_ENTRIES)
    fs.writeFileSync(storePath, JSON.stringify(entries), 'utf-8')
  } catch {
    // The registry is best-effort: losing it must never break the tool call.
  }
}

/**
 * The host recycles the background worker on server reloads, so running
 * processes are remembered on disk. Status transitions happen in
 * `refreshStatus` and `reapOrphanedProcesses` so an entry whose outer shell
 * exited is still swept for surviving grandchildren.
 */
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
      if (typeof entry.id !== 'string' || typeof entry.pid !== 'number') continue
      const status: BackgroundStatus =
        entry.status === 'running' || entry.status === 'stopped' || entry.status === 'exited'
          ? entry.status
          : 'exited'
      const pids = Array.isArray(entry.pids)
        ? entry.pids.filter((n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0)
        : undefined
      registry.set(entry.id, {
        id: entry.id,
        pid: entry.pid,
        ...(pids && pids.length > 0 ? { pids } : {}),
        ...(typeof entry.ownerPid === 'number' ? { ownerPid: entry.ownerPid } : {}),
        ...(entry.reaped === true ? { reaped: true } : {}),
        command: String(entry.command || ''),
        cwd: String(entry.cwd || ''),
        threadId: typeof entry.threadId === 'string' ? entry.threadId : undefined,
        file: String(entry.file || ''),
        startedAt: Number(entry.startedAt) || Date.now(),
        status,
        exitCode: typeof entry.exitCode === 'number' ? entry.exitCode : undefined,
        endedAt: typeof entry.endedAt === 'number' ? entry.endedAt : undefined,
        promoted: entry.promoted === true
      })
    }
  } catch {
    // A corrupt store only costs the list; never throw here.
  }
}

function refreshStatus(entry: BackgroundProcess): BackgroundProcess {
  if (entry.status === 'running' && !isEntryAlive(entry)) {
    entry.status = 'exited'
    entry.endedAt = entry.endedAt || Date.now()
    save()
  }
  return entry
}

function createLogFile(id: string): string {
  const file = path.join(resolveLogDir(), `${id}.log`)
  fs.writeFileSync(file, '', 'utf-8')
  return file
}

function register(
  partial: Omit<BackgroundProcess, 'status' | 'startedAt'> & Partial<Pick<BackgroundProcess, 'startedAt'>>
): BackgroundProcess {
  loadFromDisk()
  const entry: BackgroundProcess = {
    ...partial,
    ownerPid: partial.ownerPid ?? process.pid,
    startedAt: partial.startedAt ?? Date.now(),
    status: 'running'
  }
  registry.set(entry.id, entry)
  save()
  ensureWatchdogRunning()
  return entry
}

function markEnded(id: string, exitCode: number | null): void {
  const entry = registry.get(id)
  if (!entry) return
  if (entry.status === 'stopped') return
  const remembered = getRememberedPids(entry)
  entry.status = 'exited'
  entry.exitCode = exitCode
  entry.endedAt = Date.now()
  save()
  if (!remembered.some((pid) => isAlive(pid))) {
    stopWatchdogIfIdle()
  }
}

export interface StartedProcess {
  id: string
  pid: number
  file: string
  shell: string
}

/**
 * Starts a command detached from the tool call and returns immediately. The
 * child writes straight to a log file, so nothing has to stay attached to the
 * pipes and the chat is never blocked waiting for it.
 */
function startBackgroundProcess(
  command: string,
  cwd: string,
  options?: {
    shellPreference?: MomAiCodeSettings['shell']
    threadId?: string
    env?: NodeJS.ProcessEnv
  }
): StartedProcess {
  const { executable, args, name } = buildShellInvocation(command, options?.shellPreference)
  const id = `bg_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`
  const file = createLogFile(id)

  const out = fs.openSync(file, 'a')
  let child: any
  try {
    child = spawn(executable, args, {
      cwd,
      // On Windows `detached` makes the shell exit instantly with no output, so
      // the process group trick is only used where it actually helps (POSIX).
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', out, out],
      env: options?.env || process.env
    })
  } finally {
    fs.closeSync(out)
  }

  child.once('exit', (code: number | null) => markEnded(id, code))
  child.once('error', () => markEnded(id, null))
  child.unref()

  register({
    id,
    pid: child.pid,
    command,
    cwd,
    threadId: options?.threadId,
    file
  })

  return { id, pid: child.pid, file, shell: name }
}

/**
 * Keeps a foreground command alive when it outlives its timeout instead of
 * killing it. Whatever was already captured is flushed to the log, and the
 * remaining output keeps streaming there.
 */
function adoptRunningProcess(input: {
  child: any
  command: string
  cwd: string
  threadId?: string
  collected?: string
}): StartedProcess {
  const { child, command, cwd, threadId, collected } = input
  const id = `bg_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`
  const file = createLogFile(id)
  const stream = fs.createWriteStream(file, { flags: 'a' })

  if (collected) stream.write(collected)
  child?.stdout?.on('data', (chunk: Buffer) => stream.write(chunk))
  child?.stderr?.on('data', (chunk: Buffer) => stream.write(chunk))
  child.once('exit', (code: number | null) => {
    stream.end()
    markEnded(id, code)
  })

  register({ id, pid: child.pid, command, cwd, threadId, file, promoted: true })
  return { id, pid: child.pid, file, shell: '' }
}

function listProcesses(options?: { includeEnded?: boolean; threadId?: string }): BackgroundProcess[] {
  loadFromDisk()
  const all = [...registry.values()].map(refreshStatus)
  // A thread only ever sees its own shells: entries without a thread stay
  // visible to unfiltered callers (shutdown sweep, stop by id) but never leak
  // into another conversation.
  const scoped =
    typeof options?.threadId === 'string' && options.threadId
      ? all.filter((entry) => entry.threadId === options.threadId)
      : all
  const visible = options?.includeEnded ? scoped : scoped.filter((entry) => entry.status === 'running')
  return visible.sort((a, b) => b.startedAt - a.startedAt)
}

function getProcess(id: string): BackgroundProcess | null {
  loadFromDisk()
  const entry = registry.get(id)
  return entry ? refreshStatus(entry) : null
}

function stopProcess(id: string): { ok: boolean; process?: BackgroundProcess; error?: string } {
  const entry = getProcess(id)
  if (!entry) return { ok: false, error: `Processo ${id} não encontrado.` }
  if (entry.status !== 'running') {
    return { ok: false, error: `Processo ${id} já está ${entry.status === 'stopped' ? 'encerrado' : 'finalizado'}.` }
  }

  const remembered = getRememberedPids(entry)
  killProcessTree(entry.pid, remembered)
  entry.status = 'stopped'
  entry.endedAt = Date.now()
  entry.reaped = true
  save()
  stopWatchdogIfIdle()
  return { ok: true, process: entry }
}

/**
 * Kills every process this extension started. Called when the worker shuts down
 * (app quit, extension reload) so a dev server never outlives the app that
 * started it.
 */
function stopAllProcesses(): number {
  loadFromDisk()
  const running = [...registry.values()].filter(
    (entry) => entry.status === 'running' || (entry.status !== 'stopped' && !entry.reaped && isEntryAlive(entry))
  )
  killActiveForegroundProcesses()

  let pairs: Array<{ pid: number; ppid: number }> | undefined
  let stopped = 0
  for (const entry of running) {
    const remembered = getRememberedPids(entry)
    const needsSnapshot = !isAlive(entry.pid) || remembered.some((pid) => !isAlive(pid))
    if (needsSnapshot && !pairs) {
      pairs = listProcessPairs()
    }
    killProcessTree(entry.pid, remembered, needsSnapshot ? pairs : undefined)
    entry.status = 'stopped'
    entry.endedAt = Date.now()
    entry.reaped = true
    stopped += 1
  }
  if (stopped > 0) save()
  stopWatchdogIfIdle(true)
  return stopped
}

/**
 * Reaps processes left running by a previous worker generation.
 *
 * Every recent un-reaped entry is swept, including ones already marked exited:
 * a shell such as `powershell -Command "npm run dev"` returns while the script
 * keeps serving, so the recorded pid is dead and the real process only shows up
 * through its descendants or remembered pids.
 *
 * The worker runs this right after reporting ready, so it never delays startup.
 */
function reapOrphanedProcesses(): number {
  loadFromDisk()
  const recent = [...registry.values()]
    .filter((entry) => entry.status !== 'stopped' && !entry.reaped)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, MAX_REAP_ENTRIES)

  if (recent.length === 0) return 0

  let pairs: Array<{ pid: number; ppid: number }> | undefined
  let stopped = 0
  let dirty = false
  for (const entry of recent) {
    const remembered = getRememberedPids(entry)
    const needsSnapshot = !isAlive(entry.pid) || remembered.some((pid) => !isAlive(pid))
    if (needsSnapshot && !pairs) {
      pairs = listProcessPairs()
    }
    const reachable = killProcessTree(entry.pid, remembered, needsSnapshot ? pairs : undefined)
    if (reachable) {
      entry.status = 'stopped'
      entry.endedAt = entry.endedAt || Date.now()
      entry.reaped = true
      stopped += 1
      dirty = true
    } else {
      if (entry.status === 'running') {
        entry.status = 'exited'
        entry.endedAt = entry.endedAt || Date.now()
        stopped += 1
      }
      entry.reaped = true
      dirty = true
    }
  }
  if (dirty) save()
  stopWatchdogIfIdle()
  return stopped
}

function readOutput(id: string, maxBytes: number = MAX_OUTPUT_BYTES): { ok: boolean; output?: string; error?: string } {
  const entry = getProcess(id)
  if (!entry) return { ok: false, error: `Processo ${id} não encontrado.` }
  try {
    const size = fs.statSync(entry.file).size
    const start = Math.max(0, size - maxBytes)
    const fd = fs.openSync(entry.file, 'r')
    const buf = Buffer.alloc(Math.min(maxBytes, size))
    fs.readSync(fd, buf, 0, buf.length, start)
    fs.closeSync(fd)
    const prefix = start > 0 ? `[... ${start} bytes omitidos no início ...]\n` : ''
    return { ok: true, output: prefix + buf.toString('utf-8') }
  } catch (error: any) {
    return { ok: false, error: `Não foi possível ler a saída: ${error?.message || error}` }
  }
}

/** Test seam: clears the in-memory registry without touching the disk store. */
function clearRegistryForTests(): void {
  stopWatchdogIfIdle(true)
  registry.clear()
  storeLoaded = true
}

module.exports = {
  startBackgroundProcess,
  adoptRunningProcess,
  listProcesses,
  getProcess,
  stopProcess,
  stopAllProcesses,
  reapOrphanedProcesses,
  readOutput,
  clearRegistryForTests
}
