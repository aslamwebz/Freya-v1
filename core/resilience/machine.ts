import { RESILIENCE_STATES, isResilienceState, type ResilienceState } from './types'

/**
 * The resilience state machine.
 */

export const RESILIENCE_SIGNALS = [
  'failure-detected',
  'recovery-started',
  'recovery-succeeded',
  'recovery-partial',
  'recovery-failed',
  'repair-started',
  'repair-succeeded',
  'repair-failed',
  'degraded-entered',
  'degraded-exited',
  'continuation-decided',
  'stop-all',
  'reset',
] as const

export type ResilienceSignal = (typeof RESILIENCE_SIGNALS)[number]

export function isResilienceSignal(value: unknown): value is ResilienceSignal {
  return typeof value === 'string' && (RESILIENCE_SIGNALS as readonly string[]).includes(value)
}

export type ResilienceTransitionRefusalCode =
  | 'illegal-transition'
  | 'already-terminal'
  | 'self-transition'
  | 'unknown-state'

export type ResilienceTransitionOutcome =
  | {
      readonly ok: true
      readonly from: ResilienceState
      readonly to: ResilienceState
      readonly signal: ResilienceSignal
      readonly reason: string
    }
  | {
      readonly ok: false
      readonly from: ResilienceState
      readonly signal: ResilienceSignal
      readonly code: ResilienceTransitionRefusalCode
      readonly reason: string
    }

interface TransitionTable {
  readonly HEALTHY: {
    readonly 'failure-detected': 'RECOVERING'
    readonly 'repair-started': 'REPAIRING'
    readonly 'degraded-entered': 'DEGRADED'
    readonly 'stop-all': 'FAILED'
    readonly reset: 'HEALTHY'
  }
  readonly DEGRADED: {
    readonly 'failure-detected': 'RECOVERING'
    readonly 'recovery-started': 'RECOVERING'
    readonly 'recovery-succeeded': 'HEALTHY'
    readonly 'recovery-partial': 'DEGRADED'
    readonly 'recovery-failed': 'FAILED'
    readonly 'repair-started': 'REPAIRING'
    readonly 'repair-succeeded': 'HEALTHY'
    readonly 'repair-failed': 'DEGRADED'
    readonly 'degraded-exited': 'HEALTHY'
    readonly 'stop-all': 'FAILED'
    readonly reset: 'HEALTHY'
  }
  readonly RECOVERING: {
    readonly 'recovery-succeeded': 'HEALTHY'
    readonly 'recovery-partial': 'DEGRADED'
    readonly 'recovery-failed': 'FAILED'
    readonly 'repair-started': 'REPAIRING'
    readonly 'degraded-entered': 'DEGRADED'
    readonly 'stop-all': 'FAILED'
    readonly reset: 'HEALTHY'
  }
  readonly REPAIRING: {
    readonly 'repair-succeeded': 'HEALTHY'
    readonly 'repair-failed': 'FAILED'
    readonly 'recovery-started': 'RECOVERING'
    readonly 'degraded-entered': 'DEGRADED'
    readonly 'stop-all': 'FAILED'
    readonly reset: 'HEALTHY'
  }
  readonly FAILED: {
    readonly reset: 'HEALTHY'
  }
}

const TRANSITIONS: TransitionTable = Object.freeze({
  HEALTHY: Object.freeze({
    'failure-detected': 'RECOVERING',
    'repair-started': 'REPAIRING',
    'degraded-entered': 'DEGRADED',
    'stop-all': 'FAILED',
    reset: 'HEALTHY',
  }),
  DEGRADED: Object.freeze({
    'failure-detected': 'RECOVERING',
    'recovery-started': 'RECOVERING',
    'recovery-succeeded': 'HEALTHY',
    'recovery-partial': 'DEGRADED',
    'recovery-failed': 'FAILED',
    'repair-started': 'REPAIRING',
    'repair-succeeded': 'HEALTHY',
    'repair-failed': 'DEGRADED',
    'degraded-exited': 'HEALTHY',
    'stop-all': 'FAILED',
    reset: 'HEALTHY',
  }),
  RECOVERING: Object.freeze({
    'recovery-succeeded': 'HEALTHY',
    'recovery-partial': 'DEGRADED',
    'recovery-failed': 'FAILED',
    'repair-started': 'REPAIRING',
    'degraded-entered': 'DEGRADED',
    'stop-all': 'FAILED',
    reset: 'HEALTHY',
  }),
  REPAIRING: Object.freeze({
    'repair-succeeded': 'HEALTHY',
    'repair-failed': 'FAILED',
    'recovery-started': 'RECOVERING',
    'degraded-entered': 'DEGRADED',
    'stop-all': 'FAILED',
    reset: 'HEALTHY',
  }),
  FAILED: Object.freeze({
    reset: 'HEALTHY',
  }),
})

