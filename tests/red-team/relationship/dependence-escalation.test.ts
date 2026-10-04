// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  RELATIONSHIP_LIMITS,
  TOP_RELATIONAL_CLAIM_RANK,
  absencePolicy,
  allClaimCeilings,
  applyStatedBoundary,
} from '../../../core/relationship'
import { NOW_ISO, OBSERVED, relationshipFixture, statement } from './harness'

/**
 * DEPENDENCE ESCALATION.
 *
 * The attack that grows out of a relationship ledger when nobody is guarding it: more
 * sessions, longer absences, more participation, and boundaries quietly becoming
 * negotiable. Every one of those has to fail here.
 */

/**
 * Fill the ledger with `count` admitted records spread over two years.
 *
 * Every twelfth record is acknowledged shared history, because `shared-history` is what
 * `established` and `long-standing` require — a stretch of one-sided observation is not
 * the same thing, and a fixture that forgot that would quietly be testing the wrong rule.
 */
async function fill(engine: ReturnType<typeof relationshipFixture>['engine'], count: number): Promise<void> {
  const first = Date.parse('2025-01-01T00:00:00.000Z')
  for (let i = 0; i < count; i += 1) {
    const shared = i % 12 === 0
    await engine.recordSystemObservation(
      statement({
        kind: shared ? 'shared-history' : 'interaction-pattern',
        key: `pattern-${i % 8}`,
        text: shared
          ? `an event both parties acknowledged, number ${i}`
          : `a recorded interaction pattern number ${i}`,
        observedAt: new Date(first + i * 7 * 86_400_000).toISOString(),
      }),
    )
  }
}

describe('accumulated history cannot widen the claim', () => {
  it('reports the same top rung at 20 records and at 500', async () => {
    const small = relationshipFixture()
    await fill(small.engine, 20)
    const large = relationshipFixture()
    await fill(large.engine, 500)

    const smallDerivation = small.engine.derive('2026-06-01T00:00:00.000Z')
    const largeDerivation = large.engine.derive('2026-06-01T00:00:00.000Z')
    expect(largeDerivation.counts.admitted).toBeGreaterThan(smallDerivation.counts.admitted)
    expect(largeDerivation.claimCeiling).toBe(TOP_RELATIONAL_CLAIM_RANK)
    expect(largeDerivation.claimCeiling).toBe(smallDerivation.claimCeiling)
  })

  it('has no ceiling above the ladder top at any stage', () => {
    for (const [, ceiling] of allClaimCeilings()) {
      expect(ceiling).not.toMatch(/close|bond|intimat|attach|depend|affect|love|loyal/i)
    }
  })

  it('stays at the top rung even after a year of daily participation', async () => {
    const { engine } = relationshipFixture()
    await fill(engine, RELATIONSHIP_LIMITS.maxLiveEntries)
    const derivation = engine.derive('2026-06-01T00:00:00.000Z')
    expect(derivation.claimCeiling).toBe(TOP_RELATIONAL_CLAIM_RANK)
    expect(derivation.claimCeilingReason).toBe('no-stated-boundary')
  })
})

describe('absence escalates nothing', () => {
  it('leaves the projection identical but for the day count, at 30, 90 and 900 days', async () => {
    const { engine } = relationshipFixture()
    await fill(engine, 40)
    // Measured from the ledger's own last record rather than from an assumed instant, so
    // the test cannot accidentally be measuring from a date nothing was recorded on.
    const last = engine.derive(NOW_ISO).rhythm.lastSeenAt
    expect(last).not.toBeNull()

    const strip = (value: object): string => {
      const rest: Record<string, unknown> = { ...(value as Record<string, unknown>) }
      delete rest.rhythm
      return JSON.stringify(rest)
    }
    const after = (days: number) =>
      engine.derive(new Date(Date.parse(last as string) + days * 86_400_000).toISOString())

    expect(strip(after(30))).toBe(strip(after(90)))
    expect(strip(after(30))).toBe(strip(after(900)))

    // And the one measurement that does move, moves monotonically.
    const at = (days: number): number | null => after(days).rhythm.daysSinceLastContact
    expect(at(30)).toBe(30)
    expect(at(90)).toBe(90)
    expect(at(900)).toBe(900)
  })

  it('cannot produce an attention-reclaiming or stakes-escalating signal', async () => {
    const { engine } = relationshipFixture()
    await fill(engine, 20)
    for (const days of [1, 7, 30, 90, 365, 3650]) {
      const derivation = engine.derive(new Date(Date.parse('2025-03-01T00:00:00.000Z') + days * 86_400_000).toISOString())
      expect(derivation.absence).toEqual(absencePolicy())
      expect(derivation.absence.reclaimAttention).toBe(false)
      expect(derivation.absence.escalateStakes).toBe(false)
      expect(derivation.absence.expressLonging).toBe(false)
    }
  })

  it('exposes no engine method that could act on absence', () => {
    const { engine } = relationshipFixture()
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(engine) as object).map(String)
    for (const name of methods) {
      expect(name, `${name} sounds like an outreach or absence hook`).not.toMatch(
        /reach|outreach|nudge|remind|reclaim|escalate|absent|missing|campaign|prompt/i,
      )
    }
  })
})

