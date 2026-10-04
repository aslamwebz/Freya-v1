import { describe, expect, it } from 'vitest'
import {
  evidenceAsOf,
  experimentBundle,
  initialEconomicState,
  reduceEconomicEntryOnly,
  reduceEconomicState,
  retryCeilingForState,
  type EconomicJournalEntry,
  type EconomicState,
} from '../../../core/economic/state'
import {
  describeEconomicRecovery,
  planEconomicRecovery,
} from '../../../core/economic/recovery'
import { ECONOMIC_LIMITS, CRITERION_SEPARATOR } from '../../../core/economic/types'
import { narrowEconomicLimits } from '../../../core/economic/limits'
import { T0, T_PLUS_31D } from './harness'

/**
 * The event-sourced fold and restart recovery.
 *
 * Two claims are under test here, and both are the kind nobody notices when broken:
 *
 *   - the fold is the *only* source of state, so a cold replay of the journal produces
 *     exactly what the running subsystem had;
 *   - a journal cannot lie. An entry claiming an impossible stage move, a stale `from`, or
 *     a realised P&L the arithmetic does not support is refused and recorded as an
 *     anomaly, rather than believed.
 */

const LIMITS = ECONOMIC_LIMITS

function entry(type: string, payload: Record<string, unknown>, at = T0): EconomicJournalEntry {
  return { type, recordedAt: at, payload }
}

const CREATED = entry('economic.experiment.created', {
  experimentId: 'exp-1',
  kind: 'research',
  state: 'draft',
  title: 'A bounded question',
  question: 'Would anyone pay for this?',
  criteria: ['peer-reviewed-demand', 'competitor-pricing'].join(CRITERION_SEPARATOR),
  criteriaCount: 2,
  progress: 0,
  deadlineAt: '2026-03-31T09:00:00.000Z',
  createdAt: T0,
  updatedAt: T0,
})

const OPENED = entry('economic.experiment.state-changed', {
  experimentId: 'exp-1',
  from: 'IDLE',
  to: 'RESEARCHING',
  signal: 'experiment-opened',
  progress: 0,
  reasoning: 'criteria-unmet',
  updatedAt: T0,
})

const OPENED_RESEARCHING = entry('economic.experiment.state-changed', {
  experimentId: 'exp-1',
  from: 'RESEARCHING',
  to: 'ANALYZING',
  signal: 'research-sufficient',
  progress: 1,
  reasoning: 'criteria-met',
  updatedAt: T0,
})

const OPENED_COMPLETED = entry('economic.experiment.completed', {
  experimentId: 'exp-1',
  from: 'ANALYZING',
  progress: 1,
  criteriaMet: 2,
  completedAt: T0,
})

function fold(entries: readonly EconomicJournalEntry[]): EconomicState {
  return reduceEconomicState(entries, LIMITS).state
}

describe('folding a journal', () => {
  it('starts empty', () => {
    const state = initialEconomicState()
    expect(state.experiments).toEqual([])
    expect(state.stopAllLatched).toBe(false)
    expect(state.orders).toEqual([])
  })

  it('creates an experiment in its draft lifecycle state and its idle stage', () => {
    const state = fold([CREATED])
    expect(state.experiments).toHaveLength(1)
    expect(state.experiments[0]?.state).toBe('draft')
    expect(state.experiments[0]?.stage).toBe('IDLE')
  })

  it('reconstructs the completion criteria from the joined field', () => {
    // They have to survive a restart, or progress could not be re-derived and every
    // experiment would quietly stop being completable.
    const state = fold([CREATED])
    expect(state.experiments[0]?.completionCriteria).toEqual([
      'peer-reviewed-demand',
      'competitor-pricing',
    ])
  })

  it('moves a stage the machine permits', () => {
    const state = fold([CREATED, OPENED])
    expect(state.experiments[0]?.stage).toBe('RESEARCHING')
    expect(state.experiments[0]?.state).toBe('active')
  })

  it('completes an experiment and records when', () => {
    const state = fold([CREATED, OPENED, OPENED_RESEARCHING, OPENED_COMPLETED])
    expect(state.experiments[0]?.stage).toBe('COMPLETE')
    expect(state.experiments[0]?.state).toBe('completed')
    expect(state.experiments[0]?.completedAt).toBe(T0)
  })

  it('is deterministic: the same journal gives deep-equal state', () => {
    const entries = [CREATED, OPENED, OPENED_RESEARCHING, OPENED_COMPLETED]
    expect(fold(entries)).toEqual(fold(entries))
  })

  it('passes over entries belonging to other subsystems', () => {
    const state = fold([entry('core.started', { at: T0 }), CREATED])
    expect(state.experiments).toHaveLength(1)
  })
})

