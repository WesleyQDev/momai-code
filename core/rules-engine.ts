const path = require('node:path')
const os = require('node:os')
import type {
  MomAiCodeStorageState,
  TerminalRule
} from './types.ts'

/**
 * Escapes characters for regex, keeping * and ? as placeholders.
 */
function patternToRegex(pattern: string): RegExp {
  const trimmed = pattern.trim()
  let regexStr = '^'
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (ch === '*') {
      regexStr += '.*'
    } else if (ch === '?') {
      regexStr += '.'
    } else if (['.', '+', '^', '$', '(', ')', '[', ']', '{', '}', '\\', '|'].includes(ch)) {
      regexStr += '\\' + ch
    } else {
      regexStr += ch
    }
  }
  regexStr += '$'
  return new RegExp(regexStr, 'i')
}

/**
 * Splits a shell command string into segments based on shell operators:
 * &&, ||, ;, |, |&, &, and newlines, while respecting single and double quotes.
 */
function splitCommandSegments(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let inSingleQuote = false
  let inDoubleQuote = false

  let i = 0
  const len = command.length

  while (i < len) {
    const ch = command[i]
    const nextCh = i + 1 < len ? command[i + 1] : ''

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      current += ch
      i++
      continue
    }

    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      current += ch
      i++
      continue
    }

    if (!inSingleQuote && !inDoubleQuote) {
      // Check operators
      if (ch === '&' && nextCh === '&') {
        if (current.trim().length > 0) segments.push(current.trim())
        current = ''
        i += 2
        continue
      }
      if (ch === '|' && nextCh === '|') {
        if (current.trim().length > 0) segments.push(current.trim())
        current = ''
        i += 2
        continue
      }
      if (ch === '|' && nextCh === '&') {
        if (current.trim().length > 0) segments.push(current.trim())
        current = ''
        i += 2
        continue
      }
      if (ch === ';' || ch === '|' || ch === '&' || ch === '\n' || ch === '\r') {
        if (current.trim().length > 0) segments.push(current.trim())
        current = ''
        i++
        continue
      }
    }

    current += ch
    i++
  }

  if (current.trim().length > 0) {
    segments.push(current.trim())
  }

  return segments.length > 0 ? segments : [command.trim()]
}

function normalizeCommand(cmd: string): string {
  return cmd.trim().replace(/\s+/g, ' ')
}

/** Quote-aware tokenizer: `Remove-Item -LiteralPath 'a b.txt' -Force` -> 4 tokens. */
function tokenizeSegment(segment: string): string[] {
  const tokens: string[] = []
  let current = ''
  let inSingleQuote = false
  let inDoubleQuote = false

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      current += ch
      continue
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      current += ch
      continue
    }
    if (!inSingleQuote && !inDoubleQuote && /\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (current.length > 0) tokens.push(current)
  return tokens
}

/** Deleting verbs across PowerShell (aliases included), cmd and POSIX shells. */
const DELETE_VERBS = new Set([
  'rm',
  'rmdir',
  'rd',
  'del',
  'erase',
  'unlink',
  'shred',
  'remove-item',
  'ri'
])

/** Verbs that read file contents (used for the .env guard). */
const READ_VERBS = new Set([
  'cat',
  'type',
  'get-content',
  'gc',
  'head',
  'tail',
  'more',
  'less',
  'select-string',
  'sls',
  'grep',
  'rg',
  'strings'
])

/** Verbs that fetch remote content, and the shells a pipeline can pipe into. */
const DOWNLOADER_VERBS = new Set(['curl', 'wget', 'iwr', 'invoke-webrequest', 'irm', 'invoke-restmethod'])
const SHELL_VERBS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'fish',
  'pwsh',
  'powershell',
  'iex',
  'invoke-expression'
])

const ENV_FILE_RE = /^\.env(\.[a-z0-9_-]+)*$/i
const ENV_EXAMPLE_RE = /\.example$/i

