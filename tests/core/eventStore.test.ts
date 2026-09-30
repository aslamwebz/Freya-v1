// @vitest-environment node
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JsonlEventStore } from '../../core/events/jsonl-store'
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
