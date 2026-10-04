/**
 * Phase 36 — Resilience & Self-Recovery's domain vocabulary.
 *
 * Everything in this file is a closed set. That is not tidiness. A resilience
 * subsystem is only trustworthy if the set of states it can be in, the set of
 * failures it can detect, the set of outcomes a recovery can have, the set of
 * reasons it can refuse and the set of numbers that bound it are all finite
 * and all owned by code. An open vocabulary here would mean an unbounded
 * recovery agent by construction, and "no authority widening" would be a
 * policy rather than a type.
 *
 * The module is deliberately dependency-free. It imports nothing from Core,
 * reads no clock, reaches no provider and mints no authority. It is types,
 * frozen tables and closed code lists — which is what makes the state machine,
 * the authority gate, the deadline arithmetic and the recovery planners
 * testable without a running system, and safe to build before the subsystems
 * it will later consume.
 */

/* ---------------------------------------------------------- resilience */

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
export const FAILURE_KINDS = [
  'crash',
  'data-corruption',
  'data-loss',
  'provider-failure',
  'backup-corruption',
  'repair-failure',
] as const

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

export type ResilienceLimits = typeof RESILIENCE_LIMITS

/**
 * The same keys, with plain number values.
 */
export type ResilienceLimitsLike = { readonly [K in keyof ResilienceLimits]: number }

/**
 * A request to narrow the ceilings.
 *
 * Deliberately untyped as to value. A request is untrusted input: it may be
 * wider than the ceiling it names, non-numeric, negative, or absent, and
 * `narrowResilienceLimits` has to survive all of it without the caller being
 * able to widen anything.
 */
export type ResilienceLimitRequest = { readonly [K in keyof ResilienceLimits]?: unknown }

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
  'resilience.stopped',
  'resilience.unstopped',
  'resilience.reconciled',
  'resilience.gate.decided',
  'resilience.refusal.recorded',
] as const

export type ResilienceEventType = (typeof RESILIENCE_EVENT_TYPES)[number]

export const RESILIENCE_EVENT_SET: ReadonlySet<string> = new Set<string>(RESILIENCE_EVENT_TYPES)

export function isResilienceEventType(value: unknown): value is ResilienceEventType {
  return typeof value === 'string' && RESILIENCE_EVENT_SET.has(value)
}

/* --------------------------------------------------------- refusal */

/**
 * The closed reasons a resilience request was refused.
 */
export const RESILIENCE_REFUSAL_CODES = [
  'journal-not-trustworthy',
  'stop-all-active',
  'resilience-disabled',
  'guard-denied',
  'governor-denied',
  'budget-exhausted',
  'approval-required',
  'real-money-prohibited',
  'real-order-prohibited',
  'spending-authority-prohibited',
  'capability-widening-prohibited',
  'grant-creation-prohibited',
  'self-approval-prohibited',
  'priority-escalation-prohibited',
  'budget-widening-prohibited',
  'authority-claim-prohibited',
  'polling-prohibited',
  'inference-without-wake-prohibited',
  'state-fabrication-prohibited',
  'silent-resume-prohibited',
  'self-modification-prohibited',
  'recovery-attempt-ceiling-reached',
  'repair-attempt-ceiling-reached',
  'backup-attempt-ceiling-reached',
  'restore-attempt-ceiling-reached',
  'unknown-failure-kind',
  'unknown-recovery',
  'unknown-repair',
  'unknown-backup',
  'unknown-restore',
  'recovery-already-active',
  'repair-already-active',
  'concurrent-recovery-limit',
  'concurrent-repair-limit',
  'deadline-expired',
  'interrupted',
] as const

export type ResilienceRefusalCode = (typeof RESILIENCE_REFUSAL_CODES)[number]

export function isResilienceRefusalCode(value: unknown): value is ResilienceRefusalCode {
  return typeof value === 'string' && (RESILIENCE_REFUSAL_CODES as readonly string[]).includes(value)
}

/**
 * The closed subjects a refusal can name.
 */
export const RESILIENCE_REFUSAL_SUBJECTS = [
  'wake',
  'recovery',
  'repair',
  'backup',
  'restore',
  'degraded-mode',
  'continuation',
] as const

export type ResilienceRefusalSubject = (typeof RESILIENCE_REFUSAL_SUBJECTS)[number]

export function isResilienceRefusalSubject(value: unknown): value is ResilienceRefusalSubject {
  return typeof value === 'string' && (RESILIENCE_REFUSAL_SUBJECTS as readonly string[]).includes(value)
}

