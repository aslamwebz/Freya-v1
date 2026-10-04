import { describe, expect, it } from 'vitest'
import {
  detectAuthorityDrift,
  isProtectedInvariantViolation,
  isSelfModificationAttempt,
} from '../../../core/evolution'
import type { AuthorityEnvelope, ProposedAuthorityEnvelope } from '../../../core/evolution/types'

const CURRENT: AuthorityEnvelope = Object.freeze({
  capabilities: ['evolution.improve'],
  grants: [],
  budgetCeiling: 100,
  approvalRequired: true,
  stopAllLatched: false,
})

describe('authority drift is detected', () => {
  it('reports no-drift when the proposed envelope is the same', () => {
    const proposed: ProposedAuthorityEnvelope = {
      capabilities: ['evolution.improve'],
      grants: [],
      budgetCeiling: 100,
      approvalRequired: true,
      stopAllLatched: false,
    }
    const result = detectAuthorityDrift(proposed, CURRENT)
    expect(result.outcome).toBe('no-drift')
  })

  it('reports no-drift when the proposed envelope is narrower', () => {
    const proposed: ProposedAuthorityEnvelope = {
      capabilities: [],
      grants: [],
      budgetCeiling: 50,
      approvalRequired: true,
      stopAllLatched: false,
    }
    const result = detectAuthorityDrift(proposed, CURRENT)
    expect(result.outcome).toBe('no-drift')
  })

  it('detects a new capability', () => {
    const proposed: ProposedAuthorityEnvelope = {
      capabilities: ['evolution.improve', 'guard.bypass'],
      grants: [],
      budgetCeiling: 100,
      approvalRequired: true,
      stopAllLatched: false,
    }
    const result = detectAuthorityDrift(proposed, CURRENT)
    expect(result.outcome).toBe('drift-detected')
    expect(result.outcome === 'drift-detected' && result.violations.some((v) => v.includes('guard.bypass'))).toBe(true)
  })

  it('detects a new grant', () => {
    const proposed: ProposedAuthorityEnvelope = {
      capabilities: ['evolution.improve'],
      grants: ['cognition.unlimited'],
      budgetCeiling: 100,
      approvalRequired: true,
      stopAllLatched: false,
    }
    const result = detectAuthorityDrift(proposed, CURRENT)
    expect(result.outcome).toBe('drift-detected')
  })

  it('detects a higher budget ceiling', () => {
    const proposed: ProposedAuthorityEnvelope = {
      capabilities: ['evolution.improve'],
      grants: [],
      budgetCeiling: 200,
      approvalRequired: true,
      stopAllLatched: false,
    }
    const result = detectAuthorityDrift(proposed, CURRENT)
    expect(result.outcome).toBe('drift-detected')
  })

  it('detects a weakened approval requirement', () => {
    const proposed: ProposedAuthorityEnvelope = {
      capabilities: ['evolution.improve'],
      grants: [],
      budgetCeiling: 100,
      approvalRequired: false,
      stopAllLatched: false,
    }
    const result = detectAuthorityDrift(proposed, CURRENT)
    expect(result.outcome).toBe('drift-detected')
  })

  it('detects a cleared STOP ALL latch', () => {
    const latched: AuthorityEnvelope = { ...CURRENT, stopAllLatched: true }
    const proposed: ProposedAuthorityEnvelope = {
      capabilities: ['evolution.improve'],
      grants: [],
      budgetCeiling: 100,
      approvalRequired: true,
      stopAllLatched: false,
    }
    const result = detectAuthorityDrift(proposed, latched)
    expect(result.outcome).toBe('drift-detected')
  })
})

describe('self-modification is detected', () => {
  it('detects a self-modification capability', () => {
    const proposed: ProposedAuthorityEnvelope = {
      capabilities: ['evolution.improve', 'self-modify'],
      grants: [],
      budgetCeiling: 100,
      approvalRequired: true,
      stopAllLatched: false,
    }
    const result = isSelfModificationAttempt(proposed)
    expect(result.isAttempt).toBe(true)
  })

  it('detects a modify-code capability', () => {
    const proposed: ProposedAuthorityEnvelope = {
      capabilities: ['evolution.improve', 'modify-code'],
      grants: [],
      budgetCeiling: 100,
      approvalRequired: true,
      stopAllLatched: false,
    }
    const result = isSelfModificationAttempt(proposed)
    expect(result.isAttempt).toBe(true)
  })

  it('does not flag a normal capability', () => {
    const proposed: ProposedAuthorityEnvelope = {
      capabilities: ['evolution.improve'],
      grants: [],
      budgetCeiling: 100,
      approvalRequired: true,
      stopAllLatched: false,
    }
    const result = isSelfModificationAttempt(proposed)
    expect(result.isAttempt).toBe(false)
  })
})

describe('protected invariant violations are detected', () => {
  it('detects a STOP ALL latch clearing', () => {
    const latched: AuthorityEnvelope = { ...CURRENT, stopAllLatched: true }
    const proposed: ProposedAuthorityEnvelope = {
      capabilities: ['evolution.improve'],
      grants: [],
      budgetCeiling: 100,
      approvalRequired: true,
      stopAllLatched: false,
    }
    const result = isProtectedInvariantViolation(proposed, latched)
    expect(result.isViolation).toBe(true)
  })

  it('detects an approval requirement weakening', () => {
    const proposed: ProposedAuthorityEnvelope = {
      capabilities: ['evolution.improve'],
      grants: [],
      budgetCeiling: 100,
      approvalRequired: false,
      stopAllLatched: false,
    }
    const result = isProtectedInvariantViolation(proposed, CURRENT)
    expect(result.isViolation).toBe(true)
  })

  it('detects a budget widening', () => {
    const proposed: ProposedAuthorityEnvelope = {
      capabilities: ['evolution.improve'],
      grants: [],
      budgetCeiling: 200,
      approvalRequired: true,
      stopAllLatched: false,
    }
    const result = isProtectedInvariantViolation(proposed, CURRENT)
    expect(result.isViolation).toBe(true)
  })

  it('does not flag a normal envelope', () => {
    const proposed: ProposedAuthorityEnvelope = {
      capabilities: ['evolution.improve'],
      grants: [],
      budgetCeiling: 100,
      approvalRequired: true,
      stopAllLatched: false,
    }
    const result = isProtectedInvariantViolation(proposed, CURRENT)
    expect(result.isViolation).toBe(false)
  })
})
