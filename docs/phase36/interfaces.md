/**
 * Phase 36 — Compile-Time Types and Interfaces
 *
 * **Status:** PREPARATION ONLY — NOT PRODUCTION
 *
 * These types and interfaces are compile-time only. They cannot activate
 * runtime behavior. They define the shape of Phase 36's components.
 *
 * These types are safe to cherry-pick later. They do not import any runtime
 * module. They do not create any side effects. They are pure type definitions.
 */

/* --------------------------------------------------------- resilience */

/**
 * The closed set of resilience states.
 */
export const RESILIENCE_STATES = [
  'HEALTHY',
  'DEGRADED',
  'RECOVERING',
  'REPAIRING',
  'FAILED',
] as const
export type ResilienceState = (typeof RESILIENCE_STATES)[number]

export function isResilienceState(value: unknown): value is ResilienceState {
  return typeof value === 'string' && (RESILIENCE_STATES as readonly string[]).includes(value)
}

/**
 * The closed set of failure kinds.
 */
export const FAILURE_KINDS = ['crash', 'data-corruption', 'data-loss', 'provider-failure', 'backup-corruption', 'repair-failure'] as const
export type FailureKind = (typeof FAILURE_KINDS)[number]

export function isFailureKind(value: unknown): value is FailureKind {
  return typeof value === 'string' && (FAILURE_KINDS as readonly string[]).includes(value)
}

/**
 * A failure event.
 */
export interface FailureEvent {
  readonly failureId: string
  readonly kind: FailureKind
  readonly detectedAt: string
  readonly context: string
  readonly recoverable: boolean
}

/* --------------------------------------------------------- recovery */

/**
 * The closed set of recovery outcomes.
 */
export const RECOVERY_OUTCOMES = ['success', 'partial', 'failed', 'interrupted'] as const
export type RecoveryOutcome = (typeof RECOVERY_OUTCOMES)[number]

export function isRecoveryOutcome(value: unknown): value is RecoveryOutcome {
  return typeof value === 'string' && (RECOVERY_OUTCOMES as readonly string[]).includes(value)
}

/**
 * A recovery record.
 */
export interface RecoveryRecord {
  readonly recoveryId: string
  readonly failureId: string
  readonly outcome: RecoveryOutcome
  readonly reason: string
  readonly startedAt: string
  readonly completedAt: string | null
}

/* --------------------------------------------------------- backup */

/**
 * The closed set of backup outcomes.
 */
export const BACKUP_OUTCOMES = ['success', 'failed', 'verified', 'corrupt'] as const
export type BackupOutcome = (typeof BACKUP_OUTCOMES)[number]

export function isBackupOutcome(value: unknown): value is BackupOutcome {
  return typeof value === 'string' && (BACKUP_OUTCOMES as readonly string[]).includes(value)
}

/**
 * A backup record.
 */
export interface BackupRecord {
  readonly backupId: string
  readonly environmentId: string
  readonly outcome: BackupOutcome
  readonly reason: string
  readonly createdAt: string
  readonly verifiedAt: string | null
}

/**
 * A restore record.
 */
export interface RestoreRecord {
  readonly restoreId: string
  readonly backupId: string
  readonly outcome: BackupOutcome
  readonly reason: string
  readonly startedAt: string
  readonly completedAt: string | null
}

/* --------------------------------------------------------- degraded mode */

/**
 * The closed set of degraded-mode levels.
 */
export const DEGRADED_LEVELS = ['none', 'mild', 'moderate', 'severe', 'critical'] as const
export type DegradedLevel = (typeof DEGRADED_LEVELS)[number]

export function isDegradedLevel(value: unknown): value is DegradedLevel {
  return typeof value === 'string' && (DEGRADED_LEVELS as readonly string[]).includes(value)
}

/**
 * A degraded-mode record.
 */
export interface DegradedModeRecord {
  readonly recordId: string
  readonly level: DegradedLevel
  readonly reason: string
  readonly capabilities: readonly string[]
  readonly startedAt: string
  readonly endedAt: string | null
}

/* --------------------------------------------------------- repair */

/**
 * The closed set of repair outcomes.
 */
