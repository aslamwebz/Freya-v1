/**
 * Phase 37 — Compile-Time Types and Interfaces
 *
 * **Status:** PREPARATION ONLY — NOT PRODUCTION
 *
 * These types and interfaces are compile-time only. They cannot activate
 * runtime behavior. They define the shape of Phase 37's components.
 *
 * These types are safe to cherry-pick later. They do not import any runtime
 * module. They do not create any side effects. They are pure type definitions.
 */

/* --------------------------------------------------------- sovereignty */

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

/* --------------------------------------------------------- provider */

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

/* --------------------------------------------------------- offline */

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

/* --------------------------------------------------------- portable */

/**
 * The closed set of portable data operations.
 */
export const PORTABLE_DATA_OPERATIONS = ['export', 'import', 'verify'] as const
export type PortableDataOperation = (typeof PORTABLE_DATA_OPERATIONS)[number]

export function isPortableDataOperation(value: unknown): value is PortableDataOperation {
  return typeof value === 'string' && (PORTABLE_DATA_OPERATIONS as readonly string[]).includes(value)
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

/* --------------------------------------------------------- explainability */

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

/* --------------------------------------------------------- limits */

/**
 * The sovereignty limits.
 *
 * These are code-owned ceilings. They cannot be widened.
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

/* --------------------------------------------------------- events */

/**
 * The sovereignty event types.
 *
 * These are the event types the sovereignty subsystem appends.
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
