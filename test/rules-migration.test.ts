import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createDefaultState, migrateStoredState, DEFAULT_PRESET_RULES } = require('../core/storage.ts')

describe('stored state migration', () => {
  it('ships no delete presets (the engine baseline asks for any delete form)', () => {
    expect(DEFAULT_PRESET_RULES.some((rule: any) => String(rule.id).startsWith('rule_del_'))).toBe(false)
  })

  it('ships the disk presets as hard blocks and the rest as ask', () => {
    for (const rule of DEFAULT_PRESET_RULES as any[]) {
      if (rule.group === 'disk') expect(rule.action).toBe('block')
      else expect(rule.action).toBe('ask')
    }
  })

  it('turns legacy v1 `block` rules into `ask` for user rules', () => {
    const migrated = migrateStoredState({
      version: 1,
      terminalRules: [
        { id: 'rule_usr_1', pattern: 'git push*', action: 'block', enabled: true, group: 'custom', source: 'user' }
      ]
    })
    expect(migrated.version).toBe(4)
    const userRule = migrated.terminalRules.find((rule: any) => rule.id === 'rule_usr_1')
    expect(userRule).toMatchObject({ id: 'rule_usr_1', action: 'ask' })
  })

  it('drops legacy delete presets and syncs the curated set', () => {
    const migrated = migrateStoredState({
      version: 2,
      terminalRules: [
        { id: 'rule_del_1', pattern: 'rm -rf*', action: 'ask', enabled: true, group: 'delete', source: 'preset' },
        { id: 'rule_disk_1', pattern: 'format ?:*', action: 'ask', enabled: false, group: 'disk', source: 'preset' },
        { id: 'rule_git_1', pattern: 'git reset --hard*', action: 'ask', enabled: true, group: 'git', source: 'preset' },
        { id: 'rule_usr_hard', pattern: 'format *', action: 'block', enabled: true, group: 'custom', source: 'user' }
      ]
    })

    const byId = new Map(migrated.terminalRules.map((rule: any) => [rule.id, rule]))
    // Legacy delete presets are gone (the engine baseline covers them).
    expect(byId.has('rule_del_1')).toBe(false)
    // Presets follow the table: patterns and actions update...
    expect(byId.get('rule_git_1')).toMatchObject({ pattern: 'git reset*', action: 'ask' })
    // ...keeping the user's enable/disable toggles.
    expect(byId.get('rule_disk_1')).toMatchObject({ action: 'block', enabled: false })
    // New protections arrive.
    expect(byId.get('rule_git_11')).toMatchObject({ pattern: 'git push*', action: 'ask' })
    expect(byId.get('rule_disk_5')).toMatchObject({ action: 'block' })
    // Custom rules keep their explicit action.
    expect(byId.get('rule_usr_hard')).toMatchObject({ action: 'block' })
  })

  it('keeps a deliberately cleared preset list cleared', () => {
    const migrated = migrateStoredState({
      version: 3,
      terminalRules: [
        { id: 'rule_usr_only', pattern: 'x*', action: 'allow', enabled: true, group: 'custom', source: 'user' }
      ]
    })
    expect(migrated.terminalRules.map((rule: any) => rule.id)).toEqual(['rule_usr_only'])
  })

  it('keeps a v4 state untouched', () => {
    const current = {
      ...createDefaultState(),
      terminalRules: [
        { id: 'rule_usr_hard', pattern: 'format *', action: 'block', enabled: true, group: 'custom', source: 'user' }
      ]
    }
    const migrated = migrateStoredState(current)
    expect(migrated.terminalRules).toEqual(current.terminalRules)
  })

  it('fills missing fields from the defaults', () => {
    const migrated = migrateStoredState({ version: 1, terminalRules: [] })
    expect(migrated.terminalRules).toEqual([])
    expect(migrated.projects).toEqual([])
    expect(migrated.settings.shell).toBe('powershell')
  })
})
