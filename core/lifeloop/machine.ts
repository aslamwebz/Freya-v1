import {
  CONTINUATION_SIGNALS,
  CONTINUATION_STATES,
  isTerminalState,
  isWaitingState,
  type ContinuationSignal,
  type ContinuationState,
  type DeadlineType,
  type InterruptionNotApplicable,
  type InterruptionOutcome,
  type InterruptionSource,
  type LifeLoopEventType,
  type TransitionOutcome,
} from './types'

/**
 * The Continuation State Machine.
 *
 * Nine states, a closed set of ordinary signals, and a separate closed table for
 * interruptions. Both tables are total functions over finite inputs, so the whole
 * machine is provable by exhaustion rather than by review: every (state, signal)
 * pair has exactly one answer, and any pair not in the table is refused with a
 * code rather than reaching for a default.
 *
 * The invariants it exists to hold:
 *
 *   1. only table transitions happen;
 *   2. `DENY` and `STOP` have no outgoing edge except an explicit reset;
 *   3. every waiting state is entered with a deadline attached by its caller;
 *   4. every state change is journaled, and each journal event names exactly one
 *      state change (which is what makes the journal replayable);
 *   5. STOP ALL reaches every state, including `IDLE`;
 *   6. the ordinary table contains no self-transition.
 */

/**
 * The ordinary transition table.
 *
 * Keyed `[from][signal]`. Written out rather than computed, because a transition
 * table that is *derived* is a transition table that can be derived wrongly.
 *
 * `reset` appears only under the two terminal states: an `IDLE` loop has nothing
 * to reset, and treating "reset" as a no-op there would put a self-transition
 * into the table and quietly destroy invariant 6.
 */
const ORDINARY_TRANSITIONS: Readonly<
  Record<ContinuationState, Readonly<Partial<Record<ContinuationSignal, ContinuationState>>>>
> = Object.freeze({
  IDLE: Object.freeze({ 'wake-received': 'WAKING' }),
  WAKING: Object.freeze({
    'filter-denied': 'DENY',
    'condition-not-met': 'WAIT',
    'filter-allowed': 'ALLOW',
    'deadline-expired': 'DENY',
  }),
  WAIT: Object.freeze({ 'next-wake': 'WAKING', 'deadline-expired': 'DENY' }),
  ALLOW: Object.freeze({
    'cognition-allowed': 'ACTING',
    'cognition-denied': 'DENY',
  }),
  ACTING: Object.freeze({
    'action-completed': 'VERIFYING',
    'action-failed': 'DENY',
    'deadline-expired': 'DENY',
  }),
  VERIFYING: Object.freeze({
    'verification-passed': 'CONTINUE',
    'verification-failed': 'DENY',
    'deadline-expired': 'DENY',
  }),
  CONTINUE: Object.freeze({ 'next-iteration': 'WAKING', 'loop-complete': 'STOP' }),
  DENY: Object.freeze({ reset: 'IDLE' }),
  STOP: Object.freeze({ reset: 'IDLE' }),
})

/**
 * Which journal event each state change writes.
 *
 * One event per change and one change per event, so a reader of the journal can
 * reconstruct the state without interpreting payloads. The two entries that are
 * `null` are deliberate: `IDLE -> WAKING` on a *fresh* wake is recorded by the
 * receiving side as `lifeloop.wake.received`, and `CONTINUE -> WAKING` on the next
 * iteration is likewise a wake. An event is written when the change happens, not
 * because a table said it should be.
 */
type TransitionKey = `${ContinuationState}>${ContinuationState}`

const TRANSITION_EVENTS: Readonly<
  Partial<Record<TransitionKey, LifeLoopEventType | null>>
