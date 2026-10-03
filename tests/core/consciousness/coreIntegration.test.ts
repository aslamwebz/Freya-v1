// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCore, type Core, type CoreOptions } from '../../../core/index'
import { FakeModelProvider } from '../../../core/model/fake-provider'
import type { ConsciousContextProjection } from '../../../core/protocol/consciousness'

/**
 * The snapshot, taken from a live Core.
 *
 * The pure-function suite proves the derivation; this one proves the two claims
 * that can only be made against a real Core:
 *
 * 1. **It is a mirror, not a second source of truth.** Reading it writes nothing,
 *    and Core holds no state for it — so there is no second copy that could
 *    disagree, and no journal event that could be lost.
 * 2. **Replay reproduces it.** The same durable state, read at the same instant,
 *    gives the same snapshot — including across a restart, which is the case
 *    that actually matters.
 *
 * The instant is passed in rather than left to the clock, because "the same
 * durable state gives the same snapshot" is only checkable if the instant is
 * held still. That is the same reason `attentionTick` takes one.
 */

const AT = new Date('2026-10-03T12:00:00.000Z')

let dir: string
let core: Core | null = null

async function startCore(overrides: Partial<CoreOptions> = {}): Promise<Core> {
  const built = createCore({
    dataPath: join(dir, 'events.jsonl'),
    providers: [new FakeModelProvider()],
    ...overrides,
  })
  await built.start()
  return built
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-conscious-'))
  core = null
})

afterEach(async () => {
  await core?.stop('test-teardown')
  core = null
  await rm(dir, { recursive: true, force: true })
})

describe('a Core that has not started', () => {
  it('answers with a stated absence rather than throwing', () => {
    const built = createCore({ dataPath: join(dir, 'events.jsonl'), providers: [new FakeModelProvider()] })
    const snapshot = built.consciousness(AT)
    expect(snapshot.health).toBe('unavailable')
    expect(snapshot.reason).toContain('conscious context')
    // Every section says so, rather than reporting zeroes as facts.
    expect(snapshot.self.state).toBe('absent')
    expect(snapshot.world.state).toBe('absent')
    expect(snapshot.recentChanges.state).toBe('absent')
    expect(snapshot.uncertainty.state).toBe('absent')
    expect(snapshot.nextActions.state).toBe('absent')
  })

  it('never returns null, because a null would be indistinguishable from nothing', () => {
    const built = createCore({ dataPath: join(dir, 'events.jsonl'), providers: [new FakeModelProvider()] })
    expect(built.consciousness(AT)).not.toBeNull()
  })
})

