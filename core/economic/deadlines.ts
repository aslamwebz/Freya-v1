import { totalUnitAllowance } from './authority'
import type { EconomicLimits } from './types'

/**
 * Deadlines, retry ceilings and backoff.
 *
 * The discipline here is **absolute**, and it is inherited wholesale from Phase 23: a
 * deadline is an instant, never an interval. A relative deadline is extended by every
 * process restart, which turns a five-minute stage ceiling into "five minutes per
 * attempt, for ever" for anything that can crash the app — and the class of thing that
 * can crash the app is exactly the class of thing a deadline exists to bound.
 *
 * So every instant this module produces is written down, and a restart reads it back
 * rather than re-deriving it. The other half of the discipline is that nothing here
 * reads a clock: `now` is a parameter, which is what lets a test say "after the
 * deadline" and mean it.
 */

/** The kinds of hold an economic action can be parked on. Closed. */
export const ECONOMIC_DEADLINE_TYPES = ['experiment', 'stage', 'retry'] as const

export type EconomicDeadlineType = (typeof ECONOMIC_DEADLINE_TYPES)[number]

export interface EconomicDeadline {
  readonly type: EconomicDeadlineType
  /** Absolute ISO instant. A restart cannot move it. */
  readonly expiresAt: string
  readonly reason: string
}

/**
 * The per-kind defaults, in milliseconds.
 *
 * Declared as literal expressions rather than read from `ECONOMIC_LIMITS` so that this
 * module has no import at all. `stage` and `retry` are not in the ceilings table
 * because they are properties of *one attempt*, not of an experiment's size, and
 * putting them there would suggest an operator is expected to tune them.
 */
const ECONOMIC_LIMITS_DEFAULTS = Object.freeze({
  experiment: 30 * 24 * 60 * 60 * 1_000,
  stage: 60 * 60 * 1_000,
  retry: 5 * 60_000,
})

/** The default span each kind gets when the caller names none. */
export const ECONOMIC_DEADLINE_DEFAULT_MS: Readonly<Record<EconomicDeadlineType, number>> =
  Object.freeze({
    experiment: ECONOMIC_LIMITS_DEFAULTS.experiment,
    stage: ECONOMIC_LIMITS_DEFAULTS.stage,
    retry: ECONOMIC_LIMITS_DEFAULTS.retry,
  })

/** The closed reasons a held deadline can expire with. */
export const ECONOMIC_DEADLINE_OUTCOMES = [
  'deadline-expired',
  'attempt-ceiling-reached',
  'unit-budget-exhausted',
  'interrupted',
] as const

export type EconomicDeadlineOutcomeCode = (typeof ECONOMIC_DEADLINE_OUTCOMES)[number]

const DEADLINE_OUTCOME_REASONS: Readonly<Record<EconomicDeadlineOutcomeCode, string>> = Object.freeze({
  'deadline-expired': 'That had a deadline, and the deadline passed.',
  'attempt-ceiling-reached': 'That has been tried as many times as it is allowed.',
  'unit-budget-exhausted': 'There was nothing left to spend on that.',
  interrupted: 'That was interrupted, and a process that died cannot prove it finished.',
})

export function deadlineOutcomeReason(code: EconomicDeadlineOutcomeCode): string {
  return DEADLINE_OUTCOME_REASONS[code]
}

/**
 * Resolve an absolute deadline.
 *
 * `limitMs` is clamped to the code-owned maximum for the kind, so a caller asking for a
 * year gets the ceiling rather than the year — and a caller asking for zero gets zero,
 * which means "already expired", which is a legitimate and occasionally necessary
 * answer.
 */
export function resolveEconomicDeadline(
  type: EconomicDeadlineType,
  startedAt: string,
  limitMs: number,
): EconomicDeadline {
  const ceiling = ECONOMIC_DEADLINE_DEFAULT_MS[type]
  const asked = Number.isFinite(limitMs) && limitMs > 0 ? Math.floor(limitMs) : 0
  const span = asked < ceiling ? asked : ceiling
  const base = Date.parse(startedAt)
  const start = Number.isFinite(base) ? base : 0
  return {
    type,
    expiresAt: new Date(start + span).toISOString(),
    reason: `${type} deadline`,
  }
}

/**
 * Rebuild a deadline from a journal payload.
 *
 * The absolute instant the writer recorded wins, and only falls back to
 * `recordedAt + the default` when the entry carried none — for the same reason
 * `lifeloop/state.ts` does it: a retry backoff is minutes long, and re-deriving it
 * from an hour-long stage default would turn a two-second backoff into an hour of not
 * trying.
 */
export function rebuildEconomicDeadline(
  type: EconomicDeadlineType | null,
  recordedAt: string | null,
  absolute: unknown,
): EconomicDeadline | null {
  if (type === null) return null
  if (typeof absolute === 'string' && Number.isFinite(Date.parse(absolute))) {
    return { type, expiresAt: new Date(Date.parse(absolute)).toISOString(), reason: `${type} deadline` }
  }
  const base = Date.parse(recordedAt ?? '')
  const start = Number.isFinite(base) ? base : 0
  return {
    type,
    expiresAt: new Date(start + ECONOMIC_DEADLINE_DEFAULT_MS[type]).toISOString(),
    reason: `${type} deadline`,
  }
}

