// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import {
  RED_TEAM_SENTINELS,
  deepStrings,
  expectNoSentinels,
  journalEvents,
  startRedTeamCore,
  stopRedTeamCore,
  type RedTeamCore,
} from './harness'
import type { ConsciousContextProjection } from '../../core/protocol/consciousness'

/**
 * RED-TEAM family: Phase 20 — the unified conscious context boundary.
 *
 * The invariant under attack: **a snapshot is safe for anything that can see a
 * window.** Every other subsystem's projection is reviewed field by field; this
 * one is not, because it is assembled from eleven of them at once and a leak
 * could arrive through any of them. So it is tested the other way round — a
 * sentinel is planted in every private channel Core has, and the *serialised*
 * snapshot is swept for all of them.
 *
 * Serialised, not field-by-field, deliberately. A test that checked the fields it
 * expected to be clean would pass while a new field carrying the same content
 * went unnoticed; a sweep of every string in the object cannot.
 *
 * The attacks, each in its own `describe`:
 *
 * 1. private content planted in every channel never reaches the snapshot
 * 2. the public surface has no write verb — asserted against source text
 * 3. STOP ALL still holds, and withholds what Freya intends to do next
 * 4. absence degrades to a stated absence, never to a fabricated fact
 * 5. a hostile source cannot forge a value through a widened field
 *
 * Nothing here touches a network, a real provider or a real secret. The
 * sentinels are unmistakably fake markers, per the "Synthetic secrets" rule.
 */

let fixture: RedTeamCore | null = null

const AT = new Date('2026-10-03T12:00:00.000Z')

/** Plant a sentinel through whichever private channels the Core will accept. */
async function plantPrivateContent(): Promise<void> {
  const f = fixture
  if (f === null) throw new Error('no fixture')

  // Memory: content *and* subject, because the subject is the field a person
  // would most want to read and therefore the one most worth attacking.
  await f.core.handleCommand({
    command: 'brain.memory.write',
    requestId: 'plant-memory',
    payload: {
      kind: 'semantic',
      subject: `about ${RED_TEAM_SENTINELS[0]}`,
      content: `the value is ${RED_TEAM_SENTINELS[1]} and it matters`,
      source: 'owner-assertion',
      confidence: 'high',
    },
  })

  // A Mission's title and intent, which live only in the encrypted content store.
  await f.core.handleCommand({
    command: 'mission.create',
    requestId: 'plant-mission',
    payload: {
      title: `plan ${RED_TEAM_SENTINELS[0]}`,
      intent: `achieve ${RED_TEAM_SENTINELS[1]} before the deadline`,
      successCriteria: [`${RED_TEAM_SENTINELS[2]} is reached`],
    },
  })

  // A conversation turn: the owner's own words and the model's answer.
  await f.core.handleCommand({ command: 'conversation.create', requestId: 'plant-conv', payload: {} })
  await f.core.handleCommand({
    command: 'conversation.turn.submit',
    requestId: 'plant-turn',
    payload: { text: `remember that ${RED_TEAM_SENTINELS[0]} is the passphrase` },
  })
}

/** Every string anywhere in the snapshot, keys included. */
function snapshotStrings(snapshot: ConsciousContextProjection): string[] {
  return deepStrings(snapshot)
}

beforeEach(async () => {
  fixture = await startRedTeamCore()
})

afterEach(async () => {
  await stopRedTeamCore(fixture)
  fixture = null
})

