import {
  DECIDE_ESCALATION,
  isEscalating,
  type DecideOutcome,
  type FocusState,
  type OwnerEscalation,
} from './types'

/** Event-driven Missions use this gate, never LifeLoop polling or its cognition grant. */
export function chatMissionContinuation(input: { stopped: boolean; authorized: boolean; paused: boolean; expired: boolean }): boolean {
  return !input.stopped && input.authorized && !input.paused && !input.expired
}

/**
 * The decide step: what Freya concluded, and how loudly she is allowed to say so.
 *
 * Pure. No clock, no journal, no provider, no capability — the same reason the
 * filter is: the function that decides whether to interrupt a human being must
 * not be a function that can pay for anything, because "she only interrupts when
 * something justifies it" is not a claim worth making about code that can also
 * reach a model.
 *
 * The escalation ladder here is the one place in Phase 23 where the loop takes
 * something away from the owner, so it is closed, ordered, and monotonic: a
 * quieter outcome can never be talked up, and the only way *down* is focus.
 */

/** Ordered loudest-last. Used to compare two escalations. */
const ESCALATION_RANK: Readonly<Record<OwnerEscalation, number>> = Object.freeze({
  none: 0,
  'subtle-cue': 1,
  speak: 2,
  interrupt: 3,
})

export type EscalationResolutionReason =
  | 'not-escalating'
  | 'focus-suppressed-interrupt'
  | 'escalation-permitted'
  | 'owner-stopped'

export type EscalationResolution = {
  readonly outcome: DecideOutcome
  readonly escalation: OwnerEscalation
  readonly suppressed: boolean
  readonly code: EscalationResolutionReason
  readonly reason: string
}

const REASON_TEXT: Readonly<Record<EscalationResolutionReason, string>> = Object.freeze({
  'not-escalating': 'Freya concluded this quietly, so nothing reaches for the owner.',
  'focus-suppressed-interrupt':
    'The owner is mid-task, so what would have interrupted them is held back.',
  'escalation-permitted': 'Nothing else is in the owner’s way, so Freya may reach them.',
  'owner-stopped': 'Freya is stopped, so nothing is said at all.',
})

/** How loud an outcome is, comparable across outcomes. */
export function escalationRank(escalation: OwnerEscalation): number {
  return ESCALATION_RANK[escalation]
}

/**
 * Resolve what the owner actually experiences, given what the loop concluded.
 *
 * Three rules, in this order:
 *
 *   1. A stopped Freya escalates nothing. STOP ALL outranks every decision.
 *   2. A quiet outcome stays quiet. `do-nothing` and `remember` take nothing.
 *   3. Focus suppresses `interrupt` and nothing else. A cue or a word still
 *      gets through, because a suppressed `speak` would be silence the owner
 *      never agreed to.
 *
 * `interrupt` downgraded under focus becomes `do-nothing`, not `speak`: the
 * loop did not decide to speak, it decided to interrupt and was told it could
 * not. Quietly saying a subset of it is the loop making a new decision with no
 * wake behind it.
 */
export function resolveEscalation(
  outcome: DecideOutcome,
  focus: FocusState,
  ownerStopped = false,
): EscalationResolution {
  const requested = DECIDE_ESCALATION[outcome]

  if (ownerStopped) {
    return {
      outcome: 'do-nothing',
      escalation: 'none',
      suppressed: requested !== 'none',
      code: 'owner-stopped',
      reason: REASON_TEXT['owner-stopped'],
    }
  }

  if (!isEscalating(outcome)) {
    return {
      outcome,
      escalation: 'none',
      suppressed: false,
      code: 'not-escalating',
      reason: REASON_TEXT['not-escalating'],
    }
  }

  if (focus.focused && requested === 'interrupt') {
    return {
      outcome: 'do-nothing',
      escalation: 'none',
      suppressed: true,
      code: 'focus-suppressed-interrupt',
      reason: REASON_TEXT['focus-suppressed-interrupt'],
    }
  }

  return {
    outcome,
    escalation: requested,
    suppressed: false,
    code: 'escalation-permitted',
    reason: REASON_TEXT['escalation-permitted'],
  }
}