/** Whole milliseconds left. Zero when there is no hold; never negative. */
export function remainingMs(deadline: EconomicDeadline, now: string): number {
  const expiresAt = Date.parse(deadline.expiresAt)
  const current = Date.parse(now)
  if (!Number.isFinite(expiresAt) || !Number.isFinite(current)) return 0
  const left = expiresAt - current
  return left > 0 ? left : 0
}

/**
 * Has the deadline passed?
 *
 * A malformed instant reads as **expired**, not as "a long time from now". That is the
 * direction that fails closed: a deadline nobody can parse must not become a hold that
 * never lifts.
 */
export function isEconomicDeadlineExpired(deadline: EconomicDeadline, now: string): boolean {
  const expiresAt = Date.parse(deadline.expiresAt)
  const current = Date.parse(now)
  if (!Number.isFinite(expiresAt) || !Number.isFinite(current)) return true
  return current >= expiresAt
}

export interface EconomicRetryCeiling {
  readonly maxAttempts: number
  readonly currentAttempt: number
  readonly baseBackoffMs: number
  readonly maxBackoffMs: number
  readonly jitterMs: number
}

/** The code-owned ceiling, with the count read from durable state. */
export function defaultRetryCeiling(attempt: number, limits: EconomicLimits): EconomicRetryCeiling {
  return {
    maxAttempts: limits.maxRetryCeiling,
    currentAttempt: Math.min(Math.max(0, Math.floor(attempt)), limits.maxRetryCeiling),
    baseBackoffMs: limits.baseBackoffMs,
    maxBackoffMs: limits.maxBackoffMs,
    jitterMs: limits.jitterMs,
  }
}

/** Narrow a ceiling. Same rule as the limits clamp: only ever smaller. */
export function narrowRetryCeiling(
  ceiling: EconomicRetryCeiling,
  maxAttempts: number,
): EconomicRetryCeiling {
  const asked =
    typeof maxAttempts === 'number' && Number.isFinite(maxAttempts) && maxAttempts > 0
      ? Math.floor(maxAttempts)
      : ceiling.maxAttempts
  return { ...ceiling, maxAttempts: Math.min(asked, ceiling.maxAttempts) }
}

export function retryCeilingReached(ceiling: EconomicRetryCeiling): boolean {
  return ceiling.currentAttempt >= ceiling.maxAttempts
}

/**
 * Exponential backoff with a clamp.
 *
 * `base * 2^(attempt-1)`, capped, then jitter added and capped again. Pure arithmetic
 * on the attempt number — no clock, no randomness — so a retry schedule is a function
 * of the journal and a restart cannot re-roll it.
 */
export function backoffDelayMs(attempt: number, ceiling: EconomicRetryCeiling): number {
  const exponent = Math.max(0, Math.floor(attempt) - 1)
  const raw = ceiling.baseBackoffMs * Math.pow(2, exponent)
  const capped = raw > ceiling.maxBackoffMs ? ceiling.maxBackoffMs : raw
  return Math.floor(capped)
}

/**
 * The deterministic jitter sample.
 *
 * Derived from a reference and the attempt number rather than drawn from a random
 * source, which keeps the runtime a function of the journal: two runs over one journal
 * produce the same backoff. It is still jitter, because the reference differs per
 * attempt and two experiments retrying the same work do not back off in lockstep.
 */
export function deterministicJitterMs(reference: string, attempt: number, ceiling: { readonly jitterMs: number }): number {
  let hash = 0x811c9dc5
  const material = `${reference}:${attempt}`
  for (let index = 0; index < material.length; index += 1) {
    hash ^= material.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % (ceiling.jitterMs + 1)
}

export type EconomicRetryDecision =
  | { readonly retry: true; readonly delayMs: number; readonly reason: string }
  | { readonly retry: false; readonly code: 'attempt-ceiling-reached'; readonly reason: string }

/**
 * Whether one failed unit of work may be tried again.
 *
 * Answered by a counter against a code-owned ceiling and by nothing else. A failing
 * step cannot talk the subsystem into another attempt, and because the attempt count is
 * journaled, the counter survives a restart — so work that fails every time is tried
 * three times *in total*, not three times per launch.
 */
export function nextRetry(ceiling: EconomicRetryCeiling, jitterMs: number): EconomicRetryDecision {
  if (retryCeilingReached(ceiling)) {
    return { retry: false, code: 'attempt-ceiling-reached', reason: DEADLINE_OUTCOME_REASONS['attempt-ceiling-reached'] }
  }
  const delay = backoffDelayMs(ceiling.currentAttempt + 1, ceiling) + Math.max(0, Math.floor(jitterMs))
  const clamped = delay > ceiling.maxBackoffMs ? ceiling.maxBackoffMs : delay
  return {
    retry: true,
    delayMs: clamped,
    reason: 'That failed, and there are attempts left, so it will be tried again after a pause.',
  }
}

/**
 * How many units one experiment may still spend.
 *
 * Derived from the ceilings rather than stored, so a lowered ceiling lowers the
 * allowance with it. Never expressed in money, because there is none.
 */
export function unitAllowanceFor(limits: EconomicLimits, stages: number): number {
  const total = totalUnitAllowance(limits)
  if (!Number.isFinite(stages) || stages <= 0) return total
  return Math.floor(total / Math.max(1, Math.floor(stages)))
}