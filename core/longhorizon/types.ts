import type { PrincipalId } from '../protocol/core-protocol'
import type { GoalRoadmap, GoalRoadmapInput } from './decomposition/types'
import type { GoalBudgetPolicy, GoalSpend, GoalBudgetRemaining } from './budget'

/**
 * THE LONG-HORIZON GOAL DOMAIN.
 *
 * A persistent goal is the answer to one question:
 *
 * > **What are we trying to accomplish across days or weeks?**
 *
 * It is deliberately *not* an answer to "what are we doing right now?", which is
 * what a Mission or a Run answers. Collapsing the two is the single mistake this
 * file exists to prevent, because the collapse produces two lies:
 *
 * - A failed wake would fail the goal, when the honest position is that one
 *   continuation attempt failed and another may succeed.
 * - A successful wake would complete the goal, when a successful attempt is not
 *   the same fact as an achieved outcome.
 *
 * So:
 *
 * ```
 *   Goal      the outcome, held across restarts and wakes
 *    └ Wake   one bounded continuation attempt toward it   (Phase 31 owns this)
 *       └ Checkpoint └ Verification                      (Phase 31 owns these)
 * ```
 *
 * ## Goal content is private, and that is a structural property
 *
 * The things people put in a goal are as private as a Mission's intent: "get
 * Freya to handle my house move", "find me another job". Two consequences
 * follow, and both are load-bearing:
 *
 * 1. **Goal content never enters the event journal.** The journal holds ids,
 *    states, counts, timestamps and closed codes. There is no slot for a title,
 *    a description or a completion criterion, and the validators *reject an
 *    unexpected field* rather than ignoring it.
 * 2. **Goal content lives in its own encrypted store, under its own key.** It
 *    does not reuse the conversation key, the Brain key or any Mission secret.
 *
 * ## No progress percentage
 *
 * There is no `percent` field anywhere in this file. A goal has no denominator:
 * a wake can be decomposed again, so "3 of 5 checkpoints done" is a fact about
 * a plan and not about an outcome. Anything that printed 72% next to the word
 * goal would be inventing arithmetic.
 */

/* ----------------------------------------------------------------- states */

