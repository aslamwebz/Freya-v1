/**
 * Phase 38 — Cognitive Evolution's domain vocabulary.
 *
 * Everything in this file is a closed set. That is not tidiness. An evolution
 * subsystem is only trustworthy if the set of states it can be in, the set of
 * evidence qualities it can hold, the set of improvements it can propose, the
 * set of drift outcomes it can report, the set of reasons it can refuse and the
 * set of numbers that bound it are all finite and all owned by code.
 *
 * The module is deliberately dependency-free. It imports nothing from Core,
 * reads no clock, reaches no provider and mints no authority.
 */

/* ---------------------------------------------------------- evolution */

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

/* ---------------------------------------------------------- evidence */

/**
 * The closed set of evidence quality levels.
 */
export const EVIDENCE_QUALITY = ['insufficient', 'weak', 'moderate', 'strong', 'verified'] as const
export type EvidenceQuality = (typeof EVIDENCE_QUALITY)[number]

export function isEvidenceQuality(value: unknown): value is EvidenceQuality {
  return typeof value === 'string' && (EVIDENCE_QUALITY as readonly string[]).includes(value)
}

/**
 * The closed set of evidence sources.
 *
 * A source is a description of *where* an observation came from, never a claim
 * about authority. `owner-assertion` is the strongest and is still capped at
 * `medium` confidence downstream, because a claim generalises beyond the
 * observation behind it.
 */
export const EVIDENCE_SOURCES = [
  'work-run',
  'mission-check',
  'learning-outcome',
  'owner-assertion',
  'system-health',
  'verification-record',
] as const
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number]

export function isEvidenceSource(value: unknown): value is EvidenceSource {
  return typeof value === 'string' && (EVIDENCE_SOURCES as readonly string[]).includes(value)
}

/**
 * An evidence record.
 */
export interface EvidenceRecord {
  readonly evidenceId: string
  readonly source: EvidenceSource
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
 * The closed set of improvement states.
 *
 * ```
 *   proposed → evaluating → approved → staged → applied
 *       │          │          │          │
 *       └──────────┴──────────┴──────────┴──→ failed
 * ```
 *
 * Every terminal status is terminal. A failed improvement is a **new**
 * improvement, not a retry of this one, so a failure cannot be quietly edited
 * into a pass.
 */
export const IMPROVEMENT_STATES = [
  'proposed',
  'evaluating',
  'approved',
  'staged',
  'applied',
  'failed',
] as const
export type ImprovementState = (typeof IMPROVEMENT_STATES)[number]

export function isImprovementState(value: unknown): value is ImprovementState {
  return typeof value === 'string' && (IMPROVEMENT_STATES as readonly string[]).includes(value)
}

/**
 * The transition table, and the only authority over it.
 */
export const IMPROVEMENT_TRANSITIONS: Readonly<Record<ImprovementState, readonly ImprovementState[]>> =
  Object.freeze({
    proposed: Object.freeze(['evaluating', 'failed'] as const),
    evaluating: Object.freeze(['approved', 'failed'] as const),
    approved: Object.freeze(['staged', 'failed'] as const),
    staged: Object.freeze(['applied', 'failed'] as const),
    applied: Object.freeze(['failed'] as const),
    failed: Object.freeze([] as const),
  })

export function canTransitionImprovement(from: ImprovementState, to: ImprovementState): boolean {
  return IMPROVEMENT_TRANSITIONS[from].includes(to)
}

/**
 * An improvement record.
 */
export interface ImprovementRecord {
  readonly improvementId: string
  readonly kind: ImprovementKind
  readonly state: ImprovementState
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

/* --------------------------------------------------- authority envelope */

/**
 * The authority and capability envelope the evolution subsystem currently holds.
 *
 * This is the boundary the drift detector compares against. It is code-owned
 * data, never a claim from an improvement. An improvement may never propose an
 * envelope wider than this one.
 */
export interface AuthorityEnvelope {
  readonly capabilities: readonly string[]
  readonly grants: readonly string[]
  readonly budgetCeiling: number
  readonly approvalRequired: boolean
  readonly stopAllLatched: boolean
}

/**
 * A proposed authority envelope, carried by an improvement.
 *
 * The drift detector compares this against the current envelope. Any widening
 * — a new capability, a new grant, a higher budget, a weakened approval
 * requirement, a cleared stop — is drift.
 */
export interface ProposedAuthorityEnvelope {
  readonly capabilities: readonly string[]
  readonly grants: readonly string[]
  readonly budgetCeiling: number
  readonly approvalRequired: boolean
  readonly stopAllLatched: boolean
}

/* ------------------------------------------------------ explainability */

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

/* ---------------------------------------------------------- limits */

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
  maxProjectionRecords: 64,
  maxIdChars: 128,
  maxStatementChars: 1_000,
  maxDescriptionChars: 600,
  maxReasonChars: 500,
  maxRefChars: 128,
  maxRecordBodyBytes: 16_384,
})