> = Object.freeze({
  'IDLE>WAKING': 'lifeloop.wake.received',
  'WAKING>DENY': 'lifeloop.filter.denied',
  'WAKING>WAIT': 'lifeloop.filter.denied',
  'WAKING>ALLOW': 'lifeloop.filter.passed',
  'WAIT>WAKING': 'lifeloop.wake.received',
  'WAIT>DENY': 'lifeloop.filter.denied',
  'ALLOW>ACTING': 'lifeloop.action.started',
  'ALLOW>DENY': 'lifeloop.cognition.denied',
  'ACTING>VERIFYING': 'lifeloop.action.completed',
  'ACTING>DENY': 'lifeloop.action.failed',
  'VERIFYING>CONTINUE': 'lifeloop.verification.passed',
  'VERIFYING>DENY': 'lifeloop.verification.failed',
  'CONTINUE>WAKING': 'lifeloop.wake.received',
  'CONTINUE>STOP': 'lifeloop.stopped',
  'DENY>IDLE': null,
  'STOP>IDLE': null,
})

const SIGNAL_REASONS: Readonly<Record<ContinuationSignal, string>> = Object.freeze({
  'wake-received': 'Freya woke up and is looking at what happened.',
  'filter-denied': 'A deterministic gate refused this before anything was thought.',
  'condition-not-met': 'The thing this was waiting for has not happened yet.',
  'filter-allowed': 'Everything deterministic said this is worth thinking about.',
  'next-wake': 'Something else woke Freya, and this wait is over.',
  'deadline-expired': 'This had a deadline, and the deadline passed.',
  'cognition-allowed': 'Freya was authorized to think, and did.',
  'cognition-denied': 'Freya was not authorized to think about this.',
  'action-completed': 'The bounded action finished.',
  'action-failed': 'The bounded action failed.',
  'verification-passed': 'What happened was checked, and it held.',
  'verification-failed': 'What happened was checked, and it did not hold.',
  'next-iteration': 'There is another step, and Freya is going round again.',
  'loop-complete': 'There is nothing left to do in this wake.',
  reset: 'The loop is closed out and back to being idle.',
})

export function continuationSignalReason(signal: ContinuationSignal): string {
  return SIGNAL_REASONS[signal]
}

/**
 * Apply an ordinary signal.
 *
 * Refuses rather than throwing, because the callers are the journal writer and
 * the recovery path, and both need a refusal they can record.
 */
export function transition(from: ContinuationState, signal: ContinuationSignal): TransitionOutcome {
  if (!(CONTINUATION_STATES as readonly string[]).includes(from)) {
    return {
      ok: false,
      from,
      signal,
      code: 'illegal-transition',
      reason: 'That is not a state the continuation loop can be in.',
    }
  }
  if (!(CONTINUATION_SIGNALS as readonly string[]).includes(signal)) {
    return {
      ok: false,
      from,
      signal,
      code: 'illegal-transition',
      reason: 'That is not a signal the continuation loop understands.',
    }
  }

  const to = ORDINARY_TRANSITIONS[from][signal]
  if (to === undefined) {
    // Terminal states get their own code, because "you cannot move a STOPped
    // loop" is a different fact from "that move is not in the table", and a
    // reader debugging a stuck loop needs to tell them apart.
    const code = isTerminalState(from) ? 'already-terminal' : 'illegal-transition'
    return {
      ok: false,
      from,
      signal,
      code,
      reason: isTerminalState(from)
        ? 'This loop has already finished. It has to be closed out before anything else happens.'
        : 'The continuation loop cannot make that move from where it is.',
    }
  }
  if (to === from) {
    // Unreachable by construction over the frozen table, and asserted in the
    // suite. Kept as a guard because a future edit to the table that introduced
    // one would otherwise be invisible.
    return {
      ok: false,
      from,
      signal,
      code: 'self-transition',
      reason: 'That move would not have changed anything.',
    }
  }

  return {
    ok: true,
    from,
    to,
    signal,
    event: TRANSITION_EVENTS[`${from}>${to}` as TransitionKey] ?? null,
    reason: SIGNAL_REASONS[signal],
  }
}

