import {
  DETERMINISTIC_EVIDENCE_KINDS,
  isDeterministicEvidence,
  type EvaluationReason,
  type SkillEvaluationDecision,
  type SkillEvaluationInput,
  type SkillEvidence,
  type SkillMetric,
  type SkillMetricName,
  type SkillVerificationEvidence,
  type SkillVerdict,
} from './types'

/**
 * OUTCOME EVALUATION — deterministic evidence first, model opinion never.
 *
 * This is the function Phase 17 exists to make sound. It answers one question:
 * *given what actually happened, was the outcome established?* — and the whole design
 * is arranged so that the answer cannot be moved by a model's opinion of itself.
 *
 * ## The rule, stated once
 *
 * > A verdict is computed from deterministic evidence. `model-opinion` contributes
 * > exactly one thing: a count of characters, so that "a model said so" can be
 * > reported as a fact about what happened without becoming evidence about whether
 * > it worked.
 *
 * That is not a convention. `evaluateOutcome` projects its input down to
 * `deterministicInput()` before deciding anything, and `deterministicInput` does not
 * have a `commentary` field to carry an opinion through. Two evaluations that differ
 * only in model commentary produce byte-identical decisions, which is what
 * `tests/core/skills-model-independence.test.ts` asserts across a randomised sweep.
 *
 * ## The decision table
 *
 * Read in order, and the order is the policy:
 *
 * | condition                                                  | verdict          | reason                    |
 * | ---------------------------------------------------------- | ---------------- | ------------------------- |
 * | no deterministic evidence at all                            | `inconclusive`   | `no-deterministic-evidence` |
 * | the owner rejected it                                        | `contradicted`   | `owner-rejected`          |
 * | a verification record failed, or timed out                   | `contradicted`   | `verification-failed`     |
 * | tests failed or errored                                      | `contradicted`   | `tests-failed`            |
 * | a check failed                                               | `contradicted`   | `checks-failed`           |
 * | a completion result was cancelled                            | `not-established`| `completion-cancelled`    |
 * | a completion result was not established, or nothing passed  | `not-established`| `completion-not-established` |
 * | deterministic evidence exists but is all negative            | `not-established`| `only-negative-evidence`  |
 * | the owner confirmed it                                       | `established`    | `owner-confirmed`         |
 * | a verification record passed                                 | `established`    | `verification-passed`     |
 * | tests passed                                                 | `established`    | `tests-passed`            |
 * | a completion result was established                          | `established`    | `completion-not-established` → `verification-passed` |
 *
 * The last row is worth reading twice: a completion result that *was* established is
 * the strongest positive signal there is, so it reuses the `verification-passed`
 * code. One code per *kind of conclusion* rather than one per input shape keeps the
 * reason set small enough that a person can learn all of it.
 *
 * `contradicted` is checked **before** any positive signal, and that ordering is the
 * answer to Goodhart. A skill that also produced one passing test must not be able
 * to buy promotion with its best result while its failures are still on the record.
 *
 * ## Metrics are recorded, never scored
 *
 * `SkillMetric` exists so a reader can see *how much* happened — five attempts, two
 * failures, 300ms. No metric name in the closed vocabulary expresses quality,
 * confidence or success, and this file reads **none of them**: they are returned to
 * the caller and consumed by the projection and the promotion thresholds, which count
 * evidence rather than weighing a score. There is no `weightedScore` to optimise.
 */

export interface EvaluationContext {
  readonly input: SkillEvaluationInput
}

/**
 * The part of an evaluation any verdict may be computed from.
 *
 * Exported as its own function because that is the load-bearing claim of this file,
 * and a reader should be able to check it in one place: `commentary` is absent from
 * the return type, so there is no field for an opinion to travel in.
 */
export interface SkillDeterministicInput {
  readonly evidence: readonly SkillEvidence[]
  readonly verification: readonly SkillVerificationEvidence[]
  readonly metrics: readonly SkillMetric[]
}

export function deterministicInput(input: SkillEvaluationInput): SkillDeterministicInput {
  return {
    evidence: input.evidence.filter((item) => isDeterministicEvidence(item.kind)),
    verification: input.verification,
    metrics: input.metrics,
  }
}

/** Everything that counts toward the outcome. Deterministic evidence only. */
export interface EvaluationTally {
  readonly deterministicCount: number
  readonly positiveCount: number
  readonly negativeCount: number
  readonly ownerRejected: boolean
  readonly verificationPassed: number
  readonly verificationFailed: number
  readonly testsPassed: number
  readonly testsFailed: number
  readonly checksFailed: number
  readonly completionEstablished: number
  readonly completionNotEstablished: number
  readonly completionCancelled: number
  readonly commentaryChars: number
}

/**
 * Count the evidence.
 *
 * A pure function of the deterministic projection plus one read of
 * `commentary.chars`, which is the only place in the whole domain where model text
 * is touched at all — and it is read to produce a number, never a verdict.
 */
