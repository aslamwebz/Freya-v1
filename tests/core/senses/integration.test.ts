// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  admitCapabilityAction,
  createActionResult,
  createObservation,
  createVerification,
  testCaller,
  SENSES_TEST_NOW,
  type CapabilityActionRequest,
  type SensesAdmissionInput,
} from '../../../core/senses'

/**
 * Phase 25 integration: the deterministic capability lifecycle.
 *
 *   Action → Observation → Verification → Result
 *
 * The pipeline is pure: same inputs + same clock = same decision. Nothing here
 * calls a model, reads a clock, or mints authority.
 */

function request(over: Partial<CapabilityActionRequest> = {}): CapabilityActionRequest {
  return {
    actionId: 'action-1',
    capabilityKind: 'browser',
    action: 'navigate',
    input: { url: 'https://example.com' },
    ...over,
  }
}

function admission(over: Partial<SensesAdmissionInput> = {}): SensesAdmissionInput {
  return {
    request: request(),
    caller: testCaller(),
    stopAllActive: false,
    now: SENSES_TEST_NOW,
    budgetRemaining: 1000,
    requiredBudget: 10,
    approvals: new Set(['action-1']),
    requiresCognition: false,
    cognitionGrantId: null,
    ...over,
  }
}

describe('integration: action to result', () => {
  it('admits an action, then records observation and verification', () => {
    const decision = admitCapabilityAction(admission())
    expect(decision.decision).toBe('admitted')
    if (decision.decision !== 'admitted') return

    const observation = createObservation(
      'obs-1',
      decision.admitted.actionId,
      'result',
      'page loaded',
      SENSES_TEST_NOW,
    )
    const verification = createVerification('ver-1', decision.admitted.actionId, 'passed', SENSES_TEST_NOW)
    const result = createActionResult(
      decision.admitted.actionId,
      'completed',
      SENSES_TEST_NOW,
      SENSES_TEST_NOW,
    )

    expect(observation?.kind).toBe('result')
    expect(verification?.status).toBe('passed')
    expect(result?.status).toBe('completed')
    expect(result?.observationIds).toEqual([])
  })

  it('refuses an action with a closed code and no execution fields', () => {
    const decision = admitCapabilityAction(admission({ stopAllActive: true }))
    expect(decision.decision).toBe('refused')
    if (decision.decision !== 'refused') return
    expect(decision.code).toBe('stop_all')
    expect(decision.refusal.terminal).toBe(true)
    expect('admitted' in decision).toBe(false)
  })

  it('records a timed-out result without fabricating a success', () => {
    const result = createActionResult('action-1', 'timed_out', SENSES_TEST_NOW, SENSES_TEST_NOW)
    expect(result?.status).toBe('timed_out')
    expect(result?.settledAt).not.toBeNull()
  })

  it('records a cancelled result', () => {
    const result = createActionResult('action-1', 'cancelled', SENSES_TEST_NOW, SENSES_TEST_NOW)
    expect(result?.status).toBe('cancelled')
  })
})

describe('integration: multi-action', () => {
  it('processes a sequence deterministically', () => {
    const run = (): string =>
      JSON.stringify(
        [
          admission({ request: request({ actionId: 'a', action: 'read', input: { selector: 'body' } }) }),
          admission({ request: request({ actionId: 'b', action: 'click', input: { selector: '#go' } }) }),
          admission({ request: request({ actionId: 'c', action: 'navigate', input: { url: 'bad' } }) }),
        ].map((input) => admitCapabilityAction(input)),
      )
    expect(run()).toBe(run())
  })

  it('refuses every action under STOP ALL, in one deterministic batch', () => {
    const inputs = [
      admission({ request: request({ actionId: 'a' }) }),
      admission({ request: request({ actionId: 'b', action: 'read', input: { selector: 'body' } }) }),
    ].map((input) => ({ ...input, stopAllActive: true }))
    const decisions = inputs.map((input) => admitCapabilityAction(input))
    expect(decisions.every((d) => d.decision === 'refused' && d.code === 'stop_all')).toBe(true)
  })
})
