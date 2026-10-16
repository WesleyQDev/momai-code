import type {
  MomAiCodeStorageState,
  ProjectDefinition,
  PendingProjectRequest,
  TerminalRule,
  SingleUseGrant,
  MomAiCodeSettings
} from './types.ts'

const STORAGE_KEY = 'momai-code-state'
const PENDING_REQUEST_TTL_MS = 15 * 60 * 1000 // 15 minutos
const SINGLE_USE_GRANT_TTL_MS = 5 * 60 * 1000  // 5 minutos
const MAX_ACTIVE_PROJECT_THREADS = 100
/** Instruction-attachment bookkeeping is pruned after this long. */
const INSTRUCTION_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000
const MAX_INSTRUCTION_ATTACHMENT_KEYS = 200

/**
 * Curated protections on top of the engine's built-in baseline (deleting a file
 * or folder asks, wiping everything is blocked, .env reads and remote-exec
 * pipelines ask):
 *
 * - git mutations ask (OpenCode's own guidance: confirm every commit, push,
 *   reset, rebase and any other history rewrite);
 * - publishing and privileged/system actions ask;
 * - container/infra teardown asks;
 * - disk and boot tooling is a hard block (a formatted disk or a broken boot
 *   record is unrecoverable);
 * - database wipes ship disabled by default.
 */
const DEFAULT_PRESET_RULES: TerminalRule[] = [
  // Git mutations — ask
  { id: 'rule_git_1', pattern: 'git reset*', action: 'ask', enabled: true, group: 'git', source: 'preset' },
  { id: 'rule_git_2', pattern: 'git clean*', action: 'ask', enabled: true, group: 'git', source: 'preset' },
  { id: 'rule_git_3', pattern: 'git rebase*', action: 'ask', enabled: true, group: 'git', source: 'preset' },
  { id: 'rule_git_4', pattern: 'git checkout --*', action: 'ask', enabled: true, group: 'git', source: 'preset' },
  { id: 'rule_git_5', pattern: 'git checkout .', action: 'ask', enabled: true, group: 'git', source: 'preset' },
  { id: 'rule_git_6', pattern: 'git checkout -f*', action: 'ask', enabled: true, group: 'git', source: 'preset' },
  { id: 'rule_git_7', pattern: 'git switch --discard-changes*', action: 'ask', enabled: true, group: 'git', source: 'preset' },
  { id: 'rule_git_8', pattern: 'git switch --force*', action: 'ask', enabled: true, group: 'git', source: 'preset' },
  { id: 'rule_git_9', pattern: 'git restore*', action: 'ask', enabled: true, group: 'git', source: 'preset' },
  { id: 'rule_git_10', pattern: 'git commit*', action: 'ask', enabled: true, group: 'git', source: 'preset' },
  { id: 'rule_git_11', pattern: 'git push*', action: 'ask', enabled: true, group: 'git', source: 'preset' },
  { id: 'rule_git_12', pattern: 'git branch -D*', action: 'ask', enabled: true, group: 'git', source: 'preset' },
  { id: 'rule_git_13', pattern: 'git stash drop*', action: 'ask', enabled: true, group: 'git', source: 'preset' },
  { id: 'rule_git_14', pattern: 'git stash clear*', action: 'ask', enabled: true, group: 'git', source: 'preset' },
  { id: 'rule_git_15', pattern: 'git filter-branch*', action: 'ask', enabled: true, group: 'git', source: 'preset' },
  { id: 'rule_git_16', pattern: 'git filter-repo*', action: 'ask', enabled: true, group: 'git', source: 'preset' },

  // Publishing — ask (irreversible once it leaves the machine)
  { id: 'rule_pub_1', pattern: 'npm publish*', action: 'ask', enabled: true, group: 'publish', source: 'preset' },
  { id: 'rule_pub_2', pattern: 'pnpm publish*', action: 'ask', enabled: true, group: 'publish', source: 'preset' },
  { id: 'rule_pub_3', pattern: 'yarn publish*', action: 'ask', enabled: true, group: 'publish', source: 'preset' },
  { id: 'rule_pub_4', pattern: 'bun publish*', action: 'ask', enabled: true, group: 'publish', source: 'preset' },

  // Privileged / system — ask
  { id: 'rule_sys_1', pattern: 'sudo*', action: 'ask', enabled: true, group: 'system', source: 'preset' },
  { id: 'rule_sys_2', pattern: 'runas*', action: 'ask', enabled: true, group: 'system', source: 'preset' },
  { id: 'rule_sys_3', pattern: 'shutdown*', action: 'ask', enabled: true, group: 'system', source: 'preset' },
  { id: 'rule_sys_4', pattern: 'stop-computer*', action: 'ask', enabled: true, group: 'system', source: 'preset' },
  { id: 'rule_sys_5', pattern: 'restart-computer*', action: 'ask', enabled: true, group: 'system', source: 'preset' },
  { id: 'rule_sys_6', pattern: 'reg delete*', action: 'ask', enabled: true, group: 'system', source: 'preset' },
  { id: 'rule_sys_7', pattern: 'sc delete*', action: 'ask', enabled: true, group: 'system', source: 'preset' },

  // Containers / infra teardown — ask
  { id: 'rule_infra_1', pattern: 'docker system prune*', action: 'ask', enabled: true, group: 'infra', source: 'preset' },
  { id: 'rule_infra_2', pattern: 'docker volume rm*', action: 'ask', enabled: true, group: 'infra', source: 'preset' },
  { id: 'rule_infra_3', pattern: 'kubectl delete*', action: 'ask', enabled: true, group: 'infra', source: 'preset' },
  { id: 'rule_infra_4', pattern: 'terraform destroy*', action: 'ask', enabled: true, group: 'infra', source: 'preset' },

  // Disk, partitions and boot — hard block
  { id: 'rule_disk_1', pattern: 'format ?:*', action: 'block', enabled: true, group: 'disk', source: 'preset' },
  { id: 'rule_disk_2', pattern: 'mkfs*', action: 'block', enabled: true, group: 'disk', source: 'preset' },
  { id: 'rule_disk_3', pattern: 'diskpart*', action: 'block', enabled: true, group: 'disk', source: 'preset' },
  { id: 'rule_disk_4', pattern: 'dd *of=/dev/*', action: 'block', enabled: true, group: 'disk', source: 'preset' },
  { id: 'rule_disk_5', pattern: 'fdisk*', action: 'block', enabled: true, group: 'disk', source: 'preset' },
  { id: 'rule_disk_6', pattern: 'parted*', action: 'block', enabled: true, group: 'disk', source: 'preset' },
  { id: 'rule_disk_7', pattern: 'gdisk*', action: 'block', enabled: true, group: 'disk', source: 'preset' },
  { id: 'rule_disk_8', pattern: 'diskutil*', action: 'block', enabled: true, group: 'disk', source: 'preset' },
  { id: 'rule_boot_1', pattern: 'bcdedit*', action: 'block', enabled: true, group: 'disk', source: 'preset' },
  { id: 'rule_boot_2', pattern: 'bootrec*', action: 'block', enabled: true, group: 'disk', source: 'preset' },
  { id: 'rule_boot_3', pattern: 'vssadmin delete*', action: 'block', enabled: true, group: 'disk', source: 'preset' },

  // Optional / disabled by default: database
  { id: 'rule_db_1', pattern: 'drop table*', action: 'ask', enabled: false, group: 'database', source: 'preset' },
  { id: 'rule_db_2', pattern: 'truncate table*', action: 'ask', enabled: false, group: 'database', source: 'preset' }
]

