/**
 * Phase 23 — Compile-Time Types and Interfaces
 *
 * **Status:** INTEGRATED — these are the types Core actually builds against, and
 * the runtime that fills them lives in `core/lifeloop/runtime.ts`.
 *
 * These types and interfaces are compile-time only. They cannot activate
 * runtime behavior. They define the shape of Phase 23's components.
 *
 * These types are safe to cherry-pick later. They do not import any runtime
 * module. They do not create any side effects. They are pure type definitions.
 *
 * ---
 *
 * ## Reconciled with the implementation
 *
 * The definitions below match `core/lifeloop/types.ts`, and that module is the
 * single source of truth. Where the preparation documents and the implementation
 * disagreed, the decision is recorded in
 * `docs/phase23/implementation-decisions.md` rather than silently resolved
 * here — a reviewer needs to see which document lost and why.
 *
 * The wiring added nine closed-vocabulary extensions to `types.ts` — two event
 * types, a payload key, a fold context and four code lists — because the journal
 * could not otherwise express a restart, an owner pre-emption, an owner clearing a
 * stop, a refused wake or an absolute short deadline. Each is listed in
 * `docs/phase23/runtime-integration.md` §3 with the reason it was necessary. This
 * file mirrors the pre-integration shape; where the two differ, the implementation
 * is the truth.
 */

import {
  DECIDE_OUTCOMES,
  LIFE_LOOP_EVENT_TYPES,
  LIFE_LOOP_LIMITS,
  type DecideOutcome,
  type FocusState,
} from '../../core/lifeloop/types'

/**
 * The closed set of wake sources.
 *
 * A wake source is an authorized event that triggers the Continuous Life Loop.
 * This is a closed set. No other source may wake the loop.
 */
export type WakeSource =
  | 'owner-interaction'
  | 'authorized-event'
  | 'scheduled-heartbeat'
  | 'mission-transition'
  | 'work-transition'

/**
 * The closed set of wake kinds.
 *
 * Fourteen, each paired with the sources allowed to raise it. Closed because
 * "is this kind worth a model call?" is answered by a set lookup, and a set with
 * a hole in it is answered wrongly.
 */
export type WakeKind =
  | 'owner-message'
  | 'owner-command'
  | 'owner-approval'
  | 'mission-activated'
  | 'mission-completed'
  | 'mission-failed'
  | 'run-started'
  | 'run-completed'
  | 'run-failed'
  | 'step-verified'
  | 'research-completed'
  | 'schedule-due'
  | 'periodic-check'
  | 'system-health'

/**
 * A wake event.
 *
 * A wake is not a model call. A wake is a deterministic evaluation of whether
 * an authorized event or schedule justifies further processing.
 *
 * `kind` is the closed `WakeKind` union rather than a bare `string`. The
 * preparation text left it open; an open `kind` would let the loop wake for
 * something nobody enumerated, which is the one shape this whole phase exists to
 * prevent.
 */
export interface WakeEvent {
  readonly wakeId: string
  readonly source: WakeSource
  readonly kind: WakeKind
  readonly goalRef: string | null
  readonly sourceRef: string | null
  readonly occurredAt: string
  readonly observedAt: string
}

/**
 * The wake validation outcome.
 *
 * Three shapes, not two, because a heartbeat for something that is not due yet is
 * neither a refusal nor an acceptance: it is real, authorized and correctly
 * shaped, and it waits. Collapsing `deferred` into `denied` would put "not yet"
 * in the journal as "no".
 */
export type WakeValidationOutcome =
  | { readonly outcome: 'accepted'; readonly wake: WakeEvent; readonly wakeKey: string }
  | {
      readonly outcome: 'deferred'
      readonly wake: WakeEvent
      readonly wakeKey: string
      readonly code: 'heartbeat-not-due' | 'heartbeat-condition-unmet'
      readonly reason: string
      readonly deadline: string
    }
  | { readonly outcome: 'denied'; readonly code: WakeRefusalCode; readonly reason: string }

/**
 * What the loop concluded, and how loudly it may say so.
 *
 * The decide step's whole vocabulary. `do-nothing` is the most common outcome by
 * design; `remember` is the only silent outcome that is not empty.
 */
export type { DecideOutcome }

/** The five decide outcomes, closed. */
export { DECIDE_OUTCOMES }

/** How much of the owner's attention an outcome takes. Lower is quieter. */
export type OwnerEscalation = 'none' | 'subtle-cue' | 'speak' | 'interrupt'

/** What the owner experiences, once focus and STOP ALL have had their say. */
export interface EscalationResolution {
  readonly outcome: DecideOutcome
  readonly escalation: OwnerEscalation
  readonly suppressed: boolean
  readonly code: 'not-escalating' | 'focus-suppressed-interrupt' | 'escalation-permitted' | 'owner-stopped'
  readonly reason: string
}

/** What the owner is focused on, as Attention already knows it. Read-only. */
export type { FocusState }

/**
 * The pre-cognition filter outcome.
 *
 * The filter evaluates whether cognition is justified before any model call.
 * It is deterministic: same state + same clock = same result.
 */
