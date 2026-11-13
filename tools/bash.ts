import type { ToolContext, CodeStateManager } from '../core/types.ts'
const { resolveTargetRoot } = require('../core/perimeter.ts')
const { runProcess, buildRunEnv } = require('../core/process-runner.ts')
const { startBackgroundProcess } = require('../core/processes.ts')

/**
 * Runs a shell command in the active project root.
 *
 * Dangerous commands are handled by the host permission gate before this code
 * runs: `code_bash` declares `permission.policyTool = code_command_policy`, the
 * host asks the user when a terminal rule matches and only then executes the
 * call. By the time this function runs, the call is already authorized.
 *
 * `background: true` starts the command detached and returns at once with a
 * shellID; `code_process` lists, reads and stops those processes.
 */
async function executeCodeBash(
  args: Record<string, any>,
  stateManager: CodeStateManager,
  context?: ToolContext
): Promise<any> {
  const command = String(args.command || '').trim()
  if (!command) {
    return {
      ok: false,
      error: 'Parâmetro obrigatório ausente: command.'
    }
  }

  const projectArg = typeof args.project === 'string' ? args.project : undefined
  const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined
  const background = args.background === true
  const threadId = context?.threadId

  const state = await stateManager.load()
  const baseRoot = resolveTargetRoot(state, projectArg, threadId)

  // Update lastUsedAt if running inside a defined project (throttle save to once every 5 minutes)
  if (!baseRoot.isHome) {
    const proj = state.projects.find((p) => p.id === baseRoot.id)
    if (proj) {
      const lastUsedMs = proj.lastUsedAt ? new Date(proj.lastUsedAt).getTime() : 0
      if (Date.now() - lastUsedMs > 5 * 60 * 1000) {
        proj.lastUsedAt = new Date().toISOString()
        await stateManager.save(state)
      }
    }
  }

  if (background) {
    const started = startBackgroundProcess(command, baseRoot.path, {
      shellPreference: state.settings.shell,
      threadId,
      env: buildRunEnv(process.env)
    })

    const payload = {
      ok: true,
      status: 'running',
      shellID: started.id,
      pid: started.pid,
      base: baseRoot.name,
      cwd: baseRoot.path,
      shell: started.shell,
      outputFile: started.file,
      hint:
        'Rodando em segundo plano. Não fique consultando; siga a conversa. ' +
        'Use code_process com action "list", "output" ou "stop" quando precisar.'
    }

    return { ok: true, instruction: JSON.stringify(payload) }
  }

  const result = await runProcess(command, baseRoot.path, {
    timeoutMs: timeoutMs || state.settings.defaultTimeoutMs,
    shellPreference: state.settings.shell,
    threadId
  })

  const responsePayload: Record<string, any> = {
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    base: baseRoot.name,
    cwd: result.cwd,
    platform: process.platform,
    shell: result.shell,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr
  }

  // A command that outlived its timeout keeps running instead of dying: report
  // it as a background process so the agent never assumes it was killed.
  if (result.background) {
    responsePayload.status = 'running'
    responsePayload.shellID = result.background.id
    responsePayload.pid = result.background.pid
    responsePayload.outputFile = result.background.file
    responsePayload.hint =
      'Passou do tempo limite e continua rodando em segundo plano. ' +
      'Use code_process para ver a saída ou encerrar.'
  }

  return {
    ok: result.exitCode === 0,
    instruction: JSON.stringify(responsePayload)
  }
}

module.exports = {
  executeCodeBash
}