/** Every ordinary transition, for exhaustion tests. */
export function allOrdinaryTransitions(): readonly {
  readonly from: ContinuationState
  readonly signal: ContinuationSignal
  readonly to: ContinuationState | null
}[] {
  return CONTINUATION_STATES.flatMap((from) =>
    CONTINUATION_SIGNALS.map((signal) => ({
      from,
      signal,
      to: ORDINARY_TRANSITIONS[from][signal] ?? null,
    })),
  )
}

/* ----------------------------------------------------------- interruption */

/**
 * The interruption table.
 *
 * Separate from the ordinary table on purpose, and it *overrides* it. Interruption
 * is not a step in the loop's own reasoning: STOP ALL, an owner's command, a Guard
 * denial, an exhausted budget and an expired deadline all arrive from outside the
 * continuation and none of them has to wait for the loop to reach a convenient
 * state. The one place this table deliberately permits a self-transition is
 * `WAKING` under an owner command — the loop is *already* serving the owner, and
 * recording the preemption is how the journal says so.
 */
const INTERRUPTION_TARGETS: Readonly<
  Record<InterruptionSource, Readonly<Record<ContinuationState, ContinuationState | null>>>
> = Object.freeze({
  'stop-all': Object.freeze({
    IDLE: 'STOP',
    WAKING: 'STOP',
    WAIT: 'STOP',
    ALLOW: 'STOP',
    ACTING: 'STOP',
    VERIFYING: 'STOP',
    CONTINUE: 'STOP',
    // A stopped loop stays stopped. Re-asserting the latch is not a second
    // transition and is reported as not applicable rather than as a move.
    DENY: null,
    STOP: null,
  }),
  'owner-command': Object.freeze({
    IDLE: 'WAKING',
    WAKING: 'WAKING',
    WAIT: 'WAKING',
    ALLOW: 'WAKING',
    ACTING: 'WAKING',
    VERIFYING: 'WAKING',
    CONTINUE: 'WAKING',
    DENY: null,
    STOP: null,
  }),
  'guard-denial': Object.freeze({
    IDLE: null,
    WAKING: 'DENY',
    WAIT: 'DENY',
    ALLOW: 'DENY',
    ACTING: 'DENY',
    VERIFYING: 'DENY',
    CONTINUE: 'DENY',
    DENY: null,
    STOP: null,
  }),
  'budget-exhaustion': Object.freeze({
    IDLE: null,
    WAKING: 'DENY',
    WAIT: 'DENY',
    ALLOW: 'DENY',
    ACTING: 'DENY',
    VERIFYING: 'DENY',
    CONTINUE: 'DENY',
    DENY: null,
    STOP: null,
  }),
  // Approval parks the loop rather than ending it. The action stops immediately
  // — that is the whole point of requiring approval for a consequential thing —
  // but the loop lands in WAIT holding an `approval` deadline, because the owner
  // has not refused; they have not answered yet, and the difference matters on
  // restart. From IDLE there is nothing awaiting approval, so it does not apply.
  'approval-required': Object.freeze({
    IDLE: null,
    WAKING: 'WAIT',
    WAIT: 'WAIT',
    ALLOW: 'WAIT',
    ACTING: 'WAIT',
    VERIFYING: 'WAIT',
    CONTINUE: 'WAIT',
    DENY: null,
    STOP: null,
  }),
  'deadline-expiry': Object.freeze({
    IDLE: null,
    WAKING: 'DENY',
    WAIT: 'DENY',
    ALLOW: 'DENY',
    ACTING: 'DENY',
    VERIFYING: 'DENY',
    CONTINUE: 'DENY',
    DENY: null,
    STOP: null,
  }),
})

const INTERRUPTION_REASONS: Readonly<Record<InterruptionSource, string>> = Object.freeze({
  'stop-all': 'Freya was stopped.',
  'owner-command': 'The owner spoke, and the owner comes first.',
  'guard-denial': 'Freya was not permitted to do that.',
  'budget-exhaustion': 'There was nothing left to spend on that.',
  'approval-required': 'Freya stopped, because the owner has not agreed to this yet.',
  'deadline-expiry': 'That had a deadline, and it ran out.',
})

