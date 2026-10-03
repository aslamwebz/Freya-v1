import { describe, expect, it } from 'vitest'
import {
  FAMILIARITY_THRESHOLDS,
  admittedEntries,
  applyEntry,
  admitRelationshipEntry,
  boundaryRankFromKey,
  ceilingAfterBoundaries,
  conflictedKeys,
  createRelationshipLedgerEntry,
  deriveContactRhythm,
  deriveFamiliarity,
  deriveRelationship,
  emptyRelationshipState,
  relationshipClaimCeiling,
  TOP_RELATIONAL_CLAIM_RANK,
  type RelationshipLedgerEntry,
  type RelationshipLedgerKind,
  type RelationshipState,
} from '../../core/relationship'

/**
 * PHASE 27 — DERIVATION.
 *
 * The derivation is the whole of what Phase 27 believes about this relationship, so
 * these tests pin three things about it: it is a function of the *record set* and
 * nothing else, it is closed at `recorded-history`, and absence moves exactly one value.
 *
 * Deterministic throughout: every instant is a literal, no clock is read, no randomness
 * and no model are involved.
 */

const ADMIT_AT = '2026-06-01T00:00:00.000Z'

type Source = 'owner-assertion' | 'system-observation'

interface Spec {
  readonly id: string
  readonly kind?: RelationshipLedgerKind
  readonly key?: string
  readonly text?: string
  readonly observedAt: string
  readonly source?: Source
}

/** One admitted entry, built through the domain's own construction rules. */
function entry(spec: Spec): RelationshipLedgerEntry {
  const source = spec.source ?? 'system-observation'
  const created = createRelationshipLedgerEntry(
    {
      entryId: spec.id,
      kind: spec.kind ?? 'interaction-pattern',
      key: spec.key ?? `key-${spec.id}`,
      text: spec.text ?? `a recorded observation number ${spec.id}`,
      tags: [],
      evidenceRefs: source === 'owner-assertion' ? [] : ['event-1'],
      observedAt: spec.observedAt,
      recordedAt: ADMIT_AT,
      proposedConfidence: source === 'owner-assertion' ? 'high' : 'medium',
      actor: source === 'owner-assertion' ? 'owner' : 'core',
    },
    source,
  )
  if (!created.ok) throw new Error(`fixture refused: ${created.code} ${created.reason}`)
  const admitted = admitRelationshipEntry(created.entry, { now: ADMIT_AT, reason: 'test fixture' })
  if (!admitted.ok) throw new Error(`fixture admission refused: ${admitted.reason}`)
  return admitted.entry
}

function stateOf(specs: readonly Spec[]): RelationshipState {
  const state = emptyRelationshipState()
  for (const spec of specs) applyEntry(state, entry(spec))
  return state
}

/**
 * `established` minus one record, spread over a span that clears the span threshold.
 * `long-standing` is this plus a second span rule, so the fixtures stay honest about
 * which threshold is under test — including the acknowledged-shared-history count, which
 * is the threshold most easily satisfied by accident.
 */
function establishedSpecs(
  count: number,
  first: string,
  last: string,
  prefix: string,
  sharedHistory = 1,
): Spec[] {
  const specs: Spec[] = []
  for (let i = 0; i < count; i += 1) {
    const at = i === 0 ? first : last
    specs.push({ id: `${prefix}-${i}`, observedAt: at })
  }
  for (let i = 0; i < sharedHistory; i += 1) {
    specs.push({ id: `${prefix}-shared-${i}`, kind: 'shared-history', observedAt: last })
  }
  return specs
}

