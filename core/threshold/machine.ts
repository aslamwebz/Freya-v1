import { THRESHOLD_STATES, isThresholdState, type ThresholdState } from './types'

/**
 * The threshold state machine.
 */

export const THRESHOLD_SIGNALS = [
  'assessment-started',
  'assessment-completed',
  'evidence-collected',
  'evidence-verified',
  'evidence-fabrication-detected',
  'fail-closed-triggered',
  'fail-closed-resolved',
  'decision-proven',
  'decision-not-proven',
  'suspended',
  'resumed',
  'rollback-started',
  'rollback-completed',
  'wake-received',
  'wake-denied',
  'stop-all',
  'reset',
] as const

export type ThresholdSignal = (typeof THRESHOLD_SIGNALS)[number]

export function isThresholdSignal(value: unknown): value is ThresholdSignal {
  return typeof value === 'string' && (THRESHOLD_SIGNALS as readonly string[]).includes(value)
}

export type ThresholdTransitionRefusalCode =
  | 'illegal-transition'
  | 'already-terminal'
  | 'self-transition'
  | 'unknown-state'

export type ThresholdTransitionOutcome =
  | {
      readonly ok: true
      readonly from: ThresholdState
      readonly to: ThresholdState
      readonly signal: ThresholdSignal
      readonly reason: string
    }
  | {
      readonly ok: false
      readonly from: ThresholdState
      readonly signal: ThresholdSignal
      readonly code: ThresholdTransitionRefusalCode
      readonly reason: string
    }

interface TransitionTable {
  readonly UNPROVEN: {
    readonly 'assessment-started': 'ASSESSING'
    readonly 'evidence-collected': 'EVIDENCING'
    readonly 'decision-not-proven': 'UNPROVEN'
    readonly suspended: 'SUSPENDED'
    readonly 'rollback-started': 'ROLLED_BACK'
    readonly 'stop-all': 'SUSPENDED'
    readonly reset: 'UNPROVEN'
  }
  readonly ASSESSING: {
    readonly 'assessment-completed': 'EVALUATING'
    readonly 'evidence-collected': 'EVIDENCING'
    readonly 'fail-closed-triggered': 'SUSPENDED'
    readonly suspended: 'SUSPENDED'
    readonly 'rollback-started': 'ROLLED_BACK'
    readonly 'stop-all': 'SUSPENDED'
    readonly reset: 'UNPROVEN'
  }
  readonly EVIDENCING: {
    readonly 'evidence-verified': 'EVALUATING'
    readonly 'evidence-fabrication-detected': 'SUSPENDED'
    readonly 'fail-closed-triggered': 'SUSPENDED'
    readonly suspended: 'SUSPENDED'
    readonly 'rollback-started': 'ROLLED_BACK'
    readonly 'stop-all': 'SUSPENDED'
    readonly reset: 'UNPROVEN'
  }
  readonly EVALUATING: {
    readonly 'decision-proven': 'PROVEN'
    readonly 'decision-not-proven': 'UNPROVEN'
    readonly 'fail-closed-triggered': 'SUSPENDED'
    readonly suspended: 'SUSPENDED'
    readonly 'rollback-started': 'ROLLED_BACK'
    readonly 'stop-all': 'SUSPENDED'
    readonly reset: 'UNPROVEN'
  }
  readonly PROVEN: {
    readonly suspended: 'SUSPENDED'
    readonly 'rollback-started': 'ROLLED_BACK'
    readonly 'stop-all': 'SUSPENDED'
    readonly reset: 'UNPROVEN'
  }
  readonly SUSPENDED: {
    readonly resumed: 'UNPROVEN'
    readonly 'rollback-started': 'ROLLED_BACK'
    readonly 'stop-all': 'SUSPENDED'
    readonly reset: 'UNPROVEN'
  }
  readonly ROLLED_BACK: {
    readonly 'assessment-started': 'ASSESSING'
    readonly reset: 'UNPROVEN'
  }
}