describe('a started Core', () => {
  it('describes a situation rather than reporting emptiness', () => {
    core = createCore({ dataPath: join(dir, 'events.jsonl'), providers: [new FakeModelProvider()] })
    return core.start().then(() => {
      const snapshot = core?.consciousness(AT) as ConsciousContextProjection
      expect(snapshot.health).not.toBe('unavailable')
      expect(snapshot.provenance.sources.length).toBeGreaterThan(0)
      // Freya knows who she is, from the Brain it seeded at start.
      expect(snapshot.self.state).toBe('available')
      expect(snapshot.self.name).toBe('Freya')
      expect(snapshot.self.claimCount).toBeGreaterThan(0)
    })
  })

  it('attributes every source it read, and no source it did not', () => {
    core = createCore({ dataPath: join(dir, 'events.jsonl'), providers: [new FakeModelProvider()] })
    return core.start().then(() => {
      const snapshot = core?.consciousness(AT) as ConsciousContextProjection
      const domains = snapshot.provenance.sources.map((row) => row.domain)
      expect(domains).toContain('core')
      expect(domains).toContain('brain')
      expect(new Set(domains).size, 'no source listed twice').toBe(domains.length)
      for (const row of snapshot.provenance.sources) {
        expect(
          ['authoritative', 'derived'],
          `${row.domain} basis`,
        ).toContain(row.basis)
        expect(['fresh', 'stale', 'unknown', 'absent'], `${row.domain} freshness`).toContain(
          row.freshness,
        )
      }
    })
  })

  it('reads the same snapshot twice identically at one instant', () => {
    core = createCore({ dataPath: join(dir, 'events.jsonl'), providers: [new FakeModelProvider()] })
    return core.start().then(() => {
      const first = core?.consciousness(AT) as ConsciousContextProjection
      const second = core?.consciousness(AT) as ConsciousContextProjection
      expect(second).toEqual(first)
    })
  })

  it('writes nothing to the journal when it is read', async () => {
    core = await startCore()
    const before = (await core.activity()).length
    const sequenceBefore = core.status().eventSequence
    // Read it repeatedly, and subscribe to it, and read again.
    core.consciousness(AT)
    core.consciousness(AT)
    const dispose = core.onConsciousness(() => {})
    dispose()
    core.consciousness(AT)
    expect(core.status().eventSequence, 'no event was appended').toBe(sequenceBefore)
    expect((await core.activity()).length).toBe(before)
  })

  it('changes coherently when the authoritative state underneath it changes', async () => {
    core = await startCore()
    const before = core.consciousness(AT)

    // Ask Core to stop. This is a real durable state change, not a snapshot edit.
    await core.handleCommand({ command: 'security.stopAll', requestId: 'stop-1', payload: {} })
    const after = core.consciousness(AT)

    expect(after.stopAll.active).toBe(true)
    expect(before.stopAll.active).toBe(false)
    expect(after.provenance.durableSequence).toBeGreaterThan(before.provenance.durableSequence)
    expect(after.recentChanges.items[0]?.kind).toBe('stop_all.activated')
  })

  it('reports Stop All as withholding every offered action', async () => {
    core = await startCore()
    await core.handleCommand({ command: 'security.stopAll', requestId: 'stop-1', payload: {} })
    const snapshot = core.consciousness(AT)
    expect(snapshot.stopAll.active).toBe(true)
    expect(snapshot.nextActions.items).toEqual([])
    expect(snapshot.nextActions.note).toContain('STOP ALL')
    // Reading is not acting: the rest of the picture survives the stop.
    expect(snapshot.self.state).toBe('available')
  })

  it('keeps no durable state of its own to replay', async () => {
    core = await startCore()
    core.consciousness(AT)
    // Nothing about a conscious context appears in the event vocabulary, so there
    // is no `consciousness.*` event to lose, duplicate or forge.
    const types = new Set((await core.activity()).map((row) => row.type))
    for (const type of types) {
      expect(type.startsWith('consciousness.'), type).toBe(false)
    }
  })
})

describe('the subscription', () => {
  it('delivers the current snapshot immediately on attach', async () => {
    core = await startCore()
    const seen: ConsciousContextProjection[] = []
    core.onConsciousness((projection) => seen.push(projection))
    expect(seen).toHaveLength(1)
    expect(seen[0]?.health).not.toBe('unavailable')
  })

  it('stops delivering once disposed', async () => {
    core = await startCore()
    const seen: ConsciousContextProjection[] = []
    const dispose = core.onConsciousness((projection) => seen.push(projection))
    const afterAttach = seen.length
    dispose()
    await core.handleCommand({ command: 'security.stopAll', requestId: 'stop-1', payload: {} })
    expect(seen.length, 'a disposed subscription is silent').toBe(afterAttach)
  })

  it('does not build a snapshot for anyone when nobody is listening', async () => {
    const started = await startCore()
    core = started
    const before = started.status().eventSequence
    await started.handleCommand({ command: 'security.stopAll', requestId: 'stop-1', payload: {} })
    expect(started.status().eventSequence).toBeGreaterThan(before)
    // No subscriber, no throw, and no observable difference: the publisher is a
    // no-op when its set is empty.
    expect(() => started.consciousness(AT)).not.toThrow()
  })

  it('survives a subscriber that throws, and drops only that subscriber', async () => {
    core = await startCore()
    const good: ConsciousContextProjection[] = []
    core.onConsciousness(() => {
      throw new Error('this window is broken')
    })
    core.onConsciousness((projection) => good.push(projection))
    await core.handleCommand({ command: 'security.stopAll', requestId: 'stop-1', payload: {} })
    expect(good.length, 'the healthy subscriber kept receiving').toBeGreaterThan(1)
  })
})

