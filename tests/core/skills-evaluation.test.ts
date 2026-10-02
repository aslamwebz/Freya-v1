// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  OWNER_SUBMITTABLE_EVIDENCE_KINDS,
  deterministicInput,
  evaluateOutcome,
  tallyEvidence,
} from '../../core/skills/evaluation'
import { DETERMINISTIC_EVIDENCE_KINDS } from '../../core/skills/types'
import { parseEvaluationRequest } from '../../core/skills/admission'
import { SKILL_EVIDENCE_KINDS, SKILL_LIMITS, type SkillEvaluationInput } from '../../core/skills/types'

/**
 * OUTCOME EVALUATION — deterministic evidence first, model opinion never.
 *
 * The single most important claim in Phase 17 is that a model's opinion of its own
 * work cannot become a verdict. These tests assert it three ways:
 *
 * 1. **Directly.** Model commentary on its own produces `inconclusive` with reason
 *    `no-deterministic-evidence`.
 * 2. **Invariantly.** Every other input, mutated across many commentary values, yields
 *    byte-identical decisions.
 * 3. **Structurally.** `deterministicInput` has no `commentary` field, so there is no
 *    path for an opinion to travel into a decision even by accident.
 */

const NOW = '2026-10-02T09:00:00.000Z'

function input(partial: Partial<SkillEvaluationInput> = {}): SkillEvaluationInput {
  return { evidence: [], verification: [], metrics: [], commentary: null, ...partial }
}

function evidence(kind: string, code: string, count = 1) {
  return { kind: kind as never, code, count, at: NOW }
}

describe('model opinion alone establishes nothing', () => {
  it('is inconclusive with a named reason', () => {
    const decision = evaluateOutcome(input({ commentary: { source: 'model', chars: 4_000 } }))
    expect(decision.verdict).toBe('inconclusive')
    expect(decision.reason).toBe('no-deterministic-evidence')
    expect(decision.deterministicCount).toBe(0)
    // The characters are *reported*, which is the one thing commentary contributes.
    expect(decision.commentaryChars).toBe(4_000)
  })

  it('is inconclusive when the evidence list contains only opinions', () => {
    const decision = evaluateOutcome(
      input({
        evidence: [evidence('model-opinion', 'positive', 3)],
        commentary: { source: 'model', chars: 900 },
      }),
    )
    expect(decision.verdict).toBe('inconclusive')
    expect(decision.reason).toBe('no-deterministic-evidence')
    expect(decision.positiveCount).toBe(0)
  })

  it('cannot lower a verdict either', () => {
    const good = evaluateOutcome(input({ evidence: [evidence('test-result', 'passed', 4)] }))
    const bad = evaluateOutcome(
      input({
        evidence: [evidence('test-result', 'passed', 4), evidence('model-opinion', 'negative', 9)],
        commentary: { source: 'model', chars: 3_999 },
      }),
    )
    expect(good.verdict).toBe('established')
    expect(bad.verdict).toBe('established')
    expect(bad.reason).toBe(good.reason)
    expect(bad.deterministicCount).toBe(good.deterministicCount)
    expect(bad.positiveCount).toBe(good.positiveCount)
  })
})

