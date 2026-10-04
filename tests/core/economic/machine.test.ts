import { describe, expect, it } from 'vitest'
import {
  NO_LONG_HORIZON_SEAM,
  isSeamConnected,
  mayHonourGoal,
  type LongHorizonSeam,
} from '../../../core/economic/seams'
import { narrowEconomicLimits, narrowedLimitNames } from '../../../core/economic/limits'
import {
  ECONOMIC_LIMITS,
  ECONOMIC_STAGES,
  FORBIDDEN_ECONOMIC_PAYLOAD_KEYS,
  isCriterion,
  type EconomicExperimentKind,
  type EconomicSignal,
} from '../../../core/economic/types'
import {
  allEconomicTransitions,
  auditEconomicTable,
  signalsFrom,
  transition,
} from '../../../core/economic/machine'
import { ALL_KINDS, ALL_SIGNALS, ALL_STAGES, record } from './fixture'
import { T0 } from './harness'

/**
 * The state machine, the limits clamp and the Phase 31 seam.
 *
 * These three are grouped because they are the three places where "correct" means a
 * property over a finite set rather than a handful of examples: the transition table is
 * exhausted, the clamp is fed hostile values, and the seam is checked for the ability to
 * drive anything on its own.
 */

describe('the economic state machine', () => {
  it('passes its own audit of the table', () => {
    // No self-transition, no outgoing edge from a terminal stage except the close-out,
    // and every edge names the journal event that records it.
    expect(auditEconomicTable()).toEqual([])
  })

  it('opens each kind in the stage it is supposed to open in', () => {
    expect(transition('IDLE', 'experiment-opened', 'research').ok).toBe(true)
    const research = transition('IDLE', 'experiment-opened', 'research')
    const simulation = transition('IDLE', 'experiment-opened', 'simulation')
    const paper = transition('IDLE', 'experiment-opened', 'paper-trading')
    expect(research.ok && research.to).toBe('RESEARCHING')
    expect(simulation.ok && simulation.to).toBe('SIMULATING')
    expect(paper.ok && paper.to).toBe('PAPER_TRADING')
  })

  it('refuses to open an experiment whose kind was not stated', () => {
    // A guessed stage would be the difference between "research" and "paper trading",
    // which is the difference between gathering evidence and moving simulated capital.
    const outcome = transition('IDLE', 'experiment-opened')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('missing-experiment-kind')
  })

  it('refuses an unknown kind rather than coercing it to the first stage', () => {
    const outcome = transition('IDLE', 'experiment-opened', 'trading' as EconomicExperimentKind)
    expect(outcome.ok).toBe(false)
  })

  it('expresses a skipped stage as a different signal, not a different table', () => {
    // The table itself is kind-independent: `research-complete` means "and there is a
    // simulation to run" and `research-sufficient` means "and there is not". The *planner*
    // chooses between them, which is what keeps the skip a decision with a name rather
    // than a special case smuggled into the edges.
    expect(transition('RESEARCHING', 'research-complete', 'paper-trading').ok).toBe(true)
    expect(transition('RESEARCHING', 'research-complete', 'paper-trading')).toMatchObject({
      to: 'SIMULATING',
    })
    expect(transition('RESEARCHING', 'research-sufficient', 'research')).toMatchObject({
      to: 'ANALYZING',
    })
    // The same pair exists at the next stage, for the same reason.
    expect(transition('SIMULATING', 'simulation-complete', 'paper-trading')).toMatchObject({
      to: 'PAPER_TRADING',
    })
    expect(transition('SIMULATING', 'simulation-sufficient', 'simulation')).toMatchObject({
      to: 'ANALYZING',
    })
  })

  it('fails from every stage a kind can open in', () => {
    for (const kind of ALL_KINDS) {
      const opened = transition('IDLE', 'experiment-opened', kind)
      expect(opened.ok).toBe(true)
      if (!opened.ok) continue
      const failed = transition(opened.to, 'experiment-failed', kind)
      expect(failed.ok && failed.to).toBe('FAILED')
    }
  })

  it('has no outgoing edge from a terminal stage except the close-out', () => {
    for (const stage of ['COMPLETE', 'FAILED'] as const) {
      for (const signal of ALL_SIGNALS) {
        const outcome = transition(stage, signal, 'research')
        const legal = outcome.ok && signal === 'experiment-closed'
        expect(legal, `${stage} on ${signal} should be ${signal === 'experiment-closed'}`).toBe(
          signal === 'experiment-closed',
        )
      }
    }
  })

  it('distinguishes a terminal stage from a move that is simply not in the table', () => {
    const terminal = transition('COMPLETE', 'paper-complete', 'paper-trading')
    const notInTable = transition('RESEARCHING', 'paper-complete', 'research')
    expect(terminal.ok).toBe(false)
    expect(notInTable.ok).toBe(false)
    if (!terminal.ok && !notInTable.ok) {
      expect(terminal.code).toBe('already-terminal')
      expect(notInTable.code).toBe('illegal-transition')
    }
  })

  it('refuses an unknown stage or signal rather than reaching for a default', () => {
    const stage = transition('NOWHERE' as never, 'experiment-failed', 'research')
    const signal = transition('RESEARCHING', 'teleport' as EconomicSignal, 'research')
    expect(stage.ok).toBe(false)
    expect(signal.ok).toBe(false)
    if (!stage.ok) expect(stage.code).toBe('unknown-stage')
    if (!signal.ok) expect(signal.code).toBe('illegal-transition')
  })

  it('is total over every (stage, signal) pair', () => {
    const rows = allEconomicTransitions()
    expect(rows.length).toBe(ECONOMIC_STAGES.length * ALL_SIGNALS.length)
    for (const row of rows) {
      expect(ECONOMIC_STAGES).toContain(row.from)
      expect(ALL_SIGNALS).toContain(row.signal)
    }
  })

  it('can be reached from any live stage by some signal', () => {
    for (const stage of ALL_STAGES) {
      const legal = signalsFrom(stage)
      if (stage === 'COMPLETE' || stage === 'FAILED') {
        expect(legal).toEqual(['experiment-closed'])
        continue
      }
      expect(legal.length).toBeGreaterThan(0)
    }
  })
})

