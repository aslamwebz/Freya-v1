// @vitest-environment node
/**
 * Verifies the new contract: a Core that is *degraded* (aggregate health
 * label) is still operationally able to serve commands as long as its
 * subsystems are usable, and refuses only the commands whose specific
 * subsystem is unhealthy. STOP ALL and owner authority still work; a
 * corrupt Brain refuses its own writes but does not block Chat.
 *
 * These tests are the regression fence for the bug where a single journal
 * integrity fault or a missing durable store took the whole workspace
 * down with `core is degraded and cannot serve commands`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createCore, type Core } from '../../core/index'
import type { EventStore } from '../../core/events/store'
import { FakeModelProvider } from '../../core/model/fake-provider'
import { ownerAuthority } from '../../core/testing'
import { CORE_EVENT_SCHEMA_VERSION } from '../../core/events/envelope'
import { MemoryBrainStore } from '../../core/brain/memory-store'
import { EphemeralEventStore } from '../../core/events/ephemeral-store'
import { JsonlEventStore } from '../../core/events/jsonl-store'
import { FakeEmailAdapter } from '../../core/relay/adapters'

let dir = ''
let file = ''
let core: Core | null = null
let fake: FakeModelProvider

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-degraded-ops-'))
  file = join(dir, 'core-events.jsonl')
  fake = new FakeModelProvider()
})

afterEach(async () => {
  await core?.stop('test-teardown')
  core = null
  await rm(dir, { recursive: true, force: true })
})

function line(sequence: number, type: string, payload: unknown): string {
  return (
    JSON.stringify({
      eventId: `evt-${sequence}`,
      sequence,
      type,
      schemaVersion: CORE_EVENT_SCHEMA_VERSION,
      occurredAt: new Date(1_700_000_000_000 + sequence * 1000).toISOString(),
      source: 'core',
      actor: 'system',
      correlationId: `corr-${sequence}`,
      causationId: null,
      payload,
    }) + '\n'
  )
}

async function seedCorruptJournal(): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(
    file,
    line(1, 'core.started', { version: '0.1.0', storeKind: 'jsonl', recoveredSequence: 0 }) +
      line(2, 'core.ready', {}) +
      // A complete, malformed event the validator must reject.
      '{"eventId":"evt-bad","sequence":3,"type":"core.ready","schemaVersion":1}\n',
  )
}

describe('a degraded Core remains operational', () => {
  it('status reports degraded lifecycle but operational=true', async () => {
    await seedCorruptJournal()
    core = createCore({ dataPath: file, providers: [fake] })
    await core.start()
    const status = core.status()
    expect(status.lifecycle).toBe('degraded')
    expect(status.operational).toBe(true)
    expect(status.persistence.durable).toBe(true)
    expect(status.persistence.mode).toBe('durable')
  })

  it('still serves core.status.read and security.status.read', async () => {
    await seedCorruptJournal()
    core = createCore({ dataPath: file, providers: [fake] })
    await core.start()
    const r = await core.handleCommand({ command: 'core.status.read', requestId: 'r-1' })
    expect(r.ok).toBe(true)
    expect(r.status?.lifecycle).toBe('degraded')
    const s = await core.handleCommand({ command: 'security.status.read', requestId: 'r-2' })
    expect(s.ok).toBe(true)
  })

  it('the Governor is deny_all (the security guarantee is preserved)', async () => {
    await seedCorruptJournal()
    core = createCore({ dataPath: file, providers: [fake] })
    await core.start()
    expect(core.status().governor.status).toBe('deny_all')
  })

  it('STOP ALL still governs; a STOP ALL survived in state is enforced', async () => {
    // A clean journal with a STOP ALL. The Core must come up ready, see the
    // latch, and report governor deny_all. Owner authority, the new
    // operational test, still works.
    await mkdir(dirname(file), { recursive: true })
    await writeFile(
      file,
      line(1, 'core.started', { version: '0.1.0', storeKind: 'jsonl', recoveredSequence: 0 }) +
        line(2, 'core.ready', {}) +
        line(3, 'security.stop_all.activated', { by: 'owner', reason: 'keep this latch' }),
    )
    core = createCore({ dataPath: file, providers: [fake] })
    await core.start()
    expect(core.status().lifecycle).toBe('ready')
    expect(core.status().governor.status).toBe('deny_all')
    expect(core.status().stopAll.active).toBe(true)

    // A cognition request is refused for the right reason.
    await ownerAuthority(core).createGrant({
      grantId: 'g1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      allowedOrigins: ['user'],
      allowedCauses: ['user_message'],
      backgroundAllowed: true,
      maxCalls: 5,
      maxOutputTokens: 1000,
    })
    const outcome = await ownerAuthority(core).request({ kind: 'user_turn', maxOutputTokens: 100, prompt: 'hi' })
    expect(outcome.status).toBe('denied')
    expect(fake.calls).toBe(0)
  })
})

describe('a Core that cannot open the durable store falls back and stays operational', () => {
  it('records the fault, switches to ephemeral-fallback, and lets Chat run', async () => {
    // Use a throwing eventStore option to force the durable-store path to
    // fail without taking the diagnostics directory with it.
    const dataPath = join(dir, 'core-events.jsonl')
    const throwing: EventStore = {
      append: async () => { throw new Error('synthetic durable store failure') },
      readAll: async () => { throw new Error('synthetic durable store failure') },
      readAfter: async () => { throw new Error('synthetic durable store failure') },
      lastSequence: async () => { throw new Error('synthetic durable store failure') },
      describe: () => 'synthetic://throwing',
      close: async () => undefined,
    }
    core = createCore({ dataPath, eventStore: throwing, providers: [fake] })
    await core.start()
    const status = core.status()
    expect(status.lifecycle).toBe('degraded')
    expect(status.operational).toBe(true)
    expect(status.persistence.durable).toBe(false)
    expect(status.persistence.mode).toBe('ephemeral-fallback')
expect(status.persistence.reason).toMatch(/event store unavailable|event store read failed|event fabric open failed/i)
    // The fault is in the faults list so the operator can see it.
    expect(status.faults.some((f) => /event store unavailable|event store read failed|event fabric open failed/i.test(f))).toBe(true)

    // Chat works: a turn goes through and reaches the model. The conversation
    // service is built on top of the (ephemeral) EventStore and the
    // provider, neither of which the durable-store failure broke.
    const create = await core.handleCommand({ command: 'conversation.create', requestId: 'c1' })
    const conversationOutcome = create.conversation as { operation: string; conversation?: { conversationId: string } }
    expect(conversationOutcome.operation).toBe('created')
    const conversationId = conversationOutcome.conversation?.conversationId
    expect(conversationId).toBeDefined()
    if (conversationId === undefined) return

    const turn = await core.handleCommand({
      command: 'conversation.turn.submit',
      requestId: 't1',
      payload: { conversationId, text: 'hello from ephemeral' },
    })
    const turnOutcome = turn.conversation as { operation: string; turn?: { outcome: string } }
    expect(turnOutcome.operation).toBe('turn')
    expect(turnOutcome.turn?.outcome).toBe('completed')
    expect(fake.calls).toBe(1)
  })

  it('writes a runtime-diagnostics record naming the fallback', async () => {
    const dataPath = join(dir, 'core-events.jsonl')
    const throwing: EventStore = {
      append: async () => { throw new Error('synthetic durable store failure') },
      readAll: async () => { throw new Error('synthetic durable store failure') },
      readAfter: async () => { throw new Error('synthetic durable store failure') },
      lastSequence: async () => { throw new Error('synthetic durable store failure') },
      describe: () => 'synthetic://throwing',
      close: async () => undefined,
    }
    core = createCore({ dataPath, eventStore: throwing, providers: [fake] })
    await core.start()
    const diagPath = core.status().diagnostics.path
    expect(diagPath).not.toBeNull()
    if (diagPath === null) return
    const raw = await readFile(diagPath, 'utf8')
    // The diagnostics log is independent of the EventStore: it exists
    // even when the durable store failed to open.
    const lines = raw.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as { component: string; event: string })
    expect(lines.some((l) => l.component === 'core.event-store' && /^event_(store|fabric)_/.test(l.event))).toBe(true)
  })
})

describe('a Core that boots successfully records lifecycle transitions', () => {
  it('emits a lifecycle_transition record on a clean start', async () => {
    core = createCore({ dataPath: join(dir, 'fresh.jsonl'), providers: [fake] })
    await core.start()
    const diagPath = core.status().diagnostics.path
    expect(diagPath).not.toBeNull()
    if (diagPath === null) return
    const raw = await readFile(diagPath, 'utf8')
    const lines = raw.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as { component: string; event: string; lifecycleBefore?: string; lifecycleAfter?: string })
    const boot = lines.find((l) => l.component === 'core.lifecycle' && l.event === 'lifecycle_transition' && l.lifecycleBefore === 'booting' && l.lifecycleAfter === 'ready')
    expect(boot).toBeDefined()
  })
})

describe('degraded boundary regressions', () => {
  it('reports degraded health when the first failed write is the startup announcement', async () => {
    const store = await JsonlEventStore.open(file)
    const append = store.append.bind(store)
    store.append = async event => {
      if (event.type === 'core.started') throw new Error('startup disk full')
      await append(event)
    }
    core = createCore({ dataPath: file, eventStore: store, providers: [fake] })
    await core.start()
    expect(core.status()).toMatchObject({ lifecycle: 'degraded', operational: true, persistence: { durable: false } })
  })

  it('retains recovery and close faults independently after replay rebuilds state', async () => {
    const store = new EphemeralEventStore()
    store.lastSequence = async () => { throw new Error('sequence unavailable') }
    store.close = async () => { throw new Error('handle could not close') }
    core = createCore({ dataPath: file, eventStore: store, providers: [fake] })
    await core.start()
    expect(core.status().faults.join(' ')).toContain('sequence unavailable')
    expect(core.status().faults.join(' ')).toContain('handle could not close')
    expect(core.status().operational).toBe(true)
  })

  it('refuses voice effects on corrupt history while allowing stop controls', async () => {
    await seedCorruptJournal()
    core = createCore({ dataPath: file, providers: [fake] })
    await core.start()
    for (const command of ['voice.mic.enable', 'voice.capture.start', 'voice.capture.end', 'voice.tts.speak', 'voice.wake.arm'] as const) {
      const result = await core.handleCommand({ command, requestId: command, payload: {} })
      expect(result.ok).toBe(false)
      expect(result.refusal?.reason).toBe('journal-not-trustworthy')
    }
    for (const command of ['voice.mic.disable', 'voice.capture.cancel', 'voice.tts.stop', 'voice.tts.cancel', 'voice.wake.disarm'] as const) {
      expect((await core.handleCommand({ command, requestId: command })).ok).toBe(true)
    }
  })

  it('does not reach search or Relay adapters when security history is corrupt', async () => {
    await seedCorruptJournal()
    let calls = 0
    const email = new FakeEmailAdapter([])
    email.listMessages = async () => { calls += 1; return [] }
    core = createCore({ dataPath: file, providers: [fake], relay: { adapters: { email } },
      research: { searchProvider: { id: 'offline', status: () => ({ ready: true, reason: 'offline' }),
        search: async () => { calls += 1; return [] } },
        browserFactory: { create: async () => { calls += 1; throw new Error('must not open browser') } } } })
    await core.start()
    for (const command of ['search.web', 'browser.read', 'relay.email.read'] as const) {
      const result = await core.handleCommand({ command, requestId: command, payload: { query: 'hello', url: 'https://example.com' } })
      expect(result.ok).toBe(false)
    }
    expect(calls).toBe(0)
    expect((await core.handleCommand({ command: 'relay.status.read', requestId: 'inspect' })).ok).toBe(true)
  })

  it('keeps recovered STOP ALL when durable writes fail during startup', async () => {
    await writeFile(file, line(1, 'security.stop_all.activated', { by: 'owner', reason: 'keep stopped' }))
    const store = await JsonlEventStore.open(file)
    store.append = async () => { throw new Error('disk full') }
    core = createCore({ dataPath: file, eventStore: store, providers: [fake] })
    await core.start()
    expect(core.status()).toMatchObject({ lifecycle: 'degraded', operational: true,
      persistence: { durable: false }, stopAll: { active: true }, governor: { status: 'deny_all' } })
    expect(core.status().faults.join(' ')).toContain('disk full')
    expect((await ownerAuthority(core).request({ kind: 'user_turn', maxOutputTokens: 50, prompt: 'no spending' })).status).toBe('denied')
    expect(fake.calls).toBe(0)
  })

  it('keeps both Brain and write faults when the journal fails after startup', async () => {
    const store = await JsonlEventStore.open(file)
    const brainStore = new MemoryBrainStore()
    brainStore.health = () => ({ health: 'degraded', reason: 'Brain index damaged' })
    core = createCore({ dataPath: file, eventStore: store, brainStore, providers: [fake] })
    await core.start()
    store.append = async () => { throw new Error('runtime disk full') }
    const result = await core.handleCommand({ command: 'core.command.submit', requestId: 'disk-failed', payload: { text: 'still usable' } })
    expect(result.ok).toBe(true)
    expect(core.status()).toMatchObject({ lifecycle: 'degraded', operational: true, persistence: { durable: false } })
    expect(core.status().faults.join(' ')).toContain('Brain index damaged')
    expect(core.status().faults.join(' ')).toContain('runtime disk full')
  })

  it('falls back when sequence recovery succeeds but journal replay fails', async () => {
    const store = new EphemeralEventStore()
    store.readAll = async () => { throw new Error('journal replay unavailable') }
    core = createCore({ dataPath: file, eventStore: store, providers: [fake] })
    await core.start()
    expect(core.status()).toMatchObject({ lifecycle: 'degraded', operational: true,
      persistence: { mode: 'ephemeral-fallback', durable: false, eventStorePath: null } })
    expect(core.status().faults.join(' ')).toContain('journal replay unavailable')
    expect((await core.handleCommand({ command: 'conversation.create', requestId: 'replay' })).ok).toBe(true)
  })

  it('keeps operating when the diagnostics directory cannot be created', async () => {
    const blocked = join(dir, 'blocked')
    await writeFile(blocked, 'a file cannot be a directory')
    core = createCore({ dataPath: join(blocked, 'nested', 'events.jsonl'), providers: [fake] })
    await core.start()
    expect(core.status().operational).toBe(true)
    expect(core.status().diagnostics.writeFailures).toBeGreaterThan(0)
    expect(core.status().persistence.durable).toBe(false)
  })

  it('marks shutdown nonoperational and keeps status reads available', async () => {
    core = createCore({ dataPath: file, providers: [fake] })
    await core.start()
    await core.stop()
    expect(core.status().operational).toBe(false)
    expect((await core.handleCommand({ command: 'core.status.read', requestId: 'stopped' })).ok).toBe(true)
    expect((await core.handleCommand({ command: 'conversation.create', requestId: 'no-write' })).ok).toBe(false)
  })

  it('refuses actual cognition after restarting with an unresolved integrity fault', async () => {
    await seedCorruptJournal()
    core = createCore({ dataPath: file, providers: [fake] })
    await core.start()
    await core.stop()
    core = createCore({ dataPath: file, providers: [fake] })
    await core.start()
    const outcome = await ownerAuthority(core).request({ kind: 'user_turn', maxOutputTokens: 100, prompt: 'must be denied' })
    expect(outcome.status).toBe('denied')
    expect(fake.calls).toBe(0)
    expect(core.status()).toMatchObject({ lifecycle: 'degraded', operational: true })
  })

  it('reports a Brain fault without shutting down unrelated Chat or clearing the fault', async () => {
    const brainStore = new MemoryBrainStore()
    brainStore.health = () => ({ health: 'degraded', reason: 'Brain index damaged' })
    core = createCore({ dataPath: file, brainStore, providers: [fake] })
    await core.start()
    expect(core.status()).toMatchObject({ lifecycle: 'degraded', operational: true, governor: { status: 'ready' } })
    const created = await core.handleCommand({ command: 'conversation.create', requestId: 'brain-create' })
    const conversationId = (created.conversation as { conversation?: { conversationId: string } }).conversation!.conversationId
    const turn = await core.handleCommand({ command: 'conversation.turn.submit', requestId: 'brain-turn', payload: { conversationId, text: 'still answer' } })
    expect((turn.conversation as { turn?: { outcome: string } }).turn?.outcome).toBe('completed')
    expect(fake.calls).toBe(1)
    expect(core.status().faults.join(' ')).toContain('Brain index damaged')
    const diagnostics = await readFile(core.status().diagnostics.path!, 'utf8')
    expect(diagnostics).toContain('brain.degraded')
  })
})
