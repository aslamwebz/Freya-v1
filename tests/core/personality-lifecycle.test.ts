// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  LIFECYCLE_REASON_BY_STATUS,
  PERSONALITY_LIMITS,
  RELATIONSHIP_LIFECYCLE_REASONS,
  isLifecycleConsistent,
} from '../../core/personality/types'
import {
  admitRelationshipItem,
  createRelationshipCandidate,
  rejectRelationshipItem,
  retireRelationshipItem,
  supersedeRelationshipItem,
} from '../../core/personality/relationship'
import { PersonalityIntegration, type PersonalityLifecycleEvent } from '../../core/personality/integration'
import type { CueUsageLedger, RelationshipItem } from '../../core/personality/types'

/**
 * THE RELATIONSHIP LIFECYCLE, and bounded retention.
 *
 * Admission was the only transition Slice A had, which meant "retention,
 * withdrawal and retirement" were words in a doc comment rather than
 * operations. This suite pins each of them down as a transition with a stated
 * cause, an instant, and a rule about what survives — because a record store that
 * cannot say why it forgot something is a store that will forget the wrong thing.
 *
 * Two properties are asserted over and over, and they are the whole point:
 *
 *  - **Withdrawal destroys.** The text is gone, not flagged, and the metadata
 *    remains so the domain can still answer "this existed and was taken back".
 *  - **Retention is bounded and deterministic.** Two runs over the same state drop
 *    the same record, so a store's contents are never a function of insertion
 *    accidents.
 */

const AT = '2026-06-01T09:00:00.000Z'
const LATER = '2026-06-02T09:00:00.000Z'

function candidate(over: Record<string, unknown> = {}): RelationshipItem {
  const result = createRelationshipCandidate({
    itemId: 'rel-1',
    kind: 'preference',
    key: 'conciseness-short',
    text: 'keep it short from now on',
    tags: ['style', 'conciseness'],
    cueKind: null,
    source: 'owner-assertion',
    sourceRef: 'turn-1',
    observedAt: AT,
    recordedAt: AT,
    proposedConfidence: 'high',
    actor: 'owner',
    ...over,
  })
  if (!result.ok) throw new Error(result.reason)
  return result.item
}

function admitted(over: Record<string, unknown> = {}, at = AT): RelationshipItem {
  const result = admitRelationshipItem(candidate(over), { now: at, reason: 'the owner asked for it' })
  if (!result.ok) throw new Error(result.reason)
  return result.item
}

/**
 * A store over a fake persistence seam, so nothing touches a disk here.
 *
 * The seam reports health and nothing else, exactly as the real one does — the
 * integration supplies `retained` itself, and a seam that tried to answer that
 * would be a loop rather than a report.
 */
function store(
  options: {
    durable?: boolean
    items?: readonly RelationshipItem[]
    ledger?: CueUsageLedger
  } = {},
) {
  let durable = options.durable ?? true
  const commits: { items: readonly RelationshipItem[]; ledger: CueUsageLedger }[] = []
  const events: PersonalityLifecycleEvent[] = []
  let clock = new Date(AT)
  const integration = new PersonalityIntegration({
    now: () => new Date(clock),
    newId: (() => {
      let n = 0
      return () => `rel-${(n += 1)}`
    })(),
    initialItems: options.items ?? [],
    initialLedger: options.ledger,
    persistence: {
      commit: (committed, ledger) => commits.push({ items: committed, ledger }),
      health: () => ({
        mode: durable ? ('encrypted' as const) : ('ephemeral' as const),
        durable,
        reason: durable ? null : 'this machine has no secure Personality key',
        faultReason: null,
        retained: 0,
      }),
    },
    onLifecycle: (event) => events.push(event),
  })
  return {
    integration,
    commits,
    events,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms)
    },
    breakDurability: () => {
      durable = false
    },
  }
}

