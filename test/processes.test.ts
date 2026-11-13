import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)

const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momai-processes-'))
process.env.MOMAI_EXTENSION_STORAGE_DIR = storageDir

const {
  startBackgroundProcess,
  listProcesses,
  getProcess,
  readOutput,
  stopProcess,
  clearRegistryForTests
} = require('../core/processes.ts')

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForDeath(pid: number, attempts = 60): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!alive(pid)) return true
    await wait(100)
  }
  return false
}

const runningScript = path.join(storageDir, 'keep-running.cjs')
fs.writeFileSync(runningScript, "console.log('bg-output'); setInterval(function () {}, 1000)\n")

describe('background processes', () => {
  beforeAll(() => {
    clearRegistryForTests()
  })

  afterAll(() => {
    for (const entry of listProcesses()) {
      stopProcess(entry.id)
    }
    try {
      fs.rmSync(storageDir, { recursive: true, force: true })
    } catch {}
  })

  it('starts detached, lists the process and streams its output to a file', async () => {
    const started = startBackgroundProcess(`node "${runningScript}"`, storageDir, {
      env: process.env
    })

    expect(started.id).toMatch(/^bg_/)
    expect(started.pid).toBeGreaterThan(0)

    const listed = listProcesses()
    expect(listed.some((entry: any) => entry.id === started.id)).toBe(true)

    let output = ''
    for (let attempt = 0; attempt < 60; attempt += 1) {
      output = readOutput(started.id).output || ''
      if (output.includes('bg-output')) break
      await wait(100)
    }
    expect(output).toContain('bg-output')

    const stopped = stopProcess(started.id)
    expect(stopped.ok).toBe(true)

    await wait(300)
    expect(listProcesses().map((entry: any) => entry.id)).not.toContain(started.id)
  }, 30000)

  it('stops every running process when the worker shuts down', async () => {
    const first = startBackgroundProcess(`node "${runningScript}"`, storageDir, { env: process.env })
    const second = startBackgroundProcess(`node "${runningScript}"`, storageDir, { env: process.env })

    const { stopAllProcesses } = require('../core/processes.ts')
    expect(stopAllProcesses()).toBe(2)

    await wait(300)
    const alive = listProcesses().map((entry: any) => entry.id)
    expect(alive).not.toContain(first.id)
    expect(alive).not.toContain(second.id)
  }, 30000)

  it('reports an unknown id instead of throwing', () => {
    const missing = getProcess('bg_missing')
    expect(missing).toBeNull()

    const result = stopProcess('bg_missing')
    expect(result.ok).toBe(false)
    expect(String(result.error)).toContain('não encontrado')
  })
})

