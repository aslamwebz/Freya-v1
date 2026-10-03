import { describe, expect, it } from 'vitest'
import {
  CONTINUATION_SIGNALS,
  CONTINUATION_STATES,
  INTERRUPTION_SOURCES,
  allInterruptions,
  allOrdinaryTransitions,
  auditContinuationTable,
  interrupt,
  interruptionDeadlineType,
  requiresDeadline,
  transition,
  type ContinuationSignal,
  type ContinuationState,
  type InterruptionSource,
} from '../../../core/lifeloop'

/**
 * These are exhaustion tests. Every one walks the whole table rather than a
 * sample, because the properties being claimed — no self-transitions, no
 * outgoing edge from a terminal state, STOP ALL reaching everything — are
 * properties of the *table*, and a handful of examples cannot establish them.
 */
describe('the ordinary transition table', () => {
  it('has no self-transition anywhere', () => {
    const findings = allOrdinaryTransitions()
      .filter((entry) => entry.to === entry.from)
      .map((entry) => `${entry.from} on "${entry.signal}"`)
    expect(findings).toEqual([])
  })

  it('refuses every signal from every state except the ones in the table', () => {
    for (const { from, signal, to } of allOrdinaryTransitions()) {
      const result = transition(from, signal)
      if (to === null) {
        expect(result.ok, `${from} on ${signal}`).toBe(false)
        continue
      }
      expect(result.ok, `${from} on ${signal}`).toBe(true)
      if (result.ok) expect(result.to).toBe(to)
    }
  })

  it('gives a terminal state no edge other than an explicit reset', () => {
    for (const terminal of ['DENY', 'STOP'] as const) {
      for (const signal of CONTINUATION_SIGNALS) {
        const result = transition(terminal, signal)
        if (signal === 'reset') {
          expect(result.ok, `${terminal} reset`).toBe(true)
          continue
        }
        expect(result.ok, `${terminal} on ${signal}`).toBe(false)
        if (!result.ok) expect(result.code).toBe('already-terminal')
      }
    }
  })

  it('refuses a signal that is not in the closed set', () => {
    const result = transition('IDLE', 'wake-please' as ContinuationSignal)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('illegal-transition')
  })

  it('refuses a state that is not in the closed set', () => {
    const result = transition('THINKING' as ContinuationState, 'wake-received')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('illegal-transition')
  })

  it('can only reach IDLE by a reset', () => {
    // The property that makes "closed out" a real state rather than a formality:
    // nothing anywhere in the ordinary table lands on IDLE except a reset from a
    // terminal state. So an idle Freya is idle because she finished, never
    // because a step happened to hand her back.
    const arrivals = allOrdinaryTransitions().filter((entry) => entry.to === 'IDLE')
    expect(arrivals).toHaveLength(2)
    for (const arrival of arrivals) {
      expect(arrival.from).toMatch(/^(DENY|STOP)$/)
      expect(arrival.signal).toBe('reset')
    }
  })

  it('can only reach ACTING from ALLOW', () => {
    const arrivals = allOrdinaryTransitions().filter((entry) => entry.to === 'ACTING')
    expect(arrivals.map((entry) => `${entry.from}>${entry.to}`)).toEqual(['ALLOW>ACTING'])
  })

  it('can only reach ALLOW from WAKING', () => {
    // The state that means "cognition is justified" has exactly one door, and it
    // is the door the deterministic filter opens.
    const arrivals = allOrdinaryTransitions().filter((entry) => entry.to === 'ALLOW')
    expect(arrivals.map((entry) => entry.from)).toEqual(['WAKING'])
  })

  it('names a journal event for every state change it makes', () => {
    for (const { from, signal } of allOrdinaryTransitions()) {
      const result = transition(from, signal)
      if (!result.ok) continue
      // `DENY -> IDLE` and `STOP -> IDLE` are the reset edge. A reset is the act
      // of clearing in-memory bookkeeping, so it writes nothing; every other
      // state change must name the event that records it.
      if (result.signal === 'reset') {
        expect(result.event).toBeNull()
        continue
      }
      expect(result.event, `${from} on ${signal}`).toMatch(/^lifeloop\./)
    }
  })
})

describe('the state machine table satisfies its own invariants', () => {
  it('audits clean', () => {
    expect(auditContinuationTable()).toEqual([])
  })

  it('reaches ACTING only after passing the filter', () => {
    // The whole "wake does not imply a model call" argument, expressed as a path:
    // IDLE -> WAKING -> DENY is a complete path that never reaches cognition.
    expect(transition('WAKING', 'filter-denied').ok).toBe(true)
    expect(transition('DENY', 'cognition-allowed' as ContinuationSignal).ok).toBe(false)
  })
})

describe('waiting states must hold a deadline', () => {
  it('names exactly WAIT, ACTING and VERIFYING as states that wait on the world', () => {
    for (const state of CONTINUATION_STATES) {
      const expected = state === 'WAIT' || state === 'ACTING' || state === 'VERIFYING'
      expect(requiresDeadline(state), state).toBe(expected)
    }
  })
})

