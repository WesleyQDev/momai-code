import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const require = createRequire(import.meta.url)
const { CodeStateManager } = require('../core/storage.ts')
const { executeCodeProjectRequest } = require('../tools/projects.ts')
const { validatePerimeter, isInsideOrEqual } = require('../core/perimeter.ts')

// The direct-registration branch only applies when the temp folder sits inside
// the user's Home (typical on Windows). On systems where os.tmpdir() lives
// outside Home the confirmation card flow still applies.
const tempInsideHome = isInsideOrEqual(os.tmpdir(), os.homedir())
const itInsideHome = it.skipIf(!tempInsideHome)

const threadContext = { toolName: 'code_project_request', args: {}, threadId: 'thread_req' }

describe('code_project_request', () => {
  let root: string
  let stateManager: any

  beforeEach(() => {
    root = path.join(os.tmpdir(), `momai_req_${Date.now()}`)
    fs.mkdirSync(path.join(root, 'cuninho'), { recursive: true })
    stateManager = new CodeStateManager()
  })

  afterEach(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {}
  })

  itInsideHome('registers a Home subfolder directly, without the card', async () => {
    const target = path.join(root, 'cuninho')
    const res = await executeCodeProjectRequest({ path: target }, stateManager, threadContext)

    expect(res.ok).toBe(true)
    expect(res.structuredResponse).toBeUndefined()
    expect(res.instruction).toContain('adicionado')
    expect(res.instruction).toContain('code_project_use')

    const state = stateManager.getState()
    expect(
      state.projects.some((p: any) => p.path.toLowerCase() === target.toLowerCase())
    ).toBe(true)
  })

  itInsideHome('allows a nested project inside an existing project', async () => {
    const parent = path.join(root)
    const child = path.join(root, 'cuninho')

    const parentRes = await executeCodeProjectRequest({ path: parent }, stateManager, threadContext)
    expect(parentRes.ok).toBe(true)
    expect(parentRes.instruction).toContain('adicionado')

    const childRes = await executeCodeProjectRequest({ path: child }, stateManager, threadContext)
    expect(childRes.ok).toBe(true)
    expect(childRes.instruction).toContain('adicionado')

    const names = stateManager.getState().projects.map((p: any) => p.name)
    expect(names).toContain('cuninho')
  })

  it('explains when the path is the Home root itself', async () => {
    const res = await executeCodeProjectRequest({ path: os.homedir() }, stateManager, threadContext)
    expect(res.ok).toBe(true)
    expect(res.instruction).toContain('Home')
    expect(stateManager.getState().projects).toHaveLength(0)
  })

  itInsideHome('reports when the folder already is a project', async () => {
    const target = path.join(root, 'cuninho')
    await executeCodeProjectRequest({ path: target, name: 'cuninho' }, stateManager, threadContext)
    const again = await executeCodeProjectRequest({ path: target }, stateManager, threadContext)
    expect(again.ok).toBe(true)
    expect(again.instruction).toContain('já é o projeto')
    expect(stateManager.getState().projects).toHaveLength(1)
  })

  itInsideHome('a project in use scopes reads to it; home mode keeps the union', async () => {
    const target = path.join(root, 'cuninho')
    await executeCodeProjectRequest({ path: target }, stateManager, threadContext)
    const state = stateManager.getState()
    const project = state.projects[0]
    state.activeProjects['thread_scoped'] = project.id

    const outsideHomePath = path.join(os.homedir(), '__momai_scope_probe__', 'file.txt')
    const insideProjectPath = path.join(target, 'src', 'index.ts')

    // Inside the project: fine.
    expect(() => validatePerimeter(insideProjectPath, state, undefined, 'thread_scoped')).not.toThrow()

    // Inside Home but outside the project: denied while the project is active.
    expect(() => validatePerimeter(outsideHomePath, state, undefined, 'thread_scoped')).toThrow(
      /Acesso negado/
    )

    // Same path in Home mode: allowed again (union perimeter).
    expect(() => validatePerimeter(outsideHomePath, state)).not.toThrow()
  })
})
