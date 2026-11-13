import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { truncateOutput, resolveWindowsPowerShell, buildRunEnv, runProcess } = require('../core/process-runner.ts')

describe('truncateOutput', () => {
  it('returns short output untouched', () => {
    expect(truncateOutput('hello', 100)).toBe('hello')
  })

  it('keeps the head and the tail, marking the omitted middle', () => {
    const head = 'HEAD-'.repeat(50)
    const middle = 'M'.repeat(5000)
    const tail = '-TAIL'.repeat(50)
    const result = truncateOutput(`${head}${middle}${tail}`, 400)

    expect(result.startsWith('HEAD-')).toBe(true)
    expect(result.endsWith('-TAIL')).toBe(true)
    expect(result).toContain('bytes omitidos no meio')
    expect(Buffer.byteLength(result, 'utf-8')).toBeLessThanOrEqual(420)
  })
})

describe('runEnv for user commands', () => {
  it('drops host port names and keeps the rest', () => {
    const env = buildRunEnv({
      PORT: '8050',
      MOMAI_NODE_CORE_PORT: '8050',
      MOMAI_API_PORT: '8050',
      MOMAI_KEEP_ME: 'kept'
    } as NodeJS.ProcessEnv)

    expect(env.PORT).toBeUndefined()
    expect(env.MOMAI_NODE_CORE_PORT).toBeUndefined()
    expect(env.MOMAI_API_PORT).toBeUndefined()
    expect(env.MOMAI_KEEP_ME).toBe('kept')
    expect(env.PAGER).toBe('cat')
  })

  it('never hands the host PORT to a command process', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momai-env-'))
    const script = path.join(dir, 'print-port.cjs')
    fs.writeFileSync(script, "console.log(process.env.PORT === undefined ? 'unset' : process.env.PORT)\n")

    const previous = process.env.PORT
    process.env.PORT = '8050'
    try {
      const res = await runProcess(`node "${script}"`, process.cwd())
      expect(res.exitCode).toBe(0)
      expect(res.stdout.trim()).toBe('unset')
    } finally {
      if (previous === undefined) delete process.env.PORT
      else process.env.PORT = previous
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 15000)
})

describe.runIf(process.platform === 'win32')('resolveWindowsPowerShell', () => {
  it('never resolves to the Microsoft Store app execution alias', () => {
    const shell = resolveWindowsPowerShell() as string

    expect(shell.toLowerCase()).not.toContain('windowsapps')
    if (path.isAbsolute(shell)) {
      expect(fs.statSync(shell).isFile()).toBe(true)
    }
  })

  it('resolves executables in PowerShell even if PATHEXT was missing in parent environment', async () => {
    const origPathext = process.env.PATHEXT
    try {
      delete process.env.PATHEXT
      const res = await runProcess('git --version', process.cwd())
      expect(res.exitCode).toBe(0)
      expect(res.stdout).toContain('git version')
    } finally {
      if (origPathext) process.env.PATHEXT = origPathext
    }
  })
})

