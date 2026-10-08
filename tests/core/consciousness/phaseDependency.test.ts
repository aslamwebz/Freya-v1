// @vitest-environment node
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCore, type Core } from '../../../core/index'
import { FakeModelProvider } from '../../../core/model/fake-provider'
import { projectConsciousContext } from '../../../core/consciousness/projection'
import {
  CONSCIOUS_CONTEXT_LIMITS,
  CONSCIOUS_SOURCES,
} from '../../../core/consciousness/types'
import { continuityFromBrain } from '../../../core/consciousness/adapters/brain'
import { selfFromWorld } from '../../../core/consciousness/adapters/self'
import { worldFromWorld } from '../../../core/consciousness/adapters/world'
import type { ConsciousLifeReading } from '../../../core/consciousness/ports'
import type { StopAllState } from '../../../core/state'
import type { CoreStatus } from '../../../core/protocol/core-protocol'

/**
 * WHAT THIS LANE OWNS, AND WHAT IT STILL OWNS NO CLAIM TO.
 *
 * `PLAN.md` section 6 requires the Unified Conscious Context to consume
 * authoritative projections from Phase 21 (Life) and Phase 22 (Self/World). Both
 * have landed, and this suite pins the integrated state:
 *
 * 1. **Life is a real reading, never a fabricated history.** A Core with a Life
 *    domain reports what that domain actually holds — and before any producer
 *    exists, the port-level contract still answers a stated absence rather than
 *    zeroes. A zero reads as "nothing happened in Freya's life", which is a claim
 *    about her, not about this build.
 * 2. **Self, World and Continuity arrive through ports**, each with exactly one
 *    producer chosen in Core: Phase 22's self model and summary for `self` and
 *    `world`, the Brain for `continuity`. That is asserted structurally, by
 *    checking the projection reads ports rather than a domain projection.
 * 3. **The integration path is real and additive.** A Life reading satisfying the
 *    port contract produces a complete snapshot with no other change, so the
 *    handoff was a matter of supplying an adapter rather than a redesign.
 * 4. **This lane owns no durable truth.** No store, no table, no key, no write
 *    command, no cache - asserted against source, because an absence cannot be
 *    demonstrated by exercising the code that is supposed to lack it.
 *
 * The tests in `projection.test.ts` cover the derivation; this one covers the
 * dependency and the boundary.
 */

const AT = new Date('2026-10-03T12:00:00.000Z')
const IDLE: StopAllState = { active: false, activatedAt: null, activatedBy: null }

let dir: string
let core: Core | null = null

/** The smallest status that counts as a running Core. */
function status(): CoreStatus {
  return {
    lifecycle: 'ready',
    operational: true,
    persistence: { mode: 'durable', durable: true, reason: null, eventStorePath: null },
    diagnostics: { path: null, writeFailures: 0 },
    eventSequence: 1,
    coreStartedAt: '2026-10-03T11:00:00.000Z',
    integrity: { integrity: 'ok', reason: '', line: null, eventsRead: 0, bytesDiscarded: 0 },
    stopAll: IDLE,
    guard: { defaultOutcome: 'allow', approvalWorkflow: 'unavailable' },
    governor: { status: 'ready', grantsActive: 0 },
    providers: [],
    activeProviderCalls: 0,
    sessionUsage: { calls: 0, inputTokens: 0, outputTokens: 0, unknownUsageCalls: 0 },
    durableUsage: { calls: 0, inputTokens: 0, outputTokens: 0, unknownUsageCalls: 0 },
    faults: [],
  }
}

/** A Life reading satisfying the port contract, and nothing more. */
function life(over: Partial<ConsciousLifeReading> = {}): ConsciousLifeReading {
  return {
    health: 'ready',
    sequence: 7,
    durable: true,
    reason: null,
    authority: 'life',
    entries: 2,
    admitted: 2,
    recalled: 1,
    recent: [
      {
        entryId: 'life-b',
        kind: 'shift',
        at: '2026-10-02T09:00:00.000Z',
        textLength: 300,
        confidence: 0.9,
      },
      {
        entryId: 'life-a',
        kind: 'shift',
        at: '2026-10-01T09:00:00.000Z',
        textLength: 100,
        confidence: 0.5,
      },
    ],
    ...over,
  }
}

