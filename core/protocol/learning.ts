import type { Confidence, EpistemicStatus, SourceTrust } from '../brain/types'
import type {
  LearningExperienceKind,
  LearningKnowledgeKind,
  LearningOutcomeResult,
  LearningPipelineStage,
  LearningProposalSupport,
  LearningScope,
  LearningScopeLimit,
  LearningSourceDomain,
  LearningStatus,
} from '../learning/types'

/**
 * THE LEARNING PROTOCOL — what a window may know about what Freya has learned.
 *
 * This file is a **view**, not a channel. It carries the read-only shapes a renderer is
 * typed against, one frozen projection for a Core with no learning domain, and the outcome
 * vocabulary of the reads that exist.
 *
 * ## What crosses, and what pointedly does not
 *
 * Crosses: ids, closed labels, statuses, instants, provenance *metadata* (source class,
 * actor, confidence, epistemic status), counts, tags, the measured length of every
 * text-bearing field, the scope and scope limits of each claim, which claims are supported
 * by how many distinct verifications, and which procedure proposals are above threshold.
 *
 * Does not cross, in any broad read:
 *
 * - **Any lesson or claim text.** `learning.records.read` carries `lessonLength` and
 *   `claimLength`. The one way to read a claim's own words is the explicit, owner-only
 *   `learning.record.read` for a single record.
 * - **Any status, confidence, scope or verdict a window could assert.** They are reported,
 *   never accepted: there is no write verb on this surface at all, and no `learning.*`
 *   command on the Core surface.
 * - **Any capability, permission or authority field.** A proposal crosses carrying
 *   `grantsCapability: false`, `executable: false` and `authority: 'none'` as values, so a
 *   surface can *render* the guarantee rather than merely not violate it.
 */

/* ------------------------------------------------------------------ views */

/** One record as a broad read may hold it. No lesson or claim text. */
export interface LearningRecordView {
  readonly recordId: string
  readonly stage: LearningPipelineStage
  readonly kind: LearningExperienceKind | LearningKnowledgeKind
  readonly status: LearningStatus
  readonly sourceDomain: LearningSourceDomain
  readonly sourceType: SourceTrust
  readonly actor: string
  readonly confidence: Confidence
  readonly verificationStatus: EpistemicStatus
  readonly scope: LearningScope
  readonly scopeLimits: readonly LearningScopeLimit[]
  readonly tags: readonly string[]
  /** Ids only — never content. */
  readonly supportCount: number
  readonly verificationCount: number
  readonly observedAt: string
  readonly recordedAt: string
  readonly admittedAt: string | null
  readonly lifecycleAt: string | null
  readonly lifecycleReason: string | null
  /** Measured, never the words. The only trace of the text in a broad read. */
  readonly textLength: number
}

/** One outcome as a broad read may hold it. `checked` is metadata about a check. */
export interface LearningOutcomeView {
  readonly outcomeId: string
  readonly sourceDomain: LearningSourceDomain
  readonly verificationId: string
  readonly verifierId: string
  readonly subjectRef: string
  readonly result: LearningOutcomeResult
  readonly establishedAt: string
  readonly checkedLength: number
}

/** One claim's own words, on an explicit single-record owner read. */
export interface LearningClaimDetailView {
  readonly recordId: string
  readonly stage: 'knowledge'
  readonly kind: LearningKnowledgeKind
  readonly claim: string
  readonly scope: LearningScope
  readonly scopeLimits: readonly LearningScopeLimit[]
  readonly supports: readonly string[]
  readonly verificationIds: readonly string[]
  readonly status: LearningStatus
  readonly sourceType: SourceTrust
  readonly confidence: Confidence
  readonly observedAt: string
  readonly admittedAt: string | null
  readonly lifecycleAt: string | null
  readonly lifecycleReason: string | null
  readonly tags: readonly string[]
  /** True when the claim text was destroyed by retraction or expiry. */
  readonly textDestroyed: boolean
}

export interface LearningCountsView {
  readonly outcomes: number
  readonly experiences: number
  readonly knowledge: number
  readonly candidates: number
  readonly retracted: number
  readonly superseded: number
  readonly expired: number
  readonly rejected: number
  readonly evidenced: number
  readonly byExperienceKind: Readonly<Record<LearningExperienceKind, number>>
  readonly byKnowledgeKind: Readonly<Record<LearningKnowledgeKind, number>>
}

export interface LearningProposalView {
  readonly proposalId: string
  readonly name: string
  readonly stepCount: number
  readonly knowledgeIds: readonly string[]
  readonly experienceIds: readonly string[]
  readonly distinctVerifications: number
  readonly failedOutcomes: number
  readonly scope: LearningScope
  readonly scopeLimits: readonly LearningScopeLimit[]
  readonly confidence: Confidence
  readonly support: LearningProposalSupport
  /** Always `false`. Rendered so the guarantee can be shown, not merely respected. */
  readonly grantsCapability: false
  /** Always `false`. A proposal is not runnable. */
  readonly executable: false
  /** Always `'none'`. */
  readonly authority: 'none'
}

export interface LearningPersistenceView {
  readonly mode: 'encrypted' | 'ephemeral' | 'memory' | 'unavailable'
  readonly durable: boolean
  readonly degraded: boolean
  readonly reason: string | null
}

