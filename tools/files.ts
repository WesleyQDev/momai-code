const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')
import type { ToolContext, CodeStateManager } from '../core/types.ts'
const { validatePerimeter } = require('../core/perimeter.ts')
const { attachmentReadRoots } = require('../core/attachments.ts')
const { IGNORED_DIRS } = require('../core/ignore.ts')
const { projectInstructionsField } = require('../core/project-instructions.ts')
const { recordCheckpoint } = require('../core/checkpoints.ts')

function countLinesSync(filePath: string): number {
  try {
    const fd = fs.openSync(filePath, 'r')
    const buffer = Buffer.alloc(64 * 1024)
    let count = 1
    let bytesRead = 0
    while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) !== 0) {
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] === 10) count++
      }
    }
    fs.closeSync(fd)
    return count
  } catch {
    return 0
  }
}

async function readSliceViaStream(
  filePath: string,
  offset: number,
  limit: number
): Promise<{ slicedLines: string[]; totalLines: number; hasMore: boolean; startIndex: number }> {
  return new Promise((resolve, reject) => {
    let fileStream: any
    let rl: any
    try {
      fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' })
      rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
      })
    } catch (err) {
      reject(err)
      return
    }

    const lines: string[] = []
    let currentLine = 0
    let hasMore = false
    let stoppedEarly = false
    const startIndex = Math.max(0, offset - 1)
    const targetEnd = offset + limit

    rl.on('line', (line: string) => {
      currentLine += 1
      if (currentLine >= offset && currentLine < targetEnd) {
        lines.push(`${currentLine} | ${line}`)
      } else if (currentLine >= targetEnd) {
        hasMore = true
        stoppedEarly = true
        rl.close()
        fileStream.destroy()
      }
    })

    rl.on('close', () => {
      let totalLines = currentLine
      if (stoppedEarly) {
        totalLines = countLinesSync(filePath)
      }
      resolve({
        slicedLines: lines,
        totalLines,
        hasMore,
        startIndex
      })
    })

    rl.on('error', (err: any) => reject(err))
    fileStream.on('error', (err: any) => reject(err))
  })
}


/** Reads return up to this many lines per call, sized so one call covers most files. */
const DEFAULT_READ_LINES = 800
const MAX_READ_LINES = 2000
/**
 * Smaller requested windows are widened to this size: every extra slice costs a
 * full model round trip, while a few hundred more lines cost almost nothing.
 */
const MIN_READ_LINES = 300
/** Pagination still loads the file into memory; huge files are refused up front. */
const MAX_READABLE_FILE_BYTES = 20 * 1024 * 1024