/** The smallest world header the self adapter's trust fields can be read from. */
function minimalWorldHeader() {
  return {
    health: 'ready' as const,
    reason: null,
    schemaVersion: 1,
    sequence: 0,
    persistence: { mode: 'ephemeral' as const, durable: false, reason: null, faultReason: null },
    limits: {
      maxProjectionEntities: 0,
      maxProjectionEdges: 0,
      maxEntityDetailEdges: 0,
      maxGraphDepth: 0,
      maxConflictsListed: 0,
      maxBeliefsListed: 0,
      maxUncertaintiesListed: 0,
      maxEvidenceRecords: 0,
      maxEntities: 0,
      maxEdges: 0,
      freshnessHorizonMs: 0,
      staleAfterMs: 0,
    },
  }
}

/** Everything absent, which is what a real Core looks like on this baseline. */
function noLifeInput(over: Record<string, unknown> = {}) {
  return {
    status: status(),
    stopAll: IDLE,
    brain: null,
    self: null,
    world: null,
    continuity: null,
    life: null,
    work: null,
    mission: null,
    workforce: null,
    skills: null,
    personality: null,
    attention: null,
    context: null,
    office: null,
    relay: null,
    activity: [],
    presenceRequests: [],
    pendingRequests: [],
    faults: [],
    ...over,
  }
}

/** The source with comment lines removed, so prose cannot satisfy a code claim. */
function stripCommentLines(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
}

async function codeOf(relative: string): Promise<string> {
  return stripCommentLines(await readFile(new URL(relative, import.meta.url), 'utf8'))
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-p20-dep-'))
  core = null
})

afterEach(async () => {
  await core?.stop('test-teardown')
  core = null
  await rm(dir, { recursive: true, force: true })
})

/* ------------------------------------------------- Life is a stated absence */

describe('Life, and the stated absence it reports when no producer answers', () => {
  it('is a row in the closed source set before it is a subsystem', () => {
    expect(CONSCIOUS_SOURCES).toContain('life')
    // Its position is fixed and reviewable: the order of this array is the order of
    // the rows, so a subsystem cannot be quietly inserted mid-table and change what
    // a consumer sees first.
    expect([...CONSCIOUS_SOURCES]).toEqual([
      'core',
      'brain',
      'life',
      'self',
      'world',
      'work',
      'mission',
      'workforce',
      'skills',
      'personality',
      'attention',
      'context',
      'office',
      'relay',
    ])
  })

  it('is reported as absent with a note naming the phase, not as an empty history', () => {
    const snapshot = projectConsciousContext(noLifeInput(), AT)
    expect(snapshot.life.state).toBe('absent')
    expect(snapshot.life.note).toContain('Phase 21')
    // Every count is null rather than zero. A zero is a reading; null is the
    // absence of one. This is the single most important line in the file for the
    // Phase 21 handoff, because it is the difference between "her life is empty"
    // and "nobody has built the subsystem that would know".
    expect(snapshot.life.entries).toBeNull()
    expect(snapshot.life.admitted).toBeNull()
    expect(snapshot.life.recalled).toBeNull()
    expect(snapshot.life.durable).toBeNull()
    expect(snapshot.life.recent).toEqual([])
    expect(snapshot.life.listed).toBe(0)
  })

  it('makes the whole snapshot say it is incomplete, and names life', () => {
    const snapshot = projectConsciousContext(noLifeInput(), AT)
    expect(snapshot.health).toBe('degraded')
    expect(snapshot.reason).toContain('life')
    // And the row itself agrees with the headline, so a consumer reading only the
    // provenance table reaches the same conclusion as one reading the reason.
    const row = snapshot.provenance.sources.find((entry) => entry.domain === 'life')
    expect(row?.freshness).toBe('absent')
    expect(row?.note).toContain('Phase 21')
    // The aggregate reduces to the *weakest* reading across its sources, and with a
    // required contributor missing that is `'absent'`. That is stated here rather
    // than left to be discovered, because it is the one number on this projection
    // that changes the moment Phase 21 lands - and it must not be quietly softened
    // into `'fresh'` to make a demo look healthier. `health` is the field that says
    // whether the snapshot exists; `freshness` says how far what it rests on can be
    // trusted, and one absent source does mean the account is not complete.
    expect(snapshot.provenance.freshness).toBe('absent')
    expect(snapshot.health).toBe('degraded')
    // Degraded, never unavailable: the snapshot exists and is readable, it is just
    // not a full account. Collapsing the two would tell a surface there is nothing
    // to show when there is nearly everything to show.
    expect(snapshot.health).not.toBe('unavailable')
  })

  it('does not pretend a Life exists in a Core that has not even started', () => {
    const snapshot = projectConsciousContext(noLifeInput({ status: null }), AT)
    // "Nothing is known and none is simulated" outranks "this build lacks Life":
    // with no Core there is nothing for Life to have been absent from.
    expect(snapshot.health).toBe('unavailable')
    expect(snapshot.reason).toContain('none is simulated')
  })

  it('is not conflated with a Life that exists but cannot be read', () => {
    const unreadable = projectConsciousContext(
      noLifeInput({ life: life({ health: 'unavailable', reason: 'the life store is locked' }) }),
      AT,
    )
    // 'unknown', not 'absent'. "Phase 21 was never built" and "Phase 21 is built and
    // we cannot ask it" are different facts, and only the first is true today.
    const row = unreadable.provenance.sources.find((entry) => entry.domain === 'life')
    expect(row?.freshness).toBe('unknown')
    expect(unreadable.life.state).toBe('degraded')
    expect(unreadable.life.note).toContain('locked')
    // Still no fabricated history.
    expect(unreadable.life.entries).toBeNull()
    expect(unreadable.life.recent).toEqual([])
  })
})

