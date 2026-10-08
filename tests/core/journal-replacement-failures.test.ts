// @vitest-environment node
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { JsonlEventStore } from '../../core/events/jsonl-store'
import { createCore } from '../../core/index'
import { FakeModelProvider } from '../../core/model/fake-provider'
import { ownerAuthority } from '../../core/testing'
import { replaceJournalAtomically } from '../../core/events/atomic-journal-replacement'

const injection = vi.hoisted(() => ({ failure: '', verificationReady: false }))
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof FsPromises>()
  return { ...fs,
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      if (injection.failure === 'verification-read' && injection.verificationReady) throw new Error('injected verification read failure')
      return fs.readFile(...args)
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      if (injection.failure === 'rename' && String(args[0]).includes('.repair-temp.')) throw new Error('injected replacement failure')
      return fs.rename(...args)
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args)
      if ((injection.failure === 'sync' && String(args[0]).includes('.repair-temp.')) ||
          (injection.failure === 'archive-sync' && String(args[0]).includes('.quarantine-known-repair.'))) {
        handle.sync = async () => { throw new Error('injected sync failure') }
      }
      if (injection.failure === 'verification-read' && String(args[0]).includes('.repair-temp.')) {
        const sync = handle.sync.bind(handle)
        handle.sync = async () => { await sync(); injection.verificationReady = true }
      }
      return handle
    },
  }
})
let dir: string
let path: string
let original: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-replace-failure-'))
  path = join(dir, 'events.jsonl')
  const event = (sequence: number, type: string, payload: unknown) => ({ eventId: `e-${sequence}`, sequence,
    type, payload, schemaVersion: 1, occurredAt: '2026-10-07T18:00:00.000Z', source: 'core',
    actor: 'system', correlationId: `c-${sequence}`, causationId: null })
  const turn = { conversationId: 'conversation-1', turnId: 'turn-1', userMessageId: null,
    assistantMessageId: null, contentLength: 0, requestId: null, providerId: null, model: null,
    outcome: 'started', reason: null }
  original = [event(1, 'conversation.turn.started', turn),
    event(2, 'conversation.turn.interrupted', { ...turn, conversationId: '', outcome: 'interrupted' })]
    .map(e => JSON.stringify(e) + '\n').join('')
  await writeFile(path, original)
})
afterEach(async () => { injection.failure = ''; injection.verificationReady = false; await rm(dir, { recursive: true, force: true }) })

it.each(['sync', 'rename'])('preserves original bytes and removes the temp when %s fails', async failure => {
  injection.failure = failure
  await expect(JsonlEventStore.open(path)).rejects.toThrow()
  expect(await readFile(path, 'utf8')).toBe(original)
  expect((await readdir(dir)).filter(name => name.includes('.repair-temp.'))).toEqual([])
  const archive = (await readdir(dir)).find(name => name.includes('.quarantine-known-repair.') && !name.endsWith('.txt'))!
  expect(await readFile(join(dir, archive), 'utf8')).toBe(original)
})

it.each(['rename', 'sync', 'archive-sync', 'verification-read'])('keeps Core operational but refuses cognition when known repair fails at %s', async failure => {
  injection.failure = failure
  const provider = new FakeModelProvider()
  const core = createCore({ dataPath: path, providers: [provider] })
  try {
    await core.start()
    expect(core.status()).toMatchObject({ lifecycle: 'degraded', operational: true,
      integrity: { integrity: 'corrupt' }, persistence: { durable: false } })
    expect((await core.handleCommand({ command: 'core.status.read', requestId: 'read' })).ok).toBe(true)
    const outcome = await ownerAuthority(core).request({ kind: 'user_turn', prompt: 'must be refused', maxOutputTokens: 100 })
    expect(outcome).toMatchObject({ status: 'denied', reason: 'journal-not-trustworthy' })
    expect(provider.calls).toBe(0)
    expect((await core.conversation()).cognition).toEqual({ available: false, reason: 'journal-not-trustworthy' })
    injection.failure = ''
    expect(await readFile(path, 'utf8')).toBe(original)
  } finally { await core.stop('test-stop') }
})

it('refuses a replacement when the original changed during preparation', async () => {
  const changed = original + 'new bytes from another writer\n'
  await writeFile(path, changed)
  await expect(replaceJournalAtomically(path, Buffer.from(original), 'replacement\n')).rejects.toThrow('known journal repair could not be made durable')
  expect(await readFile(path, 'utf8')).toBe(changed)
  expect((await readdir(dir)).filter(name => name.includes('.repair-temp.'))).toEqual([])
})
