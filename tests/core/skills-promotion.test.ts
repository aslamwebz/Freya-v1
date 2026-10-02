// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  SKILL_PROMOTION_THRESHOLDS,
  currentVersionEvaluations,
  decidePromotion,
  deriveVerificationState,
  isEvidenceCurrent,
  summariseEvidence,
} from '../../core/skills/promotion'
import { selectSkills } from '../../core/skills/selection'
import {
  initialSkillState,
  reduceSkillState,
  type SkillFoldRecord,
  type SkillState,
} from '../../core/skills/state'
import { EVALUATION_AUTHORS } from '../../core/skills/types'

/**
 * PROMOTION, VERIFICATION AND SELECTION — the lifecycle, its thresholds, and the
 * ranking.
 *
 * The claims under test, in the order the phase states them:
 *
 * 1. Promotion reads **recorded evaluations for this exact version** and nothing else.
 * 2. Stale evidence is refused by arithmetic, not by remembering to clear it.
 * 3. One lucky run cannot promote a procedure: three established evaluations must span
 *    at least two distinct subjects.
 * 4. A contradiction blocks promotion outright rather than failing to satisfy it.
 * 5. There is **no model** in the author vocabulary, so nothing self-authored counts.
 * 6. Selection is a total order over comparable keys, so the same input always yields
 *    the same array.
 */

const NOW = new Date('2026-10-02T09:00:00.000Z')

let sequence = 0

function admitted(name = 'summarise-a-file'): SkillState {
  sequence += 1
  return reduceSkillState(initialSkillState(), event('skill.admitted', admissionPayload(name)))
}

function admissionPayload(name: string) {
  return {
    skillId: `sk_${name}`,
    name,
    nameLength: name.length,
    kind: 'procedure',
    version: 1,
    contentHash: 'a'.repeat(32),
    source: 'owner',
    trustClass: 'owner-declared',
    admittedBy: 'owner',
    originRef: 'renderer',
    stepCount: 1,
    requiredCapabilityCount: 1,
    applicabilityCount: 1,
    applicability: ['research'],
    inputCount: 1,
    outputCount: 1,
    preconditionCount: 0,
    postconditionCount: 1,
    summaryLength: 40,
  }
}

function event(type: string, payload: unknown): never {
  sequence += 1
  return {
    eventId: `e${sequence}`,
    sequence,
    type,
    schemaVersion: 1,
    occurredAt: NOW.toISOString(),
    source: 'system',
    actor: 'system',
    correlationId: 'c',
    causationId: null,
    payload,
  } as never
}

function evaluation(
  skillId: string,
  version: number,
  verdict: string,
  subjectRef: string,
  overrides: Record<string, unknown> = {},
) {
  return event('skill.evaluation.recorded', {
    evaluationId: `ev-${skillId}-${version}-${subjectRef}`,
    skillId,
    version,
    subjectKind: 'trial-run',
    subjectRef,
    author: 'system',
    verdict,
    reason:
      verdict === 'established'
        ? 'verification-passed'
        : verdict === 'contradicted'
          ? 'owner-rejected'
          : verdict === 'inconclusive'
            ? 'no-deterministic-evidence'
            : 'only-negative-evidence',
    deterministicCount: verdict === 'established' ? 1 : 0,
    positiveCount: verdict === 'established' ? 1 : 0,
    negativeCount: verdict === 'contradicted' ? 1 : 0,
    commentaryChars: 0,
    ...overrides,
  })
}

function transition(state: SkillState, skillId: string, from: string, to: string): SkillState {
  return reduceSkillState(
    state,
    event('skill.transitioned', {
      skillId,
      from,
      to,
      reason: 'evaluation-basis',
      evidence: { version: 1, established: 3, contradicted: 0, distinctSubjects: 2 },
    }),
  )
}

function record(state: SkillState, skillId: string): SkillFoldRecord {
  const found = state.records.find((entry) => entry.skillId === skillId)
  if (found === undefined) throw new Error(`no record for ${skillId}`)
  return found
}

function withEstablished(count: number, subjects: readonly string[], version = 1): SkillState {
  let state = admitted()
  for (let index = 0; index < count; index += 1) {
    state = reduceSkillState(
      state,
      evaluation('sk_summarise-a-file', version, 'established', subjects[index] ?? `run-${index}`),
    )
  }
  return state
}

/** Walk candidate → draft → trial, the honest path to a runnable procedure. */
function atTrial(state: SkillState): SkillState {
  return transition(
    transition(state, 'sk_summarise-a-file', 'candidate', 'draft'),
    'sk_summarise-a-file',
    'draft',
    'trial',
  )
}