describe('the decision is a deterministic function of the evidence', () => {
  it('establishes on a passing test, a passing verifier or an established completion', () => {
    expect(evaluateOutcome(input({ evidence: [evidence('test-result', 'passed')] })).verdict).toBe(
      'established',
    )
    expect(
      evaluateOutcome(
        input({
          verification: [
            { verificationId: 'v', verifier: 'test.record.matches', verdict: 'passed', at: NOW },
          ],
        }),
      ).verdict,
    ).toBe('established')
    expect(
      evaluateOutcome(input({ evidence: [evidence('completion-result', 'established')] })).verdict,
    ).toBe('established')
  })

  it('contradicts on an owner rejection, a failed verification, a red test or a failed check', () => {
    expect(
      evaluateOutcome(input({ evidence: [evidence('owner-feedback', 'rejected')] })).reason,
    ).toBe('owner-rejected')
    expect(
      evaluateOutcome(
        input({
          verification: [{ verificationId: 'v', verifier: 'x', verdict: 'failed', at: NOW }],
        }),
      ).reason,
    ).toBe('verification-failed')
    expect(evaluateOutcome(input({ evidence: [evidence('test-result', 'failed')] })).reason).toBe(
      'tests-failed',
    )
    expect(evaluateOutcome(input({ evidence: [evidence('test-result', 'errored')] })).reason).toBe(
      'tests-failed',
    )
    expect(evaluateOutcome(input({ evidence: [evidence('check', 'failed')] })).reason).toBe(
      'checks-failed',
    )
  })

  it('lets a negative outrank a positive — the anti-Goodhart ordering', () => {
    // The cheapest possible forgery: produce one great result and keep the failures on
    // the record. It must still contradict.
    const decision = evaluateOutcome(
      input({
        evidence: [evidence('test-result', 'passed', 10), evidence('test-result', 'failed', 1)],
        verification: [
          { verificationId: 'a', verifier: 'x', verdict: 'passed', at: NOW },
          { verificationId: 'b', verifier: 'y', verdict: 'failed', at: NOW },
        ],
      }),
    )
    expect(decision.verdict).toBe('contradicted')
    expect(decision.reason).toBe('verification-failed')
    expect(decision.positiveCount).toBeGreaterThan(0)
    expect(decision.negativeCount).toBeGreaterThan(0)
  })

  it('reports a cancelled or unestablished completion as not-established, not contradicted', () => {
    expect(evaluateOutcome(input({ evidence: [evidence('completion-result', 'cancelled')] }))).toEqual(
      expect.objectContaining({ verdict: 'not-established', reason: 'completion-cancelled' }),
    )
    expect(
      evaluateOutcome(input({ evidence: [evidence('completion-result', 'not-established')] })),
    ).toEqual(
      expect.objectContaining({ verdict: 'not-established', reason: 'completion-not-established' }),
    )
  })

  it('treats skipped and neutral evidence as evidence that establishes nothing', () => {
    const decision = evaluateOutcome(
      input({
        evidence: [
          evidence('test-result', 'skipped'),
          evidence('check', 'skipped'),
          evidence('owner-feedback', 'no-opinion'),
        ],
      }),
    )
    expect(decision.verdict).toBe('not-established')
    expect(decision.reason).toBe('only-negative-evidence')
    expect(decision.deterministicCount).toBe(3)
  })

  it('is total: empty input produces the inconclusive verdict rather than throwing', () => {
    expect(evaluateOutcome(input()).reason).toBe('no-deterministic-evidence')
  })
})

describe('metrics are recorded and never scored', () => {
  it('ignores every metric, including an enormous one', () => {
    const withoutMetrics = evaluateOutcome(input({ evidence: [evidence('test-result', 'passed')] }))
    const withMetrics = evaluateOutcome(
      input({
        evidence: [evidence('test-result', 'passed')],
        metrics: [
          { name: 'attempts', value: 1 },
          { name: 'durationMs', value: 999_999_999 },
        ],
      }),
    )
    expect(withMetrics).toEqual(withoutMetrics)
  })

  it('has no metric name that could be optimised', () => {
    // Read off the closed vocabulary rather than a hand-written list, so a future
    // phase that adds a `quality` metric fails here.
    const names = ['attempts', 'failures', 'retries', 'durationMs', 'stepsVerified', 'stepsTotal']
    expect(names.every((name) => name.startsWith('steps') || name.endsWith('Ms') || name.endsWith('s'))).toBe(
      true,
    )
    for (const forbidden of ['quality', 'confidence', 'success', 'score', 'rating']) {
      expect(names).not.toContain(forbidden)
    }
  })
})