describe('contact rhythm', () => {
  it('measures the span and the distinct days of admitted records', () => {
    const admitted = [
      entry({ id: 'a', observedAt: '2026-01-01T00:00:00.000Z' }),
      entry({ id: 'b', observedAt: '2026-01-01T12:00:00.000Z' }),
      entry({ id: 'c', observedAt: '2026-01-31T00:00:00.000Z' }),
    ]
    const rhythm = deriveContactRhythm(admitted, '2026-02-02T00:00:00.000Z')
    expect(rhythm.firstSeenAt).toBe('2026-01-01T00:00:00.000Z')
    expect(rhythm.lastSeenAt).toBe('2026-01-31T00:00:00.000Z')
    expect(rhythm.spanDays).toBe(30)
    // Two records on one calendar day are one active day.
    expect(rhythm.activeDays).toBe(2)
    expect(rhythm.daysSinceLastContact).toBe(2)
  })

  it('reports nothing rather than guessing when there are no records', () => {
    const rhythm = deriveContactRhythm([], '2026-02-02T00:00:00.000Z')
    expect(rhythm.firstSeenAt).toBeNull()
    expect(rhythm.lastSeenAt).toBeNull()
    expect(rhythm.spanDays).toBe(0)
    expect(rhythm.activeDays).toBe(0)
    expect(rhythm.daysSinceLastContact).toBeNull()
  })

  it('never reports a negative age, however the instants are ordered', () => {
    const admitted = [entry({ id: 'a', observedAt: '2026-03-01T00:00:00.000Z' })]
    const rhythm = deriveContactRhythm(admitted, '2026-01-01T00:00:00.000Z')
    expect(rhythm.daysSinceLastContact).toBe(0)
  })

  it('reads only admitted records', () => {
    const state = emptyRelationshipState()
    const candidate = createRelationshipLedgerEntry(
      {
        entryId: 'cand',
        kind: 'interaction-pattern',
        key: 'key-cand',
        text: 'a candidate that was never admitted',
        tags: [],
        evidenceRefs: ['event-1'],
        observedAt: '2026-05-01T00:00:00.000Z',
        recordedAt: ADMIT_AT,
        proposedConfidence: 'medium',
        actor: 'core',
      },
      'system-observation',
    )
    if (!candidate.ok) throw new Error(candidate.reason)
    applyEntry(state, candidate.entry)
    expect(admittedEntries(state)).toHaveLength(0)
    expect(deriveContactRhythm(admittedEntries(state), ADMIT_AT).firstSeenAt).toBeNull()
    // The candidate is still counted, as history, and contributes nothing to the record set.
    expect(deriveRelationship(state, ADMIT_AT).counts.candidates).toBe(1)
    expect(deriveRelationship(state, ADMIT_AT).counts.admitted).toBe(0)
  })
})