const DEFAULT_SETTINGS: MomAiCodeSettings = {
  shell: 'powershell',
  defaultTimeoutMs: 30000,
  strictMode: false
}

function createDefaultState(): MomAiCodeStorageState {
  return {
    version: 4,
    projects: [],
    pendingRequests: [],
    activeProjects: {},
    instructionAttachments: {},
    terminalRules: [...DEFAULT_PRESET_RULES],
    singleUseGrants: [],
    settings: { ...DEFAULT_SETTINGS }
  }
}

/**
 * Brings a stored state up to the current shape.
 *
 * - v1 rules used `block` for "blocked but approvable" (the host asked before
 *   running), which is exactly what `ask` means now.
 * - v3 moved file/folder deletes into the engine baseline (any delete verb
 *   asks), so the old `rule_del_*` presets are dropped.
 * - v4 makes the curated preset set authoritative: presets follow the current
 *   table (patterns and actions), keeping the user's enable/disable toggles,
 *   so new protections actually reach existing installs.
 */
function migrateStoredState(raw: any): MomAiCodeStorageState {
  const state: MomAiCodeStorageState = {
    ...createDefaultState(),
    ...raw,
    version: 4,
    projects: Array.isArray(raw.projects) ? raw.projects : [],
    terminalRules: Array.isArray(raw.terminalRules) ? raw.terminalRules : [...DEFAULT_PRESET_RULES],
    settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) }
  }
  if (raw.version === 1) {
    state.terminalRules = state.terminalRules.map((rule: TerminalRule) =>
      rule && rule.action === 'block' ? { ...rule, action: 'ask' } : rule
    )
  }
  if (typeof raw.version !== 'number' || raw.version < 4) {
    const storedPresets = new Map<string, TerminalRule>(
      state.terminalRules
        .filter((rule: TerminalRule) => rule?.source === 'preset')
        .map((rule: TerminalRule) => [rule.id, rule])
    )
    // A list that was deliberately cleared of presets stays cleared.
    if (storedPresets.size > 0 || !Array.isArray(raw.terminalRules)) {
      const customRules = state.terminalRules.filter(
        (rule: TerminalRule) => rule?.source !== 'preset'
      )
      state.terminalRules = [
        ...DEFAULT_PRESET_RULES.map((preset) => {
          const stored = storedPresets.get(preset.id)
          return stored ? { ...preset, enabled: stored.enabled } : { ...preset }
        }),
        ...customRules
      ]
    }
  }
  return state
}