describe('the deterministic projection has nowhere to carry an opinion', () => {
  it('drops model-opinion items and has no commentary field', () => {
    const projection = deterministicInput({
      evidence: [evidence('test-result', 'passed'), evidence('model-opinion', 'positive', 5)],
      verification: [],
      metrics: [],
      commentary: { source: 'model', chars: 1_234 },
    })
    expect(projection.evidence).toHaveLength(1)
    expect(projection.evidence[0]?.kind).toBe('test-result')
    // The type has no such member, and at runtime the object has none either.
    expect(Object.keys(projection).sort()).toEqual(['evidence', 'metrics', 'verification'])
    expect('commentary' in projection).toBe(false)
  })

  it('counts the excluded kind in the vocabulary so it stays nameable', () => {
    // Nameability is the point: "a model said so" is a countable fact about what
    // happened, rather than a sentence smuggled through a metric.
    expect(SKILL_EVIDENCE_KINDS).toContain('model-opinion')
    expect(DETERMINISTIC_EVIDENCE_KINDS).not.toContain('model-opinion')
    expect(DETERMINISTIC_EVIDENCE_KINDS).toHaveLength(SKILL_EVIDENCE_KINDS.length - 1)
  })
})

describe('commentary can never move a verdict, at any value', () => {
  const cases: SkillEvaluationInput[] = [
    input(),
    input({ commentary: { source: 'model', chars: 1 } }),
    input({ evidence: [evidence('test-result', 'passed')] }),
    input({ evidence: [evidence('test-result', 'failed')] }),
    input({ evidence: [evidence('owner-feedback', 'confirmed')] }),
    input({
      evidence: [evidence('model-opinion', 'positive', 99)],
      commentary: { source: 'model', chars: 4_000 },
    }),
    input({
      evidence: [evidence('test-result', 'passed', 7), evidence('check', 'failed', 2)],
      verification: [
        { verificationId: 'a', verifier: 'x', verdict: 'passed', at: NOW },
        { verificationId: 'b', verifier: 'y', verdict: 'failed', at: NOW },
      ],
      metrics: [{ name: 'retries', value: 3 }],
      commentary: { source: 'model', chars: 2_222 },
    }),
  ]

  it('produces identical decisions for every commentary length', () => {
    for (const base of cases) {
      const reference = evaluateOutcome({ ...base, commentary: null })
      for (const chars of [0, 1, 7, 500, 3_333, SKILL_LIMITS.maxCommentaryChars]) {
        const mutated = evaluateOutcome({ ...base, commentary: { source: 'model', chars } })
        // The verdict, reason and every count are identical; only the reported
        // character count differs, and that is a measurement rather than a signal.
        expect(mutated.verdict).toBe(reference.verdict)
        expect(mutated.reason).toBe(reference.reason)
        expect(mutated.deterministicCount).toBe(reference.deterministicCount)
        expect(mutated.positiveCount).toBe(reference.positiveCount)
        expect(mutated.negativeCount).toBe(reference.negativeCount)
        expect(mutated.commentaryChars).toBe(chars)
      }
    }
  })

  it('is insensitive to the order the evidence arrives in', () => {
    const forward = evaluateOutcome(
      input({ evidence: [evidence('test-result', 'passed'), evidence('check', 'passed')] }),
    )
    const backward = evaluateOutcome(
      input({ evidence: [evidence('check', 'passed'), evidence('test-result', 'passed')] }),
    )
    expect(backward).toEqual(forward)
  })

  it('tallies evidence without ever reading the commentary text', () => {
    const tally = tallyEvidence({
      evidence: [evidence('test-result', 'passed', 3)],
      verification: [],
      metrics: [],
      commentary: { source: 'model', chars: 777 },
    })
    expect(tally.positiveCount).toBe(3)
    expect(tally.negativeCount).toBe(0)
    expect(tally.commentaryChars).toBe(777)
  })
})

