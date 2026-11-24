// A minimal Agent Client Protocol client: spawn luban-acp and talk newline-delimited JSON-RPC 2.0
// over its stdio. The agent side is acp.js in the Luban repo (the same entry Zed and JetBrains use),
// so nothing here knows about Luban's internals — only the four ACP methods it answers.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type PermissionOption = { optionId: string; name: string; kind: string }

export type PermissionFile = { path: string; oldText: string; newText: string }

export type PermissionRequest = {
  title: string
  kind: string
  files: PermissionFile[]
  options: PermissionOption[]
}

export type SessionUpdate = {
  sessionUpdate: string
  /** agent_message_chunk / agent_thought_chunk */
  content?: { type?: string; text?: string }
  /** tool_call / tool_call_update */
  toolCallId?: string
  title?: string
  name?: string
  kind?: string
  status?: string
}

export type AcpHandlers = {
  /** One session/update notification, as the agent sent it. */
  onUpdate: (update: SessionUpdate) => void
  /** The agent waits for a choice; resolve with an optionId, or '' to cancel. */
  onPermission: (request: PermissionRequest) => Promise<string>
  /** The process ended (or never started); no further updates arrive. */
  onExit: (reason: string) => void
  /** One line of the agent's stderr. */
  onLog: (line: string) => void
}

type RpcMessage = {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { code?: number; message?: string }
}

const PROTOCOL_VERSION = 1

/** `<setting>` (a command line), else ~/.local/bin/luban-acp, else whatever PATH resolves. */
export function resolveLaunch(explicit: string): { command: string; args: string[] } {
  const trimmed = String(explicit || '').trim()
  if (trimmed) {
    const parts = trimmed.split(/\s+/)
    return { command: parts[0], args: parts.slice(1) }
  }
  const local = join(homedir(), '.local', 'bin', 'luban-acp')
  if (existsSync(local)) return { command: local, args: [] }
  return { command: 'luban-acp', args: [] }
}

