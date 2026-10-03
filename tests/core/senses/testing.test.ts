// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  PHASE25_LIMITS,
  SENSES_TEST_NOW,
  admitCapabilityAction,
  createActionResult,
  createObservation,
  createVerification,
  runCapabilityTest,
  testCaller,
  type CapabilityActionRequest,
} from '../../../core/senses'

/**
 * Phase 25: the record factories are part of the public `core/senses` surface,
 * so they must hold the same line as the admission pipeline.
 *
 * They fail closed. A factory never fabricates an instant, never reports a
 * non-finite duration, and never carries an unbounded observation. When the
 * inputs cannot produce an honest bounded record it returns `null` rather than
 * inventing one — `null` is already the module's own "not known / not settled"
 * value in `durationMs`, `settledAt` and `verdictAt`.
 */

const T0 = SENSES_TEST_NOW
const T1 = '2026-10-01T12:00:01.000Z'

/* ------------------------------------------------ createActionResult */

describe('createActionResult fails closed rather than reporting a false duration', () => {
  it('reports a real duration for two valid instants', () => {
    const result = createActionResult('action-1', 'completed', T0, T1)
    expect(result).not.toBeNull()
    expect(result?.durationMs).toBe(1_000)
    expect(result?.status).toBe('completed')
  })

  it('never returns a non-finite duration, whatever the instants', () => {
    const instants = [T0, T1, 'not-a-date', '', '0', 'Infinity', 'null']
    for (const startedAt of instants) {
      for (const settledAt of [...instants, null]) {
        const result = createActionResult('action-1', 'completed', startedAt, settledAt)
        if (result === null) continue
        expect(Number.isFinite(result.durationMs ?? 0)).toBe(true)
      }
    }
  })

  it('returns null when startedAt is not an instant', () => {
    expect(createActionResult('action-1', 'completed', 'not-a-date', T1)).toBeNull()
    expect(createActionResult('action-1', 'completed', '', T1)).toBeNull()
  })

  it('returns null when a terminal result has no valid settledAt', () => {
    expect(createActionResult('action-1', 'completed', T0, null)).toBeNull()
    expect(createActionResult('action-1', 'completed', T0, 'not-a-date')).toBeNull()
    expect(createActionResult('action-1', 'timed_out', T0, '')).toBeNull()
  })

  it('returns null rather than reporting zero for a result that settled before it started', () => {
    expect(createActionResult('action-1', 'completed', T1, T0)).toBeNull()
  })

  it('records a running action as unsettled, with no duration and no settle instant', () => {
    const result = createActionResult('action-1', 'running', T0, null)
    expect(result?.status).toBe('running')
    expect(result?.durationMs).toBeNull()
    expect(result?.settledAt).toBeNull()
  })

  it('returns null when a running action claims to have settled', () => {
    expect(createActionResult('action-1', 'running', T0, T1)).toBeNull()
  })

  it('returns null for an unbounded or malformed actionId', () => {
    expect(createActionResult('not a valid id!', 'completed', T0, T1)).toBeNull()
    expect(createActionResult('', 'completed', T0, T1)).toBeNull()
    expect(createActionResult('a'.repeat(129), 'completed', T0, T1)).toBeNull()
  })

  it('produces no execution evidence on its own: no observations, no verdict', () => {
    const result = createActionResult('action-1', 'completed', T0, T1)
    expect(result?.observationIds).toEqual([])
    expect(result?.reason).toBeNull()
  })
})

/* ------------------------------------------------- createObservation */

