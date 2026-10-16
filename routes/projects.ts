const crypto = require('node:crypto')
import type { ToolContext, ProjectDefinition, CodeStateManager } from '../core/types.ts'

async function executeCodeProjectConfirm(
  args: Record<string, any>,
  stateManager: CodeStateManager,
  _context?: ToolContext
): Promise<any> {
  const requestId = String(args.requestId || '').trim()
  if (!requestId) {
    return { ok: false, error: 'requestId ausente' }
  }

  const state = await stateManager.load()
  const reqIndex = state.pendingRequests.findIndex((r) => r.id === requestId)

  if (reqIndex < 0) {
    return {
      ok: false,
      error: 'Solicitação expirada ou não encontrada. Peça ao agente para solicitar novamente se necessário.'
    }
  }

  const request = state.pendingRequests[reqIndex]
  state.pendingRequests.splice(reqIndex, 1)

  // Ensure unique name
  let name = request.name
  let counter = 1
  while (state.projects.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    name = `${request.name} (${counter++})`
  }

  const newProject: ProjectDefinition = {
    id: `p_${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}`,
    name,
    path: request.path,
    addedBy: 'chat',
    createdAt: new Date().toISOString()
  }

  state.projects.push(newProject)
  await stateManager.save(state)

  return {
    ok: true,
    message: `Projeto '${newProject.name}' (${newProject.path}) adicionado com sucesso!`,
    project: newProject
  }
}

async function executeCodeProjectCancel(
  args: Record<string, any>,
  stateManager: CodeStateManager,
  _context?: ToolContext
): Promise<any> {
  const requestId = String(args.requestId || '').trim()
  if (!requestId) {
    return { ok: false, error: 'requestId ausente' }
  }

  const state = await stateManager.load()
  const reqIndex = state.pendingRequests.findIndex((r) => r.id === requestId)

  if (reqIndex >= 0) {
    state.pendingRequests.splice(reqIndex, 1)
    await stateManager.save(state)
  }

  return {
    ok: true,
    message: 'Solicitação de acesso a projeto cancelada.'
  }
}

module.exports = {
  executeCodeProjectConfirm,
  executeCodeProjectCancel
}