/* --------------------------------------------------------- wake */

/**
 * The closed set of authorized wake sources for resilience.
 */
export const RESILIENCE_WAKE_SOURCES = [
  'owner-interaction',
  'authorized-event',
  'scheduled-heartbeat',
  'mission-transition',
  'work-transition',
] as const

export type ResilienceWakeSource = (typeof RESILIENCE_WAKE_SOURCES)[number]

export function isResilienceWakeSource(value: unknown): value is ResilienceWakeSource {
  return typeof value === 'string' && (RESILIENCE_WAKE_SOURCES as readonly string[]).includes(value)
}

/**
 * The closed set of wake kinds for resilience.
 */
export const RESILIENCE_WAKE_KINDS = [
  'owner-message',
  'owner-command',
  'owner-approval',
  'mission-completed',
  'mission-failed',
  'run-completed',
  'run-failed',
  'step-verified',
  'schedule-due',
  'system-health',
  'failure-detected',
  'recovery-needed',
] as const

export type ResilienceWakeKind = (typeof RESILIENCE_WAKE_KINDS)[number]

export function isResilienceWakeKind(value: unknown): value is ResilienceWakeKind {
  return typeof value === 'string' && (RESILIENCE_WAKE_KINDS as readonly string[]).includes(value)
}

/**
 * Which source each kind may arrive on.
 */
export const RESILIENCE_WAKE_KIND_SOURCE: Readonly<Record<ResilienceWakeKind, ResilienceWakeSource>> =
  Object.freeze({
    'owner-message': 'owner-interaction',
    'owner-command': 'owner-interaction',
    'owner-approval': 'owner-interaction',
    'mission-completed': 'mission-transition',
    'mission-failed': 'mission-transition',
    'run-completed': 'work-transition',
    'run-failed': 'work-transition',
    'step-verified': 'work-transition',
    'schedule-due': 'scheduled-heartbeat',
    'system-health': 'authorized-event',
    'failure-detected': 'authorized-event',
    'recovery-needed': 'authorized-event',
  })

/**
 * Who is claiming to have produced a wake.
 */
export const RESILIENCE_WAKE_ACTORS = [
  'owner',
  'core-subsystem',
  'host-heartbeat',
  'model',
  'renderer',
  'agent',
  'connector',
  'external-webhook',
  'timer',
] as const

export type ResilienceWakeActor = (typeof RESILIENCE_WAKE_ACTORS)[number]

export function isResilienceWakeActor(value: unknown): value is ResilienceWakeActor {
  return typeof value === 'string' && (RESILIENCE_WAKE_ACTORS as readonly string[]).includes(value)
}

/**
 * The only actor permitted to raise each source.
 */
export const RESILIENCE_WAKE_SOURCE_ACTOR: Readonly<
  Record<ResilienceWakeSource, ResilienceWakeActor>
> = Object.freeze({
  'owner-interaction': 'owner',
  'authorized-event': 'core-subsystem',
  'scheduled-heartbeat': 'host-heartbeat',
  'mission-transition': 'core-subsystem',
  'work-transition': 'core-subsystem',
})

/**
 * A wake event for resilience.
 */
export interface ResilienceWake {
  readonly wakeId: string
  readonly source: ResilienceWakeSource
  readonly kind: ResilienceWakeKind
  readonly goalRef: string | null
  readonly sourceRef: string | null
  readonly occurredAt: string
  readonly observedAt: string
}

/**
 * The closed reasons a resilience wake was refused.
 */
export const RESILIENCE_WAKE_REFUSAL_CODES = [
  'unknown-source',
  'unknown-kind',
  'kind-source-mismatch',
  'unauthorized-actor',
  'missing-wake-id',
  'malformed-timestamp',
  'observed-before-occurred',
  'stop-all-active',
  'journal-not-trustworthy',
  'duplicate-wake',
  'runtime-busy',
  'runtime-closed',
  'polling-prohibited',
] as const

export type ResilienceWakeRefusalCode = (typeof RESILIENCE_WAKE_REFUSAL_CODES)[number]

export function isResilienceWakeRefusalCode(value: unknown): value is ResilienceWakeRefusalCode {
  return (
    typeof value === 'string' && (RESILIENCE_WAKE_REFUSAL_CODES as readonly string[]).includes(value)
  )
}

export type ResilienceAnyRefusalCode = ResilienceRefusalCode | ResilienceWakeRefusalCode

