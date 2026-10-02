/**
 * THE HANDS LIFECYCLE — enforcing Action → Observation → Verification.
 *
 * This file is the state machine that governs how an action moves through its
 * lifecycle. It is pure and deterministic: the same inputs always produce the
 * same outputs, with no clock, no I/O and no randomness.
 *
 * ## The lifecycle
 *
 * ```
 *   Action (running) → Observation (recorded) → Verification (requested → passed/failed)
 * ```
 *
 * An action starts as `running`. It produces zero or more observations. A
 * verification is requested against the action and its observations, and the
 * verifier returns a verdict. The action is *verified* only when a verification
 * result with `status: 'passed'` exists.
 *
 * ## What is deliberately enforced
 *
 * - **An action cannot be verified without a verification result.** There is no
 *   function in this module that marks an action as verified. The only way to
 *   represent a verified action is through a `HandsVerificationResult` with
 *   `status: 'passed'`.
 * - **An observation cannot be recorded against a terminal action.** Once an
 *   action is completed, failed, cancelled or timed out, no further observations
 *   may be recorded against it.
 * - **A verification cannot be requested without an action result.** A verifier
 *   needs something to verify.
 * - **Terminal states are terminal.** A completed, failed, cancelled or timed-out
 *   action cannot transition to any other state.
 */

import type { HandsActionResult, HandsObservationRecord, HandsVerificationResult } from './contract'
import {
  canTransitionHandsAction,
  canTransitionHandsVerification,
  isTerminalHandsActionStatus,
  isTerminalHandsVerificationStatus,
  type HandsActionStatus,
  type HandsVerificationStatus,
} from './types'

/**
 * The lifecycle state of one action.
 *
 * A pure data structure that tracks where an action is in its lifecycle. It is
 * derived from the action result, observations and verification results, and
 * is the single source of truth for "what is this action's current state".
 */
export interface HandsLifecycleState {
  readonly actionId: string
  readonly actionStatus: HandsActionStatus
  readonly observationCount: number
  readonly verificationStatus: HandsVerificationStatus | null
  /** True only when a verification result with `status: 'passed'` exists. */
  readonly verified: boolean
}

/**
 * Compute the lifecycle state of an action.
 *
 * A pure function over the action result, observations and verification results.
 * The same inputs always produce the same output.
 *
 * **It is impossible for this function to return `verified: true` without a
 * verification result with `status: 'passed'`.** The `verified` field is derived
 * solely from the verification results, never from the action status or the
 * observation count.
 */
export function handsLifecycleState(
  actionResult: HandsActionResult,
  observations: readonly HandsObservationRecord[],
  verificationResults: readonly HandsVerificationResult[],
): HandsLifecycleState {
  const verificationStatus = verificationResults.length > 0
    ? verificationResults[verificationResults.length - 1]!.status
    : null

  const verified = verificationResults.some((result) => result.status === 'passed')

  return {
    actionId: actionResult.actionId,
    actionStatus: actionResult.status,
    observationCount: observations.length,
    verificationStatus,
    verified,
  }
}

/**
 * Whether an observation may be recorded against an action.
 *
 * An observation may be recorded only when the action is `running`. Once the
 * action reaches a terminal state, no further observations may be recorded.
 */
export function canRecordObservation(actionStatus: HandsActionStatus): boolean {
  return actionStatus === 'running'
}

/**
 * Whether a verification may be requested for an action.
 *
 * A verification may be requested only when the action has reached a terminal
 * state and at least one observation has been recorded. A verifier needs
 * something to verify.
 */
export function canRequestVerification(
  actionStatus: HandsActionStatus,
  observationCount: number,
): boolean {
  return isTerminalHandsActionStatus(actionStatus) && observationCount > 0
}

/**
 * Whether an action transition is valid.
 *
 * Delegates to the state machine table in `types.ts`. A transition that is not
 * in the table is refused.
 */
export function isValidActionTransition(from: HandsActionStatus, to: HandsActionStatus): boolean {
  return canTransitionHandsAction(from, to)
}

/**
 * Whether a verification transition is valid.
 *
 * Delegates to the state machine table in `types.ts`. A transition that is not
 * in the table is refused.
 */
export function isValidVerificationTransition(
  from: HandsVerificationStatus,
  to: HandsVerificationStatus,
): boolean {
  return canTransitionHandsVerification(from, to)
}

/**
 * Whether an action is in a terminal state.
 */
export function isActionTerminal(status: HandsActionStatus): boolean {
  return isTerminalHandsActionStatus(status)
}

/**
 * Whether a verification is in a terminal state.
 */
export function isVerificationTerminal(status: HandsVerificationStatus): boolean {
  return isTerminalHandsVerificationStatus(status)
}

/**
 * The terminal outcome of an action, if it has one.
 *
 * A discriminated union that makes it impossible to represent a verified action
 * without a verification result. The `verified` variant carries the verification
 * result that established it; the `unverified` variant carries the reason it
 * was not verified.
 */
export type HandsTerminalOutcome =
  | {
      readonly kind: 'verified'
      readonly actionId: string
      readonly verification: HandsVerificationResult
    }
  | {
      readonly kind: 'unverified'
      readonly actionId: string
      readonly reason: string
    }

/**
 * Determine the terminal outcome of an action.
 *
 * **It is impossible for this function to return `kind: 'verified'` without a
 * verification result with `status: 'passed'`.** The function checks the
 * verification results, not the action status.
 */
export function handsTerminalOutcome(
  actionResult: HandsActionResult,
  verificationResults: readonly HandsVerificationResult[],
): HandsTerminalOutcome {
  const passed = verificationResults.find((result) => result.status === 'passed')
  if (passed) {
    return { kind: 'verified', actionId: actionResult.actionId, verification: passed }
  }

  if (actionResult.status === 'completed') {
    return { kind: 'unverified', actionId: actionResult.actionId, reason: 'the action completed but no verification passed' }
  }

  return { kind: 'unverified', actionId: actionResult.actionId, reason: `the action ${actionResult.status}` }
}
