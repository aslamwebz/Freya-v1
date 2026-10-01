import { describe, expect, it } from 'vitest'
import {
  HANDS_ACTION_STATUSES,
  HANDS_ACTION_TERMINAL_STATUSES,
  HANDS_CAPABILITY_KINDS,
  HANDS_LIMITS,
  HANDS_OBSERVATION_KINDS,
  HANDS_REFUSAL_CODES,
  HANDS_REFUSAL_REASONS,
  HANDS_VERIFICATION_STATUSES,
  canTransitionHandsAction,
  canTransitionHandsVerification,
  handsLimits,
  isAnyHandsCapabilityKind,
  isDeferredHandsCapabilityKind,
  isHandsCapabilityKind,
  isTerminalHandsActionStatus,
  isTerminalHandsVerificationStatus,
} from '../../../core/hands/types'

describe('hands capability kinds', () => {
  it('recognises supported kinds', () => {
    expect(isHandsCapabilityKind('browser')).toBe(true)
    expect(isHandsCapabilityKind('desktop')).toBe(true)
    expect(isHandsCapabilityKind('file')).toBe(true)
    expect(isHandsCapabilityKind('shell')).toBe(true)
    expect(isHandsCapabilityKind('network')).toBe(true)
  })

  it('rejects unknown kinds', () => {
    expect(isHandsCapabilityKind('unknown')).toBe(false)
    expect(isHandsCapabilityKind('')).toBe(false)
    expect(isHandsCapabilityKind(42)).toBe(false)
    expect(isHandsCapabilityKind(null)).toBe(false)
    expect(isHandsCapabilityKind(undefined)).toBe(false)
  })

  it('recognises deferred kinds', () => {
    expect(isDeferredHandsCapabilityKind('clipboard')).toBe(true)
    expect(isDeferredHandsCapabilityKind('media')).toBe(true)
    expect(isDeferredHandsCapabilityKind('browser')).toBe(false)
  })

  it('recognises any kind', () => {
    expect(isAnyHandsCapabilityKind('browser')).toBe(true)
    expect(isAnyHandsCapabilityKind('clipboard')).toBe(true)
    expect(isAnyHandsCapabilityKind('unknown')).toBe(false)
  })

  it('has a closed set of kinds', () => {
    expect(HANDS_CAPABILITY_KINDS).toEqual(['browser', 'desktop', 'file', 'shell', 'network'])
  })
})

describe('hands action statuses', () => {
  it('has the expected statuses', () => {
    expect(HANDS_ACTION_STATUSES).toEqual(['running', 'completed', 'failed', 'cancelled', 'timed_out'])
  })

  it('identifies terminal statuses', () => {
    expect(isTerminalHandsActionStatus('running')).toBe(false)
    expect(isTerminalHandsActionStatus('completed')).toBe(true)
    expect(isTerminalHandsActionStatus('failed')).toBe(true)
    expect(isTerminalHandsActionStatus('cancelled')).toBe(true)
    expect(isTerminalHandsActionStatus('timed_out')).toBe(true)
  })

  it('has the expected terminal statuses', () => {
    expect(HANDS_ACTION_TERMINAL_STATUSES).toEqual(['completed', 'failed', 'cancelled', 'timed_out'])
  })
})

describe('hands observation kinds', () => {
  it('has the expected kinds', () => {
    expect(HANDS_OBSERVATION_KINDS).toEqual(['result', 'exit', 'change', 'failure', 'input'])
  })
})

describe('hands verification statuses', () => {
  it('has the expected statuses', () => {
    expect(HANDS_VERIFICATION_STATUSES).toEqual(['requested', 'passed', 'failed'])
  })

  it('identifies terminal statuses', () => {
    expect(isTerminalHandsVerificationStatus('requested')).toBe(false)
    expect(isTerminalHandsVerificationStatus('passed')).toBe(true)
    expect(isTerminalHandsVerificationStatus('failed')).toBe(true)
  })
})

describe('hands refusal codes', () => {
  it('has a closed set of codes', () => {
    expect(HANDS_REFUSAL_CODES).toEqual([
      'capability_unknown',
      'capability_deferred',
      'capability_unauthorized',
      'invalid_envelope',
      'invalid_request',
      'budget_exceeded',
      'timeout_exceeded',
    ])
  })

  it('has a reason for every code', () => {
    for (const code of HANDS_REFUSAL_CODES) {
      expect(HANDS_REFUSAL_REASONS[code]).toBeTruthy()
      expect(typeof HANDS_REFUSAL_REASONS[code]).toBe('string')
    }
  })
})

describe('hands limits', () => {
  it('has the expected defaults', () => {
    expect(HANDS_LIMITS.maxActions).toBe(256)
    expect(HANDS_LIMITS.maxObservationsPerAction).toBe(8)
    expect(HANDS_LIMITS.maxVerificationsPerAction).toBe(4)
    expect(HANDS_LIMITS.maxActionTimeoutMs).toBe(5 * 60_000)
  })

  it('clamps overrides to the ceiling', () => {
    const limits = handsLimits({ maxActions: 10000 })
    expect(limits.maxActions).toBe(HANDS_LIMITS.maxActions)
  })

  it('allows lowering limits', () => {
    const limits = handsLimits({ maxActions: 10 })
    expect(limits.maxActions).toBe(10)
  })

  it('rejects invalid overrides', () => {
    const limits = handsLimits({ maxActions: -1 })
    expect(limits.maxActions).toBe(1)
  })
})

describe('hands action transitions', () => {
  it('allows running to terminal states', () => {
    expect(canTransitionHandsAction('running', 'completed')).toBe(true)
    expect(canTransitionHandsAction('running', 'failed')).toBe(true)
    expect(canTransitionHandsAction('running', 'cancelled')).toBe(true)
    expect(canTransitionHandsAction('running', 'timed_out')).toBe(true)
  })

  it('forbids terminal to any state', () => {
    expect(canTransitionHandsAction('completed', 'running')).toBe(false)
    expect(canTransitionHandsAction('failed', 'running')).toBe(false)
    expect(canTransitionHandsAction('cancelled', 'running')).toBe(false)
    expect(canTransitionHandsAction('timed_out', 'running')).toBe(false)
  })

  it('forbids running to running', () => {
    expect(canTransitionHandsAction('running', 'running')).toBe(false)
  })
})

describe('hands verification transitions', () => {
  it('allows requested to terminal states', () => {
    expect(canTransitionHandsVerification('requested', 'passed')).toBe(true)
    expect(canTransitionHandsVerification('requested', 'failed')).toBe(true)
  })

  it('forbids terminal to any state', () => {
    expect(canTransitionHandsVerification('passed', 'requested')).toBe(false)
    expect(canTransitionHandsVerification('failed', 'requested')).toBe(false)
  })
})
