import React, { useState, useEffect, useCallback } from 'react'
import { getSDK } from 'momai:sdk'
import { useI18n } from './hooks/useI18n.ts'

const EXTENSION_ID = 'momai-code'

/**
 * Host API base URL, resolved from the same bridge the host SDK uses.
 * Falls back to a relative path so the web build (served by the backend)
 * keeps working when `window.api` is unavailable.
 */
function getApiBase(): string {
  if (typeof window !== 'undefined') {
    const api = (window as any).api || (window as any).momaiAPI
    const fromHost = api?.getApiBaseUrl?.()
    if (fromHost) return String(fromHost).replace(/\/+$/, '')
  }
  return ''
}

/** Packaged `app_icon` artwork served by the host (public extension asset route). */
const APP_ICON_URL = `${getApiBase()}/extensions/${EXTENSION_ID}/asset/app.png`

/** Rotating usage tips shown under the hero title. */
const TIP_KEYS = [
  'overview.tip1',
  'overview.tip2',
  'overview.tip3',
  'overview.tip4',
  'overview.tip5',
  'overview.tip6',
  'overview.tip7',
  'overview.tip8',
  'overview.tip9',
  'overview.tip10'
] as const
const TIP_INTERVAL_MS = 7000

/** Fisher-Yates shuffle so the first tip and every following one are random. */
function shuffledTipKeys(): string[] {
  const keys: string[] = [...TIP_KEYS]
  for (let i = keys.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[keys[i], keys[j]] = [keys[j], keys[i]]
  }
  return keys
}

interface Project {
  id: string
  name: string
  path: string
  addedBy: 'page' | 'chat'
  lastUsedAt?: string
}

type TerminalRuleAction = 'allow' | 'ask' | 'block'

interface TerminalRule {
  id: string
  pattern: string
  action: TerminalRuleAction
  enabled: boolean
  group?: string
  source?: string
}

interface CodeSettings {
  shell: 'auto' | 'powershell' | 'cmd'
  defaultTimeoutMs: number
  strictMode: boolean
}

/** "Allow always" decisions are stored by the app, keyed by tool + scope. */
interface HostGrant {
  extensionId: string
  tool: string
  ruleId: string | null
  createdAt: string
}