export const GOAL_STATES = [
  'draft',
  'active',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const

export type GoalStatus = (typeof GOAL_STATES)[number]

export const GOAL_TERMINAL_STATES = ['completed', 'failed', 'cancelled'] as const
export type GoalTerminalState = (typeof GOAL_TERMINAL_STATES)[number]

export function isTerminalGoalStatus(state: GoalStatus): state is GoalTerminalState {
  return GOAL_TERMINAL_STATES.includes(state as GoalTerminalState)
}

/**
 * The goal state machine.
 *
 * The single definition. The engine and the reducer both read it, so "what
 * transitions exist" is one answer rather than two that can disagree — and a
 * disagreement there is exactly how a replayed journal could produce a state
 * the live engine would refuse to reach.
 *
 * Note what is absent. `paused → completed` is **not** permitted: a paused goal
 * has stopped, and resuming and then completing is the only honest path to it.
 * `completed → anything` is not permitted either, and there is no resurrection
 * of any kind. Retrying is a *new* goal, or another wake before settlement.
 */
export const GOAL_TRANSITIONS: Readonly<Record<GoalStatus, readonly GoalStatus[]>> = Object.freeze({
  draft: Object.freeze(['active', 'cancelled'] as const),
  active: Object.freeze(['paused', 'completed', 'failed', 'cancelled'] as const),
  paused: Object.freeze(['active', 'failed', 'cancelled'] as const),
  completed: Object.freeze([] as const),
  failed: Object.freeze([] as const),
  cancelled: Object.freeze([] as const),
})

export function canTransitionGoal(from: GoalStatus, to: GoalStatus): boolean {
  return GOAL_TRANSITIONS[from].includes(to)
}

/**
 * Closed reasons.
 *
 * Anything that reaches a durable goal event is one of these. A free-text reason
 * in the journal would be a place for private content to leak, and a place for
 * a thrown exception's message to end up on disk.
 */
export const GOAL_REASONS = Object.freeze({
  owner: 'owner',
  verification_passed: 'verification_passed',
  verification_not_established: 'verification_not_established',
  verification_timeout: 'verification_timeout',
  deadline_expired: 'deadline_expired',
  retry_ceiling_reached: 'retry_ceiling_reached',
  hard_blocker: 'hard_blocker',
  stop_all: 'stop_all',
  budget_exhausted: 'budget_exhausted',
  dependency_unmet: 'dependency_unmet',
  dependency_met: 'dependency_met',
  recovery: 'recovery',
  shutdown: 'shutdown',
  /**
   * A checkpoint was in flight when the process died.
   *
   * Distinct from `recovery` (which pauses a goal) because an interrupted
   * checkpoint is a fact about one attempt, not about the goal: the goal is
   * paused, and this is the code that says *why* the checkpoint it was working
   * on is now failed.
   */
  restart_interrupted: 'restart_interrupted',
  /**
   * The owner preempted an autonomous action.
   *
   * Journaled so a preemption is auditable rather than invisible: an owner
   * command that displaced scheduled work is a fact the record should show.
   */
  preempted: 'preempted',
} as const)

export type GoalReason = (typeof GOAL_REASONS)[keyof typeof GOAL_REASONS]

/* ------------------------------------------------------------------ limits */

export interface GoalLimits {
  /** Goals retained in the volatile listing. */
  readonly maxRetainedGoals: number
  /** Characters in a title. */
  readonly maxTitleChars: number
  /** Characters in a description. */
  readonly maxDescriptionChars: number
  /** Completion criteria a goal may hold. */
  readonly maxCompletionCriteria: number
  /** Characters in one completion criterion. */
  readonly maxCriterionChars: number
  /** Dependencies a goal may hold. */
  readonly maxDependencies: number
  /** Checkpoints a goal may hold. */
  readonly maxCheckpointsPerGoal: number
  /** Wall-clock lifetime of a goal, from creation. */
  readonly lifetimeMs: number
  /** How long one checkpoint verification may run. */
  readonly verificationDeadlineMs: number
  /** Retries per checkpoint before the goal fails. */
  readonly maxRetryCeiling: number
  /** Maximum backoff between retries. */
  readonly maxBackoffMs: number
  /** Base backoff between retries. */
  readonly baseBackoffMs: number
}

export const DEFAULT_GOAL_LIMITS: Readonly<GoalLimits> = Object.freeze({
  maxRetainedGoals: 200,
  maxTitleChars: 160,
  maxDescriptionChars: 4_000,
  maxCompletionCriteria: 64,
  maxCriterionChars: 500,
  maxDependencies: 32,
  maxCheckpointsPerGoal: 64,
  lifetimeMs: 90 * 24 * 60 * 60_000,
  verificationDeadlineMs: 24 * 60 * 60_000,
  maxRetryCeiling: 3,
  maxBackoffMs: 5 * 60_000,
  baseBackoffMs: 1_000,
})

const LIMIT_NAMES: readonly (keyof GoalLimits)[] = [
  'maxRetainedGoals',
  'maxTitleChars',
  'maxDescriptionChars',
  'maxCompletionCriteria',
  'maxCriterionChars',
  'maxDependencies',
  'maxCheckpointsPerGoal',
  'lifetimeMs',
  'verificationDeadlineMs',
  'maxRetryCeiling',
  'maxBackoffMs',
  'baseBackoffMs',
]

/**
 * Apply a caller's *narrowed* ceilings.
 *
 * A caller may lower a ceiling and may never raise one. An unknown key, a
 * non-integer or a value above the ceiling is **refused**, not clamped — clamping
 * would silently accept a caller trying to raise a limit, and an ignored key would
 * let a future field slip past unreviewed.
 */
export function goalLimits(overrides: Partial<GoalLimits> = {}): Readonly<GoalLimits> {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('goal limits are malformed')
  }
  const merged: Record<string, number> = { ...DEFAULT_GOAL_LIMITS }
  for (const [key, value] of Object.entries(overrides)) {
    if (!LIMIT_NAMES.includes(key as keyof GoalLimits)) throw new Error(`unknown goal limit: ${key}`)
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new Error(`goal limit ${key} is not a positive integer`)
    }
    if (value > DEFAULT_GOAL_LIMITS[key as keyof GoalLimits]) {
      throw new Error(`goal limit ${key} may not exceed its code-owned ceiling`)
    }
    merged[key] = value
  }
  return Object.freeze(merged as unknown as GoalLimits)
}