describe('narrowing the ceilings', () => {
  it('returns the frozen ceilings for no request', () => {
    expect(narrowEconomicLimits()).toEqual(ECONOMIC_LIMITS)
  })

  it('clamps a wider request down rather than applying or refusing it', () => {
    // Refusing would mean a host passing a generous limit finds the subsystem switched
    // off, and the natural response to that is to pass a smaller one.
    expect(narrowEconomicLimits({ maxExperiments: 9_999 }).maxExperiments).toBe(
      ECONOMIC_LIMITS.maxExperiments,
    )
  })

  it('honours a narrower request', () => {
    expect(narrowEconomicLimits({ maxExperiments: 2 }).maxExperiments).toBe(2)
  })

  it('honours zero, because "may not simulate anything" is a real configuration', () => {
    expect(narrowEconomicLimits({ maxExperiments: 0 }).maxExperiments).toBe(0)
    expect(narrowEconomicLimits({ maxExperiments: -1 }).maxExperiments).toBe(0)
  })

  it('floors a fractional request rather than rounding it up', () => {
    // Rounding *up* would be the dangerous direction: a request for 2.7 experiments must
    // not become three.
    expect(narrowEconomicLimits({ maxExperiments: 2.7 }).maxExperiments).toBe(2)
  })

  it('falls back to the ceiling for a value that is not a finite number', () => {
    // `NaN` clamped naively is `NaN`, and a bound that is `NaN` is no bound at all.
    for (const asked of [Number.NaN, Number.POSITIVE_INFINITY, '10', null, {}, []]) {
      const narrowed = narrowEconomicLimits({ maxExperiments: asked as unknown })
      expect(narrowed.maxExperiments).toBe(ECONOMIC_LIMITS.maxExperiments)
    }
  })

  it('never widens any ceiling, for any request', () => {
    const hostile: Record<string, unknown> = {}
    for (const key of Object.keys(ECONOMIC_LIMITS)) hostile[key] = Number.MAX_SAFE_INTEGER
    const narrowed = narrowEconomicLimits(hostile as never)
    for (const key of Object.keys(ECONOMIC_LIMITS) as (keyof typeof ECONOMIC_LIMITS)[]) {
      expect(narrowed[key]).toBeLessThanOrEqual(ECONOMIC_LIMITS[key])
    }
  })

  it('names the limits a deployment narrowed', () => {
    expect(narrowedLimitNames(narrowEconomicLimits())).toEqual([])
    expect(narrowedLimitNames(narrowEconomicLimits({ maxExperiments: 1 }))).toEqual(['maxExperiments'])
  })
})