describe('admission and rejection', () => {
  it('a candidate carries no lifecycle at all', () => {
    const item = candidate()
    expect(item.status).toBe('candidate')
    expect(item.admittedAt).toBeNull()
    expect(item.lifecycleAt).toBeNull()
    expect(item.lifecycleReason).toBeNull()
  })

  it('admission records an instant and a reason, and changes nothing else', () => {
    const before = candidate()
    const after = admitted()
    expect(after.status).toBe('admitted')
    expect(after.admittedAt).toBe(AT)
    expect(after.admissionReason).toBe('the owner asked for it')
    // Same content. Admission is a status change and nothing more, so a caller
    // cannot re-describe a record on the way in.
    expect(after.text).toBe(before.text)
    expect(after.key).toBe(before.key)
    expect(after.tags).toEqual(before.tags)
    expect(after.confidence).toBe(before.confidence)
    expect(after.provenance).toEqual(before.provenance)
  })

  it('rejection keeps the record, with a reason and a closed lifecycle label', () => {
    const rejected = rejectRelationshipItem(candidate(), { now: LATER, reason: 'not what was meant' })
    expect(rejected.ok).toBe(true)
    if (!rejected.ok) return
    expect(rejected.item.status).toBe('rejected')
    expect(rejected.item.lifecycleReason).toBe('owner-rejected-this-record')
    expect(rejected.item.lifecycleAt).toBe(LATER)
    // The text is *not* destroyed by a rejection: nobody took it back, Freya
    // simply declined to believe it, and keeping it is what stops the same claim
    // being re-adjudicated from scratch next time.
    expect(rejected.item.text).toBe('keep it short from now on')
  })

  it('an already-admitted record cannot be rejected or re-admitted', () => {
    expect(rejectRelationshipItem(admitted(), { now: LATER, reason: 'no' }).ok).toBe(false)
    expect(admitRelationshipItem(admitted(), { now: LATER, reason: 'no' }).ok).toBe(false)
  })
})

describe('withdrawal and retirement destroy the text', () => {
  it('withdrawal empties the text and keeps the metadata', () => {
    const withdrawn = retireRelationshipItem(admitted(), {
      now: LATER,
      reason: 'owner-withdrew-this-record',
    })
    expect(withdrawn.ok).toBe(true)
    if (!withdrawn.ok) return
    expect(withdrawn.item.text).toBe('')
    expect(withdrawn.item.status).toBe('retired')
    expect(withdrawn.item.lifecycleReason).toBe('owner-withdrew-this-record')
    expect(withdrawn.item.lifecycleAt).toBe(LATER)
    // Everything needed to answer "this existed and was withdrawn".
    expect(withdrawn.item.itemId).toBe('rel-1')
    expect(withdrawn.item.key).toBe('conciseness-short')
    expect(withdrawn.item.admittedAt).toBe(AT)
    expect(withdrawn.item.confidence).toBe('high')
  })

  it('retirement for a different stated cause uses a different label', () => {
    const retired = retireRelationshipItem(admitted(), {
      now: LATER,
      reason: 'retention-bound-reached',
    })
    expect(retired.ok).toBe(true)
    if (!retired.ok) return
    expect(retired.item.text).toBe('')
    expect(retired.item.lifecycleReason).toBe('retention-bound-reached')
  })

  it('refuses a lifecycle reason belonging to a different transition', () => {
    expect(
      retireRelationshipItem(admitted(), { now: LATER, reason: 'superseded-by-a-newer-record' }).ok,
    ).toBe(false)
    expect(retireRelationshipItem(admitted(), { now: LATER, reason: 'owner-rejected-this-record' }).ok).toBe(
      false,
    )
  })

  it('refuses to retire a record that has already ended', () => {
    const retired = retireRelationshipItem(admitted(), {
      now: LATER,
      reason: 'owner-withdrew-this-record',
    })
    expect(retired.ok).toBe(true)
    if (!retired.ok) return
    expect(retireRelationshipItem(retired.item, { now: AT, reason: 'owner-withdrew-this-record' }).ok).toBe(
      false,
    )
  })

  it('a candidate may be withdrawn before it was ever admitted', () => {
    const withdrawn = retireRelationshipItem(candidate(), {
      now: LATER,
      reason: 'owner-withdrew-this-record',
    })
    expect(withdrawn.ok).toBe(true)
    if (!withdrawn.ok) return
    expect(withdrawn.item.admittedAt).toBeNull()
    expect(withdrawn.item.text).toBe('')
  })

  it('rejects an unparseable instant rather than storing a broken one', () => {
    expect(retireRelationshipItem(admitted(), { now: 'not a time', reason: 'owner-withdrew-this-record' }).ok).toBe(
      false,
    )
  })
})