export type PreCognitionOutcome =
  | { readonly outcome: 'deny'; readonly code: PreCognitionDenialCode; readonly reason: string }
  | {
      readonly outcome: 'wait'
      readonly code: 'cooldown-active'
      readonly reason: string
      readonly deadline: string
    }
  | { readonly outcome: 'allow'; readonly code: 'cognition-justified'; readonly reason: string }

/**
 * The closed reasons the filter may refuse, in the order the checks run.
 *
 * The order is the contract: an untrustworthy journal outranks everything, STOP
 * ALL outranks everything below it, and only then is the question "is a model
 * call worth it here?" asked at all.
 */
export type PreCognitionDenialCode =
  | 'journal-not-trustworthy'
  | 'stop-all-active'
  | 'loop-disabled'
  | 'no-active-wake'
  | 'budget-exhausted'
  | 'grant-unavailable'
  | 'focus-blocks-escalation'
  | 'cognition-not-justified'
  | 'limit-iterations'
  | 'limit-actions'
  | 'limit-verifications'
  | 'limit-attempts'
  | 'limit-schedules'
  | 'limit-duration'

/**
 * The continuation state machine's states.
 *
 * Nine, closed. Two of them are terminal in the sense that nothing but an
 * explicit reset moves out of them; `DENY` and `STOP`.
 */
export type ContinuationState =
  | 'IDLE'
  | 'WAKING'
  | 'DENY'
  | 'WAIT'
  | 'ALLOW'
  | 'ACTING'
  | 'VERIFYING'
  | 'CONTINUE'
  | 'STOP'

/**
 * The continuation state machine's transitions.
 *
 * Sixteen in the preparation text. The implementation carries three more, all of
 * them the expiry of a deadline from a state that was holding one, and all of
 * them recorded in `implementation-decisions.md`. The interruption table
 * overrides this one entirely and is not enumerated here.
 */
export type ContinuationTransition =
  | { readonly from: 'IDLE'; readonly to: 'WAKING'; readonly reason: 'wake-received' }
  | { readonly from: 'WAKING'; readonly to: 'DENY'; readonly reason: 'filter-denied' }
  | { readonly from: 'WAKING'; readonly to: 'WAIT'; readonly reason: 'condition-not-met' }
  | { readonly from: 'WAKING'; readonly to: 'ALLOW'; readonly reason: 'filter-allowed' }
  | { readonly from: 'WAKING'; readonly to: 'DENY'; readonly reason: 'deadline-expired' }
  | { readonly from: 'WAIT'; readonly to: 'WAKING'; readonly reason: 'next-wake' }
  | { readonly from: 'WAIT'; readonly to: 'DENY'; readonly reason: 'deadline-expired' }
  | { readonly from: 'ALLOW'; readonly to: 'ACTING'; readonly reason: 'cognition-allowed' }
  | { readonly from: 'ALLOW'; readonly to: 'DENY'; readonly reason: 'cognition-denied' }
  | { readonly from: 'ACTING'; readonly to: 'VERIFYING'; readonly reason: 'action-completed' }
  | { readonly from: 'ACTING'; readonly to: 'DENY'; readonly reason: 'action-failed' }
  | { readonly from: 'ACTING'; readonly to: 'DENY'; readonly reason: 'deadline-expired' }
  | { readonly from: 'VERIFYING'; readonly to: 'CONTINUE'; readonly reason: 'verification-passed' }
  | { readonly from: 'VERIFYING'; readonly to: 'DENY'; readonly reason: 'verification-failed' }
  | { readonly from: 'VERIFYING'; readonly to: 'DENY'; readonly reason: 'deadline-expired' }
  | { readonly from: 'CONTINUE'; readonly to: 'WAKING'; readonly reason: 'next-iteration' }
  | { readonly from: 'CONTINUE'; readonly to: 'STOP'; readonly reason: 'loop-complete' }
  | { readonly from: 'DENY'; readonly to: 'IDLE'; readonly reason: 'reset' }
  | { readonly from: 'STOP'; readonly to: 'IDLE'; readonly reason: 'reset' }

/**
 * The deadline types.
 *
 * `approval` is here because an unanswered request for a person expires on a
 * clock like anything else. It is not "wait": on restart the two have to be
 * told apart.
 */
export type DeadlineType = 'verification' | 'approval' | 'wait' | 'action'

/**
 * A deadline. Absolute, never relative to the process that created it.
 */
export interface Deadline {
  readonly type: DeadlineType
  readonly expiresAt: string
  readonly reason: string
}

/**
 * The retry ceiling.
 *
 * `currentAttempt` is read off the journal, so the ceiling survives a restart.
 * `baseBackoffMs`/`jitterMs` are named separately because backoff is
 * `base * 2^(attempt-1) + jitter`, all of it clamped to `maxBackoffMs`.
 */
export interface RetryCeiling {
  readonly maxAttempts: number
  readonly currentAttempt: number
  readonly baseBackoffMs: number
  readonly maxBackoffMs: number
  readonly jitterMs: number
}

