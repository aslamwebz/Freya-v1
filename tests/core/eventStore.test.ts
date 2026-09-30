// @vitest-environment node
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JsonlEventStore } from '../../core/events/jsonl-store'
import type { EventStore } from '../../core/events/store'
import { CORE_EVENT_SCHEMA_VERSION, type AnyCoreEvent } from '../../core/events/envelope'
import { EventFabric } from '../../core/events/fabric'

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-events-'))
  file = join(dir, 'nested', 'events.jsonl')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

let counter = 0
function event(sequence: number, overrides: Partial<AnyCoreEvent> = {}): AnyCoreEvent {
  counter += 1
  return {
    eventId: `evt-${counter}`,
    sequence,
    type: 'core.ready',
    schemaVersion: CORE_EVENT_SCHEMA_VERSION,
    occurredAt: new Date(1_700_000_000_000 + sequence * 1000).toISOString(),
    source: 'core',
    actor: 'system',
    correlationId: `corr-${counter}`,
    causationId: null,
    payload: {},
    ...overrides,
  } as AnyCoreEvent
}

describe('JsonlEventStore', () => {
  it('creates its directory and an empty log on first use', async () => {
    const store = await JsonlEventStore.open(file)
    expect(await store.readAll()).toEqual([])
    expect(await store.lastSequence()).toBe(0)
    expect(store.describe()).toContain('jsonl:')
    await store.close()
  })

  it('persists events and reads them back in order', async () => {
    const store = await JsonlEventStore.open(file)
    await store.append(event(1))
    await store.append(event(2))
    await store.append(event(3))
    await store.close()

    const reopened = await JsonlEventStore.open(file)
    const events = await reopened.readAll()
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3])
    expect(events[2]?.eventId).toBe('evt-3')
    await reopened.close()
  })

  it('refuses a sequence that does not advance', async () => {
    const store = await JsonlEventStore.open(file)
    await store.append(event(1))
    await expect(store.append(event(1))).rejects.toThrow(/refusing to append/)
    await expect(store.append(event(0))).rejects.toThrow(/refusing to append/)
    await store.close()
  })

  it('refuses an unsupported schema version', async () => {
    const store = await JsonlEventStore.open(file)
    await expect(store.append(event(1, { schemaVersion: 99 }))).rejects.toThrow(/schema version/)
    await store.close()
  })

  it('rejects a corrupt final line rather than failing to open', async () => {
    const store = await JsonlEventStore.open(file)
    await store.append(event(1))
    await store.append(event(2))
    await store.close()

    // A process killed mid-write leaves half a line.
    await appendFile(file, '{"eventId":"evt-3","seq')

    const recovered = await JsonlEventStore.open(file)
    expect((await recovered.readAll()).map((e) => e.sequence)).toEqual([1, 2])
    await recovered.close()
  })

  it('truncates the torn tail so later appends are not poisoned', async () => {
    const store = await JsonlEventStore.open(file)
    await store.append(event(1))
    await store.close()
    await appendFile(file, '{"eventId":"evt-2","seq')

    const recovered = await JsonlEventStore.open(file)
    await recovered.append(event(2))
    await recovered.close()

    const final = await JsonlEventStore.open(file)
    expect((await final.readAll()).map((e) => e.sequence)).toEqual([1, 2])
    const raw = await readFile(file, 'utf8')
    for (const line of raw.split('\n').filter(Boolean)) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
    await final.close()
  })

  it('rejects a hand-edited line that is not a plausible event', async () => {
    await mkdir(join(dir, 'nested'), { recursive: true })
    await writeFile(file, '{"sequence":1}\n', 'utf8')
    const store = await JsonlEventStore.open(file)
    expect(await store.readAll()).toEqual([])
    await store.close()
  })

  it('does not trust a sequence injected by editing the log', async () => {
    await mkdir(join(dir, 'nested'), { recursive: true })
    await writeFile(
      file,
      `${JSON.stringify({ ...event(1), sequence: 'not-a-number' })}\n`,
      'utf8',
    )
    const store = await JsonlEventStore.open(file)
    expect(await store.readAll()).toEqual([])
    await store.close()
  })

  it('recovers the last sequence after a restart', async () => {
    const first = await JsonlEventStore.open(file)
    await first.append(event(1))
    await first.append(event(2))
    await first.close()

    const second = await JsonlEventStore.open(file)
    expect(await second.lastSequence()).toBe(2)
    await second.close()
  })
})

