import { describe, expect, it } from 'vitest'
import type {
  HandsActionResult,
  HandsObservationRecord,
  HandsVerificationResult,
} from '../../../core/hands/contract'
import {
  ABSENT_HANDS_PROJECTION,
  initialHandsState,
  isActionVerified,
  observationsForAction,
  projectHands,
  recordActionResult,
  recordObservation,
  recordRefusal,
  recordVerificationResult,
  verificationsForAction,
  type HandsState,
} from '../../../core/hands/state'

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

function makeObservation(
  overrides: Partial<HandsObservationRecord> = {},
): HandsObservationRecord {
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

describe('initialHandsState', () => {
  it('has empty collections', () => {
    const state = initialHandsState()
    expect(state.actions.size).toBe(0)
    expect(state.observations.size).toBe(0)
    expect(state.verifications.size).toBe(0)
    expect(state.refusals.size).toBe(0)
    expect(state.verifiedActions.size).toBe(0)
  })
})

describe('recordActionResult', () => {
  it('adds a new action', () => {
    const state = initialHandsState()
    const action = makeAction()
    const next = recordActionResult(state, action)
    expect(next.actions.size).toBe(1)
    expect(next.actions.get('action-1')).toEqual(action)
  })

  it('preserves existing action on duplicate', () => {
    const state = initialHandsState()
    const action = makeAction()
    const next = recordActionResult(state, action)
    const duplicate = recordActionResult(next, makeAction({ status: 'completed' }))
    expect(duplicate.actions.get('action-1')?.status).toBe('running')
  })
})

describe('recordObservation', () => {
  it('adds an observation for a running action', () => {
    const state = recordActionResult(initialHandsState(), makeAction())
    const obs = makeObservation()
    const next = recordObservation(state, obs)
    expect(next.observations.size).toBe(1)
  })

  it('refuses to add an observation for a terminal action', () => {
    const state = recordActionResult(
      initialHandsState(),
      makeAction({ status: 'completed', settledAt: '2026-01-01T00:00:02.000Z' }),
    )
    const obs = makeObservation()
    const next = recordObservation(state, obs)
    expect(next.observations.size).toBe(0)
  })

  it('refuses to add an observation for a non-existent action', () => {
    const state = initialHandsState()
    const obs = makeObservation()
    const next = recordObservation(state, obs)
    expect(next.observations.size).toBe(0)
  })

  it('preserves existing observation on duplicate', () => {
    const state = recordActionResult(initialHandsState(), makeAction())
    const obs = makeObservation()
    const next = recordObservation(state, obs)
    const duplicate = recordObservation(next, makeObservation({ summary: 'changed' }))
    expect(duplicate.observations.get('obs-1')?.summary).toBe('did the thing')
  })
})

describe('recordVerificationResult', () => {
  it('adds a verification result', () => {
    const state = initialHandsState()
    const ver = makeVerification()
    const next = recordVerificationResult(state, ver)
    expect(next.verifications.size).toBe(1)
  })

  it('marks action as verified when verification passes', () => {
    const state = initialHandsState()
    const ver = makeVerification({ status: 'passed', reason: 'matched' })
    const next = recordVerificationResult(state, ver)
    expect(next.verifiedActions.has('action-1')).toBe(true)
  })

  it('does not mark action as verified when verification fails', () => {
    const state = initialHandsState()
    const ver = makeVerification({ status: 'failed', reason: 'no match' })
    const next = recordVerificationResult(state, ver)
    expect(next.verifiedActions.has('action-1')).toBe(false)
  })

  it('does not mark action as verified when verification is requested', () => {
    const state = initialHandsState()
    const ver = makeVerification({ status: 'requested' })
    const next = recordVerificationResult(state, ver)
    expect(next.verifiedActions.has('action-1')).toBe(false)
  })
})

describe('isActionVerified', () => {
  it('returns false for unverified action', () => {
    const state = initialHandsState()
    expect(isActionVerified(state, 'action-1')).toBe(false)
  })

  it('returns true for verified action', () => {
    const state = recordVerificationResult(
      initialHandsState(),
      makeVerification({ status: 'passed' }),
    )
    expect(isActionVerified(state, 'action-1')).toBe(true)
  })
})

describe('observationsForAction', () => {
  it('returns observations for the specified action', () => {
    const state = recordActionResult(initialHandsState(), makeAction())
    const obs1 = makeObservation({ observationId: 'obs-1' })
    const obs2 = makeObservation({ observationId: 'obs-2', actionId: 'action-2' })
    const next = recordObservation(recordObservation(state, obs1), obs2)
    const result = observationsForAction(next, 'action-1')
    expect(result).toHaveLength(1)
    expect(result[0]!.observationId).toBe('obs-1')
  })
})

describe('verificationsForAction', () => {
  it('returns verifications for the specified action', () => {
    const state = initialHandsState()
    const ver1 = makeVerification({ verificationId: 'ver-1' })
    const ver2 = makeVerification({ verificationId: 'ver-2', actionId: 'action-2' })
    const next = recordVerificationResult(recordVerificationResult(state, ver1), ver2)
    const result = verificationsForAction(next, 'action-1')
    expect(result).toHaveLength(1)
    expect(result[0]!.verificationId).toBe('ver-1')
  })
})

describe('recordRefusal', () => {
  it('adds a refusal', () => {
    const state = initialHandsState()
    const next = recordRefusal(state, {
      actionId: 'action-1',
      code: 'capability_unknown',
      reason: 'that is not a capability kind this Core knows',
      capabilityId: null,
      refusedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(next.refusals.size).toBe(1)
  })

  it('preserves existing refusal on duplicate', () => {
    const state = initialHandsState()
    const entry = {
      actionId: 'action-1',
      code: 'capability_unknown' as const,
      reason: 'that is not a capability kind this Core knows',
      capabilityId: null,
      refusedAt: '2026-01-01T00:00:00.000Z',
    }
    const next = recordRefusal(state, entry)
    const duplicate = recordRefusal(next, { ...entry, reason: 'changed' })
    expect(duplicate.refusals.get('action-1')?.reason).toBe('that is not a capability kind this Core knows')
  })
})

describe('projectHands', () => {
  it('returns the absent projection for empty state', () => {
    const state = initialHandsState()
    const projection = projectHands(state)
    expect(projection.health).toBe('ready')
    expect(projection.actionCount).toBe(0)
  })

  it('counts actions by status', () => {
    let state: HandsState = initialHandsState()
    state = recordActionResult(state, makeAction({ actionId: 'a1', status: 'completed' }))
    state = recordActionResult(state, makeAction({ actionId: 'a2', status: 'failed' }))
    state = recordActionResult(state, makeAction({ actionId: 'a3', status: 'cancelled' }))
    state = recordActionResult(state, makeAction({ actionId: 'a4', status: 'timed_out' }))
    const projection = projectHands(state)
    expect(projection.actionCount).toBe(4)
    expect(projection.verifiedCount).toBe(0)
    expect(projection.failedCount).toBe(1)
    expect(projection.cancelledCount).toBe(1)
    expect(projection.timedOutCount).toBe(1)
  })

  it('counts verified actions', () => {
    let state: HandsState = initialHandsState()
    state = recordActionResult(state, makeAction({ actionId: 'a1', status: 'completed' }))
    state = recordVerificationResult(state, makeVerification({ actionId: 'a1', status: 'passed' }))
    const projection = projectHands(state)
    expect(projection.verifiedCount).toBe(1)
    expect(projection.verifiedActionIds).toContain('a1')
  })

  it('has the expected absent projection', () => {
    expect(ABSENT_HANDS_PROJECTION.health).toBe('unavailable')
    expect(ABSENT_HANDS_PROJECTION.actionCount).toBe(0)
  })
})