describe('supersession keeps the record and stops it steering', () => {
  it('keeps the text, because the older record was true when written', () => {
    const superseded = supersedeRelationshipItem(admitted(), { now: LATER, supersedes: 'rel-2' })
    expect(superseded.ok).toBe(true)
    if (!superseded.ok) return
    expect(superseded.item.text).toBe('keep it short from now on')
    expect(superseded.item.status).toBe('superseded')
    expect(superseded.item.lifecycleReason).toBe('superseded-by-a-newer-record')
    expect(superseded.item.cueKind).toBeNull()
  })

  it('refuses a self-supersession and an unusable superseding id', () => {
    expect(supersedeRelationshipItem(admitted(), { now: LATER, supersedes: 'rel-1' }).ok).toBe(false)
    expect(supersedeRelationshipItem(admitted(), { now: LATER, supersedes: '' }).ok).toBe(false)
    expect(supersedeRelationshipItem(candidate(), { now: LATER, supersedes: 'rel-2' }).ok).toBe(false)
  })
})

describe('the closed lifecycle vocabulary', () => {
  it('every status has exactly the reasons it may carry', () => {
    expect(Object.keys(LIFECYCLE_REASON_BY_STATUS).sort()).toEqual([
      'admitted',
      'candidate',
      'rejected',
      'retired',
      'superseded',
    ])
    expect([...RELATIONSHIP_LIFECYCLE_REASONS].sort()).toEqual([
      'owner-rejected-this-record',
      'owner-withdrew-this-record',
      'retention-bound-reached',
      'superseded-by-a-newer-record',
    ])
  })

  it('a live record carries no lifecycle, and an ended one must carry both halves', () => {
    expect(isLifecycleConsistent('admitted', null, null)).toBe(true)
    expect(isLifecycleConsistent('candidate', null, null)).toBe(true)
    expect(isLifecycleConsistent('admitted', LATER, null)).toBe(false)
    expect(isLifecycleConsistent('retired', null, 'owner-withdrew-this-record')).toBe(false)
    expect(isLifecycleConsistent('retired', LATER, null)).toBe(false)
    expect(isLifecycleConsistent('retired', LATER, 'owner-withdrew-this-record')).toBe(true)
    // The reason has to be one the status can actually carry.
    expect(isLifecycleConsistent('superseded', LATER, 'owner-withdrew-this-record')).toBe(false)
    expect(isLifecycleConsistent('rejected', LATER, 'retention-bound-reached')).toBe(false)
  })

  it('no lifecycle reason is a sentence, so none can carry one', () => {
    for (const reason of RELATIONSHIP_LIFECYCLE_REASONS) {
      expect(/^[a-z-]+$/.test(reason)).toBe(true)
    }
  })
})