/* ------------------------------------------------ the integration seam works */

describe('the Phase 21 integration path, exercised before Phase 21 exists', () => {
  it('produces a complete snapshot from a port reading and no other change', () => {
    const without = projectConsciousContext(noLifeInput(), AT)
    const with_ = projectConsciousContext(noLifeInput({ life: life() }), AT)

    // Everything else is absent in this fixture, so the snapshot is degraded either
    // way; what changes is *why*. Before a producer exists the reason names `life`.
    // The moment the port is satisfied it stops naming it, and nothing else about
    // the derivation has to move. That is the property that makes the Phase 21
    // handoff a one-adapter change rather than a redesign.
    expect(without.reason).toContain('life')
    expect(with_.reason).not.toContain('life')
    expect(with_.life.state).toBe('available')
    expect(with_.life.entries).toBe(2)
    expect(with_.life.note).toBeNull()
  })

  it('orders life entries newest first, with a total order that cannot tie', () => {
    const snapshot = projectConsciousContext(noLifeInput({ life: life() }), AT)
    expect(snapshot.life.recent.map((entry) => entry.entryId)).toEqual(['life-b', 'life-a'])
    // Same input twice, same order: a comparator that can return 0 for two distinct
    // records would leave this to the sort implementation.
    const again = projectConsciousContext(noLifeInput({ life: life() }), AT)
    expect(again.life.recent.map((entry) => entry.entryId)).toEqual(['life-b', 'life-a'])
  })

  it('never lets a malformed timestamp displace a well-formed entry at the head', () => {
    const snapshot = projectConsciousContext(
      noLifeInput({
        life: life({
          recent: [
            { entryId: 'life-broken', kind: 'shift', at: 'not-an-instant', textLength: 1, confidence: null },
            { entryId: 'life-newest', kind: 'shift', at: '2026-10-03T09:00:00.000Z', textLength: 1, confidence: null },
            { entryId: 'life-older', kind: 'shift', at: '2026-10-01T09:00:00.000Z', textLength: 1, confidence: null },
          ],
        }),
      }),
      AT,
    )
    // Newest first, and the broken record is last rather than first. `byInstant`
    // sorts a malformed instant last precisely so it cannot win a "most recent"
    // listing; reversing the comparator instead of the array would have inverted
    // that guarantee, and this is the assertion that catches it.
    expect(snapshot.life.recent.map((entry) => entry.entryId)).toEqual([
      'life-newest',
      'life-older',
      'life-broken',
    ])
  })

  it('bounds the life list rather than passing an arbitrary producer length through', () => {
    const many = Array.from({ length: 200 }, (_u, index) => ({
      entryId: `life-${String(index).padStart(4, '0')}`,
      kind: 'shift',
      at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      textLength: 10,
      confidence: 0.5,
    }))
    const snapshot = projectConsciousContext(noLifeInput({ life: life({ recent: many }) }), AT)
    expect(snapshot.life.listed).toBe(CONSCIOUS_CONTEXT_LIMITS.maxLifeEntries)
    expect(snapshot.life.recent).toHaveLength(CONSCIOUS_CONTEXT_LIMITS.maxLifeEntries)
    // The count of what was withheld is part of the honesty: a capped list that does
    // not say it was capped reads as a complete one.
    expect(snapshot.life.omitted).toBe(200 - CONSCIOUS_CONTEXT_LIMITS.maxLifeEntries)
  })

  it('carries no narrative field, only an id, a code, an instant and a length', async () => {
    const source = await codeOf('../../../core/consciousness/ports.ts')
    const block = source.slice(
      source.indexOf('export interface ConsciousLifeEntryReading'),
      source.indexOf('export interface ConsciousLifeReading'),
    )
    for (const forbidden of ['text:', 'summary:', 'narrative:', 'content:', 'body:', 'detail:']) {
      expect(block, `Life entries must not carry ${forbidden}`).not.toContain(forbidden)
    }
    expect(block).toContain('textLength')
  })

  it('keeps STOP ALL authoritative over a supplied Life reading', async () => {
    const snapshot = projectConsciousContext(
      noLifeInput({
        life: life(),
        stopAll: { active: true, activatedAt: '2026-10-03T11:30:00.000Z', activatedBy: 'owner' },
      }),
      AT,
    )
    expect(snapshot.stopAll.active).toBe(true)
    // Reading stays available under STOP ALL: somebody asking "what does it know"
    // during an incident is exactly who needs the answer.
    expect(snapshot.life.state).toBe('available')
    // Advertising an intention while the owner has said stop would be describing
    // something Freya is not permitted to do.
    expect(snapshot.nextActions.items).toEqual([])
    expect(snapshot.nextActions.note).toContain('STOP ALL')
  })
})

