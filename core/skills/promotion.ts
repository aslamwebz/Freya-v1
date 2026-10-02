import { canTransitionSkill, type EvaluationAuthor, type SkillStatus, type SkillVerificationState } from './types'
import type { SkillEvaluation } from './types'
import type { SkillFoldRecord } from './state'

/**
 * PROMOTION — the code-owned thresholds between two statuses.
 *
 * ## What decides a promotion
 *
 * Two things, and only two:
 *
 * 1. **The transition table** in `types.ts`. `verified → promoted` exists; nothing
 *    else does.
 * 2. **Recorded evaluations for this exact version.** Not "recent evaluations", not
 *    "the best run", not "what a model said about the skill". Specifically
 *    `record.evaluations.filter((e) => e.version === record.version)`, which is what
 *    makes stale-evidence reuse structurally impossible: revising a skill bumps its
 *    version, and the previous version's evidence stops counting without anybody
 *    having to remember to clear it.
 *
 * Nothing here reads a clock to *decide*; `now` is passed in and used only for
 * reporting and for the evidence-age ceiling.
 *
 * ## The thresholds, and why each one is here
 *
 * | threshold                       | value | what it prevents |
 * | ------------------------------- | ----- | ---------------- |
 * | `minEvaluationsForTrial`        | 1     | a skill tried before anything was ever checked |
 * | `minEvaluationsForVerified`     | 2     | one lucky run proving a procedure works |
 * | `minEstablishedForPromoted`     | 3     | the same, one level up |
 * | `minDistinctSubjectsForPromoted`| 2     | three evaluations of the *same* attempt |
 * | `maxContradictedForPromoted`    | 0     | a skill that also fails being promoted on its best day |
 * | `maxEvidenceAgeMs`              | 30 d  | evidence from before a change that invalidated it |
 * | `maxRevisionsPerVersion`        | 3     | an improvement loop that never converges |
 *
 * `minDistinctSubjectsForPromoted` is the one that stops the cheapest possible
 * forgery: replaying one successful run three times is three established evaluations
 * of one subject, and it does not reach the threshold. It counts *subjects*, not
 * evaluations, precisely so multiplying a record does not help.
 *
 * ## No self-awarded success
 *
 * Two independent guards, because either alone has a gap:
 *
 * - `EVALUATION_AUTHORS` has no `model` member. There is no spelling of an
 *   authoritative evaluation a model produced, so a model cannot report its own work
 *   as passing.
 * - Promotion is reachable **only** through an owner command. `decidePromotion`
 *   returns the *recommendation*; the engine refuses to apply it unless the caller
 *   is the owner scope Core issued. A subsystem that could promote its own skill
 *   would be a self-awarded success with extra steps.
 */

/**
 * The code-owned promotion thresholds.
 *
 * Frozen, and never read from configuration: a threshold that can be supplied is a
 * threshold that can be lowered by whoever supplies it. A host may narrow its own
 * ceilings elsewhere; it may not move these.
 */
export const SKILL_PROMOTION_THRESHOLDS = Object.freeze({
  /** Established evaluations before a skill may enter `trial`. */
  minEvaluationsForTrial: 1,
  /** Established evaluations before a skill may be `verified`. */
  minEvaluationsForVerified: 2,
  /** Established evaluations before the owner may promote. */
  minEstablishedForPromoted: 3,
  /** Distinct evaluation subjects among those established. */
  minDistinctSubjectsForPromoted: 2,
  /** Contradicted evaluations tolerated at promotion. Zero, deliberately. */
  maxContradictedForPromoted: 0,
  /** Inconclusive evaluations tolerated at promotion. */
  maxInconclusiveForPromoted: 4,
  /** How old the freshest evidence may be. */
  maxEvidenceAgeMs: 30 * 24 * 60 * 60 * 1_000,
  /** Revisions one version may spawn before improvement refuses. */
  maxRevisionsPerVersion: 3,
})

/** Why a promotion was refused, or what it established. Closed codes. */
export const PROMOTION_REASONS = [
  'evaluation-basis',
  'established-threshold',
  'subject-diversity',
  'contradicted-evidence',
  'too-many-inconclusive',
  'evidence-too-old',
  'verification-state',
  'illegal-transition',
  'trust-class',
] as const
export type PromotionReason = (typeof PROMOTION_REASONS)[number]

