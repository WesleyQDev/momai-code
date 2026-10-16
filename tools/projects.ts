const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
import type { ToolContext, CodeStateManager } from '../core/types.ts'
const { getHomeRoot, normalizePath, isInsideOrEqual } = require('../core/perimeter.ts')
const { attachProjectInstructions } = require('../core/project-instructions.ts')

async function executeCodeProjects(
  _args: Record<string, any>,
  stateManager: CodeStateManager,
  context?: ToolContext
): Promise<any> {
  const state = await stateManager.load()
  const home = getHomeRoot()
  const threadId = context?.threadId
  const activeProjectId = threadId ? state.activeProjects[threadId] : undefined

  const projectList = [
    {
      id: 'home',
      name: home.name,
      path: home.path,
      isActive: !activeProjectId || activeProjectId === 'home',
      addedBy: 'system'
    },
    ...state.projects.map((p) => ({
      id: p.id,
      name: p.name,
      path: p.path,
      isActive: activeProjectId === p.id,
      addedBy: p.addedBy,
      lastUsedAt: p.lastUsedAt
    }))
  ]

  return {
    ok: true,
    instruction: JSON.stringify(
      {
        ok: true,
        activeProject: activeProjectId
          ? state.projects.find((p) => p.id === activeProjectId)?.name || 'Sem projeto (Home)'
          : 'Sem projeto (Home)',
        projectsCount: projectList.length,
        projects: projectList
      },
      null,
      2
    )
  }
}

async function executeCodeProjectUse(
  args: Record<string, any>,
  stateManager: CodeStateManager,
  context?: ToolContext
): Promise<any> {
  const rawProject = String(args.project || '').trim()
  if (!rawProject) {
    return { ok: false, error: 'Parâmetro obrigatório ausente: project.' }
  }

  const threadId = context?.threadId || 'default'
  const state = await stateManager.load()
  const query = rawProject.toLowerCase()

  if (query === 'home' || query === 'sem projeto' || query === 'sem projeto (home)') {
    delete state.activeProjects[threadId]
    delete state.lastChatProjectId
    await stateManager.save(state)
    const home = getHomeRoot()
    return {
      ok: true,
      instruction: `Projeto ativo desta conversa definido para: ${home.name} (${home.path}). O acesso desta conversa volta a cobrir a Home inteira e os projetos autorizados.`
    }
  }

  const matched = state.projects.find((p) => p.name.toLowerCase() === query)
  if (!matched) {
    const validNames = ['home', ...state.projects.map((p) => `"${p.name}"`)]
    return {
      ok: false,
      error: `Projeto '${rawProject}' não encontrado. Projetos autorizados disponíveis: ${validNames.join(', ')}.\nPara solicitar autorização de um novo caminho, utilize code_project_request.`
    }
  }

  state.activeProjects[threadId] = matched.id
  matched.lastUsedAt = new Date().toISOString()
  await stateManager.save(state)

  // The project's AGENTS.md travels with the switch: the model starts the work
  // already aligned with the repository's rules instead of discovering them by
  // trial and error on the next tool calls.
  const instructions = await attachProjectInstructions(stateManager, state, {
    threadId,
    project: matched,
    force: true
  })

  return {
    ok: true,
    instruction: `Projeto ativo desta conversa definido para: ${matched.name} (${matched.path}). As ferramentas ficam limitadas a essa pasta; use code_project_use { project: "home" } para voltar ao acesso geral.${instructions}`
  }
}

interface RegisterProjectResult {
  ok: boolean
  project?: any
  error?: string
}

/**
 * Registers a project whose path is already inside an authorized area. Used
 * when no new permission is being granted, so no confirmation card is shown.
 */
async function registerProject(
  state: any,
  stateManager: CodeStateManager,
  normalizedPath: string,
  rawName: unknown
): Promise<RegisterProjectResult> {
  const requestedName = String(rawName || '').trim()
  let name = requestedName || path.basename(normalizedPath) || 'Projeto'

  if (
    requestedName &&
    state.projects.some((p: any) => p.name.toLowerCase() === name.toLowerCase())
  ) {
    return { ok: false, error: `Já existe um projeto cadastrado com o nome '${name}'.` }
  }

  if (!requestedName) {
    let counter = 1
    const baseCandidate = name
    while (state.projects.some((p: any) => p.name.toLowerCase() === name.toLowerCase())) {
      counter += 1
      name = `${baseCandidate} (${counter})`
    }
  }

  const project = {
    id: `p_${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}`,
    name,
    path: normalizedPath,
    addedBy: 'chat',
    createdAt: new Date().toISOString()
  }
  state.projects.push(project)
  await stateManager.save(state)
  return { ok: true, project }
}

