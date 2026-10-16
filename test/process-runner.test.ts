import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { truncateOutput, resolveWindowsPowerShell } = require('../core/process-runner.ts')

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

describe.runIf(process.platform === 'win32')('resolveWindowsPowerShell', () => {
  it('never resolves to the Microsoft Store app execution alias', () => {
    const shell = resolveWindowsPowerShell() as string

    expect(shell.toLowerCase()).not.toContain('windowsapps')
    if (path.isAbsolute(shell)) {
      expect(fs.statSync(shell).isFile()).toBe(true)
    }
  })
})