export interface PromotionDecision {
  /** False when the transition must not be applied. */
  readonly allowed: boolean
  readonly from: SkillStatus
  readonly to: SkillStatus
  /** Present when allowed: what the evidence was. Never present when refused. */
  readonly reason: PromotionReason | null
  /** A sentence for a person, bounded and code-owned. Never evidence. */
  readonly detail: string
  /** The numbers behind the decision, so a surface can show them without recomputing. */
  readonly evidence: PromotionEvidenceSummary
}

/** The counts a decision was made from. Every one of them is a count of records. */
export interface PromotionEvidenceSummary {
  readonly version: number
  readonly considered: number
  readonly established: number
  readonly contradicted: number
  readonly inconclusive: number
  readonly distinctSubjects: number
  readonly freshestAt: string | null
}

/** Only evaluations for this version can count. This is the anti-stale rule. */
export function currentVersionEvaluations(record: SkillFoldRecord): readonly SkillEvaluation[] {
  return record.evaluations.filter((evaluation) => evaluation.version === record.version)
}

export function summariseEvidence(
  record: SkillFoldRecord,
  evaluations: readonly SkillEvaluation[],
): PromotionEvidenceSummary {
  const subjects = new Set<string>()
  let freshestAt: string | null = null
  let established = 0
  let contradicted = 0
  let inconclusive = 0
  for (const evaluation of evaluations) {
    subjects.add(`${evaluation.subjectKind}:${evaluation.subjectRef}`)
    if (evaluation.decision.verdict === 'established') established += 1
    else if (evaluation.decision.verdict === 'contradicted') contradicted += 1
    else if (evaluation.decision.verdict === 'inconclusive') inconclusive += 1
    const at = Date.parse(evaluation.evaluatedAt)
    if (Number.isFinite(at)) {
      if (freshestAt === null) {
        freshestAt = evaluation.evaluatedAt
      } else {
        const current = Date.parse(freshestAt)
        if (Number.isFinite(current) && at > current) freshestAt = evaluation.evaluatedAt
      }
    }
  }
  return {
    version: record.version,
    considered: evaluations.length,
    established,
    contradicted,
    inconclusive,
    distinctSubjects: subjects.size,
    freshestAt,
  }
}

export interface PromotionRequest {
  readonly record: SkillFoldRecord
  readonly to: SkillStatus
  /** Injected so the decision is reproducible in a test with a fixed clock. */
  readonly now: Date
  /** Who is asking. Only `owner` may promote; a subsystem may not promote itself. */
  readonly requestedBy: EvaluationAuthor
}

/**
 * Decide whether one status transition may be applied.
 *
 * Pure: same record, same evaluations, same clock, same answer. That is what makes a
 * promotion reproducible, and it is what lets the model-independence harness assert
 * that *no* commentary variation can change the outcome.
 */
