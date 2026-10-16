const { spawn, execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
import type { MomAiCodeSettings } from './types.ts'

export interface ProcessRunResult {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  cwd: string
  timedOut: boolean
  /** Shell actually used for the command (powershell, cmd or bash). */
  shell: string
}

const MAX_OUTPUT_BYTES = 64 * 1024 // 64 KB

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

function killProcessTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore', windowsHide: true })
    } else {
      process.kill(-pid, 'SIGKILL')
    }
  } catch {
    // Process might already be terminated
  }
}

let cachedWindowsShell: string | null = null

/**
 * Windows Store installs expose `pwsh.exe` through an app execution alias under
 * a `WindowsApps` directory. Spawning the alias goes through packaged-app
 * activation, whose console/visibility semantics differ from a plain
 * executable, so aliases are never used as the shell.
 */
function isWindowsAppsPath(executablePath: string): boolean {
  return /[\\/]windowsapps[\\/]/i.test(executablePath)
}

function isRealExecutableFile(executablePath: string): boolean {
  if (!executablePath || isWindowsAppsPath(executablePath)) return false
  try {
    return fs.statSync(executablePath).isFile()
  } catch {
    return false
  }
}

function resolveWindowsPowerShell(): string {
  if (cachedWindowsShell) return cachedWindowsShell

  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
  const driveRoot = path.parse(systemRoot).root || 'C:\\'

  // Genuine PowerShell 7 MSI installs first (never the Store execution alias).
  const pwshCandidates = [
    path.join(driveRoot, 'Program Files', 'PowerShell', '7', 'pwsh.exe'),
    path.join(driveRoot, 'Program Files', 'PowerShell', '7-preview', 'pwsh.exe'),
    path.join(driveRoot, 'Program Files (x86)', 'PowerShell', '7', 'pwsh.exe')
  ]
  for (const candidate of pwshCandidates) {
    if (isRealExecutableFile(candidate)) {
      cachedWindowsShell = candidate
      return cachedWindowsShell
    }
  }

  // PATH lookup: `where.exe` also lists Store aliases, so keep only real files.
  try {
    const found = execSync('where.exe pwsh.exe', { stdio: 'pipe', encoding: 'utf-8', windowsHide: true })
    const fromPath = String(found || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => isRealExecutableFile(line))
    if (fromPath) {
      cachedWindowsShell = fromPath
      return cachedWindowsShell
    }
  } catch {}

  // Windows PowerShell 5.1 ships with the OS and is always a plain executable.
  const powershellPath = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  cachedWindowsShell = isRealExecutableFile(powershellPath) ? powershellPath : 'powershell.exe'
  return cachedWindowsShell
}

async function runProcess(
  command: string,
  cwd: string,
  options?: {
    timeoutMs?: number
    shellPreference?: MomAiCodeSettings['shell']
  }
): Promise<ProcessRunResult> {
  const timeoutMs = options?.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 30000
  const shellPref = options?.shellPreference || 'powershell'

  let shellExecutable: string
  let shellArgs: string[]
  let shellName: string

  if (process.platform === 'win32') {
    if (shellPref === 'cmd') {
      shellExecutable = 'cmd.exe'
      shellArgs = ['/c', command]
      shellName = 'cmd'
    } else {
      // Modern pwsh if installed on machine, fallback to powershell.exe
      shellExecutable = resolveWindowsPowerShell()
      shellArgs = [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        command
      ]
      shellName = 'powershell'
    }
  } else {
    shellExecutable = '/bin/bash'
    shellArgs = ['-c', command]
    shellName = 'bash'
  }

  const startTime = Date.now()

  return new Promise<ProcessRunResult>((resolve) => {
    let child: any
    let timedOut = false
    let timer: NodeJS.Timeout | null = null

    try {
      child = spawn(shellExecutable, shellArgs, {
        cwd,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PAGER: 'cat' }
      })
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
        stdoutData += chunk.toString('utf-8')
      })
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        stderrData += chunk.toString('utf-8')
      })
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        if (child.pid) killProcessTree(child.pid)
      }, timeoutMs)
    }

    child.on('close', (code: number | null) => {
      if (timer) clearTimeout(timer)
      const durationMs = Date.now() - startTime
      const exitCode = timedOut ? 124 : (code ?? 0)
      if (timedOut) {
        stderrData += `\n[Processo interrompido: excedeu o tempo limite de ${timeoutMs}ms]`
      }

      resolve({
        exitCode,
        stdout: truncateOutput(stdoutData),
        stderr: truncateOutput(stderrData),
        durationMs,
        cwd,
        timedOut,
        shell: shellName
      })
    })

    child.on('error', (err: any) => {
      if (timer) clearTimeout(timer)
      resolve({
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
  resolveWindowsPowerShell,
  runProcess
}
