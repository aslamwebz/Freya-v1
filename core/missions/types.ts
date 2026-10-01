/**
 * THE MISSION DOMAIN.
 *
 * A Mission is the answer to one question:
 *
 * > **What are we actually trying to accomplish?**
 *
 * It is deliberately *not* an answer to "what did we try?", which is what a Run
 * answers. Collapsing the two is the single mistake this file exists to prevent,
 * because the collapse produces two lies:
 *
 * - A failed Run would fail the Mission, when the honest position is that one
 *   execution attempt failed and another may succeed.
 * - A successful Run would complete the Mission, when a successful attempt is not
 *   the same fact as an achieved outcome.
 *
 * So:
 *
 * ```
 *   Mission   the outcome, held across restarts
 *    └ Run     one execution attempt toward it        (Phase 6 owns this)
 *       └ Step └ Action └ Observation └ Verification (Phase 6 owns these)
 * ```
 *
 * ## Mission content is private, and that is a structural property
 *
 * The things people put in a Mission are the most private text Freya will ever
 * hold: "find me another job", "help me handle my house move", "get Freya to
 * €2,000 MRR". Two consequences follow, and both are load-bearing:
 *
 * 1. **Mission content never enters the event journal.** The journal holds ids,
 *    statuses, counts, timestamps and closed codes. There is no slot for a title,
 *    an intent or a success criterion, and the validators *reject an unexpected
 *    field* rather than ignoring it.
 * 2. **Mission content lives in its own encrypted store, under its own key.** It
 *    does not reuse the conversation key, the Brain key or any research secret,
 *    and there is no master root — a Mission is about the user's plans, which is
 *    not the same class of data as anything else Freya stores.
 *
 * ## No progress percentage
 *
 * There is no `percent` field anywhere in this file. A Mission has no denominator:
 * a Run can be decomposed again, so "3 of 5 steps done" is a fact about a plan and
 * not about an outcome. Anything that printed 72% next to the word Mission would be
 * inventing arithmetic. §9 of the Phase 7 brief asks for derived counts, and that
 * is what this file provides.
 */

import type { PrincipalId } from '../protocol/core-protocol'

/* ---------------------------------------------------------------- statuses */