function cleanupExpiredState(state: MomAiCodeStorageState): MomAiCodeStorageState {
  const now = Date.now()
  const validRequests = (state.pendingRequests || []).filter((r) => {
    const exp = new Date(r.expiresAt).getTime()
    return !Number.isNaN(exp) && exp > now
  })

  const validGrants = (state.singleUseGrants || []).filter((g) => {
    const exp = new Date(g.expiresAt).getTime()
    return !Number.isNaN(exp) && exp > now
  })

  // Prune active projects if exceeding limit
  const activeEntries = Object.entries(state.activeProjects || {})
  let prunedActive = state.activeProjects || {}
  if (activeEntries.length > MAX_ACTIVE_PROJECT_THREADS) {
    prunedActive = Object.fromEntries(activeEntries.slice(-MAX_ACTIVE_PROJECT_THREADS))
  }

  // Drop stale AGENTS.md attachment records and keep the most recent ones.
  const attachmentEntries = Object.entries(state.instructionAttachments || {})
    .filter(([, at]) => now - Number(at || 0) < INSTRUCTION_ATTACHMENT_TTL_MS)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .slice(-MAX_INSTRUCTION_ATTACHMENT_KEYS)

  return {
    ...state,
    pendingRequests: validRequests,
    singleUseGrants: validGrants,
    activeProjects: prunedActive,
    instructionAttachments: Object.fromEntries(attachmentEntries)
  }
}

class CodeStateManager {
  private inMemoryState: MomAiCodeStorageState = createDefaultState()
  private storageBridge?: { get: (k: string) => Promise<any>; set: (k: string, v: any) => Promise<void> }
  private lastLoadedAt: number = 0
  private static readonly CACHE_TTL_MS = 3000

  constructor(storageBridge?: { get: (k: string) => Promise<any>; set: (k: string, v: any) => Promise<void> }) {
    this.storageBridge = storageBridge
  }

  setBridge(storageBridge: { get: (k: string) => Promise<any>; set: (k: string, v: any) => Promise<void> }) {
    this.storageBridge = storageBridge
    this.lastLoadedAt = 0
  }

  async load(forceRefresh?: boolean): Promise<MomAiCodeStorageState> {
    const now = Date.now()
    if (!forceRefresh && this.lastLoadedAt > 0 && now - this.lastLoadedAt < CodeStateManager.CACHE_TTL_MS) {
      this.inMemoryState = cleanupExpiredState(this.inMemoryState)
      return this.inMemoryState
    }

    if (this.storageBridge) {
      try {
        const raw = await this.storageBridge.get(STORAGE_KEY)
        if (raw && typeof raw === 'object' && [1, 2, 3, 4].includes(raw.version)) {
          this.inMemoryState = cleanupExpiredState(migrateStoredState(raw))
          this.lastLoadedAt = now
          return this.inMemoryState
        }
      } catch (err) {
        // Fallback to in-memory state on storage error
      }
    }
    this.inMemoryState = cleanupExpiredState(this.inMemoryState)
    this.lastLoadedAt = now
    return this.inMemoryState
  }

  async save(state: MomAiCodeStorageState): Promise<void> {
    this.inMemoryState = cleanupExpiredState(state)
    this.lastLoadedAt = Date.now()
    if (this.storageBridge) {
      try {
        await this.storageBridge.set(STORAGE_KEY, this.inMemoryState)
      } catch (err) {
        // Log or keep in memory
      }
    }
  }

  getState(): MomAiCodeStorageState {
    return this.inMemoryState
  }
}

module.exports = {
  STORAGE_KEY,
  PENDING_REQUEST_TTL_MS,
  SINGLE_USE_GRANT_TTL_MS,
  MAX_ACTIVE_PROJECT_THREADS,
  DEFAULT_PRESET_RULES,
  DEFAULT_SETTINGS,
  createDefaultState,
  cleanupExpiredState,
  migrateStoredState,
  CodeStateManager
}
