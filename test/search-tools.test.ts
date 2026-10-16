import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const require = createRequire(import.meta.url)
const { CodeStateManager } = require('../core/storage.ts')
const { executeCodeGlob, executeCodeGrep } = require('../tools/search.ts')
const { executeCodeList } = require('../tools/files.ts')

describe('Search tools', () => {
  let tempTestDir: string
  let stateManager: any

  beforeEach(() => {
    tempTestDir = path.join(os.tmpdir(), `momai_code_search_${Date.now()}`)
    fs.mkdirSync(path.join(tempTestDir, 'src', 'nested'), { recursive: true })
    fs.mkdirSync(path.join(tempTestDir, 'node_modules', 'pkg'), { recursive: true })
    fs.mkdirSync(path.join(tempTestDir, '.kilo', 'worktrees', 'copy'), { recursive: true })

    fs.writeFileSync(
      path.join(tempTestDir, 'src', 'index.ts'),
      'export const foo = 1\n// marker line\n'
    )
    fs.writeFileSync(path.join(tempTestDir, 'src', 'nested', 'deep.tsx'), 'const deep = true\n')
    fs.writeFileSync(path.join(tempTestDir, 'node_modules', 'pkg', 'dep.ts'), 'const marker = 1\n')
    fs.writeFileSync(
      path.join(tempTestDir, '.kilo', 'worktrees', 'copy', 'dup.ts'),
      'const marker = 2\n'
    )

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

  it('glob supports ** and ignores dependency and worktree directories', async () => {
    const res = await executeCodeGlob({ pattern: '**/*.ts', project: 'TestProject' }, stateManager)
    expect(res.ok).toBe(true)
    const data = JSON.parse(res.instruction)
    expect(data.matches).toEqual(['src/index.ts'])
  })

  it('glob patterns with a path prefix match the relative path', async () => {
    const res = await executeCodeGlob(
      { pattern: 'src/**/*.tsx', project: 'TestProject' },
      stateManager
    )
    const data = JSON.parse(res.instruction)
    expect(data.matches).toEqual(['src/nested/deep.tsx'])
  })

  it('grep on a single file path returns its matches (regression: used to return zero)', async () => {
    const res = await executeCodeGrep(
      {
        query: 'marker',
        path: path.join(tempTestDir, 'src', 'index.ts'),
        project: 'TestProject'
      },
      stateManager
    )
    expect(res.ok).toBe(true)
    const data = JSON.parse(res.instruction)
    expect(data.matchesCount).toBe(1)
    expect(data.results[0].file).toBe('index.ts')
    expect(data.results[0].line).toBe(2)
  })

  it('grep skips ignored directories by default', async () => {
    const res = await executeCodeGrep({ query: 'marker', project: 'TestProject' }, stateManager)
    const data = JSON.parse(res.instruction)
    expect(data.results.map((entry: any) => entry.file)).toEqual(['src/index.ts'])
  })

  it('grep include filter narrows the scanned files', async () => {
    const res = await executeCodeGrep(
      { query: 'deep', include: '*.tsx', project: 'TestProject' },
      stateManager
    )
    const data = JSON.parse(res.instruction)
    expect(data.matchesCount).toBe(1)
    expect(data.results[0].file).toBe('src/nested/deep.tsx')
  })

  it('grep returns context lines around a match', async () => {
    const res = await executeCodeGrep(
      { query: 'marker', path: 'src', context: 1, project: 'TestProject' },
      stateManager
    )
    const data = JSON.parse(res.instruction)
    expect(data.results[0].before).toEqual(['export const foo = 1'])
    expect(data.results[0].after).toEqual([''])
  })

  it('list hides dependency and worktree directories', async () => {
    const res = await executeCodeList({ path: '.', depth: 2, project: 'TestProject' }, stateManager)
    expect(res.ok).toBe(true)
    const data = JSON.parse(res.instruction)
    const names = data.entries.map((entry: any) => entry.name)
    expect(names.some((name: string) => name.startsWith('src'))).toBe(true)
    expect(
      names.every(
        (name: string) => !name.startsWith('node_modules') && !name.startsWith('.kilo')
      )
    ).toBe(true)
  })

  it('hints about isRegex when a literal pipe query finds nothing', async () => {
    const literal = await executeCodeGrep(
      { query: 'alpha|beta', project: 'TestProject' },
      stateManager
    )
    const literalData = JSON.parse(literal.instruction)
    expect(literalData.matchesCount).toBe(0)
    expect(literalData.hint).toContain('isRegex')

    const regex = await executeCodeGrep(
      { query: 'alpha|beta', isRegex: true, project: 'TestProject' },
      stateManager
    )
    const regexData = JSON.parse(regex.instruction)
    expect(regexData.hint).toBeUndefined()
  })

  it('grep skips binary files and heavy directories like .worktrees and .dev-data', async () => {
    fs.mkdirSync(path.join(tempTestDir, '.worktrees', 'branch'), { recursive: true })
    fs.mkdirSync(path.join(tempTestDir, '.dev-data', 'cache'), { recursive: true })
    fs.writeFileSync(path.join(tempTestDir, '.worktrees', 'branch', 'wt.ts'), 'const marker = 99\n')
    fs.writeFileSync(path.join(tempTestDir, '.dev-data', 'cache', 'data.json'), '{"marker": 100}\n')
    fs.writeFileSync(path.join(tempTestDir, 'src', 'asset.png'), 'binary marker content')
    fs.writeFileSync(path.join(tempTestDir, 'src', 'model.onnx'), 'binary marker content')

    const res = await executeCodeGrep({ query: 'marker', project: 'TestProject' }, stateManager)
    const data = JSON.parse(res.instruction)
    const files = data.results.map((entry: any) => entry.file)
    expect(files).toEqual(['src/index.ts'])
    expect(files).not.toContain('src/asset.png')
    expect(files).not.toContain('src/model.onnx')
    expect(files).not.toContain('.worktrees/branch/wt.ts')
    expect(files).not.toContain('.dev-data/cache/data.json')
  })
})

