import {
  ENTERPRISE_LIMITS,
  ROLLBACK_OUTCOMES,
  isRollbackOutcome,
  type ActionConsequenceClass,
  type EnterpriseRefusalCode,
  type RollbackOutcome,
} from './types'
import type { RollbackInput } from './ports'

/**
 * Rollback and recovery.
 *
 * The specification's rule is that no irreversible action can be rolled back, and the
 * work here is making that a *derived* fact rather than a judgement. Reversibility is
 * computed from four recorded facts about what the action actually did — its
 * consequence class, whether a restorable copy exists, whether it crossed a boundary,
 * and whether it exceeded a spending limit — and any one of them is sufficient on its
 * own to make the action irreversible.
 *
 * Two things this file deliberately refuses to do:
 *
 *   - **It does not trust the action's own account of itself.** Reversibility is not a
 *     field an action carries; it is a question this module answers from evidence. An
 *     action that asserts it was safely reversible has asserted nothing.
 *
 *   - **It does not attempt a partial rollback it cannot complete.** A `destructive`
 *     operation whose preserved copy is missing is `not-reversible`, full stop. There
 *     is no "best effort" path, because a best-effort rollback of a deletion is a
 *     deletion that is now also unrecoverable *and* has an audit entry claiming
 *     something was undone.
 *
 * Pure. No clock, no journal, no network.
 */

export type ReversibilityCode =
  | 'reversible'
  | 'destructive-without-restore'
  | 'crossed-boundary'
  | 'exceeded-spending'
  | 'spent-money'
  | 'rollback-limit-reached'

export interface ReversibilityAssessment {
  readonly reversible: boolean
  readonly code: ReversibilityCode
  readonly reason: string
}

export interface RollbackDecision {
  readonly allowed: boolean
  readonly outcome: RollbackOutcome
  readonly code: EnterpriseRefusalCode | null
  readonly reason: string
}

/**
 * May this action be undone?
 *
 * Checked in the order that produces the most specific honest answer, so the owner is
 * told *why* something cannot be undone rather than a generic no. The order matters in
 * one place in particular: a spent action is refused before the boundary check,
 * because money already committed is the most consequential of the four and burying it
 * under a structural reason would be dishonest.
 */
export function assessReversibility(input: RollbackInput): ReversibilityAssessment {
  if (input.spentMinor > 0) {
    return {
      reversible: false,
      code: 'spent-money',
      reason: `This action already committed ${String(input.spentMinor)} in minor units. Money that has been committed is not undone by a rollback here.`,
    }
  }
  if (input.exceededSpending) {
    return {
      reversible: false,
      code: 'exceeded-spending',
      reason: 'This action exceeded a spending gate, so what it did is outside every ceiling that would make undoing it safe.',
    }
  }
  if (input.crossedBoundary) {
    return {
      reversible: false,
      code: 'crossed-boundary',
      reason: 'This action crossed an enterprise boundary, so its effects are not confined to what a rollback could reverse.',
    }
  }
  if (input.consequence === 'destructive' && !input.restorable) {
    return {
      reversible: false,
      code: 'destructive-without-restore',
      reason:
        'This was a destructive operation and no restorable copy was kept. There is nothing to put back, so it is not reversible.',
    }
  }
  if (input.attempts >= ENTERPRISE_LIMITS.maxRollbackAttempts) {
    return {
      reversible: false,
      code: 'rollback-limit-reached',
      reason: `This action has already been rolled back ${String(input.attempts)} times, which is its ceiling. A rollback that can be attempted forever is not a bounded one.`,
    }
  }
  return {
    reversible: true,
    code: 'reversible',
    reason:
      input.consequence === 'destructive'
        ? 'This was a destructive operation and a restorable copy was kept, so it can be put back.'
        : 'This action changed nothing that cannot be put back.',
  }
}

export interface RollbackGateInput extends RollbackInput {
  /** Rollbacks already performed for this environment, for the per-environment bound. */
  readonly environmentRollbacks: number
  /** Whether the owner approved this rollback, where one is required. */
  readonly approved: boolean
}

/**
 * The rollback gate.
 *
 * Four refusals, and the two ordering decisions are the interesting part:
 *
 *   - STOP ALL is not consulted here. It is consulted by the pipeline in
 *     `../orchestration`, which every action goes through, and a rollback that could
 *     run while Freya is stopped would make the one operation most likely to be needed
 *     during an incident the one operation that cannot happen.
 *   - The irreversibility check runs *before* the approval check. Asking the owner to
 *     approve something that provably cannot be done is how a subsystem learns to
 *     request permission for impossible things.
 */