export function decidePromotion(request: PromotionRequest): PromotionDecision {
  const { record, to, now, requestedBy } = request
  const evaluations = currentVersionEvaluations(record)
  const evidence = summariseEvidence(record, evaluations)

  const refuse = (reason: PromotionReason, detail: string): PromotionDecision => ({
    allowed: false,
    from: record.status,
    to,
    reason,
    detail,
    evidence,
  })

  if (!canTransitionSkill(record.status, to)) {
    return refuse('illegal-transition', `a skill cannot go from ${record.status} to ${to}`)
  }

  if (record.status === 'verified' && to === 'promoted' && requestedBy !== 'owner') {
    // Not reachable from the command surface today, and kept anyway: the check that
    // a future internal caller honours is the one that has to exist before it is
    // needed, not after.
    return refuse('illegal-transition', 'only the owner may promote a skill')
  }

  // Downgrades are the owner's prerogative and need no evidence: withdrawing a trial
  // or a promotion is a decision about Freya's behaviour, not a claim about the world.
  if (to !== 'promoted' && to !== 'verified') {
    return {
      allowed: true,
      from: record.status,
      to,
      reason: 'evaluation-basis',
      detail: 'a downgrade needs no evidence, because it only removes behaviour',
      evidence,
    }
  }

  if (evaluations.length === 0) {
    return refuse(
      'evaluation-basis',
      `nothing has been evaluated for version ${record.version}, so there is no basis for this step`,
    )
  }

  if (record.verification !== 'verified') {
    return refuse(
      'verification-state',
      `this version is ${record.verification}, so it cannot become ${to}`,
    )
  }

  const threshold =
    to === 'verified' ? SKILL_PROMOTION_THRESHOLDS.minEvaluationsForVerified : SKILL_PROMOTION_THRESHOLDS.minEstablishedForPromoted

  if (evidence.established < threshold) {
    return refuse(
      'established-threshold',
      `${evidence.established} established evaluations; ${threshold} are required for ${to}`,
    )
  }

  if (evidence.contradicted > SKILL_PROMOTION_THRESHOLDS.maxContradictedForPromoted) {
    return refuse(
      'contradicted-evidence',
      `${evidence.contradicted} evaluations contradicted this version, and none may be tolerated`,
    )
  }

  if (evidence.inconclusive > SKILL_PROMOTION_THRESHOLDS.maxInconclusiveForPromoted) {
    return refuse(
      'too-many-inconclusive',
      `${evidence.inconclusive} evaluations reached no conclusion`,
    )
  }

  const freshest = evidence.freshestAt === null ? null : Date.parse(evidence.freshestAt)
  if (freshestAtIsStale(freshest, now)) {
    return refuse(
      'evidence-too-old',
      'the newest evidence is older than the evidence window, so it may describe something else',
    )
  }

  if (to === 'promoted' && evidence.distinctSubjects < SKILL_PROMOTION_THRESHOLDS.minDistinctSubjectsForPromoted) {
    return refuse(
      'subject-diversity',
      `${evidence.distinctSubjects} distinct subject(s); ${SKILL_PROMOTION_THRESHOLDS.minDistinctSubjectsForPromoted} are required so one lucky run cannot promote a procedure`,
    )
  }

  return {
    allowed: true,
    from: record.status,
    to,
    reason: 'evaluation-basis',
    detail: `${evidence.established} established evaluation(s) across ${evidence.distinctSubjects} subject(s) for version ${record.version}`,
    evidence,
  }
}

function freshestAtIsStale(freshestMs: number | null, now: Date): boolean {
  if (freshestMs === null) return true
  // A future instant is not "fresh"; it is an untrustworthy clock. Treated as stale
  // rather than as infinitely fresh, because the fail-open reading is the dangerous
  // one: an evidence record dated in the year 3000 would otherwise satisfy any age
  // ceiling forever.
  if (freshestMs > now.getTime()) return true
  return now.getTime() - freshestMs > SKILL_PROMOTION_THRESHOLDS.maxEvidenceAgeMs
}

/**
 * What the verification state becomes when evaluations are recorded.
 *
 * Derived rather than chosen, so a caller cannot record a verification state:
 * `failed` on any contradiction, `verified` when the established count reaches the
 * verified threshold for *this* version, `stale` when the freshest evaluation belongs
 * to an older version, and `unverified` otherwise.
 */
export function deriveVerificationState(record: SkillFoldRecord): SkillVerificationState {
  const evaluations = currentVersionEvaluations(record)
  if (evaluations.length === 0) {
    return record.version > 1 ? 'stale' : 'unverified'
  }
  const established = evaluations.filter((evaluation) => evaluation.decision.verdict === 'established').length
  const contradicted = evaluations.filter((evaluation) => evaluation.decision.verdict === 'contradicted').length
  if (contradicted > 0) return 'failed'
  if (established >= SKILL_PROMOTION_THRESHOLDS.minEvaluationsForVerified) return 'verified'
  return 'unverified'
}

/** The evaluation ages out of the window. Reported, never decided by a caller. */
export function isEvidenceCurrent(record: SkillFoldRecord, now: Date): boolean {
  const evaluations = currentVersionEvaluations(record)
  if (evaluations.length === 0) return false
  for (const evaluation of evaluations) {
    const at = Date.parse(evaluation.evaluatedAt)
    if (!Number.isFinite(at)) return false
    if (at > now.getTime()) return false
  }
  return true
}