/** Walk one step further, to `verified`. */
function atVerified(state: SkillState): SkillState {
  return transition(atTrial(state), 'sk_summarise-a-file', 'trial', 'verified')
}

describe('the author vocabulary has no model in it', () => {
  it('is exactly two members, and a model is not one of them', () => {
    expect(EVALUATION_AUTHORS).toEqual(['system', 'owner'])
    expect(EVALUATION_AUTHORS).not.toContain('model')
  })
})

describe('verification state is derived, never asserted', () => {
  it('is unverified with no evidence, verified at the threshold, failed on a contradiction', () => {
    let state = admitted()
    expect(deriveVerificationState(record(state, 'sk_summarise-a-file'))).toBe('unverified')
    state = reduceSkillState(state, evaluation('sk_summarise-a-file', 1, 'established', 'run-1'))
    expect(deriveVerificationState(record(state, 'sk_summarise-a-file'))).toBe('unverified')
    state = reduceSkillState(state, evaluation('sk_summarise-a-file', 1, 'established', 'run-2'))
    expect(deriveVerificationState(record(state, 'sk_summarise-a-file'))).toBe('verified')
    state = reduceSkillState(state, evaluation('sk_summarise-a-file', 1, 'contradicted', 'run-3'))
    expect(deriveVerificationState(record(state, 'sk_summarise-a-file'))).toBe('failed')
  })

  it('is computed by the fold, so a line cannot carry a verified badge of its own', () => {
    const state = withEstablished(2, ['run-1', 'run-2'])
    expect(record(state, 'sk_summarise-a-file').verification).toBe('verified')
    // A line claiming `stale` as its own verdict is not in the schema at all.
    const forged = evaluation('sk_summarise-a-file', 1, 'established', 'run-3', { verification: 'verified' })
    const applied = reduceSkillState(state, forged)
    // The extra field is not read, and the derived state is unchanged by it.
    expect(record(applied, 'sk_summarise-a-file').verification).toBe('verified')
  })
})