describe('background processes per thread', () => {
  beforeAll(() => {
    clearRegistryForTests()
  })

  afterAll(() => {
    for (const entry of listProcesses()) {
      stopProcess(entry.id)
    }
  })

  it('lists only the calling thread processes when filtered', async () => {
    const first = startBackgroundProcess(`node "${runningScript}"`, storageDir, {
      env: process.env,
      threadId: 'thread-a'
    })
    const second = startBackgroundProcess(`node "${runningScript}"`, storageDir, {
      env: process.env,
      threadId: 'thread-b'
    })
    const untagged = startBackgroundProcess(`node "${runningScript}"`, storageDir, {
      env: process.env
    })

    try {
      expect(listProcesses({ threadId: 'thread-a' }).map((entry: any) => entry.id)).toEqual([first.id])
      expect(listProcesses({ threadId: 'thread-b' }).map((entry: any) => entry.id)).toEqual([second.id])

      // A new thread sees nothing, and untagged processes never leak into a thread.
      expect(listProcesses({ threadId: 'thread-new' })).toEqual([])

      // The unfiltered list still returns everything (used on shutdown).
      expect(listProcesses().map((entry: any) => entry.id)).toEqual(
        expect.arrayContaining([first.id, second.id, untagged.id])
      )
    } finally {
      stopProcess(first.id)
      stopProcess(second.id)
      stopProcess(untagged.id)
    }
  })

  it('exposes the thread filter through code_process list', async () => {
    const { executeCodeProcess } = require('../tools/process.ts')
    const first = startBackgroundProcess(`node "${runningScript}"`, storageDir, {
      env: process.env,
      threadId: 'thread-a'
    })
    const second = startBackgroundProcess(`node "${runningScript}"`, storageDir, {
      env: process.env,
      threadId: 'thread-b'
    })

    try {
      const viaArgs = await executeCodeProcess({ action: 'list', threadId: 'thread-a' })
      expect(viaArgs.processes.map((entry: any) => entry.id)).toEqual([first.id])

      const viaContext = await executeCodeProcess({ action: 'list' }, undefined, { threadId: 'thread-b' })
      expect(viaContext.processes.map((entry: any) => entry.id)).toEqual([second.id])
    } finally {
      stopProcess(first.id)
      stopProcess(second.id)
    }
  })

  it('kills the grandchild when the command runs through a shell', async () => {
    // The real shape of the zombie: powershell is the registered pid and the
    // command it starts is a grandchild. Killing only the shell left the dev
    // server running forever.
    const marker = path.join(storageDir, 'grandchild.pid')
    fs.writeFileSync(
      path.join(storageDir, 'grandchild.cjs'),
      "require('fs').writeFileSync(process.env.MOMAI_TEST_GRANDCHILD, String(process.pid)); setInterval(function () {}, 1000)\n"
    )
    process.env.MOMAI_TEST_GRANDCHILD = marker

    const started = startBackgroundProcess(`node "${path.join(storageDir, 'grandchild.cjs')}"`, storageDir, {
      env: process.env
    })

    let grandchildPid = 0
    for (let attempt = 0; attempt < 60 && !grandchildPid; attempt += 1) {
      await wait(100)
      if (fs.existsSync(marker)) grandchildPid = Number(fs.readFileSync(marker, 'utf-8'))
    }
    expect(grandchildPid).toBeGreaterThan(0)

    const stopped = stopProcess(started.id)
    expect(stopped.ok).toBe(true)

    let alive = true
    for (let attempt = 0; attempt < 40 && alive; attempt += 1) {
      try {
        process.kill(grandchildPid, 0)
      } catch {
        alive = false
      }
      if (alive) await wait(100)
    }
    expect(alive).toBe(false)
  }, 30000)

  it('reaps a command whose shell already died', async () => {
    // `npm run dev` shape: the shell returns while the script keeps serving,
    // so the stored pid is dead and the real process hides under it.
    const marker = path.join(storageDir, 'npm-grandchild.pid')
    fs.writeFileSync(
      path.join(storageDir, 'npm-grandchild.cjs'),
      "require('fs').writeFileSync(process.env.MOMAI_TEST_GRANDCHILD, String(process.pid)); setInterval(function () {}, 1000)\n"
    )
    process.env.MOMAI_TEST_GRANDCHILD = marker

    const started = startBackgroundProcess(`node "${path.join(storageDir, 'npm-grandchild.cjs')}"`, storageDir, {
      env: process.env
    })

    let grandchildPid = 0
    for (let attempt = 0; attempt < 60 && !grandchildPid; attempt += 1) {
      await wait(100)
      if (fs.existsSync(marker)) grandchildPid = Number(fs.readFileSync(marker, 'utf-8'))
    }
    expect(grandchildPid).toBeGreaterThan(0)

    // Kill only the shell, never its tree.
    try {
      execSync(`taskkill /pid ${started.pid} /F`, { stdio: 'ignore', windowsHide: true })
    } catch {}
    await wait(300)
    expect(alive(grandchildPid)).toBe(true)

    const freshId = `../core/processes.ts?reap=${Date.now()}`
    const fresh: any = await import(/* @vite-ignore */ freshId)
    expect(fresh.reapOrphanedProcesses()).toBeGreaterThanOrEqual(1)
    expect(await waitForDeath(grandchildPid)).toBe(true)
  }, 60000)

  it('reaps processes left running by a previous generation on boot', async () => {
    const started = startBackgroundProcess(`node "${runningScript}"`, storageDir, {
      env: process.env,
      threadId: 'thread-orphan'
    })

    // A new worker generation boots with the same on-disk store but an empty
    // in-memory registry: exactly the state after a missed shutdown on reload,
    // app quit or crash. The query string forces a fresh module instance.
    const freshId = `../core/processes.ts?generation=${Date.now()}`
    const fresh: any = await import(/* @vite-ignore */ freshId)

    try {
      expect(typeof fresh.reapOrphanedProcesses).toBe('function')
      expect(fresh.reapOrphanedProcesses()).toBeGreaterThanOrEqual(1)
      // The entry is no longer presented as running, whatever the shell did.
      expect(fresh.getProcess(started.id)?.status).not.toBe('running')

      // The OS process is really gone: no zombie dev server left behind.
      let alive = true
      for (let attempt = 0; attempt < 20 && alive; attempt += 1) {
        try {
          process.kill(started.pid, 0)
        } catch {
          alive = false
        }
        if (alive) await wait(100)
      }
      expect(alive).toBe(false)
    } finally {
      try {
        stopProcess(started.id)
      } catch {}
    }
  }, 60000)

  it('reaps a deep command tree even when both the shell and intermediate launcher died', async () => {
    // `powershell -> npm-cli -> cmd -> node tools/dev.mjs` shape: when both the
    // shell and intermediate launcher exit, Win32_Process no longer connects
    // the stored root pid to the leaf server. Recorded descendant pids bridge
    // the gap.
    const midMarker = path.join(storageDir, 'deep-mid.pid')
    const leafMarker = path.join(storageDir, 'deep-leaf.pid')
    const leafScript = path.join(storageDir, 'deep-leaf.cjs')
    const midScript = path.join(storageDir, 'deep-mid.cjs')

    fs.writeFileSync(
      leafScript,
      "require('fs').writeFileSync(process.env.MOMAI_TEST_LEAF, String(process.pid)); setInterval(function () {}, 1000)\n"
    )
    fs.writeFileSync(
      midScript,
      `const { spawn } = require('child_process');
require('fs').writeFileSync(process.env.MOMAI_TEST_MID, String(process.pid));
const child = spawn(process.execPath, [${JSON.stringify(leafScript)}], { detached: true, stdio: 'ignore', windowsHide: true });
child.unref();
setInterval(function () {}, 1000);
`
    )

    const env = {
      ...process.env,
      MOMAI_TEST_MID: midMarker,
      MOMAI_TEST_LEAF: leafMarker
    }

    const started = startBackgroundProcess(`node "${midScript}"`, storageDir, { env })

    let midPid = 0
    let leafPid = 0
    for (let attempt = 0; attempt < 60 && (!midPid || !leafPid); attempt += 1) {
      await wait(100)
      if (!midPid && fs.existsSync(midMarker)) midPid = Number(fs.readFileSync(midMarker, 'utf-8'))
      if (!leafPid && fs.existsSync(leafMarker)) leafPid = Number(fs.readFileSync(leafMarker, 'utf-8'))
    }
    expect(midPid).toBeGreaterThan(0)
    expect(leafPid).toBeGreaterThan(0)

    // Wait for the companion watchdog to snapshot the descendant chain into `<id>.pids`.
    const pidSidecar = path.join(storageDir, 'processes', `${started.id}.pids`)
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (fs.existsSync(pidSidecar)) {
        const recorded = JSON.parse(fs.readFileSync(pidSidecar, 'utf-8'))
        if (Array.isArray(recorded) && recorded.includes(leafPid)) break
      }
      await wait(100)
    }

    // Kill both the root shell and the intermediate process, breaking the live parent chain.
    for (const pid of [started.pid, midPid]) {
      try {
        if (process.platform === 'win32') {
          execSync(`taskkill /pid ${pid} /F`, { stdio: 'ignore', windowsHide: true })
        } else {
          process.kill(pid, 'SIGKILL')
        }
      } catch {}
    }
    await wait(300)
    expect(alive(leafPid)).toBe(true)

    const freshId = `../core/processes.ts?deep=${Date.now()}`
    const fresh: any = await import(/* @vite-ignore */ freshId)
    expect(fresh.reapOrphanedProcesses()).toBeGreaterThanOrEqual(1)
    expect(await waitForDeath(leafPid)).toBe(true)
  }, 60000)

  it('kills background shells automatically when the owner process dies abruptly', async () => {
    const ownerStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momai-owner-death-'))
    const leafMarker = path.join(ownerStorageDir, 'owner-leaf.pid')
    const leafScript = path.join(ownerStorageDir, 'owner-leaf.cjs')
    const ownerScript = path.join(ownerStorageDir, 'owner-host.cjs')
    const processesModulePath = path.resolve(__dirname, '../core/processes.ts')

    fs.writeFileSync(
      leafScript,
      "require('fs').writeFileSync(process.env.MOMAI_OWNER_LEAF, String(process.pid)); setInterval(function () {}, 1000)\n"
    )
    fs.writeFileSync(
      ownerScript,
      `process.env.MOMAI_EXTENSION_STORAGE_DIR = ${JSON.stringify(ownerStorageDir)};
process.env.MOMAI_OWNER_LEAF = ${JSON.stringify(leafMarker)};
const { startBackgroundProcess } = require(${JSON.stringify(processesModulePath)});
startBackgroundProcess('node ' + JSON.stringify(${JSON.stringify(leafScript)}), ${JSON.stringify(ownerStorageDir)}, { env: process.env });
setInterval(function () {}, 1000);
`
    )

    const { spawn } = require('node:child_process')
    const owner = spawn(process.execPath, [ownerScript], {
      cwd: ownerStorageDir,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })

    let leafPid = 0
    try {
      for (let attempt = 0; attempt < 60 && !leafPid; attempt += 1) {
        await wait(100)
        if (fs.existsSync(leafMarker)) leafPid = Number(fs.readFileSync(leafMarker, 'utf-8'))
      }
      expect(leafPid).toBeGreaterThan(0)
      expect(alive(leafPid)).toBe(true)

      // Wait until the watchdog daemon has registered its own pid.
      const watchdogFile = path.join(ownerStorageDir, 'watchdog.pid')
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (fs.existsSync(watchdogFile)) {
          try {
            const info = JSON.parse(fs.readFileSync(watchdogFile, 'utf-8'))
            if (info && typeof info.pid === 'number' && info.pid > 0) break
          } catch {}
        }
        await wait(100)
      }

      // Abruptly kill ONLY the owner process (simulating hard kill / crash on quit or reload).
      try {
        if (process.platform === 'win32') {
          execSync(`taskkill /pid ${owner.pid} /F`, { stdio: 'ignore', windowsHide: true })
        } else {
          process.kill(owner.pid, 'SIGKILL')
        }
      } catch {}

      expect(await waitForDeath(leafPid, 80)).toBe(true)
    } finally {
      try {
        if (owner.pid && alive(owner.pid)) {
          if (process.platform === 'win32') {
            execSync(`taskkill /pid ${owner.pid} /T /F`, { stdio: 'ignore', windowsHide: true })
          } else {
            process.kill(owner.pid, 'SIGKILL')
          }
        }
      } catch {}
      if (leafPid && alive(leafPid)) {
        try {
          if (process.platform === 'win32') {
            execSync(`taskkill /pid ${leafPid} /F`, { stdio: 'ignore', windowsHide: true })
          } else {
            process.kill(leafPid, 'SIGKILL')
          }
        } catch {}
      }
      await wait(300)
      try {
        fs.rmSync(ownerStorageDir, { recursive: true, force: true })
      } catch {}
    }
  }, 60000)
})