export const MISSION_STATUSES = [
  'draft',
  'active',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const

export type MissionStatus = (typeof MISSION_STATUSES)[number]

export const MISSION_TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const
export type MissionTerminalStatus = (typeof MISSION_TERMINAL_STATUSES)[number]

export function isTerminalMissionStatus(status: MissionStatus): status is MissionTerminalStatus {
  return MISSION_TERMINAL_STATUSES.includes(status as MissionTerminalStatus)
}

/**
 * The Mission state machine.
 *
 * The single definition. The engine and the reducer both read it, so "what
 * transitions exist" is one answer rather than two that can disagree — and a
 * disagreement there is exactly how a replayed journal could produce a state the
 * live engine would refuse to reach.
 *
 * Note what is absent. `paused → completed` is **not** permitted: a paused Mission
 * has stopped, and resuming and then completing is the only honest path to it.
 * `completed → anything` is not permitted either, and there is no resurrection of
 * any kind. Retrying is a *new* Mission, or another child Run before settlement.
 */
export const MISSION_TRANSITIONS: Readonly<Record<MissionStatus, readonly MissionStatus[]>> = Object.freeze({
  draft: Object.freeze(['active', 'cancelled'] as const),
  active: Object.freeze(['paused', 'completed', 'failed', 'cancelled'] as const),
  paused: Object.freeze(['active', 'failed', 'cancelled'] as const),
  completed: Object.freeze([] as const),
  failed: Object.freeze([] as const),
  cancelled: Object.freeze([] as const),
})

export function canTransitionMission(from: MissionStatus, to: MissionStatus): boolean {
  return MISSION_TRANSITIONS[from].includes(to)
}

/**
 * Closed reasons.
 *
 * Anything that reaches a durable Mission event is one of these. A free-text reason
 * in the journal would be a place for private content to leak, and a place for a
 * thrown exception's message to end up on disk.
 */
export const MISSION_REASONS = Object.freeze({
  owner: 'owner',
  verification_passed: 'verification_passed',
  verification_not_established: 'verification_not_established',
  verification_timeout: 'verification_timeout',
  no_child_runs: 'no_child_runs',
  child_run_failed: 'child_run_failed',
  child_run_cancelled: 'child_run_cancelled',
  child_run_unverified: 'child_run_unverified',
  deadline_expired: 'deadline_expired',
  child_run_limit: 'child_run_limit',
  concurrent_run_limit: 'concurrent_run_limit',
  retention_limit: 'retention_limit',
  lifetime_limit: 'lifetime_limit',
  recovery: 'recovery',
  shutdown: 'shutdown',
} as const)

export type MissionReason = (typeof MISSION_REASONS)[keyof typeof MISSION_REASONS]

/* ------------------------------------------------------------------ limits */

export interface MissionLimits {
  /** Child Runs this Mission may ever attach. */
  readonly maxChildRuns: number
  /** Child Runs allowed to be non-terminal at once. */
  readonly maxConcurrentChildRuns: number
  /**
   * Wall-clock lifetime of a Mission, from creation.
   *
   * A bound, not a check between operations. Nothing polls it: expiry is
   * reconciled at startup and whenever a Mission changes state, so an expired
   * Mission is discovered rather than watched.
   */
  readonly lifetimeMs: number
  /**
   * How long one completion verification may run before the engine stops waiting.
   *
   * Raced against the verifier rather than merely aborting it, because a verifier
   * that ignores its signal must not be able to hold a Mission open indefinitely.
   */
  readonly verificationDeadlineMs: number
  /** Missions retained in the volatile listing. */
  readonly maxRetainedMissions: number
  /** Characters in a title. */
  readonly maxTitleChars: number
  /** Characters in an intent. */
  readonly maxIntentChars: number
  /** Success criteria a Mission may hold. */
  readonly maxSuccessCriteria: number
  /** Characters in one success criterion. */
  readonly maxCriterionChars: number
}

export const DEFAULT_MISSION_LIMITS: Readonly<MissionLimits> = Object.freeze({
  maxChildRuns: 64,
  maxConcurrentChildRuns: 4,
  lifetimeMs: 30 * 24 * 60 * 60_000,
  verificationDeadlineMs: 60_000,
  maxRetainedMissions: 200,
  maxTitleChars: 160,
  maxIntentChars: 4_000,
  maxSuccessCriteria: 16,
  maxCriterionChars: 500,
})

const LIMIT_NAMES: readonly (keyof MissionLimits)[] = [
  'maxChildRuns',
  'maxConcurrentChildRuns',
  'lifetimeMs',
  'verificationDeadlineMs',
  'maxRetainedMissions',
  'maxTitleChars',
  'maxIntentChars',
  'maxSuccessCriteria',
  'maxCriterionChars',
]

/**
 * Apply a caller's *narrowed* ceilings.
 *
 * A caller may lower a ceiling and may never raise one. An unknown key, a
 * non-integer or a value above the ceiling is **refused**, not clamped — clamping
 * would silently accept a caller trying to raise a limit, and an ignored key would
 * let a future field slip past unreviewed.
 */
export function missionLimits(overrides: Partial<MissionLimits> = {}): Readonly<MissionLimits> {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('mission limits are malformed')
  }
  const merged: Record<string, number> = { ...DEFAULT_MISSION_LIMITS }
  for (const [key, value] of Object.entries(overrides)) {
    if (!LIMIT_NAMES.includes(key as keyof MissionLimits)) throw new Error(`unknown mission limit: ${key}`)
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new Error(`mission limit ${key} is not a positive integer`)
    }
    if (value > DEFAULT_MISSION_LIMITS[key as keyof MissionLimits]) {
      throw new Error(`mission limit ${key} may not exceed its code-owned ceiling`)
    }
    merged[key] = value
  }
  return Object.freeze(merged as unknown as MissionLimits)
}

/* ------------------------------------------------------ private content */

/**
 * What a Mission is *for*.
 *
 * Private, bounded, and stored encrypted under the Mission domain. It never
 * appears in an event, and a Mission is unreadable without it — which is why a
 * Mission whose content cannot be opened is reported rather than shown empty.
 */
export interface MissionContentInput {
  readonly title: string
  readonly intent: string
  readonly successCriteria?: readonly string[]
}

export interface MissionContent {
  readonly missionId: string
  readonly title: string
  readonly intent: string
  readonly successCriteria: readonly string[]
  readonly createdAt: string
}

export type MissionContentResult =
  | { readonly ok: true; readonly value: Omit<MissionContent, 'missionId' | 'createdAt'> }
  | { readonly ok: false; readonly reason: string }

// Control characters are removed rather than escaped, except tab and newline.
//
// A Mission title ends up in window titles, projections and accessibility labels,
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
 * Normalise and bound Mission content.
 *
 * Content is **data**. It is never evaluated, never parsed as markup and never
 * interpreted; this function only trims, strips control characters and enforces the
 * ceilings.
 */
