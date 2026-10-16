export interface ProjectDefinition {
  id: string
  name: string
  path: string
  addedBy: 'page' | 'chat'
  createdAt: string
  lastUsedAt?: string
}

export interface PendingProjectRequest {
  id: string
  name: string
  path: string
  createdAt: string
  expiresAt: string
}

/**
 * What a matching rule does to a command:
 * - `allow`: runs without asking;
 * - `ask`: the app pauses and asks the user (allow once / allow always / deny);
 * - `block`: refused outright, with no approval card.
 */
export type TerminalRuleAction = 'allow' | 'ask' | 'block'

export interface TerminalRule {
  id: string
  pattern: string
  action: TerminalRuleAction
  enabled: boolean
  group?: 'delete' | 'disk' | 'git' | 'database' | 'system' | 'publish' | 'infra' | 'custom'
  source?: 'preset' | 'learned' | 'user'
}

/**
 * Legacy single-use command grants. Approvals are now decided and remembered by
 * the host permission gate ("allow always" grants), so nothing new is written
 * here; the field stays so previously stored states keep loading cleanly.
 */
export interface SingleUseGrant {
  id: string
  exactCommand: string
  expiresAt: string
}export interface MomAiCodeSettings {
  shell: 'auto' | 'powershell' | 'cmd'
  defaultTimeoutMs: number
  strictMode: boolean
}

export interface MomAiCodeStorageState {
  version: 4
  projects: ProjectDefinition[]
  pendingRequests: PendingProjectRequest[]
  activeProjects: Record<string, string> // threadId -> projectId
  /** Last project picked in the chat selector; new empty sessions inherit it. */
  lastChatProjectId?: string
  /** `${threadId}:${projectId}` -> epoch ms of the last AGENTS.md attachment. */
  instructionAttachments?: Record<string, number>
  terminalRules: TerminalRule[]
  /** Legacy (host-owned grants now); kept for stored-state compatibility. */
  singleUseGrants: SingleUseGrant[]
  settings: MomAiCodeSettings
}

export interface CodeStateManager {
  load(): Promise<MomAiCodeStorageState>
  save(state: MomAiCodeStorageState): Promise<void>
  getState(): MomAiCodeStorageState
  setBridge(storageBridge: { get: (k: string) => Promise<any>; set: (k: string, v: any) => Promise<void> }): void
}

/**
 * Working copy of a file the user attached to the current message. The host
 * stages the attachment and hands these paths to every extension tool call;
 * they are read-only for the current turn and do not grant project access.
 */
export interface TurnAttachment {
  id?: string
  name?: string
  mimeType?: string
  size?: number
  /** Absolute path of the host-owned working copy. */
  path?: string
  kind?: 'image' | 'file'
}

export interface ToolContext {
  toolName: string
  args: Record<string, any>
  threadId?: string
  /** Attachments of the current message, exposed as read-only source paths. */
  attachments?: TurnAttachment[]
  momai?: {
    storage?: {
      get: (key: string) => Promise<any>
      set: (key: string, value: any) => Promise<void>
    }
    attachments?: TurnAttachment[]
    log?: (msg: string) => void
    sendEvent?: (type: string, data: any) => void
    sendStructuredResponse?: (data: any) => void
  }
}
