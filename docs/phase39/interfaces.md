/**
 * Phase 39 — Compile-Time Types and Interfaces
 *
 * **Status:** PREPARATION ONLY — NOT PRODUCTION
 *
 * These types and interfaces are compile-time only. They cannot activate
 * runtime behavior. They define the shape of Phase 39's components.
 *
 * These types are safe to cherry-pick later. They do not import any runtime
 * module. They do not create any side effects. They are pure type definitions.
 */

/* --------------------------------------------------------- threshold */

/**
 * The closed set of threshold states.
 */
export const THRESHOLD_STATES = [
  'UNPROVEN',
  'ASSESSING',
  'EVIDENCING',
  'EVALUATING',
  'PROVEN',
  'SUSPENDED',
  'ROLLED_BACK',
] as const
export type ThresholdState = (typeof THRESHOLD_STATES)[number]

export function isThresholdState(value: unknown): value is ThresholdState {
  return typeof value === 'string' && (THRESHOLD_STATES as readonly string[]).includes(value)
}

/* --------------------------------------------------------- maturity */

/**
 * The closed set of maturity dimensions.
 *
 * These are the 14 dimensions Phase 39 measures.
 */
export const MATURITY_DIMENSIONS = [
  'autonomy',
  'memory',
  'world-self-model',
  'resilience',
  'security',
  'privacy',
  'owner-control',
  'verification',
  'recovery',
  'economic-boundaries',
  'relationship-intelligence',
  'capability-acquisition',
  'self-improvement',
  'long-horizon-behavior',
] as const
export type MaturityDimension = (typeof MATURITY_DIMENSIONS)[number]

export function isMaturityDimension(value: unknown): value is MaturityDimension {
  return typeof value === 'string' && (MATURITY_DIMENSIONS as readonly string[]).includes(value)
}

/**
 * The closed set of maturity levels.
 */
export const MATURITY_LEVELS = ['unproven', 'emerging', 'developing', 'proven'] as const
export type MaturityLevel = (typeof MATURITY_LEVELS)[number]

export function isMaturityLevel(value: unknown): value is MaturityLevel {
  return typeof value === 'string' && (MATURITY_LEVELS as readonly string[]).includes(value)
}

/* --------------------------------------------------------- criterion */

/**
 * A single measurable maturity criterion.
 */
export interface MaturityCriterion {
  readonly criterionId: string
  readonly dimension: MaturityDimension
  readonly description: string
  readonly testId: string
  readonly evidenceRequired: boolean
  readonly failClosed: boolean
}

/**
 * The assessment of a single criterion.
 */
export interface CriterionAssessment {
  readonly criterionId: string
  readonly dimension: MaturityDimension
  readonly level: MaturityLevel
  readonly evidenceIds: readonly string[]
  readonly assessedAt: string
  readonly reasoning: readonly string[]
}

/* --------------------------------------------------------- assessment */

/**
 * The maturity assessment across all dimensions.
 */
export interface MaturityAssessment {
  readonly assessmentId: string
  readonly dimension: MaturityDimension
  readonly level: MaturityLevel
  readonly criteria: readonly CriterionAssessment[]
  readonly evidenceIds: readonly string[]
  readonly assessedAt: string
  readonly nextBoundedAction: BoundedAction | null
}

/* --------------------------------------------------------- fail-closed */

/**
 * The closed set of fail-closed condition kinds.
 */
export const FAIL_CLOSED_KINDS = [
  'ambiguity',
  'uncertainty',
  'boundary-violation',
  'evidence-insufficient',
  'evidence-fabricated',
  'authority-drift',
  'self-modification',
  'stop-all',
] as const
export type FailClosedKind = (typeof FAIL_CLOSED_KINDS)[number]

export function isFailClosedKind(value: unknown): value is FailClosedKind {
  return typeof value === 'string' && (FAIL_CLOSED_KINDS as readonly string[]).includes(value)
}

/**
 * A fail-closed condition record.
 */
export interface FailClosedRecord {
  readonly recordId: string
  readonly kind: FailClosedKind
  readonly reason: string
  readonly triggeredAt: string
  readonly resolution: 'refused' | 'halted' | 'denied' | 'suspended'
}

