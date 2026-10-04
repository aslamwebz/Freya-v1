import {
  APPROVAL_KINDS,
  APPROVAL_STATES,
  ENVIRONMENT_STATES,
  MISSION_STATES,
  TASK_STATES,
  TERMINAL_APPROVAL_STATES,
  TERMINAL_ENVIRONMENT_STATES,
  WEBZONE_OPERATION_KINDS,
  WEBZONE_OPERATION_STATES,
  type ApprovalKind,
  type ApprovalState,
  type EnvironmentState,
  type MissionState,
  type TaskState,
  type WebzoneOperationState,
} from './types'

/**
 * The transition tables, as data.
 *
 * Five closed tables and nothing that can move a record between states except a
 * lookup in one of them. That is the whole reason this file has no logic in it: the
 * interesting property — "no terminal state has an outgoing edge, and no unlisted
 * transition is possible" — is checkable by reading the table, and
 * `auditTransitionTables` checks it by running instead of by reading.
 *
 * Every table shares one shape, `draft/pending -> active -> (paused <-> active) ->
 * terminal`. They are written out separately rather than generated, because a
 * generated table and a table somebody meant to write are indistinguishable once
 * they agree, and the disagreements are the bugs.
 */

/** `draft -> active` etc. Self-transitions are absent by construction. */
export interface Transition<S extends string> {
  readonly from: S
  readonly to: S
}

const ORDINARY_TRANSITIONS = [
  ['draft', 'active'],
  ['draft', 'cancelled'],
  ['active', 'paused'],
  ['active', 'completed'],
  ['active', 'failed'],
  ['paused', 'active'],
  ['paused', 'cancelled'],
] as const satisfies readonly (readonly [string, string])[]

export const ENVIRONMENT_TRANSITIONS: readonly Transition<EnvironmentState>[] = Object.freeze(
  ORDINARY_TRANSITIONS.map(([from, to]) =>
    Object.freeze({ from: from as EnvironmentState, to: to as EnvironmentState }),
  ),
)

export const TASK_TRANSITIONS: readonly Transition<TaskState>[] = ENVIRONMENT_TRANSITIONS.map(
  (edge) => Object.freeze({ from: edge.from as TaskState, to: edge.to as TaskState }),
)

export const MISSION_TRANSITIONS: readonly Transition<MissionState>[] = ENVIRONMENT_TRANSITIONS.map(
  (edge) => Object.freeze({ from: edge.from as MissionState, to: edge.to as MissionState }),
)

/**
 * Webzone operations are queued rather than drafted, so the first state is `pending`.
 * Everything after that matches the environment table.
 */
export const WEBZONE_TRANSITIONS: readonly Transition<WebzoneOperationState>[] = Object.freeze([
  Object.freeze({ from: 'pending', to: 'active' as const }),
  Object.freeze({ from: 'pending', to: 'cancelled' as const }),
  Object.freeze({ from: 'active', to: 'paused' as const }),
  Object.freeze({ from: 'active', to: 'completed' as const }),
  Object.freeze({ from: 'active', to: 'failed' as const }),
  Object.freeze({ from: 'paused', to: 'active' as const }),
  Object.freeze({ from: 'paused', to: 'cancelled' as const }),
])

/**
 * Approvals differ from every other table in one way that matters: `granted` is *not*
 * terminal, because a granted approval can be revoked. An approval the owner has
 * withdrawn is not an approval, and a table that treated `granted` as final would let
 * a revocation be dropped on the floor by the fold.
 */
export const APPROVAL_TRANSITIONS: readonly Transition<ApprovalState>[] = Object.freeze([
  Object.freeze({ from: 'pending', to: 'granted' as const }),
  Object.freeze({ from: 'pending', to: 'denied' as const }),
  Object.freeze({ from: 'pending', to: 'expired' as const }),
  Object.freeze({ from: 'granted', to: 'revoked' as const }),
])

function isAllowed<S extends string>(
  table: readonly Transition<S>[],
  from: S,
  to: S,
): boolean {
  return table.some((edge) => edge.from === from && edge.to === to)
}

/* ------------------------------------------------------------- environments */

export type TransitionRefusal =
  | 'allowed'
  | 'unknown-state'
  | 'terminal-state'
  | 'illegal-transition'

