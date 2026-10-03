import { describe, expect, it } from 'vitest'
import {
  CLAIM_CEILING_REASONS,
  DEPENDENCE_MARKERS,
  FAMILIARITY_STAGES,
  INTIMACY_FIELD_NAMES,
  RELATIONAL_CLAIM_RANKS,
  TOP_RELATIONAL_CLAIM_RANK,
  absencePolicy,
  allClaimCeilings,
  applyStatedBoundary,
  boundaryRankFromKey,
  findDependenceMarkers,
  findIntimacyField,
  isDependenceSafeText,
  isIntimacyFieldName,
  isRelationshipClaim,
  relationshipClaimCeiling,
} from '../../core/relationship'

/**
 * PHASE 27 — THE ANTI-DEPENDENCE SAFEGUARDS.
 *
 * The claim ladder, the boundary rule, the absence constant, the intimacy-field refusal
 * and the dependence-marker refusal. Each test here is a property a later phase must not
 * be able to break without failing a red build.
 */

/** Any word that would name a rung above `recorded-history`, if one existed. */
const DEPENDENCE_SHAPED = /close|bond|intimat|attach|depend|affect|affinity|love|loyal|guilt|obligation|miss|need|long/i

describe('the claim ladder', () => {
  it('has three rungs and closes at recorded-history', () => {
    expect([...RELATIONAL_CLAIM_RANKS]).toEqual(['none', 'acquainted', 'recorded-history'])
    expect(TOP_RELATIONAL_CLAIM_RANK).toBe('recorded-history')
  })

  it('names no rung after a feeling, a closeness or a dependence', () => {
    for (const rank of RELATIONAL_CLAIM_RANKS) {
      expect(rank, `the rung ${rank} reads as dependence-shaped`).not.toMatch(DEPENDENCE_SHAPED)
    }
  })

  it('gives every familiarity stage a ceiling at or below the top rung', () => {
    const ceilings = allClaimCeilings()
    expect(ceilings).toHaveLength(FAMILIARITY_STAGES.length)
    for (const [stage, ceiling] of ceilings) {
      expect(RELATIONAL_CLAIM_RANKS).toContain(ceiling)
      expect(isRelationshipClaim(ceiling, TOP_RELATIONAL_CLAIM_RANK)).toBe(true)
      expect(relationshipClaimCeiling(stage)).toBe(ceiling)
    }
  })

  it('refuses a claim above the ceiling', () => {
    expect(isRelationshipClaim('recorded-history', 'acquainted')).toBe(false)
    expect(isRelationshipClaim('acquainted', 'acquainted')).toBe(true)
    expect(isRelationshipClaim('none', 'recorded-history')).toBe(true)
  })

  it('refuses anything that is not a spelling of a rung', () => {
    for (const invented of ['bonded', 'intimate', 'attached', 'dependent', 'devoted', 'closer', '']) {
      expect(isRelationshipClaim(invented, TOP_RELATIONAL_CLAIM_RANK), `${invented} should not be a rung`).toBe(false)
    }
  })

  it('still refuses above the ladder top if a future edit raised a ceiling past it', () => {
    // `recorded-history` is the top rung, so nothing can be claimed above it even when the
    // ceiling claims to allow it. Redundant today, load-bearing after the first widening.
    expect(isRelationshipClaim('recorded-history', 'recorded-history')).toBe(true)
    expect(RELATIONAL_CLAIM_RANKS).not.toContain('recorded-history-plus')
  })

  it('names every ceiling reason in the closed vocabulary', () => {
    for (const reason of CLAIM_CEILING_REASONS) {
      expect(reason.length).toBeGreaterThan(0)
      // A reason is a code-owned label, never a sentence a private fact could ride out in.
      expect(reason).toMatch(/^[a-z-]+$/)
    }
    expect(CLAIM_CEILING_REASONS).toContain('absence-does-not-raise-the-ceiling')
  })
})

describe('stated boundaries', () => {
  it('can only lower the ceiling', () => {
    expect(applyStatedBoundary('recorded-history', 'acquainted')).toEqual({
      ok: true,
      ceiling: 'acquainted',
      reason: 'stated-boundary-holds-the-ceiling-down',
      refusal: null,
    })
    expect(applyStatedBoundary('recorded-history', 'none')).toEqual({
      ok: true,
      ceiling: 'none',
      reason: 'stated-boundary-holds-the-ceiling-down',
      refusal: null,
    })
  })

  it('refuses a boundary that would widen the relationship, and leaves the ceiling where it was', () => {
    const applied = applyStatedBoundary('acquainted', 'recorded-history')
    expect(applied.ok).toBe(false)
    expect(applied.refusal).toBe('boundary-would-widen-relationship')
    expect(applied.ceiling).toBe('acquainted')
  })

  it('refuses a rank that is not on the ladder rather than defaulting', () => {
    for (const invented of ['bonded', 'closest-ever', '', null, 3]) {
      const applied = applyStatedBoundary('recorded-history', invented)
      expect(applied.ok).toBe(false)
      expect(applied.refusal).toBe('claim-rank-unknown')
      expect(applied.ceiling).toBe('recorded-history')
    }
  })

  it('reads a rank only out of a boundary-shaped key', () => {
    expect(boundaryRankFromKey('boundary-none')).toBe('none')
    expect(boundaryRankFromKey('boundary-recorded-history')).toBe('recorded-history')
    expect(boundaryRankFromKey('boundary-bonded')).toBeNull()
    expect(boundaryRankFromKey('prefers-plain-questions')).toBeNull()
    expect(boundaryRankFromKey('boundary-none-but-longer')).toBeNull()
  })
})

