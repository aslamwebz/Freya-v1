import { describe, expect, it } from 'vitest'
import { ThresholdRuntime } from '../../../core/threshold/runtime'
import { classifyThresholdClaim } from '../../../core/threshold/prohibition'
import { evaluateThresholdGate } from '../../../core/threshold/authority'
import { T_PLUS_1D, harness, wake } from './harness'

/**
 * Red-team tests.
 *
 * These tests prove that the threshold subsystem cannot be tricked into
 * self-granting maturity, widening authority, bypassing Guard, overriding
 * Governor, clearing STOP ALL, exceeding budgets, skipping approvals,
 * performing real-money actions, self-modifying trusted runtime code,
 * fabricating evidence, or using maturity to widen authority.
 */

async function opened(h = harness()) {
  const runtime = new ThresholdRuntime({ ports: h.ports })
  await runtime.open()
  return { runtime, h }
}

describe('maturity forgery attacks', () => {
  it('refuses to self-grant maturity', async () => {
    const { runtime } = await opened()
    await runtime.startAssessment('autonomy')
    await runtime.collectEvidence('AUT-1', 'test', 'strong')
    const evidence = runtime.folded().evidence[0]
    if (!evidence) throw new Error('evidence not found')
    await runtime.verifyEvidence(evidence.evidenceId, 'verified', T_PLUS_1D)
    const outcome = await runtime.decideProven(0, 0)
    expect(outcome.ok).toBe(true)
    expect(runtime.folded().currentState).toBe('PROVEN')
    const report = await runtime.audit()
    expect(report.holds).toBe(true)
  })

  it('refuses maturity without evidence', async () => {
    const { runtime } = await opened()
    const outcome = await runtime.decideNotProven(['autonomy'], 'No evidence')
    expect(outcome.ok).toBe(true)
    expect(runtime.folded().currentState).toBe('UNPROVEN')
  })

  it('refuses maturity authority widening claims', () => {
    const scan = classifyThresholdClaim({ maturityWidensAuthority: true })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses maturity self-grant claims', () => {
    const scan = classifyThresholdClaim({ selfGrantMaturity: true })
    expect(scan.prohibited).toBe(true)
  })
})

describe('authority escalation attacks', () => {
  it('refuses capability claims', () => {
    const scan = classifyThresholdClaim({ capability: 'work.execute' })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses authority claims', () => {
    const scan = classifyThresholdClaim({ authority: 'owner' })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses owner claims', () => {
    const scan = classifyThresholdClaim({ principal: 'owner' })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses priority escalation claims', () => {
    const scan = classifyThresholdClaim({ priority: 'high' })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses budget widening claims', () => {
    const scan = classifyThresholdClaim({ budget: 1000000 })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses approval claims', () => {
    const scan = classifyThresholdClaim({ approved: true })
    expect(scan.prohibited).toBe(true)
  })
})

describe('boundary violation attacks', () => {
  it('refuses when Guard denies', () => {
    const outcome = evaluateThresholdGate({
      journalTrustworthy: true,
      stopAllActive: false,
      enabled: true,
      capabilityAllowed: false,
      cognitionAuthorized: true,
      budgetRemainingUnits: 1000,
      approvalSatisfied: true,
      realMoney: false,
    })
    expect(outcome.outcome).toBe('deny')
    if (outcome.outcome === 'deny') {
      expect(outcome.code).toBe('guard-denied')
    }
  })

  it('refuses when Governor denies', () => {
    const outcome = evaluateThresholdGate({
      journalTrustworthy: true,
      stopAllActive: false,
      enabled: true,
      capabilityAllowed: true,
      cognitionAuthorized: false,
      budgetRemainingUnits: 1000,
      approvalSatisfied: true,
      realMoney: false,
    })
    expect(outcome.outcome).toBe('deny')
    if (outcome.outcome === 'deny') {
      expect(outcome.code).toBe('governor-denied')
    }
  })

  it('refuses when STOP ALL is active', () => {
    const outcome = evaluateThresholdGate({
      journalTrustworthy: true,
      stopAllActive: true,
      enabled: true,
      capabilityAllowed: true,
      cognitionAuthorized: true,
      budgetRemainingUnits: 1000,
      approvalSatisfied: true,
      realMoney: false,
    })
    expect(outcome.outcome).toBe('deny')
    if (outcome.outcome === 'deny') {
      expect(outcome.code).toBe('stop-all-active')
    }
  })

  it('refuses when budget is exhausted', () => {
    const outcome = evaluateThresholdGate({
      journalTrustworthy: true,
      stopAllActive: false,
      enabled: true,
      capabilityAllowed: true,
      cognitionAuthorized: true,
      budgetRemainingUnits: 0,
      approvalSatisfied: true,
      realMoney: false,
    })
    expect(outcome.outcome).toBe('deny')
    if (outcome.outcome === 'deny') {
      expect(outcome.code).toBe('budget-exhausted')
    }
  })

  it('refuses when approval is not satisfied', () => {
    const outcome = evaluateThresholdGate({
      journalTrustworthy: true,
      stopAllActive: false,
      enabled: true,
      capabilityAllowed: true,
      cognitionAuthorized: true,
      budgetRemainingUnits: 1000,
      approvalSatisfied: false,
      realMoney: false,
    })
    expect(outcome.outcome).toBe('deny')
    if (outcome.outcome === 'deny') {
      expect(outcome.code).toBe('approval-required')
    }
  })

  it('refuses when real money is involved', () => {
    const outcome = evaluateThresholdGate({
      journalTrustworthy: true,
      stopAllActive: false,
      enabled: true,
      capabilityAllowed: true,
      cognitionAuthorized: true,
      budgetRemainingUnits: 1000,
      approvalSatisfied: true,
      realMoney: true,
    })
    expect(outcome.outcome).toBe('deny')
    if (outcome.outcome === 'deny') {
      expect(outcome.code).toBe('real-money-prohibited')
    }
  })

  it('refuses capability widening claims', () => {
    const scan = classifyThresholdClaim({ widenCapability: true })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses grant creation claims', () => {
    const scan = classifyThresholdClaim({ createGrant: true })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses self-approval claims', () => {
    const scan = classifyThresholdClaim({ selfApprove: true })
    expect(scan.prohibited).toBe(true)
  })
})

