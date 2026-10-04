/**
 * Phase 37 — Sovereign Intelligence's domain vocabulary.
 *
 * Everything in this file is a closed set. That is not tidiness. A sovereignty
 * subsystem is only trustworthy if the set of states it can be in, the set of
 * providers it can use, the set of outcomes a routing decision can have, the
 * set of reasons it can refuse and the set of numbers that bound it are all
 * finite and all owned by code.
 *
 * The module is deliberately dependency-free. It imports nothing from Core,
 * reads no clock, reaches no provider and mints no authority.
 */

/* ---------------------------------------------------------- sovereignty */

/**
 * The closed set of sovereignty states.
 */
export const SOVEREIGNTY_STATES = [
  'ONLINE',
  'OFFLINE',
  'PORTING',
  'DEGRADED',
  'FAILED',
] as const

export type SovereigntyState = (typeof SOVEREIGNTY_STATES)[number]

export function isSovereigntyState(value: unknown): value is SovereigntyState {
  return typeof value === 'string' && (SOVEREIGNTY_STATES as readonly string[]).includes(value)
}

/* ---------------------------------------------------------- provider */

/**
 * The closed set of provider statuses.
 */
export const PROVIDER_STATUSES = ['healthy', 'degraded', 'failed', 'unknown'] as const

export type ProviderStatus = (typeof PROVIDER_STATUSES)[number]

export function isProviderStatus(value: unknown): value is ProviderStatus {
  return typeof value === 'string' && (PROVIDER_STATUSES as readonly string[]).includes(value)
}

/**
 * A provider descriptor.
 */
export interface ProviderDescriptor {
  readonly providerId: string
  readonly name: string
  readonly status: ProviderStatus
  readonly priority: number
  readonly isLocal: boolean
  readonly isOfflineCapable: boolean
}

/**
 * A provider routing decision.
 */
export interface ProviderRoutingDecision {
  readonly decisionId: string
  readonly providerId: string
  readonly reason: string
  readonly routedAt: string
}

/* ---------------------------------------------------------- offline */

/**
 * The closed set of offline reasoning modes.
 */
export const OFFLINE_MODES = ['none', 'full', 'partial'] as const

export type OfflineMode = (typeof OFFLINE_MODES)[number]

export function isOfflineMode(value: unknown): value is OfflineMode {
  return typeof value === 'string' && (OFFLINE_MODES as readonly string[]).includes(value)
}

/**
 * An offline reasoning session.
 */
export interface OfflineReasoningSession {
  readonly sessionId: string
  readonly mode: OfflineMode
  readonly startedAt: string
  readonly endedAt: string | null
  readonly reasoningCount: number
}

/* ---------------------------------------------------------- portable */

/**
 * The closed set of portable data operations.
 */
export const PORTABLE_DATA_OPERATIONS = ['export', 'import', 'verify'] as const

export type PortableDataOperation = (typeof PORTABLE_DATA_OPERATIONS)[number]

export function isPortableDataOperation(value: unknown): value is PortableDataOperation {
  return (
    typeof value === 'string' && (PORTABLE_DATA_OPERATIONS as readonly string[]).includes(value)
  )
}

/**
 * A portable data record.
 */
export interface PortableDataRecord {
  readonly recordId: string
  readonly operation: PortableDataOperation
  readonly status: 'pending' | 'in-progress' | 'completed' | 'failed'
  readonly dataHash: string
  readonly encryptionVersion: string
  readonly createdAt: string
  readonly completedAt: string | null
}

/* ---------------------------------------------------------- explainability */

/**
 * The explainable sovereignty state.
 */
export interface SovereigntyStateProjection {
  readonly currentState: SovereigntyState
  readonly activeProvider: ProviderDescriptor | null
  readonly offlineMode: OfflineMode
  readonly portableDataStatus: PortableDataRecord | null
  readonly recentDecisions: readonly DecisionSummary[]
  readonly nextBoundedAction: BoundedAction | null
  readonly generatedAt: string
}

/**
 * A decision summary in the sovereignty state.
 */
export interface DecisionSummary {
  readonly decisionId: string
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
  readonly kind: 'reason' | 'route' | 'fallback' | 'export' | 'import' | 'verify' | 'wait' | 'escalate' | 'stop'
  readonly target: string
  readonly deadlineAt: string
  readonly maxAttempts: number
  readonly reasoning: readonly string[]
}