/* --------------------------------------------------------- private content */

/**
 * What a goal is *for*.
 *
 * Private, bounded, and stored encrypted under the goal domain. It never appears
 * in an event, and a goal is unreadable without it — which is why a goal whose
 * content cannot be opened is reported rather than shown empty.
 */
export interface GoalContentInput {
  readonly title: string
  readonly description: string
  readonly completionCriteria?: readonly string[]
  readonly roadmap?: GoalRoadmapInput
  readonly budget?: Partial<GoalBudgetPolicy>
}

export interface GoalContent {
  readonly goalId: string
  readonly title: string
  readonly description: string
  readonly completionCriteria: readonly string[]
  readonly createdAt: string
  readonly roadmap?: GoalRoadmap
  readonly budget?: GoalBudgetPolicy
  readonly spend?: GoalSpend
}

export type GoalContentResult =
  | { readonly ok: true; readonly value: Omit<GoalContent, 'goalId' | 'createdAt'> }
  | { readonly ok: false; readonly reason: string }

// Control characters are removed rather than escaped, except tab and newline.
//
// A goal title ends up in window titles, projections and accessibility labels,
// and an escape sequence surviving into one of those is a way to make a terminal
// say something Freya did not say.
//
// Built from numeric ranges so the source file itself contains no control byte, and
// written out rather than as a negated class so the rule cannot quietly widen.
const CONTROL_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
]

function stripControlCharacters(value: string): string {
  let out = ''
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    const stripped = CONTROL_RANGES.some(([low, high]) => code >= low && code <= high)
    if (!stripped) out += character
  }
  return out
}

/**
 * Normalise and bound goal content.
 *
 * Content is **data**. It is never evaluated, never parsed as markup and never
 * interpreted; this function only trims, strips control characters and enforces
 * the ceilings.
 */
export function normaliseGoalContent(input: GoalContentInput): GoalContentResult {
  if (typeof input !== 'object' || input === null) return { ok: false, reason: 'goal content is malformed' }

  const title = clean(input.title, DEFAULT_GOAL_LIMITS.maxTitleChars)
  if (title === null) return { ok: false, reason: `a goal title must be 1-${DEFAULT_GOAL_LIMITS.maxTitleChars} characters` }

  const description = clean(input.description, DEFAULT_GOAL_LIMITS.maxDescriptionChars)
  if (description === null) {
    return { ok: false, reason: `a goal description must be 1-${DEFAULT_GOAL_LIMITS.maxDescriptionChars} characters` }
  }

  let criteria: readonly string[] = []
  if (input.completionCriteria !== undefined) {
    if (!Array.isArray(input.completionCriteria)) return { ok: false, reason: 'completion criteria must be a list' }
    if (input.completionCriteria.length > DEFAULT_GOAL_LIMITS.maxCompletionCriteria) {
      return { ok: false, reason: `a goal may hold at most ${DEFAULT_GOAL_LIMITS.maxCompletionCriteria} completion criteria` }
    }
    const cleaned: string[] = []
    for (const raw of input.completionCriteria) {
      const criterion = clean(raw, DEFAULT_GOAL_LIMITS.maxCriterionChars)
      if (criterion === null) {
        return { ok: false, reason: `each completion criterion must be 1-${DEFAULT_GOAL_LIMITS.maxCriterionChars} characters` }
      }
      cleaned.push(criterion)
    }
    criteria = cleaned
  }

  return { ok: true, value: { title, description, completionCriteria: criteria } }
}

function clean(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = stripControlCharacters(value).trim()
  if (trimmed.length === 0 || trimmed.length > max) return null
  return trimmed
}

/* ----------------------------------------------------------------- records */

