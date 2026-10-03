import {
  LIFE_LOOP_LIMITS,
  type Deadline,
  type DeadlineOutcome,
  type DeadlineType,
  type LifeLoopLimits,
  type LifeLoopLimitRequest,
  type RetryCeiling,
} from './types'

/**
 * Deadlines, retry ceilings and backoff.
 *
 * All of it code-owned, all of it deterministic, all of it absolute.
 *
 * Two properties do the real work here:
 *
 *   - **Deadlines are absolute instants.** A deadline computed from "now" at the
 *     moment it is checked would be extended by every restart, and a 24-hour
 *     verification ceiling that restarts with the app is not a ceiling.
 *
 *   - **Bounds can only ever narrow.** `narrowLifeLoopLimits` clamps a caller's
 *     numbers *down* to the frozen ceilings and refuses to represent anything
 *     wider. There is no code path — configuration, payload or grant — that
 *     raises one of these, so "bounded everywhere" is a property of the module
 *     rather than of a reviewer's diligence.
 */

/** How long each kind of wait may last before it counts as a failure. */
export const DEADLINE_DEFAULT_MS: Readonly<Record<DeadlineType, number>> = Object.freeze({
  // A verification is checking something in the world, so it gets a day.
  verification: 24 * 60 * 60 * 1_000,
  // An approval is a person who has not answered yet. It expires; it does not hang.
  approval: 24 * 60 * 60 * 1_000,
  // The longest Freya will hold a condition open. Also the schedule horizon.
  wait: 30 * 24 * 60 * 60 * 1_000,
  // One bounded action.
  action: 15 * 60_000,
})

const DEADLINE_REASONS: Readonly<Record<DeadlineType, string>> = Object.freeze({
  verification: 'how long Freya may check whether something actually happened',
  approval: 'how long an unanswered request for the owner stays open',
  wait: 'how long Freya will wait for a condition before giving up on it',
  action: 'how long one bounded action may run',
})

const OUTCOME_REASONS: Readonly<Record<string, string>> = Object.freeze({
  'deadline-expired': 'This had a deadline, and the deadline passed.',
  'limit-attempts': 'This had been tried the maximum number of times.',
  'limit-actions': 'This had done as much as it is allowed to do.',
  'limit-duration': 'This had taken as long as it is allowed to take.',
  interrupted: 'This was interrupted before it finished.',
})

/** The frozen sentence for an outcome code. Never interpolates the event. */
export function deadlineOutcomeReason(code: string): string {
  return OUTCOME_REASONS[code] ?? 'This stopped for a recorded reason.'
}

function toInstant(value: Date | string): number {
  const ms = typeof value === 'string' ? Date.parse(value) : value.getTime()
  return Number.isFinite(ms) ? ms : Number.NaN
}

/**
 * Narrow a partial set of ceilings. Clamps downward; never upward.
 *
 * Anything non-numeric, non-finite or non-positive is treated as absent rather
 * than as a request, because the conservative reading of a malformed limit is the
 * frozen default and the liberal reading is a bound nobody chose.
 */
export function narrowLifeLoopLimits(partial?: LifeLoopLimitRequest): LifeLoopLimits {
  if (partial === undefined || partial === null) return LIFE_LOOP_LIMITS
  const narrowed: Record<string, number> = { ...LIFE_LOOP_LIMITS }
  for (const [name, ceiling] of Object.entries(LIFE_LOOP_LIMITS)) {
    const asked = (partial as Record<string, unknown>)[name]
    if (typeof asked !== 'number' || !Number.isFinite(asked) || asked <= 0) continue
    narrowed[name] = Math.min(Math.floor(asked), ceiling)
  }
  return Object.freeze(narrowed) as LifeLoopLimits
}

/**
 * Build an absolute deadline.
 *
 * `from` is the instant the wait began — not `now`. That is what makes the
 * deadline survive a restart unchanged.
 */
export function resolveDeadline(
  type: DeadlineType,
  from: Date | string,
  limits: LifeLoopLimits = LIFE_LOOP_LIMITS,
): Deadline {
  const started = toInstant(from)
  // An unusable start instant is not a licence to wait forever. The deadline
  // falls back to "already expired", which the caller must handle as a failure,
  // and which cannot be the safe-looking "in the year 10000".
  //
  // `maxWaitMs` is applied on top of the default so a caller who has narrowed the
  // limits gets the narrower wait; the clamp can only ever shorten.
  const span = Math.min(DEADLINE_DEFAULT_MS[type], limits.maxWaitMs)
  const expiresAtMs = Number.isFinite(started) ? started + span : 0
  return {
    type,
    expiresAt: new Date(expiresAtMs).toISOString(),
    reason: DEADLINE_REASONS[type],
  }
}

/** Milliseconds left, or zero once expired. Never negative, never infinite. */
export function remainingMs(deadline: Deadline, now: Date | string): number {
  const expiresAt = toInstant(deadline.expiresAt)
  const current = toInstant(now)
  if (!Number.isFinite(expiresAt) || !Number.isFinite(current)) return 0
  return Math.max(0, expiresAt - current)
}

/** Has this deadline passed? A malformed deadline counts as passed. */
export function isExpired(deadline: Deadline, now: Date | string): boolean {
  return remainingMs(deadline, now) === 0
}

/**
 * Enforce a deadline and the per-iteration ceilings together.
 *
 * The order matters: the deadline first, because a thing that ran out of time
 * failed on time rather than on its count. Returns `ok: true` with a null code
 * when nothing objected.
 */
