import type {
  EvaluationReason,
  ImprovementTarget,
  SkillEvidenceKind,
  SkillKind,
  SkillRefusalCode,
  SkillSource,
  SkillStatus,
  SkillTrustClass,
  SkillVerificationState,
  SkillVerdict,
} from '../skills/types'

/**
 * THE SKILL PROTOCOL — what a window may know about procedures and their evidence.
 *
 * This file is a **view**, not a channel. It carries the read-only shapes a renderer
 * is typed against, one frozen projection for a Core with no Skill domain, and the
 * outcome vocabulary of the few commands that exist.
 *
 * ## What crosses, and what pointedly does not
 *
 * Crosses: ids, closed labels, statuses, counts, instants, the *measured length* of
 * a summary, the applicability tags (slugs, and selection has to match on them), the
 * counts of a skill's contract and steps, and the numbers behind every evaluation
 * decision.
 *
 * Does not cross:
 *
 * - **Any skill body.** A summary's text, a contract entry's description, a step's
 *   input — none of these is a field of any view here. They live in the encrypted
 *   store, and the one way to read one back is an explicit, owner-only
 *   `skill.detail.read` for a single skill.
 * - **Any evidence text.** An evaluation crosses as a verdict, a reason code and four
 *   integers. Model commentary crosses as a **character count** and never as text,
 *   because the whole design of `evaluation.ts` is that model text is non-authoritative
 *   and keeping it out of the renderer is how a reader cannot mistake it for evidence.
 * - **Any capability, grant, approval or budget figure a window could use.** The
 *   projection reports *counts* of required capabilities, never the list, because the
 *   list is the capability map of a procedure and belongs to Core.
 *
 * ## The absences, kept apart
 *
 * `'unavailable'` with `NO_SKILL_DOMAIN_REASON` means *this build has no Skill domain
 * and none is simulated*. `null` from the host means *no Core has started yet*.
 * Rendering the first as "no procedures" would tell a person Freya has learned
 * nothing when nothing is watching.
 */

/* ------------------------------------------------------------------ views */

/** One version in a skill's history. Counts only. */
export interface SkillVersionView {
  readonly version: number
  readonly contentHash: string
  readonly createdAt: string
  readonly source: SkillSource
  readonly trustClass: SkillTrustClass
  readonly stepCount: number
  readonly requiredCapabilityCount: number
  readonly applicabilityCount: number
  readonly inputCount: number
  readonly outputCount: number
  readonly preconditionCount: number
  readonly postconditionCount: number
  readonly summaryLength: number
  readonly revisions: number
}

/**
 * One evaluation, as metadata.
 *
 * `verdict` and `reason` are Core's own closed codes. `deterministicCount` is the
 * number of evidence items the verdict was computed from, and `commentaryChars` is how
 * much model commentary existed — a count, deliberately kept next to the verdict so a
 * reader can see that a large commentary changed nothing.
 */
export interface SkillEvaluationView {
  readonly evaluationId: string
  readonly version: number
  readonly subjectKind: string
  readonly subjectRef: string
  readonly author: string
  readonly evaluatedAt: string
  readonly verdict: SkillVerdict
  readonly reason: EvaluationReason
  readonly deterministicCount: number
  readonly positiveCount: number
  readonly negativeCount: number
  readonly commentaryChars: number
}

/** One skill, as a window may hold it. */
export interface SkillView {
  readonly skillId: string
  readonly name: string
  readonly kind: SkillKind
  readonly status: SkillStatus
  readonly version: number
  readonly verification: SkillVerificationState
  readonly source: SkillSource
  readonly trustClass: SkillTrustClass
  readonly admittedBy: string
  readonly admittedAt: string
  readonly updatedAt: string
  readonly promotedAt: string | null
  readonly retiredAt: string | null
  readonly retirementReason: string | null
  /** Bounded slugs. Selection matches on these and nothing else. */
  readonly applicability: readonly string[]
  readonly stepCount: number
  readonly requiredCapabilityCount: number
  readonly inputCount: number
  readonly outputCount: number
  readonly preconditionCount: number
  readonly postconditionCount: number
  readonly summaryLength: number
  readonly executionsPlanned: number
  readonly establishedCount: number
  readonly contradictedCount: number
  readonly inconclusiveCount: number
  readonly evaluationCount: number
  /** Verdict/reason/counts of the newest evaluation, or null when there is none. */
  readonly lastEvaluation: SkillEvaluationView | null
  readonly versions: readonly SkillVersionView[]
}

