import { SOVEREIGNTY_STATES, isSovereigntyState, type SovereigntyState } from './types'

/**
 * The sovereignty state machine.
 */

export const SOVEREIGNTY_SIGNALS = [
  'wake-received',
  'provider-routed',
  'provider-failed',
  'fallback-succeeded',
  'fallback-failed',
  'offline-started',
  'offline-ended',
  'export-started',
  'export-completed',
  'import-started',
  'import-completed',
  'degraded-entered',
  'degraded-exited',
  'stop-all',
  'reset',
] as const

export type SovereigntySignal = (typeof SOVEREIGNTY_SIGNALS)[number]

export function isSovereigntySignal(value: unknown): value is SovereigntySignal {
  return typeof value === 'string' && (SOVEREIGNTY_SIGNALS as readonly string[]).includes(value)
}

export type SovereigntyTransitionRefusalCode =
  | 'illegal-transition'
  | 'already-terminal'
  | 'self-transition'
  | 'unknown-state'

export type SovereigntyTransitionOutcome =
  | {
      readonly ok: true
      readonly from: SovereigntyState
      readonly to: SovereigntyState
      readonly signal: SovereigntySignal
      readonly reason: string
    }
  | {
      readonly ok: false
      readonly from: SovereigntyState
      readonly signal: SovereigntySignal
      readonly code: SovereigntyTransitionRefusalCode
      readonly reason: string
    }

interface TransitionTable {
  readonly ONLINE: {
    readonly 'provider-failed': 'DEGRADED'
    readonly 'offline-started': 'OFFLINE'
    readonly 'export-started': 'PORTING'
    readonly 'import-started': 'PORTING'
    readonly 'degraded-entered': 'DEGRADED'
    readonly 'stop-all': 'FAILED'
    readonly reset: 'ONLINE'
  }
  readonly OFFLINE: {
    readonly 'offline-ended': 'ONLINE'
    readonly 'provider-failed': 'DEGRADED'
    readonly 'degraded-entered': 'DEGRADED'
    readonly 'stop-all': 'FAILED'
    readonly reset: 'ONLINE'
  }
  readonly PORTING: {
    readonly 'export-completed': 'ONLINE'
    readonly 'import-completed': 'ONLINE'
    readonly 'provider-failed': 'DEGRADED'
    readonly 'degraded-entered': 'DEGRADED'
    readonly 'stop-all': 'FAILED'
    readonly reset: 'ONLINE'
  }
  readonly DEGRADED: {
    readonly 'fallback-succeeded': 'ONLINE'
    readonly 'fallback-failed': 'FAILED'
    readonly 'degraded-exited': 'ONLINE'
    readonly 'offline-started': 'OFFLINE'
    readonly 'stop-all': 'FAILED'
    readonly reset: 'ONLINE'
  }
  readonly FAILED: {
    readonly reset: 'ONLINE'
  }
}

const TRANSITIONS: TransitionTable = Object.freeze({
  ONLINE: Object.freeze({
    'provider-failed': 'DEGRADED',
    'offline-started': 'OFFLINE',
    'export-started': 'PORTING',
    'import-started': 'PORTING',
    'degraded-entered': 'DEGRADED',
    'stop-all': 'FAILED',
    reset: 'ONLINE',
  }),
  OFFLINE: Object.freeze({
    'offline-ended': 'ONLINE',
    'provider-failed': 'DEGRADED',
    'degraded-entered': 'DEGRADED',
    'stop-all': 'FAILED',
    reset: 'ONLINE',
  }),
  PORTING: Object.freeze({
    'export-completed': 'ONLINE',
    'import-completed': 'ONLINE',
    'provider-failed': 'DEGRADED',
    'degraded-entered': 'DEGRADED',
    'stop-all': 'FAILED',
    reset: 'ONLINE',
  }),
  DEGRADED: Object.freeze({
    'fallback-succeeded': 'ONLINE',
    'fallback-failed': 'FAILED',
    'degraded-exited': 'ONLINE',
    'offline-started': 'OFFLINE',
    'stop-all': 'FAILED',
    reset: 'ONLINE',
  }),
  FAILED: Object.freeze({
    reset: 'ONLINE',
  }),
})

const TERMINAL_STATES: readonly SovereigntyState[] = Object.freeze(['FAILED'])

export function isTerminalSovereigntyState(state: SovereigntyState): boolean {
  return TERMINAL_STATES.includes(state)
}

export function allSovereigntyTransitions(): ReadonlyArray<{
  readonly from: SovereigntyState
  readonly signal: SovereigntySignal
  readonly to: SovereigntyState
}> {
  const result: Array<{
    readonly from: SovereigntyState
    readonly signal: SovereigntySignal
    readonly to: SovereigntyState
  }> = []
  for (const from of SOVEREIGNTY_STATES) {
    for (const signal of SOVEREIGNTY_SIGNALS) {
      const to = TRANSITIONS[from][signal as keyof (typeof TRANSITIONS)[typeof from]]
      if (to !== undefined) {
        result.push({ from, signal, to })
      }
    }
  }
  return result
}

export function auditSovereigntyTable(): {
  readonly ok: boolean
  readonly issues: readonly string[]
} {
  const issues: string[] = []
  for (const from of SOVEREIGNTY_STATES) {
    for (const signal of SOVEREIGNTY_SIGNALS) {
      const to = TRANSITIONS[from][signal as keyof (typeof TRANSITIONS)[typeof from]]
      if (to !== undefined && !isSovereigntyState(to)) {
        issues.push(`${from} + ${signal} -> ${to} (unknown target state)`)
      }
    }
  }
  return { ok: issues.length === 0, issues }
}

export function sovereigntySignalReason(signal: SovereigntySignal): string {
  switch (signal) {
    case 'wake-received':
      return 'A wake was received.'
    case 'provider-routed':
      return 'A provider was selected for routing.'
    case 'provider-failed':
      return 'A provider failed.'
    case 'fallback-succeeded':
      return 'Fallback to an alternative provider succeeded.'
    case 'fallback-failed':
      return 'Fallback to an alternative provider failed.'
    case 'offline-started':
      return 'Offline mode was started.'
    case 'offline-ended':
      return 'Offline mode was ended.'
    case 'export-started':
      return 'Data export was started.'
    case 'export-completed':
      return 'Data export was completed.'
    case 'import-started':
      return 'Data import was started.'
    case 'import-completed':
      return 'Data import was completed.'
    case 'degraded-entered':
      return 'Degraded mode was entered.'
    case 'degraded-exited':
      return 'Degraded mode was exited.'
    case 'stop-all':
      return 'STOP ALL was activated.'
    case 'reset':
      return 'The subsystem was reset.'
  }
}

export function transition(
  from: SovereigntyState,
  signal: SovereigntySignal,
): SovereigntyTransitionOutcome {
  if (!isSovereigntyState(from)) {
    return {
      ok: false,
      from: from as SovereigntyState,
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

  if (isTerminalSovereigntyState(from) && signal !== 'reset') {
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
    reason: sovereigntySignalReason(signal),
  }
}

export function signalsFrom(state: SovereigntyState): readonly SovereigntySignal[] {
  return SOVEREIGNTY_SIGNALS.filter(
    (signal) =>
      TRANSITIONS[state][signal as keyof (typeof TRANSITIONS)[typeof state]] !== undefined,
  )
}
