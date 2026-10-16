import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const {
  getHomeRoot,
  resolveTargetRoot,
  validatePerimeter,
  isInsideOrEqual
} = require('../core/perimeter.ts')
const { createDefaultState } = require('../core/storage.ts')

describe('Perimeter Guard', () => {
  it('defaults to home directory when no project or threadId is set', () => {
    const state = createDefaultState()
    const root = resolveTargetRoot(state)
    expect(root.isHome).toBe(true)
    expect(root.path.toLowerCase()).toBe(os.homedir().toLowerCase())
  })

  it('resolves active project by threadId', () => {
    const state = createDefaultState()
    state.projects.push({
      id: 'proj_1',
      name: 'MomAI',
      path: os.homedir(), // Safe path for test
      addedBy: 'page',
      createdAt: new Date().toISOString()
    })
    state.activeProjects['thread_abc'] = 'proj_1'

    const root = resolveTargetRoot(state, undefined, 'thread_abc')
    expect(root.name).toBe('MomAI')
    expect(root.id).toBe('proj_1')
  })

  it('rejects path traversal attempting to escape perimeter', () => {
    const state = createDefaultState()
    // Attempt to escape home via ../..
    const escapePath = path.resolve(os.homedir(), '..', '..', 'Windows', 'System32')

    // If on Windows and escapePath is outside home and no project covers it
    if (!isInsideOrEqual(escapePath, os.homedir())) {
      expect(() => {
        validatePerimeter(escapePath, state)
      }).toThrow(/Acesso negado/)
    }
  })

  it('allows paths within home perimeter', () => {
    const state = createDefaultState()
    const safePath = path.join(os.homedir(), 'safe-file.txt')
    const result = validatePerimeter(safePath, state)
    expect(result.allowed).toBe(true)
    expect(result.matchedRoot?.isHome).toBe(true)
  })

  it('allows paths within extra authorized project', () => {
    const state = createDefaultState()
    const tempDir = os.tmpdir()
    state.projects.push({
      id: 'proj_temp',
      name: 'TempProject',
      path: tempDir,
      addedBy: 'page',
      createdAt: new Date().toISOString()
    })

    const target = path.join(tempDir, 'subfolder', 'test.txt')
    const result = validatePerimeter(target, state, 'TempProject')
    expect(result.allowed).toBe(true)
    expect(result.matchedRoot?.name).toBe('TempProject')
  })
})