/** One open improvement proposal, as metadata. */
export interface SkillProposalView {
  readonly proposalId: string
  readonly target: ImprovementTarget
  readonly targetRef: string
  readonly skillId: string | null
  readonly baseVersion: number | null
  readonly summaryLength: number
  readonly basisCount: number
  readonly proposedBy: string
  readonly createdAt: string
  readonly status: 'open' | 'accepted' | 'refused'
  readonly settledReason: string | null
}

/** A refused admission, so an unaudited refusal cannot hide a probing pattern. */
export interface SkillRejectionView {
  readonly code: string
  readonly targetRef: string | null
}

/** Totals across the registry. Counts, never scores. */
export interface SkillCountsView {
  readonly admitted: number
  readonly revised: number
  readonly evaluations: number
  readonly established: number
  readonly contradicted: number
  readonly inconclusive: number
  readonly executionsPlanned: number
  readonly promotions: number
  readonly retirements: number
  readonly proposals: number
  readonly proposalsRefused: number
  readonly rejectedAdmissions: number
  readonly runtimePromotionsRefused: number
  readonly retained: number
  readonly promoted: number
  readonly executable: number
}

/** The code-owned thresholds, echoed so a surface can show what Core will not bend. */
export interface SkillThresholdView {
  readonly minEvaluationsForTrial: number
  readonly minEvaluationsForVerified: number
  readonly minEstablishedForPromoted: number
  readonly minDistinctSubjectsForPromoted: number
  readonly maxContradictedForPromoted: number
  readonly maxRevisionsPerVersion: number
}

/** One ranked selection result. Deterministic and ordered by evidence. */
export interface SkillSelectionView {
  readonly skillId: string
  readonly name: string
  readonly kind: SkillKind
  readonly status: SkillStatus
  readonly version: number
  readonly verification: SkillVerificationState
  readonly trustClass: SkillTrustClass
  readonly establishedCount: number
  readonly matchedTags: readonly string[]
  readonly executionsPlanned: number
}

export interface SkillSelectionReport {
  readonly candidates: readonly SkillSelectionView[]
  readonly considered: number
  readonly emptyReason: 'no-applicable-skill' | 'no-executable-skill' | 'limit-zero' | null
}

/** Whether skill bodies survive a restart, and why not when they do not. */
export interface SkillPersistenceView {
  readonly mode: 'encrypted' | 'ephemeral'
  readonly durable: boolean
  readonly reason: string | null
}

/**
 * Everything a window may know about skills, in one read-only object.
 *
 * A mirror, in the same sense as every other subsystem's: Core builds it, a window
 * holds what Core last sent, and nothing a window can do writes a field of it.
 * `sequence` lets a window prove which Core state it is looking at.
 */
export interface SkillProjection {
  readonly health: 'ready' | 'unavailable'
  readonly reason: string | null
  readonly schemaVersion: number
  readonly sequence: number
  readonly counts: SkillCountsView
  readonly thresholds: SkillThresholdView
  readonly skills: readonly SkillView[]
  readonly proposals: readonly SkillProposalView[]
  readonly rejectedAdmissions: readonly SkillRejectionView[]
  readonly runtimePromotionRefusals: readonly { artifactId: string; reason: string }[]
  readonly lastSelection: SkillSelectionReport | null
  readonly persistence: SkillPersistenceView
  readonly limits: {
    readonly maxRetainedSkills: number
    readonly maxSteps: number
    readonly maxRequiredCapabilities: number
    readonly maxOpenProposals: number
    readonly maxSelection: number
  }
}

/**
 * One skill's private body, for the owner's explicit read.
 *
 * The counterpart to the metadata projection, and the only way a body crosses the
 * bridge. It is one skill, on request, and it never enters the journal, a projection
 * or an activity row. `steps` names capabilities and verifiers — a closed vocabulary
 * — and the `input`/`output`/`precondition`/`postcondition` entries carry the owner's
 * own descriptions of their own procedure.
 */
export interface SkillDetailView {
  readonly skillId: string
  readonly name: string
  readonly kind: SkillKind
  readonly status: SkillStatus
  readonly version: number
  readonly verification: SkillVerificationState
  readonly contentHash: string
  readonly summary: string
  readonly steps: readonly { key: string; capability: string; verifier: string }[]
  readonly requiredCapabilities: readonly string[]
  readonly applicability: readonly string[]
  readonly contract: {
    readonly inputs: readonly { name: string; description: string }[]
    readonly outputs: readonly { name: string; description: string }[]
    readonly preconditions: readonly { name: string; description: string }[]
    readonly postconditions: readonly { name: string; description: string }[]
  }
  readonly provenance: {
    readonly source: SkillSource
    readonly trustClass: SkillTrustClass
    readonly admittedBy: string
    readonly admittedAt: string
    readonly parentSkillId: string | null
    readonly parentVersion: number | null
  }
}