const WRAPPER_COMMANDS = new Set(['sudo', 'command', 'env', 'nohup', 'time'])
const SHELL_COMMANDS = new Set(['bash', 'sh', 'zsh', 'dash', 'fish'])
const CMD_COMMANDS = new Set(['cmd', 'cmd.exe'])
const POWERSHELL_COMMANDS = new Set(['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'])
const SCRIPT_FLAGS = new Set(['-c', '-command', '/c', '/k'])

function stripQuotes(value: string): string {
  return value.replace(/^["']+|["']+$/g, '')
}

function isFlagToken(token: string): boolean {
  if (token.startsWith('--')) return true
  if (/^-[a-zA-Z][a-zA-Z0-9-]*$/.test(token)) return true
  // cmd/PowerShell short flags: /s /q /f (never a Windows path, which carries a drive letter)
  if (/^\/[a-zA-Z]{1,3}$/.test(token)) return true
  return false
}

/**
 * Unwraps `sudo`, `cmd /c`, `powershell -Command "..."`, `bash -c "..."` so the
 * actual verb and its targets are visible. Bounded to avoid loops.
 */
function unwrapCommand(segment: string, depth = 0): { verb: string; args: string[]; commandText: string } {
  const tokens = tokenizeSegment(segment)
  let index = 0
  let lastShellVerb = ''

  while (index < tokens.length && depth < 3) {
    const token = tokens[index].toLowerCase()
    if (WRAPPER_COMMANDS.has(token)) {
      index++
      // `env FOO=bar cmd ...`
      while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index++
      continue
    }
    if (CMD_COMMANDS.has(token) || POWERSHELL_COMMANDS.has(token) || SHELL_COMMANDS.has(token)) {
      lastShellVerb = token
      index++
      while (index < tokens.length && isFlagToken(tokens[index])) {
        const flag = tokens[index].toLowerCase()
        index++
        if (SCRIPT_FLAGS.has(flag) && index < tokens.length) {
          // Everything after the flag is the script itself (it may hold several
          // tokens, quoted or not) and is evaluated on its own.
          return unwrapCommand(stripQuotes(tokens.slice(index).join(' ')), depth + 1)
        }
      }
      continue
    }
    break
  }

  if (index >= tokens.length && lastShellVerb) {
    // A shell with no script of its own: `curl x | sh`, `cmd /c` with nothing
    // after it. The shell itself is the verb.
    return { verb: lastShellVerb, args: [], commandText: lastShellVerb }
  }

  const verb = stripQuotes(tokens[index] || '').toLowerCase()
  const args = tokens.slice(index + 1).map(stripQuotes)
  return { verb, args, commandText: tokens.slice(index).join(' ') }
}

/** Normalizes a filesystem path for comparison (drive letter casing on Windows). */
function normalizeFsPath(input: string): string {
  let resolved = path.resolve(input)
  if (process.platform === 'win32' && /^[a-zA-Z]:/.test(resolved)) {
    resolved = resolved[0].toUpperCase() + resolved.slice(1)
  }
  return resolved
}

function comparable(input: string): string {
  return process.platform === 'win32' ? input.toLowerCase() : input
}

function isAncestorOf(candidate: string, target: string): boolean {
  const parent = comparable(candidate)
  const child = comparable(target)
  if (parent === child) return false
  const prefix = parent.endsWith(path.sep) ? parent : parent + path.sep
  return child.startsWith(prefix)
}

function expandHome(raw: string): string {
  let out = raw
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) {
    out = path.join(os.homedir(), out.slice(1))
  }
  out = out.replace(/^\$HOME(?=$|[\\/])/, os.homedir())
  out = out.replace(/^\$\{HOME\}(?=$|[\\/])/, os.homedir())
  out = out.replace(/^%USERPROFILE%(?=$|[\\/])/i, os.homedir())
  return out
}

/**
 * True when the target means "everything": a bare glob, the filesystem/drive
 * root, the Home directory, the working root itself or any ancestor of it.
 * These are refused outright — no rule and no grant can unlock them.
 */
function isWholeTreeTarget(rawTarget: string, cwd: string): boolean {
  const cleaned = stripQuotes(String(rawTarget || '').trim())
  if (!cleaned) return false

  // `*`, `**`, `./*`, `.\*`, `**/*`, `*.*`: every entry of the target directory.
  if (/^(\.{0,2}[\\/])?\*+([\\/]\*+)?$/.test(cleaned) || cleaned === '*.*') return true

  // `dir/*` and `dir\*` mean the directory itself.
  const withoutGlob = expandHome(cleaned).replace(/[\\/]\*$/, '')
  const resolved = normalizeFsPath(
    path.isAbsolute(withoutGlob) ? withoutGlob : path.resolve(cwd || process.cwd(), withoutGlob)
  )

  const root = normalizeFsPath(path.parse(resolved).root)
  const home = normalizeFsPath(os.homedir())
  const base = normalizeFsPath(cwd || process.cwd())

  if (comparable(resolved) === comparable(root)) return true
  if (comparable(resolved) === comparable(home)) return true
  if (comparable(resolved) === comparable(base)) return true
  // Deleting an ancestor wipes the working tree too (`rm -rf ..`).
  if (isAncestorOf(resolved, base)) return true
  return false
}

export interface CommandPolicyResult {
  /**
   * Policy the host should apply to this command:
   * - `allow`: runs silently;
   * - `ask`: the host pauses and asks the user before running;
   * - `deny`: refused outright (a `block` rule or a whole-tree delete).
   * When segments disagree, the strictest one wins (`deny` > `ask` > `allow`).
   */
  policy: 'allow' | 'ask' | 'deny'
  matchedRule?: TerminalRule
  blockedSegment?: string
  /** Scope key for "allow always" when the ask came from the delete baseline. */
  grantScope?: string
  /** Reason shown in the approval card or in the refusal. */
  reason?: string
}

export interface CommandPolicyOptions {
  /** Working directory the command will run in (the active project root). */
  cwd?: string
}

const POLICY_RANK: Record<CommandPolicyResult['policy'], number> = {
  allow: 0,
  ask: 1,
  deny: 2
}

function policyForAction(action: TerminalRule['action']): CommandPolicyResult['policy'] {
  if (action === 'allow') return 'allow'
  if (action === 'ask') return 'ask'
  return 'deny'
}

/** Last match wins over the ordered rules. */
function matchRules(text: string, rules: TerminalRule[]): { policy: CommandPolicyResult['policy']; matchedRule: TerminalRule } | null {
  let decision: CommandPolicyResult['policy'] = 'allow'
  let matchedRule: TerminalRule | undefined
  for (const rule of rules) {
    const rx = patternToRegex(rule.pattern)
    if (rx.test(text)) {
      decision = policyForAction(rule.action)
      matchedRule = rule
    }
  }
  return matchedRule ? { policy: decision, matchedRule } : null
}

function evaluateSegment(
  segment: string,
  rules: TerminalRule[],
  cwd: string
): CommandPolicyResult {
  const normSegment = normalizeCommand(segment)
  const { verb, args, commandText } = unwrapCommand(segment)
  const isDeleteVerb = DELETE_VERBS.has(verb)
  const targets = args.filter((token) => !isFlagToken(token))

  // 1. Whole-tree deletes are always refused, whatever the rules say.
  if (isDeleteVerb) {
    const wipeTarget = targets.find((target) => isWholeTreeTarget(target, cwd))
    if (wipeTarget) {
      return {
        policy: 'deny',
        blockedSegment: segment,
        reason: `Apaga tudo (${stripQuotes(wipeTarget)}) e está bloqueado por segurança`
      }
    }
  }

  // 2. User/preset rules, matched against the segment and its unwrapped form.
  const texts = commandText && commandText !== normSegment ? [normSegment, normalizeCommand(commandText)] : [normSegment]
  let ruleDecision: { policy: CommandPolicyResult['policy']; matchedRule: TerminalRule } | null = null
  for (const text of texts) {
    const decision = matchRules(text, rules)
    if (decision && (!ruleDecision || POLICY_RANK[decision.policy] > POLICY_RANK[ruleDecision.policy])) {
      ruleDecision = decision
    }
  }
  if (ruleDecision) {
    const { policy, matchedRule } = ruleDecision
    return {
      policy,
      matchedRule,
      blockedSegment: segment,
      reason:
        policy === 'deny'
          ? `Regra '${matchedRule.pattern}' bloqueia este comando sem aprovação (segmento: ${segment})`
          : `Regra '${matchedRule.pattern}' (segmento: ${segment})`
    }
  }

  // 3. Deleting a specific file or folder asks by default, in any command form.
  //    A delete verb without explicit targets still asks: it may be deleting
  //    whatever arrives through a pipe (`Get-ChildItem x | Remove-Item`).
  if (isDeleteVerb) {
    const label = targets.map((target) => stripQuotes(target)).join(', ')
    return {
      policy: 'ask',
      blockedSegment: segment,
      grantScope: `delete:${verb}`,
      reason: label ? `Exclui ${label}` : 'Exclui a entrada do comando'
    }
  }

  // 4. Reading .env files asks: their secrets would go to the model provider.
  //    `.env.example` carries no secrets and stays allowed.
  if (READ_VERBS.has(verb)) {
    const secretFile = targets.find((target) => {
      const base = stripQuotes(target).split(/[\\/]/).pop() || ''
      return ENV_FILE_RE.test(base) && !ENV_EXAMPLE_RE.test(base)
    })
    if (secretFile) {
      return {
        policy: 'ask',
        blockedSegment: segment,
        grantScope: 'read:env',
        reason: `Lê ${stripQuotes(secretFile)} (segredos)`
      }
    }
  }

  return { policy: 'allow' }
}

/**
 * `curl ... | sh` / `iwr ... | iex` runs remote code: ask even though neither
 * segment looks dangerous on its own.
 */
function detectRemoteExecPipeline(segments: string[]): CommandPolicyResult | null {
  if (segments.length < 2) return null
  const last = unwrapCommand(segments[segments.length - 1])
  if (!SHELL_VERBS.has(last.verb)) return null
  const hasScriptArgument = last.args.some((argument) => !isFlagToken(argument))
  if (hasScriptArgument) return null
  const downloadsFirst = segments
    .slice(0, -1)
    .some((segment) => DOWNLOADER_VERBS.has(unwrapCommand(segment).verb))
  if (!downloadsFirst) return null
  return {
    policy: 'ask',
    blockedSegment: segments[segments.length - 1],
    grantScope: 'remote-exec',
    reason: 'Baixa e executa código remoto (pipe para o shell)'
  }
}

/**
 * Evaluates a command and returns the policy for the host gate
 * (`permission.policyTool`). Rules are the domain of this extension; pausing,
 * showing the card and remembering "allow always" are the host's job, so this
 * function never executes or grants anything.
 */
function evaluateCommandPolicy(
  command: string,
  state: MomAiCodeStorageState,
  options?: CommandPolicyOptions
): CommandPolicyResult {
  const segments = splitCommandSegments(command)
  const enabledRules = (state.terminalRules || []).filter((r) => r.enabled)
  const cwd = options?.cwd || process.cwd()

  let result: CommandPolicyResult = { policy: 'allow' }

  for (const segment of segments) {
    const segmentResult = evaluateSegment(segment, enabledRules, cwd)
    if (segmentResult.policy !== 'allow' && POLICY_RANK[segmentResult.policy] > POLICY_RANK[result.policy]) {
      result = segmentResult
    }
  }

  // Pipeline-level check: only matters when no segment was stricter.
  if (POLICY_RANK[result.policy] < POLICY_RANK.ask) {
    const remoteExec = detectRemoteExecPipeline(segments)
    if (remoteExec) result = remoteExec
  }

  return result
}

module.exports = {
  patternToRegex,
  splitCommandSegments,
  normalizeCommand,
  tokenizeSegment,
  unwrapCommand,
  isWholeTreeTarget,
  evaluateCommandPolicy
}