describe('interruption reaches every state, and outranks the ordinary table', () => {
  it('lets STOP ALL reach every state that is not already terminal', () => {
    for (const from of CONTINUATION_STATES) {
      const result = interrupt(from, 'stop-all')
      if (from === 'STOP' || from === 'DENY') {
        expect(result.applied, from).toBe(false)
        continue
      }
      expect(result.applied, from).toBe(true)
      if (result.applied) expect(result.to).toBe('STOP')
    }
  })

  it('refuses to move a stopped loop with anything but another stop', () => {
    // Clearing the latch is a separate, explicit act by the owner. If an owner
    // command could move a stopped loop then "stop" would mean "stop until the
    // next thing that happens", which is not what STOP ALL has ever meant.
    for (const source of INTERRUPTION_SOURCES) {
      if (source === 'stop-all') continue
      const result = interrupt('STOP', source)
      expect(result.applied, source).toBe(false)
      if (!result.applied) expect(result.code).toBe('stop-all-latched')
    }
  })

  it('treats a denied loop as finished until it is closed out', () => {
    for (const source of INTERRUPTION_SOURCES) {
      if (source === 'stop-all') continue
      const result = interrupt('DENY', source)
      expect(result.applied, source).toBe(false)
      if (!result.applied) expect(result.code).toBe('terminal')
    }
  })

  it('reports an idle loop as having nothing to preempt, rather than as a failure', () => {
    for (const source of ['guard-denial', 'budget-exhaustion', 'deadline-expiry'] as const) {
      const result = interrupt('IDLE', source)
      expect(result.applied, source).toBe(false)
      if (!result.applied) expect(result.code).toBe('nothing-to-preempt')
    }
  })

  it('denies the loop from every state a refusal can arrive in', () => {
    for (const source of ['guard-denial', 'budget-exhaustion', 'deadline-expiry'] as const) {
      for (const from of ['WAKING', 'WAIT', 'ALLOW', 'ACTING', 'VERIFYING', 'CONTINUE'] as const) {
        const result = interrupt(from, source)
        expect(result.applied, `${from}/${source}`).toBe(true)
        if (result.applied) expect(result.to).toBe('DENY')
      }
    }
  })

  it('parks the loop on an unanswered approval rather than denying it', () => {
    // Approval is not a refusal. The action stops, and the loop waits on a
    // person — denying here would tell the journal the owner said no, which is a
    // different and unfalse claim.
    for (const from of ['WAKING', 'WAIT', 'ALLOW', 'ACTING', 'VERIFYING', 'CONTINUE'] as const) {
      const result = interrupt(from, 'approval-required')
      expect(result.applied, from).toBe(true)
      if (result.applied) {
        expect(result.to).toBe('WAIT')
        expect(result.awaitingApproval).toBe(true)
      }
    }
  })

  it('never asks an idle loop for approval, because nothing is waiting on one', () => {
    const result = interrupt('IDLE', 'approval-required')
    expect(result.applied).toBe(false)
    if (!result.applied) expect(result.code).toBe('nothing-to-preempt')
  })

  it('marks only approval as awaiting the owner', () => {
    for (const { from, source } of allInterruptions()) {
      const result = interrupt(from, source as InterruptionSource)
      if (result.applied) {
        expect(result.awaitingApproval, `${from}/${source}`).toBe(source === 'approval-required')
      }
    }
  })

  it('holds an approval on a clock, and only an approval', () => {
    // The `approval` deadline type existed with no producer until this moment.
    // An unanswered request for a person expires like anything else, but it has
    // to be legible as an approval afterwards rather than as a condition.
    expect(interruptionDeadlineType('approval-required')).toBe('approval')
    for (const source of INTERRUPTION_SOURCES) {
      if (source === 'approval-required') continue
      expect(interruptionDeadlineType(source), source).toBeNull()
    }
  })

  it('lets the owner preempt every state, and marks it as a preemption', () => {
    for (const from of ['IDLE', 'WAKING', 'WAIT', 'ALLOW', 'ACTING', 'VERIFYING', 'CONTINUE'] as const) {
      const result = interrupt(from, 'owner-command')
      expect(result.applied, from).toBe(true)
      if (result.applied) {
        expect(result.to).toBe('WAKING')
        expect(result.preempted).toBe(true)
      }
    }
  })

  it('marks only the owner command as a preemption; everything else terminates', () => {
    for (const { from, source } of allInterruptions()) {
      const result = interrupt(from, source as InterruptionSource)
      if (result.applied) expect(result.preempted, `${from}/${source}`).toBe(source === 'owner-command')
    }
  })

  it('permits exactly two self-transitions, and both are a second arrival', () => {
    // The interruption table is an override of the ordinary one, so these are the
    // only documented exceptions to "no self-transitions". Neither is an
    // oversight: a loop already waking for the owner's command records the second
    // arrival rather than pretending it did not happen, and a loop already parked
    // on an unanswered approval stays parked instead of resetting a deadline that
    // is still counting.
    const selfTransitions = allInterruptions().filter((entry) => entry.to === entry.from)
    expect(selfTransitions).toHaveLength(2)
    expect(selfTransitions).toEqual(
      expect.arrayContaining([
        { from: 'WAKING', source: 'owner-command', to: 'WAKING' },
        { from: 'WAIT', source: 'approval-required', to: 'WAIT' },
      ]),
    )
  })

  it('refuses to move the loop from a state that does not exist, and says why', () => {
    const result = interrupt('THINKING' as ContinuationState, 'stop-all')
    expect(result.applied).toBe(false)
    // `unknown-state`, not `terminal`. A corrupt journal entry is not the same
    // claim as a loop that finished, and reading one as the other would let a
    // hole in the log pass for Freya having finished her work.
    expect(result).toMatchObject({ code: 'unknown-state' })
  })
})