/* ------------------------------------------------------------- read-back */

export type SkillOperation =
  | 'status'
  | 'admitted'
  | 'revised'
  | 'evaluated'
  | 'transitioned'
  | 'retired'
  | 'detail'
  | 'selected'
  | 'proposed'
  | 'settled'
  | 'refused'

/**
 * What a skill command produced.
 *
 * `refused` is an outcome rather than an exception everywhere: an unknown skill, a bad
 * payload, an illegal transition and a Core that is not up all answer in words, and
 * none is papered over. The `code` slot is the closed `SkillRefusalCode`, so a
 * surface can distinguish "this may never be true" from "this is not true yet" without
 * parsing a sentence.
 */
export interface SkillCommandOutcome {
  readonly operation: SkillOperation
  readonly ok: boolean
  readonly code?: SkillRefusalCode
  readonly reason?: string
  readonly skillId?: string
  readonly version?: number
  readonly status?: SkillStatus
  readonly evaluationId?: string
  readonly proposalId?: string
  /** Present on `skill.detail.read` only. The owner's own procedure text. */
  readonly detail?: SkillDetailView
  /** Present on `skill.select` only. Derived, read-only, deterministic. */
  readonly selection?: SkillSelectionReport
  /** Present on `skill.status.read` and `skill.select`. */
  readonly projection?: SkillProjection
  /** The evidence kinds a caller may submit, echoed so a surface can label a form. */
  readonly evidenceKinds?: readonly SkillEvidenceKind[]
}

/* --------------------------------------------------------------- absent */

/**
 * A valid projection for a Core that has no Skill domain.
 *
 * `unavailable`, never `ready` with zero counts: "Freya has no procedures" and
 * "nothing is watching for procedures" are different facts, and a surface that
 * rendered the second as the first would tell a person Freya has learned nothing in a
 * build that never offered her the chance.
 */
export const ABSENT_SKILL_PROJECTION: SkillProjection = Object.freeze({
  health: 'unavailable' as const,
  reason: 'Core has not reported a Skill domain yet',
  schemaVersion: 1,
  sequence: 0,
  counts: Object.freeze({
    admitted: 0,
    revised: 0,
    evaluations: 0,
    established: 0,
    contradicted: 0,
    inconclusive: 0,
    executionsPlanned: 0,
    promotions: 0,
    retirements: 0,
    proposals: 0,
    proposalsRefused: 0,
    rejectedAdmissions: 0,
    runtimePromotionsRefused: 0,
    retained: 0,
    promoted: 0,
    executable: 0,
  }),
  thresholds: Object.freeze({
    minEvaluationsForTrial: 0,
    minEvaluationsForVerified: 0,
    minEstablishedForPromoted: 0,
    minDistinctSubjectsForPromoted: 0,
    maxContradictedForPromoted: 0,
    maxRevisionsPerVersion: 0,
  }),
  skills: Object.freeze([]) as readonly SkillView[],
  proposals: Object.freeze([]) as readonly SkillProposalView[],
  rejectedAdmissions: Object.freeze([]) as readonly SkillRejectionView[],
  runtimePromotionRefusals: Object.freeze([]) as readonly { artifactId: string; reason: string }[],
  lastSelection: null,
  persistence: Object.freeze({ mode: 'ephemeral' as const, durable: false, reason: null }),
  limits: Object.freeze({
    maxRetainedSkills: 0,
    maxSteps: 0,
    maxRequiredCapabilities: 0,
    maxOpenProposals: 0,
    maxSelection: 0,
  }),
})

/**
 * The sentence Core reports when nothing has built a Skill domain.
 *
 * Exported so the host, the surface and the tests quote the same words instead of
 * paraphrasing the absence into four slightly different claims.
 */
export const NO_SKILL_DOMAIN_REASON =
  'this Core has no Skill domain: no procedure is stored, evaluated or promoted, and none is simulated'

/** The projection schema this lane speaks. */
export const SKILL_SCHEMA_VERSION = 1

/** The sentence a window gets when a payloadless read carried something. */
export const SKILL_NO_PAYLOAD =
  'skill.status.read carries no payload: a window may ask what Core knows about procedures and may not supply a status, a verdict, an evidence kind or a threshold'