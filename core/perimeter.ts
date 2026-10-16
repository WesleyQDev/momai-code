const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
import type { MomAiCodeStorageState, ProjectDefinition } from './types.ts'

export interface ResolvedRoot {
  id: string
  name: string
  path: string
  isHome: boolean
}

function normalizePath(p: string): string {
  let resolved = path.resolve(p)
  // On Windows, uppercase drive letter for consistent comparison
  if (process.platform === 'win32' && /^[a-zA-Z]:/.test(resolved)) {
    resolved = resolved[0].toUpperCase() + resolved.slice(1)
  }
  return resolved
}

function getHomeRoot(): ResolvedRoot {
  const homePath = normalizePath(os.homedir())
  return {
    id: 'home',
    name: 'Sem projeto (Home)',
    path: homePath,
    isHome: true
  }
}

function getAllAllowedRoots(state: MomAiCodeStorageState): ResolvedRoot[] {
  const roots: ResolvedRoot[] = []
  for (const proj of state.projects || []) {
    roots.push({
      id: proj.id,
      name: proj.name,
      path: normalizePath(proj.path),
      isHome: false
    })
  }
  // Sort projects by path length descending (most specific first)
  roots.sort((a, b) => b.path.length - a.path.length)

  // Add Home at the end as general fallback
  roots.push(getHomeRoot())
  return roots
}

function resolveTargetRoot(
  state: MomAiCodeStorageState,
  projectArg?: string,
  threadId?: string
): ResolvedRoot {
  const allRoots = getAllAllowedRoots(state)

  // Explicit project argument
  if (typeof projectArg === 'string' && projectArg.trim().length > 0) {
    const query = projectArg.trim().toLowerCase()
    if (query === 'home' || query === 'sem projeto' || query === 'sem projeto (home)') {
      return getHomeRoot()
    }
    const match = (state.projects || []).find((p) => p.name.toLowerCase() === query)
    if (!match) {
      const validNames = ['home', ...(state.projects || []).map((p) => `"${p.name}"`)]
      throw new Error(
        `Projeto '${projectArg}' não encontrado entre os projetos autorizados. Projetos disponíveis: ${validNames.join(', ')}.`
      )
    }
    return {
      id: match.id,
      name: match.name,
      path: normalizePath(match.path),
      isHome: false
    }
  }

  // Active project for this chat thread
  if (threadId && state.activeProjects && state.activeProjects[threadId]) {
    const activeId = state.activeProjects[threadId]
    const match = (state.projects || []).find((p) => p.id === activeId)
    if (match) {
      return {
        id: match.id,
        name: match.name,
        path: normalizePath(match.path),
        isHome: false
      }
    }
  }

  // Default: Home
  return getHomeRoot()
}

/**
 * Checks if targetPath is strictly inside or equal to parentPath.
 */
function isInsideOrEqual(targetPath: string, parentPath: string): boolean {
  const normalizedTarget = normalizePath(targetPath)
  const normalizedParent = normalizePath(parentPath)

  if (process.platform === 'win32') {
    const lowerTarget = normalizedTarget.toLowerCase()
    const lowerParent = normalizedParent.toLowerCase()
    if (lowerTarget === lowerParent) return true
    return lowerTarget.startsWith(lowerParent.endsWith(path.sep) ? lowerParent : lowerParent + path.sep)
  }

  if (normalizedTarget === normalizedParent) return true
  return normalizedTarget.startsWith(normalizedParent.endsWith(path.sep) ? normalizedParent : normalizedParent + path.sep)
}

/**
 * Resolves the real, canonical path to prevent symlink traversal and escapes.
 * If the leaf file does not exist yet, resolves the deepest existing ancestor.
 */