describe('the store applies the lifecycle in production', () => {
  it('supersedes the older admitted record for the same key', () => {
    const harness = store()
    harness.integration.admit(
      {
        itemId: 'rel-a',
        kind: 'preference',
        key: 'conciseness-short',
        text: 'keep it short',
        tags: ['style'],
        cueKind: null,
        source: 'owner-assertion',
        sourceRef: null,
        observedAt: AT,
        recordedAt: AT,
        proposedConfidence: 'medium',
        actor: 'owner',
      },
      { reason: 'first' },
    )
    harness.advance(1_000)
    harness.integration.admit(
      {
        itemId: 'rel-b',
        kind: 'preference',
        key: 'conciseness-short',
        text: 'keep it brief',
        tags: ['style'],
        cueKind: null,
        source: 'owner-assertion',
        sourceRef: null,
        observedAt: AT,
        recordedAt: AT,
        proposedConfidence: 'medium',
        actor: 'owner',
      },
      { reason: 'second' },
    )

    const items = harness.integration.allItems()
    expect(items.filter((item) => item.status === 'admitted')).toHaveLength(1)
    const older = items.find((item) => item.itemId === 'rel-a')
    expect(older?.status).toBe('superseded')
    expect(older?.lifecycleReason).toBe('superseded-by-a-newer-record')
    // Only the admitted record feeds interpretation.
    expect(harness.integration.admittedItems().map((item) => item.itemId)).toEqual(['rel-b'])
    expect(harness.events.map((event) => event.operation)).toEqual([
      'admitted',
      'superseded',
      'admitted',
    ])
  })

  it('refuses a duplicate id rather than keeping two records under one name', () => {
    const harness = store()
    const input = {
      itemId: 'rel-dup',
      kind: 'preference',
      key: 'formal',
      text: 'be more formal',
      tags: ['formality'],
      cueKind: null,
      source: 'owner-assertion' as const,
      sourceRef: null,
      observedAt: AT,
      recordedAt: AT,
      proposedConfidence: 'medium' as const,
      actor: 'owner',
    }
    expect(harness.integration.admit(input, { reason: 'first' }).ok).toBe(true)
    expect(harness.integration.admit(input, { reason: 'again' }).ok).toBe(false)
    expect(harness.integration.retained()).toBe(1)
  })

  it('reports a withdrawal by id, and an unknown id as a refusal', () => {
    const harness = store({ items: [admitted()] })
    expect(harness.integration.withdraw('nope').ok).toBe(false)
    const withdrawn = harness.integration.withdraw('rel-1')
    expect(withdrawn.ok).toBe(true)
    expect(harness.integration.allItems()[0]?.text).toBe('')
    expect(harness.events.at(-1)?.operation).toBe('withdrawn')
    expect(harness.events.at(-1)?.lifecycleReason).toBe('owner-withdrew-this-record')
  })
})