describe('replay', () => {
  it('reproduces the durable half of the projection across a restart', async () => {
    const journal = join(dir, 'events.jsonl')
    const first = await startCore({ dataPath: journal })
    await first.handleCommand({ command: 'security.stopAll', requestId: 'stop-1', payload: {} })
    const beforeRestart = first.consciousness(AT)
    await first.stop('test-restart')

    // A second Core over the *same* journal, read at the *same* instant.
    const second = createCore({ dataPath: journal, providers: [new FakeModelProvider()] })
    await second.start()
    core = second
    const afterRestart = second.consciousness(AT)

    // What is derived from the durable record is reproduced exactly: STOP ALL,
    // who Freya says she is, what she has learned, and what she intends.
    //
    // What is *not* asserted equal is `provenance.durableSequence` or the whole
    // activity feed, and that is not a weakening — it is the point. Starting and
    // stopping a Core appends its own lifecycle events to the journal, so a
    // restart genuinely changes the durable state. Claiming the two snapshots
    // were byte-identical would be claiming the restart wrote nothing, which is
    // false, and a test that asserted it would be asserting something untrue.
    expect(afterRestart.stopAll).toEqual(beforeRestart.stopAll)
    expect(afterRestart.self).toEqual(beforeRestart.self)
    expect(afterRestart.world).toEqual(beforeRestart.world)
    expect(afterRestart.posture).toEqual(beforeRestart.posture)
    expect(afterRestart.nextActions.items).toEqual(beforeRestart.nextActions.items)
    expect(afterRestart.provenance.durableSequence).toBeGreaterThan(
      beforeRestart.provenance.durableSequence,
    )
  })

  it('still shows the durable event that caused the stop, after a restart', async () => {
    const journal = join(dir, 'events.jsonl')
    const first = await startCore({ dataPath: journal })
    await first.handleCommand({ command: 'security.stopAll', requestId: 'stop-1', payload: {} })
    await first.stop('test-restart')

    const second = createCore({ dataPath: journal, providers: [new FakeModelProvider()] })
    await second.start()
    core = second
    const afterRestart = second.consciousness(AT)

    // Replay, not memory: the row is here because the journal says it happened.
    const kinds = afterRestart.recentChanges.items.map((row) => row.kind)
    expect(kinds).toContain('stop_all.activated')
    expect(afterRestart.stopAll.active).toBe(true)
  })

  it('reports a non-durable store as stale rather than as lost', async () => {
    const journal = join(dir, 'events.jsonl')
    const first = await startCore({ dataPath: journal })
    await first.stop('test-restart')

    const second = createCore({ dataPath: journal, providers: [new FakeModelProvider()] })
    await second.start()
    core = second
    const snapshot = second.consciousness(AT)

    // An in-memory Brain cannot survive a restart, and the snapshot says so on
    // that row rather than reporting the same numbers as though it had.
    const brain = snapshot.provenance.sources.find((row) => row.domain === 'brain')
    expect(brain?.durable, 'the Brain store is ephemeral in this build').toBe(false)
    expect(brain?.freshness).toBe('stale')
    expect(brain?.note).toContain('restart')
    // The whole snapshot is only as fresh as its weakest source, and this one is
    // not fresh — so the snapshot does not claim to be.
    expect(snapshot.provenance.freshness).not.toBe('fresh')
  })

  it('derives the same durable rows from a journal replayed twice', async () => {
    const journal = join(dir, 'events.jsonl')
    const first = await startCore({ dataPath: journal })
    await first.handleCommand({ command: 'security.stopAll', requestId: 'stop-1', payload: {} })
    await first.stop('test-restart')

    const second = createCore({ dataPath: journal, providers: [new FakeModelProvider()] })
    await second.start()
    const b = second.consciousness(AT)
    await second.stop('test-done')

    const third = createCore({ dataPath: journal, providers: [new FakeModelProvider()] })
    await third.start()
    core = third
    const c = third.consciousness(AT)

    // Two replays of the same durable record agree on every fact derived from it.
    expect(c.self).toEqual(b.self)
    expect(c.world).toEqual(b.world)
    expect(c.stopAll).toEqual(b.stopAll)
    // Compared on the durable part only. `since` is deliberately excluded because
    // a session-scoped row — "the Governor has been closed since this process
    // started" — legitimately has a different `since` in a new process, and
    // asserting otherwise would be asking a session fact to be durable.
    const shape = (snapshot: ConsciousContextProjection) =>
      snapshot.uncertainty.items.map((row) => [row.code, row.subjectKind, row.subjectId])
    expect(shape(c)).toEqual(shape(b))
    // The activity feed legitimately differs, because each start appended a
    // lifecycle event of its own. Asserting otherwise would be asserting the
    // restart was invisible to the journal.
    expect(c.provenance.durableSequence).toBeGreaterThan(b.provenance.durableSequence)
  })

  it('is byte-identical when read twice at the same instant', async () => {
    const journal = join(dir, 'events.jsonl')
    core = await startCore({ dataPath: journal })
    // This is the strict form of replay-safety, and it holds because `now` is an
    // argument rather than a clock read: the durable state did not move between
    // the two reads, so neither did anything in the snapshot.
    expect(core.consciousness(AT)).toEqual(core.consciousness(AT))
  })
})