describe('a journal that lies', () => {
  it('refuses an entry claiming a stage the machine has no edge for', () => {
    // `paper-complete` is not a signal `RESEARCHING` can act on, so an entry claiming it
    // moved the experiment into `PAPER_TRADING` is evidence of tampering.
    const forged = entry('economic.experiment.state-changed', {
      experimentId: 'exp-1',
      from: 'RESEARCHING',
      to: 'PAPER_TRADING',
      signal: 'paper-complete',
      progress: 1,
      reasoning: 'criteria-met',
      updatedAt: T0,
    })
    const result = reduceEconomicState([CREATED, OPENED, forged], LIMITS)
    expect(result.state.experiments[0]?.stage).toBe('RESEARCHING')
    expect(result.anomalies.some((anomaly) => anomaly.code === 'illegal-transition')).toBe(true)
  })

  it('refuses an entry whose `from` disagrees with the journal', () => {
    // Otherwise one line could rewind a stage by asserting it used to be somewhere else.
    const forged = entry('economic.experiment.state-changed', {
      experimentId: 'exp-1',
      from: 'PAPER_TRADING',
      to: 'ANALYZING',
      signal: 'paper-complete',
      progress: 1,
      reasoning: 'criteria-met',
      updatedAt: T0,
    })
    const result = reduceEconomicState([CREATED, OPENED, forged], LIMITS)
    expect(result.state.experiments[0]?.stage).toBe('RESEARCHING')
    expect(result.anomalies.some((anomaly) => anomaly.code === 'stage-disagreement')).toBe(true)
  })

  it('refuses an entry whose `to` disagrees with the machine', () => {
    const forged = entry('economic.experiment.state-changed', {
      experimentId: 'exp-1',
      from: 'RESEARCHING',
      to: 'PAPER_TRADING',
      signal: 'research-sufficient',
      progress: 1,
      reasoning: 'criteria-met',
      updatedAt: T0,
    })
    const result = reduceEconomicState([CREATED, OPENED, forged], LIMITS)
    expect(result.state.experiments[0]?.stage).toBe('RESEARCHING')
    expect(result.anomalies.some((anomaly) => anomaly.code === 'stage-disagreement')).toBe(true)
  })

  it('records an anomaly for an unknown economic event type', () => {
    const result = reduceEconomicState([entry('economic.something.else', {})], LIMITS)
    expect(result.anomalies.some((anomaly) => anomaly.code === 'unknown-event-type')).toBe(true)
  })

  it('records an anomaly for a payload naming a real venue', () => {
    // Reported under the real-money anomaly rather than lumped in with an authority
    // escalation: they are different failures and the release gate reads them differently.
    const forged = entry('economic.paper-order.placed', {
      orderId: 'o-1',
      experimentId: 'exp-1',
      symbol: 'ACME',
      side: 'buy',
      quantity: 1,
      price: 100,
      placedAt: T0,
      reasoning: 'simulation',
      venue: 'live',
    })
    const result = reduceEconomicState([CREATED, forged], LIMITS)
    expect(result.anomalies.some((anomaly) => anomaly.code === 'real-money-payload-key')).toBe(true)
    expect(result.state.orders).toHaveLength(0)
  })

  it('records an anomaly for a payload naming a capability', () => {
    const forged = entry('economic.gate.decided', {
      wakeId: 'w-1',
      experimentId: 'exp-1',
      outcome: 'allow',
      code: 'all-gates-clear',
      checked: '',
      remainingUnits: 1,
      at: T0,
      capability: 'research.start',
    })
    const result = reduceEconomicState([forged], LIMITS)
    expect(result.anomalies.some((anomaly) => anomaly.code === 'forbidden-payload-key')).toBe(true)
  })

  it('records an anomaly for a key outside the closed vocabulary', () => {
    const forged = entry('economic.gate.decided', {
      wakeId: 'w-1',
      experimentId: 'exp-1',
      outcome: 'allow',
      code: 'all-gates-clear',
      checked: '',
      remainingUnits: 1,
      at: T0,
      secretHandshake: 'please',
    })
    const result = reduceEconomicState([forged], LIMITS)
    expect(result.anomalies.some((anomaly) => anomaly.code === 'unknown-payload-key')).toBe(true)
  })

  it('records an anomaly for a string over the text ceiling', () => {
    const narrow = narrowEconomicLimits({ maxPayloadTextLength: 20 })
    const forged = entry('economic.experiment.created', {
      ...(CREATED.payload as Record<string, unknown>),
      title: 'a'.repeat(40),
    })
    const result = reduceEconomicState([forged], narrow)
    expect(result.anomalies.some((anomaly) => anomaly.code === 'oversized-payload-text')).toBe(true)
  })

  it('recomputes a realised P&L and reports a mismatch', () => {
    // A journal that could assert a profit the arithmetic does not support would be the
    // one place in Phase 32 where a number could be made up.
    const placed = entry('economic.paper-order.placed', {
      orderId: 'o-1',
      experimentId: 'exp-1',
      symbol: 'ACME',
      side: 'buy',
      quantity: 10,
      price: 100,
      placedAt: T0,
      reasoning: 'simulation',
    })
    const honest = entry('economic.paper-order.filled', {
      orderId: 'o-1',
      experimentId: 'exp-1',
      positionId: 'exp-1:ACME',
      symbol: 'ACME',
      side: 'buy',
      quantity: 10,
      price: 100,
      realizedPnl: 0,
    })
    const clean = reduceEconomicState([CREATED, placed, honest], LIMITS)
    expect(clean.state.positions[0]?.quantity).toBe(10)
    expect(clean.anomalies).toHaveLength(0)

    const forged = entry('economic.paper-order.filled', {
      ...(honest.payload as Record<string, unknown>),
      realizedPnl: 5_000,
    })
    const dirty = reduceEconomicState([CREATED, placed, forged], LIMITS)
    expect(dirty.anomalies.some((anomaly) => anomaly.detail.includes('realised P&L'))).toBe(true)
    expect(dirty.state.realizedPnl['exp-1']).toBe(0)
  })

  it('refuses an entry naming an experiment that does not exist', () => {
    const orphan = entry('economic.experiment.state-changed', {
      experimentId: 'ghost',
      from: 'IDLE',
      to: 'RESEARCHING',
      signal: 'experiment-opened',
      progress: 0,
      reasoning: 'criteria-unmet',
      updatedAt: T0,
    })
    const result = reduceEconomicState([orphan], LIMITS)
    expect(result.anomalies.some((anomaly) => anomaly.code === 'unknown-experiment')).toBe(true)
  })

  it('refuses to create the same experiment twice', () => {
    const result = reduceEconomicState([CREATED, CREATED], LIMITS)
    expect(result.state.experiments).toHaveLength(1)
    expect(result.anomalies.length).toBeGreaterThan(0)
  })
})

