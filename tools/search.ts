const fs = require('node:fs')
const path = require('node:path')
const { spawn, execSync } = require('node:child_process')

import type { ToolContext, CodeStateManager } from '../core/types.ts'
const { validatePerimeter } = require('../core/perimeter.ts')
const { attachmentReadRoots } = require('../core/attachments.ts')
const { IGNORED_DIRS, BINARY_EXTENSIONS } = require('../core/ignore.ts')
const { projectInstructionsField } = require('../core/project-instructions.ts')


const DEFAULT_GLOB_LIMIT = 50
const MAX_GLOB_LIMIT = 200
const DEFAULT_GREP_LIMIT = 30
const MAX_GREP_LIMIT = 100
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024
const MAX_GREP_CONTEXT_LINES = 3

function escapeRegexChar(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch
}

/** Expands simple `{a,b}` groups (no nesting) into one pattern per alternative. */
function expandBraces(pattern: string): string[] {
  const start = pattern.indexOf('{')
  if (start === -1) return [pattern]
  const end = pattern.indexOf('}', start)
  if (end === -1) return [pattern]
  const prefix = pattern.slice(0, start)
  const body = pattern.slice(start + 1, end)
  const suffix = pattern.slice(end + 1)
  return body.split(',').flatMap((alternative) => expandBraces(prefix + alternative + suffix))
}

/**
 * Converts one glob alternative to a regex source. `**` crosses directory
 * separators (`**\/` also matches zero directories), `*` and `?` stay inside a
 * single path segment.
 */
function globAlternativeToRegexSource(pattern: string): string {
  let source = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        const followedBySlash = pattern[i + 2] === '/'
        source += followedBySlash ? '(?:[^/]+/)*' : '.*'
        i += followedBySlash ? 2 : 1
      } else {
        source += '[^/]*'
      }
    } else if (ch === '?') {
      source += '[^/]'
    } else {
      source += escapeRegexChar(ch)
    }
  }
  return source
}

export interface GlobFilter {
  pattern: string
  /** Patterns containing `/` are matched against the relative path. */
  matchesPath: boolean
  test: (relativePath: string, name: string) => boolean
}

/** Builds a glob matcher: `src/**\/*.ts` matches paths, `*.ts` matches file names. */
function createGlobFilter(rawPattern: string): GlobFilter {
  const pattern = String(rawPattern || '*').trim().replace(/\\/g, '/') || '*'
  const alternatives = expandBraces(pattern).map(globAlternativeToRegexSource)
  const rx = new RegExp(`^(?:${alternatives.join('|')})$`, 'i')
  const matchesPath = pattern.includes('/')
  return {
    pattern,
    matchesPath,
    test: (relativePath: string, name: string) => rx.test(matchesPath ? relativePath : name)
  }
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/')
}

interface DirectoryEntry {
  name: string
  isDirectory: boolean
  isSymlink: boolean
}

/** Reads a directory in a deterministic order (directories first, then names). */
function listDirectory(dir: string): DirectoryEntry[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .map((item: any) => ({
        name: item.name,
        isDirectory: item.isDirectory(),
        isSymlink: item.isSymbolicLink()
      }))
      .sort((a: DirectoryEntry, b: DirectoryEntry) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name)
      })
  } catch {
    return []
  }
}

async function executeCodeGlob(
  args: Record<string, any>,
  stateManager: CodeStateManager,
  context?: ToolContext
): Promise<any> {
  const pattern = String(args.pattern || '*').trim() || '*'
  const searchPath = String(args.path || '.').trim() || '.'
  const limit =
    typeof args.limit === 'number' && args.limit > 0
      ? Math.min(args.limit, MAX_GLOB_LIMIT)
      : DEFAULT_GLOB_LIMIT

  const state = await stateManager.load()
  const perimeter = validatePerimeter(searchPath, state, args.project, context?.threadId)

  if (!fs.existsSync(perimeter.canonicalPath)) {
    return { ok: false, error: `Diretório não encontrado: '${searchPath}'.` }
  }

  const matcher = createGlobFilter(pattern)
  const matches: string[] = []

  const considerFile = (fullPath: string, name: string): void => {
    if (matches.length >= limit) return
    const relative = toPosixPath(path.relative(perimeter.canonicalPath, fullPath)) || name
    if (matcher.test(relative, name)) matches.push(relative)
  }

  const rootStat = fs.statSync(perimeter.canonicalPath)
  if (rootStat.isDirectory()) {
    const walk = (dir: string): void => {
      if (matches.length >= limit) return
      for (const item of listDirectory(dir)) {
        if (matches.length >= limit) break
        const fullPath = path.join(dir, item.name)
        if (item.isDirectory) {
          if (!IGNORED_DIRS.has(item.name)) walk(fullPath)
          continue
        }
        if (item.isSymlink) {
          // Only follow file symlinks; directory links could cycle.
          try {
            if (fs.statSync(fullPath).isFile()) considerFile(fullPath, item.name)
          } catch {
            /* broken link */
          }
          continue
        }
        considerFile(fullPath, item.name)
      }
    }
    walk(perimeter.canonicalPath)
  } else {
    considerFile(perimeter.canonicalPath, path.basename(perimeter.canonicalPath))
  }

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
      pattern,
      matchesCount: matches.length,
      hasMore: matches.length >= limit,
      ...projectFields,
      matches
    })
  }
}