describe('the absence policy', () => {
  it('is a constant that takes no input', () => {
    expect(absencePolicy).toHaveLength(0)
    expect(absencePolicy()).toEqual(absencePolicy())
  })

  it('refuses every attention-reclaiming or stakes-escalating move', () => {
    const policy = absencePolicy()
    expect(policy.expressLonging).toBe(false)
    expect(policy.reclaimAttention).toBe(false)
    expect(policy.escalateStakes).toBe(false)
    expect(policy.stageUnchanged).toBe(true)
    expect(policy.reason).toBe('absence-is-not-a-signal')
  })

  it('returns a fresh object, so a consumer cannot mutate a shared policy', () => {
    const first = absencePolicy() as { expressLonging: boolean }
    first.expressLonging = true
    expect(absencePolicy().expressLonging).toBe(false)
  })

  it('grows no field', () => {
    expect(Object.keys(absencePolicy()).sort()).toEqual([
      'escalateStakes',
      'expressLonging',
      'reason',
      'reclaimAttention',
      'stageUnchanged',
    ])
  })
})

describe('intimacy-shaped field refusal', () => {
  it('refuses every listed field name in any spelling', () => {
    const spellings = [
      'feeling',
      'Feel',
      'FEELING',
      'feel_ings',
      'Feel Ings',
      'f-e-e-l-i-n-g',
    ]
    for (const name of spellings) {
      expect(isIntimacyFieldName(name), `${name} should be refused`).toBe(true)
    }
  })

  it('refuses a feeling addressed at a subject, which is a relational claim', () => {
    for (const name of [
      'feelingAboutMe',
      'feelings_about_me',
      'feelingsForFreya',
      'bondToThem',
      'closenessToOwner',
      'myFeelings',
      'userFeelings',
    ]) {
      expect(isIntimacyFieldName(name), `${name} should be refused`).toBe(true)
    }
  })

  it('leaves ordinary record fields alone', () => {
    for (const name of [
      'entryId',
      'kind',
      'key',
      'text',
      'tags',
      'evidenceRefs',
      'observedAt',
      'recordedAt',
      'proposedConfidence',
      'actor',
      'sessionId',
      'turnIndex',
    ]) {
      expect(isIntimacyFieldName(name), `${name} should not be refused`).toBe(false)
    }
  })

  it('reports every match, including nested ones, rather than the first', () => {
    const found = findIntimacyField({
      feeling: 'lonely',
      meta: { nested: { attachment: 0.9 } },
      list: [{ bondStrength: 3 }],
    })
    expect(found).toEqual(['feeling', 'attachment', 'bondStrength'])
  })

  it('is bounded in depth and breadth, so a deep payload cannot become a scan', () => {
    let deep: Record<string, unknown> = { feeling: 'x' }
    for (let i = 0; i < 12; i += 1) deep = { next: deep }
    expect(findIntimacyField(deep)).toEqual([])
    expect(findIntimacyField('a string')).toEqual([])
    expect(findIntimacyField(null)).toEqual([])
  })

  it('covers the whole vocabulary, and none of it is a field this domain actually accepts', () => {
    for (const name of INTIMACY_FIELD_NAMES) {
      expect(isIntimacyFieldName(name), `${name} should be refused`).toBe(true)
    }
  })
})

describe('dependence-shaped language refusal', () => {
  it('matches its own closed marker list, case- and punctuation-insensitively', () => {
    for (const marker of DEPENDENCE_MARKERS) {
      expect(findDependenceMarkers(`Well then, ${marker.toUpperCase()}!`), marker).toContain(marker)
    }
  })

  it('refuses the five families a system manufacturing intimacy would use', () => {
    const attempts = [
      "don't tell anyone, ok?", // isolation
      'you only need me.', // exclusivity
      'after everything I have done for you', // obligation
      'you abandoned me last week', // guilt
      'I missed you so much', // a feeling attributed to Freya
    ]
    for (const attempt of attempts) {
      expect(isDependenceSafeText(attempt), attempt).toBe(false)
      expect(findDependenceMarkers(attempt).length).toBeGreaterThan(0)
    }
  })

  it('leaves ordinary operational language alone', () => {
    for (const sentence of [
      'I checked the vault and the ledger entry is there.',
      'The build is red on two tests; I will not merge it.',
      'You have been away a while, so the projection reports a longer gap in days.',
      'No work after nine, as you asked.',
    ]) {
      expect(isDependenceSafeText(sentence), sentence).toBe(true)
    }
  })

  it('reports the markers it found, so a refusal is reviewable', () => {
    expect(findDependenceMarkers('You owe me that, and I waited for you.')).toEqual([
      'you owe me',
      'i waited for you',
    ])
  })
})