describe('the STOP ALL latch', () => {
  const STOPPED = entry('economic.stopped', {
    experimentId: '',
    stage: 'IDLE',
    code: 'stop-all-latched',
  })

  it('sets the latch from any state, including an idle one', () => {
    const state = fold([STOPPED])
    expect(state.stopAllLatched).toBe(true)
    expect(state.stopCode).toBe('stop-all-latched')
  })

  it('refuses a lift with no owner\'s clearing behind it', () => {
    // Without this, one line written into the journal would un-press the panic button and
    // turn "Freya can be stopped" into "Freya can be un-stopped by whoever has write
    // access to a text file".
    const lifted = entry('economic.unstopped', { code: 'stop-latch-cleared' })
    const closed = reduceEconomicEntryOnly(fold([STOPPED]), lifted, { ownerClearedStop: false }, LIMITS)
    expect(closed.state.stopAllLatched).toBe(true)
    expect(closed.anomalies.length).toBeGreaterThan(0)
  })

  it('accepts a lift the owner stands behind', () => {
    const lifted = entry('economic.unstopped', { code: 'stop-latch-cleared' })
    const opened = reduceEconomicEntryOnly(fold([STOPPED]), lifted, { ownerClearedStop: true }, LIMITS)
    expect(opened.state.stopAllLatched).toBe(false)
    expect(opened.state.stopCode).toBeNull()
  })

  it('refuses a lift that arrived while nothing was latched', () => {
    const lifted = entry('economic.unstopped', { code: 'stop-latch-cleared' })
    const result = reduceEconomicState([lifted], LIMITS)
    expect(result.anomalies.length).toBeGreaterThan(0)
  })

  it('finds the owner\'s clearing in a whole journal', () => {
    // The whole-journal fold has to derive it from the security events rather than from
    // the subsystem's own terminal state, which cannot tell a panic button from a clean
    // close-out.
    const journal = [
      STOPPED,
      entry('security.stop_all.cleared', { by: 'owner' }),
      entry('economic.unstopped', { code: 'stop-latch-cleared' }),
    ]
    expect(fold(journal).stopAllLatched).toBe(false)
  })

  it('refuses a lift whose code is not the owner\'s', () => {
    const lifted = entry('economic.unstopped', { code: 'restart-recovery' })
    const result = reduceEconomicEntryOnly(fold([STOPPED]), lifted, { ownerClearedStop: true }, LIMITS)
    expect(result.state.stopAllLatched).toBe(true)
  })

  it('reports a second press of the button as an anomaly', () => {
    const result = reduceEconomicState([STOPPED, STOPPED], LIMITS)
    expect(result.anomalies.some((anomaly) => anomaly.code === 'terminal-stage-re-entered')).toBe(true)
  })
})