/* --------------------------------------------------------- evidence */

/**
 * The closed set of evidence quality levels.
 */
export const THRESHOLD_EVIDENCE_QUALITY = ['insufficient', 'weak', 'moderate', 'strong', 'verified'] as const
export type ThresholdEvidenceQuality = (typeof THRESHOLD_EVIDENCE_QUALITY)[number]

export function isThresholdEvidenceQuality(value: unknown): value is ThresholdEvidenceQuality {
  return typeof value === 'string' && (THRESHOLD_EVIDENCE_QUALITY as readonly string[]).includes(value)
}

/**
 * A threshold evidence record.
 */
export interface ThresholdEvidenceRecord {
  readonly evidenceId: string
  readonly criterionId: string
  readonly source: string
  readonly quality: ThresholdEvidenceQuality
  readonly statement: string
  readonly verifiedAt: string
  readonly expiresAt: string
}

/* --------------------------------------------------------- rollback */

/**
 * The closed set of rollback reasons.
 */
export const ROLLBACK_REASONS = [
  'authority-widening',
  'hidden-inference',
  'real-money-action',
  'fabricated-evidence',
  'unverifiable-maturity',
  'boundary-violation',
  'owner-requested',
] as const
export type RollbackReason = (typeof ROLLBACK_REASONS)[number]

export function isRollbackReason(value: unknown): value is RollbackReason {
  return typeof value === 'string' && (ROLLBACK_REASONS as readonly string[]).includes(value)
}

/**
 * A rollback record.
 */
export interface RollbackRecord {
  readonly rollbackId: string
  readonly reason: RollbackReason
  readonly triggeredAt: string
  readonly approvedBy: string
  readonly journaled: boolean
}

/* --------------------------------------------------------- explainability */

/**
 * The explainable threshold state.
 */
export interface ThresholdStateProjection {
  readonly currentState: ThresholdState
  readonly activeAssessments: readonly MaturityAssessment[]
  readonly pendingEvidence: readonly ThresholdEvidenceRecord[]
  readonly recentFailClosed: readonly FailClosedRecord[]
  readonly recentRollbacks: readonly RollbackRecord[]
  readonly nextBoundedAction: BoundedAction | null
  readonly generatedAt: string
}

/**
 * A bounded next action.
 */
export interface BoundedAction {
  readonly actionId: string
  readonly kind: 'assess' | 'collect' | 'verify' | 'evaluate' | 'prove' | 'suspend' | 'rollback' | 'wait' | 'escalate' | 'stop'
  readonly target: string
  readonly deadlineAt: string
  readonly maxAttempts: number
  readonly reasoning: readonly string[]
}

/* --------------------------------------------------------- limits */

/**
 * The threshold limits.
 *
 * These are code-owned ceilings. They cannot be widened.
 */
export const THRESHOLD_LIMITS = Object.freeze({
  maxCriteriaPerDimension: 16,
  maxEvidencePerCriterion: 16,
  maxAssessmentDurationMs: 7 * 24 * 60 * 60 * 1_000,
  maxEvidenceCollectionDurationMs: 24 * 60 * 60 * 1_000,
  maxEvaluationDurationMs: 24 * 60 * 60 * 1_000,
  maxRetryCeiling: 3,
  maxBackoffMs: 5 * 60_000,
  baseBackoffMs: 1_000,
  jitterMs: 1_000,
})

/* --------------------------------------------------------- events */

/**
 * The threshold event types.
 *
 * These are the event types the threshold subsystem appends.
 */
export const THRESHOLD_EVENT_TYPES = [
  'threshold.assessment.started',
  'threshold.assessment.completed',
  'threshold.evidence.collected',
  'threshold.evidence.verified',
  'threshold.evidence.fabrication-detected',
  'threshold.fail-closed.triggered',
  'threshold.fail-closed.resolved',
  'threshold.decision.proven',
  'threshold.decision.not-proven',
  'threshold.suspended',
  'threshold.resumed',
  'threshold.rollback.started',
  'threshold.rollback.completed',
  'threshold.wake.received',
  'threshold.wake.denied',
] as const

export type ThresholdEventType = (typeof THRESHOLD_EVENT_TYPES)[number]
