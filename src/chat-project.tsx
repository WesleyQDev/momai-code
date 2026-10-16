import React, { useState, useEffect, useRef, useCallback } from 'react'
import { getSDK } from 'momai:sdk'

interface Project {
  id: string
  name: string
  path: string
}

interface ChatProjectProps {
  threadId?: string
  sdk?: any
}

/** Enables the momai-code skill for a chat thread (host API when available, HTTP fallback). */
async function activateCodeSkill(threadId: string): Promise<void> {
  const sdk = getSDK()
  const chat = (sdk as any).chat
  if (chat?.activateSkill) {
    await chat.activateSkill('momai-code', threadId)
  } else {
    await sdk.api.post('/chat/skills/activate', { thread_id: threadId, skill_id: 'momai-code' })
  }
}

export default function ChatProjectSelector({ threadId = 'default' }: ChatProjectProps) {
  const [activeProject, setActiveProject] = useState<Project | null>(null)
  const [gitBranch, setGitBranch] = useState<string | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [isOpen, setIsOpen] = useState(false)
  const [isAdding, setIsAdding] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const loadData = useCallback(async () => {
    try {
      const sdk = getSDK()
      const res = await sdk.api.post('/extensions/momai-code/settings', {
        action: 'get_chat_project',
        threadId
      })
      if (res.ok && res.data) {
        setActiveProject(res.data.activeProject || null)
        setGitBranch(res.data.gitBranch || null)
        setProjects(res.data.projects || [])

        // New session inherited the last selected project: enable the skill too.
        if (res.data.inherited && res.data.activeProject) {
          await activateCodeSkill(threadId)
        }
      }
    } catch {
      // Best-effort
    }
  }, [threadId])

  useEffect(() => {
    loadData()
  }, [loadData])

  // Fecha dropdown ao clicar fora
  useEffect(() => {
    if (!isOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  const handleSelectProject = async (projectId: string | null) => {
    try {
      const sdk = getSDK()
      const res = await sdk.api.post('/extensions/momai-code/settings', {
        action: 'set_chat_project',
        threadId,
        projectId: projectId || 'home'
      })
      if (res.ok && res.data) {
        setActiveProject(res.data.activeProject || null)
        setGitBranch(res.data.gitBranch || null)
        if (res.data.projects) setProjects(res.data.projects)

        if (projectId && projectId !== 'home') {
          await activateCodeSkill(threadId)
        }
      }
    } catch {
      // Best-effort
    } finally {
      setIsOpen(false)
    }
  }

  const handleAddProject = async () => {
    setIsAdding(true)
    try {
      const sdk = getSDK()
      let chosenPath: string | null = null

      if (sdk.dialog?.selectDirectory) {
        try {
          const picked = await sdk.dialog.selectDirectory({
            title: 'Selecionar Pasta do Projeto - MomAI Code'
          })
          if (picked && !picked.canceled && picked.path) {
            chosenPath = picked.path
          }
        } catch {
          // Fall through to backend picker
        }
      }

      if (!chosenPath) {
        const res = await sdk.api.post('/extensions/momai-code/settings', {
          action: 'pick_project',
          threadId
        })
        if (res.ok && res.data && !res.data.canceled) {
          if (res.data.activeProject) setActiveProject(res.data.activeProject)
          if (res.data.gitBranch !== undefined) setGitBranch(res.data.gitBranch)
          if (res.data.projects) setProjects(res.data.projects)
          await activateCodeSkill(threadId)
          await loadData()
          return
        }
      }

      if (chosenPath) {
        const res = await sdk.api.post('/extensions/momai-code/settings', {
          action: 'add_project',
          path: chosenPath,
          threadId
        })
        if (res.ok && res.data) {
          if (res.data.activeProject) setActiveProject(res.data.activeProject)
          if (res.data.gitBranch !== undefined) setGitBranch(res.data.gitBranch)
          if (res.data.projects) setProjects(res.data.projects)
          await activateCodeSkill(threadId)
        }
        await loadData()
      }
    } catch {
      // Best-effort
    } finally {
      setIsAdding(false)
      setIsOpen(false)
    }
  }

  return (
    <div
      ref={dropdownRef}
      className="relative inline-flex items-center gap-1.5 text-xs text-text-muted select-none"
    >
      {/* Botão Dropdown sem fundo */}
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="flex items-center gap-1.5 bg-transparent hover:bg-input/60 active:bg-input rounded-md px-1.5 py-1 text-xs text-text-muted hover:text-text transition-colors cursor-pointer focus:outline-none border-none"
        title={activeProject ? activeProject.name : 'Sem Projeto'}
      >
        {/* Ícone de código/projeto */}
        <div className="w-4 h-4 rounded flex items-center justify-center bg-accent/15 text-accent shrink-0">
          <svg
            className="w-2.5 h-2.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
          </svg>
        </div>

        <span className="font-medium max-w-[150px] truncate text-text">
          {activeProject ? activeProject.name : 'Sem Projeto'}
        </span>

        {/* Chevron down */}
        <svg
          className={`w-3 h-3 text-text-muted/60 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {/* Separador / */}
      <span className="text-text-muted/40 font-light select-none">/</span>

      {/* Git branch info */}
      <div
        className="flex items-center gap-1 text-xs text-text-muted/80 max-w-[180px] truncate"
        title={gitBranch ? `Branch: ${gitBranch}` : 'Sem git'}
      >
        <svg
          className="w-3.5 h-3.5 text-text-muted/60 shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="6" y1="3" x2="6" y2="15" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
        <span className="truncate">{gitBranch || 'Sem git'}</span>
      </div>

      {/* Dropdown Menu suspenso */}
      {isOpen && (
        <div className="absolute bottom-full mb-1.5 left-0 min-w-[210px] max-w-[280px] max-h-[260px] overflow-y-auto bg-card border border-border/70 rounded-xl shadow-xl p-1 z-50 text-xs flex flex-col gap-0.5 custom-scrollbar animate-in fade-in zoom-in-95 duration-150">
          {/* Opção: Sem Projeto */}
          <button
            type="button"
            onClick={() => handleSelectProject(null)}
            className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left transition-colors cursor-pointer border-none ${
              !activeProject
                ? 'bg-accent/15 text-accent font-medium'
                : 'text-text hover:bg-input/60'
            }`}
          >
            <svg
              className="w-3.5 h-3.5 shrink-0 opacity-70"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
            <span className="truncate flex-1">Sem Projeto</span>
            {!activeProject && <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />}
          </button>

          {/* Lista de Projetos Cadastrados */}
          {projects.length > 0 && (
            <div className="my-1 border-t border-border/30" />
          )}

          {projects.map((proj) => {
            const isSelected = activeProject?.id === proj.id
            const initial = (proj.name || 'P').charAt(0).toUpperCase()
            return (
              <button
                key={proj.id}
                type="button"
                onClick={() => handleSelectProject(proj.id)}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left transition-colors cursor-pointer border-none ${
                  isSelected
                    ? 'bg-accent/15 text-accent font-medium'
                    : 'text-text hover:bg-input/60'
                }`}
                title={proj.path}
              >
                <div className="w-4 h-4 rounded bg-input/80 border border-border/40 flex items-center justify-center text-[10px] font-semibold shrink-0 text-text-muted">
                  {initial}
                </div>
                <span className="truncate flex-1">{proj.name}</span>
                {isSelected && <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />}
              </button>
            )
          })}

          {/* Divisor antes de adicionar */}
          <div className="my-1 border-t border-border/30" />

          {/* Opção "+ Adicionar projeto" abaixo de tudo */}
          <button
            type="button"
            disabled={isAdding}
            onClick={handleAddProject}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left text-text-muted hover:text-text hover:bg-input/60 active:bg-input transition-colors cursor-pointer border-none disabled:opacity-50"
          >
            <svg
              className="w-3.5 h-3.5 shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span className="truncate flex-1">
              {isAdding ? 'Abrindo explorador...' : 'Adicionar projeto'}
            </span>
          </button>
        </div>
      )}
    </div>
  )
}
