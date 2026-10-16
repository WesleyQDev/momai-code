const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const cp = require('node:child_process')
import type {
  ToolContext,
  ProjectDefinition,
  TerminalRule,
  TerminalRuleAction,
  CodeStateManager
} from '../core/types.ts'
const { getHomeRoot, normalizePath } = require('../core/perimeter.ts')
const { DEFAULT_PRESET_RULES } = require('../core/storage.ts')

async function addProjectToState(
  rawPath: string,
  rawName: string | undefined,
  stateManager: CodeStateManager
): Promise<{ ok: boolean; message?: string; error?: string; project?: ProjectDefinition }> {
  const home = getHomeRoot()
  const state = await stateManager.load()

  const trimmedPath = String(rawPath || '').trim()
  const trimmedName = String(rawName || '').trim()

  if (!trimmedPath) return { ok: false, error: 'Caminho do projeto é obrigatório.' }
  if (!path.isAbsolute(trimmedPath)) return { ok: false, error: 'O caminho do projeto deve ser absoluto.' }

  const normalized = normalizePath(trimmedPath)
  if (!fs.existsSync(normalized)) {
    return { ok: false, error: `O caminho informado não existe no sistema: '${trimmedPath}'.` }
  }
  const stat = fs.statSync(normalized)
  if (!stat.isDirectory()) {
    return { ok: false, error: `O caminho informado não é um diretório: '${trimmedPath}'.` }
  }

  if (normalized.toLowerCase() === home.path.toLowerCase()) {
    return { ok: false, error: 'A pasta pessoal (Home) já é a base padrão da extensão.' }
  }

  const existing = state.projects.find((p: any) => p.path === normalized)
  if (existing) {
    return { ok: true, message: `Projeto '${existing.name}' selecionado com sucesso!`, project: existing }
  }

  let name = trimmedName || path.basename(normalized) || 'Projeto'
  if (!trimmedName) {
    let counter = 1
    const baseCandidate = name
    while (state.projects.some((p: any) => p.name.toLowerCase() === name.toLowerCase())) {
      counter++
      name = `${baseCandidate} (${counter})`
    }
  } else if (state.projects.some((p: any) => p.name.toLowerCase() === name.toLowerCase())) {
    return { ok: false, error: `Já existe um projeto cadastrado com o nome '${name}'.` }
  }

  const newProj: ProjectDefinition = {
    id: `p_${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}`,
    name,
    path: normalized,
    addedBy: 'page',
    createdAt: new Date().toISOString()
  }
  state.projects.push(newProj)
  await stateManager.save(state)
  return { ok: true, message: `Projeto '${newProj.name}' adicionado com sucesso!`, project: newProj }
}

function getGitBranch(projectPath: string): string | null {
  try {
    if (!projectPath || typeof projectPath !== 'string') return null
    if (!fs.existsSync(projectPath)) return null

    let gitDir = path.join(projectPath, '.git')
    if (!fs.existsSync(gitDir)) return null

    const stat = fs.statSync(gitDir)
    if (!stat.isDirectory()) {
      // Arquivo .git (submódulo ou worktree): "gitdir: <path>"
      const content = fs.readFileSync(gitDir, 'utf-8')
      const match = content.match(/gitdir:\s*(.+)/i)
      if (match) {
        let target = match[1].trim()
        if (!path.isAbsolute(target)) {
          target = path.resolve(projectPath, target)
        }
        gitDir = target
      } else {
        return null
      }
    }

    const headFile = path.join(gitDir, 'HEAD')
    if (!fs.existsSync(headFile)) return null

    const headContent = fs.readFileSync(headFile, 'utf-8').trim()
    const refMatch = headContent.match(/^ref:\s*refs\/heads\/(.+)$/)
    if (refMatch) {
      return refMatch[1].trim()
    }
    // detached head ou sha
    if (/^[0-9a-f]{7,40}$/i.test(headContent)) {
      return headContent.slice(0, 7)
    }
    return null
  } catch {
    return null
  }
}

