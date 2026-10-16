import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const require = createRequire(import.meta.url)
const { CodeStateManager } = require('../core/storage.ts')
const { executeCodeProjectUse, executeCodeChatContext } = require('../tools/projects.ts')
const { executeCodeRead } = require('../tools/files.ts')


const threadContext = { toolName: 'code_project_use', args: {}, threadId: 'thread_agents' }

describe('Project instructions (AGENTS.md)', () => {
  let tempTestDir: string
  let stateManager: any
  let indexPath: string

  beforeEach(() => {
    tempTestDir = path.join(os.tmpdir(), `momai_code_instr_${Date.now()}`)
    fs.mkdirSync(tempTestDir, { recursive: true })
    indexPath = path.join(tempTestDir, 'index.ts')
    fs.writeFileSync(indexPath, 'export const x = 1\n', 'utf8')

    stateManager = new CodeStateManager()
    const state = stateManager.getState()
    state.projects.push({
      id: 'p_instr',
      name: 'InstrProject',
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

  it('loads AGENTS.md into the result when entering the project', async () => {
    fs.writeFileSync(
      path.join(tempTestDir, 'AGENTS.md'),
      '# Regras do projeto\nUse pnpm e rode os testes antes de commitar.',
      'utf8'
    )

    const res = await executeCodeProjectUse({ project: 'InstrProject' }, stateManager, threadContext)
    expect(res.ok).toBe(true)
    expect(res.instruction).toContain('Projeto ativo')
    expect(res.instruction).toContain('AGENTS.md')
    expect(res.instruction).toContain('Use pnpm e rode os testes antes de commitar.')
  })

  it('does not mention instructions when the project has no AGENTS.md', async () => {
    const res = await executeCodeProjectUse({ project: 'InstrProject' }, stateManager, threadContext)
    expect(res.ok).toBe(true)
    expect(res.instruction).toContain('Projeto ativo')
    expect(res.instruction).not.toContain('AGENTS.md')
  })

  it('truncates very large instruction files with a continuation hint', async () => {
    fs.writeFileSync(path.join(tempTestDir, 'AGENTS.md'), 'x'.repeat(30000), 'utf8')

    const res = await executeCodeProjectUse({ project: 'InstrProject' }, stateManager, threadContext)
    expect(res.ok).toBe(true)
    expect(res.instruction).toContain('AGENTS.md')
    expect(res.instruction).toContain('truncado')
    expect(res.instruction.length).toBeLessThan(30000)
  })

  it('auto-attaches AGENTS.md on the first touch, even without code_project_use', async () => {
    fs.writeFileSync(path.join(tempTestDir, 'AGENTS.md'), '# Convenções\nRode os testes.', 'utf8')

    const first = await executeCodeRead({ path: indexPath }, stateManager, threadContext)
    expect(JSON.parse(first.instruction).projectInstructions).toContain('Rode os testes.')

    // Cooldown: the same thread does not receive the document again right away.
    const second = await executeCodeRead({ path: indexPath }, stateManager, threadContext)
    expect(JSON.parse(second.instruction).projectInstructions).toBeUndefined()

    // A different thread gets it again.
    const other = await executeCodeRead({ path: indexPath }, stateManager, {
      ...threadContext,
      threadId: 'thread_other'
    })
    expect(JSON.parse(other.instruction).projectInstructions).toContain('Rode os testes.')
  })

  it('does not duplicate the document right after code_project_use in the same thread', async () => {
    fs.writeFileSync(path.join(tempTestDir, 'AGENTS.md'), '# Convenções\nRode os testes.', 'utf8')

    await executeCodeProjectUse({ project: 'InstrProject' }, stateManager, threadContext)
    const read = await executeCodeRead({ path: indexPath }, stateManager, threadContext)
    expect(JSON.parse(read.instruction).projectInstructions).toBeUndefined()
  })

  it('code_chat_context respects cooldown across consecutive user messages', async () => {
    fs.writeFileSync(path.join(tempTestDir, 'AGENTS.md'), '# Convenções\nRegra secreta.', 'utf8')
    await executeCodeProjectUse({ project: 'InstrProject' }, stateManager, threadContext)

    // First prompt hook right after project use: instructions are in cooldown, so not duplicated
    const firstPrompt = await executeCodeChatContext({}, stateManager, threadContext)
    expect(firstPrompt.ok).toBe(true)
    expect(firstPrompt.instruction).toContain('InstrProject')
    expect(firstPrompt.instruction).not.toContain('Regra secreta.')
  })
})