/* --------------------------------------------------------- assertions */

/**
 * The Phase 36 assertions, by id. Each is checkable and none is decorative.
 */
export const RESILIENCE_ASSERTIONS = [
  'noRealMoneyAction',
  'noRealOrder',
  'noModelCallWithoutWake',
  'noContinuousPolling',
  'noHiddenReasoning',
  'noUnrestrictedLoops',
  'noAuthorityEscalation',
  'noIdleModelCall',
  'noHiddenDurableState',
  'noSelfApproval',
  'noBudgetWidening',
  'noSelfModification',
  'noCapabilityWidening',
  'noGrantCreation',
  'noSilentResume',
  'noStateFabrication',
  'noDegradationHiding',
  'noCapabilityFabrication',
] as const

export type ResilienceAssertionId = (typeof RESILIENCE_ASSERTIONS)[number]

export type ResilienceAssertionVerdict = Readonly<Record<ResilienceAssertionId, boolean>>

/* --------------------------------------------------------- payload keys */

/**
 * The closed payload vocabulary, per event type.
 */
export const RESILIENCE_PAYLOAD_KEYS: Readonly<Record<ResilienceEventType, readonly string[]>> =
  Object.freeze({
    'resilience.failure.detected': ['failureId', 'kind', 'detectedAt', 'context', 'recoverable'],
    'resilience.recovery.started': ['recoveryId', 'failureId', 'startedAt'],
    'resilience.recovery.completed': ['recoveryId', 'failureId', 'outcome', 'reason', 'completedAt'],
    'resilience.recovery.failed': ['recoveryId', 'failureId', 'reason', 'completedAt'],
    'resilience.backup.created': ['backupId', 'environmentId', 'outcome', 'reason', 'createdAt'],
    'resilience.backup.verified': ['backupId', 'verifiedAt', 'outcome'],
    'resilience.restore.started': ['restoreId', 'backupId', 'startedAt'],
    'resilience.restore.completed': ['restoreId', 'backupId', 'outcome', 'reason', 'completedAt'],
    'resilience.restore.failed': ['restoreId', 'backupId', 'reason', 'completedAt'],
    'resilience.degraded-mode.entered': ['recordId', 'level', 'reason', 'capabilities', 'startedAt'],
    'resilience.degraded-mode.exited': ['recordId', 'endedAt'],
    'resilience.repair.started': ['repairId', 'failureId', 'authorizedBy', 'startedAt'],
    'resilience.repair.completed': ['repairId', 'failureId', 'outcome', 'reason', 'completedAt'],
    'resilience.repair.failed': ['repairId', 'failureId', 'reason', 'completedAt'],
    'resilience.repair.unauthorized': ['repairId', 'failureId', 'reason'],
    'resilience.self-modification.attempted': ['attemptId', 'target', 'reason'],
    'resilience.self-modification.refused': ['attemptId', 'target', 'reason'],
    'resilience.continuation.decided': ['decision', 'from', 'to', 'reasoning'],
    'resilience.wake.received': [
      'wakeId',
      'source',
      'kind',
      'wakeKey',
      'goalRef',
      'sourceRef',
      'occurredAt',
      'observedAt',
    ],
    'resilience.wake.denied': ['wakeId', 'source', 'kind', 'code'],
    'resilience.stopped': ['failureId', 'kind', 'code'],
    'resilience.unstopped': ['code'],
    'resilience.reconciled': ['code', 'from', 'reason'],
    'resilience.gate.decided': ['wakeId', 'subject', 'outcome', 'code', 'checked', 'remainingUnits', 'at'],
    'resilience.refusal.recorded': ['refusalId', 'code', 'subject', 'target', 'wakeId', 'at'],
  })

/**
 * Keys that must never appear in a resilience payload.
 */
export const FORBIDDEN_RESILIENCE_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  'capability',
  'capabilities',
  'grant',
  'grantId',
  'authority',
  'verdict',
  'allowed',
  'approved',
  'approvalId',
  'token',
  'secret',
  'credential',
  'budget',
  'priority',
  'principal',
  'actor',
  'spend',
  'spendingAuthority',
  'venue',
  'broker',
  'brokerage',
  'account',
  'accountId',
  'wallet',
  'exchange',
  'live',
  'realMoney',
  'realOrder',
  'capital',
  'notional',
  'currencyPair',
  'custodian',
  'withdrawal',
  'deposit',
])
