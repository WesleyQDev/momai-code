const { rollbackCheckpoints } = require('../core/checkpoints.ts')
import type { ToolContext, CodeStateManager } from '../core/types.ts'

async function executeCodeRollback(
  args: Record<string, any>,
  _stateManager: CodeStateManager,
  context?: ToolContext
): Promise<any> {
  const threadId = args.threadId || context?.threadId || 'default'
  const messageId = args.messageId
  const timestamp = args.timestamp

  const result = rollbackCheckpoints(threadId, { messageId, timestamp })

  return {
    ok: true,
    ...result,
    instruction:
      result.restoredCount > 0
        ? `Reversão de código concluída: ${result.restoredCount} arquivo(s) restaurado(s) para o estado anterior.`
        : 'Nenhuma alteração de código pendente de reversão para este ponto.'
  }
}

module.exports = {
  executeCodeRollback
}