export function checkRollbackGate(input: RollbackGateInput): RollbackDecision {
  if (input.environmentRollbacks >= ENTERPRISE_LIMITS.maxRollbacksPerEnvironment) {
    return {
      allowed: false,
      outcome: 'not-reversible',
      code: 'rollback-limit-exceeded',
      reason: `This environment has reached its ceiling of ${String(ENTERPRISE_LIMITS.maxRollbacksPerEnvironment)} rollbacks.`,
    }
  }

  const assessment = assessReversibility(input)
  if (!assessment.reversible) {
    return {
      allowed: false,
      outcome: 'not-reversible',
      code: 'action-not-reversible',
      reason: assessment.reason,
    }
  }

  if (!input.approved) {
    return {
      allowed: false,
      outcome: 'not-reversible',
      code: 'approval-required',
      reason:
        'Undoing a public change is itself a public change, so it needs the same owner approval the original action needed.',
    }
  }

  return {
    allowed: true,
    outcome: 'success',
    code: null,
    reason: 'This action is reversible and the owner approved the rollback.',
  }
}

/**
 * What did the reverse attempt actually achieve?
 *
 * `rolledBack` says whether the effect was undone. `allOfIt` says whether *everything*
 * was undone. They are separate because the honest answer to "we undid it" is often
 * "we undid most of it", and reporting `success` for a partial reversal is how an
 * owner comes to believe their site was restored when it was not.
 */
export interface RollbackOutcomeInput {
  readonly rollbackId: string
  readonly actionId: string
  readonly environmentId: string
  /** Whether the reverse effect happened. */
  readonly rolledBack: boolean
  /** Whether every part of the original action was undone. */
  readonly allOfIt: boolean
  readonly restorable: boolean
}

/**
 * Derive a rollback outcome from what happened.
 *
 * `partial` is reachable, and it is reported rather than rounded up to `success`. A
 * partially reversed action is a state the owner has to know about.
 */
export function deriveRollbackOutcome(input: RollbackOutcomeInput): RollbackDecision {
  if (!input.restorable) {
    return {
      allowed: false,
      outcome: 'not-reversible',
      code: 'action-not-reversible',
      reason: 'There was no restorable copy, so there was never anything to reverse.',
    }
  }
  if (!input.rolledBack) {
    return {
      allowed: false,
      outcome: 'failed',
      code: 'verification-failed',
      reason: 'The reverse effect did not happen, so the original action is still in place.',
    }
  }
  if (!input.allOfIt) {
    return {
      allowed: true,
      outcome: 'partial',
      code: null,
      reason:
        'Only part of the original action was undone. This is reported as partial rather than success, because a partial restore is not a restore.',
    }
  }
  return {
    allowed: true,
    outcome: 'success',
    code: null,
    reason: 'The original action was fully undone and that was observed.',
  }
}

export interface RollbackRecord {
  readonly rollbackId: string
  readonly actionId: string
  readonly environmentId: string
  readonly outcome: RollbackOutcome
  readonly reason: string
  readonly rolledBackAt: string
}

/**
 * May this environment continue operating after what just happened?
 *
 * The only rollback outcome that stops the environment is a failure, and the reason is
 * that the environment's own record and the outside world may now disagree. A partial
 * rollback is a problem but it is a *known* problem; a failed one means the subsystem
 * no longer knows the true state, and continuing from an unknown state is how a
 * business gets into a state nobody chose.
 */
export function environmentMayContinue(outcome: RollbackOutcome): {
  readonly mayContinue: boolean
  readonly reason: string
} {
  if (!isRollbackOutcome(outcome)) {
    return { mayContinue: false, reason: 'An unknown rollback outcome cannot be continued from.' }
  }
  switch (outcome) {
    case 'success':
      return { mayContinue: true, reason: 'The action was undone, so the environment is where it was.' }
    case 'partial':
      return {
        mayContinue: true,
        reason:
          'Part of the action was undone. The environment continues, and the partial state is shown to the owner rather than smoothed over.',
      }
    case 'failed':
      return {
        mayContinue: false,
        reason:
          'The rollback failed, so what is outside no longer matches what this subsystem believes. Continuing would mean operating from a state nobody has verified.',
      }
    case 'not-reversible':
      return {
        mayContinue: true,
        reason:
          'Nothing was reversed because nothing could be. The environment continues with the action in place and visible.',
      }
  }
}

/**
 * Is this consequence class one a rollback may be attempted against at all?
 *
 * A read has nothing to undo. Answering "yes" for a read would mean the subsystem can
 * be asked to roll back something that never happened, which is how a rollback record
 * with a fabricated action id gets into a journal.
 */
export function mayAttemptRollbackFor(
  consequence: ActionConsequenceClass,
): { readonly allowed: boolean; readonly reason: string } {
  if (consequence === 'read') {
    return {
      allowed: false,
      reason: 'A read changed nothing, so there is nothing to roll back.',
    }
  }
  return {
    allowed: true,
    reason: `A ${consequence} action may be rolled back if it is reversible.`,
  }
}

export function rollbackOutcomes(): readonly RollbackOutcome[] {
  return ROLLBACK_OUTCOMES
}

/** The maximum rollback duration, in milliseconds. */
export function maxRollbackDurationMs(): number {
  return ENTERPRISE_LIMITS.maxRollbackDurationMs
}