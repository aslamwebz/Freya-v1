import type { EventFabric } from '../events/fabric'
import type { PrincipalId } from '../../shared/contracts/identity'
import {
  DEFAULT_GOAL_LIMITS,
  GOAL_REASONS,
  type CheckpointOutcome,
  type GoalReason,
  type GoalVerificationContext,
  type GoalVerifier,
} from './types'

/**
 * CHECKPOINT VERIFICATION AND RECOVERY.
 *
 * Every long-horizon goal checkpoint must be verified before the goal can
 * continue. Verification is bounded, deterministic and journaled. Recovery
 * from verification failure is explicit and bounded.
 *
 * ## Verification is bounded
 *
 * Every verification has a deadline (`verificationDeadlineMs`, default 24h). A
 * verification that exceeds the deadline is `timeout`, not `passed`: an
 * unbounded verification is a hidden loop with a verifier's name on it.
 *
 * ## Retry ceiling
 *
 * A failed checkpoint may retry up to `maxRetryCeiling` (default 3) times. At
 * the ceiling the checkpoint is `failed` with `retry_ceiling_reached` and the
 * goal is failed. There is no goal retry: a failed goal stays failed, and the
 * owner creates a new goal to continue the work.
 *
 * ## Backoff is bounded
 *
 * Exponential backoff with jitter, capped at `maxBackoffMs` (default 5 min):
 *
 * ```
 * delay = min(baseBackoffMs * 2^attempt + jitter(0..1000), maxBackoffMs)
 * ```
 *
 * The cap is the point. An unbounded exponential backoff is a quiet way to
 * wait forever.
 *
 * ## No authority
 *
 * A verified checkpoint does not bypass Guard, bypass Governor, exceed a
 * budget, override STOP ALL or skip an approval. Verification determines
 * whether a goal *can* continue; it does not change what the subsystem *may*
 * do.
 */

/** What the verification engine needs from the goal engine, and nothing more. */
export interface VerificationGoalPort {
  /** Journal a checkpoint outcome. Returns the outcome that was recorded. */
  recordCheckpointOutcome(
    goalId: string,
    checkpointId: string,
    outcome: CheckpointOutcome,
    reason: GoalReason | null,
    attempts: number,
  ): Promise<void>
  /** The checkpoint's current attempt count. */
  checkpointAttempts(goalId: string, checkpointId: string): number
  /** The goal's current retry count. */
  goalRetryCount(goalId: string): number
}

export interface VerificationEngineOptions {
  fabric: EventFabric
  goals: VerificationGoalPort
  principalId: PrincipalId
  now?: () => Date
  stopAll?: () => boolean
  /**
   * How long one verification may run. Defaults to the code-owned ceiling.
   * Injectable so tests can exercise the timeout path without waiting 24 hours.
   */
  verificationDeadlineMs?: number
}

export interface VerificationResult {
  readonly outcome: CheckpointOutcome
  readonly reason: GoalReason | null
  readonly attempts: number
  /** Milliseconds until the next retry, when the outcome allows one. */
  readonly retryAfterMs: number | null
}

/**
 * Compute the backoff delay before a retry.
 *
 * Pure and bounded: `min(base * 2^attempt + jitter, max)`. The jitter is
 * injected (never read from a wall clock or a random source inside the
 * formula) so the function is deterministic and testable.
 */
export function computeBackoff(
  attempt: number,
  jitterMs: number,
  baseBackoffMs: number = DEFAULT_GOAL_LIMITS.baseBackoffMs,
  maxBackoffMs: number = DEFAULT_GOAL_LIMITS.maxBackoffMs,
): number {
  const exponential = baseBackoffMs * 2 ** Math.max(0, attempt)
  const jittered = exponential + Math.max(0, Math.min(jitterMs, DEFAULT_GOAL_LIMITS.baseBackoffMs))
  return Math.min(jittered, maxBackoffMs)
}

/**
 * Whether a checkpoint may retry.
 *
 * The attempt count includes the attempt that just failed, so a checkpoint with
 * `maxRetryCeiling: 3` may be attempted 3 times total: attempts 1, 2 and 3, and
 * the failure of attempt 3 is the ceiling.
 */
export function canRetry(attempts: number, maxRetryCeiling: number = DEFAULT_GOAL_LIMITS.maxRetryCeiling): boolean {
  return attempts < maxRetryCeiling
}

