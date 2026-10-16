import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const require = createRequire(import.meta.url)
const { CodeStateManager } = require('../core/storage.ts')
const { executeCodeSettings } = require('../routes/settings.ts')

describe('chat project selector backend actions', () => {
  let root: string
  let stateManager: any

  beforeEach(() => {
    root = path.join(os.tmpdir(), `momai_chat_proj_${Date.now()}`)
    fs.mkdirSync(root, { recursive: true })
    stateManager = new CodeStateManager()
  })

  afterEach(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {}
  })

  it('retrieves chat project and identifies git branch if repo present', async () => {
    // Cria projeto com .git/HEAD
    const projectDir = path.join(root, 'repo1')
    const gitDir = path.join(projectDir, '.git')
    fs.mkdirSync(gitDir, { recursive: true })
    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/feature/chat-elements\n')

    // Cadastra o projeto
    const addRes = await executeCodeSettings(
      { action: 'add_project', path: projectDir, name: 'Repo1', threadId: 'session_abc' },
      stateManager
    )
    expect(addRes.ok).toBe(true)

    // Consulta status do projeto no chat
    const getRes = await executeCodeSettings(
      { action: 'get_chat_project', threadId: 'session_abc' },
      stateManager
    )
    expect(getRes.ok).toBe(true)
    expect(getRes.activeProject).not.toBeNull()
    expect(getRes.activeProject.name).toBe('Repo1')
    expect(getRes.gitBranch).toBe('feature/chat-elements')

    // Alterna para Sem Projeto
    const setNone = await executeCodeSettings(
      { action: 'set_chat_project', threadId: 'session_abc', projectId: 'home' },
      stateManager
    )
    expect(setNone.ok).toBe(true)
    expect(setNone.activeProject).toBeNull()
    expect(setNone.gitBranch).toBeNull()
  })

  it('returns null gitBranch when directory is not a git repository', async () => {
    const plainDir = path.join(root, 'plain-project')
    fs.mkdirSync(plainDir, { recursive: true })

    const addRes = await executeCodeSettings(
      { action: 'add_project', path: plainDir, name: 'Plain', threadId: 'session_xyz' },
      stateManager
    )
    expect(addRes.ok).toBe(true)

    const getRes = await executeCodeSettings(
      { action: 'get_chat_project', threadId: 'session_xyz' },
      stateManager
    )
    expect(getRes.ok).toBe(true)
    expect(getRes.activeProject.name).toBe('Plain')
    expect(getRes.gitBranch).toBeNull()
  })

  it('new sessions inherit the last selected project until "Sem Projeto" is chosen', async () => {
    const projectDir = path.join(root, 'inherit-project')
    fs.mkdirSync(projectDir, { recursive: true })

    const addRes = await executeCodeSettings(
      { action: 'add_project', path: projectDir, name: 'Inherit', threadId: 'session_1' },
      stateManager
    )
    expect(addRes.ok).toBe(true)

    // Brand-new session picks up the last project.
    const fresh = await executeCodeSettings(
      { action: 'get_chat_project', threadId: 'session_2' },
      stateManager
    )
    expect(fresh.inherited).toBe(true)
    expect(fresh.activeProject.name).toBe('Inherit')

    // Re-reading the same session is not a new inheritance.
    const again = await executeCodeSettings(
      { action: 'get_chat_project', threadId: 'session_2' },
      stateManager
    )
    expect(again.inherited).toBe(false)
    expect(again.activeProject.name).toBe('Inherit')

    // Choosing "Sem Projeto" stops the inheritance for later sessions.
    await executeCodeSettings(
      { action: 'set_chat_project', threadId: 'session_2', projectId: 'home' },
      stateManager
    )
    const next = await executeCodeSettings(
      { action: 'get_chat_project', threadId: 'session_3' },
      stateManager
    )
    expect(next.inherited).toBe(false)
    expect(next.activeProject).toBeNull()
  })
})