export type EvolutionLimits = typeof EVOLUTION_LIMITS

export type EvolutionLimitRequest = { readonly [K in keyof EvolutionLimits]?: unknown }

/* ---------------------------------------------------------- events */

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
  'evolution.state-changed',
] as const

export type EvolutionEventType = (typeof EVOLUTION_EVENT_TYPES)[number]

export const EVOLUTION_EVENT_SET: ReadonlySet<string> = new Set<string>(EVOLUTION_EVENT_TYPES)

export function isEvolutionEventType(value: unknown): value is EvolutionEventType {
  return typeof value === 'string' && EVOLUTION_EVENT_SET.has(value)
}

/* ---------------------------------------------------------- refusal */

/**
 * The closed reasons an evolution request was refused.
 */
export const EVOLUTION_REFUSAL_CODES = [
  'journal-not-trustworthy',
  'stop-all-active',
  'evolution-disabled',
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
  'unauthorized-improvement-prohibited',
  'drift-detected',
  'boundary-violation',
  'unknown-operation',
  'invalid-evidence',
  'insufficient-evidence',
  'evidence-expired',
  'improvement-bound-reached',
  'no-such-improvement',
  'illegal-transition',
  'not-owner',
  'store-unavailable',
  'store-degraded',
  'invalid-record',
] as const

export type EvolutionRefusalCode = (typeof EVOLUTION_REFUSAL_CODES)[number]

export function isEvolutionRefusalCode(value: unknown): value is EvolutionRefusalCode {
  return (
    typeof value === 'string' && (EVOLUTION_REFUSAL_CODES as readonly string[]).includes(value)
  )
}

export const EVOLUTION_REFUSAL_SUBJECTS = [
  'wake',
  'evidence',
  'improvement',
  'drift-check',
  'continuation',
] as const

export type EvolutionRefusalSubject = (typeof EVOLUTION_REFUSAL_SUBJECTS)[number]

export function isEvolutionRefusalSubject(value: unknown): value is EvolutionRefusalSubject {
  return (
    typeof value === 'string' && (EVOLUTION_REFUSAL_SUBJECTS as readonly string[]).includes(value)
  )
}

/* ---------------------------------------------------------- wake */

export const EVOLUTION_WAKE_SOURCES = [
  'owner-interaction',
  'authorized-event',
  'scheduled-heartbeat',
  'mission-transition',
  'work-transition',
] as const

export type EvolutionWakeSource = (typeof EVOLUTION_WAKE_SOURCES)[number]

export function isEvolutionWakeSource(value: unknown): value is EvolutionWakeSource {
  return typeof value === 'string' && (EVOLUTION_WAKE_SOURCES as readonly string[]).includes(value)
}

export const EVOLUTION_WAKE_KINDS = [
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
  'provider-failed',
  'offline-requested',
] as const

export type EvolutionWakeKind = (typeof EVOLUTION_WAKE_KINDS)[number]

export function isEvolutionWakeKind(value: unknown): value is EvolutionWakeKind {
  return typeof value === 'string' && (EVOLUTION_WAKE_KINDS as readonly string[]).includes(value)
}

export const EVOLUTION_WAKE_KIND_SOURCE: Readonly<Record<EvolutionWakeKind, EvolutionWakeSource>> =
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
    'provider-failed': 'authorized-event',
    'offline-requested': 'authorized-event',
  })