/**
 * What the journal knows about one goal.
 *
 * Durable, and metadata only. Every field is an id, a status, an instant, a count,
 * a bound or a closed code. There is deliberately **no title, no description and
 * no completion criteria here** — those live in the encrypted private store, and
 * their absence from this record is what makes a goal journal safe to keep in a
 * backup.
 */
export interface GoalRecord {
  readonly goalId: string
  readonly state: GoalStatus
  readonly createdAt: string
  readonly activatedAt: string | null
  readonly pausedAt: string | null
  readonly settledAt: string | null
  /** Absolute deadline derived from `lifetimeMs` at creation. */
  readonly deadlineAt: string
  /** Goal IDs this goal depends on. */
  readonly dependencies: readonly string[]
  /** Checkpoint IDs in order. */
  readonly checkpoints: readonly string[]
  /** The last verification request's outcome. A code, never evidence. */
  readonly verification: GoalVerificationRecord | null
  /** Closed code for why this goal settled, or for a refused wake. */
  readonly reason: GoalReason | null
  /** How many checkpoints have been verified. */
  readonly verifiedCheckpoints: number
  /** How many retries the current checkpoint has used. */
  readonly retryCount: number
  /** How many wakes were refused by a ceiling. Durable, so a restart cannot hide one. */
  readonly limitsHit: readonly GoalLimitName[]
}

export type GoalLimitName = 'maxCheckpointsPerGoal' | 'lifetimeMs' | 'maxRetryCeiling'

export type GoalVerificationState = 'requested' | 'passed' | 'not_established' | 'timeout' | 'cancelled'

export interface GoalVerificationRecord {
  readonly verifierId: string
  readonly state: GoalVerificationState
  readonly requestedAt: string
  readonly settledAt: string | null
  /** Closed code. Never a verifier's message, never evidence. */
  readonly reason: GoalReason | null
  /** Checkpoint IDs this request required. Ids only. */
  readonly requiredCheckpointIds: readonly string[]
}

/* ------------------------------------------------------------- checkpoints */

/**
 * A goal checkpoint.
 *
 * A checkpoint is a discrete, verifiable unit of progress toward a goal. It is
 * the smallest unit of long-horizon continuation: a wake verifies one checkpoint,
 * and the goal completes when all checkpoints are verified.
 */
export interface GoalCheckpointRecord {
  readonly checkpointId: string
  readonly goalId: string
  readonly order: number
  /** Closed code for what this checkpoint verifies. */
  readonly kind: string
  readonly status: 'pending' | 'in-progress' | 'verified' | 'failed'
  readonly verifiedAt: string | null
  /** Closed code. Never a verifier's message. */
  readonly failureReason: GoalReason | null
  /** How many times this checkpoint has been retried. */
  readonly attempts: number
}

/* ------------------------------------------------------------ verification */

/**
 * What a goal verifier is asked.
 *
 * Deliberately thin: ids, statuses and counts. A verifier is code owned by this
 * repository, and handing it the goal's private text would put that text in
 * whatever the verifier does with it — including, for a future verifier, a model.
 * A verifier that needs to know *what* the goal is should ask for that
 * deliberately through the private store, under its own capability.
 */
export interface GoalVerificationContext {
  readonly goalId: string
  readonly state: GoalStatus
  /** Checkpoint IDs the completion request required, ids only. */
  readonly requiredCheckpointIds: readonly string[]
  /** Checkpoint statuses, so a verifier needs no goal access of its own. */
  readonly checkpointStatuses: Readonly<Record<string, 'verified' | 'failed' | 'pending' | 'in-progress'>>
}

/**
 * A verifier's answer.
 *
 * A verdict and a closed code. **No free text, no evidence, no status of its
 * own** — the engine performs the transition, and only after reading this. A
 * verifier returning `{"status":"completed","principal":"owner"}` is data; it
 * cannot move a goal, and there is no field here it could put that into.
 */
export interface GoalVerificationOutcome {
  readonly established: boolean
  readonly reason: GoalReason
  /** Present only when it is a fixed length, for display. Never content. */
  readonly summaryLength?: number
}

