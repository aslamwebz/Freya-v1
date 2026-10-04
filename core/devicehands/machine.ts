import {
  DEVICE_HANDS_APPROVAL_STATES,
  DEVICE_HANDS_ACTION_STATES,
  DEVICE_HANDS_SETTLE_OUTCOMES,
  isDeviceHandsActionState,
  isDeviceHandsSettleOutcome,
  type DeviceHandsActionState,
  type DeviceHandsApprovalState,
  type DeviceHandsSettleOutcome,
} from './types'

/**
 * The state machines, declared centrally.
 *
 * Nothing in this phase moves a record by writing to it: the fold and the runtime both
 * go through these tables, and both record `illegal-transition` for an edge that does not
 * exist. That is what makes "a terminal record is never rewritten" a property of the
 * tables rather than of how carefully somebody remembered.
 *
 * Pure. No clock, no journal, no authority.
 */

/* ------------------------------------------------------------------ actions */

/**
 * `pending → running → settled`.
 *
 * `pending` exists so the shape of an admitted-but-not-started action is
 * representable, and `settled` is the only terminal state — the *outcome* inside it
 * ({@link DEVICE_HANDS_SETTLE_OUTCOMES}) carries whether it completed, failed, was
 * refused, was cancelled, timed out, is unverified, or was interrupted.
 *
 * Separating "finished" from "how it finished" is what lets `interrupted` and
 * `unverified` be terminal outcomes rather than special cases threaded through three
 * branches of a switch.
 */
export const DEVICE_HANDS_ACTION_TRANSITIONS: Readonly<
  Record<DeviceHandsActionState, readonly DeviceHandsActionState[]>
> = Object.freeze({
  pending: ['running'],
  running: ['settled'],
  settled: [],
})

export function canTransitionAction(from: DeviceHandsActionState, to: DeviceHandsActionState): boolean {
  return (DEVICE_HANDS_ACTION_TRANSITIONS[from] ?? []).includes(to)
}

export function actionTransition(
  from: DeviceHandsActionState,
  to: DeviceHandsActionState,
): { readonly allowed: boolean; readonly reason: string } {
  if (!isDeviceHandsActionState(from) || !isDeviceHandsActionState(to)) {
    return { allowed: false, reason: 'That is not an action state this build knows.' }
  }
  if (canTransitionAction(from, to)) return { allowed: true, reason: `An action may go from ${from} to ${to}.` }
  if (from === 'settled') {
    return {
      allowed: false,
      reason: `This action is already settled as ${from}, so it cannot also become ${to}. A finished action is not rewritten.`,
    }
  }
  return { allowed: false, reason: `No edge from ${from} to ${to}.` }
}

/* --------------------------------------------------------------- approvals */

/**
 * `pending → granted | denied`, `granted → revoked`.
 *
 * There is no edge out of `denied` or `revoked`, and none into `granted` from anything
 * but `pending`. An approval somebody declined is not an approval they declined *for
 * now*, and an approval somebody took back is not one they can take back again into a
 * second life — a caller that wants another chance has to ask for another approval,
 * which puts it in front of the owner a second time.
 */
export const DEVICE_HANDS_APPROVAL_TRANSITIONS: Readonly<
  Record<DeviceHandsApprovalState, readonly DeviceHandsApprovalState[]>
> = Object.freeze({
  pending: ['granted', 'denied'],
  granted: ['revoked'],
  denied: [],
  revoked: [],
  expired: [],
})

export function canTransitionApprovalMachine(
  from: DeviceHandsApprovalState,
  to: DeviceHandsApprovalState,
): boolean {
  return (DEVICE_HANDS_APPROVAL_TRANSITIONS[from] ?? []).includes(to)
}

/* ---------------------------------------------------------------- outcomes */

/** The settle outcome a verification verdict produces. */
export function settleOutcomeFor(
  verdict: 'passed' | 'failed' | 'unverified',
): DeviceHandsSettleOutcome {
  if (verdict === 'passed') return 'completed'
  if (verdict === 'failed') return 'failed'
  return 'unverified'
}

/* ------------------------------------------------------------------ audits */

export interface Transition {
  readonly from: string
  readonly to: string
}

export interface TransitionDecision {
  readonly allowed: boolean
  readonly reason: string
}

export interface TransitionRefusal {
  readonly kind: 'illegal-transition' | 'terminal-state-re-entered'
  readonly detail: string
}

/**
 * Every machine table is well-formed, total, and acyclic.
 *
 * Re-derived from the tables rather than asserted, so an edit that adds an edge without
 * deciding what it means fails here. Three properties are checked:
 *
 *   - every `from` and every `to` is a member of its own state set;
 *   - no state has an edge to itself (a self-loop is a record that can be rewritten
 *     forever, which for a *terminal* state is the bug this whole phase is about);
 *   - a terminal state has no outgoing edges at all.
 */
export function auditTransitionTables(): readonly string[] {
  const findings: string[] = []

  const check = (
    name: string,
    states: readonly string[],
    table: Readonly<Record<string, readonly string[]>>,
    terminal: readonly string[],
  ): void => {
    for (const [from, targets] of Object.entries(table)) {
      if (!states.includes(from)) findings.push(`${name} has a row for "${from}", which is not a state`)
      for (const to of targets) {
        if (!states.includes(to)) findings.push(`${name} has the edge ${from} -> ${to}, and "${to}" is not a state`)
        if (from === to) findings.push(`${name} has the self-loop ${from} -> ${to}`)
      }
    }
    for (const state of states) {
      if (table[state] === undefined) findings.push(`${name} has no row for the state "${state}"`)
    }
    for (const state of terminal) {
      const targets = table[state]
      if (targets === undefined || targets.length > 0) {
        findings.push(`${name} gives the terminal state "${state}" an outgoing edge`)
      }
    }
  }

  check(
    'DEVICE_HANDS_ACTION_TRANSITIONS',
    DEVICE_HANDS_ACTION_STATES,
    DEVICE_HANDS_ACTION_TRANSITIONS,
    ['settled'],
  )
  check(
    'DEVICE_HANDS_APPROVAL_TRANSITIONS',
    DEVICE_HANDS_APPROVAL_STATES,
    DEVICE_HANDS_APPROVAL_TRANSITIONS,
    ['denied', 'revoked', 'expired'],
  )

  for (const outcome of DEVICE_HANDS_SETTLE_OUTCOMES) {
    if (!isDeviceHandsSettleOutcome(outcome)) {
      findings.push(`"${outcome}" is listed as a settle outcome but is not one`)
    }
  }

  return findings
}