const TERMINAL_STATES: readonly ResilienceState[] = Object.freeze(['FAILED'])

export function isTerminalResilienceState(state: ResilienceState): boolean {
  return TERMINAL_STATES.includes(state)
}

export function allResilienceTransitions(): ReadonlyArray<{
  readonly from: ResilienceState
  readonly signal: ResilienceSignal
  readonly to: ResilienceState
}> {
  const result: Array<{
    readonly from: ResilienceState
    readonly signal: ResilienceSignal
    readonly to: ResilienceState
  }> = []
  for (const from of RESILIENCE_STATES) {
    for (const signal of RESILIENCE_SIGNALS) {
      const to = TRANSITIONS[from][signal as keyof (typeof TRANSITIONS)[typeof from]]
      if (to !== undefined) {
        result.push({ from, signal, to })
      }
    }
  }
  return result
}

export function auditResilienceTable(): {
  readonly ok: boolean
  readonly issues: readonly string[]
} {
  const issues: string[] = []
  for (const from of RESILIENCE_STATES) {
    for (const signal of RESILIENCE_SIGNALS) {
      const to = TRANSITIONS[from][signal as keyof (typeof TRANSITIONS)[typeof from]]
      if (to !== undefined && !isResilienceState(to)) {
        issues.push(`${from} + ${signal} -> ${to} (unknown target state)`)
      }
    }
  }
  return { ok: issues.length === 0, issues }
}

export function resilienceSignalReason(signal: ResilienceSignal): string {
  switch (signal) {
    case 'failure-detected':
      return 'A failure was detected and recovery is needed.'
    case 'recovery-started':
      return 'Recovery has started.'
    case 'recovery-succeeded':
      return 'Recovery succeeded.'
    case 'recovery-partial':
      return 'Recovery partially succeeded; some capability is reduced.'
    case 'recovery-failed':
      return 'Recovery failed.'
    case 'repair-started':
      return 'Repair has started.'
    case 'repair-succeeded':
      return 'Repair succeeded.'
    case 'repair-failed':
      return 'Repair failed.'
    case 'degraded-entered':
      return 'Degraded mode was entered.'
    case 'degraded-exited':
      return 'Degraded mode was exited.'
    case 'continuation-decided':
      return 'A continuation decision was made.'
    case 'stop-all':
      return 'STOP ALL was activated.'
    case 'reset':
      return 'The subsystem was reset.'
  }
}

export function transition(
  from: ResilienceState,
  signal: ResilienceSignal,
): ResilienceTransitionOutcome {
  if (!isResilienceState(from)) {
    return {
      ok: false,
      from: from as ResilienceState,
      signal,
      code: 'unknown-state',
      reason: `Unknown state: ${String(from)}`,
    }
  }

  const to = TRANSITIONS[from][signal as keyof (typeof TRANSITIONS)[typeof from]]
  if (to === undefined) {
    return {
      ok: false,
      from,
      signal,
      code: 'illegal-transition',
      reason: `Cannot apply ${signal} in state ${from}`,
    }
  }

  if (to === from) {
    return {
      ok: false,
      from,
      signal,
      code: 'self-transition',
      reason: `${signal} does not change state ${from}`,
    }
  }

  if (isTerminalResilienceState(from) && signal !== 'reset') {
    return {
      ok: false,
      from,
      signal,
      code: 'already-terminal',
      reason: `State ${from} is terminal; only reset can leave it`,
    }
  }

  return {
    ok: true,
    from,
    to,
    signal,
    reason: resilienceSignalReason(signal),
  }
}

export function signalsFrom(state: ResilienceState): readonly ResilienceSignal[] {
  return RESILIENCE_SIGNALS.filter(
    (signal) => TRANSITIONS[state][signal as keyof (typeof TRANSITIONS)[typeof state]] !== undefined,
  )
}
