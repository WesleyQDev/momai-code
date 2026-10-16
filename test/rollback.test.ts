import { describe, it, expect, beforeEach, afterEach } from 'vitest'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const runtime = require('../runtime.ts')
const {
  recordCheckpoint,
  getCheckpoints,
  clearCheckpoints,
  rollbackCheckpoints
} = require('../core/checkpoints.ts')

describe('momai-code checkpoints & rollback', () => {
  let tempDir: string
  const threadId = 'test_thread_rollback'

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momai-code-rollback-test-'))
    clearCheckpoints(threadId)
  })

  afterEach(() => {
    clearCheckpoints(threadId)
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  })

  it('records checkpoint and reverts an edited file', () => {
    const testFile = path.join(tempDir, 'sample.txt')
    fs.writeFileSync(testFile, 'initial content', 'utf-8')

    // Simulate editing: record previous content
    recordCheckpoint(threadId, testFile, 'initial content', 'msg_1')
    fs.writeFileSync(testFile, 'modified content', 'utf-8')

    expect(fs.readFileSync(testFile, 'utf-8')).toBe('modified content')

    // Perform rollback
    const result = rollbackCheckpoints(threadId)
    expect(result.restoredCount).toBe(1)
    expect(result.restoredFiles).toContain(testFile)
    expect(fs.readFileSync(testFile, 'utf-8')).toBe('initial content')
  })

  it('records checkpoint and removes a newly created file on rollback', () => {
    const newFile = path.join(tempDir, 'created.txt')

    // Newly created file: previous content was null
    recordCheckpoint(threadId, newFile, null, 'msg_2')
    fs.writeFileSync(newFile, 'newly created content', 'utf-8')

    expect(fs.existsSync(newFile)).toBe(true)

    // Rollback should delete it
    const result = rollbackCheckpoints(threadId)
    expect(result.restoredCount).toBe(1)
    expect(result.restoredFiles).toContain(newFile)
    expect(fs.existsSync(newFile)).toBe(false)
  })

  it('executes code_rollback via runtime.execute', async () => {
    const testFile = path.join(tempDir, 'doc.txt')
    fs.writeFileSync(testFile, 'version 1', 'utf-8')

    recordCheckpoint(threadId, testFile, 'version 1', 'msg_3')
    fs.writeFileSync(testFile, 'version 2', 'utf-8')

    const response = await runtime.execute('code_rollback', {
      threadId,
      messageId: 'msg_3'
    })

    expect(response.ok).toBe(true)
    expect(response.restoredCount).toBe(1)
    expect(response.restoredFiles).toContain(testFile)
    expect(fs.readFileSync(testFile, 'utf-8')).toBe('version 1')
  })
})