function formatMegabytes(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`
}

async function executeCodeRead(
  args: Record<string, any>,
  stateManager: CodeStateManager,
  context?: ToolContext
): Promise<any> {
  const filePath = String(args.path || '').trim()
  if (!filePath) {
    return { ok: false, error: 'Parâmetro obrigatório ausente: path.' }
  }

  const offset = typeof args.offset === 'number' && args.offset > 0 ? args.offset : 1
  const requestedLimit =
    typeof args.limit === 'number' && args.limit > 0 ? args.limit : DEFAULT_READ_LINES
  const limit = Math.min(Math.max(requestedLimit, MIN_READ_LINES), MAX_READ_LINES)
  const limitWidened = limit > requestedLimit

  const state = await stateManager.load()
  const perimeter = validatePerimeter(filePath, state, args.project, context?.threadId, {
    extraReadRoots: attachmentReadRoots(context)
  })

  if (!fs.existsSync(perimeter.canonicalPath)) {
    return {
      ok: false,
      error: `Arquivo não encontrado: '${filePath}' (resolvido como '${perimeter.canonicalPath}').`
    }
  }

  const stat = fs.statSync(perimeter.canonicalPath)
  if (stat.isDirectory()) {
    return {
      ok: false,
      error: `O caminho '${filePath}' é um diretório, não um arquivo. Use code_list para listar seu conteúdo.`
    }
  }

  if (stat.size > MAX_READABLE_FILE_BYTES) {
    return {
      ok: false,
      error: `Arquivo muito grande para leitura paginada (${formatMegabytes(stat.size)}; limite ${formatMegabytes(MAX_READABLE_FILE_BYTES)}). Use code_grep com 'include' e 'context' para localizar o trecho desejado.`
    }
  }

  const { slicedLines, totalLines, hasMore, startIndex } = await readSliceViaStream(
    perimeter.canonicalPath,
    offset,
    limit
  )

  const formattedLines = slicedLines.join('\n')

  const projectFields = await projectInstructionsField(
    stateManager,
    state,
    perimeter.canonicalPath,
    context?.threadId
  )

  return {
    ok: true,
    instruction: JSON.stringify({
      ok: true,
      base: perimeter.baseRoot.name,
      path: perimeter.canonicalPath,
      offset,
      limit,
      totalLines,
      returnedLines: slicedLines.length,
      hasMore,
      ...(hasMore ? { nextOffset: startIndex + slicedLines.length + 1 } : {}),
      ...(limitWidened && slicedLines.length > requestedLimit
        ? {
            hint: `Leitura ampliada de ${requestedLimit} para ${limit} linhas (mínimo ${MIN_READ_LINES}) para evitar rodadas extras; o contexto ao redor já está incluído.`
          }
        : {}),
      ...projectFields,
      content: formattedLines
    })
  }
}

async function executeCodeWrite(
  args: Record<string, any>,
  stateManager: CodeStateManager,
  context?: ToolContext
): Promise<any> {
  const filePath = String(args.path || '').trim()
  if (!filePath) {
    return { ok: false, error: 'Parâmetro obrigatório ausente: path.' }
  }
  if (args.content === undefined || args.content === null) {
    return { ok: false, error: 'Parâmetro obrigatório ausente: content.' }
  }

  const content = String(args.content)
  const state = await stateManager.load()
  const perimeter = validatePerimeter(filePath, state, args.project, context?.threadId)

  const parentDir = path.dirname(perimeter.canonicalPath)
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true })
  }

  const previousContent = fs.existsSync(perimeter.canonicalPath)
    ? fs.readFileSync(perimeter.canonicalPath, 'utf-8')
    : null
  recordCheckpoint(
    context?.threadId || 'default',
    perimeter.canonicalPath,
    previousContent,
    context?.args?.messageId
  )

  fs.writeFileSync(perimeter.canonicalPath, content, 'utf-8')
  const bytesWritten = Buffer.byteLength(content, 'utf-8')
  const projectFields = await projectInstructionsField(
    stateManager,
    state,
    perimeter.canonicalPath,
    context?.threadId
  )

  return {
    ok: true,
    instruction: JSON.stringify({
      ok: true,
      base: perimeter.baseRoot.name,
      path: perimeter.canonicalPath,
      bytesWritten,
      ...projectFields,
      message: `Arquivo gravado com sucesso (${bytesWritten} bytes).`
    })
  }
}

/** Line-level diff (LCS) between a chunk's target and replacement. */
function countChangedLines(before: string, after: string): { added: number; removed: number } {
  const a = before ? before.split('\n') : []
  const b = after ? after.split('\n') : []
  if (a.length * b.length > 250000) {
    return { added: b.length, removed: a.length }
  }
  const rows = a.length
  const cols = b.length
  const dp: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0))
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  let i = 0
  let j = 0
  let added = 0
  let removed = 0
  while (i < rows && j < cols) {
    if (a[i] === b[j]) {
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      removed++
      i++
    } else {
      added++
      j++
    }
  }
  removed += rows - i
  added += cols - j
  return { added, removed }
}

async function executeCodeEdit(
  args: Record<string, any>,
  stateManager: CodeStateManager,
  context?: ToolContext
): Promise<any> {
  const filePath = String(args.path || '').trim()
  if (!filePath) {
    return { ok: false, error: 'Parâmetro obrigatório ausente: path.' }
  }

  type ChunkItem = { target: string; replacement: string; replaceAll?: boolean }
  let chunks: ChunkItem[] = []
  const isMultiChunk = Array.isArray(args.chunks) && args.chunks.length > 0

  if (isMultiChunk) {
    chunks = args.chunks.map((c: any) => ({
      target: String(c?.target || ''),
      replacement: String(c?.replacement ?? ''),
      replaceAll: Boolean(c?.replaceAll)
    }))
  } else if (args.target !== undefined && args.target !== null && args.replacement !== undefined && args.replacement !== null) {
    chunks = [
      {
        target: String(args.target),
        replacement: String(args.replacement),
        replaceAll: Boolean(args.replaceAll)
      }
    ]
  } else {
    if (!args.target) {
      return { ok: false, error: 'Parâmetro obrigatório ausente: target.' }
    }
    return { ok: false, error: 'Parâmetro obrigatório ausente: replacement.' }
  }

  for (let i = 0; i < chunks.length; i++) {
    if (!chunks[i].target) {
      return {
        ok: false,
        error: isMultiChunk
          ? `Trecho alvo vazio no bloco ${i + 1} ('target' obrigatório).`
          : 'Parâmetro obrigatório ausente: target.'
      }
    }
  }

  const state = await stateManager.load()
  const perimeter = validatePerimeter(filePath, state, args.project, context?.threadId)

  if (!fs.existsSync(perimeter.canonicalPath)) {
    return {
      ok: false,
      error: `Arquivo não encontrado para edição: '${filePath}'.`
    }
  }

  const originalContent = fs.readFileSync(perimeter.canonicalPath, 'utf-8')
  const isCrlf = originalContent.includes('\r\n')
  const normalizedContent = originalContent.replace(/\r\n/g, '\n')

  // Atomic validation: verify that every chunk exists and satisfies uniqueness
  let testContent = normalizedContent
  const counts: number[] = []
  let totalAdded = 0
  let totalRemoved = 0

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    const normTarget = chunk.target.replace(/\r\n/g, '\n')
    const count = testContent.split(normTarget).length - 1

    if (count === 0) {
      const targetLabel = isMultiChunk ? ` ('target') do bloco ${i + 1}` : " ('target')"
      return {
        ok: false,
        error: `O texto alvo${targetLabel} não foi encontrado no arquivo '${perimeter.canonicalPath}'. Verifique se o conteúdo exato e os espaços coincidem.`
      }
    }

    if (count > 1 && !chunk.replaceAll) {
      const targetLabel = isMultiChunk ? ` ('target') do bloco ${i + 1}` : " ('target')"
      return {
        ok: false,
        error: `O texto alvo${targetLabel} foi encontrado ${count} vezes no arquivo '${perimeter.canonicalPath}'. Forneça mais contexto de linhas ao redor para torná-lo único, ou use replaceAll: true se a intenção for substituir todas as ocorrências.`
      }
    }

    counts.push(count)
    const normReplacement = chunk.replacement.replace(/\r\n/g, '\n')
    const occurrences = chunk.replaceAll ? count : 1
    const changed = countChangedLines(normTarget, normReplacement)
    totalAdded += changed.added * occurrences
    totalRemoved += changed.removed * occurrences
    testContent = chunk.replaceAll
      ? testContent.split(normTarget).join(normReplacement)
      : testContent.replace(normTarget, normReplacement)
  }

  // All chunks passed validation! Write atomically
  let updatedContent = testContent
  if (isCrlf) {
    updatedContent = updatedContent.replace(/\n/g, '\r\n')
  }

  recordCheckpoint(
    context?.threadId || 'default',
    perimeter.canonicalPath,
    originalContent,
    context?.args?.messageId
  )

  fs.writeFileSync(perimeter.canonicalPath, updatedContent, 'utf-8')

  const totalReplacements = counts.reduce((acc, c) => acc + c, 0)
  const projectFields = await projectInstructionsField(
    stateManager,
    state,
    perimeter.canonicalPath,
    context?.threadId
  )

  const summaryMsg = isMultiChunk
    ? `Arquivo editado com sucesso (${totalReplacements} substituição(ões) em ${chunks.length} blocos).`
    : `Arquivo editado com sucesso (${totalReplacements} substituição(ões)).`

  // Row presentation for the chat execution list: green/red changed-line
  // counts. Public contract: ToolResult.step (momai-sdk).
  const step =
    totalAdded + totalRemoved > 0
      ? {
          badges: [
            { text: `+${totalAdded}`, tone: 'success' },
            { text: `-${totalRemoved}`, tone: 'danger' }
          ]
        }
      : undefined

  return {
    ok: true,
    instruction: JSON.stringify({
      ok: true,
      base: perimeter.baseRoot.name,
      path: perimeter.canonicalPath,
      chunksApplied: chunks.length,
      replacementsCount: totalReplacements,
      ...projectFields,
      message: summaryMsg
    }),
    ...(step ? { step } : {})
  }
}

export interface DirEntryInfo {
  name: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  size?: number
}

async function executeCodeList(
  args: Record<string, any>,
  stateManager: CodeStateManager,
  context?: ToolContext
): Promise<any> {
  const dirPath = String(args.path || '.').trim()
  const maxDepth = typeof args.depth === 'number' && args.depth > 0 ? Math.min(args.depth, 3) : 1
  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 500) : 150

  const state = await stateManager.load()
  const perimeter = validatePerimeter(dirPath, state, args.project, context?.threadId)

  if (!fs.existsSync(perimeter.canonicalPath)) {
    return {
      ok: false,
      error: `Diretório não encontrado: '${dirPath}'.`
    }
  }

  const stat = fs.statSync(perimeter.canonicalPath)
  if (!stat.isDirectory()) {
    return {
      ok: false,
      error: `O caminho '${dirPath}' não é um diretório.`
    }
  }

  const entries: DirEntryInfo[] = []
  let totalFound = 0

  function readDirRecursive(currentPath: string, currentDepth: number) {
    if (currentDepth > maxDepth || entries.length >= limit) return
    try {
      const items = fs.readdirSync(currentPath, { withFileTypes: true })
      items.sort((a: any, b: any) => {
        if (a.isDirectory() && !b.isDirectory()) return -1
        if (!a.isDirectory() && b.isDirectory()) return 1
        return a.name.localeCompare(b.name)
      })

      for (const item of items) {
        if (item.isDirectory() && IGNORED_DIRS.has(item.name)) {
          continue
        }
        totalFound++

        let type: DirEntryInfo['type'] = 'other'
        if (item.isFile()) type = 'file'
        else if (item.isDirectory()) type = 'directory'
        else if (item.isSymbolicLink()) type = 'symlink'

        let size: number | undefined
        if (type === 'file') {
          try {
            size = fs.statSync(path.join(currentPath, item.name)).size
          } catch {}
        }

        if (entries.length < limit) {
          entries.push({
            name: currentDepth > 1 ? path.relative(perimeter.canonicalPath, path.join(currentPath, item.name)) : item.name,
            type,
            size
          })
        }

        if (type === 'directory' && currentDepth < maxDepth && entries.length < limit) {
          readDirRecursive(path.join(currentPath, item.name), currentDepth + 1)
        }
      }
    } catch {}
  }

  readDirRecursive(perimeter.canonicalPath, 1)
  const projectFields = await projectInstructionsField(
    stateManager,
    state,
    perimeter.canonicalPath,
    context?.threadId
  )

  return {
    ok: true,
    instruction: JSON.stringify({
      ok: true,
      base: perimeter.baseRoot.name,
      path: perimeter.canonicalPath,
      entriesCount: entries.length,
      hasMore: totalFound > entries.length,
      ...projectFields,
      entries
    })
  }
}

module.exports = {
  executeCodeRead,
  executeCodeWrite,
  executeCodeEdit,
  executeCodeList
}