export class VerificationEngine {
  private closed = false

  constructor(private readonly options: VerificationEngineOptions) {}

  async open(): Promise<void> {}

  async close(): Promise<void> {
    this.closed = true
  }

  /**
   * Verify one checkpoint.
   *
   * The verifier is deterministic and code-owned. The verification runs under
   * the goal's verification deadline; exceeding it is a `timeout`, never a
   * `passed`. The outcome is journaled through the goal engine, and the retry
   * decision is returned rather than acted on: the verification engine does not
   * retry by itself, because a retry that schedules itself is a loop.
   */
  async verify(
    goalId: string,
    checkpointId: string,
    verifier: GoalVerifier,
    signal: AbortSignal,
  ): Promise<VerificationResult> {
    if (this.closed) {
      return { outcome: 'cancelled', reason: GOAL_REASONS.shutdown, attempts: 0, retryAfterMs: null }
    }
    if (this.stopped()) {
      return { outcome: 'cancelled', reason: GOAL_REASONS.stop_all, attempts: 0, retryAfterMs: null }
    }

    const attempts = this.options.goals.checkpointAttempts(goalId, checkpointId)
    const context: GoalVerificationContext = {
      goalId,
      state: 'active',
      requiredCheckpointIds: [checkpointId],
      checkpointStatuses: { [checkpointId]: 'in-progress' },
    }

    const deadlineMs = this.options.verificationDeadlineMs ?? DEFAULT_GOAL_LIMITS.verificationDeadlineMs

    let outcome: CheckpointOutcome
    // Assigned on every path below — a passed verification has no reason to
    // record, so the initial value would never be read.
    let reason: GoalReason | null

    try {
      const result = await runWithDeadline(verifier, context, signal, deadlineMs)
      if (signal.aborted) {
        outcome = 'cancelled'
        reason = GOAL_REASONS.shutdown
      } else if (result.established) {
        outcome = 'passed'
        reason = null
      } else {
        outcome = 'not_established'
        reason = result.reason
      }
    } catch (error) {
      if (signal.aborted) {
        outcome = 'cancelled'
        reason = GOAL_REASONS.shutdown
      } else if (this.isDeadlineError(error)) {
        outcome = 'timeout'
        reason = GOAL_REASONS.verification_timeout
      } else {
        outcome = 'not_established'
        reason = GOAL_REASONS.verification_not_established
      }
      console.error('[freya.core] checkpoint verification failed', this.describe(error))
    }

    const recordedAttempts = attempts + 1
    await this.options.goals.recordCheckpointOutcome(goalId, checkpointId, outcome, reason, recordedAttempts)

    const retryAfterMs =
      outcome === 'not_established' && canRetry(recordedAttempts) ? computeBackoff(recordedAttempts, 0) : null

    return { outcome, reason, attempts: recordedAttempts, retryAfterMs }
  }

  private stopped(): boolean {
    return this.options.stopAll?.() ?? false
  }

  private isDeadlineError(error: unknown): boolean {
    return error instanceof Error && error.message === VERIFICATION_DEADLINE_EXCEEDED
  }

  private describe(error: unknown): string {
    if (error instanceof Error) return error.message
    return String(error)
  }
}

/** The sentinel error a deadline rejection carries. */
const VERIFICATION_DEADLINE_EXCEEDED = 'verification deadline exceeded'

/**
 * Run a verifier under a deadline.
 *
 * The deadline is enforced with a timeout that rejects. A verifier that
 * ignores its AbortSignal is still bounded: the deadline rejects the promise
 * even if the verifier keeps running, and the outcome is `timeout`.
 */
async function runWithDeadline(
  verifier: GoalVerifier,
  context: GoalVerificationContext,
  signal: AbortSignal,
  deadlineMs: number,
): Promise<{ established: boolean; reason: GoalReason }> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
      reject(new Error(VERIFICATION_DEADLINE_EXCEEDED))
    }, deadlineMs)
    timer.unref?.()

    const onAbort = () => controller.abort()
    if (signal.aborted) {
      controller.abort()
    } else {
      signal.addEventListener('abort', onAbort, { once: true })
    }

    verifier
      .verify(context, controller.signal)
      .then(
        (result) => {
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          resolve({ established: result.established, reason: result.reason })
        },
        (error) => {
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      )
  })
}
