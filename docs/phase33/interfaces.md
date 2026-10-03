/**
 * Phase 33 — Compile-Time Types and Interfaces
 *
 * **Status:** PREPARATION ONLY — NOT PRODUCTION
 *
 * These types and interfaces are compile-time only. They cannot activate
 * runtime behavior. They define the shape of Phase 33's components.
 *
 * These types are safe to cherry-pick later. They do not import any runtime
 * module. They do not create any side effects. They are pure type definitions.
 */

/* --------------------------------------------------------- environment */

/**
 * The closed set of business environment states.
 */
export const ENVIRONMENT_STATES = [
  'draft',
  'active',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const
export type EnvironmentState = (typeof ENVIRONMENT_STATES)[number]

export function isEnvironmentState(value: unknown): value is EnvironmentState {
  return typeof value === 'string' && (ENVIRONMENT_STATES as readonly string[]).includes(value)
}

/**
 * The closed set of business environment kinds.
 */
export const ENVIRONMENT_KINDS = ['webzone', 'marketplace', 'service', 'content'] as const
export type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number]

export function isEnvironmentKind(value: unknown): value is EnvironmentKind {
  return typeof value === 'string' && (ENVIRONMENT_KINDS as readonly string[]).includes(value)
}

/**
 * An owner-controlled business environment.
 */
export interface BusinessEnvironment {
  readonly environmentId: string
  readonly kind: EnvironmentKind
  readonly state: EnvironmentState
  readonly title: string
  readonly description: string
  readonly completionCriteria: readonly string[]
  readonly progress: number
  readonly boundaries: EnterpriseBoundaries
  readonly spendingLimits: SpendingLimits
  readonly deadlineAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly completedAt: string | null
}

/* --------------------------------------------------------- boundaries */

/**
 * Enterprise boundaries.
 */
export interface EnterpriseBoundaries {
  readonly maxTasks: number
  readonly maxMissions: number
  readonly maxWebzoneOperations: number
  readonly maxConcurrentOperations: number
  readonly allowedDomains: readonly string[]
  readonly forbiddenActions: readonly string[]
}

/* --------------------------------------------------------- spending */

/**
 * Spending limits.
 */
export interface SpendingLimits {
  readonly maxTotalSpend: number
  readonly maxPerAction: number
  readonly maxPerDay: number
  readonly currency: string
  readonly hardCeiling: boolean
}

/* --------------------------------------------------------- tasks */

/**
 * The closed set of task states.
 */
