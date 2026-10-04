import { describe, expect, it } from 'vitest'
import {
  evaluateThresholdGate,
  THRESHOLD_GATE_CHECKS,
  THRESHOLD_GUARD_CAPABILITY,
  blockerForRefusal,
} from '../../../core/threshold/authority'
import type { ThresholdAuthorityFacts } from '../../../core/threshold/authority'

/**
 * The authority gate.
 */

const ALL_CLEAR: ThresholdAuthorityFacts = {
  journalTrustworthy: true,
  stopAllActive: false,
  enabled: true,
  capabilityAllowed: true,
  cognitionAuthorized: true,
  budgetRemainingUnits: 1_000_000,
  approvalSatisfied: true,
  realMoney: false,
}

describe('gate checks', () => {
  it('allows when every fact is clear', () => {
    const outcome = evaluateThresholdGate(ALL_CLEAR)
    expect(outcome.outcome).toBe('allow')
    if (outcome.outcome === 'allow') {
      expect(outcome.cleared).toEqual(THRESHOLD_GATE_CHECKS)
    }
  })

  it('denies when the journal is not trustworthy', () => {
    const outcome = evaluateThresholdGate({ ...ALL_CLEAR, journalTrustworthy: false })
    expect(outcome.outcome).toBe('deny')
    if (outcome.outcome === 'deny') {
      expect(outcome.code).toBe('journal-not-trustworthy')
      expect(outcome.failedCheck).toBe('journal-not-trustworthy')
    }
  })

  it('denies when STOP ALL is active', () => {
    const outcome = evaluateThresholdGate({ ...ALL_CLEAR, stopAllActive: true })
    expect(outcome.outcome).toBe('deny')
    if (outcome.outcome === 'deny') {
      expect(outcome.code).toBe('stop-all-active')
      expect(outcome.failedCheck).toBe('stop-all-active')
    }
  })

  it('denies when real money is involved', () => {
    const outcome = evaluateThresholdGate({ ...ALL_CLEAR, realMoney: true })
    expect(outcome.outcome).toBe('deny')
    if (outcome.outcome === 'deny') {
      expect(outcome.code).toBe('real-money-prohibited')
      expect(outcome.failedCheck).toBe('real-money-prohibited')
    }
  })

  it('denies when the threshold is disabled', () => {
    const outcome = evaluateThresholdGate({ ...ALL_CLEAR, enabled: false })
    expect(outcome.outcome).toBe('deny')
    if (outcome.outcome === 'deny') {
      expect(outcome.code).toBe('threshold-disabled')
      expect(outcome.failedCheck).toBe('threshold-disabled')
    }
  })

  it('denies when the Guard does not allow the capability', () => {
    const outcome = evaluateThresholdGate({ ...ALL_CLEAR, capabilityAllowed: false })
    expect(outcome.outcome).toBe('deny')
    if (outcome.outcome === 'deny') {
      expect(outcome.code).toBe('guard-denied')
      expect(outcome.failedCheck).toBe('guard-capability')
    }
  })

  it('denies when the Governor does not authorize cognition', () => {
    const outcome = evaluateThresholdGate({ ...ALL_CLEAR, cognitionAuthorized: false })
    expect(outcome.outcome).toBe('deny')
    if (outcome.outcome === 'deny') {
      expect(outcome.code).toBe('governor-denied')
      expect(outcome.failedCheck).toBe('governor-cognition')
    }
  })

  it('denies when the budget is exhausted', () => {
    const outcome = evaluateThresholdGate({ ...ALL_CLEAR, budgetRemainingUnits: 0 })
    expect(outcome.outcome).toBe('deny')
    if (outcome.outcome === 'deny') {
      expect(outcome.code).toBe('budget-exhausted')
      expect(outcome.failedCheck).toBe('budget-remaining')
    }
  })

  it('denies when approval is not satisfied', () => {
    const outcome = evaluateThresholdGate({ ...ALL_CLEAR, approvalSatisfied: false })
    expect(outcome.outcome).toBe('deny')
    if (outcome.outcome === 'deny') {
      expect(outcome.code).toBe('approval-required')
      expect(outcome.failedCheck).toBe('approval-required')
    }
  })

  it('checks in precedence order', () => {
    const outcome = evaluateThresholdGate({
      ...ALL_CLEAR,
      journalTrustworthy: false,
      stopAllActive: true,
    })
    expect(outcome.outcome).toBe('deny')
    if (outcome.outcome === 'deny') {
      expect(outcome.failedCheck).toBe('journal-not-trustworthy')
    }
  })
})

describe('blocker for refusal', () => {
  it('maps journal-not-trustworthy', () => {
    expect(blockerForRefusal('journal-not-trustworthy')).toBe('journal-not-trustworthy')
  })

  it('maps stop-all-active', () => {
    expect(blockerForRefusal('stop-all-active')).toBe('stop-all-latched')
  })

  it('maps guard-denied', () => {
    expect(blockerForRefusal('guard-denied')).toBe('guard-denied')
  })

  it('maps governor-denied', () => {
    expect(blockerForRefusal('governor-denied')).toBe('governor-denied')
  })

  it('maps budget-exhausted', () => {
    expect(blockerForRefusal('budget-exhausted')).toBe('budget-exhausted')
  })

  it('maps approval-required', () => {
    expect(blockerForRefusal('approval-required')).toBe('approval-required')
  })

  it('maps real-money-prohibited', () => {
    expect(blockerForRefusal('real-money-prohibited')).toBe('real-money-prohibited')
  })
})

describe('guard capability', () => {
  it('uses the research.start capability', () => {
    expect(THRESHOLD_GUARD_CAPABILITY).toBe('research.start')
  })
})
