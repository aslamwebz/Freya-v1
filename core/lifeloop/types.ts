/**
 * Phase 23 — the Continuous Life Loop's domain vocabulary.
 *
 * Everything in this file is a closed set. That is not tidiness: a life loop is
 * only trustworthy if the set of things that can wake it, the set of things it
 * can be in, the set of reasons it can refuse, and the set of numbers that bound
 * it are all finite and all owned by code. An open vocabulary here would mean an
 * unbounded loop by construction.
 *
 * The module is deliberately dependency-free. It imports nothing from Core, reads
 * no clock of its own, reaches no provider, and mints no authority. It is types,
 * frozen tables and closed code lists — which is what makes the state machine,
 * the pre-cognition filter and the deadline arithmetic testable without a
 * running system and safe to build before the subsystems it will later consume.
 */

/* ------------------------------------------------------------------ wake */

/**
 * The closed set of authorized wake sources.
 *
 * A wake is an authorized event that says *look at this now*. It is not a model
 * call, it is not permission, and it is not work. Five sources is all there is;
 * a sixth cannot be added at runtime, and a renderer, a model, an agent, a
 * connector callback and an external webhook are all outside this set by
 * construction rather than by policy.
 */
export const WAKE_SOURCES = [
  'owner-interaction',
  'authorized-event',
  'scheduled-heartbeat',
  'mission-transition',
  'work-transition',
] as const

export type WakeSource = (typeof WAKE_SOURCES)[number]

/**
 * The closed set of wake kinds.
 *
 * The kind, not just the source, is closed, and each kind belongs to exactly one
 * source. That is what stops a scheduled heartbeat from *claiming* to be a
 * mission transition, and stops a caller from relabelling a routine periodic
 * check as owner interaction to get past the pre-cognition filter.
 */
export const WAKE_KINDS = [
  'owner-message',
  'owner-command',
  'owner-approval',
  'mission-activated',
  'mission-completed',
  'mission-failed',
  'run-started',
  'run-completed',
  'run-failed',
  'step-verified',
  'schedule-due',
  'periodic-check',
  'research-completed',
  'system-health',
] as const

export type WakeKind = (typeof WAKE_KINDS)[number]

/**
 * Which source each kind may arrive on.
 *
 * Read as a constraint table rather than a convenience map: a wake whose source
 * does not match its kind is refused, because a mismatch is either a bug or an
 * attempt to buy a louder wake than the event deserves.
 */
export const WAKE_KIND_SOURCE: Readonly<Record<WakeKind, WakeSource>> = Object.freeze({
  'owner-message': 'owner-interaction',
  'owner-command': 'owner-interaction',
  'owner-approval': 'owner-interaction',
  'mission-activated': 'mission-transition',
  'mission-completed': 'mission-transition',
  'mission-failed': 'mission-transition',
  'run-started': 'work-transition',
  'run-completed': 'work-transition',
  'run-failed': 'work-transition',
  'step-verified': 'work-transition',
  'schedule-due': 'scheduled-heartbeat',
  'periodic-check': 'scheduled-heartbeat',
  'research-completed': 'authorized-event',
  'system-health': 'authorized-event',
})

/**
 * Who is claiming to have produced a wake.
 *
 * The source of a wake is assigned by Core from the actor that raised it, never
 * read out of a payload. Keeping the attribution on the type rather than in a
 * comment is what makes "no renderer may drive the loop" a compile-time pairing
 * instead of a review finding.
 */
