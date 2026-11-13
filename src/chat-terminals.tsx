import React, { useCallback, useEffect, useRef, useState } from 'react'
import sdkDefault from 'momai:sdk'
import { useI18n } from './hooks/useI18n.ts'

export interface TerminalProcess {
  id: string
  pid: number
  command: string
  cwd: string
  status: string
  runningSeconds?: number
  exitCode?: number | null
  outputFile: string
}

export interface ChatTerminalsProps {
  threadId?: string
  /** Supplied by the host: the extension that registered this element. */
  extensionId?: string
  sdk?: any
  initialProcesses?: TerminalProcess[]
}

const POLL_MS = 5000

function formatElapsed(seconds?: number): string {
  if (!seconds || seconds < 0) return ''
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}m ${rest}s`
}

/**
 * Terminals running in the background, shown right above the composer.
 *
 * The badge only shows while something runs: with an empty list and the
 * panel closed it renders nothing instead of lingering on zero.
 *
 * The list comes from the same `code_process` tool the agent uses, so stopping a
 * process here is exactly what the agent would do: kill the whole tree. The
 * extension id and the API client come from the host, never from a literal.
 */
export default function ChatTerminals({
  threadId = 'default',
  extensionId,
  sdk,
  initialProcesses
}: ChatTerminalsProps) {
  const { t } = useI18n()
  const [processes, setProcesses] = useState<TerminalProcess[]>(initialProcesses ?? [])
  const [isOpen, setIsOpen] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const client = sdk ?? sdkDefault
  const route = extensionId ? `/extensions/${extensionId}/processes` : null

  const call = useCallback(
    async (payload: Record<string, any>) => {
      if (!route) return null
      const res = await client.api.post(route, { ...payload, threadId })
      return (res as any)?.data ?? res
    },
    [client, route, threadId]
  )

  const load = useCallback(async () => {
    if (typeof document !== 'undefined' && document.hidden) return
    try {
      const data = await call({ action: 'list' })
      const list = Array.isArray(data?.processes) ? data.processes : []
      const running = list.filter((entry: TerminalProcess) => entry.status === 'running')
      setProcesses(running)
      if (running.length === 0) {
        setIsOpen(false)
      }
    } catch {
      // The panel must never break the chat when the worker is restarting.
    }
  }, [call])

  useEffect(() => {
    load()
  }, [load])

  // Switching threads must never flash the previous thread's list: drop what
  // is shown and close the panel, then the reload above fetches this thread.
  useEffect(() => {
    setProcesses([])
    setIsOpen(false)
  }, [threadId])

  useEffect(() => {
    const timer = setInterval(load, POLL_MS)
    return () => clearInterval(timer)
  }, [load])

  useEffect(() => {
    if (!isOpen) return
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  const handleStop = async (id: string) => {
    setBusyId(id)
    try {
      await call({ action: 'stop', id })
      setProcesses((prev) => {
        const remaining = prev.filter((p) => p.id !== id)
        if (remaining.length === 0) {
          setIsOpen(false)
        }
        return remaining
      })
      await load()
    } catch {
      // Keep the row visible so the user can try again.
    } finally {
      setBusyId(null)
    }
  }

  if (!route) return null

  const count = processes.length

  // No background work and the panel closed: stay hidden instead of showing
  // a zero badge. An open panel keeps rendering so the user sees the empty
  // state until they close it.
  if (count === 0 && !isOpen) return null

  const countLabel = t(count === 1 ? 'terminals.shells.one' : 'terminals.shells.other', { count })

  return (
    <div ref={dropdownRef} className="relative inline-flex items-center text-xs select-none">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="group flex items-center gap-1.5 bg-transparent hover:bg-input/60 active:bg-input rounded-md px-1.5 py-1 text-xs text-text transition-colors cursor-pointer focus:outline-none border-none"
        title={t('terminals.title')}
        aria-label={t('terminals.title')}
        aria-expanded={isOpen}
      >
        <div
          className={`w-4 h-4 rounded flex items-center justify-center border shrink-0 transition-colors ${
            count > 0
              ? `bg-accent/10 border-accent/40 text-accent ${isOpen ? '' : 'animate-pulse motion-reduce:animate-none'}`
              : 'bg-input/60 border-border/40 text-text-muted'
          }`}
        >
          <svg
            className="w-2.5 h-2.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
        </div>

        <span className="font-medium text-text">{countLabel}</span>
      </button>

      {isOpen && (
        <div className="absolute bottom-full mb-1 left-0 w-[300px] max-h-[320px] overflow-y-auto bg-card border border-border/60 rounded shadow-xl z-50 text-xs flex flex-col custom-scrollbar">
          <div className="px-3 py-2 border-b border-border/30 text-text-muted font-semibold">
            {t('terminals.title')}
          </div>

          {count === 0 && (
            <div className="px-3 py-3 text-text-muted">{t('terminals.empty')}</div>
          )}

          {processes.map((entry) => {
            const elapsed = formatElapsed(entry.runningSeconds)
            return (
              <div
                key={entry.id}
                className="flex items-start gap-2 px-3 py-2 border-b border-border/20 last:border-b-0"
              >
                <span className="mt-1 w-1.5 h-1.5 rounded-full bg-accent shrink-0 animate-pulse motion-reduce:animate-none" />

                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[11px] text-text truncate" title={entry.command}>
                    {entry.command}
                  </div>
                  <div className="text-[10px] text-text-muted/80 truncate" title={entry.cwd}>
                    {entry.pid}
                    {elapsed ? ` · ${elapsed}` : ''}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => handleStop(entry.id)}
                  disabled={busyId === entry.id}
                  className="shrink-0 px-2 py-1 rounded border border-border/60 bg-input/60 text-[10px] font-semibold text-text hover:bg-input transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default"
                >
                  {t('terminals.stop')}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
