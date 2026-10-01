import { describe, expect, it } from 'vitest'
import {
  createHandsRefusal,
  refuseBudgetExceeded,
  refuseDeferredCapability,
  refuseInvalidEnvelope,
  refuseInvalidRequest,
  refuseTimeoutExceeded,
  refuseUnauthorizedCapability,
  refuseUnsupportedCapability,
} from '../../../core/hands/refusal'
import { HANDS_REFUSAL_REASONS } from '../../../core/hands/types'

describe('createHandsRefusal', () => {
  it('creates a refusal with the correct code and reason', () => {
    const refusal = createHandsRefusal('action-1', 'capability_unknown', null, '2026-01-01T00:00:00.000Z')
    expect(refusal.actionId).toBe('action-1')
    expect(refusal.code).toBe('capability_unknown')
    expect(refusal.reason).toBe(HANDS_REFUSAL_REASONS.capability_unknown)
    expect(refusal.capabilityId).toBeNull()
  })

  it('includes the capability id when provided', () => {
    const refusal = createHandsRefusal('action-1', 'capability_unauthorized', 'cap-browser', '2026-01-01T00:00:00.000Z')
    expect(refusal.capabilityId).toBe('cap-browser')
  })
})

describe('refuseUnsupportedCapability', () => {
  it('creates a capability_unknown refusal', () => {
    const refusal = refuseUnsupportedCapability('action-1', 'cap-unknown', '2026-01-01T00:00:00.000Z')
    expect(refusal.code).toBe('capability_unknown')
    expect(refusal.capabilityId).toBe('cap-unknown')
  })
})

describe('refuseDeferredCapability', () => {
  it('creates a capability_deferred refusal', () => {
    const refusal = refuseDeferredCapability('action-1', 'cap-clipboard', '2026-01-01T00:00:00.000Z')
    expect(refusal.code).toBe('capability_deferred')
  })
})

describe('refuseUnauthorizedCapability', () => {
  it('creates a capability_unauthorized refusal', () => {
    const refusal = refuseUnauthorizedCapability('action-1', 'cap-browser', '2026-01-01T00:00:00.000Z')
    expect(refusal.code).toBe('capability_unauthorized')
    expect(refusal.capabilityId).toBe('cap-browser')
  })
})

describe('refuseInvalidEnvelope', () => {
  it('creates an invalid_envelope refusal', () => {
    const refusal = refuseInvalidEnvelope('action-1', '2026-01-01T00:00:00.000Z')
    expect(refusal.code).toBe('invalid_envelope')
    expect(refusal.capabilityId).toBeNull()
  })
})

describe('refuseInvalidRequest', () => {
  it('creates an invalid_request refusal', () => {
    const refusal = refuseInvalidRequest('action-1', '2026-01-01T00:00:00.000Z')
    expect(refusal.code).toBe('invalid_request')
  })
})

describe('refuseBudgetExceeded', () => {
  it('creates a budget_exceeded refusal', () => {
    const refusal = refuseBudgetExceeded('action-1', 'cap-browser', '2026-01-01T00:00:00.000Z')
    expect(refusal.code).toBe('budget_exceeded')
  })
})

describe('refuseTimeoutExceeded', () => {
  it('creates a timeout_exceeded refusal', () => {
    const refusal = refuseTimeoutExceeded('action-1', 'cap-browser', '2026-01-01T00:00:00.000Z')
    expect(refusal.code).toBe('timeout_exceeded')
  })
})

describe('refusal shapes', () => {
  it('every refusal has a closed code', () => {
    const refusals = [
      refuseUnsupportedCapability('a', 'c', 't'),
      refuseDeferredCapability('a', 'c', 't'),
      refuseUnauthorizedCapability('a', 'c', 't'),
      refuseInvalidEnvelope('a', 't'),
      refuseInvalidRequest('a', 't'),
      refuseBudgetExceeded('a', 'c', 't'),
      refuseTimeoutExceeded('a', 'c', 't'),
    ]
    for (const refusal of refusals) {
      expect(refusal.actionId).toBe('a')
      expect(refusal.reason).toBeTruthy()
      expect(typeof refusal.reason).toBe('string')
    }
  })

  it('a refusal is not an action result', () => {
    const refusal = refuseUnsupportedCapability('action-1', 'cap-unknown', '2026-01-01T00:00:00.000Z')
    expect(refusal).not.toHaveProperty('status')
    expect(refusal).not.toHaveProperty('observationIds')
  })

  it('a refusal is not a verification result', () => {
    const refusal = refuseUnsupportedCapability('action-1', 'cap-unknown', '2026-01-01T00:00:00.000Z')
    expect(refusal).not.toHaveProperty('verdictAt')
  })
})
