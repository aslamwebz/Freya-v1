/**
 * Phase 31 — Compile-Time Types and Interfaces
 *
 * **Status:** PREPARATION ONLY — NOT PRODUCTION
 *
 * These types and interfaces are compile-time only. They cannot activate
 * runtime behavior. They define the shape of Phase 31's components.
 *
 * These types are safe to cherry-pick later. They do not import any runtime
 * module. They do not create any side effects. They are pure type definitions.
 */

/* ------------------------------------------------------------- goals */

/**
 * The closed set of goal states.
 */
export const GOAL_STATES = [
  'draft',
  'active',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const
export type GoalState = (typeof GOAL_STATES)[number]

export function isGoalState(value: unknown): value is GoalState {
  return typeof value === 'string' && (GOAL_STATES as readonly string[]).includes(value)
}

/**
 * The closed set of goal kinds.
 */
export const GOAL_KINDS = ['mission', 'project', 'research', 'maintenance'] as const
export type GoalKind = (typeof GOAL_KINDS)[number]

export function isGoalKind(value: unknown): value is GoalKind {
  return typeof value === 'string' && (GOAL_KINDS as readonly string[]).includes(value)
}

/**
 * A persistent long-horizon goal.
 */
export interface Goal {
  readonly goalId: string
  readonly kind: GoalKind
  readonly state: GoalState
  readonly title: string
  readonly description: string
  readonly completionCriteria: readonly string[]
  readonly progress: number
  readonly dependencies: readonly string[]
  readonly deadlineAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly completedAt: string | null
}

/**
 * A goal checkpoint.
 */
export interface GoalCheckpoint {
  readonly checkpointId: string
  readonly goalId: string
  readonly order: number
  readonly description: string
  readonly status: 'pending' | 'in-progress' | 'verified' | 'failed'
  readonly verifiedAt: string | null
  readonly failureReason: string | null
}

/* --------------------------------------------------------- scheduling */

/**
 * The closed set of schedule conditions.
 */
export const SCHEDULE_CONDITIONS = ['always', 'focus-available', 'goal-open'] as const
export type ScheduleCondition = (typeof SCHEDULE_CONDITIONS)[number]

export function isScheduleCondition(value: unknown): value is ScheduleCondition {
  return typeof value === 'string' && (SCHEDULE_CONDITIONS as readonly string[]).includes(value)
}

/**
 * A bounded schedule for long-horizon continuation.
 */
export interface LongHorizonSchedule {
  readonly scheduleId: string
  readonly goalId: string
  readonly condition: ScheduleCondition
  readonly dueAt: string
  readonly fired: boolean
  readonly repeatCount: number
  readonly maxRepeats: number
  readonly createdAt: string
}

/* ------------------------------------------------------ continuation */

/**
 * The closed set of long-horizon continuation states.
 */
export const LONG_HORIZON_STATES = [
  'IDLE',
  'GOAL_ACTIVE',
  'CHECKPOINT',
  'GOAL_PAUSED',
  'GOAL_COMPLETE',
  'GOAL_FAILED',
] as const
export type LongHorizonState = (typeof LONG_HORIZON_STATES)[number]

export function isLongHorizonState(value: unknown): value is LongHorizonState {
  return typeof value === 'string' && (LONG_HORIZON_STATES as readonly string[]).includes(value)
}

/**
 * A long-horizon continuation decision.
 */
export type LongHorizonDecision =
  | { readonly decision: 'continue'; readonly reason: string }
  | { readonly decision: 'pause'; readonly reason: string }
  | { readonly decision: 'complete'; readonly reason: string }
  | { readonly decision: 'fail'; readonly reason: string }
  | { readonly decision: 'wait'; readonly reason: string; readonly deadline: string }

/* ------------------------------------------------------ verification */

/**
 * The closed set of verification outcomes.
 */
export const VERIFICATION_OUTCOMES = ['passed', 'failed', 'interrupted', 'deadline-expired'] as const
export type VerificationOutcome = (typeof VERIFICATION_OUTCOMES)[number]

export function isVerificationOutcome(value: unknown): value is VerificationOutcome {
  return typeof value === 'string' && (VERIFICATION_OUTCOMES as readonly string[]).includes(value)
}

/**
 * A verification record for a goal checkpoint.
 */
export interface CheckpointVerification {
  readonly verificationId: string
  readonly checkpointId: string
  readonly goalId: string
  readonly outcome: VerificationOutcome
  readonly reason: string
  readonly verifiedAt: string
}

/* ------------------------------------------------------ uncertainty */

/**
 * The closed set of confidence levels.
 */
export const CONFIDENCE_LEVELS = ['high', 'medium', 'low', 'unknown'] as const
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number]

