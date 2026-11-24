// The plugin's worker: it owns one luban-acp process per conversation and answers the panel.
// Orca transpiles this file when the plugin loads (no build step). A worker restart drops the
// conversation — that is intentional: the agent process belongs to this worker.
import type { OrcaWorkerApi } from 'orca/worker'
import { AcpClient, resolveLaunch, type PermissionRequest, type SessionUpdate } from './acp'
import type { ChatMessage, ChatState, PermissionView, ToolRow } from './protocol'

const MAX_MESSAGES = 400

let orca: OrcaWorkerApi | null = null
let client: AcpClient | null = null
let connecting: Promise<AcpClient> | null = null
let state = emptyState()
let flush: ReturnType<typeof setTimeout> | null = null
/** The assistant message new chunks append to; null between text and tool runs. */
let tail: ChatMessage | null = null
let pendingPermission: { id: string; request: PermissionRequest; answer: (choice: string) => void } | null = null
let seq = 0

function emptyState(): ChatState {
  return {
    status: 'idle',
    error: '',
    cwd: '',
    session: '',
    messages: [],
    tools: [],
    permission: null
  }
}

function nextId(prefix: string): string {
  seq += 1
  return prefix + '_' + String(seq)
}

/** A plain copy: panels get JSON, and later mutations must not leak into a posted value. */
function snapshot(): ChatState {
  return JSON.parse(JSON.stringify(state)) as ChatState
}

function publish(immediate = false): void {
  const api = orca
  if (!api) return
  if (flush !== null) {
    clearTimeout(flush)
    flush = null
  }
  if (immediate) {
    api.panels.post('chat.state.changed', snapshot())
    return
  }
  // Streaming chunks arrive per token: batch them so one turn does not post hundreds of states.
  flush = setTimeout(() => {
    flush = null
    api.panels.post('chat.state.changed', snapshot())
  }, 90)
}

// ─────────────────────────────── agent process ───────────────────────────────

async function workspacePath(api: OrcaWorkerApi): Promise<string> {
  try {
    const context = (await api.host.call('workspace.readContext', {})) as
      | { workspaceId?: string }
      | null
    const listed = (await api.host.call('workspace.list', {})) as {
      workspaces?: { id: string; path: string }[]
    }
    const rows = listed?.workspaces || []
    const id = context?.workspaceId
    const match = (id ? rows.find((row) => row.id === id) : undefined) || rows[0]
    if (match?.path) return match.path
  } catch (error) {
    api.log('读不到工作区路径：' + (error as Error).message)
  }
  return process.cwd()
}

async function ensureClient(api: OrcaWorkerApi): Promise<AcpClient> {
  if (client) return client
  if (connecting) return connecting
  connecting = (async () => {
    const cwd = await workspacePath(api)
    const command = String((await api.settings.get('acpCommand')) || '')
    const model = String((await api.settings.get('model')) || '').trim()
    const readOnly = (await api.settings.get('readOnly')) === true
    const launch = resolveLaunch(command)
    const extra: string[] = ['--root', cwd]
    if (model) extra.push('--model', model)
    if (readOnly) extra.push('--read-only')
    state.cwd = cwd
    state.status = 'starting'
    state.error = ''
    publish(true)

    const created = new AcpClient(launch, cwd, extra, {
      onUpdate: onUpdate,
      onPermission: onPermission,
      onExit: onExit,
      onLog: (line) => api.log(line)
    })
    const sessionId = await created.start()
    client = created
    state.session = sessionId
    return created
  })()
  try {
    return await connecting
  } finally {
    connecting = null
  }
}

function onUpdate(update: SessionUpdate): void {
  const kind = String(update.sessionUpdate || '')
  if (kind === 'agent_message_chunk') {
    appendText('assistant', textOf(update))
    return
  }
  if (kind === 'agent_thought_chunk') {
    appendText('thought', textOf(update))
    return
  }
  if (kind === 'tool_call') {
    tail = null
    const id = String(update.toolCallId || '')
    if (!id) return
    const row: ToolRow = {
      id,
      title: String(update.title || update.name || '工具'),
      status: String(update.status || 'in_progress')
    }
    const at = state.tools.findIndex((item) => item.id === id)
    if (at >= 0) state.tools[at] = row
    else state.tools.push(row)
    publish()
    return
  }
  if (kind === 'tool_call_update') {
    tail = null
    const id = String(update.toolCallId || '')
    const at = state.tools.findIndex((item) => item.id === id)
    if (at >= 0 && update.status) state.tools[at].status = String(update.status)
    publish()
    return
  }
  // plan / 其它：面板暂不展示
}

