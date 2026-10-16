const fs = require('node:fs')
const path = require('node:path')
const { isInsideOrEqual } = require('./perimeter.ts')

/** Instruction files read from the project root when the agent works on it. */
const PROJECT_INSTRUCTION_FILES = ['AGENTS.md']
/** Bounds so a huge instruction file cannot flood the context in one tool call. */
const MAX_INSTRUCTION_FILE_BYTES = 512 * 1024
const MAX_INSTRUCTION_CHARS = 20000
/** Same thread+project re-attaches only after this window. */
const REATTACH_COOLDOWN_MS = 15 * 60 * 1000
const MAX_ATTACHMENT_KEYS = 200

interface ProjectInstructions {
  file: string
  content: string
}

/**
 * Reads the project's agent instruction file (AGENTS.md). Missing or unreadable
 * files never block a tool call.
 */
function readProjectInstructions(projectPath: string): ProjectInstructions | null {
  for (const file of PROJECT_INSTRUCTION_FILES) {
    try {
      const fullPath = path.join(projectPath, file)
      const stat = fs.statSync(fullPath)
      if (!stat.isFile() || stat.size > MAX_INSTRUCTION_FILE_BYTES) continue
      let content = fs.readFileSync(fullPath, 'utf-8').replace(/^\uFEFF/, '')
      if (content.length > MAX_INSTRUCTION_CHARS) {
        content = `${content.slice(0, MAX_INSTRUCTION_CHARS)}\n\n[... ${file} truncado; continue com code_read em '${file}']`
      }
      return { file, content }
    } catch {
      // Missing or unreadable instruction files are simply skipped.
    }
  }
  return null
}

/** Most specific registered project containing the path (longest root wins). */
function resolveProjectForPath(state: any, accessedPath: string): any {
  const matches = (state.projects || []).filter(
    (project: any) => project && project.path && isInsideOrEqual(accessedPath, project.path)
  )
  if (matches.length === 0) return null
  return matches.sort((a: any, b: any) => b.path.length - a.path.length)[0]
}

function pruneAttachments(attachments: Record<string, number>): void {
  const entries = Object.entries(attachments)
  if (entries.length <= MAX_ATTACHMENT_KEYS) return
  entries.sort((a, b) => Number(b[1]) - Number(a[1]))
  for (const [key] of entries.slice(MAX_ATTACHMENT_KEYS)) delete attachments[key]
}

interface AttachOptions {
  threadId?: string
  /** Path being touched by the tool call; used to resolve the project. */
  accessedPath?: string
  /** Explicit project (used by code_project_use). */
  project?: { id: string; name: string; path: string }
  /** Skips the cooldown: entering a project always brings its instructions. */
  force?: boolean
}

/**
 * Returns the project instruction block to append to a tool result, or '' when
 * there is nothing (or nothing recent enough) to attach. Mutates/persists the
 * per-thread attachment bookkeeping when it attaches.
 */
async function attachProjectInstructions(
  stateManager: any,
  state: any,
  options: AttachOptions
): Promise<string> {
  const project = options.project || (options.accessedPath ? resolveProjectForPath(state, options.accessedPath) : null)
  if (!project) return ''

  const attachments: Record<string, number> = (state.instructionAttachments =
    state.instructionAttachments || {})
  const key = `${options.threadId || 'default'}:${project.id}`
  const lastAttachedAt = Number(attachments[key] || 0)
  if (!options.force && Date.now() - lastAttachedAt < REATTACH_COOLDOWN_MS) return ''

  const instructions = readProjectInstructions(project.path)
  if (!instructions) return ''

  attachments[key] = Date.now()
  pruneAttachments(attachments)
  await stateManager.save(state)

  return `\n\nInstruções do projeto (${instructions.file}) — convenções do repositório '${project.name}' que você deve seguir:\n\n${instructions.content}`
}

/**
 * Ready-to-spread payload field for tool results: `{ projectInstructions }`
 * when the touched path belongs to a registered project with instructions.
 */
async function projectInstructionsField(
  stateManager: any,
  state: any,
  accessedPath: string,
  threadId?: string
): Promise<Record<string, string>> {
  const instructions = await attachProjectInstructions(stateManager, state, {
    threadId,
    accessedPath
  })
  return instructions ? { projectInstructions: instructions } : {}
}

module.exports = {
  attachProjectInstructions,
  projectInstructionsField,
  readProjectInstructions,
  resolveProjectForPath,
  PROJECT_INSTRUCTION_FILES,
  MAX_INSTRUCTION_CHARS,
  REATTACH_COOLDOWN_MS
}
