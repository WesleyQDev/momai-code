import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const require = createRequire(import.meta.url)
const { CodeStateManager } = require('../core/storage.ts')
const { executeCodeAttach } = require('../tools/attachments.ts')
const { executeCodeRead } = require('../tools/files.ts')

function attachmentContext(stagedPath: string, name = 'foto.png') {
  return {
    toolName: 'code_attach',
    args: {},
    threadId: 'thread_attach',
    attachments: [
      { id: 'att-1', name, mimeType: 'image/png', size: 7, path: stagedPath, kind: 'image' }
    ]
  }
}

describe('attachment tools (code_attach)', () => {
  let projectDir: string
  let stagingDir: string
  let stagedPath: string
  let stateManager: any

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momai_attach_project_'))
    stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momai_attach_staging_'))
    stagedPath = path.join(stagingDir, 'att-1-foto.png')
    fs.writeFileSync(stagedPath, Buffer.from('PNGDATA'))

    stateManager = new CodeStateManager()
    stateManager.getState().projects.push({
      id: 'p_attach',
      name: 'AttachProject',
      path: projectDir,
      addedBy: 'page',
      createdAt: new Date().toISOString()
    })
  })

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true })
    fs.rmSync(stagingDir, { recursive: true, force: true })
  })

  it('copies an attachment by name into the project root by default', async () => {
    const res = await executeCodeAttach(
      { attachment: 'foto.png', project: 'AttachProject' },
      stateManager,
      attachmentContext(stagedPath)
    )

    expect(res.ok).toBe(true)
    const parsed = JSON.parse(res.instruction)
    expect(parsed.path).toBe(path.join(projectDir, 'foto.png'))
    expect(fs.readFileSync(parsed.path, 'utf-8')).toBe('PNGDATA')
  })

  it('accepts the working-copy path and honors destination and fileName', async () => {
    const res = await executeCodeAttach(
      {
        attachment: stagedPath,
        destination: 'assets/logo.png',
        project: 'AttachProject'
      },
      stateManager,
      attachmentContext(stagedPath)
    )

    expect(res.ok).toBe(true)
    const parsed = JSON.parse(res.instruction)
    expect(parsed.path).toBe(path.join(projectDir, 'assets', 'logo.png'))
    expect(fs.existsSync(parsed.path)).toBe(true)
  })

  it('treats an extension-less destination as a folder', async () => {
    const res = await executeCodeAttach(
      { attachment: 'foto.png', destination: 'assets/imagens', project: 'AttachProject' },
      stateManager,
      attachmentContext(stagedPath)
    )

    expect(res.ok).toBe(true)
    expect(fs.existsSync(path.join(projectDir, 'assets', 'imagens', 'foto.png'))).toBe(true)
  })

  it('rejects an attachment outside the message allowlist', async () => {
    const res = await executeCodeAttach(
      { attachment: '../../outro.png', project: 'AttachProject' },
      stateManager,
      attachmentContext(stagedPath)
    )

    expect(res.ok).toBe(false)
    expect(String(res.error)).toContain('não encontrado entre os anexos')
  })

  it('rejects a message without attachments', async () => {
    const res = await executeCodeAttach(
      { attachment: 'foto.png', project: 'AttachProject' },
      stateManager,
      { toolName: 'code_attach', args: {}, threadId: 'thread_attach' }
    )

    expect(res.ok).toBe(false)
    expect(String(res.error)).toContain('Nenhum anexo disponível')
  })

  it('requires an explicit destination when no project is active', async () => {
    const res = await executeCodeAttach(
      { attachment: 'foto.png' },
      stateManager,
      attachmentContext(stagedPath)
    )

    expect(res.ok).toBe(false)
    expect(String(res.error)).toContain('Nenhum projeto ativo')
  })

  it('refuses a destination outside the project perimeter', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momai_attach_outside_'))
    try {
      const res = await executeCodeAttach(
        { attachment: 'foto.png', destination: path.join(outsideDir, 'copia.png'), project: 'AttachProject' },
        stateManager,
        attachmentContext(stagedPath)
      )
      expect(res.ok).toBe(false)
      expect(String(res.error)).toContain('fora do perímetro')
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('refuses to write into the attachment staging folder', async () => {
    // Staged copies can live inside the project perimeter (home mode); writing
    // there would corrupt the read-only source, so the tool refuses it.
    const innerStaging = path.join(projectDir, '.attachments')
    fs.mkdirSync(innerStaging, { recursive: true })
    const innerCopy = path.join(innerStaging, 'att-2-doc.txt')
    fs.writeFileSync(innerCopy, 'DOC')

    const res = await executeCodeAttach(
      { attachment: 'doc.txt', destination: path.join(innerStaging, 'copia.txt'), project: 'AttachProject' },
      stateManager,
      attachmentContext(innerCopy, 'doc.txt')
    )

    expect(res.ok).toBe(false)
    expect(String(res.error)).toContain('pasta de anexos')
  })

  it('requires overwrite when the destination already exists', async () => {
    fs.writeFileSync(path.join(projectDir, 'foto.png'), 'antigo')

    const blocked = await executeCodeAttach(
      { attachment: 'foto.png', project: 'AttachProject' },
      stateManager,
      attachmentContext(stagedPath)
    )
    expect(blocked.ok).toBe(false)
    expect(String(blocked.error)).toContain('overwrite')

    const overwritten = await executeCodeAttach(
      { attachment: 'foto.png', project: 'AttachProject', overwrite: true },
      stateManager,
      attachmentContext(stagedPath)
    )
    expect(overwritten.ok).toBe(true)
    expect(fs.readFileSync(path.join(projectDir, 'foto.png'), 'utf-8')).toBe('PNGDATA')
  })

  it('reads the staged copy but cannot write to it', async () => {
    const readable = await executeCodeRead(
      { path: stagedPath, project: 'AttachProject' },
      stateManager,
      {
        toolName: 'code_read',
        args: {},
        threadId: 'thread_attach',
        attachments: [{ id: 'att-1', name: 'foto.png', path: stagedPath, kind: 'image' }]
      }
    )
    expect(readable.ok).toBe(true)
    expect(JSON.parse(readable.instruction).content).toContain('PNGDATA')

    const denied = executeCodeRead(
      { path: stagedPath, project: 'AttachProject' },
      stateManager,
      { toolName: 'code_read', args: {}, threadId: 'thread_attach' }
    )
    await expect(denied).rejects.toThrow('Acesso negado')
  })
})