/* ----------------------------------------- Self/World/Continuity are ports */

describe('Self, World and Continuity, and the one producer each port has', () => {
  it('are read through ports, not straight off a domain projection', async () => {
    const projection = await codeOf('../../../core/consciousness/projection.ts')
    // The single strongest structural claim in this lane: the derivation file does
    // not import BrainProjection to build those three sections. It still imports it
    // for one thing only - whether the Brain itself is readable - so the Brain *type*
    // appearing is expected, and what is forbidden is the Brain's *values* feeding
    // self/world/continuity.
    // Matched on the *declaration* rather than every call, so the assertion is about
    // how each builder is typed rather than about how often it is invoked.
    const builderSignatures = [
      ...projection.matchAll(/function build(Self|World|Continuity)\(([^)]*)\)/g),
    ].map((match) => match[2]?.trim() ?? '')
    expect(builderSignatures).toEqual([
      'self: ConsciousSelfReading | null',
      'world: ConsciousWorldReading | null',
      'continuity: ConsciousContinuityReading | null',
    ])
  })

  it('has one producer per port, and a missing producer means no reading', () => {
    // No producer, no reading: `null` out, rather than a reading invented from a
    // projection that is not there. Phase 22 owns `self` and `world`; the Brain
    // still owns `continuity`, because the world domain has no memory-admission
    // concept to answer it with.
    expect(selfFromWorld(null, { ...minimalWorldHeader() })).toBeNull()
    expect(worldFromWorld(null)).toBeNull()
    expect(continuityFromBrain(null)).toBeNull()
  })

  it('computes the memory subject length in the adapter and returns no subject', async () => {
    const source = await codeOf('../../../core/consciousness/adapters/brain.ts')
    // The single most privacy-sensitive line in the lane, asserted directly: the
    // subject is measured here and never returned.
    expect(source).toContain('subjectLength: entry.subject.length')
    const reading = continuityFromBrain({
      health: 'healthy',
      reason: null,
      durable: true,
      sequence: 1,
      identity: null,
      self: null,
      counts: {
        entities: 0,
        relations: 0,
        observations: 0,
        memories: 1,
        admitted: 1,
        conflicted: 0,
        rejected: 0,
        withdrawn: 0,
        experiences: 0,
      },
      recentAdmissions: [
        {
          memoryId: 'm1',
          kind: 'episodic',
          source: 'owner',
          confidence: 'high',
          status: 'admitted',
          subject: 'a private subject nobody should read here',
          content: 'a private body',
          admittedAt: '2026-10-03T10:00:00.000Z',
        },
      ],
      conflicts: [],
    } as never)
    expect(reading?.health).toBe('ready')
    expect(JSON.stringify(reading)).not.toContain('private')
    expect(reading?.items[0]?.subjectLength).toBe(
      'a private subject nobody should read here'.length,
    )
  })
})