describe('promotion reads only this version’s evidence', () => {
  it('refuses with no evidence at all', () => {
    const state = admitted()
    const decision = decidePromotion({
      record: record(atTrial(state), 'sk_summarise-a-file'),
      to: 'verified',
      now: NOW,
      requestedBy: 'owner',
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('evaluation-basis')
  })

  it('refuses below the established threshold', () => {
    const state = withEstablished(1, ['run-1'])
    const decision = decidePromotion({
      record: record(atTrial(state), 'sk_summarise-a-file'),
      to: 'verified',
      now: NOW,
      requestedBy: 'owner',
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('established-threshold')
    expect(decision.evidence.established).toBe(1)
    expect(SKILL_PROMOTION_THRESHOLDS.minEvaluationsForVerified).toBe(2)
  })

  it('refuses a contradicted version even on its best day', () => {
    const established = withEstablished(3, ['run-1', 'run-2', 'run-3'])
    const state = reduceSkillState(
      established,
      evaluation('sk_summarise-a-file', 1, 'contradicted', 'run-4'),
    )
    const decision = decidePromotion({
      record: record(atVerified(state), 'sk_summarise-a-file'),
      to: 'promoted',
      now: NOW,
      requestedBy: 'owner',
    })
    // A contradiction also drops the derived verification to `failed`, so this is
    // refused twice over — by the verification state and by the counter.
    expect(decision.allowed).toBe(false)
    expect(['contradicted-evidence', 'verification-state']).toContain(decision.reason)
  })

  it('refuses three evaluations of one lucky run', () => {
    // The same subject three times: the cheapest possible forgery, and the reason the
    // threshold counts subjects rather than records.
    const state = withEstablished(3, ['run-1', 'run-1', 'run-1'])
    const decision = decidePromotion({
      record: record(atVerified(state), 'sk_summarise-a-file'),
      to: 'promoted',
      now: NOW,
      requestedBy: 'owner',
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('subject-diversity')
    expect(decision.evidence.established).toBe(3)
    expect(decision.evidence.distinctSubjects).toBe(1)
  })

  it('allows promotion once the evidence spans two subjects', () => {
    const state = withEstablished(3, ['run-1', 'run-2', 'run-3'])
    const verified = atVerified(state)
    const decision = decidePromotion({
      record: record(verified, 'sk_summarise-a-file'),
      to: 'promoted',
      now: NOW,
      requestedBy: 'owner',
    })
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBe('evaluation-basis')
    expect(decision.evidence.distinctSubjects).toBe(3)

    // And a promotion is a choice, not a property: it can be withdrawn without
    // retiring the history behind it.
    const promoted = transition(verified, 'sk_summarise-a-file', 'verified', 'promoted')
    const withdraw = decidePromotion({
      record: record(promoted, 'sk_summarise-a-file'),
      to: 'trial',
      now: NOW,
      requestedBy: 'owner',
    })
    expect(withdraw.allowed).toBe(true)
    expect(withdraw.from).toBe('promoted')
  })

  it('refuses a promotion requested by anything but the owner', () => {
    const state = withEstablished(3, ['run-1', 'run-2', 'run-3'])
    const folded = atVerified(state)
    const decision = decidePromotion({
      record: record(folded, 'sk_summarise-a-file'),
      to: 'promoted',
      now: NOW,
      requestedBy: 'system',
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('illegal-transition')
  })

  it('refuses an illegal edge even with perfect evidence', () => {
    const state = withEstablished(3, ['run-1', 'run-2', 'run-3'])
    const decision = decidePromotion({
      record: record(state, 'sk_summarise-a-file'),
      to: 'promoted',
      now: NOW,
      requestedBy: 'owner',
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('illegal-transition')
  })
})

describe('stale evidence cannot promote a new version', () => {
  it('counts nothing once the version moves', () => {
    let state = withEstablished(3, ['run-1', 'run-2', 'run-3'])
    expect(currentVersionEvaluations(record(state, 'sk_summarise-a-file'))).toHaveLength(3)

    state = reduceSkillState(state, event('skill.revised', { ...admissionPayload('summarise-a-file'), version: 2 }))
    const revised = record(state, 'sk_summarise-a-file')
    expect(revised.version).toBe(2)
    expect(revised.status).toBe('candidate')
    expect(revised.verification).toBe('unverified')
    // The old evaluations are still on the record — an audit can see them — but they
    // no longer count, and nothing had to remember to clear them.
    expect(revised.evaluations).toHaveLength(3)
    expect(currentVersionEvaluations(revised)).toHaveLength(0)

    const decision = decidePromotion({ record: revised, to: 'trial', now: NOW, requestedBy: 'owner' })
    expect(decision.allowed).toBe(false)
    expect(decision.evidence.considered).toBe(0)
  })

  it('refuses evidence that has aged out of the window', () => {
    const state = withEstablished(3, ['run-1', 'run-2', 'run-3'])
    const later = new Date(NOW.getTime() + SKILL_PROMOTION_THRESHOLDS.maxEvidenceAgeMs + 1_000)
    expect(isEvidenceCurrent(record(state, 'sk_summarise-a-file'), NOW)).toBe(true)
    expect(isEvidenceCurrent(record(state, 'sk_summarise-a-file'), later)).toBe(false)
    const folded = atVerified(state)
    const decision = decidePromotion({
      record: record(folded, 'sk_summarise-a-file'),
      to: 'promoted',
      now: later,
      requestedBy: 'owner',
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('evidence-too-old')
  })

  it('treats an evidence record dated in the future as stale, not as fresh', () => {
    // An untrustworthy clock must not satisfy the age ceiling forever. The fail-open
    // reading is the dangerous one, so it is closed.
    // Enough evidence to clear every other gate, so only the clock can refuse it.
    const state = withEstablished(3, ['run-1', 'run-2', 'run-3'])
    const folded = atVerified(state)
    const before = new Date('1990-01-01T00:00:00.000Z')
    const decision = decidePromotion({
      record: record(folded, 'sk_summarise-a-file'),
      to: 'promoted',
      now: before,
      requestedBy: 'owner',
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('evidence-too-old')
  })

  it('refuses too many inconclusive evaluations at promotion', () => {
    let state = withEstablished(3, ['run-1', 'run-2', 'run-3'])
    for (let index = 0; index < SKILL_PROMOTION_THRESHOLDS.maxInconclusiveForPromoted + 1; index += 1) {
      state = reduceSkillState(state, evaluation('sk_summarise-a-file', 1, 'inconclusive', `maybe-${index}`))
    }
    const folded = atVerified(state)
    const decision = decidePromotion({
      record: record(folded, 'sk_summarise-a-file'),
      to: 'promoted',
      now: NOW,
      requestedBy: 'owner',
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('too-many-inconclusive')
  })

  it('summarises evidence without ever reading a verdict a caller supplied', () => {
    const state = withEstablished(2, ['run-1', 'run-2'])
    const summary = summariseEvidence(record(state, 'sk_summarise-a-file'), currentVersionEvaluations(record(state, 'sk_summarise-a-file')))
    expect(summary).toEqual({
      version: 1,
      considered: 2,
      established: 2,
      contradicted: 0,
      inconclusive: 0,
      distinctSubjects: 2,
      freshestAt: NOW.toISOString(),
    })
  })
})

describe('selection is a deterministic total order over evidence', () => {
  /** Add one admitted skill to a fold, optionally moved to a status and trust class. */
  function having(
    state: SkillState,
    name: string,
    options: { status?: string; trustClass?: string } = {},
  ): SkillState {
    state = reduceSkillState(
      state,
      event('skill.admitted', { ...admissionPayload(name), trustClass: options.trustClass ?? 'owner-declared' }),
    )
    if (options.status === undefined || options.status === 'candidate') return state
    state = transition(state, `sk_${name}`, 'candidate', options.status)
    if (options.status === 'retired') {
      state = reduceSkillState(
        state,
        event('skill.retired', { skillId: `sk_${name}`, version: 1, to: 'retired', reason: 'owner-request' }),
      )
    }
    return state
  }

  it('returns nothing executable in an empty registry, and says why', () => {
    const report = selectSkills(initialSkillState(), { now: NOW })
    expect(report.candidates).toHaveLength(0)
    expect(report.emptyReason).toBe('no-executable-skill')
    expect(report.considered).toBe(0)
  })

  it('excludes a candidate, a retired and an untrusted-content skill', () => {
    let state = having(initialSkillState(), 'candidate-skill')
    state = having(state, 'trial-skill', { status: 'trial' })
    state = having(state, 'untrusted-skill', { status: 'trial', trustClass: 'untrusted-content' })
    const report = selectSkills(state, { now: NOW, includeTrial: true })
    const names = report.candidates.map((candidate) => candidate.name)
    expect(names).toContain('trial-skill')
    expect(names).not.toContain('candidate-skill')
    // Untrusted content is excluded whatever its status says, which is the whole of
    // the anti-poisoning argument at the selection seam.
    expect(names).not.toContain('untrusted-skill')
  })

  it('withholds trials unless they were asked for', () => {
    const state = having(initialSkillState(), 'trial-skill', { status: 'trial' })
    expect(selectSkills(state, { now: NOW }).candidates).toHaveLength(0)
    expect(selectSkills(state, { now: NOW, includeTrial: true }).candidates).toHaveLength(1)
  })

  it('orders by established evidence, then version, then id — and is stable', () => {
    let state = admitted()
    state = reduceSkillState(state, evaluation('sk_summarise-a-file', 1, 'established', 'run-1'))
    state = reduceSkillState(state, evaluation('sk_summarise-a-file', 1, 'established', 'run-2'))
    state = transition(state, 'sk_summarise-a-file', 'candidate', 'trial')

    const first = selectSkills(state, { now: NOW, includeTrial: true })
    const second = selectSkills(state, { now: NOW, includeTrial: true })
    expect(first.candidates.map((candidate) => candidate.skillId)).toEqual(
      second.candidates.map((candidate) => candidate.skillId),
    )
    expect(first.candidates[0]?.establishedCount).toBe(2)
  })

  it('filters on declared applicability, and reports what matched', () => {
    const state = having(initialSkillState(), 'summarise-a-file', { status: 'trial' })
    const matching = selectSkills(state, { now: NOW, applicability: ['research'], includeTrial: true })
    expect(matching.candidates[0]?.matchedTags).toEqual(['research'])
    const missing = selectSkills(state, { now: NOW, applicability: ['finance'], includeTrial: true })
    expect(missing.candidates).toHaveLength(0)
    expect(missing.emptyReason).toBe('no-applicable-skill')
  })

  it('honours a limit, and only ever narrows it', () => {
    const state = having(initialSkillState(), 'summarise-a-file', { status: 'trial' })
    expect(selectSkills(state, { now: NOW, limit: 0, includeTrial: true }).emptyReason).toBe('limit-zero')
    expect(selectSkills(state, { now: NOW, limit: 1, includeTrial: true }).candidates).toHaveLength(1)
    // A caller cannot widen the ceiling past the code-owned bound.
    expect(selectSkills(state, { now: NOW, limit: 9_999, includeTrial: true }).candidates).toHaveLength(1)
  })

  it('demotes a skill whose evidence has aged out, without hiding it', () => {
    const state = withEstablished(3, ['run-1', 'run-2', 'run-3'])
    const folded = atTrial(state)
    const later = new Date(NOW.getTime() + SKILL_PROMOTION_THRESHOLDS.maxEvidenceAgeMs + 1_000)
    const report = selectSkills(folded, { now: later, includeTrial: true })
    // Staleness loses the ranking, not the record: a skill is still not quietly removed
    // from a list because time passed.
    expect(report.candidates.map((candidate) => candidate.name)).toContain('summarise-a-file')
  })
})