/* ---------------------------------------------------------- limits */

/**
 * The sovereignty limits.
 */
export const SOVEREIGNTY_LIMITS = Object.freeze({
  maxProviders: 8,
  maxOfflineReasoningDurationMs: 24 * 60 * 60 * 1_000,
  maxPortableDataSize: 1024 * 1024 * 1024,
  maxPortableDataOperations: 16,
  maxRetryCeiling: 3,
  maxBackoffMs: 5 * 60_000,
  baseBackoffMs: 1_000,
  jitterMs: 1_000,
})

export type SovereigntyLimits = typeof SOVEREIGNTY_LIMITS

export type SovereigntyLimitsLike = { readonly [K in keyof SovereigntyLimits]: number }

export type SovereigntyLimitRequest = { readonly [K in keyof SovereigntyLimits]?: unknown }

/* ---------------------------------------------------------- events */

/**
 * The sovereignty event types.
 */
export const SOVEREIGNTY_EVENT_TYPES = [
  'sovereignty.provider.routed',
  'sovereignty.provider.fallback',
  'sovereignty.provider.failed',
  'sovereignty.offline.started',
  'sovereignty.offline.ended',
  'sovereignty.portable-data.exported',
  'sovereignty.portable-data.imported',
  'sovereignty.portable-data.verified',
  'sovereignty.portable-data.failed',
  'sovereignty.state-changed',
  'sovereignty.continuation.decided',
  'sovereignty.wake.received',
  'sovereignty.wake.denied',
] as const

export type SovereigntyEventType = (typeof SOVEREIGNTY_EVENT_TYPES)[number]

export const SOVEREIGNTY_EVENT_SET: ReadonlySet<string> = new Set<string>(SOVEREIGNTY_EVENT_TYPES)

export function isSovereigntyEventType(value: unknown): value is SovereigntyEventType {
  return typeof value === 'string' && SOVEREIGNTY_EVENT_SET.has(value)
}

/* ---------------------------------------------------------- refusal */

/**
 * The closed reasons a sovereignty request was refused.
 */
export const SOVEREIGNTY_REFUSAL_CODES = [
  'journal-not-trustworthy',
  'stop-all-active',
  'sovereignty-disabled',
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
  'provider-not-approved',
  'provider-limit-reached',
  'plaintext-storage-prohibited',
  'integrity-fabrication-prohibited',
  'offline-timeout',
  'portable-data-limit-reached',
  'unknown-operation',
] as const

export type SovereigntyRefusalCode = (typeof SOVEREIGNTY_REFUSAL_CODES)[number]

export function isSovereigntyRefusalCode(value: unknown): value is SovereigntyRefusalCode {
  return (
    typeof value === 'string' && (SOVEREIGNTY_REFUSAL_CODES as readonly string[]).includes(value)
  )
}

export const SOVEREIGNTY_REFUSAL_SUBJECTS = [
  'wake',
  'provider',
  'offline',
  'portable-data',
  'continuation',
] as const

export type SovereigntyRefusalSubject = (typeof SOVEREIGNTY_REFUSAL_SUBJECTS)[number]

export function isSovereigntyRefusalSubject(value: unknown): value is SovereigntyRefusalSubject {
  return (
    typeof value === 'string' && (SOVEREIGNTY_REFUSAL_SUBJECTS as readonly string[]).includes(value)
  )
}

/* ---------------------------------------------------------- wake */

export const SOVEREIGNTY_WAKE_SOURCES = [
  'owner-interaction',
  'authorized-event',
  'scheduled-heartbeat',
  'mission-transition',
  'work-transition',
] as const

export type SovereigntyWakeSource = (typeof SOVEREIGNTY_WAKE_SOURCES)[number]

export function isSovereigntyWakeSource(value: unknown): value is SovereigntyWakeSource {
  return (
    typeof value === 'string' && (SOVEREIGNTY_WAKE_SOURCES as readonly string[]).includes(value)
  )
}

