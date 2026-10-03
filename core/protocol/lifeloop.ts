import type {
  ContinuationState,
  DeadlineType,
  DecideOutcome,
  LifeLoopLimits,
  OwnerEscalation,
  WakeKind,
  WakeRefusalCode,
  WakeSource,
} from '../lifeloop/types'

/**
 * This file is a **view**, not a channel.
 *
 * It describes what a window may know about the Continuous Life Loop, and — as
 * much — what it may not. There is no `lifeloop.*` command anywhere in the Core
 * vocabulary, and there is no renderer-writable bridge entry, because a pull and a
 * push are enough for a read and the *absence of a write verb* is the property
 * rather than an omission. A surface can see that Freya is waiting; it cannot make
 * her wake, make her think, spend on her, lift a stop, or shorten a deadline.
 *
 * ## Crosses
 *
 * Closed codes, ids, instants, counters and the loop's own fixed self-statements.
 *
 * ## Does not cross
 *
 * The prompt a thought was given, the answer a provider returned, the text of the
 * event that woke the loop, the reason a refusal gave in anything but its closed
 * code, and the identity of any provider. Each of those stays in the process or in
 * the gateway's own records, and each is replaced here by a closed code or a
 * counter. The journal holds metadata for the same reason and under the same
 * 200-character ceiling — it is the least protected file in the system, and a
 * life-loop record that could carry a paragraph would quietly turn it into a
 * transcript of what Freya was thinking.
 */

/* --------------------------------------------------------------- views */

export interface LifeLoopWakeView {
  readonly wakeId: string
  readonly source: WakeSource
  readonly kind: WakeKind
  /** References only. Never a title, an intent or a piece of content. */
  readonly goalRef: string | null
  readonly sourceRef: string | null
  readonly occurredAt: string
  readonly observedAt: string
}

export interface LifeLoopDeadlineView {
  readonly type: DeadlineType
  /** Absolute. A window cannot extend it, shorten it or supply one. */
  readonly expiresAt: string
  /** Milliseconds left, or zero once expired. Never negative, never infinite. */
  readonly remainingMs: number
}

export interface LifeLoopCountersView {
  readonly iteration: number
  readonly actions: number
  readonly verifications: number
  /** Thoughts this wake has been authorized to have. Bounded per wake, not per process. */
  readonly cognitionRequests: number
  /** Attempts spent on the unit of work in hand. Journaled, so a restart cannot reset it. */
  readonly attempts: number
  readonly maxAttempts: number
}

export interface LifeLoopRefusalView {
  /** From `WakeRefusalCode`, or one of the loop's own closed close-out codes. */
  readonly code: string
  /** When it was recorded, so a stale answer is visibly stale. */
  readonly at: string
}

/**
 * What the loop concluded last, and how loudly it was allowed to say so.
 *
 * `outcome` is what the loop concluded; `escalation` is what it resolved that down
 * to. The gap between them is the whole of Phase 23's restraint — focus suppresses
 * an `interrupt` and nothing else, and STOP ALL suppresses everything — so both are
 * shown rather than only the safer one.
 */
export interface LifeLoopConclusionView {
  readonly outcome: DecideOutcome
  readonly escalation: OwnerEscalation
  /** True when Attention, which owns the owner's attention, suppressed or demoted it. */
  readonly attentionSuppressed: boolean
}

/**
 * Everything a window may know about the life loop, in one read-only object.
 *
 * A mirror, in the same sense as every other subsystem's: Core builds it, a window
 * holds what Core last sent, and nothing a window can do writes a field of it.
 * `sequence` lets a window prove *which* journal state it is looking at.
 */