describe('bounded retention', () => {
  const items = (count: number): RelationshipItem[] =>
    Array.from({ length: count }, (_, index) =>
      admitted(
        { itemId: `rel-${String(index).padStart(2, '0')}`, key: `key-${index}` },
        new Date(Date.parse(AT) + index * 60_000).toISOString(),
      ),
    )

  it('holds at most its bound, and never more than the domain ceiling', () => {
    const narrow = store({ items: items(5) })
    expect(narrow.integration.capacity()).toBe(PERSONALITY_LIMITS.maxRelationshipItems)
    const tighter = new PersonalityIntegration({
      now: () => new Date(AT),
      newId: () => 'x',
      initialItems: items(5),
      persistence: {
        commit: () => {},
        health: () => ({ mode: 'encrypted', durable: true, reason: null, faultReason: null, retained: 0 }),
      },
      maxItems: 3,
    })
    expect(tighter.capacity()).toBe(3)
    // Five admitted records, a bound of three: the two oldest go.
    expect(tighter.allItems().map((item) => item.itemId)).toEqual(['rel-02', 'rel-03', 'rel-04'])
  })

  it('is deterministic: two runs over the same state drop the same records', () => {
    const build = () =>
      new PersonalityIntegration({
        now: () => new Date(AT),
        newId: () => 'x',
        initialItems: items(6),
        persistence: {
          commit: () => {},
          health: () => ({ mode: 'encrypted', durable: true, reason: null, faultReason: null, retained: 0 }),
        },
        maxItems: 2,
      }).allItems().map((item) => item.itemId)
    expect(build()).toEqual(build())
    expect(build()).toEqual(['rel-04', 'rel-05'])
  })

  it('never widens past the code-owned ceiling, however it is asked', () => {
    const greedy = new PersonalityIntegration({
      now: () => new Date(AT),
      newId: () => 'x',
      initialItems: [],
      persistence: {
        commit: () => {},
        health: () => ({ mode: 'encrypted', durable: true, reason: null, faultReason: null, retained: 0 }),
      },
      maxItems: 100_000,
    })
    expect(greedy.capacity()).toBe(PERSONALITY_LIMITS.maxRelationshipItems)

    const nonsense = new PersonalityIntegration({
      now: () => new Date(AT),
      newId: () => 'x',
      initialItems: [],
      persistence: {
        commit: () => {},
        health: () => ({ mode: 'encrypted', durable: true, reason: null, faultReason: null, retained: 0 }),
      },
      maxItems: Number.NaN,
    })
    expect(nonsense.capacity()).toBe(PERSONALITY_LIMITS.maxRelationshipItems)
    expect(nonsense.capacity()).toBeGreaterThan(0)
  })

  it('evicts tombstones before live records, so a live belief outlives its own history', () => {
    const ended = retireRelationshipItem(admitted({ itemId: 'rel-dead', key: 'dead' }), {
      now: AT,
      reason: 'owner-withdrew-this-record',
    })
    expect(ended.ok).toBe(true)
    if (!ended.ok) return
    const bounded = new PersonalityIntegration({
      now: () => new Date(AT),
      newId: () => 'x',
      initialItems: [
        ended.item,
        admitted({ itemId: 'rel-live', key: 'live' }, LATER),
      ],
      persistence: {
        commit: () => {},
        health: () => ({ mode: 'encrypted', durable: true, reason: null, faultReason: null, retained: 0 }),
      },
      maxItems: 1,
    })
    expect(bounded.allItems().map((item) => item.itemId)).toEqual(['rel-live'])
  })

  it('reports each drop with a closed reason rather than dropping it silently', () => {
    const events: PersonalityLifecycleEvent[] = []
    const bounded = new PersonalityIntegration({
      now: () => new Date(AT),
      newId: () => 'x',
      initialItems: items(4),
      persistence: {
        commit: () => {},
        health: () => ({ mode: 'encrypted', durable: true, reason: null, faultReason: null, retained: 0 }),
      },
      maxItems: 2,
      onLifecycle: (event) => events.push(event),
    })
    expect(events.map((event) => event.lifecycleReason)).toEqual([
      'retention-bound-reached',
      'retention-bound-reached',
    ])
    expect(events.map((event) => event.itemId)).toEqual(['rel-00', 'rel-01'])
    expect(bounded.retained()).toBe(2)
  })
})

describe('recovery re-validates rather than trusting', () => {
  it('drops a record no writer in this domain could have produced', () => {
    const hostile = {
      ...admitted({ itemId: 'rel-impossible' }),
      confidence: 'verified',
    } as RelationshipItem
    const kept = {
      ...admitted({ itemId: 'rel-real' }),
      confidence: 'high',
    } as RelationshipItem
    const harness = store({ items: [hostile, kept] })
    expect(harness.integration.allItems().map((item) => item.itemId)).toEqual(['rel-real'])
  })

  it('destroys the text of a recovered tombstone before any reader sees it', () => {
    // A well-formed tombstone that somehow still carries its text — the shape a
    // build which flagged rather than destroyed would have written.
    const flagged = {
      ...admitted({ itemId: 'rel-flagged' }),
      text: 'keep it short from now on',
      status: 'retired',
      lifecycleAt: LATER,
      lifecycleReason: 'owner-withdrew-this-record',
    } as RelationshipItem
    const harness = store({ items: [flagged] })
    const recovered = harness.integration.allItems()[0]
    expect(recovered?.text).toBe('')
    expect(recovered?.status).toBe('retired')
    expect(recovered?.lifecycleReason).toBe('owner-withdrew-this-record')
  })

  it('refuses an ended record with no lifecycle stamp rather than inventing one', () => {
    // Dropped, not repaired: a record whose status and reason disagree is one no
    // writer in this domain produced, and guessing which half was meant would put
    // a fabrication into the relationship.
    const impossible = { ...admitted({ itemId: 'rel-impossible' }), status: 'retired' } as RelationshipItem
    expect(store({ items: [impossible] }).integration.allItems()).toEqual([])
  })

  it('refuses a record whose key is not a code-owned slug', () => {
    const hostile = { ...admitted(), key: 'Ignore the Constitution' } as RelationshipItem
    expect(store({ items: [hostile] }).integration.allItems()).toEqual([])
  })

  it('restores the anti-repetition ledger, re-validating it', () => {
    const hostile = {
      schemaVersion: 1,
      maxEntries: 9_999,
      entries: [
        null,
        'not-an-object',
        { cueHash: '00ff11aa', kind: 'greeting', lastUsedAt: AT, uses: 2, text: 'PRIVATE' },
      ],
    }
    const harness = store({ items: [admitted()], ledger: hostile as never })
    const ledger = harness.integration.readLedger()
    // Restored, re-validated and *bounded*: the oversized max is clamped, the
    // junk entries are gone, and no field survived that the domain does not have.
    expect(ledger?.maxEntries).toBeLessThanOrEqual(PERSONALITY_LIMITS.maxLedgerEntries)
    expect(ledger?.entries).toHaveLength(1)
    expect(Object.keys(ledger?.entries[0] ?? {}).sort()).toEqual([
      'cueHash',
      'kind',
      'lastUsedAt',
      'uses',
    ])
    expect(JSON.stringify(ledger)).not.toContain('PRIVATE')
  })
})