/* ---------------------------------------------- this lane owns no durable truth */

describe('this lane owns no durable truth', () => {
  it('contains no store, engine, state or table module', async () => {
    const entries = await readdir(new URL('../../../core/consciousness/', import.meta.url), {
      recursive: true,
    })
    const files = entries.filter((entry) => entry.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      // A subsystem that persists needs one of these words in its name. Phase 20
      // has none of them, and that is the structural reason it cannot become a
      // second source of truth: there is nowhere for one to be written.
      expect(file, `${file} looks like a store`).not.toMatch(
        /(store|engine|state|table|schema|migration|repository|persist|cache)/i,
      )
    }
  })

  it('opens no database and writes no file from the projection', async () => {
    const projection = await codeOf('../../../core/consciousness/projection.ts')
    const ports = await codeOf('../../../core/consciousness/ports.ts')
    const types = await codeOf('../../../core/consciousness/types.ts')
    for (const [name, source] of [
      ['projection.ts', projection],
      ['ports.ts', ports],
      ['types.ts', types],
    ] as const) {
      expect(source, `${name} must not touch a database`).not.toMatch(
        /\b(sqlcipher|sqlite|sql|pragma|create\s+table|insert\s+into|db\.|openVault|execute)\b/i,
      )
      expect(source, `${name} must not touch the filesystem`).not.toMatch(
        /\b(node:fs|writeFile|readFile|appendFile|mkdir|localStorage|sessionStorage)\b/,
      )
      expect(source, `${name} must not reach the network`).not.toMatch(
        /\b(fetch|XMLHttpRequest|axios|https?\.request)\b/,
      )
    }
  })

  it('reads no clock and no randomness, so replay reproduces it', async () => {
    const projection = await codeOf('../../../core/consciousness/projection.ts')
    // `now` is an argument. A `Date.now()` or `new Date()` in here would make the
    // snapshot depend on when it was read, and "the same durable state gives the
    // same snapshot" would stop being true - which is the property replay rests on.
    expect(projection).not.toMatch(/Date\.now\(\)/)
    expect(projection).not.toMatch(/new Date\(\s*\)/)
    expect(projection).not.toMatch(/Math\.random/)
  })

  it('exposes no write verb in the Core command vocabulary', async () => {
    const protocol = await codeOf('../../../core/protocol/consciousness.ts')
    // A read and a push are enough for a read. The absence of a command is the
    // property, and `tests/host/consciousnessBridge.test.ts` proves the same absence
    // survives all the way to the renderer allowlist.
    expect(protocol).not.toMatch(/consciousness\s*[:.]\s*(set|write|submit|update|patch|refresh|rebuild|delete|correct|ingest|merge)/i)
  })

  it('mutates no input, so a caller cannot be corrupted by reading', () => {
    const lifeReading = life()
    const frozen = Object.freeze({ ...lifeReading, recent: Object.freeze([...lifeReading.recent]) })
    const snapshot = projectConsciousContext(noLifeInput({ life: frozen }), AT)
    expect(snapshot.life.listed).toBe(2)
    // The projection copied what it needed rather than handing back the producer's
    // own arrays, so a later mutation of the producer cannot rewrite a snapshot a
    // window is already holding.
    const lifeA = life()
    const snapshotA = projectConsciousContext(noLifeInput({ life: lifeA }), AT)
    // The port type is `readonly`, because a producer's own reading should not be
    // mutable behind the projection's back. That is a compile-time promise, so to
    // actually *test* that the projection copied rather than aliased, the mutation
    // below is made through a cast - standing in for a producer that breaks its own
    // promise at runtime, which is exactly the case the copy has to survive.
    ;(lifeA.recent[0] as { entryId: string }).entryId = 'mutated-after-the-read'
    expect(snapshotA.life.recent[0]?.entryId).not.toBe('mutated-after-the-read')
  })
})