describe('the Phase 31 seam', () => {
  it('is inert by default and says so', () => {
    expect(isSeamConnected(NO_LONG_HORIZON_SEAM)).toBe(false)
    expect(NO_LONG_HORIZON_SEAM.name).toBe('no-long-horizon-seam')
    expect(NO_LONG_HORIZON_SEAM.goalsFor('exp-1')).toEqual([])
    expect(NO_LONG_HORIZON_SEAM.wakeFor('goal-1', T0)).toBeNull()
    expect(NO_LONG_HORIZON_SEAM.continueGoal('goal-1')).toBe(false)
  })

  it('cannot authorise anything on its own', () => {
    expect(mayHonourGoal(NO_LONG_HORIZON_SEAM, 'goal-1', 'exp-1')).toBe(false)
  })

  it('refuses a goal the seam does not actually hold', () => {
    // A seam that could be argued into continuing a goal is a seam that has become an
    // authority, and this subsystem has enough of those already. The seam below answers
    // per experiment, so asking about one it has never heard of has to fail.
    const seam: LongHorizonSeam = {
      name: 'test',
      goalsFor: (experimentId) => (experimentId === 'exp-1' ? ['goal-1'] : []),
      wakeFor: () => null,
      continueGoal: () => true,
    }
    expect(mayHonourGoal(seam, 'goal-1', 'exp-2')).toBe(false)
    expect(mayHonourGoal(seam, 'goal-1', 'exp-1')).toBe(true)
  })

  it('refuses a goal Phase 31 does not itself want continued', () => {
    const seam: LongHorizonSeam = {
      name: 'test',
      goalsFor: () => ['goal-1'],
      wakeFor: () => null,
      continueGoal: () => false,
    }
    expect(mayHonourGoal(seam, 'goal-1', 'exp-1')).toBe(false)
  })

  it('has no method that writes to Phase 31', () => {
    // The dependency is one-way by construction: the type has three questions and no verbs.
    const methods = Object.keys(NO_LONG_HORIZON_SEAM).filter((key) => typeof NO_LONG_HORIZON_SEAM[key as 'name'] === 'function')
    expect(methods.sort()).toEqual(['continueGoal', 'goalsFor', 'wakeFor'])
  })
})

describe('the closed vocabularies', () => {
  it('keeps every completion criterion to a key', () => {
    expect(isCriterion('peer-reviewed-demand')).toBe(true)
    // A criterion that could hold prose would be a durable field a caller could fill with
    // a paragraph, and would stop being matchable against an evidence claim.
    expect(isCriterion('Would anyone pay for this?')).toBe(false)
    expect(isCriterion('Has Spaces')).toBe(false)
    expect(isCriterion('')).toBe(false)
  })

  it('refuses every authority-shaped and every real-money-shaped key in the journal', () => {
    for (const key of ['capability', 'grant', 'verdict', 'approved', 'priority', 'budget']) {
      expect(FORBIDDEN_ECONOMIC_PAYLOAD_KEYS.has(key)).toBe(true)
    }
    for (const key of ['venue', 'broker', 'exchange', 'account', 'wallet', 'capital', 'live']) {
      expect(FORBIDDEN_ECONOMIC_PAYLOAD_KEYS.has(key)).toBe(true)
    }
  })
})

describe('an experiment record', () => {
  it('carries a stage distinct from its lifecycle state', () => {
    // "Is this still live work" and "which bounded step is in hand" are two questions,
    // and an experiment can be `active` in `PAPER_TRADING` and `completed` in `COMPLETE`.
    const r = record({ state: 'active', stage: 'PAPER_TRADING' })
    expect(r.state).toBe('active')
    expect(r.stage).toBe('PAPER_TRADING')
  })
})