async function executeCodeSettings(
  args: Record<string, any>,
  stateManager: CodeStateManager,
  _context?: ToolContext
): Promise<any> {
  const action = String(args.action || 'get').toLowerCase()
  const state = await stateManager.load()
  const home = getHomeRoot()

  if (action === 'get') {
    return {
      ok: true,
      home,
      projects: state.projects,
      terminalRules: state.terminalRules,
      settings: state.settings
    }
  }

  if (action === 'get_chat_project') {
    const threadId = String(args.threadId || 'default')
    if (!state.activeProjects) state.activeProjects = {}
    let activeId = state.activeProjects[threadId]
    let inherited = false
    let activeProject: ProjectDefinition | null = null
    let gitBranch: string | null = null

    // A session that has never picked a project inherits the last chat selection.
    if (!activeId && state.lastChatProjectId) {
      const last = state.projects.find((p: any) => p.id === state.lastChatProjectId)
      if (last) {
        state.activeProjects[threadId] = last.id
        await stateManager.save(state)
        try {
          const { attachProjectInstructions } = require('../core/project-instructions.ts')
          await attachProjectInstructions(stateManager, state, {
            threadId,
            project: last,
            force: true
          })
        } catch {}
        activeId = last.id
        inherited = true
      } else {
        delete state.lastChatProjectId
        await stateManager.save(state)
      }
    }

    if (activeId && activeId !== 'home') {
      const found = state.projects.find((p: any) => p.id === activeId)
      if (found) {
        activeProject = found
        gitBranch = getGitBranch(found.path)
      }
    }

    return {
      ok: true,
      activeProject,
      gitBranch,
      inherited,
      projects: state.projects
    }
  }

  if (action === 'set_chat_project') {
    const threadId = String(args.threadId || 'default')
    const projectId = String(args.projectId || '').trim()

    if (!state.activeProjects) state.activeProjects = {}

    if (!projectId || projectId === 'home' || projectId === 'none') {
      delete state.activeProjects[threadId]
      delete state.lastChatProjectId
      await stateManager.save(state)
      return {
        ok: true,
        activeProject: null,
        gitBranch: null,
        projects: state.projects
      }
    }

    const matched = state.projects.find((p: any) => p.id === projectId)
    if (!matched) {
      return { ok: false, error: 'Projeto não encontrado.' }
    }

    state.activeProjects[threadId] = matched.id
    state.lastChatProjectId = matched.id
    matched.lastUsedAt = new Date().toISOString()
    await stateManager.save(state)

    try {
      const { attachProjectInstructions } = require('../core/project-instructions.ts')
      await attachProjectInstructions(stateManager, state, {
        threadId,
        project: matched,
        force: true
      })
    } catch {}

    const gitBranch = getGitBranch(matched.path)
    return {
      ok: true,
      activeProject: matched,
      gitBranch,
      projects: state.projects
    }
  }

  if (action === 'add_project') {
    const res = await addProjectToState(args.path, args.name, stateManager)
    if (res.ok && res.project && args.threadId) {
      const threadId = String(args.threadId)
      if (!state.activeProjects) state.activeProjects = {}
      state.activeProjects[threadId] = res.project.id
      state.lastChatProjectId = res.project.id
      await stateManager.save(state)
      try {
        const { attachProjectInstructions } = require('../core/project-instructions.ts')
        await attachProjectInstructions(stateManager, state, {
          threadId,
          project: res.project,
          force: true
        })
      } catch {}
      return {
        ...res,
        activeProject: res.project,
        gitBranch: getGitBranch(res.project.path),
        projects: state.projects
      }
    }
    return res
  }

  if (action === 'pick_project') {
    const scriptPath = path.join(__dirname, '..', 'scripts', 'pick-folder.ps1')
    return new Promise((resolve) => {
      cp.execFile(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', scriptPath],
        { windowsHide: false, timeout: 120000 },
        async (error: any, stdout: string) => {
          if (error) {
            return resolve({ ok: false, error: 'Seleção de pasta cancelada ou indisponível.' })
          }
          const chosen = stdout.trim()
          if (!chosen) {
            return resolve({ ok: true, canceled: true })
          }
          const addResult = await addProjectToState(chosen, undefined, stateManager)
          if (addResult.ok && addResult.project && args.threadId) {
            const threadId = String(args.threadId)
            if (!state.activeProjects) state.activeProjects = {}
            state.activeProjects[threadId] = addResult.project.id
            state.lastChatProjectId = addResult.project.id
            await stateManager.save(state)
            try {
              const { attachProjectInstructions } = require('../core/project-instructions.ts')
              await attachProjectInstructions(stateManager, state, {
                threadId,
                project: addResult.project,
                force: true
              })
            } catch {}
            return resolve({
              ...addResult,
              activeProject: addResult.project,
              gitBranch: getGitBranch(addResult.project.path),
              projects: state.projects
            })
          }
          return resolve(addResult)
        }
      )
    })
  }

  if (action === 'remove_project') {
    const id = String(args.id || '').trim()
    const index = state.projects.findIndex((p: any) => p.id === id)
    if (index >= 0) {
      const removed = state.projects.splice(index, 1)[0]
      // Clean active references
      for (const [thId, pId] of Object.entries(state.activeProjects || {})) {
        if (pId === id) delete state.activeProjects[thId]
      }
      if (state.lastChatProjectId === id) delete state.lastChatProjectId
      await stateManager.save(state)
      return { ok: true, message: `Projeto '${removed.name}' removido.` }
    }
    return { ok: false, error: 'Projeto não encontrado.' }
  }

  if (action === 'rename_project') {
    const id = String(args.id || '').trim()
    const newName = String(args.name || '').trim()
    if (!newName) return { ok: false, error: 'Novo nome é obrigatório.' }

    const proj = state.projects.find((p: any) => p.id === id)
    if (!proj) return { ok: false, error: 'Projeto não encontrado.' }

    if (
      state.projects.some(
        (p: any) => p.id !== id && p.name.toLowerCase() === newName.toLowerCase()
      )
    ) {
      return { ok: false, error: `Já existe um projeto com o nome '${newName}'.` }
    }

    proj.name = newName
    await stateManager.save(state)
    return { ok: true, message: `Projeto renomeado para '${newName}'.` }
  }

  if (action === 'toggle_rule') {
    const id = String(args.id || '').trim()
    const rule = state.terminalRules.find((r: any) => r.id === id)
    if (rule) {
      rule.enabled = !rule.enabled
      await stateManager.save(state)
      return { ok: true, enabled: rule.enabled }
    }
    return { ok: false, error: 'Regra não encontrada.' }
  }

  if (action === 'add_rule') {
    const pattern = String(args.pattern || '').trim()
    const requested = String(args.ruleAction || args.action || 'ask').toLowerCase()
    const ruleAction: TerminalRuleAction =
      requested === 'allow' ? 'allow' : requested === 'block' ? 'block' : 'ask'
    if (!pattern) return { ok: false, error: 'Padrão da regra é obrigatório.' }

    const newRule: TerminalRule = {
      id: `rule_usr_${Date.now()}`,
      pattern,
      action: ruleAction,
      enabled: true,
      group: 'custom',
      source: 'user'
    }
    state.terminalRules.push(newRule)
    await stateManager.save(state)
    return { ok: true, message: 'Regra adicionada.', rule: newRule }
  }

  if (action === 'update_rule') {
    const id = String(args.id || '').trim()
    const rule = state.terminalRules.find((r: any) => r.id === id)
    if (!rule) return { ok: false, error: 'Regra não encontrada.' }
    if (args.ruleAction !== undefined) {
      const requested = String(args.ruleAction).toLowerCase()
      if (requested !== 'allow' && requested !== 'ask' && requested !== 'block') {
        return { ok: false, error: `Ação de regra inválida: '${requested}'. Use allow, ask ou block.` }
      }
      rule.action = requested
    }
    if (args.pattern !== undefined) {
      const pattern = String(args.pattern).trim()
      if (!pattern) return { ok: false, error: 'Padrão da regra é obrigatório.' }
      rule.pattern = pattern
    }
    await stateManager.save(state)
    return { ok: true, message: 'Regra atualizada.', rule }
  }

  if (action === 'remove_rule') {
    const id = String(args.id || '').trim()
    const index = state.terminalRules.findIndex((r: any) => r.id === id)
    if (index >= 0) {
      state.terminalRules.splice(index, 1)
      await stateManager.save(state)
      return { ok: true, message: 'Regra removida.' }
    }
    return { ok: false, error: 'Regra não encontrada.' }
  }

  if (action === 'reorder_rules') {
    const rules = args.rules
    if (Array.isArray(rules)) {
      state.terminalRules = rules
      await stateManager.save(state)
      return { ok: true, message: 'Ordem das regras atualizada.' }
    }
    return { ok: false, error: 'Lista de regras inválida.' }
  }

  if (action === 'restore_presets') {
    // Preserve custom rules, restore default presets
    const customRules = state.terminalRules.filter((r: any) => r.source === 'user' || r.source === 'learned')
    state.terminalRules = [...DEFAULT_PRESET_RULES, ...customRules]
    await stateManager.save(state)
    return { ok: true, message: 'Presets de regras restaurados.', rules: state.terminalRules }
  }

  if (action === 'update_settings') {
    if (args.shell && ['auto', 'powershell', 'cmd'].includes(args.shell)) {
      state.settings.shell = args.shell
    }
    if (typeof args.defaultTimeoutMs === 'number' && args.defaultTimeoutMs >= 1000) {
      state.settings.defaultTimeoutMs = args.defaultTimeoutMs
    }
    if (typeof args.strictMode === 'boolean') {
      state.settings.strictMode = args.strictMode
    }
    await stateManager.save(state)
    return { ok: true, message: 'Configurações atualizadas.', settings: state.settings }
  }

  return { ok: false, error: `Ação desconhecida: '${action}'.` }
}

module.exports = {
  executeCodeSettings
}