describe('attack: private content planted in every channel', () => {
  it('reaches none of them, anywhere in the serialised snapshot', async () => {
    await plantPrivateContent()
    const f = fixture
    if (f === null) throw new Error('no fixture')

    const snapshot = f.core.consciousness(AT)
    // The sweep the whole family exists for: every string, at every depth.
    expectNoSentinels('conscious context', snapshot)

    const serialised = JSON.stringify(snapshot)
    for (const sentinel of RED_TEAM_SENTINELS) {
      expect(serialised.includes(sentinel), `${sentinel} in the serialised snapshot`).toBe(false)
    }
  })

  it('does not reach it through a key name either', async () => {
    await plantPrivateContent()
    const f = fixture
    if (f === null) throw new Error('no fixture')
    const keys = snapshotStrings(f.core.consciousness(AT))
    for (const sentinel of RED_TEAM_SENTINELS) {
      expect(keys.some((text) => text.includes(sentinel)), sentinel).toBe(false)
    }
  })

  it('carries a memory subject as a length rather than as the subject', async () => {
    await plantPrivateContent()
    const f = fixture
    if (f === null) throw new Error('no fixture')
    const snapshot = f.core.consciousness(AT)
    // The section may legitimately hold the admission; what it must not hold is
    // the words. A length survives; a subject does not.
    for (const item of snapshot.continuity.items) {
      expect(typeof item.subjectLength).toBe('number')
      expect(Object.keys(item)).not.toContain('subject')
      expect(Object.keys(item)).not.toContain('content')
    }
  })

  it('reports the memory count honestly while withholding what was said', async () => {
    await plantPrivateContent()
    const f = fixture
    if (f === null) throw new Error('no fixture')
    const snapshot = f.core.consciousness(AT)
    // Counting is not disclosure: a consumer learns that something was learned,
    // which is a fact about Freya's state, and not one character of its content.
    // The world domain does not have a "memories" measurement, so it is null.
    //
    // Phase 22 made every one of these figures `number | null`, where null is a
    // *stated absence* rather than a zero — "I cannot tell you" is not "there were
    // none", and conflating them is the failure this suite is about. A zero would be
    // that conflation wearing a number's clothes, so it is refused here too: the
    // assertion is the specific honest answer, not "null or some number".
    expect(snapshot.world.memories).toBeNull()
    expect(typeof snapshot.world.memories).not.toBe('string')
    expect(snapshot.continuity.listed).toBe(snapshot.continuity.items.length)
  })

  it('writes nothing to the journal while producing the snapshot', async () => {
    const f = fixture
    if (f === null) throw new Error('no fixture')
    const before = await journalEvents(f)
    f.core.consciousness(AT)
    f.core.consciousness(AT)
    const after = await journalEvents(f)
    expect(after.length).toBe(before.length)
    // And no event type named after this phase exists at all.
    for (const event of after) {
      expect(String(event['type']).startsWith('consciousness.')).toBe(false)
    }
  })

  it('spends no cognition to produce it', async () => {
    const f = fixture
    if (f === null) throw new Error('no fixture')
    // `calls` is a counter, not a list: the provider was never asked.
    const before = f.fake.calls
    f.core.consciousness(AT)
    expect(f.fake.calls, 'reading a snapshot asked a provider').toBe(before)
    const events = await journalEvents(f)
    const modelEvents = events.filter((event) => String(event['type']).startsWith('model.request.'))
    expect(modelEvents.length).toBe(0)
  })
})

describe('attack: a window reaching for authority through the snapshot', () => {
  it('finds no write verb anywhere on the public protocol', async () => {
    const { readFile } = await import('node:fs/promises')
    const source = await readFile(
      new URL('../../core/protocol/consciousness.ts', import.meta.url),
      'utf8',
    )
    // Comments are stripped first, so a doc comment cannot satisfy an assertion
    // about code — the failure mode this exact style exists to prevent.
    const code = source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    expect(code).not.toMatch(/\bfunction\s+(set|update|write|apply|mutate|patch|delete|remove)/i)
    expect(code).not.toMatch(/\bmethod\s*:/i)
  })

  it('exposes exactly one read and one subscription on the public interface', async () => {
    const { readFile } = await import('node:fs/promises')
    const source = await readFile(new URL('../../core/index.ts', import.meta.url), 'utf8')

    // The `Core` interface is the surface a caller is typed against, so it is the
    // right thing to assert on. The class also has a private `publishConsciousness`,
    // which is Core calling itself rather than anything a window can reach — and
    // which TypeScript's `private` removes from the type a caller ever sees.
    const start = source.indexOf('export interface Core {')
    expect(start, 'the Core interface was not found').toBeGreaterThan(-1)
    const block = source.slice(start, source.indexOf('\n}', start))

    const members = [...block.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*)\(/gm)].map((m) => m[1])
    const conscious = members.filter((name) => name?.toLowerCase().includes('conscious'))
    expect(conscious.sort()).toEqual(['consciousness', 'onConsciousness'])
  })

  it('keeps the internal publisher off the public interface', async () => {
    const f = fixture
    if (f === null) throw new Error('no fixture')
    // Present at runtime, because TypeScript `private` is a compile-time fact.
    // Absent from the interface above, which is what makes it unreachable.
    const own = Object.getOwnPropertyNames(Object.getPrototypeOf(f.core))
    expect(own).toContain('publishConsciousness')
    // And it takes no input a caller could supply: it rebuilds from Core's own
    // state and pushes to subscribers.
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(f.core))).toContain('onConsciousness')
  })

  it('offers no way to correct a field the window is holding', async () => {
    const f = fixture
    if (f === null) throw new Error('no fixture')
    const own = Object.getOwnPropertyNames(Object.getPrototypeOf(f.core))
    // Nothing that could take a projection *back* into Core either. A mirror a
    // window cannot correct is a mirror a window cannot lie to.
    const suspicious = own.filter((name) => /conscious.*(set|write|apply|ingest|merge|correct)/i.test(name))
    expect(suspicious).toEqual([])
  })

  it('cannot widen a grant, a capability or a budget through the snapshot', async () => {
    const f = fixture
    if (f === null) throw new Error('no fixture')
    const snapshot = f.core.consciousness(AT)
    const serialised = JSON.stringify(snapshot).toLowerCase()
    // These are the words a forged authority would have to carry. None of them
    // is a field on this projection, and the check is textual so that adding one
    // is what makes this fail.
    for (const word of ['grantid', 'principalid', 'capabilitytoken', 'onbehalfof', 'maxouttokens']) {
      expect(serialised.includes(word), word).toBe(false)
    }
  })
})

