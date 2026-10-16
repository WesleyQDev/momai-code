const { CodeStateManager } = require('./core/storage.ts')
import type { ToolContext, TurnAttachment } from './core/types.ts'
const { executeCodeBash } = require('./tools/bash.ts')
const { executeCodeRead, executeCodeWrite, executeCodeEdit, executeCodeList } = require('./tools/files.ts')
const { executeCodeAttach } = require('./tools/attachments.ts')
const { executeCodeProjects, executeCodeProjectUse, executeCodeProjectRequest, executeCodeChatContext } = require('./tools/projects.ts')
const { executeCodeGlob, executeCodeGrep } = require('./tools/search.ts')
const { executeCodeSettings } = require('./routes/settings.ts')
const { executeCodeProjectConfirm, executeCodeProjectCancel } = require('./routes/projects.ts')
const { executeCodeCommandPolicy } = require('./tools/policy.ts')
const { executeCodeRollback } = require('./tools/rollback.ts')

const stateManager = new CodeStateManager()

/** Attachments of the current message, however the host delivered them. */
function resolveAttachments(payload: any, fallback: any): TurnAttachment[] | undefined {
  const candidates = [
    payload?.attachments,
    payload?.context?.attachments,
    fallback?.attachments
  ]
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) return candidate
  }
  return undefined
}

async function execute(payloadOrTool: any, maybeArgs?: any, maybeContext?: any): Promise<any> {
  let toolName: string
  let args: Record<string, any>
  let context: ToolContext

  if (typeof payloadOrTool === 'string') {
    toolName = payloadOrTool
    args = (maybeArgs && typeof maybeArgs === 'object') ? maybeArgs : {}
    context = {
      toolName,
      args,
      threadId: (maybeContext as any)?.threadId,
      attachments: resolveAttachments(undefined, maybeContext),
      momai: maybeContext
    }
  } else if (payloadOrTool && typeof payloadOrTool === 'object') {
    toolName = String(payloadOrTool.toolName || payloadOrTool.tool || payloadOrTool.name || '')
    args = (payloadOrTool.args && typeof payloadOrTool.args === 'object')
      ? payloadOrTool.args
      : (payloadOrTool.payload?.args || {})
    context = {
      toolName,
      args,
      threadId: payloadOrTool.threadId || payloadOrTool.payload?.threadId,
      attachments: resolveAttachments(payloadOrTool, undefined),
      momai: payloadOrTool.momai || payloadOrTool.context
    }
  } else {
    return { ok: false, error: 'Formato de chamada inválido.' }
  }

  // Bind storage bridge if provided by host
  if (context.momai?.storage) {
    stateManager.setBridge(context.momai.storage)
  }

  try {
    switch (toolName) {
      // Public tools
      case 'code_bash':
        return await executeCodeBash(args, stateManager, context)
      case 'code_read':
        return await executeCodeRead(args, stateManager, context)
      case 'code_write':
        return await executeCodeWrite(args, stateManager, context)
      case 'code_edit':
        return await executeCodeEdit(args, stateManager, context)
      case 'code_list':
        return await executeCodeList(args, stateManager, context)
      case 'code_attach':
        return await executeCodeAttach(args, stateManager, context)
      case 'code_projects':
        return await executeCodeProjects(args, stateManager, context)
      case 'code_chat_context':
        return await executeCodeChatContext(args, stateManager, context)
      case 'code_project_use':
        return await executeCodeProjectUse(args, stateManager, context)
      case 'code_project_request':
        return await executeCodeProjectRequest(args, stateManager, context)
      case 'code_command_policy':
        return await executeCodeCommandPolicy(args, stateManager, context)
      case 'code_glob':
        return await executeCodeGlob(args, stateManager, context)
      case 'code_grep':
        return await executeCodeGrep(args, stateManager, context)

      // Route / Internal tools
      case 'code_settings':
        return await executeCodeSettings(args, stateManager, context)
      case 'code_project_confirm':
        return await executeCodeProjectConfirm(args, stateManager, context)
      case 'code_project_cancel':
        return await executeCodeProjectCancel(args, stateManager, context)
      case 'code_rollback':
        return await executeCodeRollback(args, stateManager, context)

      default:
        return {
          ok: false,
          error: `Ferramenta desconhecida: '${toolName}'.`
        }
    }
  } catch (err: any) {
    return {
      ok: false,
      error: err?.message || String(err),
      instruction: `Erro na execução de ${toolName}: ${err?.message || err}`
    }
  }
}

module.exports = {
  execute,
  executeTool: execute
}
