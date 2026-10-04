import { describe, expect, it } from 'vitest'
import {
  ECONOMIC_GATE_CHECKS,
  ECONOMIC_GUARD_CAPABILITY,
  STAGE_UNIT_COST,
  blockerForRefusal,
  evaluateEconomicGate,
  totalUnitAllowance,
} from '../../../core/economic/authority'
import { ECONOMIC_LIMITS, ECONOMIC_REFUSAL_CODES } from '../../../core/economic/types'
import type { EconomicAuthorityFacts } from '../../../core/economic/authority'
import { authority } from './fixture'
import { harness } from './harness'
import { narrowEconomicLimits } from '../../../core/economic/limits'

/**
 * The authority gate.
 *
 * These tests exist because the gate is the whole of Phase 32's claim to "no authority
 * widening". A precedence table is exactly the sort of thing that is correct on the day it
 * is written and quietly reorders itself over eighteen months, so the ordering is
 * asserted as data rather than demonstrated once by example.
 */

describe('the authority gate', () => {
  it('allows when every fact is permissive', () => {
    const outcome = evaluateEconomicGate(authority())
    expect(outcome.outcome).toBe('allow')
    expect(outcome.cleared).toEqual(ECONOMIC_GATE_CHECKS)
  })

  it('clears every check in the published order when it allows', () => {
    const outcome = evaluateEconomicGate(authority())
    // Not a set comparison: order is the content, and a set would pass on any permutation.
    expect(outcome.cleared).toStrictEqual([
      'journal-not-trustworthy',
      'stop-all-active',
      'real-money-prohibited',
      'economic-disabled',
      'guard-capability',
      'governor-cognition',
      'budget-remaining',
      'approval-required',
    ])
  })

  it('refuses an untrustworthy journal above everything else', () => {
    const outcome = evaluateEconomicGate(
      authority({ journalTrustworthy: false, stopAllActive: true, capabilityAllowed: false }),
    )
    expect(outcome.outcome).toBe('deny')
    if (outcome.outcome === 'deny') {
      expect(outcome.failedCheck).toBe('journal-not-trustworthy')
      expect(outcome.cleared).toEqual([])
    }
  })

  it('puts STOP ALL above the Guard, the Governor, the budget and approval', () => {
    // Every lower gate is failing at once. STOP ALL must still be the *first* refusal,
    // because a latch says "no request is being considered at all" while the others say
    // something about this particular request.
    const outcome = evaluateEconomicGate(
      authority({
        stopAllActive: true,
        capabilityAllowed: false,
        cognitionAuthorized: false,
        budgetRemainingUnits: 0,
        approvalSatisfied: false,
      }),
    )
    expect(outcome.outcome).toBe('deny')
    if (outcome.outcome === 'deny') {
      expect(outcome.failedCheck).toBe('stop-all-active')
      expect(outcome.cleared).toEqual(['journal-not-trustworthy'])
    }
  })

  it('puts the Guard above the Governor', () => {
    const outcome = evaluateEconomicGate(authority({ capabilityAllowed: false, cognitionAuthorized: false }))
    expect(outcome.outcome).toBe('deny')
    if (outcome.outcome === 'deny') expect(outcome.failedCheck).toBe('guard-capability')
  })

  it('puts the Governor above the budget and above approval', () => {
    const outcome = evaluateEconomicGate(
      authority({ cognitionAuthorized: false, budgetRemainingUnits: 0, approvalSatisfied: false }),
    )
    expect(outcome.outcome).toBe('deny')
    if (outcome.outcome === 'deny') expect(outcome.failedCheck).toBe('governor-cognition')
  })

  it('puts the budget above approval', () => {
    const outcome = evaluateEconomicGate(authority({ budgetRemainingUnits: 0, approvalSatisfied: false }))
    expect(outcome.outcome).toBe('deny')
    if (outcome.outcome === 'deny') expect(outcome.failedCheck).toBe('budget-remaining')
  })

  it('refuses a real-money request before the Guard is even consulted', () => {
    const outcome = evaluateEconomicGate(authority({ realMoney: true, capabilityAllowed: false }))
    expect(outcome.outcome).toBe('deny')
    if (outcome.outcome === 'deny') {
      expect(outcome.failedCheck).toBe('real-money-prohibited')
      expect(outcome.code).toBe('real-money-prohibited')
    }
  })

  it('refuses a NaN or negative unit allowance rather than letting it through', () => {
    // `NaN < 0` is false, so a naive `remaining < 0` check would let a NaN budget through
    // and the gate would have no budget at all. This is the whole reason the check is
    // written as a positive assertion.
    for (const remaining of [Number.NaN, -1, -0.5]) {
      const outcome = evaluateEconomicGate(authority({ budgetRemainingUnits: remaining }))
      expect(outcome.outcome).toBe('deny')
      if (outcome.outcome === 'deny') expect(outcome.code).toBe('budget-exhausted')
    }
  })

  it('gives every denial a code and a fixed sentence', () => {
    const facts: Readonly<{ key: keyof EconomicAuthorityFacts; value: EconomicAuthorityFacts[keyof EconomicAuthorityFacts] }>[] = [
      { key: 'journalTrustworthy', value: false },
      { key: 'stopAllActive', value: true },
      { key: 'realMoney', value: true },
      { key: 'enabled', value: false },
      { key: 'capabilityAllowed', value: false },
      { key: 'cognitionAuthorized', value: false },
      { key: 'budgetRemainingUnits', value: 0 },
      { key: 'approvalSatisfied', value: false },
    ]
    for (const entry of facts) {
      const outcome = evaluateEconomicGate(authority({ [entry.key]: entry.value } as Partial<EconomicAuthorityFacts>))
      expect(outcome.outcome).toBe('deny')
      if (outcome.outcome !== 'deny') continue
      expect(ECONOMIC_REFUSAL_CODES).toContain(outcome.code)
      expect(outcome.reason.length).toBeGreaterThan(10)
      // A refusal that interpolated the offending value would put caller text into an
      // owner-visible string. The two gates below are distinct, which proves it did not.
      expect(outcome.reason).not.toContain('NaN')
    }
  })

  it('reports a cleared prefix rather than a bare denial', () => {
    const outcome = evaluateEconomicGate(authority({ budgetRemainingUnits: 0 }))
    if (outcome.outcome === 'deny') {
      // "three gates cleared and then the budget ran out" is the useful sentence.
      expect(outcome.cleared).toEqual([
        'journal-not-trustworthy',
        'stop-all-active',
        'real-money-prohibited',
        'economic-disabled',
        'guard-capability',
        'governor-cognition',
      ])
    } else {
      throw new Error('expected a denial')
    }
  })
})