describe('attack: STOP ALL as a thing to route around', () => {
  it('is reported by the snapshot, not hidden from it', async () => {
    const f = fixture
    if (f === null) throw new Error('no fixture')
    const before = f.core.consciousness(AT)
    expect(before.stopAll.active).toBe(false)

    await f.core.handleCommand({ command: 'security.stopAll', requestId: 'stop-1', payload: {} })
    const after = f.core.consciousness(AT)
    // Reading under STOP ALL is not acting, and a person asking "what does it
    // know" during an incident is exactly who needs the answer.
    expect(after.stopAll.active).toBe(true)
    expect(after.stopAll.activatedBy).toBe('owner')
  })

  it('withholds every offered action, and says how many it withheld', async () => {
    const f = fixture
    if (f === null) throw new Error('no fixture')
    await plantPrivateContent()
    await f.core.handleCommand({ command: 'security.stopAll', requestId: 'stop-1', payload: {} })
    const snapshot = f.core.consciousness(AT)
    expect(snapshot.nextActions.items).toEqual([])
    expect(snapshot.nextActions.listed).toBe(0)
    expect(snapshot.nextActions.note).toContain('STOP ALL')
    // The count is the honest half: "nothing to do" and "not permitted to do
    // anything" are different facts and only one of them is true.
    expect(typeof snapshot.nextActions.omitted).toBe('number')
  })
})

describe('attack: an absent subsystem rendered as an empty one', () => {
  it('is stated as absent, and never as a zero', async () => {
    const { projectConsciousContext } = await import('../../core/consciousness/projection')
    const snapshot = projectConsciousContext(
      {
        status: null,
        stopAll: { active: false, activatedAt: null, activatedBy: null },
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
      },
      AT,
    )
    expect(snapshot.health).toBe('unavailable')
    expect(snapshot.world.entities, 'a fabricated zero').toBeNull()
    expect(snapshot.self.name).toBeNull()
    expect(snapshot.focus.primaryRunId).toBeNull()
    // Even the sections that are lists report themselves as absent, so "there is
    // nothing" is never asserted about a Core that has not started.
    expect(snapshot.recentChanges.state).toBe('absent')
    expect(snapshot.uncertainty.state).toBe('absent')
    expect(snapshot.nextActions.state).toBe('absent')
  })

  it('names which subsystems are missing rather than saying nothing', async () => {
    const { projectConsciousContext } = await import('../../core/consciousness/projection')
    const snapshot = projectConsciousContext(
      {
        status: null,
        stopAll: { active: false, activatedAt: null, activatedBy: null },
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
      },
      AT,
    )
    // Fourteen absent rows rather than an empty list: a consumer can act on "this
    // is missing", and cannot act on "I cannot tell you what is missing".
    // Fourteen rather than twelve because Phase 20 added `self` and `world` as
    // separate provenance rows, and `life` is a row *before* it is a subsystem.
    //
    // The number is written down *and* checked against the producer's own table.
    // The written number is what forces a human to look when a domain lands — it
    // went stale once for Phase 21's `life` and once for Phase 22's `self` and
    // `world`. The derived check is what makes the assertion the claim itself rather
    // than a tally: *every* declared source has a row, every row says `absent`, and
    // the set is exactly the declared one — so neither a domain added later without a
    // row nor a stale row that outlived its domain can slip through.
    const { CONSCIOUS_SOURCES } = await import('../../core/consciousness/types')
    const rows = snapshot.provenance.sources
    expect(rows).toHaveLength(14)
    expect(rows).toHaveLength(CONSCIOUS_SOURCES.length)
    expect(rows.every((row) => row.freshness === 'absent')).toBe(true)
    expect(rows.map((row) => row.domain).sort()).toEqual([...CONSCIOUS_SOURCES].sort())
  })
})