function textOf(update: SessionUpdate): string {
  const content = update.content
  return content && typeof content.text === 'string' ? content.text : ''
}

function appendText(role: 'assistant' | 'thought', text: string): void {
  if (!text) return
  if (!tail || tail.role !== role) {
    tail = { id: nextId(role), role, text: '' }
    state.messages.push(tail)
    if (state.messages.length > MAX_MESSAGES) state.messages.splice(0, state.messages.length - MAX_MESSAGES)
  }
  tail.text += text
  publish()
}

function onExit(reason: string): void {
  client = null
  tail = null
  if (pendingPermission) {
    const waiting = pendingPermission
    pendingPermission = null
    state.permission = null
    waiting.answer('')
  }
  state.status = 'error'
  state.error = reason
  state.session = ''
  publish(true)
}

function onPermission(request: PermissionRequest): Promise<string> {
  const id = nextId('perm')
  const view: PermissionView = {
    id,
    title: request.title,
    kind: request.kind,
    choices: request.options.map((option) => ({ id: option.optionId, name: option.name })),
    diff: request.files.length
      ? { path: request.files[0].path, text: unifiedDiff(request.files[0].oldText, request.files[0].newText) }
      : null
  }
  tail = null
  state.permission = view
  if (state.status === 'working') state.status = 'waiting'
  publish(true)
  return new Promise<string>((answer) => {
    pendingPermission = { id, request, answer }
  })
}

function unifiedDiff(before: string, after: string): string {
  const oldLines = before ? before.split('\n') : []
  const newLines = after ? after.split('\n') : []
  const head = ['--- 旧', '+++ 新']
  const body = oldLines.map((line) => '-' + line).concat(newLines.map((line) => '+' + line))
  return head.concat(body).join('\n')
}

function settlePermission(choice: string): boolean {
  const waiting = pendingPermission
  if (!waiting) return false
  pendingPermission = null
  state.permission = null
  if (state.status === 'waiting') state.status = 'working'
  publish(true)
  waiting.answer(choice)
  return true
}

// ─────────────────────────────── panel requests ───────────────────────────────

export default function activate(api: OrcaWorkerApi): void {
  orca = api

  api.panels.handle('chat.state', async () => snapshot())

  api.panels.handle('chat.send', async ({ text }) => {
    const trimmed = String(text || '').trim()
    if (!trimmed) return { ok: false, error: '消息是空的' }
    if (state.status === 'working' || state.status === 'waiting' || state.status === 'starting') {
      return { ok: false, error: '上一轮还在跑，等它收尾或先取消' }
    }
    state.messages.push({ id: nextId('user'), role: 'user', text: trimmed })
    if (state.messages.length > MAX_MESSAGES) state.messages.splice(0, state.messages.length - MAX_MESSAGES)
    tail = null
    state.error = ''
    publish(true)
    let active: AcpClient
    try {
      active = await ensureClient(api)
    } catch (error) {
      state.status = 'error'
      state.error = (error as Error).message
      publish(true)
      return { ok: false, error: state.error }
    }
    state.status = 'working'
    publish(true)
    // The turn streams through onUpdate; its request resolves only when the agent stops.
    void active
      .prompt(trimmed)
      .then(() => {
        tail = null
        if (state.status !== 'error') state.status = 'idle'
        publish(true)
      })
      .catch((error: Error) => {
        tail = null
        state.status = 'error'
        state.error = error.message
        publish(true)
      })
    return { ok: true }
  })

  api.panels.handle('chat.permission', async ({ id, choice }) => {
    if (!pendingPermission || pendingPermission.id !== String(id || '')) return { ok: false }
    return { ok: settlePermission(String(choice || '')) }
  })

  api.panels.handle('chat.cancel', async () => {
    if (!client) return { ok: false }
    if (pendingPermission) settlePermission('')
    client.cancel()
    return { ok: true }
  })

  api.panels.handle('chat.reset', async () => {
    if (client) client.dispose('会话已重置')
    if (pendingPermission) settlePermission('')
    client = null
    tail = null
    state = emptyState()
    publish(true)
    return { ok: true }
  })
}

export function deactivate(): void {
  if (client) client.dispose('插件被停用')
  client = null
  orca = null
}