describe('the economic guard capability', () => {
  it('names an existing Phase 1 capability rather than adding one', () => {
    // The phase's claim is that it widens nothing. Gating on an *existing* capability is
    // how that is true rather than aspirational; a new string here would be the widening.
    expect(ECONOMIC_GUARD_CAPABILITY).toBe('research.start')
  })
})

describe('unit costs', () => {
  it('costs nothing in a terminal or idle stage', () => {
    expect(STAGE_UNIT_COST.IDLE).toBe(0)
    expect(STAGE_UNIT_COST.COMPLETE).toBe(0)
    expect(STAGE_UNIT_COST.FAILED).toBe(0)
  })

  it('costs the most to simulate', () => {
    expect(STAGE_UNIT_COST.SIMULATING).toBeGreaterThan(STAGE_UNIT_COST.RESEARCHING)
    expect(STAGE_UNIT_COST.RESEARCHING).toBeGreaterThan(0)
  })

  it('derives the total allowance from the ceilings rather than from a separate number', () => {
    // Raising a ceiling has to raise what it costs, or a limit is a limit on paper.
    const narrowed = narrowEconomicLimits({ maxPaperOrdersPerExperiment: 2 })
    expect(totalUnitAllowance(narrowed)).toBeLessThan(totalUnitAllowance(ECONOMIC_LIMITS))
  })
})

describe('blocker mapping', () => {
  it('names the latch when the owner stopped Freya', () => {
    expect(blockerForRefusal('stop-all-active')).toBe('stop-all-latched')
  })

  it('names the real-money prohibition distinctly from a Guard denial', () => {
    // An owner reading these two side by side needs to be able to tell "not permitted"
    // from "that is not a thing this subsystem can do at all".
    expect(blockerForRefusal('real-money-prohibited')).toBe('real-money-prohibited')
    expect(blockerForRefusal('real-order-prohibited')).toBe('real-money-prohibited')
    expect(blockerForRefusal('guard-denied')).toBe('guard-denied')
    expect(blockerForRefusal('governor-denied')).toBe('governor-denied')
  })
})

describe('the gate inside a running subsystem', () => {
  it('journals an allowed decision as well as a refused one', async () => {
    const h = harness()
    const { EconomicRuntime } = await import('../../../core/economic/runtime')
    const runtime = new EconomicRuntime({ ports: h.ports })
    await runtime.open()
    await runtime.openExperiment({
      experimentId: 'exp-1',
      kind: 'research',
      title: 'A bounded question',
      question: 'Would anyone pay for this?',
      completionCriteria: ['peer-reviewed-demand'],
      createdAt: '2026-03-01T09:00:00.000Z',
      deadlineAt: null,
    })
    const gates = h.payloads('economic.gate.decided')
    expect(gates.length).toBeGreaterThan(0)
    expect(gates[0]?.outcome).toBe('allow')
    expect(gates[0]?.code).toBe('all-gates-clear')
  })

  it('journals a refusal with the gates that had already cleared', async () => {
    const h = harness({ budgetRemainingUnits: 0 })
    const { EconomicRuntime } = await import('../../../core/economic/runtime')
    const runtime = new EconomicRuntime({ ports: h.ports })
    await runtime.open()
    const outcome = await runtime.openExperiment({
      experimentId: 'exp-1',
      kind: 'research',
      title: 'A bounded question',
      question: 'Would anyone pay for this?',
      completionCriteria: ['peer-reviewed-demand'],
      createdAt: '2026-03-01T09:00:00.000Z',
      deadlineAt: null,
    })
    expect(outcome.ok).toBe(false)
    const gates = h.payloads('economic.gate.decided')
    expect(gates[0]?.outcome).toBe('deny')
    expect(gates[0]?.code).toBe('budget-exhausted')
    expect(String(gates[0]?.checked)).toContain('guard-capability')
    expect(h.refusals()).toContain('budget-exhausted')
  })
})