export const EVOLUTION_WAKE_ACTORS = [
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

export type EvolutionWakeActor = (typeof EVOLUTION_WAKE_ACTORS)[number]

export function isEvolutionWakeActor(value: unknown): value is EvolutionWakeActor {
  return typeof value === 'string' && (EVOLUTION_WAKE_ACTORS as readonly string[]).includes(value)
}

export const EVOLUTION_WAKE_SOURCE_ACTOR: Readonly<
  Record<EvolutionWakeSource, EvolutionWakeActor>
> = Object.freeze({
  'owner-interaction': 'owner',
  'authorized-event': 'core-subsystem',
  'scheduled-heartbeat': 'host-heartbeat',
  'mission-transition': 'core-subsystem',
  'work-transition': 'core-subsystem',
})

export interface EvolutionWake {
  readonly wakeId: string
  readonly source: EvolutionWakeSource
  readonly kind: EvolutionWakeKind
  readonly goalRef: string | null
  readonly sourceRef: string | null
  readonly occurredAt: string
  readonly observedAt: string
}

export const EVOLUTION_WAKE_REFUSAL_CODES = [
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

export type EvolutionWakeRefusalCode = (typeof EVOLUTION_WAKE_REFUSAL_CODES)[number]

export function isEvolutionWakeRefusalCode(value: unknown): value is EvolutionWakeRefusalCode {
  return (
    typeof value === 'string' &&
    (EVOLUTION_WAKE_REFUSAL_CODES as readonly string[]).includes(value)
  )
}

export type EvolutionAnyRefusalCode = EvolutionRefusalCode | EvolutionWakeRefusalCode

/* ---------------------------------------------------------- assertions */

export const EVOLUTION_ASSERTIONS = [
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
  'noEvidenceFabrication',
  'noUnauthorizedImprovement',
  'noAuthorityDrift',
] as const

export type EvolutionAssertionId = (typeof EVOLUTION_ASSERTIONS)[number]

export type EvolutionAssertionVerdict = Readonly<Record<EvolutionAssertionId, boolean>>

/* ---------------------------------------------------------- payload keys */

export const EVOLUTION_PAYLOAD_KEYS: Readonly<Record<EvolutionEventType, readonly string[]>> =
  Object.freeze({
    'evolution.evidence.verified': [
      'evidenceId',
      'source',
      'quality',
      'statement',
      'verifiedAt',
      'expiresAt',
    ],
    'evolution.improvement.proposed': [
      'improvementId',
      'kind',
      'state',
      'evidenceIds',
      'description',
      'createdAt',
    ],
    'evolution.improvement.evaluating': ['improvementId', 'evaluatedAt'],
    'evolution.improvement.approved': ['improvementId', 'approvedAt'],
    'evolution.improvement.staged': ['improvementId', 'stagedAt'],
    'evolution.improvement.applied': ['improvementId', 'appliedAt'],
    'evolution.improvement.failed': ['improvementId', 'reason', 'failedAt'],
    'evolution.drift-check.passed': ['checkId', 'improvementId', 'outcome', 'checkedAt'],
    'evolution.drift-check.failed': ['checkId', 'improvementId', 'outcome', 'reason', 'checkedAt'],
    'evolution.drift-check.boundary-violation': [
      'checkId',
      'improvementId',
      'outcome',
      'reason',
      'checkedAt',
    ],
    'evolution.self-modification.attempted': ['target', 'reason', 'attemptedAt'],
    'evolution.self-modification.refused': ['target', 'reason', 'refusedAt'],
    'evolution.continuation.decided': ['decision', 'reasoning'],
    'evolution.wake.received': [
      'wakeId',
      'source',
      'kind',
      'wakeKey',
      'goalRef',
      'sourceRef',
      'occurredAt',
      'observedAt',
    ],
    'evolution.wake.denied': ['wakeId', 'source', 'kind', 'code'],
    'evolution.state-changed': ['from', 'to', 'signal', 'reason'],
  })

export const FORBIDDEN_EVOLUTION_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
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

/* ---------------------------------------------------------- utilities */

export function instantMs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/** A bounded opaque reference id. */
export function isEvolutionRef(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= EVOLUTION_LIMITS.maxRefChars &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  )
}

/** A bounded non-empty string. */
export function isBoundedEvolutionText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}