export default function MomAiCodePage() {
  const { t } = useI18n()
  const [view, setView] = useState<'main' | 'rules' | 'projects' | 'environment'>('main')
  const [loading, setLoading] = useState(true)
  const [homePath, setHomePath] = useState('')
  const [projects, setProjects] = useState<Project[]>([])
  const [terminalRules, setTerminalRules] = useState<TerminalRule[]>([])
  const [grants, setGrants] = useState<HostGrant[]>([])
  const [settings, setSettings] = useState<CodeSettings>({
    shell: 'powershell',
    defaultTimeoutMs: 30000,
    strictMode: false
  })

  // Project state
  const [projectError, setProjectError] = useState<string | null>(null)
  const [isSubmittingProj, setIsSubmittingProj] = useState(false)
  const [showManualInput, setShowManualInput] = useState(false)
  const [manualPath, setManualPath] = useState('')

  // Add Rule Form State
  const [newRulePattern, setNewRulePattern] = useState('')
  const [newRuleAction, setNewRuleAction] = useState<TerminalRuleAction>('ask')

  // Feedback State
  const [statusMsg, setStatusMsg] = useState<string | null>(null)

  // Hero tips rotation (random order, random first tip)
  const [tipOrder] = useState<string[]>(shuffledTipKeys)
  const [tipIndex, setTipIndex] = useState(0)

  // Hero artwork fallback when app.png is missing
  const [appIconFailed, setAppIconFailed] = useState(false)

  const showStatus = (msg: string) => {
    setStatusMsg(msg)
    setTimeout(() => setStatusMsg(null), 3000)
  }

  useEffect(() => {
    const id = setInterval(() => setTipIndex((i) => (i + 1) % tipOrder.length), TIP_INTERVAL_MS)
    return () => clearInterval(id)
  }, [tipOrder])

  const loadData = useCallback(async () => {
    try {
      const sdk = getSDK()
      const res = await sdk.api.post('/extensions/momai-code/settings', { action: 'get' })
      if (res.ok && res.data) {
        setHomePath(res.data.home?.path || '')
        setProjects(res.data.projects || [])
        setTerminalRules(res.data.terminalRules || [])
        if (res.data.settings) setSettings(res.data.settings)
      }
    } catch {
      // Best effort load
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  // "Allow always" grants live in the host permission store; list the ones
  // that belong to this extension so the user can see and revoke them.
  const loadGrants = useCallback(async (bustCache = false) => {
    try {
      const sdk = getSDK()
      const res = await sdk.api.get<{ grants: HostGrant[] }>(
        '/chat/tool-permissions',
        bustCache ? { _: Date.now() } : undefined
      )
      if (res.ok) {
        const all = Array.isArray(res.data?.grants) ? res.data.grants : []
        setGrants(all.filter((grant) => grant?.extensionId === 'momai-code'))
      }
    } catch {
      // Best effort: the rules list still works without the host grants.
    }
  }, [])

  useEffect(() => {
    loadGrants()
  }, [loadGrants])

  useEffect(() => {
    if (view === 'rules') loadGrants(true)
  }, [view, loadGrants])

  const grantScopeLabel = (grant: HostGrant): string => {
    const ruleId = grant.ruleId || ''
    if (ruleId.startsWith('delete:')) return t('grants.scopeDelete')
    if (ruleId === 'read:env') return t('grants.scopeEnv')
    if (ruleId === 'remote-exec') return t('grants.scopeRemote')
    const rule = terminalRules.find((candidate) => candidate.id === ruleId)
    if (rule) return `${t('grants.scopeRule')} '${rule.pattern}'`
    return t('grants.scopeTool')
  }

  const handleRevokeGrant = async (grant: HostGrant) => {
    try {
      const sdk = getSDK()
      const params = new URLSearchParams({ extension_id: grant.extensionId, tool: grant.tool })
      if (grant.ruleId) params.set('rule_id', grant.ruleId)
      const res = await sdk.api.delete(`/chat/tool-permissions?${params.toString()}`)
      if (res.ok) {
        showStatus(t('grants.revoked'))
        await loadGrants(true)
      }
    } catch {
      // Best effort
    }
  }

  // Open native file explorer dialog (uses SDK dialog when available, falls back to extension backend)
  const handleOpenFolderPicker = async () => {
    setIsSubmittingProj(true)
    setProjectError(null)

    try {
      const sdk = getSDK()
      let chosenPath: string | null = null

      if (sdk.dialog?.selectDirectory) {
        try {
          const picked = await sdk.dialog.selectDirectory({
            title: t('projects.dialogTitle')
          })
          if (picked && !picked.canceled && picked.path) {
            chosenPath = picked.path
          }
        } catch {
          // Fall through to backend picker
        }
      }

      if (chosenPath) {
        const res = await sdk.api.post('/extensions/momai-code/settings', {
          action: 'add_project',
          path: chosenPath
        })

        if (res.ok) {
          showStatus(res.data?.message || t('projects.added'))
          await loadData()
        } else {
          setProjectError(res.error || t('projects.errPick'))
        }
        return
      }

      // Seamless fallback: extension backend opens modern Windows IFileOpenDialog
      const res = await sdk.api.post('/extensions/momai-code/settings', {
        action: 'pick_project'
      })

      if (res.ok) {
        if (res.data?.canceled) {
          return
        }
        showStatus(res.data?.message || t('projects.added'))
        await loadData()
      } else {
        setProjectError(res.error || t('projects.errPick'))
      }
    } catch (err: any) {
      setProjectError(err?.message || t('common.commError'))
    } finally {
      setIsSubmittingProj(false)
    }
  }

  // Handle manual path submission
  const handleAddManualProject = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!manualPath.trim()) return

    setIsSubmittingProj(true)
    setProjectError(null)

    try {
      const sdk = getSDK()
      const res = await sdk.api.post('/extensions/momai-code/settings', {
        action: 'add_project',
        path: manualPath.trim()
      })

      if (res.ok) {
        setManualPath('')
        setShowManualInput(false)
        showStatus(res.data?.message || t('projects.added'))
        await loadData()
      } else {
        setProjectError(res.error || t('projects.errAdd'))
      }
    } catch (err: any) {
      setProjectError(err?.message || t('common.commError'))
    } finally {
      setIsSubmittingProj(false)
    }
  }

  // Remove project
  const handleRemoveProject = async (id: string) => {
    try {
      const sdk = getSDK()
      const res = await sdk.api.post('/extensions/momai-code/settings', {
        action: 'remove_project',
        id
      })
      if (res.ok) {
        showStatus(res.data?.message || t('projects.removed'))
        await loadData()
      }
    } catch {}
  }

  // Toggle rule
  const handleToggleRule = async (id: string) => {
    try {
      const sdk = getSDK()
      const res = await sdk.api.post('/extensions/momai-code/settings', {
        action: 'toggle_rule',
        id
      })
      if (res.ok) {
        setTerminalRules((prev) =>
          prev.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r))
        )
      }
    } catch {}
  }

  const RULE_ACTION_CYCLE: TerminalRuleAction[] = ['ask', 'allow', 'block']

  // Cycle the rule action in place: Perguntar -> Permitir -> Bloquear -> Perguntar
  const handleCycleRuleAction = async (rule: TerminalRule) => {
    const next = RULE_ACTION_CYCLE[(RULE_ACTION_CYCLE.indexOf(rule.action) + 1) % RULE_ACTION_CYCLE.length]
    try {
      const sdk = getSDK()
      const res = await sdk.api.post('/extensions/momai-code/settings', {
        action: 'update_rule',
        id: rule.id,
        ruleAction: next
      })
      if (res.ok) {
        setTerminalRules((prev) =>
          prev.map((r) => (r.id === rule.id ? { ...r, action: next } : r))
        )
      }
    } catch {}
  }

  // Add Rule
  const handleAddRule = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newRulePattern.trim()) return

    try {
      const sdk = getSDK()
      const res = await sdk.api.post('/extensions/momai-code/settings', {
        action: 'add_rule',
        pattern: newRulePattern.trim(),
        ruleAction: newRuleAction
      })
      if (res.ok) {
        setNewRulePattern('')
        showStatus(t('rules.added'))
        await loadData()
      }
    } catch {}
  }

  // Remove rule
  const handleRemoveRule = async (id: string) => {
    try {
      const sdk = getSDK()
      const res = await sdk.api.post('/extensions/momai-code/settings', {
        action: 'remove_rule',
        id
      })
      if (res.ok) {
        await loadData()
      }
    } catch {}
  }

  // Reorder rule up/down
  const handleMoveRule = async (index: number, direction: 'up' | 'down') => {
    const targetIndex = direction === 'up' ? index - 1 : index + 1
    if (targetIndex < 0 || targetIndex >= terminalRules.length) return

    const updated = [...terminalRules]
    const temp = updated[index]
    updated[index] = updated[targetIndex]
    updated[targetIndex] = temp

    setTerminalRules(updated)
    try {
      const sdk = getSDK()
      await sdk.api.post('/extensions/momai-code/settings', {
        action: 'reorder_rules',
        rules: updated
      })
    } catch {}
  }

  // Restore presets
  const handleRestorePresets = async () => {
    try {
      const sdk = getSDK()
      const res = await sdk.api.post('/extensions/momai-code/settings', {
        action: 'restore_presets'
      })
      if (res.ok) {
        showStatus(t('rules.presetsRestored'))
        await loadData()
      }
    } catch {}
  }

  // Save settings
  const handleSaveSettings = async () => {
    try {
      const sdk = getSDK()
      const res = await sdk.api.post('/extensions/momai-code/settings', {
        action: 'update_settings',
        shell: settings.shell,
        defaultTimeoutMs: settings.defaultTimeoutMs
      })
      if (res.ok) {
        showStatus(t('settings.saved'))
      }
    } catch {}
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center p-6 text-text-muted text-sm">
        {t('app.loading')}
      </div>
    )
  }

  // Dedicated view: Work Projects
  if (view === 'projects') {
    return (
      <div className="h-full overflow-y-auto bg-bg text-text p-6 md:p-8">
        <div className="max-w-2xl mx-auto space-y-6">
          {/* Header & actions */}
          <div className="flex items-center justify-between gap-4 border-b border-border/40 pb-6">
            <button
              onClick={() => setView('main')}
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-text bg-input hover:bg-input/80 border border-border transition-colors flex items-center gap-1.5"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m15 18-6-6 6-6" />
              </svg>
              {t('common.back')}
            </button>

            <button
              onClick={handleOpenFolderPicker}
              disabled={isSubmittingProj}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-input hover:bg-input/80 border border-border text-text transition-colors disabled:opacity-50"
            >
              {isSubmittingProj ? t('projects.adding') : t('projects.addBtn')}
            </button>
          </div>

          <div>
            <h1 className="text-xl font-bold tracking-tight text-text">{t('projects.title')}</h1>
            <p className="text-xs text-text-muted mt-1">{t('projects.subtitle')}</p>
          </div>

          {statusMsg && (
            <div className="p-3 rounded-lg bg-input border border-border text-text text-xs font-medium">
              {statusMsg}
            </div>
          )}

          <div className="flex justify-center">
            <button
              type="button"
              onClick={() => setShowManualInput(!showManualInput)}
              className="text-xs text-text-muted hover:text-text transition-colors underline"
            >
              {showManualInput ? t('projects.manualHide') : t('projects.manualShow')}
            </button>
          </div>

          {/* Optional manual path input */}
          {showManualInput && (
            <form onSubmit={handleAddManualProject} className="border border-border/60 rounded-lg p-3 flex gap-2">
              <input
                type="text"
                value={manualPath}
                onChange={(e) => setManualPath(e.target.value)}
                placeholder={t('projects.manualPlaceholder')}
                className="flex-1 px-3 py-1.5 rounded-lg bg-input border border-border text-xs font-mono text-text placeholder:text-text-muted focus:outline-none"
              />
              <button
                type="submit"
                disabled={isSubmittingProj || !manualPath.trim()}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-input hover:bg-input/80 border border-border text-text transition-colors disabled:opacity-40 shrink-0"
              >
                {t('projects.addManual')}
              </button>
            </form>
          )}

          {projectError && (
            <div className="p-3 rounded-lg bg-input/40 border border-border/60 text-xs text-text flex items-center justify-between gap-2">
              <span>{projectError}</span>
              <button
                onClick={() => setProjectError(null)}
                className="text-text-muted hover:text-text text-xs p-1"
              >
                ✕
              </button>
            </div>
          )}

          <div className="border border-border/50 rounded-lg overflow-hidden divide-y divide-border">
            {/* Pinned Home Root */}
            <div className="p-4 flex items-start justify-between gap-3">
              <div className="flex items-start gap-3 min-w-0">
                <svg className="w-4 h-4 text-text-muted shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  <polyline points="9 22 9 12 15 12 15 22" />
                </svg>
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="font-semibold text-sm text-text">{t('projects.home')}</span>
                    <span className="text-xs text-text-muted">{t('projects.defaultTag')}</span>
                  </div>
                  <p className="text-xs font-mono text-text-muted mt-1 truncate">{homePath || '...'}</p>
                  <p className="text-xs text-text-muted mt-1">{t('projects.homeDesc')}</p>
                </div>
              </div>
            </div>

            {/* Configured Projects List */}
            {projects.length === 0 ? (
              <div className="p-4 text-xs text-text-muted italic">
                {t('projects.empty')}
              </div>
            ) : (
              projects.map((proj) => (
                <div
                  key={proj.id}
                  className="p-4 flex items-center justify-between gap-3 hover:bg-input/20 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <svg className="w-4 h-4 text-text-muted shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
                    </svg>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="font-semibold text-sm text-text truncate">{proj.name}</span>
                        <span className="text-xs text-text-muted shrink-0">
                          {proj.addedBy === 'chat' ? t('projects.viaChat') : t('projects.viaPage')}
                        </span>
                      </div>
                      <p className="text-xs font-mono text-text-muted truncate mt-0.5">{proj.path}</p>
                      {proj.lastUsedAt && (
                        <p className="text-xs text-text-muted mt-0.5">
                          {t('projects.lastUsed')}: {new Date(proj.lastUsedAt).toLocaleDateString()}
                        </p>
                      )}
                    </div>
                  </div>

                  <button
                    onClick={() => handleRemoveProject(proj.id)}
                    className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-text-muted hover:text-error hover:bg-input/60 transition-colors shrink-0"
                  >
                    {t('projects.remove')}
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    )
  }

  // Dedicated view: Execution environment
  if (view === 'environment') {
    return (
      <div className="h-full overflow-y-auto bg-bg text-text p-6 md:p-8">
        <div className="max-w-2xl mx-auto space-y-6">
          {/* Header & actions */}
          <div className="flex items-center justify-between gap-4 border-b border-border/40 pb-6">
            <button
              onClick={() => setView('main')}
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-text bg-input hover:bg-input/80 border border-border transition-colors flex items-center gap-1.5"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m15 18-6-6 6-6" />
              </svg>
              {t('common.back')}
            </button>

            <button
              onClick={handleSaveSettings}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-input hover:bg-input/80 border border-border text-text transition-colors"
            >
              {t('settings.save')}
            </button>
          </div>

          <div>
            <h1 className="text-xl font-bold tracking-tight text-text">{t('settings.title')}</h1>
            <p className="text-xs text-text-muted mt-1">{t('settings.subtitle')}</p>
          </div>

          {statusMsg && (
            <div className="p-3 rounded-lg bg-input border border-border text-text text-xs font-medium">
              {statusMsg}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1.5">
                {t('settings.shell')}
              </label>
              <select
                value={settings.shell}
                onChange={(e) => setSettings({ ...settings, shell: e.target.value as any })}
                className="w-full px-3 py-2 rounded-lg bg-input border border-border text-xs text-text focus:outline-none"
              >
                <option value="powershell">{t('settings.shellPowershell')}</option>
                <option value="cmd">{t('settings.shellCmd')}</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-text-muted mb-1.5">
                {t('settings.timeout')}
              </label>
              <input
                type="number"
                min={5}
                max={300}
                value={Math.round(settings.defaultTimeoutMs / 1000)}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    defaultTimeoutMs: Math.max(5000, Number(e.target.value) * 1000)
                  })
                }
                className="w-full px-3 py-2 rounded-lg bg-input border border-border text-xs text-text focus:outline-none"
              />
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Dedicated view: Terminal Rules only
  if (view === 'rules') {
    return (
      <div className="h-full overflow-y-auto bg-bg text-text p-6 md:p-8">
        <div className="max-w-2xl mx-auto space-y-6">
          {/* Header & Back navigation */}
          <div className="flex items-center justify-between gap-4 border-b border-border/40 pb-6">
            <button
              onClick={() => setView('main')}
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-text bg-input hover:bg-input/80 border border-border transition-colors flex items-center gap-1.5"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m15 18-6-6 6-6" />
              </svg>
              {t('common.back')}
            </button>

            <button
              onClick={handleRestorePresets}
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-text-muted hover:text-text bg-input/40 hover:bg-input border border-border/60 transition-colors"
            >
              {t('rules.restorePresets')}
            </button>
          </div>

          <div>
            <h1 className="text-xl font-bold tracking-tight text-text">{t('rules.manageTitle')}</h1>
            <p className="text-xs text-text-muted mt-1">{t('rules.subtitle')}</p>
            <p className="text-xs text-text-muted/80 mt-1.5 leading-relaxed">
              {t('rules.baselineNote')}
            </p>
          </div>

          {statusMsg && (
            <div className="p-3 rounded-lg bg-input border border-border text-text text-xs font-medium">
              {statusMsg}
            </div>
          )}

          {/* Add Rule Toolbar */}
          <form onSubmit={handleAddRule} className="border border-border/60 rounded-xl p-3 bg-card/40 flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={newRulePattern}
              onChange={(e) => setNewRulePattern(e.target.value)}
              placeholder={t('rules.patternPlaceholder')}
              className="flex-1 px-3 py-2 rounded-lg bg-input border border-border text-xs font-mono text-text placeholder:text-text-muted focus:outline-none"
            />
            <select
              value={newRuleAction}
              onChange={(e) => setNewRuleAction(e.target.value as TerminalRuleAction)}
              className="px-3 py-2 rounded-lg bg-input border border-border text-xs text-text focus:outline-none"
            >
              <option value="allow">{t('rules.allowAction')}</option>
              <option value="ask">{t('rules.askAction')}</option>
              <option value="block">{t('rules.blockAction')}</option>
            </select>
            <button
              type="submit"
              disabled={!newRulePattern.trim()}
              className="px-4 py-2 rounded-lg text-xs font-semibold bg-input hover:bg-input/80 border border-border text-text disabled:opacity-40 transition-colors shrink-0"
            >
              {t('rules.addRule')}
            </button>
          </form>

          {/* Rules Ordered List */}
          <div className="border border-border/60 rounded-xl overflow-hidden bg-card/40 divide-y divide-border">
            {terminalRules.length === 0 ? (
              <div className="p-8 text-center text-xs text-text-muted">
                {t('rules.empty')}
              </div>
            ) : (
              terminalRules.map((rule, idx) => (
                <div
                  key={rule.id}
                  className={`p-3.5 flex items-center justify-between gap-3 transition-colors ${
                    rule.enabled ? 'hover:bg-input/20' : 'opacity-50 hover:bg-input/20'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <span className="text-xs font-mono text-text-muted w-6 shrink-0">
                      #{idx + 1}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleCycleRuleAction(rule)}
                      title={t('rules.cycleAction')}
                      className={`text-xs uppercase font-bold px-2 py-0.5 rounded border transition-colors ${
                        rule.action === 'block'
                          ? 'bg-input text-error border-border hover:bg-input/80'
                          : rule.action === 'ask'
                            ? 'bg-input text-warning border-border hover:bg-input/80'
                            : 'bg-input text-dev border-border hover:bg-input/80'
                      }`}
                    >
                      {rule.action === 'block'
                        ? t('rules.blockAction')
                        : rule.action === 'ask'
                          ? t('rules.askAction')
                          : t('rules.allowAction')}
                    </button>
                    <span className="font-mono text-xs text-text truncate">
                      {rule.pattern}
                    </span>
                    {rule.source === 'learned' && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-input/60 text-text-muted border border-border/40 shrink-0">
                        {t('rules.learned')}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => handleToggleRule(rule.id)}
                      className="px-2.5 py-1 rounded-md text-xs font-medium text-text bg-input/60 hover:bg-input border border-border/60 transition-colors"
                    >
                      {rule.enabled ? t('rules.enabled') : t('rules.disabled')}
                    </button>
                    <button
                      onClick={() => handleMoveRule(idx, 'up')}
                      disabled={idx === 0}
                      className="p-1.5 rounded-md text-xs text-text hover:bg-input disabled:opacity-20 transition-colors"
                      title={t('rules.moveUp')}
                    >
                      ▲
                    </button>
                    <button
                      onClick={() => handleMoveRule(idx, 'down')}
                      disabled={idx === terminalRules.length - 1}
                      className="p-1.5 rounded-md text-xs text-text hover:bg-input disabled:opacity-20 transition-colors"
                      title={t('rules.moveDown')}
                    >
                      ▼
                    </button>
                    <button
                      onClick={() => handleRemoveRule(rule.id)}
                      className="p-1.5 rounded-md text-xs text-text-muted hover:text-error hover:bg-input transition-colors"
                      title={t('rules.remove')}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Host grants ("Permitir sempre" decisions live in the app, not here) */}
          <div className="border border-border/60 rounded-xl bg-card/40 overflow-hidden">
            <div className="p-3.5 border-b border-border/60">
              <h3 className="text-sm font-semibold text-text">{t('grants.title')}</h3>
              <p className="text-xs text-text-muted mt-1 leading-relaxed">{t('grants.desc')}</p>
            </div>
            {grants.length === 0 ? (
              <div className="p-6 text-center text-xs text-text-muted">{t('grants.empty')}</div>
            ) : (
              <div className="divide-y divide-border">
                {grants.map((grant) => (
                  <div
                    key={`${grant.tool}:${grant.ruleId ?? '*'}`}
                    className="p-3.5 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <p className="font-mono text-xs text-text truncate">{grant.tool}</p>
                      <p className="text-xs text-text-muted truncate">
                        {grantScopeLabel(grant)}
                      </p>
                    </div>
                    <button
                      onClick={() => handleRevokeGrant(grant)}
                      className="px-2.5 py-1 rounded-md text-xs font-medium text-text-muted hover:text-error bg-input/60 hover:bg-input border border-border/60 transition-colors shrink-0"
                    >
                      {t('grants.revoke')}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // Main view: hero intro, then configuration sections
  const activeRulesCount = terminalRules.filter((r) => r.enabled).length
  const askedRulesCount = terminalRules.filter((r) => r.enabled && r.action === 'ask').length
  const blockedRulesCount = terminalRules.filter((r) => r.enabled && r.action === 'block').length

  return (
    <div className="h-full overflow-y-auto bg-bg text-text p-6 md:p-8">
      <div className="max-w-2xl mx-auto flex flex-col gap-10">
        {/* Hero: extension identity */}
        <header className="flex flex-col items-center text-center pt-6 pb-2">
          {!appIconFailed ? (
            <img
              src={APP_ICON_URL}
              alt={t('app.title')}
              draggable={false}
              onError={() => setAppIconFailed(true)}
              className="w-16 h-16 rounded-xl object-cover border border-border/60 select-none"
            />
          ) : (
            <div className="w-16 h-16 rounded-xl bg-card border border-border/60 flex items-center justify-center text-text-muted">
              <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="16 18 22 12 16 6" />
                <polyline points="8 6 2 12 8 18" />
              </svg>
            </div>
          )}

          <h1 className="mt-4 font-mono text-3xl font-bold tracking-tight text-text">
            {t('app.title')}
            <span className="text-text-muted/60 select-none" aria-hidden="true">_</span>
          </h1>
          <p
            key={tipIndex}
            className="text-sm text-text-muted mt-3 max-w-xl leading-relaxed min-h-10 animate-slide-in-up"
          >
            {t(tipOrder[tipIndex])}
          </p>
        </header>

        {statusMsg && (
          <div className="p-3 rounded-lg bg-input border border-border text-text text-xs font-medium text-center">
            {statusMsg}
          </div>
        )}

        {/* Sections */}
        <div className="flex flex-col gap-10">
          {/* Projects entrance */}
          <section className="mt-2">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-text">{t('projects.title')}</h3>
                <p className="text-xs text-text-muted mt-1">
                  {projects.length} {t('projects.activeProjects')}. {t('projects.subtitle')}
                </p>
              </div>
              <button
                onClick={() => setView('projects')}
                className="w-40 px-4 py-2 rounded-lg text-xs font-semibold bg-input hover:bg-input/80 border border-border text-text transition-colors inline-flex items-center justify-center whitespace-nowrap shrink-0"
              >
                {t('projects.openBtn')}
              </button>
            </div>
          </section>

          {/* Terminal rules */}
          <section className="mt-2">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-text">{t('rules.title')}</h3>
                <p className="text-xs text-text-muted mt-1">
                  {activeRulesCount} {t('rules.activeRules')} ({askedRulesCount}{' '}
                  {t('rules.askedRules')}, {blockedRulesCount} {t('rules.blockedRules')}).{' '}
                  {t('rules.summaryDesc')}
                </p>
              </div>
              <button
                onClick={() => setView('rules')}
                className="w-40 px-4 py-2 rounded-lg text-xs font-semibold bg-input hover:bg-input/80 border border-border text-text transition-colors inline-flex items-center justify-center whitespace-nowrap shrink-0"
              >
                {t('rules.openBtn')}
              </button>
            </div>
          </section>

          {/* Execution environment */}
          <section className="mt-2">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-text">{t('settings.title')}</h3>
                <p className="text-xs text-text-muted mt-1">
                  {settings.shell === 'cmd' ? 'CMD' : 'PowerShell'} ·{' '}
                  {Math.round(settings.defaultTimeoutMs / 1000)}s. {t('settings.subtitle')}
                </p>
              </div>
              <button
                onClick={() => setView('environment')}
                className="w-40 px-4 py-2 rounded-lg text-xs font-semibold bg-input hover:bg-input/80 border border-border text-text transition-colors inline-flex items-center justify-center whitespace-nowrap shrink-0"
              >
                {t('settings.openBtn')}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
