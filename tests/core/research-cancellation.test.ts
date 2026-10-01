// @vitest-environment node
import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCore, type Core } from '../../core'
import { ownerAuthority } from '../../core/testing'
import { JsonlEventStore } from '../../core/events/jsonl-store'
import { BlockingModelProvider, FakeModelProvider } from '../../core/model/fake-provider'
import { ManagedBrowserService } from '../../core/research/browser'

let core: Core | undefined
let directory: string | undefined
afterEach(async () => {
  await core?.stop()
  if (directory) await rm(directory, { recursive: true, force: true })
})
async function path() {
  directory = await mkdtemp(join(tmpdir(), 'freya-research-cancel-'))
  return join(directory, 'events.jsonl')
}
const intent = { kind: 'user_turn' as const, prompt: 'hello', maxOutputTokens: 100 }

it('a trusted abort during durable authorization prevents subsequent provider contact', async () => {
  const store = await JsonlEventStore.open(await path())
  let release!: () => void
  let entered!: () => void
  const arrived = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const append = store.append.bind(store)
  store.append = async event => {
    if (event.type === 'cognition.allowed') { entered(); await held }
    await append(event)
  }
  const provider = new FakeModelProvider()
  core = createCore({ dataPath: '', eventStore: store, providers: [provider] })
  await core.start()
  const controller = new AbortController()
  const pending = ownerAuthority(core).request({ ...intent, signal: controller.signal })
  await arrived
  controller.abort(new Error('FAKE_SECRET C:/private/key'))
  release()
  expect((await pending).status).toBe('cancelled')
  expect(core.status().sessionUsage.calls).toBe(0)
})

it('a trusted abort cancels its in-flight request and leaves unrelated cognition alone', async () => {
  const provider = new BlockingModelProvider()
  core = createCore({ dataPath: await path(), providers: [provider] })
  await core.start()
  const controller = new AbortController()
  const pending = ownerAuthority(core).request({ ...intent, signal: controller.signal })
  await provider.contacted
  controller.abort()
  // Avoid leaving the pre-fix implementation hanging during RED.
  await new Promise(resolve => setTimeout(resolve, 20))
  const aborts = provider.aborts
  if (!aborts) await core.handleCommand({ command: 'security.stopAll', requestId: 'cleanup' })
  expect((await pending).status).toBe('cancelled')
  expect(aborts).toBe(1)
})

it('provider diagnostic text never reaches the Core journal or activity', async () => {
  const dataPath = await path()
  const provider = new FakeModelProvider()
  provider.complete = async () => { throw new Error('FAKE_SECRET C:/private/key') }
  core = createCore({ dataPath, providers: [provider] })
  await core.start()
  await ownerAuthority(core).request(intent)
  expect(await readFile(dataPath, 'utf8')).not.toContain('FAKE_SECRET')
  expect(JSON.stringify(core.activity())).not.toContain('C:/private/key')
})

it('closeAll awaits a physical target close already running after session removal', async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const browser = new ManagedBrowserService({ create: async () => ({
    navigate: async () => {}, read: async () => { throw new Error('unused') }, close: () => held,
  }) })
  const id = await browser.create()
  const closing = browser.close(id)
  let drained = false
  const all = browser.closeAll().then(() => { drained = true })
  await new Promise(resolve => setTimeout(resolve, 20))
  const early = drained
  release()
  await Promise.all([closing, all])
  expect(early).toBe(false)
})