export const WAKE_ACTORS = [
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

export type WakeActor = (typeof WAKE_ACTORS)[number]

/**
 * The only actor permitted to raise each source.
 *
 * Five pairs. Everything else in `WAKE_ACTORS` is unauthorized for every source,
 * which is the whole point: `model`, `renderer`, `agent`, `connector`,
 * `external-webhook` and `timer` appear nowhere on the right-hand side.
 */
export const WAKE_SOURCE_ACTOR: Readonly<Record<WakeSource, WakeActor>> = Object.freeze({
  'owner-interaction': 'owner',
  'authorized-event': 'core-subsystem',
  'scheduled-heartbeat': 'host-heartbeat',
  'mission-transition': 'core-subsystem',
  'work-transition': 'core-subsystem',
})

/**
 * Wake priority, lowest number first.
 *
 * Only meaningful when several wakes are already queued. An owner's message is
 * answered before a mission transition, which is answered before a routine
 * heartbeat. A heartbeat is last because it is the source that is allowed to be
 * entirely uninteresting.
 */
export const WAKE_SOURCE_PRIORITY: Readonly<Record<WakeSource, number>> = Object.freeze({
  'owner-interaction': 0,
  'mission-transition': 1,
  'work-transition': 2,
  'authorized-event': 3,
  'scheduled-heartbeat': 4,
})

/** A wake. Metadata only: ids, a closed kind and two timestamps. */
export interface WakeEvent {
  readonly wakeId: string
  readonly source: WakeSource
  readonly kind: WakeKind
  readonly goalRef: string | null
  readonly sourceRef: string | null
  readonly occurredAt: string
  readonly observedAt: string
}

/** A registered schedule a heartbeat may fire. */
export interface PendingSchedule {
  readonly scheduleId: string
  readonly dueAt: string
}

/** Why a wake was refused. Closed; every value has one fixed sentence. */
export type WakeRefusalCode =
  | 'unknown-source'
  | 'unknown-kind'
  | 'kind-source-mismatch'
  | 'unauthorized-actor'
  | 'missing-wake-id'
  | 'missing-kind'
  | 'missing-source-reference'
  | 'malformed-timestamp'
  | 'observed-before-occurred'
  | 'stop-all-active'
  | 'journal-not-trustworthy'
  | 'duplicate-wake'
  | 'loop-busy'
  | 'awaiting-reset'
  | 'unknown-schedule'
  | 'heartbeat-not-due'
  | 'heartbeat-condition-unmet'

/**
 * Why a wake was not acted on *now*.
 *
 * `deferred` is not a refusal. It means the wake is real, authorized and
 * correctly shaped, but the thing it names is not due yet — so the loop waits
 * with a deadline instead of spending anything.
 */
export type WakeOutcome = 'accepted' | 'deferred' | 'denied'

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

/* ------------------------------------------------------- pre-cognition */

/**
 * The closed decide outcomes — what Freya concluded, and how loudly.
 *
 * This is the vocabulary the decide step speaks, and it is deliberately small.
 * `do-nothing` is the most common outcome by design: most wakes are correct to
 * produce no thought, no action and no interruption. `remember` is the only
 * outcome that is silent but not empty. The remaining three are the only ways
 * Freya reaches for the owner's attention, ordered by how much they take from
 * them — and `interrupt` outranks all of it.
 */
export const DECIDE_OUTCOMES = [
  'do-nothing',
  'remember',
  'subtle-cue',
  'speak',
  'interrupt',
] as const

export type DecideOutcome = (typeof DECIDE_OUTCOMES)[number]

/**
 * How much of the owner's attention an outcome takes. Lower is quieter.
 *
 * `interrupt` is the highest escalation and is the only one focus is allowed to
 * suppress on its own: breaking into whatever the owner is doing is exactly the
 * thing attention is supposed to protect.
 */
export const OWNER_ESCALATIONS = ['none', 'subtle-cue', 'speak', 'interrupt'] as const

export type OwnerEscalation = (typeof OWNER_ESCALATIONS)[number]

export const DECIDE_ESCALATION: Readonly<Record<DecideOutcome, OwnerEscalation>> = Object.freeze({
  'do-nothing': 'none',
  remember: 'none',
  'subtle-cue': 'subtle-cue',
  speak: 'speak',
  interrupt: 'interrupt',
})

/** Whether an outcome reaches for the owner's attention at all. */
export function isEscalating(outcome: DecideOutcome): boolean {
  return DECIDE_ESCALATION[outcome] !== 'none'
}

/**
 * What the owner is currently focused on, as Attention already knows it.
 *
 * Read-only and supplied by the host. The life loop never sets focus and never
 * asks for it to be set — that would be Freya competing for the owner's
 * attention, which is the one thing this whole mechanism exists to prevent.
 */
export interface FocusState {
  /** The owner is mid-task. Escalation is suppressed. */
  readonly focused: boolean
  /** Stable identifier for what they are focused on. Metadata only. */
  readonly focusRef: string | null
}

/**
 * The closed reasons the pre-cognition filter may refuse.
 *
 * Ordered as the checks run, and the order is load-bearing: an untrustworthy
 * journal outranks everything, STOP ALL outranks everything below it, and only
 * once both are clear does the question "is a model call worth it here?" even
 * get asked. A refusal therefore always names the *first* thing that was wrong,
 * which is what makes the journal readable after the fact.
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

export type PreCognitionOutcome =
  | { readonly outcome: 'deny'; readonly code: PreCognitionDenialCode; readonly reason: string }
  | {
      readonly outcome: 'wait'
      readonly code: 'cooldown-active'
      readonly reason: string
      readonly deadline: string
    }
  | {
      readonly outcome: 'allow'
      readonly code: 'cognition-justified'
      readonly reason: string
    }

/**
 * The wake kinds that justify spending a model call, and the kinds that do not.
 *
 * This table *is* the "a wake does not imply a model call" requirement. A
 * periodic check, a system health ping, a mission merely becoming active and a
 * run merely starting all wake the loop and all get evaluated — but none of them
 * is on its own a reason to pay for inference. They are the four cases a
 * plausible implementation would get wrong by treating "something happened" as
 * "Freya should think about it".
 */
export const COGNITION_JUSTIFYING_KINDS: ReadonlySet<WakeKind> = new Set<WakeKind>([
  'owner-message',
  'owner-command',
  'owner-approval',
  'mission-completed',
  'mission-failed',
  'run-completed',
  'run-failed',
  'step-verified',
  'research-completed',
  'schedule-due',
])

/** The kinds that wake the loop and are deterministically refused a model call. */
export const NON_JUSTIFYING_KINDS: readonly WakeKind[] = Object.freeze(
  (['periodic-check', 'system-health', 'mission-activated', 'run-started'] as const).filter(
    (kind) => !COGNITION_JUSTIFYING_KINDS.has(kind),
  ),
)

/* ---------------------------------------------------------- state machine */

/** The continuation states. Nine, closed, and two of them terminal. */
export const CONTINUATION_STATES = [
  'IDLE',
  'WAKING',
  'DENY',
  'WAIT',
  'ALLOW',
  'ACTING',
  'VERIFYING',
  'CONTINUE',
  'STOP',
] as const

export type ContinuationState = (typeof CONTINUATION_STATES)[number]

/** States with no outgoing edge except an explicit reset. */
export const TERMINAL_STATES: readonly ContinuationState[] = Object.freeze(['DENY', 'STOP'])

/** States that are holding a deadline and must be interruptible. */
export const WAITING_STATES: readonly ContinuationState[] = Object.freeze([
  'WAIT',
  'ACTING',
  'VERIFYING',
])

/** The ordinary signals the state machine moves on. */
export const CONTINUATION_SIGNALS = [
  'wake-received',
  'filter-denied',
  'condition-not-met',
  'filter-allowed',
  'next-wake',
  'deadline-expired',
  'cognition-allowed',
  'cognition-denied',
  'action-completed',
  'action-failed',
  'verification-passed',
  'verification-failed',
  'next-iteration',
  'loop-complete',
  'reset',
] as const

export type ContinuationSignal = (typeof CONTINUATION_SIGNALS)[number]

/** Why an ordinary transition was refused. */
export type TransitionRefusalCode = 'illegal-transition' | 'already-terminal' | 'self-transition'

export type TransitionOutcome =
  | {
      readonly ok: true
      readonly from: ContinuationState
      readonly to: ContinuationState
      readonly signal: ContinuationSignal
      readonly event: LifeLoopEventType | null
      readonly reason: string
    }
  | {
      readonly ok: false
      readonly from: ContinuationState
      readonly signal: ContinuationSignal
      readonly code: TransitionRefusalCode
      readonly reason: string
    }

/* ----------------------------------------------------------- deadlines */

export type DeadlineType = 'verification' | 'approval' | 'wait' | 'action'

export const DEADLINE_TYPES: readonly DeadlineType[] = Object.freeze([
  'verification',
  'approval',
  'wait',
  'action',
])

/**
 * A deadline. Absolute, never relative to the process that created it.
 *
 * Absolute is the whole discipline: a relative deadline is extended every time
 * the process restarts, which turns a 24-hour verification ceiling into "24
 * hours per attempt, forever" for anything that can crash the app.
 */
export interface Deadline {
  readonly type: DeadlineType
  readonly expiresAt: string
  readonly reason: string
}

/** The closed reasons a deadline can expire with. */
export type DeadlineOutcomeCode =
  | 'deadline-expired'
  | 'limit-attempts'
  | 'limit-actions'
  | 'limit-duration'
  | 'interrupted'

export type DeadlineOutcome = {
  readonly ok: boolean
  readonly code: DeadlineOutcomeCode | null
  readonly reason: string
}

export interface RetryCeiling {
  readonly maxAttempts: number
  readonly currentAttempt: number
  readonly baseBackoffMs: number
  readonly maxBackoffMs: number
  readonly jitterMs: number
}

/* --------------------------------------------------------- interruption */

export const INTERRUPTION_SOURCES = [
  'stop-all',
  'owner-command',
  'guard-denial',
  'budget-exhaustion',
  'approval-required',
  'deadline-expiry',
] as const

export type InterruptionSource = (typeof INTERRUPTION_SOURCES)[number]

/**
 * Why an interruption did not change the state.
 *
 * `unknown-state` is separate from `terminal` because they mean opposite things
 * and conflating them would let a corrupt journal entry read as a finished loop.
 */
export type InterruptionNotApplicable =
  | 'nothing-to-preempt'
  | 'terminal'
  | 'unknown-state'
  | 'stop-all-latched'

export type InterruptionOutcome =
  | {
      readonly applied: true
      readonly from: ContinuationState
      readonly to: ContinuationState
      readonly source: InterruptionSource
      readonly preempted: boolean
      /**
       * The loop is now parked on the owner rather than on the world.
       *
       * True only for `approval-required`, and it is what makes the caller mint
       * an `approval` deadline instead of a `wait` one: an unanswered request for
       * a person expires on a clock like anything else, but it is a different
       * kind of clock and it must be legible as one afterwards.
       */
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

/* ------------------------------------------------------------- recovery */

export type RecoveryActionCode =
  | 'stay-idle'
  | 'reset-to-idle'
  | 're-evaluate-on-next-wake'
  | 'preserve-wait'
  | 'wait-deadline-expired'
  | 'interrupted-action-stopped'
  | 'interrupted-verification-stopped'
  | 'stop-all-latched'

export interface RecoveryAction {
  readonly code: RecoveryActionCode
  readonly from: ContinuationState
  readonly to: ContinuationState
  readonly reason: string
}

export interface RecoveryReport {
  readonly interruptedState: ContinuationState
  readonly recoveredState: ContinuationState
  readonly actions: readonly RecoveryAction[]
  /** Whether the loop may pick work up again on its own. Never `true` after this phase. */
  readonly resumption: 'none' | 'wait'
  readonly residualDeadline: Deadline | null
  /** True when only the owner can move things on. */
  readonly requiresOwnerAction: boolean
  readonly stopAllActive: boolean
}

/* --------------------------------------------------------------- limits */

/**
 * The code-owned ceilings. Frozen, and the source of every bound in Phase 23.
 *
 * These are not defaults. There is no code path that raises them: the only way
 * to configure the loop is `narrowLifeLoopLimits`, which clamps every value
 * *down* to the numbers below and refuses to represent anything wider.
 */
export const LIFE_LOOP_LIMITS = Object.freeze({
  /** Loop iterations per wake. Ten is a bound, not a budget. */
  maxLoopIterations: 10,
  /** Wall-clock for one iteration. */
  maxLoopIterationMs: 15 * 60_000,
  /** Bounded actions per iteration. */
  maxActionsPerIteration: 128,
  /** Verifications per iteration. */
  maxVerificationsPerIteration: 64,
  /** Cognition requests per wake. The real ceiling on spend per wake. */
  maxCognitionRequestsPerWake: 8,
  /** The longest a wait may last before it is a failure. */
  maxWaitMs: 30 * 24 * 60 * 60 * 1_000,
  /** Backoff ceiling. */
  maxBackoffMs: 5 * 60_000,
  /** Backoff base. */
  baseBackoffMs: 1_000,
  /** Jitter window, added to the exponential term and then clamped. */
  jitterMs: 1_000,
  /** Attempts for one retried unit of work. */
  maxAttemptsPerUnit: 3,
  /** Kept schedules a heartbeat may fire. */
  maxPendingSchedules: 64,
  /**
   * The longest string any life-loop journal payload may carry.
   *
   * The journal is the least protected file in the system. A life-loop event
   * that could carry a paragraph would quietly turn it into a transcript of what
   * Freya was thinking, so the bound is enforced on the value and not merely
   * documented.
   */
  maxPayloadTextLength: 200,
})

export type LifeLoopLimits = typeof LIFE_LOOP_LIMITS

/**
 * A request to narrow the ceilings.
 *
 * Deliberately untyped as to value. A request is untrusted input: it may be
 * wider than the ceiling it names, non-numeric, negative, or absent, and
 * `narrowLifeLoopLimits` has to survive all of it without the caller being able
 * to widen anything. Typing the values as the frozen literals would mean the
 * type system rejected the hostile requests before the clamp ever saw them,
 * which is exactly the case worth testing.
 */
export type LifeLoopLimitRequest = { readonly [K in keyof LifeLoopLimits]?: unknown }

/* -------------------------------------------------------------- journal */

export const LIFE_LOOP_EVENT_TYPES = [
  'lifeloop.wake.received',
  'lifeloop.wake.denied',
  'lifeloop.filter.passed',
  'lifeloop.filter.denied',
  'lifeloop.cognition.requested',
  'lifeloop.cognition.denied',
  'lifeloop.action.started',
  'lifeloop.action.completed',
  'lifeloop.action.failed',
  'lifeloop.verification.started',
  'lifeloop.verification.passed',
  'lifeloop.verification.failed',
  'lifeloop.continuation.decided',
  'lifeloop.reset',
  'lifeloop.stopped',
] as const

export type LifeLoopEventType = (typeof LIFE_LOOP_EVENT_TYPES)[number]

export const LIFE_LOOP_EVENT_TYPE_SET: ReadonlySet<string> = new Set<string>(LIFE_LOOP_EVENT_TYPES)

/**
 * The closed payload vocabulary, per event type.
 *
 * Two jobs. It makes "the journal holds metadata and not content" checkable by
 * reading one table, and it makes the reducer's unknown-key handling an audit
 * signal rather than a shrug. A payload key that is not on this list is an
 * anomaly, not a new field.
 */
export const LIFE_LOOP_PAYLOAD_KEYS: Readonly<Record<LifeLoopEventType, readonly string[]>> =
  Object.freeze({
    'lifeloop.wake.received': [
      'wakeId',
      'source',
      'kind',
      'wakeKey',
      'iteration',
      'goalRef',
      'sourceRef',
      'occurredAt',
      'observedAt',
    ],
    'lifeloop.wake.denied': ['wakeId', 'source', 'code', 'iteration'],
    'lifeloop.filter.passed': ['wakeId', 'wakeKey', 'code', 'iteration'],
    'lifeloop.filter.denied': ['wakeId', 'wakeKey', 'outcome', 'code', 'deadlineType', 'iteration'],
    'lifeloop.cognition.requested': ['wakeId', 'wakeKey', 'iteration', 'cognitionRequest'],
    'lifeloop.cognition.denied': ['wakeId', 'wakeKey', 'code', 'iteration'],
    'lifeloop.action.started': ['wakeId', 'iteration', 'actionIndex', 'deadlineType'],
    'lifeloop.action.completed': ['wakeId', 'iteration', 'actionIndex'],
    'lifeloop.action.failed': ['wakeId', 'iteration', 'actionIndex', 'code'],
    'lifeloop.verification.started': ['wakeId', 'iteration', 'verificationIndex', 'deadlineType'],
    'lifeloop.verification.passed': ['wakeId', 'iteration', 'verificationIndex'],
    'lifeloop.verification.failed': ['wakeId', 'iteration', 'verificationIndex', 'code'],
    'lifeloop.continuation.decided': [
      'wakeId',
      'iteration',
      'decision',
      'actionCount',
      'verificationCount',
    ],
    'lifeloop.stopped': ['wakeId', 'iteration', 'code'],
    // The close-out. Without it a denied loop stays denied in the journal for
    // ever and the loop is single-shot: one wake, one refusal, silence. `code`
    // says why the wake is over — 'closed-out', 'retry', 'awaiting-approval'.
    'lifeloop.reset': ['wakeId', 'iteration', 'code'],
  })

/**
 * Keys that must never appear in a life-loop payload.
 *
 * Authority is minted by the Guard and the Governor, and it is minted by Core —
 * never by an event. So a payload carrying one of these is not a new field, it
 * is an escalation attempt, and it is refused before it reaches the journal.
 */
export const FORBIDDEN_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  'capability',
  'capabilities',
  'grant',
  'grantId',
  'authority',
  'verdict',
  'allowed',
  'approved',
  'token',
  'secret',
  'credential',
  'budget',
  'maxOutputTokens',
])