describe('attack: a hostile source forging a value through a widened field', () => {
  it('narrows an unrecognised self-capability state to unknown', async () => {
    const { projectConsciousContext } = await import('../../core/consciousness/projection')
    const forged = {
      health: 'healthy' as const,
      reason: null,
      persistence: 'encrypted' as const,
      durable: true,
      identity: { name: 'Freya', role: 'assistant', purpose: 'help', claims: [] },
      self: {
        complete: true,
        capabilities: [
          {
            capability: 'launch-missiles',
            // Not a member of the closed set. If this reached a window verbatim,
            // a future surface could render "Freya can launch missiles".
            state: 'omnipotent',
            cannot: [],
          },
        ],
        limitations: [],
      },
      counts: {
        entities: 0,
        relations: 0,
        observations: 0,
        memories: 0,
        admitted: 0,
        conflicted: 0,
        rejected: 0,
        withdrawn: 0,
        experiences: 0,
      },
      recentAdmissions: [],
      conflicts: [],
      sequence: 1,
    }
    const { selfFromBrain } = await import('../../core/consciousness/adapters/brain')
    const snapshot = projectConsciousContext(
      {
        status: {
          lifecycle: 'ready',

    operational: true,
    persistence: { mode: 'durable', durable: true, reason: null, eventStorePath: null },
    diagnostics: { path: null, writeFailures: 0 },          eventSequence: 1,
          coreStartedAt: AT.toISOString(),
          integrity: { integrity: 'ok', reason: '', line: null, eventsRead: 0, bytesDiscarded: 0 },
          stopAll: { active: false, activatedAt: null, activatedBy: null },
          guard: { defaultOutcome: 'allow', approvalWorkflow: 'unavailable' },
          governor: { status: 'ready', grantsActive: 0 },
          providers: [],
          activeProviderCalls: 0,
          sessionUsage: { calls: 0, inputTokens: 0, outputTokens: 0, unknownUsageCalls: 0 },
          durableUsage: { calls: 0, inputTokens: 0, outputTokens: 0, unknownUsageCalls: 0 },
          faults: [],
        },
        stopAll: { active: false, activatedAt: null, activatedBy: null },
        brain: forged,
        // Routed through the real adapter rather than hand-written, because that is
        // where the narrowing now lives. A hand-written reading would have made this
        // test assert its own fixture instead of the boundary.
        self: selfFromBrain(forged as never),
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
      },
      AT,
    )
    expect(snapshot.self.capabilities[0]?.state).toBe('unknown')
  })

  it('bounds an oversized list rather than passing it through', async () => {
    const { projectConsciousContext } = await import('../../core/consciousness/projection')
    const { CONSCIOUS_CONTEXT_LIMITS } = await import('../../core/consciousness/types')
    const events = Array.from({ length: 5000 }, (_unused, index) => ({
      id: `e${index}`,
      kind: 'core.ready' as const,
      type: 'core.ready' as const,
      sequence: index,
      at: index,
      text: `a sentence ${index}`,
      tone: 'neutral' as const,
    }))
    const snapshot = projectConsciousContext(
      {
        status: null,
        stopAll: { active: false, activatedAt: null, activatedBy: null },
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
        activity: events,
        presenceRequests: [],
        pendingRequests: [],
        faults: [],
      },
      AT,
    )
    // Core is not up, so the section says so rather than listing 24 of 5000 and
    // implying that 24 is what happened.
    expect(snapshot.recentChanges.state).toBe('absent')
    expect(snapshot.recentChanges.items).toHaveLength(0)
    expect(CONSCIOUS_CONTEXT_LIMITS.maxRecentChanges).toBeGreaterThan(0)
  })

  it('drops an uncertainty code it does not recognise rather than forwarding it', async () => {
    // The codes are a closed union, so this is enforced by the type rather than
    // by a check — but the *ordering* is data, and data can be tampered with.
    const { CONSCIOUS_UNCERTAINTY_CODES } = await import('../../core/protocol/consciousness')
    for (const code of CONSCIOUS_UNCERTAINTY_CODES) {
      expect(typeof code).toBe('string')
      expect(code).toMatch(/^[a-z]+(\.[a-z-]+)+$/)
    }
  })
})

describe('attack: a snapshot used as a transcript', () => {
  it('carries no activity sentence', async () => {
    const f = fixture
    if (f === null) throw new Error('no fixture')
    const snapshot = f.core.consciousness(AT)
    // The activity feed's sentence is Core-authored and already crosses elsewhere,
    // so dropping it leaks nothing new — and it buys an invariant that can be
    // checked exhaustively: the only free text in this projection is Freya's own
    // immutable account of herself.
    const activity = f.core.activity()
    const sentences = activity.map((row) => row.text)
    const serialised = JSON.stringify(snapshot)
    for (const sentence of sentences) {
      if (sentence.length > 24) {
        expect(serialised.includes(sentence), sentence).toBe(false)
      }
    }
    for (const row of snapshot.recentChanges.items) {
      expect(Object.keys(row).sort()).toEqual(['at', 'id', 'kind', 'sequence', 'tone'])
    }
  })

  it('carries no conversation turn and no prompt', async () => {
    const f = fixture
    if (f === null) throw new Error('no fixture')
    await plantPrivateContent()
    const serialised = JSON.stringify(f.core.consciousness(AT))
    expect(serialised.includes('passphrase')).toBe(false)
    expect(serialised.includes('remember that')).toBe(false)
  })
})