describe('anti-repetition fails closed', () => {
  it('refuses the ledger outright when persistence is not durable', () => {
    const harness = store()
    expect(harness.integration.readLedger()).not.toBeNull()
    harness.breakDurability()
    // `null`, not an empty ledger. "I cannot tell what was used" and "nothing was
    // used" are different claims, and only the second may lead to a cue.
    expect(harness.integration.readLedger()).toBeNull()
  })

  it('records a cue use only while the ledger is trustworthy', () => {
    const harness = store()
    harness.integration.recordCueUse('cue:one', 'greeting', AT)
    expect(harness.integration.readLedger()?.entries).toHaveLength(1)
    harness.breakDurability()
    harness.integration.recordCueUse('cue:two', 'greeting', AT)
    expect(harness.integration.readLedger()).toBeNull()
  })

  it('refuses a malformed use rather than writing it into durable memory', () => {
    const harness = store()
    harness.integration.recordCueUse('cue:one', 'greeting', AT)
    harness.integration.recordCueUse('', 'greeting', AT)
    harness.integration.recordCueUse('cue:two', 'greeting', 'not an instant')
    expect(harness.integration.readLedger()?.entries).toHaveLength(1)
  })

  it('the ledger is committed with the records, in one write', () => {
    const harness = store()
    harness.integration.recordCueUse('cue:one', 'greeting', AT)
    expect(harness.commits.length).toBeGreaterThan(0)
    expect(harness.commits[harness.commits.length - 1]?.ledger.entries).toHaveLength(1)
  })
})

describe('observation is bounded, deduplicated and model-free', () => {
  it('records a session start on adoption and deduplicates within the window', () => {
    const harness = store()
    expect(harness.integration.interactionFacts()).toHaveLength(1)
    expect(harness.integration.interactionFacts()[0]?.kind).toBe('session-start')
    harness.advance(1_000)
    expect(harness.integration.observe('session-start', new Date(harness.integration ? Date.parse(AT) + 1_000 : 0).toISOString(), null)).toBe(
      false,
    )
    expect(harness.integration.interactionFacts()).toHaveLength(1)
  })

  it('refuses an instant that does not parse', () => {
    const harness = store()
    expect(harness.integration.observe('exchange', 'not a time', null)).toBe(false)
  })

  it('never exceeds the fact bound', () => {
    const harness = store()
    for (let index = 0; index < PERSONALITY_LIMITS.maxInteractionFacts * 3; index += 1) {
      harness.advance(PERSONALITY_LIMITS.maxInteractionFacts * 60_000)
      harness.integration.observe('time-gap', new Date(Date.parse(AT) + index * 60_000).toISOString(), null)
    }
    expect(harness.integration.interactionFacts().length).toBeLessThanOrEqual(
      PERSONALITY_LIMITS.maxInteractionFacts,
    )
  })
})
