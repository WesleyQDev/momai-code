import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const require = createRequire(import.meta.url)
const { CodeStateManager } = require('../core/storage.ts')
const {
  executeCodeWrite,
  executeCodeRead,
  executeCodeEdit,
  executeCodeList
} = require('../tools/files.ts')
const {
  executeCodeProjects,
  executeCodeProjectUse
} = require('../tools/projects.ts')

describe('File and Project Tools', () => {
  let tempTestDir: string
  let stateManager: any

  beforeEach(() => {
    tempTestDir = path.join(os.tmpdir(), `momai_code_test_${Date.now()}`)
    fs.mkdirSync(tempTestDir, { recursive: true })

    stateManager = new CodeStateManager()
    const state = stateManager.getState()
    state.projects.push({
      id: 'p_test',
      name: 'TestProject',
      path: tempTestDir,
      addedBy: 'page',
      createdAt: new Date().toISOString()
    })
  })

  afterEach(() => {
    try {
      fs.rmSync(tempTestDir, { recursive: true, force: true })
    } catch {}
  })

  it('writes and reads files with line numbering', async () => {
    const filePath = 'example.txt'
    const content = 'Line 1: Alpha\nLine 2: Beta\nLine 3: Gamma'

    // Write file
    const writeRes = await executeCodeWrite(
      { path: filePath, content, project: 'TestProject' },
      stateManager
    )
    expect(writeRes.ok).toBe(true)

    // Read file
    const readRes = await executeCodeRead(
      { path: filePath, project: 'TestProject', offset: 2, limit: 2 },
      stateManager
    )
    expect(readRes.ok).toBe(true)
    const parsed = JSON.parse(readRes.instruction)
    expect(parsed.totalLines).toBe(3)
    expect(parsed.returnedLines).toBe(2)
    expect(parsed.content).toContain('2 | Line 2: Beta')
    expect(parsed.content).toContain('3 | Line 3: Gamma')
  })

  it('edits file with exact string match', async () => {
    const filePath = 'code.ts'
    const initialCode = 'const val = 10\nconsole.log(val)'

    await executeCodeWrite(
      { path: filePath, content: initialCode, project: 'TestProject' },
      stateManager
    )

    const editRes = await executeCodeEdit(
      {
        path: filePath,
        target: 'const val = 10',
        replacement: 'const val = 42',
        project: 'TestProject'
      },
      stateManager
    )
    expect(editRes.ok).toBe(true)

    const fullPath = path.join(tempTestDir, filePath)
    const updated = fs.readFileSync(fullPath, 'utf-8')
    expect(updated).toBe('const val = 42\nconsole.log(val)')
  })

  it('reports changed-line counts as step badges after an edit', async () => {
    const filePath = 'badges.ts'
    await executeCodeWrite(
      { path: filePath, content: 'alpha\nbeta\ngamma', project: 'TestProject' },
      stateManager
    )

    const editRes = await executeCodeEdit(
      {
        path: filePath,
        target: 'beta',
        replacement: 'BETA\nBETA2',
        project: 'TestProject'
      },
      stateManager
    )
    expect(editRes.ok).toBe(true)
    expect(editRes.step?.badges).toEqual([
      { text: '+2', tone: 'success' },
      { text: '-1', tone: 'danger' }
    ])
  })

  it('scales changed-line counts by occurrence for replaceAll', async () => {
    const filePath = 'replace-all.txt'
    await executeCodeWrite(
      { path: filePath, content: 'foo one\nfoo two', project: 'TestProject' },
      stateManager
    )

    const editRes = await executeCodeEdit(
      {
        path: filePath,
        target: 'foo',
        replacement: 'bar',
        replaceAll: true,
        project: 'TestProject'
      },
      stateManager
    )
    expect(editRes.ok).toBe(true)
    expect(editRes.step?.badges).toEqual([
      { text: '+2', tone: 'success' },
      { text: '-2', tone: 'danger' }
    ])
  })

  it('refuses edit if target is not unique and replaceAll is false', async () => {
    const filePath = 'multi.txt'
    const initial = 'foo bar foo baz'

    await executeCodeWrite(
      { path: filePath, content: initial, project: 'TestProject' },
      stateManager
    )

    const editRes = await executeCodeEdit(
      {
        path: filePath,
        target: 'foo',
        replacement: 'qux',
        project: 'TestProject'
      },
      stateManager
    )
    expect(editRes.ok).toBe(false)
    expect(editRes.error).toContain('encontrado 2 vezes')
  })

  it('switches active project per threadId and reflects in code_projects', async () => {
    const threadId = 'thread_42'

    // Switch to TestProject
    const useRes = await executeCodeProjectUse(
      { project: 'TestProject' },
      stateManager,
      { toolName: 'code_project_use', args: {}, threadId }
    )
    expect(useRes.ok).toBe(true)

    // Check code_projects
    const listRes = await executeCodeProjects(
      {},
      stateManager,
      { toolName: 'code_projects', args: {}, threadId }
    )
    expect(listRes.ok).toBe(true)
    const data = JSON.parse(listRes.instruction)
    expect(data.activeProject).toBe('TestProject')
  })

  it('reads stream slices efficiently with accurate line count', async () => {
    const filePath = 'lines.txt'
    const totalLines = 1000
    const content = Array.from({ length: totalLines }, (_, i) => `Line ${i + 1}`).join('\n')

    await executeCodeWrite(
      { path: filePath, content, project: 'TestProject' },
      stateManager
    )

    const readRes = await executeCodeRead(
      { path: filePath, project: 'TestProject', offset: 50, limit: 400 },
      stateManager
    )
    expect(readRes.ok).toBe(true)
    const parsed = JSON.parse(readRes.instruction)
    expect(parsed.totalLines).toBe(1000)
    expect(parsed.returnedLines).toBe(400)
    expect(parsed.hasMore).toBe(true)
    expect(parsed.nextOffset).toBe(450)
    expect(parsed.content).toContain('50 | Line 50')
    expect(parsed.content).toContain('449 | Line 449')
    expect(parsed.content).not.toContain('450 | Line 450')
    expect(parsed.hint).toBeUndefined()
  })

  it('widens tiny read windows to the minimum to save model rounds', async () => {
    const filePath = 'wide.txt'
    const content = Array.from({ length: 1000 }, (_, i) => `Line ${i + 1}`).join('\n')
    await executeCodeWrite({ path: filePath, content, project: 'TestProject' }, stateManager)

    const readRes = await executeCodeRead(
      { path: filePath, project: 'TestProject', offset: 100, limit: 20 },
      stateManager
    )
    const parsed = JSON.parse(readRes.instruction)
    expect(parsed.limit).toBe(300)
    expect(parsed.returnedLines).toBe(300)
    expect(parsed.content).toContain('100 | Line 100')
    expect(parsed.content).toContain('399 | Line 399')
    expect(parsed.nextOffset).toBe(400)
    expect(parsed.hint).toContain('20')
  })

  it('stops a widened read at the end of a short file', async () => {
    const filePath = 'short.txt'
    const content = Array.from({ length: 150 }, (_, i) => `Line ${i + 1}`).join('\n')
    await executeCodeWrite({ path: filePath, content, project: 'TestProject' }, stateManager)

    const readRes = await executeCodeRead(
      { path: filePath, project: 'TestProject', offset: 50, limit: 10 },
      stateManager
    )
    const parsed = JSON.parse(readRes.instruction)
    expect(parsed.returnedLines).toBe(101)
    expect(parsed.hasMore).toBe(false)
    expect(parsed.content).toContain('150 | Line 150')
  })

  it('edits file with multiple atomic chunks and CRLF tolerance', async () => {
    const filePath = 'crlf.ts'
    const initialCode = 'function a() {\r\n  return 1\r\n}\r\nfunction b() {\r\n  return 2\r\n}'

    await executeCodeWrite(
      { path: filePath, content: initialCode, project: 'TestProject' },
      stateManager
    )

    // Send chunks with LF only (typical LLM output) against CRLF file
    const editRes = await executeCodeEdit(
      {
        path: filePath,
        chunks: [
          { target: 'return 1', replacement: 'return 10' },
          { target: 'return 2', replacement: 'return 20' }
        ],
        project: 'TestProject'
      },
      stateManager
    )
    expect(editRes.ok).toBe(true)
    const parsed = JSON.parse(editRes.instruction)
    expect(parsed.chunksApplied).toBe(2)
    expect(parsed.replacementsCount).toBe(2)

    const fullPath = path.join(tempTestDir, filePath)
    const updated = fs.readFileSync(fullPath, 'utf-8')
    expect(updated).toBe('function a() {\r\n  return 10\r\n}\r\nfunction b() {\r\n  return 20\r\n}')
  })

  it('aborts all chunks atomically if any chunk target is missing', async () => {
    const filePath = 'atomic.ts'
    const initialCode = 'const x = 1\nconst y = 2'

    await executeCodeWrite(
      { path: filePath, content: initialCode, project: 'TestProject' },
      stateManager
    )

    const editRes = await executeCodeEdit(
      {
        path: filePath,
        chunks: [
          { target: 'const x = 1', replacement: 'const x = 99' },
          { target: 'const NON_EXISTENT = 3', replacement: 'const z = 3' }
        ],
        project: 'TestProject'
      },
      stateManager
    )
    expect(editRes.ok).toBe(false)
    expect(editRes.error).toContain('não foi encontrado')

    // Original file must NOT have been partially modified
    const fullPath = path.join(tempTestDir, filePath)
    const afterFailedEdit = fs.readFileSync(fullPath, 'utf-8')
    expect(afterFailedEdit).toBe(initialCode)
  })
})