export function isConfidenceLevel(value: unknown): value is ConfidenceLevel {
  return typeof value === 'string' && (CONFIDENCE_LEVELS as readonly string[]).includes(value)
}

/**
 * An assumption made during long-horizon planning.
 */
export interface LongHorizonAssumption {
  readonly assumptionId: string
  readonly goalId: string
  readonly statement: string
  readonly confidence: ConfidenceLevel
  readonly source: string
  readonly expiresAt: string
  readonly status: 'active' | 'confirmed' | 'refuted' | 'expired'
}

/* ------------------------------------------------------ explainability */

/**
 * The explainable long-horizon state.
 */
export interface LongHorizonStateProjection {
  readonly activeGoals: readonly GoalSummary[]
  readonly blockedGoals: readonly GoalSummary[]
  readonly uncertainGoals: readonly GoalSummary[]
  readonly nextBoundedAction: BoundedAction | null
  readonly generatedAt: string
}

/**
 * A goal summary in the long-horizon state.
 */
export interface GoalSummary {
  readonly goalId: string
  readonly kind: GoalKind
  readonly state: GoalState
  readonly title: string
  readonly progress: number
  readonly reasoning: readonly string[]
  readonly blockedReason: string | null
  readonly uncertainty: readonly string[]
}

/**
 * A bounded next action.
 */
export interface BoundedAction {
  readonly actionId: string
  readonly kind: 'execute' | 'delegate' | 'verify' | 'wait' | 'escalate' | 'stop'
  readonly target: string
  readonly deadlineAt: string
  readonly maxAttempts: number
  readonly reasoning: readonly string[]
}

/* ------------------------------------------------------ limits */

/**
 * The long-horizon limits.
 *
 * These are code-owned ceilings. They cannot be widened.
 */
export const LONG_HORIZON_LIMITS = Object.freeze({
  maxGoals: 32,
  maxCheckpointsPerGoal: 64,
  maxSchedules: 64,
  maxScheduleRepeats: 8,
  minScheduleIntervalMs: 60_000,
  maxScheduleHorizonMs: 30 * 24 * 60 * 60 * 1_000,
  maxGoalDurationMs: 90 * 24 * 60 * 60 * 1_000,
  maxCheckpointVerificationMs: 24 * 60 * 60 * 1_000,
  maxRetryCeiling: 3,
  maxBackoffMs: 5 * 60_000,
  baseBackoffMs: 1_000,
  jitterMs: 1_000,
})

/* ------------------------------------------------------ events */

/**
 * The long-horizon event types.
 *
 * These are the event types the long-horizon subsystem appends.
 */
export const LONG_HORIZON_EVENT_TYPES = [
  'longhorizon.goal.created',
  'longhorizon.goal.updated',
  'longhorizon.goal.state-changed',
  'longhorizon.goal.completed',
  'longhorizon.goal.failed',
  'longhorizon.goal.cancelled',
  'longhorizon.checkpoint.started',
  'longhorizon.checkpoint.verified',
  'longhorizon.checkpoint.failed',
  'longhorizon.continuation.decided',
  'longhorizon.schedule.fired',
  'longhorizon.schedule.expired',
  'longhorizon.wake.received',
  'longhorizon.wake.denied',
] as const

export type LongHorizonEventType = (typeof LONG_HORIZON_EVENT_TYPES)[number]