export class AcpClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private nextId = 1
  private pending = new Map<number, { resolve: (value: RpcMessage) => void; reject: (error: Error) => void }>()
  private sessionId = ''
  private stopped = false

  constructor(
    private readonly launch: { command: string; args: string[] },
    private readonly cwd: string,
    private readonly extraArgs: string[],
    private readonly handlers: AcpHandlers,
    private readonly timeoutMs = 30_000
  ) {}

  /** Spawns the agent, initializes it and opens one session; resolves with the session id. */
  async start(): Promise<string> {
    this.spawn()
    const init = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      // No filesystem or terminal delegation: the agent reads and writes the workspace itself.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'Orca Luban Chat', version: '0.1.0' }
    })
    const version = Number(init.result?.protocolVersion)
    if (version !== PROTOCOL_VERSION) {
      this.handlers.onLog('luban-acp 回的是协议版本 ' + String(version) + '，按 1 继续')
    }
    const created = await this.request('session/new', { cwd: this.cwd, mcpServers: [] })
    this.sessionId = String(created.result?.sessionId || '')
    if (!this.sessionId) throw new Error('luban-acp 没有返回 sessionId')
    return this.sessionId
  }

  /** Sends one turn; resolves when the agent stops working on it. */
  async prompt(text: string): Promise<void> {
    await this.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text }] }, 30 * 60_000)
  }

  cancel(): void {
    this.notify('session/cancel', { sessionId: this.sessionId })
  }

  dispose(reason = '客户端关闭了会话'): void {
    if (this.stopped) return
    this.stopped = true
    const child = this.child
    this.child = null
    if (child) {
      try { child.kill() } catch { /* already gone */ }
    }
    this.failPending(new Error(reason))
  }

  private spawn(): void {
    const child = spawn(this.launch.command, [...this.launch.args, ...this.extraArgs], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env
    })
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onData(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim()) this.handlers.onLog(line)
      }
    })
    child.on('error', (error: Error) => {
      this.stopped = true
      this.failPending(error)
      this.handlers.onExit('无法启动 ' + this.launch.command + '：' + error.message)
    })
    child.on('exit', (code: number | null, signal: string | null) => {
      if (this.stopped) return
      this.stopped = true
      this.child = null
      const why = signal ? '信号 ' + signal : '退出码 ' + String(code)
      this.failPending(new Error('luban-acp 已退出（' + why + '）'))
      this.handlers.onExit('luban-acp 已退出（' + why + '）')
    })
  }

  private failPending(error: Error): void {
    const waiting = [...this.pending.values()]
    this.pending.clear()
    for (const entry of waiting) entry.reject(error)
  }

  private send(message: RpcMessage): void {
    const child = this.child
    if (!child || this.stopped) return
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
  }

  private notify(method: string, params: unknown): void {
    this.send({ method, params: params as Record<string, unknown> })
  }

  private respond(id: number | string, result: Record<string, unknown>): void {
    this.send({ id, result })
  }

  private request(method: string, params: unknown, timeoutMs = this.timeoutMs): Promise<RpcMessage> {
    const id = this.nextId++
    return new Promise<RpcMessage>((resolve, reject) => {
      const child = this.child
      if (!child || this.stopped) {
        reject(new Error('luban-acp 没在运行'))
        return
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('luban-acp 没有在 ' + Math.round(timeoutMs / 1000) + 's 内回应 ' + method))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) }
      })
      this.send({ id, method, params: params as Record<string, unknown> })
    })
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let cut = this.buffer.indexOf('\n')
    while (cut >= 0) {
      const line = this.buffer.slice(0, cut).trim()
      this.buffer = this.buffer.slice(cut + 1)
      if (line) this.onLine(line)
      cut = this.buffer.indexOf('\n')
    }
  }

  private onLine(line: string): void {
    let message: RpcMessage
    try {
      message = JSON.parse(line) as RpcMessage
    } catch {
      this.handlers.onLog('无法解析的一行（已忽略）：' + line.slice(0, 200))
      return
    }
    if (message.method) {
      if (message.id === undefined) {
        if (message.method === 'session/update') {
          const update = (message.params?.update || {}) as SessionUpdate
          this.handlers.onUpdate(update)
        } else {
          this.handlers.onLog('忽略通知：' + message.method)
        }
        return
      }
      void this.onServerRequest(message)
      return
    }
    if (typeof message.id === 'number') {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(String(message.error.message || 'ACP 调用失败')))
      else entry.resolve(message)
    }
  }

  private async onServerRequest(message: RpcMessage): Promise<void> {
    const id = message.id
    if (id === undefined) return
    if (message.method !== 'session/request_permission') {
      this.send({ id, error: { code: -32601, message: '不支持：' + String(message.method) } })
      return
    }
    const params = message.params || {}
    const toolCall = (params.toolCall || {}) as Record<string, unknown>
    const request: PermissionRequest = {
      title: String(toolCall.title || '需要你确认'),
      kind: String(toolCall.kind || ''),
      files: readDiffs(toolCall.content),
      options: readOptions(params.options)
    }
    let choice = ''
    try {
      choice = await this.handlers.onPermission(request)
    } catch (error) {
      this.handlers.onLog('权限选择失败：' + (error as Error).message)
      choice = ''
    }
    if (choice) this.respond(id, { outcome: { outcome: 'selected', optionId: choice } })
    else this.respond(id, { outcome: { outcome: 'cancelled' } })
  }
}

function readOptions(value: unknown): PermissionOption[] {
  if (!Array.isArray(value)) return []
  return value.map((raw) => {
    const option = (raw || {}) as Record<string, unknown>
    return {
      optionId: String(option.optionId || ''),
      name: String(option.name || option.optionId || ''),
      kind: String(option.kind || '')
    }
  })
}

function readDiffs(value: unknown): PermissionFile[] {
  if (!Array.isArray(value)) return []
  const files: PermissionFile[] = []
  for (const raw of value) {
    const block = (raw || {}) as Record<string, unknown>
    if (block.type !== 'diff') continue
    files.push({
      path: String(block.path || ''),
      oldText: String(block.oldText == null ? '' : block.oldText),
      newText: String(block.newText == null ? '' : block.newText)
    })
  }
  return files
}