describe('EventFabric — ordering and durability', () => {
  async function fabric() {
    const store = await JsonlEventStore.open(file)
    let tick = 1_700_000_000_000
    return {
      store,
      open: () =>
        EventFabric.open({
          store,
          now: () => new Date((tick += 1000)),
          newId: () => `id-${(tick += 1)}`,
        }),
    }
  }

  it('assigns monotonic sequences', async () => {
    const f = await (await fabric()).open()
    expect(f.lastSequence).toBe(0)
    const a = await f.append('core.stopping', { reason: 'test' })
    const b = await f.append('core.stopping', { reason: 'test' })
    expect(a.sequence).toBe(1)
    expect(b.sequence).toBe(2)
    expect(f.lastSequence).toBe(2)
    await f.close()
  })

  it('publishes only after the append has resolved', async () => {
    const { store, open: make } = await fabric()
    const f = await make()
    const seen: number[] = []

    let storeDurable = false
    const originalAppend = store.append.bind(store)
    store.append = async (e) => {
      await originalAppend(e)
      storeDurable = true
    }

    f.subscribe((e) => {
      // Inside the callback the event must already be on disk.
      seen.push(storeDurable ? e.sequence : -e.sequence)
    })
    await f.append('core.stopping', { reason: 'test' })

    expect(seen).toEqual([1])
    await f.close()
  })

  it('does not publish when the append fails, and does not consume the sequence', async () => {
    const { store, open: make } = await fabric()
    const f = await make()
    const seen: number[] = []
    f.subscribe((e) => seen.push(e.sequence))

    const originalAppend = store.append.bind(store)
    store.append = async () => {
      throw new Error('disk is on fire')
    }

    await expect(f.append('core.stopping', { reason: 'test' })).rejects.toThrow('disk is on fire')
    expect(seen).toEqual([])
    expect(f.lastSequence).toBe(0)

    // The next attempt still takes sequence 1.
    store.append = originalAppend
    const recovered = await f.append('core.stopping', { reason: 'test' })
    expect(recovered.sequence).toBe(1)
    await f.close()
  })

  it('keeps a throwing subscriber from breaking the fabric', async () => {
    const { open: make } = await fabric()
    const f = await make()
    const seen: number[] = []
    f.subscribe(() => {
      throw new Error('bad subscriber')
    })
    f.subscribe((e) => seen.push(e.sequence))

    await f.append('core.stopping', { reason: 'test' })
    await f.append('core.stopping', { reason: 'test' })

    expect(seen).toEqual([1, 2])
    await f.close()
  })

  it('provides a working disposer', async () => {
    const { open: make } = await fabric()
    const f = await make()
    const seen: number[] = []
    const dispose = f.subscribe((e) => seen.push(e.sequence))
    expect(f.subscriberCount).toBe(1)

    await f.append('core.stopping', { reason: 'test' })
    dispose()
    expect(f.subscriberCount).toBe(0)
    await f.append('core.stopping', { reason: 'test' })

    expect(seen).toEqual([1])
    await f.close()
  })

  it('subscribing and disposing repeatedly does not accumulate listeners', async () => {
    const { open: make } = await fabric()
    const f = await make()
    for (let i = 0; i < 50; i += 1) {
      f.subscribe(() => {})()
    }
    expect(f.subscriberCount).toBe(0)
    await f.close()
  })

  it('continues the sequence after a restart', async () => {
    const first = await (await fabric()).open()
    await first.append('core.stopping', { reason: 'test' })
    await first.append('core.stopping', { reason: 'test' })
    await first.close()

    const store = await JsonlEventStore.open(file)
    const second = await EventFabric.open({ store })
    expect(second.lastSequence).toBe(2)
    const next = await second.append('core.stopping', { reason: 'test' })
    expect(next.sequence).toBe(3)
    await second.close()
  })
})