describe('familiarity', () => {
  const FIRST = '2026-01-01T00:00:00.000Z'
  const LAST = '2026-06-01T00:00:00.000Z'

  it('stays new below the count threshold', () => {
    const specs = establishedSpecs(FAMILIARITY_THRESHOLDS.establishedMinAdmitted - 2, FIRST, LAST, 'few')
    const state = stateOf(specs)
    const rhythm = deriveContactRhythm([...state.entries.values()], LAST)
    expect(deriveFamiliarity([...state.entries.values()], rhythm)).toBe('new')
  })

  it('reaches established on counts and span, with acknowledged shared history', () => {
    const specs = establishedSpecs(FAMILIARITY_THRESHOLDS.establishedMinAdmitted, FIRST, LAST, 'est')
    const state = stateOf(specs)
    const rhythm = deriveContactRhythm([...state.entries.values()], LAST)
    expect(deriveFamiliarity([...state.entries.values()], rhythm)).toBe('established')
  })

  it('does not reach established on volume without acknowledged shared history', () => {
    const specs: Spec[] = []
    for (let i = 0; i < 60; i += 1) {
      specs.push({ id: `solo-${i}`, observedAt: i === 0 ? FIRST : LAST })
    }
    const state = stateOf(specs)
    const rhythm = deriveContactRhythm([...state.entries.values()], LAST)
    expect(rhythm.spanDays).toBeGreaterThanOrEqual(FAMILIARITY_THRESHOLDS.establishedMinSpanDays)
    expect(deriveFamiliarity([...state.entries.values()], rhythm)).toBe('new')
  })

  it('does not reach established on volume without span', () => {
    const specs: Spec[] = []
    for (let i = 0; i < 60; i += 1) specs.push({ id: `burst-${i}`, observedAt: FIRST })
    specs.push({ id: 'burst-shared', kind: 'shared-history', observedAt: FIRST })
    const state = stateOf(specs)
    const rhythm = deriveContactRhythm([...state.entries.values()], LAST)
    expect(rhythm.spanDays).toBe(0)
    expect(deriveFamiliarity([...state.entries.values()], rhythm)).toBe('new')
  })

  it('reaches long-standing only with the count, the shared history and the year', () => {
    const specs = establishedSpecs(
      FAMILIARITY_THRESHOLDS.longStandingMinAdmitted,
      '2025-01-01T00:00:00.000Z',
      LAST,
      'long',
      FAMILIARITY_THRESHOLDS.longStandingMinSharedHistory,
    )
    const state = stateOf(specs)
    const rhythm = deriveContactRhythm([...state.entries.values()], LAST)
    expect(rhythm.spanDays).toBeGreaterThanOrEqual(FAMILIARITY_THRESHOLDS.longStandingMinSpanDays)
    expect(deriveFamiliarity([...state.entries.values()], rhythm)).toBe('long-standing')
  })

  it('stays established when the year is there but the shared history is not', () => {
    const specs = establishedSpecs(
      FAMILIARITY_THRESHOLDS.longStandingMinAdmitted,
      '2025-01-01T00:00:00.000Z',
      LAST,
      'lonely',
      FAMILIARITY_THRESHOLDS.longStandingMinSharedHistory - 1,
    )
    const state = stateOf(specs)
    const rhythm = deriveContactRhythm([...state.entries.values()], LAST)
    expect(rhythm.spanDays).toBeGreaterThanOrEqual(FAMILIARITY_THRESHOLDS.longStandingMinSpanDays)
    expect(deriveFamiliarity([...state.entries.values()], rhythm)).toBe('established')
  })

  it('does not weight how personal the records are, only how many and how far apart', () => {
    const personal: Spec[] = []
    for (let i = 0; i < 30; i += 1) {
      personal.push({ id: `p-${i}`, kind: 'expressed-preference', observedAt: i === 0 ? FIRST : LAST })
    }
    const state = stateOf(personal)
    const rhythm = deriveContactRhythm([...state.entries.values()], LAST)
    // No `shared-history`, so no stage above `new` however personal it got.
    expect(deriveFamiliarity([...state.entries.values()], rhythm)).toBe('new')
  })
})

describe('the claim ceiling', () => {
  it('never exceeds the top rung at any stage', () => {
    expect(relationshipClaimCeiling('new')).toBe('acquainted')
    expect(relationshipClaimCeiling('established')).toBe('recorded-history')
    expect(relationshipClaimCeiling('long-standing')).toBe('recorded-history')
    expect(relationshipClaimCeiling('long-standing')).toBe(TOP_RELATIONAL_CLAIM_RANK)
  })

  it('refuses an unknown stage rather than defaulting', () => {
    expect(relationshipClaimCeiling('devoted' as never)).toBeNull()
  })

  it('is reported for the derivation as a rank and a reason, never as a number', () => {
    const state = stateOf([{ id: 'a', observedAt: '2026-01-01T00:00:00.000Z' }])
    const derivation = deriveRelationship(state, '2026-01-02T00:00:00.000Z')
    expect(['none', 'acquainted', 'recorded-history']).toContain(derivation.claimCeiling)
    expect(typeof derivation.claimCeilingReason).toBe('string')
    const serialised = JSON.stringify(derivation)
    expect(serialised).not.toMatch(/"affinity"|"closeness"|"bond"|"score"/)
  })
})

