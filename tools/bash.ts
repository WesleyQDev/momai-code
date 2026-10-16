import type { ToolContext, CodeStateManager } from '../core/types.ts'
const { resolveTargetRoot } = require('../core/perimeter.ts')
const { runProcess } = require('../core/process-runner.ts')

/**
 * Runs a shell command in the active project root.
 *
 * Dangerous commands are handled by the host permission gate before this code
 * runs: `code_bash` declares `permission.policyTool = code_command_policy`, the
 * host asks the user when a terminal rule matches and only then executes the
 * call. By the time this function runs, the call is already authorized.
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
  const threadId = context?.threadId

  const state = await stateManager.load()
  const baseRoot = resolveTargetRoot(state, projectArg, threadId)

  const result = await runProcess(command, baseRoot.path, {
    timeoutMs: timeoutMs || state.settings.defaultTimeoutMs,
    shellPreference: state.settings.shell
  })

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

  const responsePayload = {
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

  return {
    ok: result.exitCode === 0,
    instruction: JSON.stringify(responsePayload)
  }
}

module.exports = {
  executeCodeBash
}