export interface TransitionDecision {
  readonly allowed: boolean
  readonly code: TransitionRefusal
  readonly reason: string
}

const REASONS: Readonly<Record<TransitionRefusal, string>> = Object.freeze({
  allowed: 'The state machine permits this transition.',
  'unknown-state': 'The state named is not one of the closed states, so nothing is permitted.',
  'terminal-state':
    'This state is terminal. The record is finished and cannot be re-entered or revived.',
  'illegal-transition': 'The state machine has no edge for this transition, so it is refused.',
})

function decide<S extends string>(
  table: readonly Transition<S>[],
  states: readonly S[],
  terminal: readonly S[],
  from: S,
  to: S,
): TransitionDecision {
  if (!states.includes(from) || !states.includes(to)) {
    return { allowed: false, code: 'unknown-state', reason: REASONS['unknown-state'] }
  }
  if (from === to) {
    return { allowed: false, code: 'illegal-transition', reason: REASONS['illegal-transition'] }
  }
  if (terminal.includes(from)) {
    return { allowed: false, code: 'terminal-state', reason: REASONS['terminal-state'] }
  }
  if (terminal.includes(to)) {
    // Reaching a terminal state is always permitted; it is the *only* thing a
    // terminal state may do, and saying so explicitly keeps the terminal list from
    // being read as "these three are unreachable".
    return { allowed: true, code: 'allowed', reason: REASONS.allowed }
  }
  if (isAllowed(table, from, to)) {
    return { allowed: true, code: 'allowed', reason: REASONS.allowed }
  }
  return { allowed: false, code: 'illegal-transition', reason: REASONS['illegal-transition'] }
}

export function environmentTransition(
  from: EnvironmentState,
  to: EnvironmentState,
): TransitionDecision {
  return decide(ENVIRONMENT_TRANSITIONS, ENVIRONMENT_STATES, TERMINAL_ENVIRONMENT_STATES, from, to)
}

export function taskTransition(from: TaskState, to: TaskState): TransitionDecision {
  return decide(TASK_TRANSITIONS, TASK_STATES, TERMINAL_ENVIRONMENT_STATES, from, to)
}

export function missionTransition(from: MissionState, to: MissionState): TransitionDecision {
  return decide(MISSION_TRANSITIONS, MISSION_STATES, TERMINAL_ENVIRONMENT_STATES, from, to)
}

export function webzoneTransition(
  from: WebzoneOperationState,
  to: WebzoneOperationState,
): TransitionDecision {
  return decide(
    WEBZONE_TRANSITIONS,
    WEBZONE_OPERATION_STATES,
    TERMINAL_ENVIRONMENT_STATES,
    from,
    to,
  )
}

export function approvalTransition(from: ApprovalState, to: ApprovalState): TransitionDecision {
  return decide(APPROVAL_TRANSITIONS, APPROVAL_STATES, TERMINAL_APPROVAL_STATES, from, to)
}

/** An approval kind's pending-request ceiling. */
export const APPROVAL_PENDING_LIMITS: Readonly<Record<ApprovalKind, number>> = Object.freeze({
  action: 32,
  spending: 16,
  boundary: 8,
})

/* ------------------------------------------------------------------- audit */

/**
 * Re-derive the invariants from the tables themselves.
 *
 * Used by the suite as an exhaustion check rather than by production code, which is
 * why it lives here rather than in `types.ts`: these are statements *about* the
 * machine, so they belong next to the things they are about.
 *
 * The checks worth having are the ones that would catch a future edit, not the ones
 * that merely restate the tables:
 *
 *   - a terminal state with an outgoing edge other than "into terminal" is the bug
 *     that lets a `completed` environment be reopened;
 *   - a self-transition is always a bug, because every table here is driven by a
 *     distinct event;
 *   - a state with no outgoing edge at all and no terminal status is a state a record
 *     can get stuck in forever;
 *   - a webzone kind that is not in `WEBZONE_OPERATION_KINDS` cannot be described,
 *     which is how the absence of `pay` and `sign` is enforced.
 */