export const REPAIR_OUTCOMES = ['success', 'partial', 'failed', 'not-authorized'] as const
export type RepairOutcome = (typeof REPAIR_OUTCOMES)[number]

export function isRepairOutcome(value: unknown): value is RepairOutcome {
  return typeof value === 'string' && (REPAIR_OUTCOMES as readonly string[]).includes(value)
}

/**
 * A repair record.
 */
export interface RepairRecord {
  readonly repairId: string
  readonly failureId: string
  readonly outcome: RepairOutcome
  readonly reason: string
  readonly authorizedBy: string | null
  readonly startedAt: string
  readonly completedAt: string | null
}

/* --------------------------------------------------------- explainability */

/**
 * The explainable resilience state.
 */
export interface ResilienceStateProjection {
  readonly currentState: ResilienceState
  readonly activeRecoveries: readonly RecoverySummary[]
  readonly activeRepairs: readonly RepairSummary[]
  readonly degradedMode: DegradedModeRecord | null
  readonly recentFailures: readonly FailureSummary[]
  readonly nextBoundedAction: BoundedAction | null
  readonly generatedAt: string
}

/**
 * A recovery summary in the resilience state.
 */
export interface RecoverySummary {
  readonly recoveryId: string
  readonly failureId: string
  readonly outcome: RecoveryOutcome
  readonly reason: string
  readonly progress: number
}

/**
 * A repair summary in the resilience state.
 */
export interface RepairSummary {
  readonly repairId: string
  readonly failureId: string
  readonly outcome: RepairOutcome
  readonly reason: string
  readonly progress: number
}

/**
 * A failure summary in the resilience state.
 */
export interface FailureSummary {
  readonly failureId: string
  readonly kind: FailureKind
  readonly detectedAt: string
  readonly recoverable: boolean
}

/**
 * A bounded next action.
 */
export interface BoundedAction {
  readonly actionId: string
  readonly kind: 'recover' | 'repair' | 'backup' | 'restore' | 'verify' | 'wait' | 'escalate' | 'stop'
  readonly target: string
  readonly deadlineAt: string
  readonly maxAttempts: number
  readonly reasoning: readonly string[]
}

/* --------------------------------------------------------- limits */

/**
 * The resilience limits.
 *
 * These are code-owned ceilings. They cannot be widened.
 */
export const RESILIENCE_LIMITS = Object.freeze({
  maxRecoveryAttempts: 3,
  maxRecoveryDurationMs: 24 * 60 * 60 * 1_000,
  maxRepairAttempts: 3,
  maxRepairDurationMs: 24 * 60 * 60 * 1_000,
  maxBackupDurationMs: 24 * 60 * 60 * 1_000,
  maxRestoreDurationMs: 24 * 60 * 60 * 1_000,
  maxConcurrentRecoveries: 2,
  maxConcurrentRepairs: 1,
  maxRetryCeiling: 3,
  maxBackoffMs: 5 * 60_000,
  baseBackoffMs: 1_000,
  jitterMs: 1_000,
  maxDegradedModeDurationMs: 7 * 24 * 60 * 60 * 1_000,
})

/* --------------------------------------------------------- events */

/**
 * The resilience event types.
 *
 * These are the event types the resilience subsystem appends.
 */
export const RESILIENCE_EVENT_TYPES = [
  'resilience.failure.detected',
  'resilience.recovery.started',
  'resilience.recovery.completed',
  'resilience.recovery.failed',
  'resilience.backup.created',
  'resilience.backup.verified',
  'resilience.restore.started',
  'resilience.restore.completed',
  'resilience.restore.failed',
  'resilience.degraded-mode.entered',
  'resilience.degraded-mode.exited',
  'resilience.repair.started',
  'resilience.repair.completed',
  'resilience.repair.failed',
  'resilience.repair.unauthorized',
  'resilience.self-modification.attempted',
  'resilience.self-modification.refused',
  'resilience.continuation.decided',
  'resilience.wake.received',
  'resilience.wake.denied',
] as const

export type ResilienceEventType = (typeof RESILIENCE_EVENT_TYPES)[number]