export interface LifeLoopProjection {
  readonly health: 'ready' | 'degraded' | 'unavailable'
  /** Why, in words a person can act on. Null when healthy. */
  readonly reason: string | null
  readonly schemaVersion: number
  /** Highest sequence folded in, so a window can prove it is current. */
  readonly sequence: number
  /** Where the loop is. Nine states, closed. */
  readonly state: ContinuationState
  readonly isIdle: boolean
  readonly isStopped: boolean
  /** True while the loop is switched off entirely, which is a decision not a fault. */
  readonly isEnabled: boolean
  readonly currentWake: LifeLoopWakeView | null
  readonly currentDeadline: LifeLoopDeadlineView | null
  readonly counters: LifeLoopCountersView
  readonly conclusion: LifeLoopConclusionView | null
  /** The most recent refusal the registry made, or null. Code and instant only. */
  readonly lastRefusal: LifeLoopRefusalView | null
  /** How many wakes the registry has refused since this process started. */
  readonly refusedWakes: number
  /** One line about what the last restart did, or null when nothing was recovered. */
  readonly recovery: string | null
  /** A recovery that stopped work the owner thought was under way. */
  readonly requiresOwnerAction: boolean
  /**
   * How much of the loop's own promise is currently being kept, by name.
   *
   * Eight assertions, each checkable, reported rather than claimed — because a
   * promise about money is worth only as much as the thing that tests it, and a
   * surface that could see the verdict would not have to take the claim on trust.
   */
  readonly assertions: LifeLoopAssertionView
  readonly limits: LifeLoopLimits
}

export interface LifeLoopAssertionView {
  readonly noModelCallWithoutWake: boolean
  readonly noContinuousPolling: boolean
  readonly noHiddenReasoning: boolean
  readonly noUnrestrictedLoops: boolean
  readonly noAuthorityEscalation: boolean
  readonly noIdleModelCall: boolean
  readonly noBackgroundReasoning: boolean
  readonly noHiddenDurableState: boolean
}

/* --------------------------------------------------------------- absent */

/**
 * A valid projection for a Core that has no life loop.
 *
 * `unavailable`, never `ready` with zeroes: "Freya is idle" and "there is no
 * continuous life loop" are different facts, and a surface that rendered the
 * second as the first would be telling a person that nothing is watching when
 * nothing is.
 */
export const ABSENT_LIFE_LOOP_PROJECTION: LifeLoopProjection = Object.freeze({
  health: 'unavailable' as const,
  reason: 'Core has not reported a Continuous Life Loop yet',
  schemaVersion: 1,
  sequence: 0,
  state: 'IDLE' as ContinuationState,
  isIdle: true,
  isStopped: false,
  isEnabled: false,
  currentWake: null,
  currentDeadline: null,
  counters: Object.freeze({
    iteration: 0,
    actions: 0,
    verifications: 0,
    cognitionRequests: 0,
    attempts: 0,
    maxAttempts: 0,
  }),
  conclusion: null,
  lastRefusal: null,
  refusedWakes: 0,
  recovery: null,
  requiresOwnerAction: false,
  assertions: Object.freeze({
    noModelCallWithoutWake: true,
    noContinuousPolling: true,
    noHiddenReasoning: true,
    noUnrestrictedLoops: true,
    noAuthorityEscalation: true,
    noIdleModelCall: true,
    noBackgroundReasoning: true,
    noHiddenDurableState: true,
  }),
  limits: Object.freeze({
    maxLoopIterations: 0,
    maxLoopIterationMs: 0,
    maxActionsPerIteration: 0,
    maxVerificationsPerIteration: 0,
    maxCognitionRequestsPerWake: 0,
    maxWaitMs: 0,
    maxBackoffMs: 0,
    baseBackoffMs: 0,
    jitterMs: 0,
    maxAttemptsPerUnit: 0,
    maxPendingSchedules: 0,
    maxPayloadTextLength: 0,
  }) as unknown as LifeLoopLimits,
})

/**
 * The sentence Core reports when the loop has not been built.
 *
 * Exported so the host, the surface and the tests quote the same words rather than
 * paraphrasing the absence into four slightly different claims.
 */
export const NO_LIFE_LOOP_DOMAIN_REASON =
  'this Core has no Continuous Life Loop: nothing wakes, and none of it is simulated'

/** The projection schema this lane speaks. */
export const LIFE_LOOP_SCHEMA_VERSION = 1

/** The sentence a window gets when a payloadless read carried something. */
export const LIFE_LOOP_NO_PAYLOAD =
  'lifeloop.status.read carries no payload: a window may ask where the loop is and may not supply a wake, a source, an outcome or a deadline'

export type { WakeRefusalCode }