describe('EventFabric — replay has no side effects', () => {
  it('reduces history without publishing to subscribers', async () => {
    const store = await JsonlEventStore.open(file)
    const f = await EventFabric.open({ store })
    await f.append('core.stopping', { reason: 'test' })
    await f.append('core.stopping', { reason: 'test' })

    const published: number[] = []
    f.subscribe((e) => published.push(e.sequence))

    const result = await f.replay(0, (count) => count + 1)

    expect(result).toBe(2)
    // Replay must not have reached a subscriber.
    expect(published).toEqual([])
    expect(f.lastSequence).toBe(2)
    await f.close()
  })

  it('appends nothing while replaying', async () => {
    const store = await JsonlEventStore.open(file)
    const f = await EventFabric.open({ store })
    await f.append('core.stopping', { reason: 'test' })
    const before = await store.readAll()

    await f.replay<AnyCoreEvent[]>([], (events, e) => [...events, e])

    expect(await store.readAll()).toEqual(before)
    expect(await store.lastSequence()).toBe(before.length)
    await f.close()
  })

  it('does not advance the fabric sequence, so replayed events are not re-emitted', async () => {
    const store = await JsonlEventStore.open(file)
    const f = await EventFabric.open({ store })
    await f.append('core.stopping', { reason: 'test' })
    const sequenceBefore = f.lastSequence

    await f.replay(0, (n) => n + 1)

    expect(f.lastSequence).toBe(sequenceBefore)
    const next = await f.append('core.stopping', { reason: 'test' })
    expect(next.sequence).toBe(sequenceBefore + 1)
    await f.close()
  })

  it('replays a log recovered after a restart', async () => {
    const store1 = await JsonlEventStore.open(file)
    const first = await EventFabric.open({ store: store1 })
    await first.append('core.stopping', { reason: 'test' })
    await first.append('core.stopping', { reason: 'test' })
    await first.close()

    const store2 = await JsonlEventStore.open(file)
    const second = await EventFabric.open({ store: store2 })
    const replayed = await second.replay<AnyCoreEvent[]>([], (events, e) => [...events, e])

    expect(replayed).toHaveLength(2)
    await second.close()
  })
})

describe('concurrent appends', () => {
  it('assigns strictly unique monotonic sequences under 200 simultaneous appends', async () => {
    const store = await JsonlEventStore.open(file)
    const fabric = await EventFabric.open({ store })

    // All 200 are in flight together. Without a serialised append queue every
    // one of them reads `sequence + 1` before any of them has written.
    const appended = await Promise.all(
      Array.from({ length: 200 }, (_unused, i) =>
        fabric.append('cognition.denied', {
          requestId: `req-${i}`,
          reason: 'concurrency probe',
          grantId: null,
        }),
      ),
    )

    const assigned = appended.map((e) => e.sequence)
    expect(new Set(assigned).size).toBe(200)
    expect([...assigned].sort((a, b) => a - b)).toEqual(assigned)

    // The durable log, not just the returned values, must agree.
    const onDisk = await store.readAll()
    const persisted = onDisk.map((e) => e.sequence)
    expect(persisted).toEqual(assigned)
    for (let i = 1; i < persisted.length; i += 1) {
      expect(persisted[i]).toBe((persisted[i - 1] ?? 0) + 1)
    }
    await fabric.close()
  })

  it('publishes in sequence order, not completion order', async () => {
    const store = await JsonlEventStore.open(file)
    const fabric = await EventFabric.open({ store })
    const published: number[] = []
    fabric.subscribe((e) => published.push(e.sequence))

    await Promise.all(
      Array.from({ length: 50 }, () => fabric.append('core.stopping', { reason: 'probe' })),
    )

    expect(published).toEqual([...published].sort((a, b) => a - b))
    await fabric.close()
  })

  it('does not let one failed append poison the queue', async () => {
    const backing = await JsonlEventStore.open(file)
    // A store that fails exactly the second append, the way a full disk or a
    // transient IO error would.
    let seen = 0
    const store: EventStore = {
      append: async (e) => {
        seen += 1
        if (seen === 2) throw new Error('simulated write failure')
        await backing.append(e)
      },
      readAll: () => backing.readAll(),
      readAfter: (n) => backing.readAfter(n),
      lastSequence: () => backing.lastSequence(),
      describe: () => backing.describe(),
      close: () => backing.close(),
    }
    const fabric = await EventFabric.open({ store })

    const results = await Promise.allSettled([
      fabric.append('core.stopping', { reason: 'ok-1' }),
      fabric.append('core.stopping', { reason: 'this one fails' }),
      fabric.append('core.stopping', { reason: 'ok-2' }),
    ])

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])

    // The queue survived. The failed append gave its sequence back rather than
    // leaving a hole, and the append behind it still landed.
    const onDisk = await backing.readAll()
    expect(onDisk.map((e) => e.sequence)).toEqual([1, 2])
    expect(onDisk.every((e) => e.type === 'core.stopping')).toBe(true)

    // And Core is not wedged afterwards.
    const next = await fabric.append('core.stopping', { reason: 'ok-3' })
    expect(next.sequence).toBe(3)
    await fabric.close()
  })
})