/* --------------------------------------- against a real Core, on this baseline */

describe('a real Core on this baseline', () => {
  it('reports the real Life domain rather than a stated absence', async () => {
    const built = createCore({
      dataPath: join(dir, 'events.jsonl'),
      providers: [new FakeModelProvider()],
    })
    await built.start()
    core = built
    const snapshot = built.consciousness(AT)
    // Phase 21 has landed, so the Life section is a reading of the real domain: an
    // empty history is `available` with zero entries, not `absent`. The stated
    // absence is still what a Core with no Life domain reports — that path is
    // pinned at the port level above — but this build has the domain.
    expect(snapshot.life.state).toBe('available')
    expect(snapshot.life.entries).toBe(0)
    expect(snapshot.life.recent).toEqual([])
    // And the reason no longer names life: the snapshot is degraded only because
    // the Brain and world stores in this test are ephemeral, which is a fact
    // about the store, not a missing domain.
    expect(snapshot.reason).not.toContain('life')
  })

  it('derives Self and World from Phase 22 and Continuity from the Brain', async () => {
    const built = createCore({
      dataPath: join(dir, 'events.jsonl'),
      providers: [new FakeModelProvider()],
    })
    await built.start()
    core = built
    const snapshot = built.consciousness(AT)
    // Phase 22 owns `self` and `world` now, and both are available rather than
    // absent. The self model still carries the Brain's seeded identity — the world
    // domain reads it live — so the name a renderer sees is unchanged.
    expect(snapshot.self.state).toBe('available')
    expect(snapshot.self.name).toBe('Freya')
    expect(snapshot.world.state).toBe('available')
    // Continuity stays with the Brain: the world domain owns entities, facts and
    // relations, not memories.
    expect(snapshot.continuity.state).toBe('available')
  })

  it('reproduces the snapshot exactly at the same instant, and differs only in asOf otherwise', async () => {
    const built = createCore({
      dataPath: join(dir, 'events.jsonl'),
      providers: [new FakeModelProvider()],
    })
    await built.start()
    core = built
    const first = built.consciousness(AT)
    const second = built.consciousness(AT)
    expect(second).toEqual(first)

    const later = built.consciousness(new Date(AT.getTime() + 60_000))
    expect(later.provenance.asOf).not.toBe(first.provenance.asOf)
    // Same derivation, different stamp: the durable content is untouched, which is
    // what makes the derivation replayable rather than merely repeatable.
    expect(later.self).toEqual(first.self)
    expect(later.world).toEqual(first.world)
    expect(later.uncertainty).toEqual(first.uncertainty)
  })

  it('writes nothing to the journal when read', async () => {
    const built = createCore({
      dataPath: join(dir, 'events.jsonl'),
      providers: [new FakeModelProvider()],
    })
    await built.start()
    core = built
    const before = await readFile(join(dir, 'events.jsonl'), 'utf8')
    built.consciousness(AT)
    built.consciousness(AT)
    const after = await readFile(join(dir, 'events.jsonl'), 'utf8')
    // A mirror that appended its own reads would be a second durable record of the
    // situation, and the first thing to drift from the subsystems it mirrors.
    expect(after).toBe(before)
  })
})