describe('reading the fold', () => {
  it('joins one experiment\'s records and nobody else\'s', () => {
    const second = entry('economic.experiment.created', {
      ...(CREATED.payload as Record<string, unknown>),
      experimentId: 'exp-2',
    })
    const mine = entry('economic.evidence.gathered', {
      evidenceId: 'ev-1',
      experimentId: 'exp-1',
      source: 'published-study',
      sourceRef: 'filing-a',
      citation: 'A study',
      claim: 'peer-reviewed-demand',
      observedAt: T0,
      state: 'fresh',
      confidence: 'medium',
    })
    const bundle = experimentBundle(fold([CREATED, second, mine]), 'exp-1')
    expect(bundle.evidence).toHaveLength(1)
    expect(experimentBundle(fold([CREATED, second, mine]), 'exp-2').evidence).toHaveLength(0)
  })

  it('re-derives evidence freshness at read time', () => {
    const mine = entry('economic.evidence.gathered', {
      evidenceId: 'ev-1',
      experimentId: 'exp-1',
      source: 'published-study',
      sourceRef: 'filing-a',
      citation: 'A study',
      claim: 'peer-reviewed-demand',
      observedAt: T0,
      state: 'fresh',
      confidence: 'medium',
    })
    const state = fold([CREATED, mine])
    expect(state.evidence[0]?.state).toBe('fresh')
    expect(evidenceAsOf(state, T0, LIMITS)[0]?.state).toBe('fresh')
    expect(evidenceAsOf(state, T_PLUS_31D, LIMITS)[0]?.state).toBe('stale')
  })

  it('derives the retry ceiling from the journal, not from memory', () => {
    const state = initialEconomicState()
    expect(retryCeilingForState(state, LIMITS).currentAttempt).toBe(0)
    expect(retryCeilingForState(state, LIMITS).maxAttempts).toBe(LIMITS.maxRetryCeiling)
  })
})

describe('restart recovery', () => {
  it('has nothing to do for an empty journal', () => {
    const report = planEconomicRecovery({
      state: initialEconomicState(),
      now: T0,
      stopAllActive: false,
    })
    expect(report.reconciled).toBe(false)
    expect(report.resumption).toBe('awaiting-wake')
    expect(report.requiresOwnerAction).toBe(false)
    expect(describeEconomicRecovery(report)).toBeNull()
  })

  it('records an interrupted experiment and changes nothing about where it is', () => {
    // The whole claim: a process that died mid-stage cannot be resumed, so it is made
    // visible and left alone.
    const state = fold([CREATED, OPENED])
    const before = state.experiments[0]?.stage
    const report = planEconomicRecovery({ state, now: T_PLUS_31D, stopAllActive: false })
    expect(report.reconciled).toBe(true)
    expect(report.interrupted).toHaveLength(1)
    expect(report.interrupted[0]?.stage).toBe('RESEARCHING')
    expect(state.experiments[0]?.stage).toBe(before)
  })

  it('never resumes on its own', () => {
    const report = planEconomicRecovery({
      state: fold([CREATED, OPENED]),
      now: T0,
      stopAllActive: false,
    })
    expect(report.resumption).toBe('awaiting-wake')
    // And it says a person is needed, because somebody has to decide whether these go on.
    expect(report.requiresOwnerAction).toBe(true)
  })

  it('reports a completed experiment as nothing to reconcile', () => {
    const state = fold([CREATED, OPENED, OPENED_RESEARCHING, OPENED_COMPLETED])
    const report = planEconomicRecovery({ state, now: T0, stopAllActive: false })
    expect(report.reconciled).toBe(false)
    expect(report.actions[0]?.code).toBe('experiments-already-terminal')
  })

  it('puts STOP ALL above everything else', () => {
    // A stopped subsystem is not a subsystem with experiments in it, and reporting the
    // experiments would let a reader conclude work is in progress when nothing is.
    const report = planEconomicRecovery({
      state: fold([CREATED, OPENED]),
      now: T0,
      stopAllActive: true,
    })
    expect(report.stopAllActive).toBe(true)
    expect(report.interrupted).toEqual([])
    expect(report.actions[0]?.code).toBe('stop-all-latched')
    expect(report.requiresOwnerAction).toBe(true)
  })

  it('finds a live experiment the journal never reconciled', () => {
    // A journal truncated between two entries would otherwise leave a half-finished
    // experiment looking untouched.
    const report = planEconomicRecovery({
      state: fold([CREATED, OPENED]),
      now: T0,
      stopAllActive: false,
    })
    expect(report.interrupted[0]?.code).toBe('restart-recovery')
  })

  it('describes an interruption in one line a person can act on', () => {
    const report = planEconomicRecovery({
      state: fold([CREATED, OPENED]),
      now: T0,
      stopAllActive: false,
    })
    const line = describeEconomicRecovery(report)
    expect(line).toContain('interrupted')
    expect(line).toContain('resumed')
  })
})