export const TASK_STATES = [
  'draft',
  'active',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const
export type TaskState = (typeof TASK_STATES)[number]

export function isTaskState(value: unknown): value is TaskState {
  return typeof value === 'string' && (TASK_STATES as readonly string[]).includes(value)
}

/**
 * An enterprise task.
 */
export interface EnterpriseTask {
  readonly taskId: string
  readonly environmentId: string
  readonly state: TaskState
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

/* --------------------------------------------------------- missions */

/**
 * The closed set of mission states.
 */
export const MISSION_STATES = [
  'draft',
  'active',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const
export type MissionState = (typeof MISSION_STATES)[number]

export function isMissionState(value: unknown): value is MissionState {
  return typeof value === 'string' && (MISSION_STATES as readonly string[]).includes(value)
}

/**
 * An enterprise mission.
 */
export interface EnterpriseMission {
  readonly missionId: string
  readonly environmentId: string
  readonly state: MissionState
  readonly title: string
  readonly description: string
  readonly completionCriteria: readonly string[]
  readonly progress: number
  readonly childTaskIds: readonly string[]
  readonly deadlineAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly completedAt: string | null
}

/* --------------------------------------------------------- webzone */

/**
 * The closed set of webzone operation states.
 */
export const WEBZONE_OPERATION_STATES = [
  'pending',
  'active',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const
export type WebzoneOperationState = (typeof WEBZONE_OPERATION_STATES)[number]

export function isWebzoneOperationState(value: unknown): value is WebzoneOperationState {
  return typeof value === 'string' && (WEBZONE_OPERATION_STATES as readonly string[]).includes(value)
}

/**
 * A webzone operation.
 */
export interface WebzoneOperation {
  readonly operationId: string
  readonly environmentId: string
  readonly state: WebzoneOperationState
  readonly kind: 'publish' | 'update' | 'delete' | 'query' | 'interact'
  readonly target: string
  readonly payload: string
  readonly createdAt: string
  readonly completedAt: string | null
}

/* --------------------------------------------------------- verification */

/**
 * The closed set of verification outcomes.
 */
export const VERIFICATION_OUTCOMES = ['passed', 'failed', 'interrupted', 'deadline-expired'] as const
export type VerificationOutcome = (typeof VERIFICATION_OUTCOMES)[number]

export function isVerificationOutcome(value: unknown): value is VerificationOutcome {
  return typeof value === 'string' && (VERIFICATION_OUTCOMES as readonly string[]).includes(value)
}

/**
 * An external-action verification record.
 */
export interface ExternalActionVerification {
  readonly verificationId: string
  readonly actionId: string
  readonly environmentId: string
  readonly outcome: VerificationOutcome
  readonly reason: string
  readonly verifiedAt: string
}

/* --------------------------------------------------------- rollback */

/**
 * The closed set of rollback outcomes.
 */
export const ROLLBACK_OUTCOMES = ['success', 'partial', 'failed', 'not-reversible'] as const
export type RollbackOutcome = (typeof ROLLBACK_OUTCOMES)[number]

export function isRollbackOutcome(value: unknown): value is RollbackOutcome {
  return typeof value === 'string' && (ROLLBACK_OUTCOMES as readonly string[]).includes(value)
}

/**
 * A rollback record.
 */
export interface RollbackRecord {
  readonly rollbackId: string
  readonly actionId: string
  readonly environmentId: string
  readonly outcome: RollbackOutcome
  readonly reason: string
  readonly rolledBackAt: string
}

/* --------------------------------------------------------- explainability */

/**
 * The explainable enterprise state.
 */
export interface EnterpriseStateProjection {
  readonly activeEnvironments: readonly EnvironmentSummary[]
  readonly blockedEnvironments: readonly EnvironmentSummary[]
  readonly uncertainEnvironments: readonly EnvironmentSummary[]
  readonly recentActions: readonly ActionSummary[]
  readonly nextBoundedAction: BoundedAction | null
  readonly generatedAt: string
}

/**
 * An environment summary in the enterprise state.
 */
export interface EnvironmentSummary {
  readonly environmentId: string
  readonly kind: EnvironmentKind
  readonly state: EnvironmentState
  readonly title: string
  readonly progress: number
  readonly reasoning: readonly string[]
  readonly blockedReason: string | null
  readonly uncertainty: readonly string[]
}

/**
 * An action summary in the enterprise state.
 */
export interface ActionSummary {
  readonly actionId: string
  readonly kind: string
  readonly target: string
  readonly state: string
  readonly reasoning: readonly string[]
}

/**
 * A bounded next action.
 */
export interface BoundedAction {
  readonly actionId: string
  readonly kind: 'execute' | 'delegate' | 'verify' | 'wait' | 'escalate' | 'stop' | 'rollback'
  readonly target: string
  readonly deadlineAt: string
  readonly maxAttempts: number
  readonly reasoning: readonly string[]
}

/* --------------------------------------------------------- limits */

/**
 * The enterprise limits.
 *
 * These are code-owned ceilings. They cannot be widened.
 */
export const ENTERPRISE_LIMITS = Object.freeze({
  maxEnvironments: 16,
  maxTasksPerEnvironment: 64,
  maxMissionsPerEnvironment: 32,
  maxWebzoneOperationsPerEnvironment: 128,
  maxConcurrentOperations: 8,
  maxEnvironmentDurationMs: 90 * 24 * 60 * 60 * 1_000,
  maxTaskDurationMs: 30 * 24 * 60 * 60 * 1_000,
  maxMissionDurationMs: 60 * 24 * 60 * 60 * 1_000,
  maxWebzoneOperationDurationMs: 24 * 60 * 60 * 1_000,
  maxRetryCeiling: 3,
  maxBackoffMs: 5 * 60_000,
  baseBackoffMs: 1_000,
  jitterMs: 1_000,
  maxRollbackAttempts: 3,
  maxSpendingGateChecksPerAction: 1,
})

/* --------------------------------------------------------- events */

/**
 * The enterprise event types.
 *
 * These are the event types the enterprise subsystem appends.
 */
export const ENTERPRISE_EVENT_TYPES = [
  'enterprise.environment.created',
  'enterprise.environment.updated',
  'enterprise.environment.state-changed',
  'enterprise.environment.completed',
  'enterprise.environment.failed',
  'enterprise.environment.cancelled',
  'enterprise.task.created',
  'enterprise.task.updated',
  'enterprise.task.state-changed',
  'enterprise.task.completed',
  'enterprise.task.failed',
  'enterprise.mission.created',
  'enterprise.mission.updated',
  'enterprise.mission.state-changed',
  'enterprise.mission.completed',
  'enterprise.mission.failed',
  'enterprise.webzone-operation.started',
  'enterprise.webzone-operation.completed',
  'enterprise.webzone-operation.failed',
  'enterprise.spending-gate.checked',
  'enterprise.spending-gate.exceeded',
  'enterprise.external-action.verified',
  'enterprise.external-action.failed',
  'enterprise.rollback.executed',
  'enterprise.rollback.failed',
  'enterprise.continuation.decided',
  'enterprise.wake.received',
  'enterprise.wake.denied',
] as const

export type EnterpriseEventType = (typeof ENTERPRISE_EVENT_TYPES)[number]