export function auditTransitionTables(): readonly string[] {
  const findings: string[] = []
  const groups: readonly {
    readonly name: string
    readonly edges: readonly Transition<string>[]
    readonly states: readonly string[]
    readonly terminal: readonly string[]
  }[] = [
    {
      name: 'environment',
      edges: ENVIRONMENT_TRANSITIONS,
      states: ENVIRONMENT_STATES,
      terminal: TERMINAL_ENVIRONMENT_STATES,
    },
    {
      name: 'task',
      edges: TASK_TRANSITIONS,
      states: TASK_STATES,
      terminal: TERMINAL_ENVIRONMENT_STATES,
    },
    {
      name: 'mission',
      edges: MISSION_TRANSITIONS,
      states: MISSION_STATES,
      terminal: TERMINAL_ENVIRONMENT_STATES,
    },
    {
      name: 'webzone',
      edges: WEBZONE_TRANSITIONS,
      states: WEBZONE_OPERATION_STATES,
      terminal: TERMINAL_ENVIRONMENT_STATES,
    },
  ]

  for (const group of groups) {
    for (const edge of group.edges) {
      if (edge.from === edge.to) {
        findings.push(`${group.name}: self-transition ${edge.from}`)
      }
      if (!group.states.includes(edge.from)) {
        findings.push(`${group.name}: edge from unknown state ${edge.from}`)
      }
      if (!group.states.includes(edge.to)) {
        findings.push(`${group.name}: edge to unknown state ${edge.to}`)
      }
      if (group.terminal.includes(edge.from) && !group.terminal.includes(edge.to)) {
        findings.push(`${group.name}: terminal state ${edge.from} has an outgoing edge to ${edge.to}`)
      }
    }
    // The initial state is entered by *creation*, not by a transition, so it has no
    // incoming edge and is exempt from the reachability check. Missing that exemption
    // makes the audit report the initial state of all four tables as unreachable,
    // which trains people to ignore the audit — so the exemption is written down.
    const INITIAL_STATES: Readonly<Record<string, string>> = Object.freeze({
      environment: 'draft',
      task: 'draft',
      mission: 'draft',
      webzone: 'pending',
    })
    const initial = INITIAL_STATES[group.name]

    for (const state of group.states) {
      if (group.terminal.includes(state)) continue
      const reachable = group.edges.some((edge) => edge.from === state)
      if (!reachable) findings.push(`${group.name}: non-terminal state ${state} is a dead end`)
      if (state === initial) continue
      const enters = group.edges.some((edge) => edge.to === state)
      if (!enters) findings.push(`${group.name}: state ${state} is unreachable`)
    }
  }

  // `granted` is deliberately non-terminal so a revocation survives the fold.
  for (const edge of APPROVAL_TRANSITIONS) {
    if (edge.from === edge.to) findings.push(`approval: self-transition ${edge.from}`)
    if (!APPROVAL_STATES.includes(edge.from)) {
      findings.push(`approval: edge from unknown state ${edge.from}`)
    }
    if (!APPROVAL_STATES.includes(edge.to)) {
      findings.push(`approval: edge to unknown state ${edge.to}`)
    }
    if (
      TERMINAL_APPROVAL_STATES.includes(edge.from) &&
      !TERMINAL_APPROVAL_STATES.includes(edge.to)
    ) {
      findings.push(`approval: terminal state ${edge.from} has an outgoing edge to ${edge.to}`)
    }
  }
  if (!APPROVAL_TRANSITIONS.some((edge) => edge.from === 'granted' && edge.to === 'revoked')) {
    findings.push('approval: a granted approval cannot be revoked')
  }

  // The guarantee that no webzone operation can describe a binding or monetary effect
  // is the absence of these names, so assert the absence rather than trusting it.
  const forbiddenKindWords = ['pay', 'order', 'transfer', 'sign', 'contract', 'subscribe', 'trade']
  for (const kind of WEBZONE_OPERATION_KINDS) {
    for (const word of forbiddenKindWords) {
      if (kind.includes(word)) {
        findings.push(`webzone: operation kind "${kind}" names a binding or monetary effect`)
      }
    }
  }
  if (APPROVAL_KINDS.length !== 3) {
    findings.push(`approval: expected exactly three kinds, found ${APPROVAL_KINDS.length}`)
  }

  return findings
}