describe('durable event validation', () => {
  /** Write a raw log, bypassing the store, so recovery has something to judge. */
  async function seed(...lines: string[]): Promise<void> {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, lines.length === 0 ? '' : lines.join('\n') + '\n')
  }

  const good = (sequence: number, overrides: Record<string, unknown> = {}): string =>
    JSON.stringify({
      eventId: `evt-${sequence}`,
      sequence,
      type: 'core.stopping',
      schemaVersion: CORE_EVENT_SCHEMA_VERSION,
      occurredAt: new Date(1_700_000_000_000 + sequence * 1000).toISOString(),
      source: 'core',
      actor: 'system',
      correlationId: `corr-${sequence}`,
      causationId: null,
      payload: { reason: 'validation fixture' },
      ...overrides,
    })

  const open = () => JsonlEventStore.open(file)

  it('accepts a well-formed log and preserves it', async () => {
    await seed(good(1), good(2), good(3))
    const store = await open()
    expect((await store.readAll()).map((e) => e.sequence)).toEqual([1, 2, 3])
    expect(store.lastTruncation()).toBeNull()
    await store.close()
  })

  it('truncates a torn final write', async () => {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, good(1) + '\n' + good(2).slice(0, 40))
    const store = await open()
    expect((await store.readAll()).map((e) => e.sequence)).toEqual([1])
    expect(store.lastTruncation()?.reason).toMatch(/torn/i)
    await store.close()
  })

  it('truncates an unparseable final line', async () => {
    await seed(good(1), 'this is not json at all')
    const store = await open()
    expect((await store.readAll()).map((e) => e.sequence)).toEqual([1])
    expect(store.lastTruncation()).not.toBeNull()
    await store.close()
  })

  it('refuses an unknown event type', async () => {
    await seed(good(1), good(2, { type: 'security.stop_all.activated_evil' }))
    const store = await open()
    expect((await store.readAll()).map((e) => e.sequence)).toEqual([1])
    expect(store.lastTruncation()?.reason).toMatch(/unknown event type/i)
    await store.close()
  })

  it('refuses an unsupported schema version', async () => {
    await seed(good(1), good(2, { schemaVersion: 99 }))
    const store = await open()
    expect((await store.readAll()).map((e) => e.sequence)).toEqual([1])
    expect(store.lastTruncation()?.reason).toMatch(/schema version/i)
    await store.close()
  })

  it('refuses a forged principal', async () => {
    // The check that matters most: a hand-written line must not be able to
    // present itself as the owner.
    await seed(good(1), good(2, { actor: 'owner; DROP TABLE' }))
    const store = await open()
    expect((await store.readAll()).map((e) => e.sequence)).toEqual([1])
    expect(store.lastTruncation()?.reason).toMatch(/principal/i)
    await store.close()
  })

  it('refuses a hostile source', async () => {
    await seed(good(1), good(2, { source: 'somewhere-else' }))
    const store = await open()
    expect((await store.readAll()).map((e) => e.sequence)).toEqual([1])
    expect(store.lastTruncation()?.reason).toMatch(/source/i)
    await store.close()
  })

  it('refuses a non-positive or fractional sequence', async () => {
    await seed(good(1), good(0))
    let store = await open()
    expect((await store.readAll()).map((e) => e.sequence)).toEqual([1])
    await store.close()

    await seed(good(1), good(1.5))
    store = await open()
    expect((await store.readAll()).map((e) => e.sequence)).toEqual([1])
    await store.close()
  })

  it('refuses a duplicate sequence', async () => {
    await seed(good(1), good(1))
    const store = await open()
    expect((await store.readAll()).map((e) => e.sequence)).toEqual([1])
    expect(store.lastTruncation()?.reason).toMatch(/not greater than/i)
    await store.close()
  })

  it('refuses a reversed sequence', async () => {
    await seed(good(1), good(5), good(3))
    const store = await open()
    expect((await store.readAll()).map((e) => e.sequence)).toEqual([1, 5])
    expect(store.lastTruncation()?.reason).toMatch(/not greater than/i)
    await store.close()
  })

  it('refuses a malformed correlation id', async () => {
    await seed(good(1), good(2, { correlationId: 'has spaces and\ttabs' }))
    const store = await open()
    expect((await store.readAll()).map((e) => e.sequence)).toEqual([1])
    expect(store.lastTruncation()?.reason).toMatch(/correlationId/i)
    await store.close()
  })

  it('refuses a payload that does not match its event type', async () => {
    // Right type name, wrong shape: a stop event with no reason, and a grant
    // whose ceilings are strings.
    await seed(good(1), good(2, { payload: {} }))
    let store = await open()
    expect((await store.readAll()).map((e) => e.sequence)).toEqual([1])
    expect(store.lastTruncation()?.reason).toMatch(/payload does not match/i)
    await store.close()

    await seed(
      good(1),
      JSON.stringify({
        eventId: 'evt-2',
        sequence: 2,
        type: 'cognition.grant.created',
        schemaVersion: CORE_EVENT_SCHEMA_VERSION,
        occurredAt: new Date().toISOString(),
        source: 'core',
        actor: 'owner',
        correlationId: 'corr-2',
        causationId: null,
        payload: {
          grantId: 'g',
          createdBy: 'owner',
          expiresAt: new Date(Date.now() + 1000).toISOString(),
          allowedOrigins: ['user'],
          allowedCauses: ['user_message'],
          goalId: null,
          runId: null,
          actor: null,
          backgroundAllowed: false,
          maxCalls: 'lots',
          maxOutputTokens: 100,
        },
      }),
    )
    store = await open()
    expect((await store.readAll()).map((e) => e.sequence)).toEqual([1])
    await store.close()
  })

  it('truncates an invalid middle line and everything after it', async () => {
    // The documented sharp edge: valid events after the damage are discarded
    // too, because a journal with a hole in it cannot be replayed safely.
    await seed(good(1), good(2, { type: 'not.a.real.event' }), good(3), good(4))
    const store = await open()
    expect((await store.readAll()).map((e) => e.sequence)).toEqual([1])
    expect(store.lastTruncation()?.line).toBe(2)
    // And the file really was shortened, so the next append lands cleanly.
    const raw = await readFile(file, 'utf8')
    expect(raw.trim().split('\n')).toHaveLength(1)
    await store.close()
  })

  it('never replays a forged event as security state', async () => {
    // The end-to-end claim: a log trying to activate STOP ALL with a bogus
    // payload is truncated before replay can see it.
    await seed(
      good(1),
      JSON.stringify({
        eventId: 'evt-evil',
        sequence: 2,
        type: 'security.stop_all.activated',
        schemaVersion: CORE_EVENT_SCHEMA_VERSION,
        occurredAt: new Date().toISOString(),
        source: 'core',
        actor: 'owner',
        correlationId: 'corr-evil',
        causationId: null,
        payload: { by: 'owner' },
      }),
    )
    const store = await open()
    const fabric = await EventFabric.open({ store })
    // A reducer that behaves like the real one: the latch turns on for that one
    // event type and nothing else.
    const state = await fabric.replay({ stopped: false }, (acc, e) =>
      e.type === 'security.stop_all.activated' ? { stopped: true } : acc,
    )
    expect(state.stopped).toBe(false)
    expect(fabric.lastSequence).toBe(1)
    await fabric.close()
  })
})