/**
 * A goal verifier.
 *
 * Code-owned and separately registered. Neither a renderer nor a model may inject
 * one: a verifier is the thing that decides whether an outcome was achieved, and
 * an injectable verifier would be an injectable authority.
 */
export interface GoalVerifier {
  readonly id: string
  verify(context: GoalVerificationContext, signal: AbortSignal): Promise<GoalVerificationOutcome>
}

/* ------------------------------------------------------------- projection */

/**
 * What a renderer may know about a goal without its private content.
 *
 * `needsAttention` is derived, deterministic and honest: it means something needs
 * a person, not that a goal is doing badly. A failed checkpoint sets it, because
 * an execution that failed is exactly what a person decides what to do about.
 */
export interface GoalSummaryView {
  readonly goalId: string
  readonly state: GoalStatus
  readonly createdAt: string
  readonly deadlineAt: string
  readonly settledAt: string | null
  readonly reason: GoalReason | null
  readonly counts: GoalCheckpointCounts
  readonly needsAttention: boolean
  /** What can be done now, derived from the state. The UI offers exactly this. */
  readonly availableActions: readonly GoalAction[]
  readonly verification: {
    readonly state: GoalVerificationState
    readonly verifierId: string
  } | null
}

/** Counts of checkpoints by their status. Factual, never a percentage. */
export interface GoalCheckpointCounts {
  readonly total: number
  readonly pending: number
  readonly inProgress: number
  readonly verified: number
  readonly failed: number
}

/** Actions the engine can actually perform from a given state. */
export const GOAL_ACTIONS = [
  'activate',
  'pause',
  'resume',
  'requestCompletion',
  'cancel',
  'fail',
] as const

export type GoalAction = (typeof GOAL_ACTIONS)[number]

/**
 * Every goal, for a listing.
 *
 * `durable` says whether the private content store is encrypted. It is false on a
 * machine with no secure storage, and a goal that is ephemeral says so rather
 * than pretending otherwise — because a goal somebody is told is durable and
 * which is not is worse than no goal at all.
 */
export interface GoalProjection {
  readonly persistence: {
    readonly mode: 'encrypted' | 'ephemeral' | 'unavailable'
    readonly reason: string | null
    readonly durable: boolean
  }
  readonly goals: readonly GoalSummaryView[]
  readonly counts: {
    readonly total: number
    readonly draft: number
    readonly active: number
    readonly paused: number
    readonly completed: number
    readonly failed: number
    readonly cancelled: number
    readonly needsAttention: number
  }
  readonly limits: GoalLimits
  /**
   * How many goals this projection lists, out of how many exist, and how many are
   * therefore not on screen.
   *
   * `maxRetainedGoals` bounds the *listing* and nothing else — not the journal, not
   * the in-memory fold — so a viewer that quietly stopped listing goals would read
   * as "they were never created". These three make the gap visible instead.
   */
  readonly goalsRetained: number
  readonly goalsTotal: number
  readonly goalsHidden: number
  /** Highest sequence folded in, so a window can prove it is current. */
  readonly sequence: number
}

/** One goal with its private content, for the goal that is on screen. */
export interface GoalDetail extends GoalSummaryView {
  /** Null only when the content store is unavailable or the content is gone. */
  readonly content: GoalContent | null
  readonly contentReason: string | null
  readonly roadmap?: GoalRoadmap | null
  readonly budget?: GoalBudgetPolicy | null
  readonly spend?: GoalSpend | null
  readonly budgetRemaining?: GoalBudgetRemaining | null
}

/* -------------------------------------------------------------- outcomes */

export type GoalOperation =
  | 'status'
  | 'created'
  | 'activated'
  | 'paused'
  | 'resumed'
  | 'cancelled'
  | 'settled-failed'
  | 'verification-passed'
  | 'verification-not-established'
  | 'verification-in-progress'
  | 'verification-timeout'
  | 'checkpoint-verified'
  | 'checkpoint-failed'
  | 'roadmap-updated'
  | 'milestone-settled'
  | 'budget-updated'
  | 'refused'