const NOT_APPLICABLE_REASONS: Readonly<Record<InterruptionNotApplicable, string>> = Object.freeze({
  'nothing-to-preempt':
    'There was nothing running for that to interrupt.',
  terminal: 'This loop has already finished, so there is nothing left to preempt.',
  'unknown-state': 'That is not a state the continuation loop can be in.',
  'stop-all-latched': 'Freya is stopped until the owner says otherwise.',
})

/**
 * The deadline type each interruption leaves behind, where it leaves one.
 *
 * Approval is the only interruption that waits rather than stops, so it is the
 * only one that mints a deadline — and it mints the `approval` kind, which was
 * declared for exactly this and had no producer until now.
 */
export const INTERRUPTION_DEADLINE: Readonly<
  Partial<Record<InterruptionSource, DeadlineType>>
> = Object.freeze({
  'approval-required': 'approval',
})

export function interruptionDeadlineType(source: InterruptionSource): DeadlineType | null {
  return INTERRUPTION_DEADLINE[source] ?? null
}

export function interruptionReason(source: InterruptionSource): string {
  return INTERRUPTION_REASONS[source]
}

export function interruptionNotApplicableReason(code: InterruptionNotApplicable): string {
  return NOT_APPLICABLE_REASONS[code]
}

/**
 * Apply an interruption.
 *
 * `applied: false` is a real and common answer — an idle loop has nothing for a
 * Guard denial to preempt — and it is reported as such rather than as a refusal,
 * because nothing was attempted and nothing went wrong.
 */
export function interrupt(
  from: ContinuationState,
  source: InterruptionSource,
): InterruptionOutcome {
  if (!(CONTINUATION_STATES as readonly string[]).includes(from)) {
    return {
      applied: false,
      from,
      source,
      code: 'unknown-state',
      reason: NOT_APPLICABLE_REASONS['unknown-state'],
    }
  }
  // Nothing outranks the latch. While STOP ALL is held, an owner command cannot
  // restart the loop either: clearing the latch is a separate, explicit act by
  // the owner, and conflating the two would make "stop" mean "stop until the
  // next thing that happens".
  if (from === 'STOP' && source !== 'stop-all') {
    return { applied: false, from, source, code: 'stop-all-latched', reason: NOT_APPLICABLE_REASONS['stop-all-latched'] }
  }
  if (from === 'DENY' && source !== 'stop-all') {
    return { applied: false, from, source, code: 'terminal', reason: NOT_APPLICABLE_REASONS.terminal }
  }

  const target = INTERRUPTION_TARGETS[source][from]
  if (target === null) {
    return {
      applied: false,
      from,
      source,
      code: 'nothing-to-preempt',
      reason: NOT_APPLICABLE_REASONS['nothing-to-preempt'],
    }
  }

  return {
    applied: true,
    from,
    to: target,
    source,
    // Preemption, as opposed to termination: the loop is being taken away from
    // and may be resumed by its owner once the reason has passed.
    preempted: source === 'owner-command',
    awaitingApproval: source === 'approval-required',
    reason: INTERRUPTION_REASONS[source],
  }
}

/** Every interruption pair, for exhaustion tests. */
export function allInterruptions(): readonly {
  readonly from: ContinuationState
  readonly source: InterruptionSource
  readonly to: ContinuationState | null
}[] {
  return CONTINUATION_STATES.flatMap((from) =>
    (Object.keys(INTERRUPTION_TARGETS) as InterruptionSource[]).map((source) => ({
      from,
      source,
      to: INTERRUPTION_TARGETS[source][from],
    })),
  )
}

/**
 * Whether a state must be holding a deadline.
 *
 * `WAIT`, `ACTING` and `VERIFYING` all hold on something external, and an
 * unbounded wait is an unbounded loop wearing a different hat.
 */
export function requiresDeadline(state: ContinuationState): boolean {
  return isWaitingState(state)
}