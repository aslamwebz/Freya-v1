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

/**
 * Reported provider usage, accumulated over many calls.
 *
 * The two figures are sums of what providers *said*, and the counter is what
 * makes them honest:
 *
 * - `inputTokens` / `outputTokens` are the totals of the calls that reported
 *   usage. They are a **lower bound** whenever `unknownUsageCalls` is above zero,
 *   because the calls that reported nothing are simply not in the sum.
 * - `unknownUsageCalls` counts the calls that reported no usage, or only part of
 *   it. This is the explicit representation of "we do not know", chosen over
 *   treating an unreported call as zero — which would make an unaccounted call
 *   look like a free one — and over making the whole total null, which would
 *   throw away the calls that *were* accounted for.
 *
 * Nothing here is ever estimated. A caller that needs a true total must check
 * `unknownUsageCalls` first; presenting these two numbers as exact is the bug
 * this shape exists to prevent.
 *
 * This is entirely separate from a grant's *authorisation* budget, which is
 * reserved before a call and never depends on what a provider reports.
 */
export interface ModelUsage {
  calls: number
  inputTokens: number | null
  outputTokens: number | null
  /** Calls whose usage was not fully reported. Makes the totals a lower bound. */
  unknownUsageCalls: number
}

/* ---------------------------------------------------------- projection */

export type CoreLifecycle = 'booting' | 'ready' | 'degraded' | 'stopping' | 'stopped'

/**
 * Everything the renderer may know about Core.
 *
 * This is a projection of durable state, not a live handle. A field that is
 * genuinely unknown is `null`, never a placeholder number.
 */
/**
 * Whether the journal can be believed.
 *
 * `torn` is ordinary: a crash interrupted the last write and the surviving
 * prefix is the whole truth. `corrupt` is not: a complete line failed
 * validation, so the journal cannot be replayed into security state — the
 * discarded segment could have contained a STOP ALL. A Core in this state denies
 * cognition regardless of what the replayed prefix says.
 */
export type JournalIntegrity = 'ok' | 'torn' | 'corrupt'

export interface JournalFault {
  integrity: JournalIntegrity
  /** Why, in words a person can act on. Never null. */
  reason: string
  /** Which line the problem was found on, 1-indexed. */
  line: number | null
  /** Complete events that were read and believed. */
  eventsRead: number
  /** Bytes discarded during recovery, including a torn tail. */
  bytesDiscarded: number
}

export interface CoreStatus {
  lifecycle: CoreLifecycle
  /** Last durable event sequence, or 0 when the log is empty. */
  eventSequence: number
  coreStartedAt: string | null
  /**
   * Always present. A healthy journal says so explicitly, because the absence of
   * a warning is not the same thing as a warning that is absent.
   */
  integrity: JournalFault
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