/**
 * What a goal command produced.
 *
 * Explicit operations rather than a boolean, because "the goal was not
 * completed" has several genuinely different meanings — refused, not established,
 * timed out, already settled — and a caller that has to inspect a reason string to
 * tell them apart is a caller that will get it wrong.
 */
export interface GoalCommandOutcome {
  readonly operation: GoalOperation
  readonly ok: boolean
  readonly reason?: string
  readonly goalId?: string
  readonly state?: GoalStatus
  readonly needsAttention?: boolean
  readonly revision?: number
  readonly milestoneId?: string
  readonly budgetExhausted?: boolean
}

/* ------------------------------------------------------------------ misc */

/** A goal's owning principal, assigned by Core and never taken from a payload. */
export type GoalActor = PrincipalId

/** The durable shape the reducer folds and the journal replays. */
export interface GoalState {
  readonly goals: ReadonlyMap<string, GoalRecord>
  readonly checkpoints: ReadonlyMap<string, GoalCheckpointRecord>
  readonly sequence: number
}

/* -------------------------------------------------------------- scheduling */

/**
 * The bounded scheduler's code-owned ceilings.
 *
 * A schedule is a deterministic wake trigger: it fires when due and its
 * condition holds. These ceilings bound how many may exist, how often they may
 * repeat, how far ahead they may be set, and how long a single schedule may
 * live. They cannot be widened at runtime.
 */
export const SCHEDULE_LIMITS = Object.freeze({
  /** Schedules retained at once. */
  maxSchedules: 64,
  /** How many times a repeating schedule may fire. */
  maxRepeats: 8,
  /** Shortest interval between repeats, in milliseconds. */
  minIntervalMs: 60_000,
  /** How far ahead a schedule may be set, in milliseconds. */
  maxHorizonMs: 30 * 24 * 60 * 60 * 1000,
  /** How long a schedule may live before it expires, in milliseconds. */
  maxLifetimeMs: 30 * 24 * 60 * 60 * 1000,
})

/** The closed set of schedule conditions. */
export const SCHEDULE_CONDITIONS = ['always', 'focus-available', 'goal-open'] as const

export type ScheduleCondition = (typeof SCHEDULE_CONDITIONS)[number]

/** The closed set of schedule states. */
export const SCHEDULE_STATES = ['pending', 'fired', 'expired', 'cancelled'] as const

export type ScheduleState = (typeof SCHEDULE_STATES)[number]

/** A schedule's wake source, as recorded in the journal. */
export const WAKE_SOURCES = ['schedule', 'owner', 'heartbeat', 'mission', 'work'] as const

export type WakeSource = (typeof WAKE_SOURCES)[number]

/** Closed codes for why a wake was denied. */
export const WAKE_DENIAL_REASONS = [
  'stop-all',
  'no-active-goal',
  'goal-not-open',
  'unknown-source',
  'schedule-not-due',
] as const

export type WakeDenialReason = (typeof WAKE_DENIAL_REASONS)[number]

/**
 * One durable schedule.
 *
 * A schedule is metadata: an id, a goal, a condition, a due time. It carries no
 * content — what to do when it fires belongs to the goal it references, and the
 * journal holds only the audit events.
 */
export interface GoalScheduleRecord {
  readonly scheduleId: string
  /** Null for schedules not bound to a specific goal. */
  readonly goalId: string | null
  readonly condition: ScheduleCondition
  readonly dueAt: string
  readonly state: ScheduleState
  readonly repeatCount: number
  readonly maxRepeats: number
  readonly intervalMs: number
  readonly createdAt: string
  readonly lastFiredAt: string | null
}

/** What registering a schedule requires. */
export interface ScheduleInput {
  readonly goalId?: string | null
  readonly condition?: ScheduleCondition
  /** Milliseconds from now until the schedule is due. */
  readonly delayMs: number
  /** How many times a repeating schedule may fire. 1 for one-shot. */
  readonly maxRepeats?: number
  /** Milliseconds between repeats. */
  readonly intervalMs?: number
}

/** What a schedule command produced. */
export interface ScheduleCommandOutcome {
  readonly operation: 'registered' | 'cancelled' | 'refused'
  readonly ok: boolean
  readonly reason?: string
  readonly scheduleId?: string
}

