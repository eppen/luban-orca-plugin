// Runs src/worker.ts's activate(orca) with the orca object Orca passes, over a mock host.
// Nothing here spawns luban-acp: these cases stop before the agent process is needed.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

test('answers the panel with an empty conversation first', async () => {
  const host = mockHost()
  const worker = await mountWorker(main, { host })
  const state = await worker.request('chat.state')
  assert.equal(state.status, 'idle')
  assert.deepEqual(state.messages, [])
  assert.deepEqual(state.tools, [])
  assert.equal(state.permission, null)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('refuses an empty message without starting the agent', async () => {
  const host = mockHost()
  const worker = await mountWorker(main, { host })
  const answer = await worker.request('chat.send', { text: '   ' })
  assert.equal(answer.ok, false)
  assert.equal((await worker.request('chat.state')).messages.length, 0)
  await worker.deactivate()
})

test('refuses a permission answer when nothing is pending', async () => {
  const host = mockHost()
  const worker = await mountWorker(main, { host })
  const answer = await worker.request('chat.permission', { id: 'perm_1', choice: 'allow_once' })
  assert.deepEqual(answer, { ok: false })
  await worker.deactivate()
})

test('reset clears the conversation and answers ok', async () => {
  const host = mockHost()
  const worker = await mountWorker(main, { host })
  assert.deepEqual(await worker.request('chat.reset'), { ok: true })
  assert.equal((await worker.request('chat.state')).status, 'idle')
  await worker.deactivate()
})
