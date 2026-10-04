/**
 * Phase 38 — Compile-Time Types and Interfaces
 *
 * **Status:** PREPARATION ONLY — NOT PRODUCTION
 *
 * These types and interfaces are compile-time only. They cannot activate
 * runtime behavior. They define the shape of Phase 38's components.
 *
 * These types are safe to cherry-pick later. They do not import any runtime
 * module. They do not create any side effects. They are pure type definitions.
 */

/* --------------------------------------------------------- evolution */

/**
 * The closed set of evolution states.
 */
export const EVOLUTION_STATES = [
  'STABLE',
  'EVALUATING',
  'IMPROVING',
  'VERIFYING',
  'STAGING',
  'FAILED',
] as const
export type EvolutionState = (typeof EVOLUTION_STATES)[number]

export function isEvolutionState(value: unknown): value is EvolutionState {
  return typeof value === 'string' && (EVOLUTION_STATES as readonly string[]).includes(value)
}

/* --------------------------------------------------------- evidence */

/**
 * The closed set of evidence quality levels.
 */
export const EVIDENCE_QUALITY = ['insufficient', 'weak', 'moderate', 'strong', 'verified'] as const
export type EvidenceQuality = (typeof EVIDENCE_QUALITY)[number]

export function isEvidenceQuality(value: unknown): value is EvidenceQuality {
  return typeof value === 'string' && (EVIDENCE_QUALITY as readonly string[]).includes(value)
}

/**
 * An evidence record.
 */
export interface EvidenceRecord {
  readonly evidenceId: string
  readonly source: string
  readonly quality: EvidenceQuality
  readonly statement: string
  readonly verifiedAt: string
  readonly expiresAt: string
}

/* --------------------------------------------------------- improvement */

/**
 * The closed set of improvement kinds.
 */
export const IMPROVEMENT_KINDS = ['planning', 'reasoning', 'learning'] as const
export type ImprovementKind = (typeof IMPROVEMENT_KINDS)[number]

export function isImprovementKind(value: unknown): value is ImprovementKind {
  return typeof value === 'string' && (IMPROVEMENT_KINDS as readonly string[]).includes(value)
}

/**
 * An improvement record.
 */
export interface ImprovementRecord {
  readonly improvementId: string
  readonly kind: ImprovementKind
  readonly state: 'proposed' | 'evaluating' | 'approved' | 'staged' | 'applied' | 'failed'
  readonly evidenceIds: readonly string[]
  readonly description: string
  readonly createdAt: string
  readonly appliedAt: string | null
}

/* --------------------------------------------------------- drift */

/**
 * The closed set of drift check outcomes.
 */
export const DRIFT_CHECK_OUTCOMES = ['no-drift', 'drift-detected', 'boundary-violation'] as const
export type DriftCheckOutcome = (typeof DRIFT_CHECK_OUTCOMES)[number]

export function isDriftCheckOutcome(value: unknown): value is DriftCheckOutcome {
  return typeof value === 'string' && (DRIFT_CHECK_OUTCOMES as readonly string[]).includes(value)
}

/**
 * A drift check record.
 */
export interface DriftCheckRecord {
  readonly checkId: string
  readonly improvementId: string
  readonly outcome: DriftCheckOutcome
  readonly reason: string
  readonly checkedAt: string
}

/* --------------------------------------------------------- explainability */

/**
 * The explainable evolution state.
 */
export interface EvolutionStateProjection {
  readonly currentState: EvolutionState
  readonly activeImprovements: readonly ImprovementSummary[]
  readonly pendingEvidence: readonly EvidenceRecord[]
  readonly recentDriftChecks: readonly DriftCheckRecord[]
  readonly nextBoundedAction: BoundedAction | null
  readonly generatedAt: string
}

/**
 * An improvement summary in the evolution state.
 */
export interface ImprovementSummary {
  readonly improvementId: string
  readonly kind: ImprovementKind
  readonly state: string
  readonly description: string
  readonly progress: number
}

/**
 * A bounded next action.
 */
export interface BoundedAction {
  readonly actionId: string
  readonly kind: 'evaluate' | 'improve' | 'verify' | 'stage' | 'apply' | 'wait' | 'escalate' | 'stop'
  readonly target: string
  readonly deadlineAt: string
  readonly maxAttempts: number
  readonly reasoning: readonly string[]
}

/* --------------------------------------------------------- limits */

/**
 * The evolution limits.
 *
 * These are code-owned ceilings. They cannot be widened.
 */
export const EVOLUTION_LIMITS = Object.freeze({
  maxImprovements: 32,
  maxEvidencePerImprovement: 16,
  maxImprovementDurationMs: 30 * 24 * 60 * 60 * 1_000,
  maxEvaluationDurationMs: 24 * 60 * 60 * 1_000,
  maxVerificationDurationMs: 24 * 60 * 60 * 1_000,
  maxStagingDurationMs: 7 * 24 * 60 * 60 * 1_000,
  maxRetryCeiling: 3,
  maxBackoffMs: 5 * 60_000,
  baseBackoffMs: 1_000,
  jitterMs: 1_000,
})

/* --------------------------------------------------------- events */

/**
 * The evolution event types.
 *
 * These are the event types the evolution subsystem appends.
 */
export const EVOLUTION_EVENT_TYPES = [
  'evolution.evidence.verified',
  'evolution.improvement.proposed',
  'evolution.improvement.evaluating',
  'evolution.improvement.approved',
  'evolution.improvement.staged',
  'evolution.improvement.applied',
  'evolution.improvement.failed',
  'evolution.drift-check.passed',
  'evolution.drift-check.failed',
  'evolution.drift-check.boundary-violation',
  'evolution.self-modification.attempted',
  'evolution.self-modification.refused',
  'evolution.continuation.decided',
  'evolution.wake.received',
  'evolution.wake.denied',
] as const

export type EvolutionEventType = (typeof EVOLUTION_EVENT_TYPES)[number]