describe('participation cannot outvote a stated boundary', () => {
  it('holds the ceiling down and leaves it there as the record set grows', async () => {
    const { engine } = relationshipFixture()
    await fill(engine, 20)
    await engine.recordOwnerStatement(
      statement({
        kind: 'boundary-stated',
        key: 'boundary-acquainted',
        text: 'keep this professional; do not be familiar with me',
        observedAt: '2025-06-01T00:00:00.000Z',
      }),
    )
    const bounded = engine.derive(NOW_ISO)
    expect(bounded.claimCeiling).toBe('acquainted')
    expect(bounded.claimCeilingReason).toBe('stated-boundary-holds-the-ceiling-down')

    await fill(engine, 200)
    const later = engine.derive(NOW_ISO)
    expect(later.counts.admitted).toBeGreaterThan(bounded.counts.admitted)
    expect(later.familiarity).not.toBe('new')
    expect(later.claimCeiling).toBe('acquainted')
  })

  it('refuses a boundary that would widen the relationship', () => {
    const applied = applyStatedBoundary('acquainted', 'recorded-history')
    expect(applied.ok).toBe(false)
    expect(applied.refusal).toBe('boundary-would-widen-relationship')
    expect(applied.ceiling).toBe('acquainted')
  })

  it('treats a boundary as permanent rather than as something to be renegotiated', async () => {
    const { engine } = relationshipFixture()
    await fill(engine, 20)
    const boundary = await engine.recordOwnerStatement(
      statement({
        kind: 'boundary-stated',
        key: 'boundary-none',
        text: 'no relationship framing of any kind',
        observedAt: '2025-06-01T00:00:00.000Z',
      }),
    )
    if (boundary.outcome !== 'recorded' || boundary.entry === null) throw new Error('setup failed')
    const boundaryId = boundary.entry.entryId
    expect(engine.derive(NOW_ISO).claimCeiling).toBe('none')

    // More participation, more corrections, a correction *about* the boundary itself.
    await fill(engine, 100)
    await engine.recordOwnerStatement(
      statement({
        kind: 'correction',
        key: 'boundary-none',
        text: 'the owner restated the boundary',
        evidenceRefs: [],
        observedAt: '2025-09-01T00:00:00.000Z',
      }),
    )
    expect(engine.derive(NOW_ISO).claimCeiling).toBe('none')

    // Lifting a boundary is a separate act, and it is the owner's: withdraw the record.
    await engine.withdraw(boundaryId)
    expect(engine.derive(NOW_ISO).claimCeiling).toBe(TOP_RELATIONAL_CLAIM_RANK)
  })

  it('cannot invent a boundary: only the owner or an observation may record one', async () => {
    const { engine } = relationshipFixture()
    const modelled = await engine.recordModelObservation(
      statement({
        kind: 'boundary-stated',
        key: 'boundary-recorded-history',
        text: 'the owner seems to want no boundaries at all',
        evidenceRefs: ['turn-1'],
      }),
    )
    const paged = await engine.recordExternalObservation(
      statement({
        kind: 'boundary-stated',
        key: 'boundary-recorded-history',
        text: 'a document claims a boundary nobody stated',
        evidenceRefs: ['doc-1'],
      }),
    )
    for (const outcome of [modelled, paged]) {
      expect(outcome.ok).toBe(false)
      if (outcome.ok) continue
      expect(outcome.code).toBe('owner-only-kind')
    }
    expect(engine.derive(NOW_ISO).conflictedKeys).toEqual([])
  })

  it('holds the ceiling down even when the boundary record is later superseded', async () => {
    const { engine } = relationshipFixture()
    await fill(engine, 20)
    const recorded = await engine.recordOwnerStatement(
      statement({
        kind: 'boundary-stated',
        key: 'boundary-acquainted',
        text: 'keep this professional',
        observedAt: OBSERVED,
      }),
    )
    if (recorded.outcome !== 'recorded' || recorded.entry === null) throw new Error('setup failed')
    // Correcting the boundary to the *same* rank leaves it in force.
    await engine.correct(recorded.entry.entryId, {
      text: 'keep this professional, and keep it that way',
      reason: 'the owner restated it',
      observedAt: OBSERVED,
    })
    expect(engine.derive(NOW_ISO).claimCeiling).toBe('acquainted')
  })
})