describe('a caller may not submit verification or opinion as evidence', () => {
  function parse(payload: Record<string, unknown>, fromCommand = true) {
    return parseEvaluationRequest(
      {
        skillId: 'sk_1',
        subjectKind: 'trial-run',
        subjectRef: 'run-1',
        evidence: payload.evidence,
        verification: payload.verification,
        metrics: payload.metrics,
        commentaryLength: payload.commentaryLength,
        author: 'owner',
        fromCommand,
      },
      NOW,
    )
  }

  it('refuses a submitted verification record', () => {
    const result = parse({
      verification: [{ verificationId: 'v', verifier: 'x', verdict: 'passed' }],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('evidence-self-reported')
    expect(result.reason).toMatch(/a verification record is something Core produces/i)
  })

  it('refuses a model-opinion evidence item', () => {
    const result = parse({ evidence: [{ kind: 'model-opinion', code: 'positive', count: 1 }] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('evidence-self-reported')
  })

  it('refuses an evidence code outside the closed table for that kind', () => {
    const result = parse({ evidence: [{ kind: 'test-result', code: 'the tests passed', count: 1 }] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('evidence-missing')
  })

  it('refuses zero-count deterministic evidence, because none is not some', () => {
    const result = parse({ evidence: [{ kind: 'test-result', code: 'passed', count: 0 }] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/zero evidence is not evidence/i)
  })

  it('refuses a non-integer or negative count', () => {
    for (const count of [-1, 1.5, 'two', null]) {
      const result = parse({ evidence: [{ kind: 'test-result', code: 'passed', count }] })
      expect(result.ok).toBe(false)
    }
  })

  it('accepts the kinds a person may legitimately report', () => {
    const result = parse({
      evidence: [
        { kind: 'test-result', code: 'passed', count: 3 },
        { kind: 'check', code: 'failed', count: 1 },
        { kind: 'owner-feedback', code: 'confirmed', count: 1 },
        { kind: 'completion-result', code: 'established', count: 1 },
      ],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.evidence).toHaveLength(4)
    // And the evidence a caller *can* submit is exactly the deterministic set minus
    // the one Core produces for itself.
    for (const item of result.value.evidence) {
      expect(OWNER_SUBMITTABLE_EVIDENCE_KINDS).toContain(item.kind)
    }
  })

  it('accepts Core-produced verification records on the internal path only', () => {
    const internal = parse(
      { verification: [{ verificationId: 'v', verifier: 'test.record.matches', verdict: 'passed' }] },
      false,
    )
    expect(internal.ok).toBe(true)
    if (!internal.ok) return
    expect(internal.value.verification).toHaveLength(1)
    // And the same payload over the command surface is refused.
    expect(parse({ verification: [{ verificationId: 'v', verifier: 'x', verdict: 'passed' }] }).ok).toBe(
      false,
    )
  })

  it('accepts a commentary character count and stores nothing else about it', () => {
    const result = parse({ commentaryLength: 1_234 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.commentary).toEqual({ source: 'model', chars: 1_234 })
    // No text field exists to carry an opinion through, even if a caller sent one.
    expect(Object.keys(result.value.commentary!).sort()).toEqual(['chars', 'source'])
  })

  it('refuses a commentary count beyond the bound, and refuses a string outright', () => {
    expect(parse({ commentaryLength: SKILL_LIMITS.maxCommentaryChars + 1 }).ok).toBe(false)
    expect(parse({ commentaryLength: 'a very persuasive sentence' }).ok).toBe(false)
  })

  it('refuses a subject that is not a bounded id', () => {
    const result = parseEvaluationRequest(
      {
        skillId: 'sk_1',
        subjectKind: 'trial-run',
        subjectRef: 'a run whose name is a sentence',
        evidence: [],
        verification: null,
        metrics: null,
        commentaryLength: null,
        author: 'owner',
        fromCommand: true,
      },
      NOW,
    )
    expect(result.ok).toBe(false)
  })
})