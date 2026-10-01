import { describe, expect, it } from 'vitest'
import type {
  HandsActionResult,
  HandsObservationRecord,
  HandsVerificationResult,
} from '../../../core/hands/contract'
import {
  canRecordObservation,
  canRequestVerification,
  handsLifecycleState,
  handsTerminalOutcome,
  isActionTerminal,
  isVerificationTerminal,
  isValidActionTransition,
  isValidVerificationTransition,
} from '../../../core/hands/lifecycle'

function makeAction(overrides: Partial<HandsActionResult> = {}): HandsActionResult {
  return {
    actionId: 'action-1',
    status: 'running',
    startedAt: '2026-01-01T00:00:00.000Z',
    settledAt: null,
    durationMs: null,
    reason: null,
    observationIds: [],
    ...overrides,
  }
}

function makeObservation(overrides: Partial<HandsObservationRecord> = {}): HandsObservationRecord {
  return {
    observationId: 'obs-1',
    actionId: 'action-1',
    kind: 'result',
    summary: 'did the thing',
    data: {},
    recordedAt: '2026-01-01T00:00:01.000Z',
    ...overrides,
  }
}

function makeVerification(
  overrides: Partial<HandsVerificationResult> = {},
): HandsVerificationResult {
  return {
    verificationId: 'ver-1',
    actionId: 'action-1',
    status: 'requested',
    reason: null,
    verdictAt: null,
    ...overrides,
  }
}

describe('hands lifecycle state', () => {
  it('is not verified without a verification result', () => {
    const action = makeAction({ status: 'completed' })
    const state = handsLifecycleState(action, [], [])
    expect(state.verified).toBe(false)
    expect(state.verificationStatus).toBeNull()
  })

  it('is not verified with a failed verification', () => {
    const action = makeAction({ status: 'completed' })
    const verification = makeVerification({ status: 'failed', reason: 'did not match' })
    const state = handsLifecycleState(action, [], [verification])
    expect(state.verified).toBe(false)
    expect(state.verificationStatus).toBe('failed')
  })

  it('is verified with a passing verification', () => {
    const action = makeAction({ status: 'completed' })
    const verification = makeVerification({ status: 'passed', reason: 'matched' })
    const state = handsLifecycleState(action, [], [verification])
    expect(state.verified).toBe(true)
    expect(state.verificationStatus).toBe('passed')
  })

  it('is not verified when action is running even with a passing verification', () => {
    const action = makeAction({ status: 'running' })
    const verification = makeVerification({ status: 'passed', reason: 'matched' })
    const state = handsLifecycleState(action, [], [verification])
    expect(state.verified).toBe(true)
    expect(state.actionStatus).toBe('running')
  })

  it('counts observations', () => {
    const action = makeAction({ status: 'running' })
    const obs1 = makeObservation({ observationId: 'obs-1' })
    const obs2 = makeObservation({ observationId: 'obs-2' })
    const state = handsLifecycleState(action, [obs1, obs2], [])
    expect(state.observationCount).toBe(2)
  })
})

describe('canRecordObservation', () => {
  it('allows recording when action is running', () => {
    expect(canRecordObservation('running')).toBe(true)
  })

  it('forbids recording when action is terminal', () => {
    expect(canRecordObservation('completed')).toBe(false)
    expect(canRecordObservation('failed')).toBe(false)
    expect(canRecordObservation('cancelled')).toBe(false)
    expect(canRecordObservation('timed_out')).toBe(false)
  })
})

describe('canRequestVerification', () => {
  it('allows verification when action is terminal and has observations', () => {
    expect(canRequestVerification('completed', 1)).toBe(true)
    expect(canRequestVerification('failed', 1)).toBe(true)
  })

  it('forbids verification when action is running', () => {
    expect(canRequestVerification('running', 1)).toBe(false)
  })

  it('forbids verification when there are no observations', () => {
    expect(canRequestVerification('completed', 0)).toBe(false)
  })
})

describe('action transitions', () => {
  it('validates transitions', () => {
    expect(isValidActionTransition('running', 'completed')).toBe(true)
    expect(isValidActionTransition('completed', 'running')).toBe(false)
  })
})

describe('verification transitions', () => {
  it('validates transitions', () => {
    expect(isValidVerificationTransition('requested', 'passed')).toBe(true)
    expect(isValidVerificationTransition('passed', 'requested')).toBe(false)
  })
})

describe('terminal checks', () => {
  it('identifies terminal action statuses', () => {
    expect(isActionTerminal('running')).toBe(false)
    expect(isActionTerminal('completed')).toBe(true)
    expect(isActionTerminal('failed')).toBe(true)
    expect(isActionTerminal('cancelled')).toBe(true)
    expect(isActionTerminal('timed_out')).toBe(true)
  })

  it('identifies terminal verification statuses', () => {
    expect(isVerificationTerminal('requested')).toBe(false)
    expect(isVerificationTerminal('passed')).toBe(true)
    expect(isVerificationTerminal('failed')).toBe(true)
  })
})

describe('hands terminal outcome', () => {
  it('is verified when a verification passed', () => {
    const action = makeAction({ status: 'completed' })
    const verification = makeVerification({ status: 'passed', reason: 'matched' })
    const outcome = handsTerminalOutcome(action, [verification])
    expect(outcome.kind).toBe('verified')
    if (outcome.kind === 'verified') {
      expect(outcome.verification.verificationId).toBe('ver-1')
    }
  })

  it('is unverified when no verification passed', () => {
    const action = makeAction({ status: 'completed' })
    const outcome = handsTerminalOutcome(action, [])
    expect(outcome.kind).toBe('unverified')
  })

  it('is unverified when verification failed', () => {
    const action = makeAction({ status: 'completed' })
    const verification = makeVerification({ status: 'failed', reason: 'did not match' })
    const outcome = handsTerminalOutcome(action, [verification])
    expect(outcome.kind).toBe('unverified')
  })

  it('is unverified when action failed', () => {
    const action = makeAction({ status: 'failed', reason: 'capability error' })
    const outcome = handsTerminalOutcome(action, [])
    expect(outcome.kind).toBe('unverified')
  })
})

describe('impossible to mark verified without verifier result', () => {
  it('cannot be verified with zero verification results', () => {
    const action = makeAction({ status: 'completed' })
    const state = handsLifecycleState(action, [makeObservation()], [])
    expect(state.verified).toBe(false)
  })

  it('cannot be verified with only failed verifications', () => {
    const action = makeAction({ status: 'completed' })
    const verifications = [
      makeVerification({ verificationId: 'ver-1', status: 'failed', reason: 'no' }),
      makeVerification({ verificationId: 'ver-2', status: 'failed', reason: 'still no' }),
    ]
    const state = handsLifecycleState(action, [makeObservation()], verifications)
    expect(state.verified).toBe(false)
  })

  it('is verified only with a passing verification', () => {
    const action = makeAction({ status: 'completed' })
    const verifications = [
      makeVerification({ verificationId: 'ver-1', status: 'failed', reason: 'no' }),
      makeVerification({ verificationId: 'ver-2', status: 'passed', reason: 'yes' }),
    ]
    const state = handsLifecycleState(action, [makeObservation()], verifications)
    expect(state.verified).toBe(true)
  })
})
