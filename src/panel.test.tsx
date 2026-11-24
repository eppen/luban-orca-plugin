// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { ChatState } from './protocol'

function emptyState(): ChatState {
  return { status: 'idle', error: '', cwd: '/tmp/repo', session: 'sess_1', messages: [], tools: [], permission: null }
}

test('draws the empty conversation the worker reports', async () => {
  const host = mockHost({ requests: { 'chat.state': () => emptyState() } })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'Luban' }))
  assert.ok(view.find({ text: '空闲' }))
  // EmptyState carries its title as a prop, so it shows in summary() rather than as a text node.
  assert.ok(view.summary().includes('EmptyState "还没有对话"'))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('redraws from a posted state with a message and a tool row', async () => {
  const host = mockHost({ requests: { 'chat.state': () => emptyState() } })
  const view = await mount(panel, { host })
  const next: ChatState = {
    ...emptyState(),
    status: 'working',
    messages: [
      { id: 'user_1', role: 'user', text: '把 README 里的 TODO 列出来' },
      { id: 'assistant_2', role: 'assistant', text: '一共 3 条。' }
    ],
    tools: [{ id: 't1', title: 'read_file README.md', status: 'completed' }]
  }
  await view.post('chat.state.changed', next)
  assert.ok(view.find({ text: '干活中' }))
  assert.ok(view.find({ text: 'read_file README.md' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('shows a permission card with its choices', async () => {
  const host = mockHost({ requests: { 'chat.state': () => emptyState() } })
  const view = await mount(panel, { host })
  await view.post('chat.state.changed', {
    ...emptyState(),
    status: 'waiting',
    permission: {
      id: 'perm_1',
      title: 'write_file · demo.txt',
      kind: 'edit',
      choices: [
        { id: 'allow_once', name: '允许这次写入' },
        { id: 'reject_once', name: '拒绝' }
      ],
      diff: { path: '/tmp/repo/demo.txt', text: '--- 旧\n+++ 新\n+hi' }
    }
  })
  assert.ok(view.find({ text: '等你确认' }))
  assert.ok(view.find({ text: '允许这次写入' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