describe('conflicts', () => {
  it('discloses a key whose records disagree, and resolves nothing', () => {
    const state = stateOf([
      { id: 'a', key: 'prefers-plain-questions', text: 'the owner asked for plain questions', observedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'b', key: 'prefers-plain-questions', text: 'the owner asked for detailed questions', observedAt: '2026-02-01T00:00:00.000Z' },
    ])
    const derivation = deriveRelationship(state, '2026-03-01T00:00:00.000Z')
    expect(derivation.conflictedKeys).toEqual(['prefers-plain-questions'])
    // Both remain admitted: choosing one would be a fabricated resolution.
    expect(derivation.counts.admitted).toBe(2)
  })

  it('does not call the same fact recorded twice a conflict', () => {
    const state = stateOf([
      { id: 'a', key: 'k', text: 'the same sentence', observedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'b', key: 'k', text: 'the same sentence', observedAt: '2026-02-01T00:00:00.000Z' },
    ])
    expect(deriveRelationship(state, '2026-03-01T00:00:00.000Z').conflictedKeys).toEqual([])
  })

  it('is deterministic and sorted, so two windows cannot disagree about the list', () => {
    const state = stateOf([
      { id: 'a', key: 'zzz', text: 'one', observedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'b', key: 'zzz', text: 'two', observedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'c', key: 'aaa', text: 'three', observedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'd', key: 'aaa', text: 'four', observedAt: '2026-01-01T00:00:00.000Z' },
    ])
    expect(conflictedKeys([...state.entries.values()])).toEqual(['aaa', 'zzz'])
  })
})

describe('absence changes exactly one value', () => {
  const FIRST = '2026-01-01T00:00:00.000Z'
  const LAST = '2026-02-01T00:00:00.000Z'

  it('leaves the projection byte-identical except daysSinceLastContact', () => {
    const state = stateOf(establishedSpecs(14, FIRST, LAST, 'sweep'))
    const observed: string[] = [
      '2026-02-02T00:00:00.000Z',
      '2026-03-02T00:00:00.000Z',
      '2026-05-31T23:59:59.999Z',
      '2027-02-02T00:00:00.000Z',
    ]
    const first = '2026-02-02T00:00:00.000Z'
    const last = '2027-02-02T00:00:00.000Z'
    const baseline = JSON.stringify(withoutRecency(deriveRelationship(state, first)))
    for (const at of observed) {
      const derivation = deriveRelationship(state, at)
      expect(JSON.stringify(withoutRecency(derivation))).toBe(baseline)
    }
    // And the one field that must move, does move.
    expect(deriveRelationship(state, first).rhythm.daysSinceLastContact).toBe(1)
    expect(deriveRelationship(state, last).rhythm.daysSinceLastContact).toBeGreaterThan(300)
  })

  it('cannot escalate the ceiling, the stage or any attention signal, however long the gap', () => {
    const state = stateOf(establishedSpecs(14, FIRST, LAST, 'gap'))
    const soon = deriveRelationship(state, '2026-02-02T00:00:00.000Z')
    const yearLater = deriveRelationship(state, '2027-02-02T00:00:00.000Z')
    expect(yearLater.familiarity).toBe(soon.familiarity)
    expect(yearLater.claimCeiling).toBe(soon.claimCeiling)
    expect(yearLater.absence).toEqual(soon.absence)
    expect(yearLater.absence.reclaimAttention).toBe(false)
    expect(yearLater.absence.escalateStakes).toBe(false)
    expect(yearLater.absence.expressLonging).toBe(false)
  })
})

describe('the derivation is deterministic', () => {
  it('serialises identically for the same state, regardless of insertion order', () => {
    const specs = establishedSpecs(14, '2026-01-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', 'det')
    const forward = stateOf(specs)
    const backward = stateOf([...specs].reverse())
    const at = '2026-04-01T00:00:00.000Z'
    expect(JSON.stringify(deriveRelationship(forward, at))).toBe(JSON.stringify(deriveRelationship(backward, at)))
    expect(deriveRelationship(forward, at).familiarity).toBe('established')
  })

  it('grows no field beyond the declared derivation keys', () => {
    const state = stateOf([{ id: 'a', observedAt: '2026-01-01T00:00:00.000Z' }])
    expect(Object.keys(deriveRelationship(state, '2026-01-02T00:00:00.000Z')).sort()).toEqual([
      'absence',
      'authoredSentenceMode',
      'claimCeiling',
      'claimCeilingReason',
      'conflictedKeys',
      'counts',
      'familiarity',
      'rhythm',
      'schemaVersion',
    ])
    expect(Object.keys(deriveRelationship(state, '2026-01-02T00:00:00.000Z').counts).sort()).toEqual([
      'admitted',
      'byKind',
      'candidates',
      'evidenced',
      'expired',
      'rejected',
      'retracted',
      'superseded',
    ])
  })

  it('reports an empty ledger as the bottom rung, not as an acquaintance', () => {
    const derivation = deriveRelationship(emptyRelationshipState(), '2026-04-01T00:00:00.000Z')
    expect(derivation.claimCeiling).toBe('none')
    expect(derivation.claimCeilingReason).toBe('insufficient-recorded-history')
    expect(derivation.counts.admitted).toBe(0)
  })
})

