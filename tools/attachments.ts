const fs = require('node:fs')
const path = require('node:path')
import type { ToolContext, CodeStateManager } from '../core/types.ts'
const { validatePerimeter, isInsideOrEqual } = require('../core/perimeter.ts')
const { resolveTurnAttachment } = require('../core/attachments.ts')
const { recordCheckpoint } = require('../core/checkpoints.ts')

/**
 * Copies an attachment staged by the host into the active project.
 *
 * The source is restricted to the working copies granted for the current
 * message (`context.attachments`); the destination is validated by the regular
 * project perimeter, so the tool can read an attachment anywhere but can only
 * write inside the conversation's authorized scope.
 */

function sanitizeFileName(value: string, fallback: string): string {
  const base = path.basename(String(value || '').trim())
  const cleaned = base.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_').replace(/^[.\s]+/, '')
  return cleaned.slice(0, 120) || fallback
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round((bytes / 1024) * 10) / 10} KB`
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`
}

async function executeCodeAttach(
  args: Record<string, any>,
  stateManager: CodeStateManager,
  context?: ToolContext
): Promise<any> {
  const resolved = resolveTurnAttachment(String(args.attachment || ''), context)
  if (!resolved.attachment) {
    return { ok: false, error: resolved.error }
  }
  const source = resolved.attachment
  const sourcePath = String(source.path)

  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    return {
      ok: false,
      error:
        `A cópia de trabalho do anexo '${source.name || sourcePath}' não está mais disponível ` +
        `(${sourcePath}). Peça ao usuário para reenviar o anexo nesta conversa.`
    }
  }

  const state = await stateManager.load()
  const destinationInput = String(args.destination || '').trim()
  let perimeter
  try {
    perimeter = validatePerimeter(destinationInput || '.', state, args.project, context?.threadId)
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) }
  }
  // Without an explicit destination, defaulting to the Home root would drop
  // the file loose in the user's home folder; require a project or a path.
  if (!destinationInput && !args.project && perimeter.baseRoot.isHome) {
    return {
      ok: false,
      error:
        'Nenhum projeto ativo na conversa. Ative um projeto com code_project_use e repita, ' +
        "ou informe explicitamente um 'destination' (ex: \"Downloads/imagens\")."
    }
  }
  let targetPath = perimeter.canonicalPath

  // Writing into the attachment staging area would corrupt the read-only
  // source; the destination must be real project space.
  if (isInsideOrEqual(targetPath, path.dirname(path.resolve(sourcePath)))) {
    return {
      ok: false,
      error: `O destino '${destinationInput}' aponta para a pasta de anexos da conversa. Escolha um destino dentro do projeto.`
    }
  }

  const requestedName = args.fileName ? String(args.fileName) : String(source.name || '')
  const fileName = sanitizeFileName(requestedName, 'anexo')

  const destinationExists = fs.existsSync(targetPath)
  const looksLikeFile =
    path.extname(targetPath) !== '' || path.basename(targetPath).startsWith('.')
  if (destinationExists && fs.statSync(targetPath).isDirectory()) {
    // Existing folder: keep its name and use the attachment's file name.
    targetPath = path.join(targetPath, fileName)
  } else if (!destinationExists && !looksLikeFile) {
    // A path without extension is treated as a folder (e.g. "src/assets").
    targetPath = path.join(targetPath, fileName)
  }

  const overwrite = Boolean(args.overwrite)
  if (fs.existsSync(targetPath)) {
    if (fs.statSync(targetPath).isDirectory()) {
      return {
        ok: false,
        error: `O destino '${targetPath}' é um diretório. Informe o nome do arquivo.`
      }
    }
    if (!overwrite) {
      return {
        ok: false,
        error:
          `Já existe um arquivo em '${targetPath}'. Use overwrite: true para substituí-lo ` +
          'ou informe outro destino/fileName.'
      }
    }
  }

  const parentDir = path.dirname(targetPath)
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true })
  }

  if (fs.existsSync(targetPath)) {
    // Text checkpoint mirrors code_write/code_edit so the chat rollback can
    // restore the previous content. Binary targets are skipped instead of
    // storing a lossy utf-8 read; overwriting those is not rollback-able.
    try {
      const previous = fs.readFileSync(targetPath)
      if (!previous.subarray(0, 8000).includes(0)) {
        recordCheckpoint(
          context?.threadId || 'default',
          targetPath,
          previous.toString('utf-8'),
          context?.args?.messageId
        )
      }
    } catch {
      /* unreadable: skip the checkpoint instead of failing the copy */
    }
  } else {
    recordCheckpoint(context?.threadId || 'default', targetPath, null, context?.args?.messageId)
  }

  fs.copyFileSync(sourcePath, targetPath)
  const bytes = fs.statSync(targetPath).size

  return {
    ok: true,
    instruction: JSON.stringify({
      ok: true,
      base: perimeter.baseRoot.name,
      path: targetPath,
      source: sourcePath,
      bytes,
      message: `Anexo '${source.name || fileName}' copiado para '${targetPath}' (${formatBytes(bytes)}).`
    })
  }
}

module.exports = {
  executeCodeAttach
}