export function normaliseMissionContent(input: MissionContentInput): MissionContentResult {
  if (typeof input !== 'object' || input === null) return { ok: false, reason: 'mission content is malformed' }

  const title = clean(input.title, DEFAULT_MISSION_LIMITS.maxTitleChars)
  if (title === null) return { ok: false, reason: `a mission title must be 1-${DEFAULT_MISSION_LIMITS.maxTitleChars} characters` }

  const intent = clean(input.intent, DEFAULT_MISSION_LIMITS.maxIntentChars)
  if (intent === null) return { ok: false, reason: `a mission intent must be 1-${DEFAULT_MISSION_LIMITS.maxIntentChars} characters` }

  let criteria: readonly string[] = []
  if (input.successCriteria !== undefined) {
    if (!Array.isArray(input.successCriteria)) return { ok: false, reason: 'success criteria must be a list' }
    if (input.successCriteria.length > DEFAULT_MISSION_LIMITS.maxSuccessCriteria) {
      return { ok: false, reason: `a mission may hold at most ${DEFAULT_MISSION_LIMITS.maxSuccessCriteria} success criteria` }
    }
    const cleaned: string[] = []
    for (const raw of input.successCriteria) {
      const criterion = clean(raw, DEFAULT_MISSION_LIMITS.maxCriterionChars)
      if (criterion === null) {
        return { ok: false, reason: `each success criterion must be 1-${DEFAULT_MISSION_LIMITS.maxCriterionChars} characters` }
      }
      cleaned.push(criterion)
    }
    criteria = cleaned
  }

  return { ok: true, value: { title, intent, successCriteria: criteria } }
}

function clean(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = stripControlCharacters(value).trim()
  if (trimmed.length === 0 || trimmed.length > max) return null
  return trimmed
}

/* --------------------------------------------------------------- records */

/**
 * What the journal knows about one Mission.
 *
 * Durable, and metadata only. Every field is an id, a status, an instant, a count,
 * a bound or a closed code. There is deliberately **no title, no intent and no
 * success criteria here** — those live in the encrypted private store, and their
 * absence from this record is what makes a Mission journal safe to keep in a backup.
 */
export interface MissionRecord {
  readonly missionId: string
  readonly status: MissionStatus
  readonly createdAt: string
  readonly activatedAt: string | null
  readonly pausedAt: string | null
  readonly settledAt: string | null
  /** Absolute deadline derived from `lifetimeMs` at creation. */
  readonly deadlineAt: string
  /** Child Runs attached, in attachment order. Never re-sorted. */
  readonly childRuns: readonly string[]
  readonly limits: MissionLimits
  /** The last verification request's outcome. A code, never evidence. */
  readonly verification: MissionVerificationRecord | null
  /** Closed code for why this Mission settled, or for a refused child Run. */
  readonly reason: MissionReason | null
  /** How many child Runs were refused by a ceiling. Durable, so a restart cannot hide one. */
  readonly limitsHit: readonly MissionLimitName[]
}

export type MissionLimitName = 'maxChildRuns' | 'maxConcurrentChildRuns' | 'lifetimeMs'

export type MissionVerificationState = 'requested' | 'passed' | 'not_established' | 'timeout' | 'cancelled'

export interface MissionVerificationRecord {
  readonly verifierId: string
  readonly state: MissionVerificationState
  readonly requestedAt: string
  readonly settledAt: string | null
  /** Closed code. Never a verifier's message, never evidence. */
  readonly reason: MissionReason | null
  /** Child Runs this request required. Ids only. */
  readonly requiredRunIds: readonly string[]
}

/* ------------------------------------------------------------ verification */

/**
 * What a Mission verifier is asked.
 *
 * Deliberately thin: ids, statuses and counts. A verifier is code owned by this
 * repository, and handing it the Mission's private text would put that text in
 * whatever the verifier does with it — including, for a future verifier, a model.
 * A verifier that needs to know *what* the Mission is should ask for that
 * deliberately through the private store, under its own capability.
 */
export interface MissionVerificationContext {
  readonly missionId: string
  readonly status: MissionStatus
  /** Child Runs the completion request required, ids only. */
  readonly requiredRunIds: readonly string[]
  /** Child Run statuses, so a verifier needs no Work access of its own. */
  readonly runStatuses: Readonly<Record<string, 'completed' | 'failed' | 'cancelled' | 'verified_steps' | 'non_terminal'>>
  /** Aggregate step status per required Run. */
  readonly runStepStatuses: Readonly<Record<string, { verified: number; total: number; failed: number; other: number }>>
}