interface GrepMatch {
  file: string
  line: number
  content: string
  before?: string[]
  after?: string[]
}

let cachedRipgrepPath: string | null | undefined = undefined

function resolveRipgrepPath(): string | null {
  if (cachedRipgrepPath !== undefined) return cachedRipgrepPath
  try {
    const test = execSync('where.exe rg.exe', {
      stdio: 'pipe',
      encoding: 'utf-8',
      windowsHide: true
    })
    if (test && test.trim()) {
      cachedRipgrepPath = test.split(/\r?\n/)[0].trim()
      return cachedRipgrepPath
    }
  } catch {}
  cachedRipgrepPath = null
  return null
}

async function runRipgrepSearch(
  rgPath: string,
  canonicalPath: string,
  query: string,
  options: {
    limit: number
    isRegex: boolean
    caseSensitive: boolean
    include?: string
    contextLines?: number
  }
): Promise<{ ok: boolean; results: GrepMatch[]; searchTruncated?: boolean }> {
  return new Promise((resolve) => {
    let isFile = false
    try {
      isFile = fs.statSync(canonicalPath).isFile()
    } catch {
      resolve({ ok: false, results: [] })
      return
    }

    const cwd = isFile ? path.dirname(canonicalPath) : canonicalPath
    const targetArg = isFile ? path.basename(canonicalPath) : '.'

    const args: string[] = ['--json', '--color=never']
    if (!options.isRegex) args.push('-F')
    if (options.caseSensitive) args.push('-s')
    else args.push('-i')

    if (options.contextLines && options.contextLines > 0) {
      args.push('-C', String(options.contextLines))
    }

    if (options.include) {
      args.push('--glob', options.include)
    }

    for (const ignored of IGNORED_DIRS) {
      args.push('--glob', `!**/${ignored}/**`)
    }
    for (const binExt of BINARY_EXTENSIONS) {
      args.push('--glob', `!*${binExt}`)
    }

    args.push(query, targetArg)

    let child: any
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (child?.pid) {
          if (process.platform === 'win32') {
            execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore', windowsHide: true })
          } else {
            process.kill(-child.pid, 'SIGKILL')
          }
        }
      } catch {}
    }, 4000)

    try {
      child = spawn(rgPath, args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch {
      clearTimeout(timer)
      resolve({ ok: false, results: [] })
      return
    }

    let stdoutData = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutData += chunk.toString('utf-8')
    })

    child.on('close', (code: number) => {
      clearTimeout(timer)
      if (timedOut) {
        resolve({ ok: false, results: [], searchTruncated: true })
        return
      }
      if (code !== 0 && code !== 1) {
        resolve({ ok: false, results: [] })
        return
      }

      const lines = stdoutData.split('\n')
      const matches: GrepMatch[] = []
      let currentFile = ''
      const contextBuf: { line: number; text: string }[] = []

      for (const line of lines) {
        if (!line.trim() || matches.length >= options.limit) continue
        try {
          const parsed = JSON.parse(line)
          if (parsed.type === 'begin') {
            currentFile = (parsed.data?.path?.text || '')
              .replace(/^\.[/\\]?/, '')
              .replace(/\\/g, '/')
            contextBuf.length = 0
          } else if (parsed.type === 'context') {
            const num = parsed.data?.line_number || 0
            const text = (parsed.data?.lines?.text || '').replace(/\r?\n$/, '').trim()
            contextBuf.push({ line: num, text })
            if (contextBuf.length > 20) contextBuf.shift()

            if (matches.length > 0 && options.contextLines && options.contextLines > 0) {
              const last = matches[matches.length - 1]
              if (last.file === (currentFile || path.basename(canonicalPath)) && num > last.line && num <= last.line + options.contextLines) {
                last.after = last.after || []
                last.after.push(text)
              }
            }
          } else if (parsed.type === 'match') {
            const num = parsed.data?.line_number || 0
            const text = (parsed.data?.lines?.text || '').replace(/\r?\n$/, '').trim()
            const before = (options.contextLines && options.contextLines > 0)
              ? contextBuf.filter((c) => c.line < num && c.line >= num - options.contextLines).map((c) => c.text)
              : undefined

            const entry: GrepMatch = {
              file: currentFile || path.basename(canonicalPath),
              line: num,
              content: text
            }
            if (before && before.length > 0) entry.before = before
            matches.push(entry)
          } else if (parsed.type === 'end') {
            if (matches.length > 0 && options.contextLines && options.contextLines > 0) {
              const last = matches[matches.length - 1]
              const matchFile = currentFile || path.basename(canonicalPath)
              if (last.file === matchFile && (!last.after || last.after.length === 0)) {
                try {
                  const targetFilePath = isFile ? canonicalPath : path.join(cwd, currentFile)
                  const stat = fs.statSync(targetFilePath)
                  if (stat.size > 0) {
                    const buf = Buffer.alloc(1)
                    const fd = fs.openSync(targetFilePath, 'r')
                    fs.readSync(fd, buf, 0, 1, stat.size - 1)
                    fs.closeSync(fd)
                    if (buf[0] === 10) {
                      last.after = ['']
                    }
                  }
                } catch {}
              }
            }
            contextBuf.length = 0
          }

        } catch {}
      }

      resolve({ ok: true, results: matches })
    })

    child.on('error', () => {
      clearTimeout(timer)
      resolve({ ok: false, results: [] })
    })
  })
}

