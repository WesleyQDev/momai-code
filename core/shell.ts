const { execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

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

export interface ShellInvocation {
  executable: string
  args: string[]
  name: string
}

/** Shell binary and argv used to run one command line. */
function buildShellInvocation(
  command: string,
  preference?: 'auto' | 'powershell' | 'cmd' | string
): ShellInvocation {
  if (process.platform === 'win32') {
    if (preference === 'cmd') {
      return { executable: 'cmd.exe', args: ['/c', command], name: 'cmd' }
    }
    return {
      executable: resolveWindowsPowerShell(),
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        command
      ],
      name: 'powershell'
    }
  }

  return { executable: '/bin/bash', args: ['-c', command], name: 'bash' }
}

module.exports = {
  resolveWindowsPowerShell,
  buildShellInvocation
}