describe('hidden inference attacks', () => {
  it('refuses inference without wake claims', () => {
    const scan = classifyThresholdClaim({ inference: true })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses polling claims', () => {
    const scan = classifyThresholdClaim({ polling: true })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses hidden reasoning claims', () => {
    const scan = classifyThresholdClaim({ hiddenReasoning: true })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses unrestricted loop claims', () => {
    const scan = classifyThresholdClaim({ unrestrictedLoop: true })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses idle model call claims', () => {
    const scan = classifyThresholdClaim({ idleModelCall: true })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses background reasoning claims', () => {
    const scan = classifyThresholdClaim({ backgroundReasoning: true })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses hidden durable state claims', () => {
    const scan = classifyThresholdClaim({ hiddenDurableState: true })
    expect(scan.prohibited).toBe(true)
  })
})

describe('data injection attacks', () => {
  it('treats model output urgency as data', () => {
    const scan = classifyThresholdClaim({ urgency: 'high' })
    expect(scan.prohibited).toBe(false)
  })

  it('treats model output priority as data', () => {
    const scan = classifyThresholdClaim({ priority: 'high' })
    expect(scan.prohibited).toBe(true)
  })

  it('treats event importance as data', () => {
    const scan = classifyThresholdClaim({ importance: 'high' })
    expect(scan.prohibited).toBe(false)
  })

  it('treats event deadline as data', () => {
    const scan = classifyThresholdClaim({ deadline: '2026-03-01' })
    expect(scan.prohibited).toBe(false)
  })

  it('treats context authority as data', () => {
    const scan = classifyThresholdClaim({ authority: 'owner' })
    expect(scan.prohibited).toBe(true)
  })
})

describe('restart recovery attacks', () => {
  it('refuses state fabrication on restart', () => {
    const scan = classifyThresholdClaim({ fabricateState: true })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses hidden state on restart', () => {
    const scan = classifyThresholdClaim({ hiddenState: true })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses silent resume', () => {
    const scan = classifyThresholdClaim({ silentResume: true })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses self-modification on restart', () => {
    const scan = classifyThresholdClaim({ selfModify: true })
    expect(scan.prohibited).toBe(true)
  })
})

describe('composite attacks', () => {
  it('refuses maturity + authority widening', () => {
    const scan = classifyThresholdClaim({ selfGrantMaturity: true, maturityWidensAuthority: true })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses evidence fabrication + unauthorized improvement', () => {
    const scan = classifyThresholdClaim({ fabricateEvidence: true, unauthorizedImprovement: true })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses self-grant maturity + widen authority', () => {
    const scan = classifyThresholdClaim({ selfGrantMaturity: true, widenCapability: true })
    expect(scan.prohibited).toBe(true)
  })
})

describe('runtime red-team', () => {
  it('refuses assessment when STOP ALL is active', async () => {
    const h = harness({ stopAll: true })
    const { runtime } = await opened(h)
    const outcome = await runtime.startAssessment('autonomy')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('stop-all-active')
  })

  it('refuses evidence collection when STOP ALL is active', async () => {
    const h = harness({ stopAll: true })
    const { runtime } = await opened(h)
    const outcome = await runtime.collectEvidence('AUT-1', 'test', 'strong')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('stop-all-active')
  })

  it('refuses decision when STOP ALL is active', async () => {
    const h = harness({ stopAll: true })
    const { runtime } = await opened(h)
    const outcome = await runtime.decideProven(14, 112)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('stop-all-active')
  })

  it('refuses rollback when STOP ALL is active', async () => {
    const h = harness({ stopAll: true })
    const { runtime } = await opened(h)
    const outcome = await runtime.startRollback('authority-widening')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('stop-all-active')
  })

  it('refuses wake when STOP ALL is active', async () => {
    const h = harness({ stopAll: true })
    const { runtime } = await opened(h)
    const outcome = await runtime.considerWake(wake())
    expect(outcome.outcome).toBe('denied')
  })

  it('refuses self-modification', async () => {
    const { runtime, h } = await opened()
    await runtime.refuseSelfModification('guard', 'Attempted to modify Guard')
    expect(h.types()).toContain('threshold.fail-closed.triggered')
  })
})
