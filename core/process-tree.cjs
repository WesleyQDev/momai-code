/**
 * Kills a process and everything below it.
 *
 * `taskkill /T` alone is not enough when intermediate shells already exited:
 * survivors get re-parented and a walk from the root misses them. `remembered`
 * covers descendant pids recorded while the tree was forming; they are killed
 * leaves-first before the root so tearing down the shell never orphans the
 * server underneath.
 */
const { execFileSync, execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

function resolvePowerShellExecutable() {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
  const candidate = path.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  try {
    if (fs.existsSync(candidate)) return candidate
  } catch {
    /* fallback below */
  }
  return 'powershell.exe'
}

function listProcessPairs() {
  try {
    const raw =
      process.platform === 'win32'
        ? execFileSync(
            resolvePowerShellExecutable(),
            [
              '-NoLogo',
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'
            ],
            { encoding: 'utf-8', windowsHide: true, timeout: 15000 }
          )
        : execFileSync('ps', ['-A', '-o', 'pid=,ppid='], {
            encoding: 'utf-8',
            timeout: 10000
          })

    return String(raw || '')
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter((pair) => pair.length === 2 && pair.every((value) => Number.isFinite(value)))
      .map(([pid, ppid]) => ({ pid, ppid }))
  } catch {
    return []
  }
}

function isAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Every descendant of `rootOrRoots`, parents before their children.
 * Accepts an optional pre-fetched `pairs` list so batch callers only snapshot
 * the OS process table once.
 */
function collectDescendants(rootOrRoots, preloadedPairs) {
  const roots = (Array.isArray(rootOrRoots) ? rootOrRoots : [rootOrRoots]).filter(
    (value) => Number.isFinite(value) && value > 0
  )
  if (roots.length === 0) return []

  const pairs = Array.isArray(preloadedPairs) ? preloadedPairs : listProcessPairs()
  const children = new Map()
  for (const pair of pairs) {
    if (!pair || !Number.isFinite(pair.pid) || !Number.isFinite(pair.ppid)) continue
    if (!children.has(pair.ppid)) children.set(pair.ppid, [])
    children.get(pair.ppid).push(pair.pid)
  }

  const found = []
  const seen = new Set(roots)
  let frontier = [...roots]
  // Bounded on purpose: a runaway tree must never stall a shutdown.
  for (let depth = 0; depth < 8 && frontier.length > 0; depth += 1) {
    const next = []
    for (const pid of frontier) {
      for (const child of children.get(pid) || []) {
        if (seen.has(child)) continue
        seen.add(child)
        found.push(child)
        next.push(child)
      }
    }
    frontier = next
  }
  return found
}

function killOne(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false
  if (!isAlive(pid)) return false
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${pid} /F`, { stdio: 'ignore', windowsHide: true })
    } else {
      process.kill(pid, 'SIGKILL')
    }
    return true
  } catch {
    return false
  }
}

function killSubtreeFast(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false
  if (!isAlive(pid)) return false
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore', windowsHide: true })
    } else {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        process.kill(pid, 'SIGKILL')
      }
    }
    return true
  } catch {
    return killOne(pid)
  }
}

/**
 * Kills `root`, its descendants and any pid still remembered from before.
 *
 * Fast path: when `root` or any `remembered` descendant is still alive, kill
 * the remembered descendants bottom-up with `/T /F` and then `root` with `/T /F`
 * (unless `preloadedPairs` was already supplied). The expensive CIM snapshot is
 * only needed when `root` is already dead and no remembered descendant is alive.
 */
function killTree(root, remembered, preloadedPairs) {
  const extra = Array.isArray(remembered)
    ? remembered.filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== root)
    : []
  const rootAlive = isAlive(root)
  const aliveExtra = extra.filter(isAlive)
  const deadExtra = extra.length !== aliveExtra.length

  if (rootAlive && !deadExtra && !Array.isArray(preloadedPairs)) {
    for (const pid of aliveExtra.slice().reverse()) {
      killSubtreeFast(pid)
    }
    killSubtreeFast(root)
    return 1 + aliveExtra.length
  }

  const descendants = collectDescendants([root, ...extra], preloadedPairs)
  const aliveDescendants = descendants.filter(isAlive)

  const liveTargets = new Set([
    ...aliveDescendants,
    ...aliveExtra,
    ...(rootAlive ? [root] : [])
  ])
  if (liveTargets.size === 0) return 0

  // Leaves first: a parent killed early may orphan what is left of the tree.
  for (const pid of descendants.slice().reverse()) {
    killOne(pid)
  }
  for (const pid of extra.slice().reverse()) {
    killSubtreeFast(pid)
  }
  if (rootAlive || isAlive(root)) {
    killSubtreeFast(root)
  }

  return liveTargets.size
}

module.exports = {
  killTree,
  killOne,
  collectDescendants,
  listProcessPairs,
  isAlive
}
