// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  PHASE25_LIMITS,
  SENSES_TEST_NOW,
  admitCapabilityAction,
  testCaller,
  type CapabilityActionRequest,
  type SensesAdmissionInput,
} from '../../../core/senses'

/**
 * Phase 25: admission is total and never fabricates an instant.
 *
 * Every input — valid, malformed, or at the very edge of the representable
 * date range — must produce a typed decision. A refusal is an answer; a thrown
 * `RangeError` is not, and it would escape into whatever called admission.
 */

/** The largest instant a `Date` can represent; valid input, no representable deadline. */
const MAX_INSTANT_MS = 8_640_000_000_000_000
/** `download-start`'s registration timeout, the longest in the registry. */
const LONGEST_TIMEOUT_MS = 5 * 60_000
const MAX_INSTANT = new Date(MAX_INSTANT_MS).toISOString()
/**
 * The latest instant that can still carry a full-length deadline: one timeout
 * below the ceiling. One millisecond less is still refused, because the
 * deadline would leave the representable range.
 */
const LAST_ADMITTABLE_INSTANT = new Date(MAX_INSTANT_MS - LONGEST_TIMEOUT_MS).toISOString()
/** One millisecond inside the overflow, so the deadline cannot be represented. */
const FIRST_OVERFLOWING_INSTANT = new Date(MAX_INSTANT_MS - LONGEST_TIMEOUT_MS + 1).toISOString()
/** The lowest representable instant. */
const MIN_INSTANT = new Date(-MAX_INSTANT_MS).toISOString()

function downloadRequest(over: Partial<CapabilityActionRequest> = {}): CapabilityActionRequest {
  return {
    actionId: 'action-1',
    capabilityKind: 'download',
    action: 'download-start',
    input: { url: 'https://example.com/f', destination: '/tmp/f' },
    ...over,
  }
}

function admission(over: Partial<SensesAdmissionInput> = {}): SensesAdmissionInput {
  return {
    request: downloadRequest(),
    caller: testCaller(),
    stopAllActive: false,
    now: SENSES_TEST_NOW,
    budgetRemaining: 1000,
    requiredBudget: 1,
    approvals: new Set(['action-1']),
    requiresCognition: false,
    cognitionGrantId: null,
    ...over,
  }
}

describe('admission is total at the edges of the representable range', () => {
  it('refuses rather than throwing when the deadline leaves the range', () => {
    let thrown: unknown = null
    let decision: ReturnType<typeof admitCapabilityAction> | null = null
    try {
      decision = admitCapabilityAction(admission({ now: MAX_INSTANT }))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeNull()
    expect(decision?.decision).toBe('refused')
    if (decision?.decision !== 'refused') return
    expect(decision.code).toBe('invalid_context')
    expect(decision.refusal.terminal).toBe(true)
  })

  it('admits at the last instant that can carry a full-length deadline', () => {
    const decision = admitCapabilityAction(admission({ now: LAST_ADMITTABLE_INSTANT }))
    expect(decision.decision).toBe('admitted')
    if (decision.decision !== 'admitted') return
    // The deadline is a real instant, not a clamped or substituted one.
    expect(Number.isNaN(Date.parse(decision.admitted.deadlineAt))).toBe(false)
    expect(Date.parse(decision.admitted.deadlineAt)).toBe(MAX_INSTANT_MS)
  })

  it('refuses one millisecond later, where the deadline would overflow', () => {
    const decision = admitCapabilityAction(admission({ now: FIRST_OVERFLOWING_INSTANT }))
    expect(decision.decision).toBe('refused')
    if (decision.decision !== 'refused') return
    expect(decision.code).toBe('invalid_context')
  })

  it('admits at the lowest representable instant', () => {
    let thrown: unknown = null
    try {
      admitCapabilityAction(admission({ now: MIN_INSTANT }))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeNull()
  })

  it('returns a decision for every instant, valid or not, and never throws', () => {
    const instants = [
      SENSES_TEST_NOW,
      MAX_INSTANT,
      LAST_ADMITTABLE_INSTANT,
      FIRST_OVERFLOWING_INSTANT,
      MIN_INSTANT,
      'not-a-date',
      '',
      '0',
      'Infinity',
      'null',
      '2026-02-30T00:00:00.000Z',
    ]
    for (const now of instants) {
      for (const timeoutMs of [undefined, null, 0, -5, 1, PHASE25_LIMITS.maxActionTimeoutMs, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => admitCapabilityAction(admission({ now, request: downloadRequest({ timeoutMs }) }))).not.toThrow()
      }
    }
  })

  it('never lowers the timeout below one millisecond or raises it above the action bound', () => {
    const below = admitCapabilityAction(admission({ request: downloadRequest({ timeoutMs: -5 }) }))
    const above = admitCapabilityAction(admission({ request: downloadRequest({ timeoutMs: Number.MAX_SAFE_INTEGER }) }))
    if (below.decision !== 'admitted' || above.decision !== 'admitted') {
      throw new Error('expected both to admit')
    }
    expect(below.admitted.timeoutMs).toBe(1)
    expect(above.admitted.timeoutMs).toBe(300_000)
  })
})