export interface LearningProjection {
  readonly schemaVersion: number
  /** `'unavailable'` only for a build with no learning domain. */
  readonly mode: 'available' | 'unavailable'
  readonly counts: LearningCountsView
  /** Supporting experience ids where two admitted claims disagree. Disclosed, never resolved. */
  readonly conflictedClaims: readonly string[]
  /** The widest scope any claim reaches. A fact about the records, not a measure of Freya. */
  readonly strongestScope: LearningScope
  readonly proposals: readonly LearningProposalView[]
  /** Always `'none'`. Learning is evidence, not authority. */
  readonly authority: 'none'
  /** The strongest confidence any claim can ever carry. `medium`, for every source. */
  readonly confidenceCeiling: Confidence
  readonly persistence: LearningPersistenceView
}

export interface LearningRecordsView {
  /**
   * The checked outcomes, as their own view type.
   *
   * They are deliberately not folded into `items`: an outcome is a report that a check
   * happened, with no status, no confidence and no scope of its own, and projecting it
   * into a claim-shaped record would invent all three.
   */
  readonly outcomes: readonly LearningOutcomeView[]
  readonly items: readonly LearningRecordView[]
  readonly truncated: boolean
  readonly total: number
  readonly schemaVersion: number
}

/* --------------------------------------------------------------- outcomes */

export type LearningRecordsOutcome =
  | { readonly ok: true; readonly records: LearningRecordsView; readonly reason: null }
  | { readonly ok: false; readonly code: string; readonly reason: string }

export type LearningClaimReadOutcome =
  | { readonly ok: true; readonly claim: LearningClaimDetailView; readonly reason: null }
  | { readonly ok: false; readonly code: string; readonly reason: string }

/** One record as the owner's export holds it. Text included — this is the export. */
export interface LearningExportItemView {
  readonly recordId: string
  readonly stage: LearningPipelineStage
  readonly kind: LearningExperienceKind | LearningKnowledgeKind
  readonly text: string
  readonly status: LearningStatus
  readonly scope: LearningScope
  readonly scopeLimits: readonly LearningScopeLimit[]
  readonly supports: readonly string[]
  readonly verificationIds: readonly string[]
  readonly sourceType: SourceTrust
  readonly confidence: Confidence
  readonly observedAt: string
  readonly recordedAt: string
  readonly admittedAt: string | null
  readonly lifecycleAt: string | null
  readonly lifecycleReason: string | null
  readonly tags: readonly string[]
}

export interface LearningExportView {
  readonly schemaVersion: number
  readonly items: readonly LearningExportItemView[]
  readonly total: number
  /** Records the bound excluded. Non-zero means this export is partial. */
  readonly withheld: number
  readonly persistence: LearningPersistenceView
}

export type LearningExportOutcome =
  | { readonly ok: true; readonly export: LearningExportView; readonly reason: null }
  | { readonly ok: false; readonly code: string; readonly reason: string }

/**
 * The outcome of one trusted write.
 *
 * Core-internal. A window receives the *projection*, not the outcome of writing, and there
 * is no `learning.*` command on the Core surface for a renderer to send one to.
 */
export type LearningWriteOutcome =
  | {
      readonly ok: true
      readonly outcome: 'recorded' | 'distilled' | 'corrected' | 'withdrawn' | 'forgotten' | 'rejected'
      readonly recordId: string | null
      readonly reason: string
      readonly superseded: string | null
    }
  | {
      readonly ok: false
      readonly outcome: 'refused'
      readonly recordId: null
      readonly reason: string
      readonly code: string
      readonly superseded: null
    }

/** The fixed reason a build with no learning domain reports. */
export const NO_LEARNING_DOMAIN_REASON = 'this build has no learning domain and none is simulated'

/** The fixed reason a window receives when no Core has started. */
export const NO_CORE_REASON = 'no Core has started yet'

export const LEARNING_SCHEMA_VERSION = 1

function zeroExperienceCounts(): Readonly<Record<LearningExperienceKind, number>> {
  return Object.freeze({
    'outcome-lesson': 0,
    'tool-lesson': 0,
    'environment-lesson': 0,
    'failure-lesson': 0,
    'constraint-lesson': 0,
  })
}

function zeroKnowledgeCounts(): Readonly<Record<LearningKnowledgeKind, number>> {
  return Object.freeze({
    'tool-behaviour': 0,
    'environment-fact': 0,
    'process-fact': 0,
    'failure-cause': 0,
    'constraint-learned': 0,
    'outcome-pattern': 0,
  })
}

/** One frozen projection for a Core with no learning domain and none simulated. */
export const ABSENT_LEARNING_PROJECTION: LearningProjection = Object.freeze({
  schemaVersion: LEARNING_SCHEMA_VERSION,
  mode: 'unavailable' as const,
  counts: Object.freeze({
    outcomes: 0,
    experiences: 0,
    knowledge: 0,
    candidates: 0,
    retracted: 0,
    superseded: 0,
    expired: 0,
    rejected: 0,
    evidenced: 0,
    byExperienceKind: zeroExperienceCounts(),
    byKnowledgeKind: zeroKnowledgeCounts(),
  }),
  conflictedClaims: Object.freeze([]),
  strongestScope: 'one-instance' as const,
  proposals: Object.freeze([]),
  authority: 'none' as const,
  confidenceCeiling: 'medium' as const,
  persistence: Object.freeze({
    mode: 'unavailable' as const,
    durable: false,
    degraded: false,
    reason: NO_LEARNING_DOMAIN_REASON,
  }),
})