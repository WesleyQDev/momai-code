import { describe, it, expect, beforeAll, afterAll } from 'vitest'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')

// The host recycles the background worker on server hot-reload and app
// restart. Checkpoints recorded before the restart must still be revertible
// from a fresh worker process, otherwise "undo changes" silently reverts
// nothing after any restart.
describe('checkpoints persistence across worker restarts', () => {
  const previousStorageDir = process.env.MOMAI_EXTENSION_STORAGE_DIR
  const threadId = `persistence_${Date.now()}`
  let storageDir: string
  let filesDir: string

  beforeAll(() => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momai-code-store-'))
    filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momai-code-files-'))
    process.env.MOMAI_EXTENSION_STORAGE_DIR = storageDir
  })

  afterAll(() => {
    if (previousStorageDir === undefined) {
      delete process.env.MOMAI_EXTENSION_STORAGE_DIR
    } else {
      process.env.MOMAI_EXTENSION_STORAGE_DIR = previousStorageDir
    }
    fs.rmSync(storageDir, { recursive: true, force: true })
    fs.rmSync(filesDir, { recursive: true, force: true })
  })

  it('reverts edits recorded before the worker was recycled', () => {
    const checkpoints = require('../core/checkpoints.ts')
    const targetFile = path.join(filesDir, 'sample.txt')
    fs.writeFileSync(targetFile, 'before edit', 'utf-8')

    // Worker A records the checkpoint and the edit happens.
    checkpoints.recordCheckpoint(threadId, targetFile, 'before edit', 'msg_1')
    fs.writeFileSync(targetFile, 'after edit', 'utf-8')

    expect(fs.existsSync(path.join(storageDir, 'edit-checkpoints.json'))).toBe(true)

    // Worker B is a brand-new process (the host recycled the worker): only the
    // on-disk store can supply the pending checkpoint it must revert.
    const checkpointsPath = path.join(process.cwd(), 'core', 'checkpoints.ts')
    const script = [
      `const checkpoints = require(${JSON.stringify(checkpointsPath)})`,
      `const result = checkpoints.rollbackCheckpoints(${JSON.stringify(threadId)})`,
      `process.stdout.write(JSON.stringify(result))`
    ].join('\n')
    const output = execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, MOMAI_EXTENSION_STORAGE_DIR: storageDir },
      encoding: 'utf-8'
    })

    const result = JSON.parse(output)
    expect(result.restoredCount).toBe(1)
    expect(result.restoredFiles).toContain(targetFile)
    expect(fs.readFileSync(targetFile, 'utf-8')).toBe('before edit')
  })
})
