import { describe, it, expect, afterAll } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)

const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momai-bash-bg-'))
process.env.MOMAI_EXTENSION_STORAGE_DIR = storageDir
process.env.MOMAI_DATA_DIR = storageDir

const { execute } = require('../runtime.ts')
const { listProcesses, stopProcess } = require('../core/processes.ts')

const script = path.join(storageDir, 'keep.cjs')
fs.writeFileSync(script, "console.log('hello-bg')\nsetInterval(function () {}, 1000)\n")

describe('code_bash in background', () => {
  afterAll(() => {
    for (const entry of listProcesses()) stopProcess(entry.id)
    try {
      fs.rmSync(storageDir, { recursive: true, force: true })
    } catch {}
  })

  it('returns at once with a shellID and exposes it through code_process', async () => {
    const started = await execute('code_bash', { command: `node "${script}"`, background: true })

    expect(started.ok).toBe(true)
    const payload = JSON.parse(started.instruction)
    expect(payload.status).toBe('running')
    expect(payload.shellID).toMatch(/^bg_/)
    expect(payload.pid).toBeGreaterThan(0)

    const listed = JSON.parse((await execute('code_process', { action: 'list' })).instruction)
    expect(listed.running).toBeGreaterThan(0)
    expect(listed.processes.some((entry: any) => entry.id === payload.shellID)).toBe(true)

    const stopped = await execute('code_process', { action: 'stop', id: payload.shellID })
    expect(stopped.ok).toBe(true)
    expect(JSON.parse(stopped.instruction).status).toBe('stopped')
  }, 30000)
})