/**
 * The result of one host-driven tick.
 *
 * Bounded and deterministic: the same state + same clock produces the same
 * result. A tick that fires nothing produces an empty list.
 */
export interface ScheduleTickResult {
  readonly fired: readonly string[]
  readonly expired: readonly string[]
  readonly denied: readonly string[]
  readonly wakeIds: readonly string[]
}

/** The scheduler's projection. */
export interface ScheduleProjection {
  readonly schedules: readonly GoalScheduleRecord[]
  readonly counts: {
    readonly total: number
    readonly pending: number
    readonly fired: number
    readonly expired: number
    readonly cancelled: number
  }
  readonly limits: typeof SCHEDULE_LIMITS
}

/* ----------------------------------------------------------- continuation */

/**
 * The long-horizon continuation state machine.
 *
 * This is what the subsystem is *doing*, distinct from what a goal *is*. A goal
 * is `active` (durable state); the subsystem is `CHECKPOINT` (what it is doing
 * right now toward that goal). The two are deliberately separate so a goal's
 * state cannot be moved by the act of pursuing it.
 */
export const CONTINUATION_STATES = [
  'IDLE',
  'GOAL_ACTIVE',
  'CHECKPOINT',
  'GOAL_PAUSED',
  'GOAL_COMPLETE',
  'GOAL_FAILED',
] as const

export type ContinuationState = (typeof CONTINUATION_STATES)[number]

/** A continuation decision, as journaled. */
export type ContinuationDecision =
  | { readonly decision: 'continue'; readonly reason: string }
  | { readonly decision: 'pause'; readonly reason: string }
  | { readonly decision: 'complete'; readonly reason: string }
  | { readonly decision: 'fail'; readonly reason: string }
  | { readonly decision: 'wait'; readonly reason: string; readonly deadline: string }

/* ----------------------------------------------------------- verification */

/** Closed verification outcomes for a checkpoint. */
export const CHECKPOINT_OUTCOMES = ['passed', 'not_established', 'timeout', 'cancelled'] as const

export type CheckpointOutcome = (typeof CHECKPOINT_OUTCOMES)[number]

/* ------------------------------------------------------------ uncertainty */

/** Closed confidence levels. Never 100%, never fabricated. */
export const CONFIDENCE_LEVELS = ['high', 'medium', 'low', 'unknown'] as const

export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number]

/** The closed set of assumption statuses. */
export const ASSUMPTION_STATUSES = ['active', 'confirmed', 'refuted', 'expired'] as const

export type AssumptionStatus = (typeof ASSUMPTION_STATUSES)[number]

/**
 * An explicit assumption made during planning.
 *
 * An assumption is a statement accepted as true for planning purposes without
 * verification. It is bounded (has an expiration), sourced (names who/what
 * created it), and surfaced (appears in the long-horizon state). It cannot
 * override owner directives and cannot grant authority.
 */
export interface GoalAssumption {
  readonly assumptionId: string
  readonly goalId: string
  readonly statement: string
  readonly confidence: ConfidenceLevel
  readonly source: string
  readonly expiresAt: string
  readonly status: AssumptionStatus
  readonly createdAt: string
}

/** Staleness thresholds for evidence, by kind. */
export const EVIDENCE_STALENESS_THRESHOLDS = Object.freeze({
  realTimeState: 5 * 60_000,
  recentEvents: 60 * 60_000,
  historicalData: 24 * 60 * 60_000,
  staticConfiguration: 30 * 24 * 60 * 60_000,
})

export type EvidenceKind = keyof typeof EVIDENCE_STALENESS_THRESHOLDS

/**
 * One piece of evidence, with its provenance and freshness.
 *
 * Evidence is never fabricated: a confidence level is always derived from the
 * sources behind it, and a stale piece of evidence is marked stale rather than
 * silently trusted.
 */
export interface GoalEvidence {
  readonly evidenceId: string
  readonly goalId: string
  readonly kind: EvidenceKind
  readonly source: string
  readonly collectedAt: string
  readonly confidence: ConfidenceLevel
  readonly stale: boolean
  readonly conflictsWith: readonly string[]
}