export function enforceDeadline(
  deadline: Deadline | null,
  now: Date | string,
  progress?: {
    readonly attempts: number
    readonly maxAttempts: number
    readonly actions?: number
    readonly maxActions?: number
    readonly durationMs?: number
    readonly maxDurationMs?: number
  },
): DeadlineOutcome {
  if (deadline !== null && isExpired(deadline, now)) {
    return { ok: false, code: 'deadline-expired', reason: deadlineOutcomeReason('deadline-expired') }
  }
  if (progress === undefined) return { ok: true, code: null, reason: '' }
  if (progress.attempts >= progress.maxAttempts) {
    return { ok: false, code: 'limit-attempts', reason: deadlineOutcomeReason('limit-attempts') }
  }
  if (
    progress.actions !== undefined &&
    progress.maxActions !== undefined &&
    progress.actions >= progress.maxActions
  ) {
    return { ok: false, code: 'limit-actions', reason: deadlineOutcomeReason('limit-actions') }
  }
  if (
    progress.durationMs !== undefined &&
    progress.maxDurationMs !== undefined &&
    progress.durationMs >= progress.maxDurationMs
  ) {
    return { ok: false, code: 'limit-duration', reason: deadlineOutcomeReason('limit-duration') }
  }
  return { ok: true, code: null, reason: '' }
}

/* --------------------------------------------------------------- backoff */

/** The default retry ceiling, from the frozen limits. */
export function defaultRetryCeiling(limits: LifeLoopLimits = LIFE_LOOP_LIMITS): RetryCeiling {
  return {
    maxAttempts: limits.maxAttemptsPerUnit,
    currentAttempt: 0,
    baseBackoffMs: limits.baseBackoffMs,
    maxBackoffMs: limits.maxBackoffMs,
    jitterMs: limits.jitterMs,
  }
}

/** A ceiling that can only be tightened. */
export function narrowRetryCeiling(
  ceiling: RetryCeiling,
  partial: Partial<RetryCeiling>,
): RetryCeiling {
  const clampDown = (asked: unknown, ceilingValue: number): number => {
    if (typeof asked !== 'number' || !Number.isFinite(asked) || asked < 0) return ceilingValue
    return Math.min(Math.floor(asked), ceilingValue)
  }
  return {
    maxAttempts: Math.max(1, clampDown(partial.maxAttempts, ceiling.maxAttempts)),
    currentAttempt: Math.max(0, Math.floor(ceiling.currentAttempt)),
    baseBackoffMs: Math.max(1, clampDown(partial.baseBackoffMs, ceiling.baseBackoffMs)),
    maxBackoffMs: Math.max(1, clampDown(partial.maxBackoffMs, ceiling.maxBackoffMs)),
    jitterMs: clampDown(partial.jitterMs, ceiling.jitterMs),
  }
}

/** Has the retry ceiling been reached? */
export function retryCeilingReached(ceiling: RetryCeiling): boolean {
  return ceiling.currentAttempt >= ceiling.maxAttempts
}

/**
 * Exponential backoff with jitter, hard-capped.
 *
 *   delay = min(base * 2^(attempt-1) + jitter, maxBackoff)
 *
 * Three ways this cannot be made to grow without bound, all of which matter
 * because an attacker who controls the number of retries also controls the
 * exponent:
 *
 *   - the exponent is clamped, so a caller cannot ask for attempt 1,000,000 and
 *     get `Infinity`;
 *   - the jitter is clamped into `[0, jitterMs]` *before* it is added, so a
 *     caller passing `Number.MAX_SAFE_INTEGER` cannot inflate the wait;
 *   - and the sum is clamped to `maxBackoffMs` last, so even a caller who got
 *     both of the above wrong still cannot exceed five minutes.
 *
 * The jitter is an injected sample rather than a call to `Math.random`, so the
 * whole function is pure and the tests are exact.
 */
export function backoffDelayMs(
  attempt: number,
  jitterSample: number,
  ceiling: RetryCeiling = defaultRetryCeiling(),
): number {
  const cappedAttempt = Math.min(Math.max(1, Math.floor(attempt)), 31)
  const exponential = ceiling.baseBackoffMs * 2 ** (cappedAttempt - 1)
  const jitter =
    Number.isFinite(jitterSample) && jitterSample > 0
      ? Math.min(Math.floor(jitterSample), ceiling.jitterMs)
      : 0
  return Math.min(exponential + jitter, ceiling.maxBackoffMs)
}

/**
 * The next retry decision, if there is one.
 *
 * `null` means *do not retry*, and it is the answer whenever the ceiling is
 * reached. That is the important half of the function: "should we try again" is
 * answered by a counter, never by a judgement, so a failing unit of work cannot
 * talk the loop into another attempt.
 */
export function nextRetry(
  ceiling: RetryCeiling,
  jitterSample: number,
): { readonly retry: false; readonly code: 'limit-attempts'; readonly reason: string } | {
  readonly retry: true
  readonly attempt: number
  readonly delayMs: number
  readonly ceiling: RetryCeiling
} {
  if (retryCeilingReached(ceiling)) {
    return { retry: false, code: 'limit-attempts', reason: deadlineOutcomeReason('limit-attempts') }
  }
  const attempt = ceiling.currentAttempt + 1
  return {
    retry: true,
    attempt,
    delayMs: backoffDelayMs(attempt, jitterSample, ceiling),
    ceiling: { ...ceiling, currentAttempt: attempt },
  }
}