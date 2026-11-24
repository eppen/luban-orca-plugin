// No build step: Orca strips the types and compiles the JSX when the panel loads.
// Everything here comes from 'orca' — no DOM, no hooks; state lives in atoms.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Card,
  CodeView,
  EmptyState,
  Heading,
  IconButton,
  Markdown,
  plugin,
  read,
  Row,
  set,
  Spinner,
  Stack,
  Text,
  Textarea,
  type PanelContext
} from 'orca'
import type { ChatMessage, ChatState, ChatStatus, PermissionView } from './protocol'

/** The worker's last answer; null until it first answers. */
const view = atom<ChatState | null>(null)
/** A keyed atom so a hot reload keeps what was typed. */
const draft = atom('draft', '')
/** A local, non-persisted hint (a refused send, for instance). */
const notice = atom('')

const STATUS: Record<ChatStatus, { text: string; tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' }> = {
  idle: { text: '空闲', tone: 'neutral' },
  starting: { text: '启动中', tone: 'accent' },
  working: { text: '干活中', tone: 'accent' },
  waiting: { text: '等你确认', tone: 'warning' },
  error: { text: '出错', tone: 'danger' }
}

const TOOL_TONE: Record<string, 'neutral' | 'accent' | 'success' | 'danger'> = {
  in_progress: 'accent',
  pending: 'neutral',
  completed: 'success',
  failed: 'danger'
}

function busy(state: ChatState): boolean {
  return state.status === 'working' || state.status === 'starting' || state.status === 'waiting'
}

async function send(): Promise<void> {
  const text = read(draft).trim()
  if (!text) return
  set(draft, '')
  set(notice, '')
  const answer = await plugin.request('chat.send', { text })
  if (!answer.ok) {
    set(notice, answer.error || '发送失败')
    set(draft, text)
  }
}

async function answer(permission: PermissionView, choice: string): Promise<void> {
  set(notice, '')
  await plugin.request('chat.permission', { id: permission.id, choice })
}

async function cancel(): Promise<void> {
  await plugin.request('chat.cancel')
}

async function reset(): Promise<void> {
  set(notice, '')
  await plugin.request('chat.reset')
}

/** Runs once before the first render; what it pushes to `subscriptions` ends with the panel. */
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('chat.state.changed', (payload) => set(view, payload)))
  void plugin.request('chat.state').then((payload) => set(view, payload))
}

function Message({ message }: { message: ChatMessage }) {
  if (message.role === 'assistant') {
    return (
      <Card>
        <Markdown content={message.text} />
      </Card>
    )
  }
  if (message.role === 'thought') {
    return (
      <Text muted size="xs">
        {message.text}
      </Text>
    )
  }
  return (
    <Box background="muted" padding="sm" radius="md">
      <Text size="sm" weight="medium">
        {message.text}
      </Text>
    </Box>
  )
}

export default function Panel() {
  const state = read(view)
  const text = read(draft)
  const hint = read(notice)

  if (!state) {
    return (
      <Row gap="xs" align="center">
        <Spinner label="连接中" labelHidden />
        <Text muted size="sm">
          正在连接 Luban…
        </Text>
      </Row>
    )
  }

  const meta = STATUS[state.status]
  const permission = state.permission
  const running = busy(state)

  return (
    <Stack gap="sm">
      <Row justify="between" align="center">
        <Row gap="xs" align="center">
          <Heading level={3}>Luban</Heading>
          <Badge tone={meta.tone}>{meta.text}</Badge>
        </Row>
        <Row gap="xs" align="center">
          {running ? <IconButton icon="stop" label="停止" tooltip="让 Luban 停下这一轮" onPress={() => void cancel()} /> : null}
          <IconButton icon="refresh" label="新会话" tooltip="丢掉进程与对话，下一轮重新开始" onPress={() => void reset()} />
        </Row>
      </Row>

      {state.cwd ? (
        <Text muted size="xs" truncate>
          {state.cwd}
        </Text>
      ) : null}

      {state.error ? (
        <Callout tone="danger" title="出错了">
          <Text size="sm">{state.error}</Text>
        </Callout>
      ) : null}

      {state.messages.length === 0 ? (
        <EmptyState
          title="还没有对话"
          description="在下面写任务。Luban 会用当前工作区、你 ~/.luban/providers.json 里的模型跑，一轮一次。"
          icon="bot"
        />
      ) : (
        <Box direction="column" gap="sm">
          {state.messages.map((message) => (
            <Message key={message.id} message={message} />
          ))}
        </Box>
      )}

      {state.tools.length ? (
        <Stack gap="xs">
          <Text muted size="xs">
            工具
          </Text>
          {state.tools.map((tool) => (
            <Row key={tool.id} gap="xs" align="center">
              <Badge tone={TOOL_TONE[tool.status] || 'neutral'}>{tool.status}</Badge>
              <Text size="xs" truncate>
                {tool.title}
              </Text>
            </Row>
          ))}
        </Stack>
      ) : null}

      {permission ? (
        <Card title={permission.title} description="Luban 停下来等你确认">
          {permission.diff ? (
            <CodeView label={permission.diff.path} code={permission.diff.text} language="diff" />
          ) : null}
          <Row gap="xs" wrap>
            {permission.choices.map((choice) => (
              <Button key={choice.id} onPress={() => void answer(permission, choice.id)}>
                {choice.name}
              </Button>
            ))}
          </Row>
        </Card>
      ) : null}

      {hint ? (
        <Text tone="danger" size="xs">
          {hint}
        </Text>
      ) : null}

      <Textarea
        label="消息"
        labelHidden
        rows={3}
        value={text}
        placeholder="给 Luban 的任务…"
        onChange={(value) => set(draft, value)}
        onSubmit={() => void send()}
      />

      <Row justify="between" align="center">
        <Text muted size="xs">
          {running ? '一轮一次：等这轮收尾再发下一句' : '空闲'}
        </Text>
        <Button onPress={() => void send()} disabled={!text.trim() || running}>
          发送
        </Button>
      </Row>
    </Stack>
  )
}