/**
 * A verifier's answer.
 *
 * A verdict and a closed code. **No free text, no evidence, no status of its
 * own** — the engine performs the transition, and only after reading this. A
 * verifier returning `{"status":"completed","principal":"owner"}` is data; it
 * cannot move a Mission, and there is no field here it could put that into.
 */
export interface MissionVerificationOutcome {
  readonly established: boolean
  readonly reason: MissionReason
  /** Present only when it is a fixed length, for display. Never content. */
  readonly summaryLength?: number
}

/**
 * A Mission verifier.
 *
 * Code-owned and separately registered. Neither a renderer nor a model may inject
 * one: a verifier is the thing that decides whether an outcome was achieved, and
 * an injectable verifier would be an injectable authority.
 */
export interface MissionVerifier {
  readonly id: string
  verify(context: MissionVerificationContext, signal: AbortSignal): Promise<MissionVerificationOutcome>
}

/* ------------------------------------------------------------- projection */

/** Counts of child Runs by their Work status. Factual, never a percentage. */
export interface MissionChildRunCounts {
  readonly total: number
  readonly queued: number
  readonly running: number
  readonly waiting: number
  readonly awaitingApproval: number
  readonly paused: number
  readonly completed: number
  readonly failed: number
  readonly cancelled: number
  /** Runs whose every step is `verified`. */
  readonly verified: number
}

/**
 * What a renderer may know about a Mission without its private content.
 *
 * `needsAttention` is derived, deterministic and honest: it means something needs
 * a person, not that a Mission is doing badly. A failed child Run sets it, because
 * an execution that failed is exactly what a person decides what to do about.
 */
export interface MissionSummaryView {
  readonly missionId: string
  readonly status: MissionStatus
  readonly createdAt: string
  readonly deadlineAt: string
  readonly settledAt: string | null
  readonly reason: MissionReason | null
  readonly counts: MissionChildRunCounts
  readonly needsAttention: boolean
  /** What can be done now, derived from the status. The UI offers exactly this. */
  readonly availableActions: readonly MissionAction[]
  readonly verification: {
    readonly state: MissionVerificationState
    readonly verifierId: string
  } | null
}

/** Actions the engine can actually perform from a given status. */
export const MISSION_ACTIONS = [
  'activate',
  'pause',
  'resume',
  'requestCompletion',
  'cancel',
  'fail',
] as const

export type MissionAction = (typeof MISSION_ACTIONS)[number]

/**
 * Every Mission, for a listing.
 *
 * `durable` says whether the private content store is encrypted. It is false on a
 * machine with no secure storage, and a Mission that is ephemeral says so rather
 * than pretending otherwise — because a Mission somebody is told is durable and
 * which is not is worse than no Mission at all.
 */
export interface MissionProjection {
  readonly persistence: {
    readonly mode: 'encrypted' | 'ephemeral' | 'unavailable'
    readonly reason: string | null
    readonly durable: boolean
  }
  readonly missions: readonly MissionSummaryView[]
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
  readonly limits: MissionLimits
  /** Highest sequence folded in, so a window can prove it is current. */
  readonly sequence: number
}

/** One Mission with its private content, for the Mission that is on screen. */
export interface MissionDetail extends MissionSummaryView {
  /** Null only when the content store is unavailable or the content is gone. */
  readonly content: MissionContent | null
  readonly contentReason: string | null
}

/* -------------------------------------------------------------- outcomes */

export type MissionOperation =
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
  | 'run-attached'
  | 'run-refused'
  | 'refused'

/**
 * What a Mission command produced.
 *
 * Explicit operations rather than a boolean, because "the Mission was not
 * completed" has several genuinely different meanings — refused, not established,
 * timed out, already settled — and a caller that has to inspect a reason string to
 * tell them apart is a caller that will get it wrong.
 */
export interface MissionCommandOutcome {
  readonly operation: MissionOperation
  readonly ok: boolean
  readonly reason?: string
  readonly missionId?: string
  readonly status?: MissionStatus
  readonly runId?: string
  readonly needsAttention?: boolean
}

/* ------------------------------------------------------------------ misc */

/** A Mission's owning principal, assigned by Core and never taken from a payload. */
export type MissionActor = PrincipalId

/** The durable shape the reducer folds and the journal replays. */
export interface MissionState {
  readonly missions: ReadonlyMap<string, MissionRecord>
  readonly sequence: number
}