import { DEVICE_HANDS_LIMITS } from './types'
import { unresolvedActions, type DeviceHandsState } from './state'

/**
 * Restart and recovery: what this phase is willing to say about an action whose
 * process ended before it settled.
 *
 * ## The one honest answer
 *
 * An action that was `running` when the process ended is **unknown**. It might have
 * finished, it might have been halfway, it might have never started. This phase cannot
 * tell, so it does not guess in either direction:
 *
 *   - it is never reported as `completed`, because "it completed" is a claim about the
 *     past that nothing on the record supports;
 *   - it is not reported as `failed` either, because "it failed" is *also* a claim, and
 *     a claim that a half-finished download was a failed download is how a duplicate
 *     gets created on retry.
 *
 * It is reported as `interrupted`, is treated as **not done** everywhere downstream,
 * and is journalled as `hands.action.interrupted` at the next `open()` so the fact
 * survives the process rather than living in a comment. A retry is a new action id with
 * a new approval — never a re-run of the old one, which is why `interrupted` is a
 * refusal of the *id* as much as of the action.
 *
 * Nothing here is repaired, guessed, or retried automatically. There is no timer, so
 * nothing can wake itself up and try again.
 */

/** What recovery found, and what it is willing to claim. */
export interface RecoveryReport {
  /** Actions whose process ended before they settled. */
  readonly unresolved: readonly { readonly actionId: string; readonly actionKey: string }[]
  readonly completed: number
  readonly failed: number
  readonly unverified: number
  readonly interrupted: number
  readonly cancelled: number
  readonly timedOut: number
  readonly refused: number
  /** True when this journal contained no trace of a phase having been open. */
  readonly neverOpened: boolean
  /** True when a policy digest is on the record, so a restart can be checked against it. */
  readonly policyOnRecord: boolean
}

/**
 * Read the journal and say exactly what it supports.
 *
 * Every number here is counted from settled records, and an action still running is
 * counted in `interrupted` rather than in any of the others — including `completed`.
 */
export function recoveryReport(state: DeviceHandsState): RecoveryReport {
  let completed = 0
  let failed = 0
  let unverified = 0
  let interrupted = 0
  let cancelled = 0
  let timedOut = 0
  let refused = 0

  for (const action of Object.values(state.actions)) {
    if (action.state !== 'settled') {
      interrupted += 1
      continue
    }
    switch (action.outcome) {
      case 'completed':
        completed += 1
        break
      case 'failed':
        failed += 1
        break
      case 'unverified':
        unverified += 1
        break
      case 'interrupted':
        interrupted += 1
        break
      case 'cancelled':
        cancelled += 1
        break
      case 'timed-out':
        timedOut += 1
        break
      case 'refused':
        refused += 1
        break
    }
  }

  return {
    unresolved: unresolvedActions(state).map((action) => ({
      actionId: action.actionId,
      actionKey: action.actionKey,
    })),
    completed,
    failed,
    unverified,
    interrupted,
    cancelled,
    timedOut,
    refused,
    neverOpened: state.openedAt === null,
    policyOnRecord: state.policyDigest !== null,
  }
}

/**
 * Whether this journal may be opened at all.
 *
 * Two refusals, both fail-closed, and neither is repairable:
 *
 *   - an **untrustworthy** journal refuses, because "we fixed what we could on startup"
 *     is how a system ends up running on a record nobody has read;
 *   - a journal with **actions past the code-owned ceiling** refuses, because the fold
 *     has stopped bounding them and a fold that has stopped bounding is not a fold.
 */
export function mayOpenJournal(input: {
  readonly trustworthy: boolean
  readonly actionCount: number
}): { readonly ok: boolean; readonly code: string; readonly reason: string } {
  if (!input.trustworthy) {
    return {
      ok: false,
      code: 'journal-untrustworthy',
      reason:
        'The action journal cannot be believed, so this phase did not open. Refusing is the only honest response to a record nobody has read.',
    }
  }
  if (input.actionCount > DEVICE_HANDS_LIMITS.maxActionsPerSession) {
    return {
      ok: false,
      code: 'action-count-exceeded',
      reason: `The journal holds ${String(input.actionCount)} actions, past this build's ceiling of ${String(DEVICE_HANDS_LIMITS.maxActionsPerSession)}. A journal the fold can no longer bound is not one to act on.`,
    }
  }
  return { ok: true, code: '', reason: 'The journal can be believed and is within its bounds.' }
}