/**
 * The interruption source.
 *
 * Six. `approval-required` is the one the preparation text described in prose but
 * did not name, and its absence was why the `approval` deadline type had no
 * producer at all.
 */
export type InterruptionSource =
  | 'stop-all'
  | 'owner-command'
  | 'guard-denial'
  | 'budget-exhaustion'
  | 'approval-required'
  | 'deadline-expiry'

/**
 * The interruption outcome.
 *
 * `applied: false` is a real and common answer — an idle loop has nothing for a
 * Guard denial to preempt — and is reported as such rather than as a failure.
 * `awaitingApproval` is the flag that tells the caller to mint an `approval`
 * deadline rather than a `wait` one.
 */
export type InterruptionOutcome =
  | {
      readonly applied: true
      readonly from: ContinuationState
      readonly to: ContinuationState
      readonly source: InterruptionSource
      readonly preempted: boolean
      readonly awaitingApproval: boolean
      readonly reason: string
    }
  | {
      readonly applied: false
      readonly from: ContinuationState
      readonly source: InterruptionSource
      readonly code: InterruptionNotApplicable
      readonly reason: string
    }

export type InterruptionNotApplicable =
  | 'nothing-to-preempt'
  | 'terminal'
  | 'unknown-state'
  | 'stop-all-latched'

/**
 * The life loop's event types.
 *
 * These are the event types the life loop appends. They are metadata only.
 *
 * `lifeloop.reset` is the close-out. Without it a denied loop stays denied in
 * the journal for ever and the loop is single-shot: one wake, one refusal,
 * silence.
 */
export { LIFE_LOOP_EVENT_TYPES }

export type LifeLoopEventType = (typeof LIFE_LOOP_EVENT_TYPES)[number]

/**
 * The life loop's limits.
 *
 * These are the code-owned ceilings on the life loop. They cannot be widened.
 *
 * Four were added at implementation: the per-wake cognition ceiling (the real
 * ceiling on spend), the per-unit attempt ceiling, the number of open schedules
 * a heartbeat will hold, and the longest string any payload may carry. Each is
 * a number that was already fixed somewhere in the prose and had nowhere to live.
 */
export { LIFE_LOOP_LIMITS }

/**
 * A request to narrow the limits.
 *
 * Untyped as to value on purpose. A request is untrusted input: it may be wider
 * than the ceiling it names, non-numeric, negative, or absent. Typing the values
 * as the frozen literals would let the type system reject the hostile requests
 * before the clamp ever saw them — which is the case most worth testing.
 */
export type LifeLoopLimitRequest = { readonly [K in keyof LifeLoopLimits]?: unknown }

export type LifeLoopLimits = typeof LIFE_LOOP_LIMITS

/**
 * The zero-idle-inference assertions.
 *
 * These are invariants that must hold at all times. They are the proof that
 * idle Freya makes no paid model call and performs no hidden background reasoning.
 */
export interface ZeroIdleInferenceAssertions {
  /** No model call without a wake. */
  readonly noModelCallWithoutWake: boolean
  /** No continuous polling. */
  readonly noContinuousPolling: boolean
  /** No hidden reasoning. */
  readonly noHiddenReasoning: boolean
  /** No unrestricted loops. */
  readonly noUnrestrictedLoops: boolean
  /** No authority escalation. */
  readonly noAuthorityEscalation: boolean
  /** No idle model call. */
  readonly noIdleModelCall: boolean
  /** No background reasoning. */
  readonly noBackgroundReasoning: boolean
  /** No hidden durable state. */
  readonly noHiddenDurableState: boolean
}

/**
 * The life loop's configuration.
 *
 * This is the configuration for the life loop. It is code-owned and cannot be
 * widened at runtime.
 */
export interface LifeLoopConfig {
  /** Whether the life loop is enabled. */
  readonly enabled: boolean
  /** The loop limits. */
  readonly limits: LifeLoopLimits
  /** The zero-idle-inference assertions. */
  readonly assertions: ZeroIdleInferenceAssertions
}

/**
 * The life loop's status.
 *
 * This is the current status of the life loop. It is derived from the event
 * journal.
 *
 * `attemptCount` and `retriesExhausted` are here so a caller never has to
 * re-derive the retry ceiling from the raw count.
 */
export interface LifeLoopStatus {
  /** The current state of the loop. */
  readonly state: ContinuationState
  /** The number of loop iterations in the current wake. */
  readonly iterationCount: number
  /** The number of actions in the current iteration. */
  readonly actionCount: number
  /** The number of verifications in the current iteration. */
  readonly verificationCount: number
  /** Cognition requests in the current wake. */
  readonly cognitionRequestCount: number
  /** Failed attempts at the unit of work in hand. */
  readonly attemptCount: number
  /** Whether that unit of work has used its whole retry budget. */
  readonly retriesExhausted: boolean
  /** The current wake event. */
  readonly currentWake: WakeEvent | null
  /** The current deadline. */
  readonly currentDeadline: Deadline | null
  /** Whether the loop is idle. */
  readonly isIdle: boolean
  /** Whether the loop is stopped. */
  readonly isStopped: boolean
}