export const SOVEREIGNTY_WAKE_KINDS = [
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

export type SovereigntyWakeKind = (typeof SOVEREIGNTY_WAKE_KINDS)[number]

export function isSovereigntyWakeKind(value: unknown): value is SovereigntyWakeKind {
  return typeof value === 'string' && (SOVEREIGNTY_WAKE_KINDS as readonly string[]).includes(value)
}

export const SOVEREIGNTY_WAKE_KIND_SOURCE: Readonly<Record<SovereigntyWakeKind, SovereigntyWakeSource>> =
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

export const SOVEREIGNTY_WAKE_ACTORS = [
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

export type SovereigntyWakeActor = (typeof SOVEREIGNTY_WAKE_ACTORS)[number]

export function isSovereigntyWakeActor(value: unknown): value is SovereigntyWakeActor {
  return (
    typeof value === 'string' && (SOVEREIGNTY_WAKE_ACTORS as readonly string[]).includes(value)
  )
}

export const SOVEREIGNTY_WAKE_SOURCE_ACTOR: Readonly<
  Record<SovereigntyWakeSource, SovereigntyWakeActor>
> = Object.freeze({
  'owner-interaction': 'owner',
  'authorized-event': 'core-subsystem',
  'scheduled-heartbeat': 'host-heartbeat',
  'mission-transition': 'core-subsystem',
  'work-transition': 'core-subsystem',
})

export interface SovereigntyWake {
  readonly wakeId: string
  readonly source: SovereigntyWakeSource
  readonly kind: SovereigntyWakeKind
  readonly goalRef: string | null
  readonly sourceRef: string | null
  readonly occurredAt: string
  readonly observedAt: string
}

export const SOVEREIGNTY_WAKE_REFUSAL_CODES = [
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

export type SovereigntyWakeRefusalCode = (typeof SOVEREIGNTY_WAKE_REFUSAL_CODES)[number]

export function isSovereigntyWakeRefusalCode(value: unknown): value is SovereigntyWakeRefusalCode {
  return (
    typeof value === 'string' &&
    (SOVEREIGNTY_WAKE_REFUSAL_CODES as readonly string[]).includes(value)
  )
}

export type SovereigntyAnyRefusalCode = SovereigntyRefusalCode | SovereigntyWakeRefusalCode

/* ---------------------------------------------------------- assertions */

export const SOVEREIGNTY_ASSERTIONS = [
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
  'noPlaintextStorage',
  'noIntegrityFabrication',
] as const

export type SovereigntyAssertionId = (typeof SOVEREIGNTY_ASSERTIONS)[number]

export type SovereigntyAssertionVerdict = Readonly<Record<SovereigntyAssertionId, boolean>>

/* ---------------------------------------------------------- payload keys */

export const SOVEREIGNTY_PAYLOAD_KEYS: Readonly<Record<SovereigntyEventType, readonly string[]>> =
  Object.freeze({
    'sovereignty.provider.routed': ['decisionId', 'providerId', 'reason', 'routedAt'],
    'sovereignty.provider.fallback': ['decisionId', 'fromProviderId', 'toProviderId', 'reason'],
    'sovereignty.provider.failed': ['providerId', 'reason', 'at'],
    'sovereignty.offline.started': ['sessionId', 'mode', 'startedAt'],
    'sovereignty.offline.ended': ['sessionId', 'endedAt', 'reasoningCount'],
    'sovereignty.portable-data.exported': ['recordId', 'dataHash', 'encryptionVersion', 'createdAt'],
    'sovereignty.portable-data.imported': ['recordId', 'dataHash', 'encryptionVersion', 'createdAt'],
    'sovereignty.portable-data.verified': ['recordId', 'dataHash', 'verifiedAt'],
    'sovereignty.portable-data.failed': ['recordId', 'reason', 'at'],
    'sovereignty.state-changed': ['from', 'to', 'signal', 'reason'],
    'sovereignty.continuation.decided': ['decision', 'reasoning'],
    'sovereignty.wake.received': [
      'wakeId',
      'source',
      'kind',
      'wakeKey',
      'goalRef',
      'sourceRef',
      'occurredAt',
      'observedAt',
    ],
    'sovereignty.wake.denied': ['wakeId', 'source', 'kind', 'code'],
  })

export const FORBIDDEN_SOVEREIGNTY_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
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
