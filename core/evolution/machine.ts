import { EVOLUTION_STATES, isEvolutionState, type EvolutionState } from './types'

/**
 * The evolution state machine.
 *
 * The closed set of signals that may move the machine, and the transition
 * table that is the only authority over which state may follow which.
 *
 * ```
 *   STABLE → EVALUATING → IMPROVING → VERIFYING → STAGING → STABLE
 *      │          │           │           │          │
 *      └──────────┴───────────┴───────────┴──────────┴──→ FAILED
 * ```
 *
 * `FAILED` is terminal. There is no edge out of it, because an evolution
 * subsystem that has failed must not quietly resume — it must be reset by an
 * explicit owner act, the same rule Phase 37 uses.
 */
export const EVOLUTION_SIGNALS = [
  'wake-accepted',
  'evidence-sufficient',
  'evidence-insufficient',
  'improvement-ready',
  'improvement-applied',
  'verification-passed',
  'verification-failed',
  'drift-detected',
  'stop-all',
  'reset',
] as const

export type EvolutionSignal = (typeof EVOLUTION_SIGNALS)[number]

export function isEvolutionSignal(value: unknown): value is EvolutionSignal {
  return typeof value === 'string' && (EVOLUTION_SIGNALS as readonly string[]).includes(value)
}

export const EVOLUTION_TRANSITIONS: Readonly<Record<EvolutionState, readonly EvolutionState[]>> =
  Object.freeze({
    STABLE: Object.freeze(['EVALUATING', 'FAILED'] as const),
    EVALUATING: Object.freeze(['IMPROVING', 'STABLE', 'FAILED'] as const),
    IMPROVING: Object.freeze(['VERIFYING', 'STABLE', 'FAILED'] as const),
    VERIFYING: Object.freeze(['STAGING', 'STABLE', 'FAILED'] as const),
    STAGING: Object.freeze(['STABLE', 'FAILED'] as const),
    FAILED: Object.freeze(['STABLE'] as const),
  })

export function canTransitionEvolution(from: EvolutionState, to: EvolutionState): boolean {
  return EVOLUTION_TRANSITIONS[from].includes(to)
}

export interface EvolutionTransition {
  readonly ok: true
  readonly from: EvolutionState
  readonly to: EvolutionState
  readonly signal: EvolutionSignal
}

export interface EvolutionTransitionRefusal {
  readonly ok: false
  readonly from: EvolutionState
  readonly to: EvolutionState
  readonly signal: EvolutionSignal
  readonly reason: string
}

export type EvolutionTransitionResult = EvolutionTransition | EvolutionTransitionRefusal

/**
 * Attempt a transition.
 *
 * The signal is recorded so a reader can see *why* a state changed, not merely
 * that it did. A refusal carries the reason rather than being silent, because
 * a state machine that refuses quietly is a state machine nobody can debug.
 */
export function transition(
  from: EvolutionState,
  signal: EvolutionSignal,
): EvolutionTransitionResult {
  const to = stateForSignal(from, signal)
  if (to === null) {
    return {
      ok: false,
      from,
      to: from,
      signal,
      reason: `a ${from} state cannot receive the ${signal} signal`,
    }
  }
  if (!canTransitionEvolution(from, to)) {
    return {
      ok: false,
      from,
      to,
      signal,
      reason: `a ${from} state cannot become ${to}`,
    }
  }
  return { ok: true, from, to, signal }
}

/**
 * The state a signal moves a machine to, or null when the signal does not apply.
 *
 * Written as a table rather than scattered conditions, so the whole machine can
 * be read at once and checked against the diagram in the architecture spec.
 */
function stateForSignal(from: EvolutionState, signal: EvolutionSignal): EvolutionState | null {
  if (signal === 'stop-all') return 'FAILED'
  if (signal === 'reset') return from === 'FAILED' ? 'STABLE' : null
  switch (from) {
    case 'STABLE':
      return signal === 'wake-accepted' ? 'EVALUATING' : null
    case 'EVALUATING':
      if (signal === 'evidence-sufficient') return 'IMPROVING'
      if (signal === 'evidence-insufficient') return 'STABLE'
      return null
    case 'IMPROVING':
      if (signal === 'improvement-ready') return 'VERIFYING'
      if (signal === 'evidence-insufficient') return 'STABLE'
      return null
    case 'VERIFYING':
      if (signal === 'verification-passed') return 'STAGING'
      if (signal === 'verification-failed') return 'STABLE'
      return null
    case 'STAGING':
      if (signal === 'improvement-applied') return 'STABLE'
      if (signal === 'drift-detected') return 'STABLE'
      return null
    case 'FAILED':
      return null
    default: {
      const exhaustive: never = from
      return exhaustive !== exhaustive ? null : null
    }
  }
}

export function isTerminalEvolutionState(state: EvolutionState): boolean {
  return state === 'FAILED'
}

export { EVOLUTION_STATES, isEvolutionState }
