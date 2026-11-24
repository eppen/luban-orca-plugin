// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.

export type ChatRole = 'user' | 'assistant' | 'thought'

export type ChatMessage = { id: string; role: ChatRole; text: string }

export type ToolRow = { id: string; title: string; status: string }

export type PermissionChoice = { id: string; name: string }

export type PermissionView = {
  id: string
  title: string
  kind: string
  choices: PermissionChoice[]
  /** The first file a write would touch, as a unified diff, when the agent sent one. */
  diff: { path: string; text: string } | null
}

export type ChatStatus = 'idle' | 'starting' | 'working' | 'waiting' | 'error'

export type ChatState = {
  status: ChatStatus
  /** Set when status is 'error'; empty otherwise. */
  error: string
  /** Absolute path the agent was started in (the focused workspace). */
  cwd: string
  session: string
  messages: ChatMessage[]
  tools: ToolRow[]
  permission: PermissionView | null
}

export {}

declare module 'orca' {
  interface PluginRequests {
    /** The whole conversation, so a reopened panel redraws without replaying updates. */
    'chat.state': { output: ChatState }
    /** Hands one turn to the agent and answers as soon as it is queued (the reply streams). */
    'chat.send': { input: { text: string }; output: { ok: boolean; error?: string } }
    /** Answers the pending permission prompt with one of its choices. */
    'chat.permission': { input: { id: string; choice: string }; output: { ok: boolean } }
    /** Asks the agent to stop the current turn. */
    'chat.cancel': { output: { ok: boolean } }
    /** Drops the process and the conversation; the next send starts a fresh session. */
    'chat.reset': { output: { ok: boolean } }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel after anything in the conversation changes. */
    'chat.state.changed': ChatState
  }
}