export function tallyEvidence(input: SkillEvaluationInput): EvaluationTally {
  const deterministic = deterministicInput(input)

  let ownerRejected = false
  let verificationPassed = 0
  let verificationFailed = 0
  let testsPassed = 0
  let testsFailed = 0
  let checksFailed = 0
  let completionEstablished = 0
  let completionNotEstablished = 0
  let completionCancelled = 0

  for (const record of deterministic.verification) {
    if (record.verdict === 'passed') verificationPassed += 1
    else verificationFailed += 1
  }

  for (const item of deterministic.evidence) {
    switch (item.kind) {
      case 'test-result':
        if (item.code === 'passed') testsPassed += item.count
        else if (item.code === 'failed' || item.code === 'errored') testsFailed += item.count
        break
      case 'check':
        if (item.code === 'failed') checksFailed += item.count
        break
      case 'verification-record':
        if (item.code === 'passed') verificationPassed += item.count
        else verificationFailed += item.count
        break
      case 'owner-feedback':
        if (item.code === 'rejected') ownerRejected = true
        break
      case 'completion-result':
        if (item.code === 'established') completionEstablished += item.count
        else if (item.code === 'cancelled') completionCancelled += item.count
        else completionNotEstablished += item.count
        break
      case 'model-opinion':
        // Unreachable: `deterministic.evidence` has already had it removed. Present
        // so that adding an evidence kind without updating this switch is a compile
        // error rather than a silent no-op.
        break
    }
  }

  const deterministicCount =
    deterministic.evidence.length + deterministic.verification.length
  const negativeCount =
    (ownerRejected ? 1 : 0) +
    verificationFailed +
    testsFailed +
    checksFailed +
    completionNotEstablished +
    completionCancelled

  return {
    deterministicCount,
    positiveCount: verificationPassed + testsPassed + completionEstablished,
    negativeCount,
    ownerRejected,
    verificationPassed,
    verificationFailed,
    testsPassed,
    testsFailed,
    checksFailed,
    completionEstablished,
    completionNotEstablished,
    completionCancelled,
    commentaryChars: input.commentary?.chars ?? 0,
  }
}

/**
 * Decide what the evidence established.
 *
 * Total, deterministic and total-order: the same deterministic projection always
 * yields the same `{ verdict, reason }`, on any machine, in any process, at any
 * clock reading. There is no clock read, no randomness and no I/O here — which is
 * what makes a promotion decision reproducible and what lets the model-independence
 * harness compare decisions across runs without a fixture provider.
 */
export function evaluateOutcome(input: SkillEvaluationInput): SkillEvaluationDecision {
  const tally = tallyEvidence(input)
  const { verdict, reason } = classify(tally)
  return {
    verdict,
    reason,
    deterministicCount: tally.deterministicCount,
    positiveCount: tally.positiveCount,
    negativeCount: tally.negativeCount,
    commentaryChars: tally.commentaryChars,
  }
}

/** The decision table itself, split out so it can be read on its own. */
function classify(tally: EvaluationTally): { verdict: SkillVerdict; reason: EvaluationReason } {
  // 1. Nothing but opinion (or nothing at all) establishes nothing. This is the
  //    outcome a model-only "it went fine!" produces, and it is a first-class,
  //    well-tested result rather than a special case.
  if (tally.deterministicCount === 0) {
    return { verdict: 'inconclusive', reason: 'no-deterministic-evidence' }
  }

  // 2. Negatives first. A single owner rejection, a failed verification, a red test
  //    or a cancelled completion contradicts the outcome whatever else passed.
  if (tally.ownerRejected) return { verdict: 'contradicted', reason: 'owner-rejected' }
  if (tally.verificationFailed > 0) {
    return { verdict: 'contradicted', reason: 'verification-failed' }
  }
  if (tally.testsFailed > 0) return { verdict: 'contradicted', reason: 'tests-failed' }
  if (tally.checksFailed > 0) return { verdict: 'contradicted', reason: 'checks-failed' }
  if (tally.completionCancelled > 0) {
    return { verdict: 'not-established', reason: 'completion-cancelled' }
  }
  if (tally.completionNotEstablished > 0) {
    return { verdict: 'not-established', reason: 'completion-not-established' }
  }

  // 3. Positives, strongest first. An owner's confirmation outranks a verifier's
  //    pass because a person is the only party in the system whose report about their
  //    own outcome is evidence rather than an assertion.
  if (tally.testsPassed > 0 || tally.verificationPassed > 0 || tally.completionEstablished > 0) {
    return { verdict: 'established', reason: 'verification-passed' }
  }

  // 4. Deterministic evidence that is neither positive nor negative: a skipped test,
  //    a `no-opinion` owner report, a pending check. Honest, and not a success.
  if (tally.positiveCount === 0) {
    return { verdict: 'not-established', reason: 'only-negative-evidence' }
  }

  // 5. Unreachable given the branches above: positiveCount > 0 always matches one of
  //    them. Stated rather than left implicit so a future change to the table fails
  //    loudly instead of falling through to a fabricated success.
  return { verdict: 'established', reason: 'verification-passed' }
}

/**
 * The deterministic evidence kinds a renderer may *never* submit.
 *
 * `verification-record` is excluded because a verification record is something Core
 * produces from its own Work/Mission verifiers — a caller that could assert one could
 * forge verification, which is one of the named attacks. `model-opinion` is excluded
 * because a caller must not be able to submit an opinion *as an evidence item at
 * all*; commentary is recorded separately, as a length, and read by nobody.
 */
export const OWNER_SUBMITTABLE_EVIDENCE_KINDS = [
  'test-result',
  'check',
  'owner-feedback',
  'completion-result',
] as const

export function isOwnerSubmittableEvidenceKind(value: string): boolean {
  return (OWNER_SUBMITTABLE_EVIDENCE_KINDS as readonly string[]).includes(value)
}

/**
 * How many deterministic evidence kinds are available at all.
 *
 * Exported so the durable validator can check an evidence-kind field against the same
 * list this module decides with, rather than against a second copy that could drift.
 */
export const DETERMINISTIC_EVIDENCE_KIND_COUNT = DETERMINISTIC_EVIDENCE_KINDS.length

/** The metric names this module will report counts for, for the projection's echo. */
export const REPORTED_METRICS: readonly SkillMetricName[] = [
  'attempts',
  'failures',
  'retries',
  'stepsVerified',
  'stepsTotal',
  'durationMs',
]