async function executeCodeProjectRequest(
  args: Record<string, any>,
  stateManager: CodeStateManager,
  context?: ToolContext
): Promise<any> {
  const inputPath = String(args.path || '').trim()
  if (!inputPath) {
    return { ok: false, error: 'Parâmetro obrigatório ausente: path.' }
  }

  if (!path.isAbsolute(inputPath)) {
    return {
      ok: false,
      error: `O caminho '${inputPath}' deve ser absoluto para adicionar um novo projeto.`
    }
  }

  const normalized = normalizePath(inputPath)
  if (!fs.existsSync(normalized)) {
    return {
      ok: false,
      error: `O caminho especificado não existe no sistema: '${inputPath}'.`
    }
  }

  const stat = fs.statSync(normalized)
  if (!stat.isDirectory()) {
    return {
      ok: false,
      error: `O caminho especificado não é um diretório: '${inputPath}'.`
    }
  }

  const state = await stateManager.load()
  const home = getHomeRoot()

  const existing = state.projects.find(
    (p) => normalizePath(p.path).toLowerCase() === normalized.toLowerCase()
  )
  if (existing) {
    return {
      ok: true,
      instruction: `A pasta '${normalized}' já é o projeto autorizado '${existing.name}'. Use code_project_use { project: "${existing.name}" } para ativá-lo nesta conversa.`
    }
  }

  if (normalized.toLowerCase() === home.path.toLowerCase()) {
    return {
      ok: true,
      instruction: `A pasta '${normalized}' é a própria Home, que já é a base padrão da extensão. Use code_project_use { project: "home" } para o modo geral.`
    }
  }

  // Paths inside Home (or inside an already authorized project) add no new
  // access: they are registered directly, without the confirmation card. The
  // card stays reserved for paths outside every authorized root, where real
  // permission is being granted. Registering a subfolder is how the user scopes
  // the assistant to one project, so nesting is allowed on purpose.
  const insideHome = isInsideOrEqual(normalized, home.path)
  const insideAuthorizedProject = state.projects.some((p) => isInsideOrEqual(normalized, p.path))
  if (insideHome || insideAuthorizedProject) {
    const registered = await registerProject(state, stateManager, normalized, args.name)
    if (!registered.ok) {
      return { ok: false, error: registered.error }
    }
    const project = registered.project
    return {
      ok: true,
      instruction:
        `Projeto '${project.name}' adicionado (${normalized}). O caminho já estava dentro de uma área autorizada (${insideHome ? 'a Home' : 'um projeto existente'}), então nenhuma autorização nova foi necessária. ` +
        `Chame code_project_use { project: "${project.name}" } para ativá-lo: as ferramentas da conversa ficam limitadas a essa pasta e o AGENTS.md do repositório é carregado quando existir.`
    }
  }

  const suggestedName = String(args.name || path.basename(normalized) || 'Novo Projeto').trim()
  const requestId = `req_proj_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`

  // Guard request in state with 15m TTL
  state.pendingRequests.push({
    id: requestId,
    name: suggestedName,
    path: normalized,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
  })
  await stateManager.save(state)

  const isWideDrive = /^[a-zA-Z]:\\?$/.test(normalized) || normalized === '/'
  const isSystemDir = /windows|program files|system32/i.test(normalized)

  const warningNote = isWideDrive || isSystemDir
    ? ' (Atenção: este diretório abrange arquivos amplos do sistema)'
    : ''

  const structuredResponse = {
    type: 'generic-extension',
    extension: 'momai-code',
    header: {
      title: 'Autorização de Acesso a Projeto',
      subtitle: `O agente de código solicitou permissão para trabalhar na pasta:${warningNote}`
    },
    items: [
      {
        id: requestId,
        label: suggestedName,
        description: normalized,
        badge: { text: 'Aguardando Aprovação', variant: 'warning' },
        primaryAction: {
          type: 'primary',
          label: 'Adicionar Projeto',
          endpoint: '/extensions/momai-code/projects/confirm',
          payload: { requestId },
          actionType: 'execute'
        },
        actions: [
          {
            type: 'ghost',
            label: 'Cancelar',
            endpoint: '/extensions/momai-code/projects/cancel',
            payload: { requestId },
            actionType: 'execute'
          }
        ]
      }
    ]
  }

  return {
    ok: true,
    structuredResponse,
    instruction: JSON.stringify({
      status: 'PROJECT_REQUEST_CARD_RENDERED',
      requestId,
      name: suggestedName,
      path: normalized,
      message: 'Um card de autorização foi apresentado ao usuário no chat. O acesso só será liberado se o usuário clicar em "Adicionar Projeto".'
    })
  }
}

async function executeCodeChatContext(
  args: Record<string, any>,
  stateManager: CodeStateManager,
  context?: ToolContext
): Promise<any> {
  const threadId = context?.threadId || args?.threadId || 'default'
  const state = await stateManager.load()
  const activeProjectId = state.activeProjects ? state.activeProjects[threadId] : undefined

  if (!activeProjectId || activeProjectId === 'home') {
    return { ok: true, instruction: '' }
  }

  const matched = state.projects.find((p) => p.id === activeProjectId)
  if (!matched) {
    return { ok: true, instruction: '' }
  }

  const instructions = await attachProjectInstructions(stateManager, state, {
    threadId,
    project: matched
  })


  return {
    ok: true,
    instruction: `[MomAI Code - Projeto Ativo: "${matched.name}"]\nO usuário selecionou o projeto "${matched.name}" (${matched.path}) para esta conversa. Execute as ferramentas de código (code_read, code_grep, code_glob, code_bash, etc.) com escopo padrão nesta pasta, sem pedir confirmação do projeto.${instructions}`
  }
}

module.exports = {
  executeCodeProjects,
  executeCodeProjectUse,
  executeCodeProjectRequest,
  executeCodeChatContext
}

