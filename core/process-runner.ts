const { spawn } = require('node:child_process')
import type { MomAiCodeSettings } from './types.ts'
const { resolveWindowsPowerShell, buildShellInvocation } = require('./shell.ts')
const { killTree: killProcessTreeShared } = require('./process-tree.cjs')

export interface ProcessRunResult {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  cwd: string
  timedOut: boolean
  /** Shell actually used for the command (powershell, cmd or bash). */
  shell: string
  /** Set when the command outlived its timeout and was kept running. */
  background?: { id: string; pid: number; file: string }
}

const MAX_OUTPUT_BYTES = 64 * 1024 // 64 KB

/**
 * Port names the host app owns. The host exports them into every child, so a
 * project script that reads `PORT` (a common convention for dev servers) would
 * bind the MomAI core port and make the app refuse to boot. They never reach
 * user commands: a project that wants a port must ask for one explicitly.
 */
const HOST_PORT_ENV_KEYS = new Set([
  'PORT',
  'MOMAI_API_PORT',
  'MOMAI_NODE_CORE_PORT',
  'MOMAI_SERVER_PORT',
  'MOMAI_PYTHON_SIDECAR_PORT'
])

/** Child environment for a user command: host port names removed, shell fixed. */
function buildRunEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || HOST_PORT_ENV_KEYS.has(key)) continue
    env[key] = value
  }

  env.PAGER = 'cat'
  if (process.platform === 'win32') {
    env.PATHEXT =
      base.PATHEXT || '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC'
    env.SystemRoot = base.SystemRoot || base.WINDIR || 'C:\\Windows'
    env.SystemDrive = base.SystemDrive || 'C:'
    env.COMSPEC = base.COMSPEC || 'C:\\Windows\\System32\\cmd.exe'
  }

  return env
}

/**
 * Keeps the beginning and the end of a long output: errors usually land at the
 * tail, while the head carries the command's context.
 */
function truncateOutput(output: string, maxBytes: number = MAX_OUTPUT_BYTES): string {
  const buf = Buffer.from(output, 'utf-8')
  if (buf.length <= maxBytes) return output

  const marker = `\n\n[... saída truncada: ${buf.length - maxBytes} bytes omitidos no meio ...]\n\n`
  const markerBytes = Buffer.byteLength(marker, 'utf-8')
  const keepBytes = Math.max(0, maxBytes - markerBytes)
  if (keepBytes === 0) return marker.trim()

  const headBytes = Math.floor(keepBytes * 0.6)
  const tailBytes = keepBytes - headBytes
  const head = buf.subarray(0, headBytes).toString('utf-8')
  const tail = buf.subarray(buf.length - tailBytes).toString('utf-8')
  return `${head}${marker}${tail}`
}

/** Kills the process and its tree; returns whether anything was reachable. */
function killProcessTree(
  pid: number,
  remembered?: number[],
  preloadedPairs?: Array<{ pid: number; ppid: number }>
): boolean {
  return killProcessTreeShared(pid, remembered, preloadedPairs) > 0
}

const activeForegroundPids = new Set<number>()

function killActiveForegroundProcesses(
  preloadedPairs?: Array<{ pid: number; ppid: number }>
): number {
  let killed = 0
  for (const pid of [...activeForegroundPids]) {
    activeForegroundPids.delete(pid)
    if (killProcessTree(pid, undefined, preloadedPairs)) {
      killed += 1
    }
  }
  return killed
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

/**
 * Runs a command and waits for it to finish. When it outlives `timeoutMs` the
 * process is not killed: it is adopted as a background process, its output keeps
 * streaming to a file and the caller gets the id back. That is what keeps the
 * chat responsive around dev servers and watchers.
 */
async function runProcess(
  command: string,
  cwd: string,
  options?: {
    timeoutMs?: number
    shellPreference?: MomAiCodeSettings['shell']
    threadId?: string
    /** Set to false to kill the process on timeout instead of adopting it. */
    promoteOnTimeout?: boolean
  }
): Promise<ProcessRunResult> {
  const timeoutMs = options?.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 30000
  const { executable, args, name: shellName } = buildShellInvocation(
    command,
    options?.shellPreference || 'powershell'
  )
  const promoteOnTimeout = options?.promoteOnTimeout !== false

  const startTime = Date.now()

  return new Promise<ProcessRunResult>((resolve) => {
    let child: any
    let settled = false
    let promoted = false
    let timer: NodeJS.Timeout | null = null

    const runEnv = buildRunEnv(process.env)

    const finish = (result: ProcessRunResult): void => {
      if (settled) return
      settled = true
      if (child?.pid) activeForegroundPids.delete(child.pid)
      if (timer) clearTimeout(timer)
      resolve(result)
    }

    try {
      child = spawn(executable, args, {
        cwd,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: runEnv
      })
      if (child?.pid) activeForegroundPids.add(child.pid)
    } catch (err: any) {
      resolve({
        exitCode: 1,
        stdout: '',
        stderr: `Erro ao iniciar processo: ${err?.message || err}`,
        durationMs: Date.now() - startTime,
        cwd,
        timedOut: false,
        shell: shellName
      })
      return
    }

    let stdoutData = ''
    let stderrData = ''

    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => {
        if (promoted) return
        stdoutData += chunk.toString('utf-8')
      })
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        if (promoted) return
        stderrData += chunk.toString('utf-8')
      })
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (promoted) return

        if (promoteOnTimeout && child.pid && isAlive(child.pid)) {
          const { adoptRunningProcess } = require('./processes.ts')
          const adopted = adoptRunningProcess({
            child,
            command,
            cwd,
            threadId: options?.threadId,
            collected: stdoutData + stderrData
          })
          promoted = true
          finish({
            exitCode: 0,
            stdout: truncateOutput(stdoutData),
            stderr: truncateOutput(stderrData),
            durationMs: Date.now() - startTime,
            cwd,
            timedOut: true,
            shell: shellName,
            background: adopted
          })
          return
        }

        if (child.pid) killProcessTree(child.pid)
      }, timeoutMs)
    }

    child.on('close', (code: number | null) => {
      if (promoted) return
      const durationMs = Date.now() - startTime
      finish({
        exitCode: code ?? 0,
        stdout: truncateOutput(stdoutData),
        stderr: truncateOutput(stderrData),
        durationMs,
        cwd,
        timedOut: false,
        shell: shellName
      })
    })

    child.on('error', (err: any) => {
      if (promoted) return
      finish({
        exitCode: 1,
        stdout: truncateOutput(stdoutData),
        stderr: truncateOutput(stderrData + `\nErro do processo: ${err?.message || err}`),
        durationMs: Date.now() - startTime,
        cwd,
        timedOut: false,
        shell: shellName
      })
    })
  })
}

module.exports = {
  MAX_OUTPUT_BYTES,
  truncateOutput,
  killProcessTree,
  killActiveForegroundProcesses,
  resolveWindowsPowerShell,
  buildRunEnv,
  runProcess
}
