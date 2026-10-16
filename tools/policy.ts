import type { ToolContext, CodeStateManager } from '../core/types.ts'
const { evaluateCommandPolicy } = require('../core/rules-engine.ts')
const { resolveTargetRoot } = require('../core/perimeter.ts')

/**
 * Internal policy hook (`permission.policyTool` on `code_bash`): the host calls
 * it before executing a command and pauses for the user when the answer is
 * `ask`. The rules engine is this extension's domain; pausing, the approval
 * card and "allow always" grants belong to the host.
 *
 * The returned `ruleId` is the grant scope: the active project (or Home) plus
 * either the matched rule or the delete baseline, so "allow always" never leaks
 * across projects. Errors fail closed on the host side.
 */
async function executeCodeCommandPolicy(
  args: Record<string, any>,
  stateManager: CodeStateManager,
  context?: ToolContext
): Promise<any> {
  const tool = String(args?.tool || '').trim()
  const callArgs =
    args?.args && typeof args.args === 'object' && !Array.isArray(args.args) ? args.args : {}

  // Only the terminal tool is gated today; every other tool keeps the host
  // default (no permission declared).
  if (tool !== 'code_bash') {
    return { ok: true, instruction: JSON.stringify({ policy: 'allow' }) }
  }

  const command = String(callArgs.command || '').trim()
  if (!command) {
    return { ok: true, instruction: JSON.stringify({ policy: 'allow' }) }
  }

  const state = await stateManager.load()
  const baseRoot = resolveTargetRoot(state, undefined, context?.threadId)
  const result = evaluateCommandPolicy(command, state, { cwd: baseRoot.path })

  if (result.policy === 'allow') {
    return { ok: true, instruction: JSON.stringify({ policy: 'allow' }) }
  }

  // A hard refusal (block rule or whole-tree delete) has no grant scope: no
  // card, no "allow always".
  if (result.policy === 'deny') {
    return {
      ok: true,
      instruction: JSON.stringify({
        policy: 'deny',
        reason: result.reason || 'Comando bloqueado pelas regras do terminal'
      })
    }
  }

  const scopeKey = result.matchedRule ? result.matchedRule.id : result.grantScope
  return {
    ok: true,
    instruction: JSON.stringify({
      policy: 'ask',
      ...(scopeKey ? { ruleId: `${baseRoot.id}:${scopeKey}` } : {}),
      reason: result.reason || 'Comando sujeito a autorização'
    })
  }
}

module.exports = {
  executeCodeCommandPolicy
}
