import type { ResilienceLimitsLike } from './types'

/**
 * Deadline arithmetic for resilience.
 *
 * Every deadline is absolute, never relative to the process that created it.
 * A relative deadline is extended every time the process restarts, which turns
 * a 24-hour recovery ceiling into "24 hours per attempt, forever" for anything
 * that can crash the app.
 */

/**
 * The closed deadline types.
 */
export const RESILIENCE_DEADLINE_TYPES = [
  'recovery',
  'repair',
  'backup',
  'restore',
  'degraded-mode',
] as const

export type ResilienceDeadlineType = (typeof RESILIENCE_DEADLINE_TYPES)[number]

export function isResilienceDeadlineType(value: unknown): value is ResilienceDeadlineType {
  return (
    typeof value === 'string' && (RESILIENCE_DEADLINE_TYPES as readonly string[]).includes(value)
  )
}

/**
 * A deadline. Absolute, never relative.
 */
export interface ResilienceDeadline {
  readonly type: ResilienceDeadlineType
  readonly expiresAt: string
  readonly reason: string
}

/**
 * The closed reasons a deadline can expire with.
 */
export type ResilienceDeadlineOutcomeCode =
  | 'deadline-expired'
  | 'attempt-ceiling-reached'
  | 'interrupted'

export interface ResilienceDeadlineOutcome {
  readonly ok: boolean
  readonly code: ResilienceDeadlineOutcomeCode | null
  readonly reason: string
}

/**
 * Whether a deadline has expired at the given instant.
 */
export function isResilienceDeadlineExpired(deadline: ResilienceDeadline, now: string): boolean {
  return Date.parse(deadline.expiresAt) <= Date.parse(now)
}

/**
 * How many milliseconds remain before a deadline.
 */
export function remainingMs(deadline: ResilienceDeadline, now: string): number {
  return Date.parse(deadline.expiresAt) - Date.parse(now)
}

/**
 * The closed deadline outcome codes.
 */
export const RESILIENCE_DEADLINE_OUTCOME_CODES = [
  'deadline-expired',
  'attempt-ceiling-reached',
  'interrupted',
] as const

export type ResilienceDeadlineOutcomeCodeValue =
  (typeof RESILIENCE_DEADLINE_OUTCOME_CODES)[number]

/**
 * Why each deadline outcome exists, as a closed mapping.
 */
export function deadlineOutcomeReason(code: ResilienceDeadlineOutcomeCode): string {
  switch (code) {
    case 'deadline-expired':
      return 'The deadline for this operation has passed.'
    case 'attempt-ceiling-reached':
      return 'The maximum number of attempts has been reached.'
    case 'interrupted':
      return 'The operation was interrupted by STOP ALL or an owner command.'
  }
}

/**
 * A retry ceiling.
 */
export interface ResilienceRetryCeiling {
  readonly maxAttempts: number
  readonly currentAttempt: number
  readonly baseBackoffMs: number
  readonly maxBackoffMs: number
  readonly jitterMs: number
}

/**
 * The default retry ceiling from limits.
 */
export function defaultRetryCeiling(
  currentAttempt: number,
  limits: ResilienceLimitsLike,
): ResilienceRetryCeiling {
  return {
    maxAttempts: limits.maxRetryCeiling,
    currentAttempt,
    baseBackoffMs: limits.baseBackoffMs,
    maxBackoffMs: limits.maxBackoffMs,
    jitterMs: limits.jitterMs,
  }
}

/**
 * Narrow a retry ceiling against the limits.
 */
export function narrowRetryCeiling(
  ceiling: ResilienceRetryCeiling,
  maxAttempts: number,
): ResilienceRetryCeiling {
  return {
    ...ceiling,
    maxAttempts: Math.min(ceiling.maxAttempts, maxAttempts),
  }
}

/**
 * Whether the retry ceiling has been reached.
 */
export function retryCeilingReached(ceiling: ResilienceRetryCeiling): boolean {
  return ceiling.currentAttempt >= ceiling.maxAttempts
}

/**
 * Compute the backoff delay for a given attempt.
 *
 * Deterministic: same attempt + same ceiling = same delay. No randomness.
 */
export function backoffDelayMs(attempt: number, ceiling: ResilienceRetryCeiling): number {
  if (attempt <= 0) return 0
  const exponential = ceiling.baseBackoffMs * Math.pow(2, attempt - 1)
  const jitter = deterministicJitterMs(attempt, ceiling.jitterMs)
  return Math.min(exponential + jitter, ceiling.maxBackoffMs)
}

/**
 * Deterministic jitter: a pure function of the attempt number.
 */
export function deterministicJitterMs(attempt: number, jitterMs: number): number {
  if (jitterMs <= 0) return 0
  // Simple deterministic hash of the attempt number
  const hash = ((attempt * 2654435761) >>> 0) % 1000
  return Math.floor((hash / 1000) * jitterMs)
}

/**
 * Rebuild a deadline from a type and duration.
 */
export function rebuildResilienceDeadline(
  type: ResilienceDeadlineType,
  durationMs: number,
  now: string,
  reason: string,
): ResilienceDeadline {
  const expiresAt = new Date(Date.parse(now) + durationMs).toISOString()
  return { type, expiresAt, reason }
}

/**
 * Resolve a deadline outcome.
 */
export function resolveResilienceDeadline(
  deadline: ResilienceDeadline,
  now: string,
  attemptCeilingReached: boolean,
  interrupted: boolean,
): ResilienceDeadlineOutcome {
  if (interrupted) {
    return { ok: false, code: 'interrupted', reason: deadlineOutcomeReason('interrupted') }
  }
  if (attemptCeilingReached) {
    return {
      ok: false,
      code: 'attempt-ceiling-reached',
      reason: deadlineOutcomeReason('attempt-ceiling-reached'),
    }
  }
  if (isResilienceDeadlineExpired(deadline, now)) {
    return { ok: false, code: 'deadline-expired', reason: deadlineOutcomeReason('deadline-expired') }
  }
  return { ok: true, code: null, reason: 'The deadline has not expired.' }
}
