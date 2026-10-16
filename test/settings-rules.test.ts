import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { executeCodeSettings } = require('../routes/settings.ts')
const { createDefaultState } = require('../core/storage.ts')

function stateManagerWith(state: any) {
  return {
    load: async () => state,
    save: async () => {}
  }
}

describe('terminal rule actions in the settings route', () => {
  it('adds rules defaulting to ask', async () => {
    const state = createDefaultState()
    const res = await executeCodeSettings(
      { action: 'add_rule', pattern: 'curl *' },
      stateManagerWith(state)
    )
    expect(res.ok).toBe(true)
    expect(res.rule.action).toBe('ask')
    expect(state.terminalRules.at(-1)).toMatchObject({ pattern: 'curl *', action: 'ask' })
  })

  it('accepts allow, ask and block when adding', async () => {
    const state = createDefaultState()
    const manager = stateManagerWith(state)
    const allow = await executeCodeSettings(
      { action: 'add_rule', pattern: 'a*', ruleAction: 'allow' },
      manager
    )
    const block = await executeCodeSettings(
      { action: 'add_rule', pattern: 'b*', ruleAction: 'block' },
      manager
    )
    expect(allow.rule.action).toBe('allow')
    expect(block.rule.action).toBe('block')
  })

  it('updates the action of an existing rule and rejects invalid values', async () => {
    const state = createDefaultState()
    const manager = stateManagerWith(state)
    const added = await executeCodeSettings(
      { action: 'add_rule', pattern: 'c*', ruleAction: 'allow' },
      manager
    )

    const toAsk = await executeCodeSettings(
      { action: 'update_rule', id: added.rule.id, ruleAction: 'ask' },
      manager
    )
    expect(toAsk.ok).toBe(true)
    expect(toAsk.rule.action).toBe('ask')
    expect(state.terminalRules.find((r: any) => r.id === added.rule.id).action).toBe('ask')

    const toBlock = await executeCodeSettings(
      { action: 'update_rule', id: added.rule.id, ruleAction: 'block' },
      manager
    )
    expect(toBlock.rule.action).toBe('block')

    const invalid = await executeCodeSettings(
      { action: 'update_rule', id: added.rule.id, ruleAction: 'maybe' },
      manager
    )
    expect(invalid.ok).toBe(false)

    const missing = await executeCodeSettings(
      { action: 'update_rule', id: 'rule_missing', ruleAction: 'ask' },
      manager
    )
    expect(missing.ok).toBe(false)
  })
})