/* ---------------------------------------------------------------- status */

/** The zero-idle-inference assertions, by id. Each is checkable, none is decorative. */
export const ZERO_IDLE_ASSERTIONS = [
  'noModelCallWithoutWake',
  'noContinuousPolling',
  'noHiddenReasoning',
  'noUnrestrictedLoops',
  'noAuthorityEscalation',
  'noIdleModelCall',
  'noBackgroundReasoning',
  'noHiddenDurableState',
] as const

export type ZeroIdleAssertionId = (typeof ZERO_IDLE_ASSERTIONS)[number]

export interface LifeLoopStatus {
  readonly state: ContinuationState
  readonly iterationCount: number
  readonly actionCount: number
  readonly verificationCount: number
  readonly cognitionRequestCount: number
  readonly attemptCount: number
  readonly retriesExhausted: boolean
  readonly currentWake: WakeEvent | null
  readonly currentDeadline: Deadline | null
  readonly isIdle: boolean
  readonly isStopped: boolean
}

/* ----------------------------------------------------------- predicates */

export function isWakeSource(value: unknown): value is WakeSource {
  return typeof value === 'string' && (WAKE_SOURCES as readonly string[]).includes(value)
}

export function isWakeKind(value: unknown): value is WakeKind {
  return typeof value === 'string' && (WAKE_KINDS as readonly string[]).includes(value)
}

export function isContinuationState(value: unknown): value is ContinuationState {
  return typeof value === 'string' && (CONTINUATION_STATES as readonly string[]).includes(value)
}

export function isTerminalState(state: ContinuationState): boolean {
  return TERMINAL_STATES.includes(state)
}

export function isWaitingState(state: ContinuationState): boolean {
  return WAITING_STATES.includes(state)
}

/**
 * Does this wake kind, on its own, justify paying for a model call?
 *
 * The single most important predicate in the module. It is a pure set lookup, it
 * takes no arguments from a caller who could bend it, and the answer is `false`
 * for a routine periodic check.
 */
export function justifiesCognition(kind: WakeKind): boolean {
  return COGNITION_JUSTIFYING_KINDS.has(kind)
}

/** Relative wake priority; lower is sooner. */
export function wakePriority(source: WakeSource): number {
  return WAKE_SOURCE_PRIORITY[source]
}