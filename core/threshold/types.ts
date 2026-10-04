/**
 * Phase 39 — Mature Freya Threshold's domain vocabulary.
 *
 * Everything in this file is a closed set. That is not tidiness. A threshold
 * subsystem is only trustworthy if the set of states it can be in, the set of
 * dimensions it measures, the set of levels a dimension can reach, the set of
 * reasons it can refuse and the set of numbers that bound it are all finite
 * and all owned by code. An open vocabulary here would mean an unbounded
 * assessment agent by construction, and "no authority widening" would be a
 * policy rather than a type.
 *
 * The module is deliberately dependency-free. It imports nothing from Core,
 * reads no clock, reaches no provider and mints no authority. It is types,
 * frozen tables and closed code lists — which is what makes the state machine,
 * the authority gate, the evidence verification and the rollback controller
 * testable without a running system, and safe to build before the subsystems
 * it will later consume.
 */

/* ---------------------------------------------------------- threshold */

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
export const THRESHOLD_EVIDENCE_QUALITY = [
  'insufficient',
  'weak',
  'moderate',
  'strong',
  'verified',
] as const

export type ThresholdEvidenceQuality = (typeof THRESHOLD_EVIDENCE_QUALITY)[number]

export function isThresholdEvidenceQuality(value: unknown): value is ThresholdEvidenceQuality {
  return (
    typeof value === 'string' && (THRESHOLD_EVIDENCE_QUALITY as readonly string[]).includes(value)
  )
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
  readonly kind:
    | 'assess'
    | 'collect'
    | 'verify'
    | 'evaluate'
    | 'prove'
    | 'suspend'
    | 'rollback'
    | 'wait'
    | 'escalate'
    | 'stop'
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

export type ThresholdLimits = typeof THRESHOLD_LIMITS

/**
 * The same keys, with plain number values.
 */
export type ThresholdLimitsLike = { readonly [K in keyof ThresholdLimits]: number }

/**
 * A request to narrow the ceilings.
 *
 * Deliberately untyped as to value. A request is untrusted input: it may be
 * wider than the ceiling it names, non-numeric, negative, or absent, and
 * `narrowThresholdLimits` has to survive all of it without the caller being
 * able to widen anything.
 */
export type ThresholdLimitRequest = { readonly [K in keyof ThresholdLimits]?: unknown }

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

export const THRESHOLD_EVENT_SET: ReadonlySet<string> = new Set<string>(THRESHOLD_EVENT_TYPES)

export function isThresholdEventType(value: unknown): value is ThresholdEventType {
  return typeof value === 'string' && THRESHOLD_EVENT_SET.has(value)
}

/* --------------------------------------------------------- refusal */

/**
 * The closed reasons a threshold request was refused.
 */
export const THRESHOLD_REFUSAL_CODES = [
  'journal-not-trustworthy',
  'stop-all-active',
  'threshold-disabled',
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
  'evidence-fabrication-prohibited',
  'maturity-self-grant-prohibited',
  'maturity-authority-widening-prohibited',
  'assessment-attempt-ceiling-reached',
  'evidence-collection-attempt-ceiling-reached',
  'evaluation-attempt-ceiling-reached',
  'unknown-dimension',
  'unknown-criterion',
  'unknown-evidence',
  'unknown-assessment',
  'unknown-rollback',
  'assessment-already-active',
  'evidence-already-collected',
  'concurrent-assessment-limit',
  'deadline-expired',
  'interrupted',
  /**
   * A transition the state machine does not contain.
   *
   * This was missing from the closed list while three places already used it: the
   * machine's own transition check, the fold's anomaly codes, and `ThresholdRuntime.resume`,
   * which refuses with exactly this when the current state is not `SUSPENDED`. The
   * refusal was real and reportable — it is the answer to "why did resume do
   * nothing?" — but the vocabulary had no word for it, so the code did not compile.
   *
   * Adding a refusal code makes the subsystem refuse more, never less: it is the
   * fail-closed direction, and it is what lets an illegal transition be reported in
   * the subsystem's own words instead of surfacing as a crash or being folded into a
   * generic failure.
   */
  'illegal-transition',
] as const

export type ThresholdRefusalCode = (typeof THRESHOLD_REFUSAL_CODES)[number]

export function isThresholdRefusalCode(value: unknown): value is ThresholdRefusalCode {
  return (
    typeof value === 'string' && (THRESHOLD_REFUSAL_CODES as readonly string[]).includes(value)
  )
}

/**
 * The closed subjects a refusal can name.
 */
export const THRESHOLD_REFUSAL_SUBJECTS = [
  'wake',
  'assessment',
  'evidence',
  'evaluation',
  'decision',
  'rollback',
  'continuation',
] as const

export type ThresholdRefusalSubject = (typeof THRESHOLD_REFUSAL_SUBJECTS)[number]

export function isThresholdRefusalSubject(value: unknown): value is ThresholdRefusalSubject {
  return (
    typeof value === 'string' && (THRESHOLD_REFUSAL_SUBJECTS as readonly string[]).includes(value)
  )
}

/* --------------------------------------------------------- wake */

/**
 * The closed set of authorized wake sources for threshold.
 */
export const THRESHOLD_WAKE_SOURCES = [
  'owner-interaction',
  'authorized-event',
  'scheduled-heartbeat',
  'mission-transition',
  'work-transition',
] as const

export type ThresholdWakeSource = (typeof THRESHOLD_WAKE_SOURCES)[number]

export function isThresholdWakeSource(value: unknown): value is ThresholdWakeSource {
  return typeof value === 'string' && (THRESHOLD_WAKE_SOURCES as readonly string[]).includes(value)
}

/**
 * The closed set of wake kinds for threshold.
 */
export const THRESHOLD_WAKE_KINDS = [
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

export type ThresholdWakeKind = (typeof THRESHOLD_WAKE_KINDS)[number]

export function isThresholdWakeKind(value: unknown): value is ThresholdWakeKind {
  return typeof value === 'string' && (THRESHOLD_WAKE_KINDS as readonly string[]).includes(value)
}

/**
 * Which source each kind may arrive on.
 */
export const THRESHOLD_WAKE_KIND_SOURCE: Readonly<Record<ThresholdWakeKind, ThresholdWakeSource>> =
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
export const THRESHOLD_WAKE_ACTORS = [
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

export type ThresholdWakeActor = (typeof THRESHOLD_WAKE_ACTORS)[number]

export function isThresholdWakeActor(value: unknown): value is ThresholdWakeActor {
  return typeof value === 'string' && (THRESHOLD_WAKE_ACTORS as readonly string[]).includes(value)
}

/**
 * The only actor permitted to raise each source.
 */
export const THRESHOLD_WAKE_SOURCE_ACTOR: Readonly<
  Record<ThresholdWakeSource, ThresholdWakeActor>
> = Object.freeze({
  'owner-interaction': 'owner',
  'authorized-event': 'core-subsystem',
  'scheduled-heartbeat': 'host-heartbeat',
  'mission-transition': 'core-subsystem',
  'work-transition': 'core-subsystem',
})

/**
 * A wake event for threshold.
 */
export interface ThresholdWake {
  readonly wakeId: string
  readonly source: ThresholdWakeSource
  readonly kind: ThresholdWakeKind
  readonly goalRef: string | null
  readonly sourceRef: string | null
  readonly occurredAt: string
  readonly observedAt: string
}

/**
 * The closed reasons a threshold wake was refused.
 */
export const THRESHOLD_WAKE_REFUSAL_CODES = [
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

export type ThresholdWakeRefusalCode = (typeof THRESHOLD_WAKE_REFUSAL_CODES)[number]

export function isThresholdWakeRefusalCode(value: unknown): value is ThresholdWakeRefusalCode {
  return (
    typeof value === 'string' && (THRESHOLD_WAKE_REFUSAL_CODES as readonly string[]).includes(value)
  )
}

export type ThresholdAnyRefusalCode = ThresholdRefusalCode | ThresholdWakeRefusalCode

/* --------------------------------------------------------- assertions */

/**
 * The Phase 39 assertions, by id. Each is checkable and none is decorative.
 */
export const THRESHOLD_ASSERTIONS = [
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
  'noEvidenceFabrication',
  'noMaturitySelfGrant',
  'noMaturityAuthorityWidening',
] as const

export type ThresholdAssertionId = (typeof THRESHOLD_ASSERTIONS)[number]

export type ThresholdAssertionVerdict = Readonly<Record<ThresholdAssertionId, boolean>>

/* --------------------------------------------------------- payload keys */

/**
 * The closed payload vocabulary, per event type.
 */
export const THRESHOLD_PAYLOAD_KEYS: Readonly<Record<ThresholdEventType, readonly string[]>> =
  Object.freeze({
    'threshold.assessment.started': ['assessmentId', 'dimension', 'startedAt'],
    'threshold.assessment.completed': [
      'assessmentId',
      'dimension',
      'level',
      'criteriaCount',
      'evidenceCount',
      'completedAt',
    ],
    'threshold.evidence.collected': [
      'evidenceId',
      'criterionId',
      'source',
      'quality',
      'collectedAt',
    ],
    'threshold.evidence.verified': [
      'evidenceId',
      'criterionId',
      'quality',
      'verifiedAt',
      'expiresAt',
    ],
    'threshold.evidence.fabrication-detected': ['evidenceId', 'criterionId', 'reason', 'detectedAt'],
    'threshold.fail-closed.triggered': ['recordId', 'kind', 'reason', 'triggeredAt'],
    'threshold.fail-closed.resolved': ['recordId', 'kind', 'resolution', 'resolvedAt'],
    'threshold.decision.proven': ['decisionId', 'assessmentCount', 'evidenceCount', 'decidedAt'],
    'threshold.decision.not-proven': [
      'decisionId',
      'failedDimensions',
      'reason',
      'decidedAt',
    ],
    'threshold.suspended': ['reason', 'suspendedAt'],
    'threshold.resumed': ['reason', 'resumedAt'],
    'threshold.rollback.started': ['rollbackId', 'reason', 'startedAt'],
    'threshold.rollback.completed': ['rollbackId', 'reason', 'approvedBy', 'completedAt'],
    'threshold.wake.received': [
      'wakeId',
      'source',
      'kind',
      'wakeKey',
      'goalRef',
      'sourceRef',
      'occurredAt',
      'observedAt',
    ],
    'threshold.wake.denied': ['wakeId', 'source', 'kind', 'code'],
  })

/**
 * Keys that must never appear in a threshold payload.
 */
export const FORBIDDEN_THRESHOLD_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
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