describe('createObservation is a bounded record', () => {
  it('records an observation with no payload attached', () => {
    const observation = createObservation('obs-1', 'action-1', 'result', 'page loaded', T0)
    expect(observation?.kind).toBe('result')
    expect(observation?.data).toEqual({})
    expect(observation?.summary).toBe('page loaded')
  })

  it('returns null for an unbounded summary rather than truncating it silently', () => {
    const huge = 'x'.repeat(PHASE25_LIMITS.maxInputBytes + 1)
    expect(createObservation('obs-1', 'action-1', 'result', huge, T0)).toBeNull()
  })

  it('accepts a summary exactly at the bound', () => {
    const atBound = 'x'.repeat(PHASE25_LIMITS.maxInputBytes)
    const observation = createObservation('obs-1', 'action-1', 'result', atBound, T0)
    expect(observation?.summary).toHaveLength(PHASE25_LIMITS.maxInputBytes)
  })

  it('returns null when recordedAt is not an instant', () => {
    expect(createObservation('obs-1', 'action-1', 'result', 'page loaded', 'not-a-date')).toBeNull()
    expect(createObservation('obs-1', 'action-1', 'result', 'page loaded', '')).toBeNull()
  })

  it('returns null for malformed observation or action ids', () => {
    expect(createObservation('!!', 'action-1', 'result', 'page loaded', T0)).toBeNull()
    expect(createObservation('obs-1', 'not a valid id!', 'result', 'page loaded', T0)).toBeNull()
    expect(createObservation('', 'action-1', 'result', 'page loaded', T0)).toBeNull()
  })

  it('returns null for a kind outside the closed observation vocabulary', () => {
    const kind = 'conclusion' as unknown as Parameters<typeof createObservation>[2]
    expect(createObservation('obs-1', 'action-1', kind, 'page loaded', T0)).toBeNull()
  })
})

/* ----------------------------------------------- createVerification */

describe('createVerification never fabricates a verdict instant', () => {
  it('records the instant it is given, not a substituted one', () => {
    const verification = createVerification('ver-1', 'action-1', 'passed', T1)
    expect(verification?.status).toBe('passed')
    expect(verification?.verdictAt).toBe(T1)
  })

  it('returns null rather than stamping a verdict that was never dated', () => {
    expect(createVerification('ver-1', 'action-1', 'passed', null)).toBeNull()
    expect(createVerification('ver-1', 'action-1', 'passed', 'not-a-date')).toBeNull()
    expect(createVerification('ver-1', 'action-1', 'failed', null)).toBeNull()
  })

  it('leaves a requested verification undated', () => {
    const verification = createVerification('ver-1', 'action-1', 'requested', null)
    expect(verification?.status).toBe('requested')
    expect(verification?.verdictAt).toBeNull()
  })

  it('returns null for a requested verification that claims a verdict instant', () => {
    expect(createVerification('ver-1', 'action-1', 'requested', T1)).toBeNull()
  })

  it('returns null for malformed verification or action ids', () => {
    expect(createVerification('!!', 'action-1', 'passed', T1)).toBeNull()
    expect(createVerification('ver-1', 'not a valid id!', 'passed', T1)).toBeNull()
  })

  it('returns null for a status outside the closed verification vocabulary', () => {
    const status = 'verified' as unknown as Parameters<typeof createVerification>[2]
    expect(createVerification('ver-1', 'action-1', status, T1)).toBeNull()
  })
})

/* ------------------------- a test outcome is not execution evidence */

describe('a capability test outcome is not execution evidence', () => {
  const request: CapabilityActionRequest = {
    actionId: 'action-1',
    capabilityKind: 'browser',
    action: 'navigate',
    input: { url: 'https://example.com' },
  }

  it('reports completed for an action that is still pending, not executed', () => {
    const decision = admitCapabilityAction({
      request,
      caller: testCaller(),
      stopAllActive: false,
      now: T0,
      budgetRemaining: 1000,
      requiredBudget: 1,
      approvals: new Set(['action-1']),
      requiresCognition: false,
      cognitionGrantId: null,
    })
    expect(decision.decision).toBe('admitted')
    if (decision.decision !== 'admitted') return
    // The vocabulary overlaps with the action-result status, but the state does
    // not: admission stops at pending, and only a verifier can close an action.
    expect(decision.admitted.status).toBe('pending')

    const result = runCapabilityTest({
      testId: 'browser.navigate.valid',
      capabilityKind: 'browser',
      action: 'navigate',
      input: { url: 'https://example.com' },
      expectedOutcome: 'completed',
    })
    expect(result.actualOutcome).toBe('completed')
    // No executor ran, so a test reports no elapsed time and no observations.
    expect(result.durationMs).toBe(0)
    expect(result).not.toHaveProperty('observationIds')
    expect(result).not.toHaveProperty('settledAt')
  })

  it('is deterministic: repeated runs agree exactly', () => {
    const test = {
      testId: 'terminal.command-run.valid',
      capabilityKind: 'terminal' as const,
      action: 'command-run',
      input: { command: 'echo hi' },
      expectedOutcome: 'completed' as const,
    }
    expect(JSON.stringify(runCapabilityTest(test))).toBe(JSON.stringify(runCapabilityTest(test)))
  })
})