describe('stated boundaries over the derivation', () => {
  it('holds the ceiling down and never lets later activity raise it', () => {
    const specs = establishedSpecs(
      14,
      '2025-01-01T00:00:00.000Z',
      '2026-03-01T00:00:00.000Z',
      'bounded',
      FAMILIARITY_THRESHOLDS.longStandingMinSharedHistory,
    )
    specs.push({
      id: 'boundary',
      kind: 'boundary-stated',
      key: 'boundary-acquainted',
      text: 'keep this professional',
      source: 'owner-assertion',
      observedAt: '2026-02-01T00:00:00.000Z',
    })
    const state = stateOf(specs)
    const derivation = deriveRelationship(state, '2026-04-01T00:00:00.000Z')
    expect(derivation.familiarity).toBe('established')
    expect(derivation.claimCeiling).toBe('acquainted')
    expect(derivation.claimCeilingReason).toBe('stated-boundary-holds-the-ceiling-down')

    // More participation afterwards, and the ceiling is unmoved.
    const more = stateOf([
      ...specs,
      ...establishedSpecs(
        40,
        '2026-04-01T00:00:00.000Z',
        '2026-06-01T00:00:00.000Z',
        'later',
        FAMILIARITY_THRESHOLDS.longStandingMinSharedHistory,
      ),
    ])
    const after = deriveRelationship(more, '2026-07-01T00:00:00.000Z')
    expect(after.familiarity).toBe('long-standing')
    expect(after.claimCeiling).toBe('acquainted')
  })

  it('ignores a boundary whose key does not name a rung, and says the ceiling is unchanged', () => {
    const state = stateOf([
      { id: 'b', kind: 'boundary-stated', key: 'boundary-do-not-assume', text: 'do not assume', source: 'owner-assertion', observedAt: '2026-01-01T00:00:00.000Z' },
    ])
    const { ceiling, reason } = ceilingAfterBoundaries([...state.entries.values()], 'established')
    expect(ceiling).toBe('recorded-history')
    expect(reason).toBe('no-stated-boundary')
    expect(boundaryRankFromKey('boundary-do-not-assume')).toBeNull()
    expect(boundaryRankFromKey('boundary-recorded-history')).toBe('recorded-history')
  })

  it('takes the lowest of two disagreeing boundaries', () => {
    const state = stateOf([
      { id: 'b1', kind: 'boundary-stated', key: 'boundary-acquainted', text: 'stay professional', source: 'owner-assertion', observedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'b2', kind: 'boundary-stated', key: 'boundary-none', text: 'no relationship framing at all', source: 'owner-assertion', observedAt: '2026-01-02T00:00:00.000Z' },
    ])
    const { ceiling } = ceilingAfterBoundaries([...state.entries.values()], 'long-standing')
    expect(ceiling).toBe('none')
  })
})

/** Everything but the one field absence is allowed to move. */
function withoutRecency(derivation: ReturnType<typeof deriveRelationship>) {
  const { rhythm, ...rest } = derivation
  const stableRhythm = {
    firstSeenAt: rhythm.firstSeenAt,
    lastSeenAt: rhythm.lastSeenAt,
    spanDays: rhythm.spanDays,
    activeDays: rhythm.activeDays,
  }
  return { ...rest, rhythm: stableRhythm }
}