function resolveCanonicalPath(targetPath: string): string {
  const abs = normalizePath(targetPath)
  try {
    if (fs.existsSync(abs)) {
      return normalizePath(fs.realpathSync.native ? fs.realpathSync.native(abs) : fs.realpathSync(abs))
    }
  } catch {}

  // Find existing ancestor
  let current = abs
  const segments: string[] = []
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) break
    segments.unshift(path.basename(current))
    current = parent
  }

  let canonicalParent = current
  try {
    if (fs.existsSync(current)) {
      canonicalParent = normalizePath(fs.realpathSync.native ? fs.realpathSync.native(current) : fs.realpathSync(current))
    }
  } catch {}

  return segments.length > 0 ? normalizePath(path.join(canonicalParent, ...segments)) : canonicalParent
}

export interface PerimeterCheckResult {
  fullPath: string
  canonicalPath: string
  baseRoot: ResolvedRoot
  allowed: boolean
  matchedRoot?: ResolvedRoot
}

export interface PerimeterOptions {
  /**
   * Extra read-only roots for this call only (e.g. the working copies the host
   * staged for the current message's attachments). Read tools pass them; write
   * tools never do, so attachments stay read-only for the extension.
   */
  extraReadRoots?: string[]
}

/**
 * Validates that the target path resides within the allowed perimeter.
 *
 * - Home mode (no project in use): the perimeter is the union (Home plus every
 *   authorized project), so any authorized path stays reachable.
 * - Project in use (active project or an explicit `project` argument): the
 *   conversation is scoped to that project's root, even when the path is inside
 *   the user's Home. This is what makes "work on this project" mean the
 *   assistant stays inside it; `code_project_use` switches the scope.
 * - `options.extraReadRoots` adds per-call read allowances (host-staged
 *   attachments) without widening the writable perimeter.
 */
function validatePerimeter(
  inputPath: string,
  state: MomAiCodeStorageState,
  projectArg?: string,
  threadId?: string,
  options?: PerimeterOptions
): PerimeterCheckResult {
  const baseRoot = resolveTargetRoot(state, projectArg, threadId)
  const resolvedPath = path.isAbsolute(inputPath)
    ? normalizePath(inputPath)
    : normalizePath(path.resolve(baseRoot.path, inputPath))

  const canonical = resolveCanonicalPath(resolvedPath)
  const baseRoots = baseRoot.isHome ? getAllAllowedRoots(state) : [baseRoot]
  const extraRoots: ResolvedRoot[] = (options?.extraReadRoots || [])
    .filter((candidate) => typeof candidate === 'string' && candidate.trim().length > 0)
    .map((candidate, index) => ({
      id: `turn-attachment-${index}`,
      name: 'Anexo da conversa (somente leitura)',
      // Canonicalize so a staged copy behind a junction/symlink still matches
      // the canonical target path resolved below.
      path: resolveCanonicalPath(candidate),
      isHome: false
    }))

  const matchedRoot = [...baseRoots, ...extraRoots].find((root) =>
    isInsideOrEqual(canonical, root.path)
  )

  if (!matchedRoot) {
    const rootList = baseRoots.map((r) => `${r.name} (${r.path})`).join('\n - ')
    const scopeHint = baseRoot.isHome
      ? 'Para acessar outra pasta fora da Home, solicite autorização com code_project_request.'
      : `O escopo atual é o projeto '${baseRoot.name}'. Use code_project_use { project: "home" } ou o nome de outro projeto para mudar o escopo desta conversa.`
    throw new Error(
      `Acesso negado: o caminho '${inputPath}' (resolvido como '${canonical}') está fora do perímetro de trabalho autorizado.\nRaízes autorizadas agora:\n - ${rootList}\n${scopeHint}`
    )
  }

  return {
    fullPath: resolvedPath,
    canonicalPath: canonical,
    baseRoot,
    allowed: true,
    matchedRoot
  }
}

module.exports = {
  normalizePath,
  getHomeRoot,
  getAllAllowedRoots,
  resolveTargetRoot,
  isInsideOrEqual,
  resolveCanonicalPath,
  validatePerimeter
}
