import type { ToolContext, TurnAttachment } from './types.ts'

/**
 * Helpers for the attachments the host staged for the current message.
 *
 * The host (MomAI core) writes a working copy of every chat attachment and
 * hands their absolute paths to each extension tool call through the tool
 * context. These copies are the only attachment files this extension may read:
 * they are granted per call as read-only roots and expire with the
 * conversation. The extension never touches the user's original file.
 */

function collectAttachments(context?: ToolContext): TurnAttachment[] {
  const direct = context?.attachments
  if (Array.isArray(direct) && direct.length > 0) return direct
  const bridged = context?.momai?.attachments
  return Array.isArray(bridged) ? bridged : []
}

/** Read-only roots granted by the current message's attachments. */
function attachmentReadRoots(context?: ToolContext): string[] {
  return collectAttachments(context)
    .map((attachment) => (typeof attachment?.path === 'string' ? attachment.path.trim() : ''))
    .filter((candidate) => candidate.length > 0)
}

function normalizeForCompare(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/g, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/**
 * Resolves the "attachment" argument of `code_attach` against the current
 * message's staged files: an absolute path must match one of the granted
 * copies, and a plain name must match exactly one of them. Anything else is
 * refused — the argument can never point outside the granted list.
 */
function resolveTurnAttachment(
  input: string,
  context?: ToolContext
): { attachment?: TurnAttachment; error?: string } {
  const requested = String(input || '').trim()
  if (!requested) return { error: 'Parâmetro obrigatório ausente: attachment.' }

  const available = collectAttachments(context).filter(
    (attachment) => typeof attachment?.path === 'string' && String(attachment.path).trim().length > 0
  )
  if (available.length === 0) {
    return {
      error:
        'Nenhum anexo disponível nesta mensagem. Peça ao usuário para anexar o arquivo e reenviar.'
    }
  }

  const byPath = available.find(
    (attachment) => normalizeForCompare(String(attachment.path)) === normalizeForCompare(requested)
  )
  if (byPath) return { attachment: byPath }

  const lowered = requested.toLowerCase()
  const byName = available.filter(
    (attachment) => String(attachment.name || '').toLowerCase() === lowered
  )
  if (byName.length === 1) return { attachment: byName[0] }
  if (byName.length > 1) {
    return {
      error:
        `Há ${byName.length} anexos com o nome '${requested}'. Informe o caminho da cópia de trabalho de um deles.\n` +
        byName.map((attachment) => `- ${attachment.path}`).join('\n')
    }
  }

  return {
    error:
      `Anexo '${requested}' não encontrado entre os anexos desta mensagem. Disponíveis:\n` +
      available
        .map((attachment) => `- ${String(attachment.name || 'arquivo')} (${attachment.path})`)
        .join('\n')
  }
}

module.exports = {
  collectAttachments,
  attachmentReadRoots,
  resolveTurnAttachment
}
