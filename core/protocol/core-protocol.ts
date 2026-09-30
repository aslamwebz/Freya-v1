/**
 * The Core protocol: the vocabulary shared by Core and the renderer.
 *
 * Types only, and no runtime values, so the renderer can depend on the shape
 * of Core without depending on Core's implementation. Everything the renderer
 * is allowed to see is declared here.
 *
 * A renderer that can name a projection field cannot thereby acquire the
 * capability to change one.
 */

/* ------------------------------------------------------------ identity */

/** A principal asking Core for something. Never carries credentials. */
export type PrincipalId =
  | 'owner'
  | 'system'
  | `agent:${string}`
  | `module:${string}`

/* --------------------------------------------------------- capabilities */

/**
 * The Phase 1 capability vocabulary. Deny by default: a principal holds only
 * what has been explicitly granted, and the vocabulary is closed.
 */
export const CAPABILITIES = [
  'core.status.read',
  'core.command.submit',
  'cognition.status.read',
  'cognition.request',
  'cognition.grant.manage',
  'security.status.read',
  'security.stop',
  'security.resume',
] as const

export type Capability = (typeof CAPABILITIES)[number]

/**
 * Everything the owner holds, in one place.
 *
 * The owner principal is built from this rather than from a list written out at
 * the call site, so a capability added to the vocabulary cannot be quietly left
 * off the one principal that is supposed to have it.
 */
export const ALL_CAPABILITIES: readonly Capability[] = CAPABILITIES

/**
 * The capabilities a worker may ever hold.
 *
 * Deliberately excludes `cognition.grant.manage` and every `security.*`
 * capability: a worker can ask to think, and that is the end of it.
 */
export const WORKER_CAPABILITIES: readonly Capability[] = ['cognition.request']

/* --------------------------------------------------------------- Guard */

export type GuardOutcome = 'allow' | 'deny' | 'approval_required'

export interface GuardDecision {
  outcome: GuardOutcome
  /** The rule that decided it, for the audit trail. */
  reason: string
  capability: Capability
  principal: PrincipalId
}

/* ------------------------------------------------------------ cognition */

export type CognitionOrigin = 'user' | 'goal' | 'workflow' | 'agent' | 'learning' | 'system'

export type CognitionCause =
  | 'user_message'
  | 'user_requested_test'
  | 'explicit_review'
  | 'goal_started'
  | 'run_finished'
  | 'world_changed'
  | 'scheduled_grant'
  | 'learning_consolidation'

export type GovernorOutcome = 'allow' | 'ask' | 'deny'

export interface GovernorDecision {
  outcome: GovernorOutcome
  reason: string
  grantId: string | null
}

/* --------------------------------------------------------------- model */

export type ProviderStatusKind = 'disabled' | 'unconfigured' | 'configured' | 'faulted'

export interface ProviderStatus {
  id: string
  kind: 'fake' | 'nanogpt'
  status: ProviderStatusKind
  /** Never a secret: a shape, not a value. */
  model: string | null
  /** Why it is in this state, in words a person can act on. */
  detail: string
  /** True only when a live external call is possible and permitted. */
  liveEnabled: boolean
}

export interface ModelUsage {
  calls: number
  inputTokens: number | null
  outputTokens: number | null
}

/* ---------------------------------------------------------- projection */

export type CoreLifecycle = 'booting' | 'ready' | 'degraded' | 'stopping' | 'stopped'

/**
 * Everything the renderer may know about Core.
 *
 * This is a projection of durable state, not a live handle. A field that is
 * genuinely unknown is `null`, never a placeholder number.
 */
export interface CoreStatus {
  lifecycle: CoreLifecycle
  /** Last durable event sequence, or 0 when the log is empty. */
  eventSequence: number
  coreStartedAt: string | null
  /** The latch is derived from durable events, so it survives a restart. */
  stopAll: {
    active: boolean
    activatedAt: string | null
    activatedBy: PrincipalId | null
  }
  guard: {
    /** Deny by default; shown so the posture is visible rather than implied. */
    defaultOutcome: GuardOutcome
    /** Capable of approval, but no approval workflow exists in Phase 1. */
    approvalWorkflow: 'unavailable'
  }
  governor: {
    /**
     * `unknown` is not the same as `deny_all`. A Core that has not finished
     * booting has no answer, and reporting "denying everything" there would
     * claim a stop latch that may well not be set.
     */
    status: 'ready' | 'deny_all' | 'unknown'
    grantsActive: number
  }
  providers: ProviderStatus[]
  /** Usage for this Core session. Durable totals are separate. */
  sessionUsage: ModelUsage
  durableUsage: ModelUsage
  /** Non-empty when something is wrong; Core says what, rather than hiding it. */
  faults: string[]
}

/* ----------------------------------------------------------------- RPC */

export type CoreCommandName =
  | 'core.status.read'
  | 'core.command.submit'
  | 'security.status.read'
  | 'security.stopAll'
  | 'security.resume'
  | 'cognition.status.read'
  /**
   * Grant governance. The handler ignores any principal in the payload and
   * records the owner, because identity is assigned by Core and never
   * accepted from a caller.
   */
  | 'cognition.grant.create'
  | 'cognition.grant.revoke'

export interface CoreCommandEnvelope {
  command: CoreCommandName
  /** Correlates the acknowledgement with the request that caused it. */
  requestId: string
  payload?: unknown
}

export interface CoreCommandResult {
  requestId: string
  ok: boolean
  /** Present when the command was understood; absent on rejection. */
  status?: CoreStatus
  /** Present on a deliberate refusal: Guard, Governor, validation. */
  refusal?: { reason: string }
  /** Present on an unexpected failure. Never carries a stack to the renderer. */
  error?: { message: string }
  /**
   * The durable sequence number of the event this command produced. Present only
   * when the command actually appended something, so a renderer can verify the
   * effect is on disk instead of taking a boolean on trust.
   */
  durableSequence?: number
}