const TRANSITIONS: TransitionTable = Object.freeze({
  UNPROVEN: Object.freeze({
    'assessment-started': 'ASSESSING',
    'evidence-collected': 'EVIDENCING',
    'decision-not-proven': 'UNPROVEN',
    suspended: 'SUSPENDED',
    'rollback-started': 'ROLLED_BACK',
    'stop-all': 'SUSPENDED',
    reset: 'UNPROVEN',
  }),
  ASSESSING: Object.freeze({
    'assessment-completed': 'EVALUATING',
    'evidence-collected': 'EVIDENCING',
    'fail-closed-triggered': 'SUSPENDED',
    suspended: 'SUSPENDED',
    'rollback-started': 'ROLLED_BACK',
    'stop-all': 'SUSPENDED',
    reset: 'UNPROVEN',
  }),
  EVIDENCING: Object.freeze({
    'evidence-verified': 'EVALUATING',
    'evidence-fabrication-detected': 'SUSPENDED',
    'fail-closed-triggered': 'SUSPENDED',
    suspended: 'SUSPENDED',
    'rollback-started': 'ROLLED_BACK',
    'stop-all': 'SUSPENDED',
    reset: 'UNPROVEN',
  }),
  EVALUATING: Object.freeze({
    'decision-proven': 'PROVEN',
    'decision-not-proven': 'UNPROVEN',
    'fail-closed-triggered': 'SUSPENDED',
    suspended: 'SUSPENDED',
    'rollback-started': 'ROLLED_BACK',
    'stop-all': 'SUSPENDED',
    reset: 'UNPROVEN',
  }),
  PROVEN: Object.freeze({
    suspended: 'SUSPENDED',
    'rollback-started': 'ROLLED_BACK',
    'stop-all': 'SUSPENDED',
    reset: 'UNPROVEN',
  }),
  SUSPENDED: Object.freeze({
    resumed: 'UNPROVEN',
    'rollback-started': 'ROLLED_BACK',
    'stop-all': 'SUSPENDED',
    reset: 'UNPROVEN',
  }),
  ROLLED_BACK: Object.freeze({
    'assessment-started': 'ASSESSING',
    reset: 'UNPROVEN',
  }),
})

const TERMINAL_STATES: readonly ThresholdState[] = Object.freeze(['ROLLED_BACK'])

export function isTerminalThresholdState(state: ThresholdState): boolean {
  return TERMINAL_STATES.includes(state)
}

export function allThresholdTransitions(): ReadonlyArray<{
  readonly from: ThresholdState
  readonly signal: ThresholdSignal
  readonly to: ThresholdState
}> {
  const result: Array<{
    readonly from: ThresholdState
    readonly signal: ThresholdSignal
    readonly to: ThresholdState
  }> = []
  for (const from of THRESHOLD_STATES) {
    for (const signal of THRESHOLD_SIGNALS) {
      const to = TRANSITIONS[from][signal as keyof (typeof TRANSITIONS)[typeof from]]
      if (to !== undefined) {
        result.push({ from, signal, to })
      }
    }
  }
  return result
}

export function auditThresholdTable(): {
  readonly ok: boolean
  readonly issues: readonly string[]
} {
  const issues: string[] = []
  for (const from of THRESHOLD_STATES) {
    for (const signal of THRESHOLD_SIGNALS) {
      const to = TRANSITIONS[from][signal as keyof (typeof TRANSITIONS)[typeof from]]
      if (to !== undefined && !isThresholdState(to)) {
        issues.push(`${from} + ${signal} -> ${to} (unknown target state)`)
      }
    }
  }
  return { ok: issues.length === 0, issues }
}

export function thresholdSignalReason(signal: ThresholdSignal): string {
  switch (signal) {
    case 'assessment-started':
      return 'A maturity assessment has started.'
    case 'assessment-completed':
      return 'A maturity assessment has completed.'
    case 'evidence-collected':
      return 'Evidence has been collected.'
    case 'evidence-verified':
      return 'Evidence has been verified.'
    case 'evidence-fabrication-detected':
      return 'Evidence fabrication was detected.'
    case 'fail-closed-triggered':
      return 'A fail-closed condition was triggered.'
    case 'fail-closed-resolved':
      return 'A fail-closed condition was resolved.'
    case 'decision-proven':
      return 'Maturity has been proven.'
    case 'decision-not-proven':
      return 'Maturity has not been proven.'
    case 'suspended':
      return 'The threshold has been suspended.'
    case 'resumed':
      return 'The threshold has been resumed.'
    case 'rollback-started':
      return 'A rollback has started.'
    case 'rollback-completed':
      return 'A rollback has completed.'
    case 'wake-received':
      return 'A wake was received.'
    case 'wake-denied':
      return 'A wake was denied.'
    case 'stop-all':
      return 'STOP ALL was activated.'
    case 'reset':
      return 'The subsystem was reset.'
  }
}

export function transition(
  from: ThresholdState,
  signal: ThresholdSignal,
): ThresholdTransitionOutcome {
  if (!isThresholdState(from)) {
    return {
      ok: false,
      from: from as ThresholdState,
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

  return {
    ok: true,
    from,
    to,
    signal,
    reason: thresholdSignalReason(signal),
  }
}

export function signalsFrom(state: ThresholdState): readonly ThresholdSignal[] {
  return THRESHOLD_SIGNALS.filter(
    (signal) =>
      TRANSITIONS[state][signal as keyof (typeof TRANSITIONS)[typeof state]] !== undefined,
  )
}