async function executeCodeGrep(
  args: Record<string, any>,
  stateManager: CodeStateManager,
  context?: ToolContext
): Promise<any> {
  const query = String(args.query || '').trim()
  if (!query) {
    return { ok: false, error: 'Parâmetro obrigatório ausente: query.' }
  }
  const searchPath = String(args.path || '.').trim() || '.'
  const limit =
    typeof args.limit === 'number' && args.limit > 0
      ? Math.min(args.limit, MAX_GREP_LIMIT)
      : DEFAULT_GREP_LIMIT
  const isRegex = Boolean(args.isRegex)
  const caseSensitive = Boolean(args.caseSensitive)
  const include = String(args.include || '').trim()
  const contextLines =
    typeof args.context === 'number' && args.context > 0
      ? Math.min(Math.floor(args.context), MAX_GREP_CONTEXT_LINES)
      : 0

  const state = await stateManager.load()
  const perimeter = validatePerimeter(searchPath, state, args.project, context?.threadId, {
    extraReadRoots: attachmentReadRoots(context)
  })

  if (!fs.existsSync(perimeter.canonicalPath)) {
    return { ok: false, error: `Diretório ou arquivo não encontrado: '${searchPath}'.` }
  }

  // 1. Try native Ripgrep first (fastest, SIMD, respects .gitignore)
  const rgPath = resolveRipgrepPath()
  if (rgPath) {
    const rgResult = await runRipgrepSearch(rgPath, perimeter.canonicalPath, query, {
      limit,
      isRegex,
      caseSensitive,
      include,
      contextLines
    })

    if (rgResult.ok) {
      const projectFields = await projectInstructionsField(
        stateManager,
        state,
        perimeter.canonicalPath,
        context?.threadId
      )
      const regexHint =
        rgResult.results.length === 0 && !isRegex && query.includes('|')
          ? {
              hint: "A busca foi literal e não encontrou nada. Se a intenção era 'A ou B', refaça com isRegex: true."
            }
          : rgResult.searchTruncated
            ? {
                hint: "A busca foi limitada para proteger o desempenho. Especifique 'path' ou 'include' para restringir o diretório ou tipo de arquivo."
              }
            : {}

      return {
        ok: true,
        instruction: JSON.stringify({
          ok: true,
          base: perimeter.baseRoot.name,
          path: perimeter.canonicalPath,
          query,
          ...(include ? { include } : {}),
          matchesCount: rgResult.results.length,
          hasMore: rgResult.results.length >= limit || Boolean(rgResult.searchTruncated),
          ...(rgResult.searchTruncated ? { truncated: true } : {}),
          ...regexHint,
          ...projectFields,
          results: rgResult.results
        })
      }
    }
  }

  // 2. Fallback to JavaScript search engine
  let matcher: RegExp
  try {
    const source = isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    matcher = new RegExp(source, caseSensitive ? '' : 'i')
  } catch (err: any) {
    return { ok: false, error: `Expressão regular inválida: ${err?.message || err}` }
  }

  const includeFilter = include ? createGlobFilter(include) : null
  const results: GrepMatch[] = []

  const MAX_GREP_SCANNED_FILES = 1500
  const MAX_GREP_DURATION_MS = 4000
  let scannedFilesCount = 0
  let searchTruncated = false
  const searchStartTime = Date.now()


  const searchFile = (fullPath: string, relativePath: string): void => {
    if (results.length >= limit || searchTruncated) return
    if (scannedFilesCount >= MAX_GREP_SCANNED_FILES || Date.now() - searchStartTime > MAX_GREP_DURATION_MS) {
      searchTruncated = true
      return
    }
    scannedFilesCount += 1

    const ext = path.extname(fullPath).toLowerCase()
    if (BINARY_EXTENSIONS && BINARY_EXTENSIONS.has(ext)) return

    try {
      const stat = fs.statSync(fullPath)
      if (!stat.isFile() || stat.size > MAX_GREP_FILE_BYTES) return

      const content = fs.readFileSync(fullPath, 'utf-8')
      const lines = content.split(/\r?\n/)
      for (let i = 0; i < lines.length && results.length < limit; i += 1) {
        if (!matcher.test(lines[i])) continue
        const entry: GrepMatch = {
          file: relativePath,
          line: i + 1,
          content: lines[i].trim()
        }
        if (contextLines > 0) {
          entry.before = lines.slice(Math.max(0, i - contextLines), i).map((line) => line.trim())
          entry.after = lines.slice(i + 1, i + 1 + contextLines).map((line) => line.trim())
        }
        results.push(entry)
      }
    } catch {
      /* unreadable file stays out of the results */
    }
  }

  const rootStat = fs.statSync(perimeter.canonicalPath)
  if (rootStat.isFile()) {
    // A file path searches just that file — a directory-only walk used to
    // return zero matches silently here.
    searchFile(perimeter.canonicalPath, path.basename(perimeter.canonicalPath))
  } else {
    const walk = (dir: string): void => {
      if (results.length >= limit || searchTruncated) return
      for (const item of listDirectory(dir)) {
        if (results.length >= limit || searchTruncated) break
        const fullPath = path.join(dir, item.name)
        if (item.isDirectory) {
          if (!IGNORED_DIRS.has(item.name)) walk(fullPath)
          continue
        }
        if (item.isSymlink) {
          try {
            if (!fs.statSync(fullPath).isFile()) continue
          } catch {
            continue
          }
        }
        const relative = toPosixPath(path.relative(perimeter.canonicalPath, fullPath)) || item.name
        if (includeFilter && !includeFilter.test(relative, item.name)) continue
        searchFile(fullPath, relative)
      }
    }
    walk(perimeter.canonicalPath)
  }

  const projectFields = await projectInstructionsField(
    stateManager,
    state,
    perimeter.canonicalPath,
    context?.threadId
  )
  // `|`-style queries are the usual regex intent, but a literal search can
  // never match them; point the model at the fix instead of a silent zero.
  const regexHint =
    results.length === 0 && !isRegex && query.includes('|')
      ? {
          hint: "A busca foi literal e não encontrou nada. Se a intenção era 'A ou B', refaça com isRegex: true."
        }
      : searchTruncated
        ? {
            hint: "A busca foi limitada para proteger o desempenho. Especifique 'path' ou 'include' para restringir o diretório ou tipo de arquivo."
          }
        : {}

  return {
    ok: true,
    instruction: JSON.stringify({
      ok: true,
      base: perimeter.baseRoot.name,
      path: perimeter.canonicalPath,
      query,
      ...(include ? { include } : {}),
      matchesCount: results.length,
      hasMore: results.length >= limit || searchTruncated,
      ...(searchTruncated ? { truncated: true } : {}),
      ...regexHint,
      ...projectFields,
      results
    })
  }
}

module.exports = {
  executeCodeGlob,
  executeCodeGrep
}
