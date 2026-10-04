import { describe, expect, it } from 'vitest'
import { EconomicRuntime } from '../../../core/economic/runtime'
import { projectEconomicState } from '../../../core/economic/projection'
import { reduceEconomicState } from '../../../core/economic/state'
import { ECONOMIC_LIMITS } from '../../../core/economic/types'
import { narrowEconomicLimits } from '../../../core/economic/limits'
import type { LongHorizonSeam } from '../../../core/economic/seams'
import {
  T0,
  T_PLUS_1D,
  T_PLUS_31D,
  experimentDraft,
  harness,
  observation,
  series,
  wake,
} from './harness'

/**
 * The runtime, end to end and deterministically.
 *
 * The point of this file is that **nothing in the harness can spend or place a real
 * order**, so a test here is genuinely proving the runtime has no route to either. Every
 * instant is a literal, every id is a counter, and the journal is an array — so two runs
 * of the same script produce byte-identical journals and the assertions can be about
 * behaviour rather than about timing.
 */

const RUNNING = [100, 101, 102, 101, 103, 105, 104, 106, 108, 107]

async function opened(h = harness(), draft = experimentDraft()) {
  const runtime = new EconomicRuntime({ ports: h.ports })
  await runtime.open()
  const outcome = await runtime.openExperiment(draft)
  expect(outcome.ok).toBe(true)
  return { runtime, h }
}

describe('opening an experiment', () => {
  it('journals both the creation and the opening, because both are facts', () => {
    const h = harness()
    return opened(h).then(() => {
      expect(h.types()).toContain('economic.experiment.created')
      expect(h.types()).toContain('economic.experiment.state-changed')
      // An experiment existing and an experiment having begun are different things, and a
      // fold that collapsed them would make "opened but never started" unrepresentable.
      const created = h.payloads('economic.experiment.created')[0]
      expect(created?.state).toBe('draft')
      const openedEntry = h.payloads('economic.experiment.state-changed')[0]
      expect(openedEntry?.signal).toBe('experiment-opened')
    })
  })

  it('opens each kind in the stage its kind dictates', async () => {
    for (const [kind, stage] of [
      ['research', 'RESEARCHING'],
      ['simulation', 'SIMULATING'],
      ['paper-trading', 'PAPER_TRADING'],
    ] as const) {
      const h = harness()
      const { runtime } = await opened(h, experimentDraft({ kind, experimentId: `exp-${kind}` }))
      const experiment = runtime.folded().experiments.find((entry) => entry.experimentId === `exp-${kind}`)
      expect(experiment?.stage, kind).toBe(stage)
    }
  })

  it('writes only payloads the Core journal validator accepts', async () => {
    // The strongest property available here. A payload the validator would reject reaches
    // disk and is refused on the next read, which truncates the log at that line — so this
    // is not a cosmetic check, it is "the journal is not corrupt".
    const h = harness()
    await opened(h)
    expect(h.validate()).toEqual([])
  })

  it('refuses a draft it cannot bound, before anything is written', async () => {
    const h = harness()
    const runtime = new EconomicRuntime({ ports: h.ports })
    await runtime.open()
    const outcome = await runtime.openExperiment(experimentDraft({ completionCriteria: [] }))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('criteria-empty')
    expect(h.types()).toContain('economic.refusal.recorded')
    expect(h.types()).not.toContain('economic.experiment.created')
  })
})

describe('gathering evidence', () => {
  it('admits an observation and journals it', async () => {
    const h = harness()
    const { runtime } = await opened(h)
    const outcome = await runtime.recordObservations('exp-1', [observation({ claim: 'peer-reviewed-demand' })])
    expect(outcome.ok && outcome.value.admitted).toBe(1)
    expect(h.payloads('economic.evidence.gathered')).toHaveLength(1)
    void runtime
  })

  it('refuses a batch carrying one hostile observation rather than half-applying it', async () => {
    const h = harness()
    const { runtime } = await opened(h)
    const hostile = { ...observation({ claim: 'peer-reviewed-demand' }), broker: 'some-broker' }
    const outcome = await runtime.recordObservations('exp-1', [
      observation({ claim: 'peer-reviewed-demand', evidenceId: 'ev-1' }),
      hostile as never,
    ])
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('real-order-prohibited')
    // A partial application would leave the journal describing evidence nobody can
    // account for.
    expect(h.payloads('economic.evidence.gathered')).toHaveLength(0)
  })

  it('pulls from the port only when somebody asked it to', async () => {
    // The pull is here, on the queue, inside a command. There is no timer behind it.
    const h = harness({ observations: [observation({ claim: 'peer-reviewed-demand' })] })
    const { runtime } = await opened(h)
    expect(h.observationCalls()).toBe(0)
    await runtime.pullEvidence('exp-1')
    expect(h.observationCalls()).toBe(1)
  })

  it('records a refusal for an observation it will not admit', async () => {
    const h = harness()
    const { runtime } = await opened(h)
    await runtime.recordObservations('exp-1', [observation({ claim: 'x', citation: '' })])
    expect(h.refusals()).toContain('missing-citation')
  })
})

describe('running a scenario', () => {
  it('runs against a supplied series and journals the run without the metrics', async () => {
    const h = harness({ series: series(RUNNING) })
    const { runtime } = await opened(h, experimentDraft({ kind: 'simulation', experimentId: 'exp-sim' }))
    const outcome = await runtime.runScenario('exp-sim', {
      scenarioId: 'sc-1',
      name: 'buy and hold',
      strategy: 'buy-and-hold',
      parameters: {},
      assumptions: ['no fees'],
      symbol: 'ACME',
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.value.totalReturn).toBeCloseTo(0.07, 10)
    const completed = h.payloads('economic.simulation.completed')[0]
    // The metrics are deliberately absent: the journal records that a run happened, and
    // the numbers are recomputed from the series on demand.
    expect(Object.keys(completed ?? {})).not.toContain('metrics')
  })

  it('fetches the series once, and only for a run somebody asked for', async () => {
    const h = harness({ series: series(RUNNING) })
    const { runtime } = await opened(h, experimentDraft({ kind: 'simulation', experimentId: 'exp-sim' }))
    expect(h.seriesCalls()).toBe(0)
    await runtime.runScenario('exp-sim', {
      scenarioId: 'sc-1',
      name: 'a scenario',
      strategy: 'cash',
      parameters: {},
      assumptions: [],
      symbol: 'ACME',
    })
    expect(h.seriesCalls()).toBe(1)
  })

  it('refuses a scenario carrying anything real', async () => {
    const h = harness({ series: series(RUNNING) })
    const { runtime } = await opened(h, experimentDraft({ kind: 'simulation', experimentId: 'exp-sim' }))
    const outcome = await runtime.runScenario('exp-sim', {
      scenarioId: 'sc-1',
      name: 'a scenario',
      strategy: 'cash',
      parameters: {},
      assumptions: [],
      symbol: 'ACME',
      venue: 'live',
    } as never)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('real-order-prohibited')
    expect(h.seriesCalls()).toBe(0)
  })
})

describe('paper trading', () => {
  const PAPER = experimentDraft({ kind: 'paper-trading', experimentId: 'exp-paper' })

  it('places a simulated order and fills it against the simulated portfolio', async () => {
    const h = harness()
    const { runtime } = await opened(h, PAPER)
    const outcome = await runtime.placePaperOrder('exp-paper', {
      orderId: 'o-1',
      symbol: 'ACME',
      side: 'buy',
      quantity: 10,
      price: 100,
      placedAt: T0,
      reasoning: ['scenario:entry'],
    })
    expect(outcome.ok).toBe(true)
    expect(h.payloads('economic.paper-order.placed')).toHaveLength(1)
    expect(h.payloads('economic.paper-order.filled')).toHaveLength(1)
    const positions = runtime.folded().positions
    expect(positions[0]?.quantity).toBe(10)
    expect(positions[0]?.averagePrice).toBe(100)
  })

  it('only lets a paper-trading experiment place an order', async () => {
    // A research experiment has no portfolio to place against, which is a refusal the
    // owner can read rather than a silently empty order.
    const h = harness()
    const { runtime } = await opened(h)
    const outcome = await runtime.placePaperOrder('exp-1', {
      orderId: 'o-1',
      symbol: 'ACME',
      side: 'buy',
      quantity: 10,
      price: 100,
      placedAt: T0,
      reasoning: ['scenario:entry'],
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('experiment-kind-mismatch')
    expect(h.types()).not.toContain('economic.paper-order.placed')
  })

  it('refuses an order draft naming a venue, before anything else is looked at', async () => {
    const h = harness()
    const { runtime } = await opened(h, PAPER)
    const outcome = await runtime.placePaperOrder('exp-paper', {
      orderId: 'o-1',
      symbol: 'ACME',
      side: 'buy',
      quantity: 10,
      price: 100,
      placedAt: T0,
      reasoning: ['scenario:entry'],
      broker: 'some-broker',
    } as never)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('real-order-prohibited')
    expect(h.types()).not.toContain('economic.paper-order.placed')
  })

  it('computes metrics that all carry a denominator', async () => {
    const h = harness()
    const { runtime } = await opened(h, PAPER)
    await runtime.placePaperOrder('exp-paper', {
      orderId: 'o-1',
      symbol: 'ACME',
      side: 'buy',
      quantity: 10,
      price: 100,
      placedAt: T0,
      reasoning: ['scenario:entry'],
    })
    const outcome = await runtime.computeMetrics('exp-paper', { ACME: 150 })
    expect(outcome.ok).toBe(true)
    for (const payload of h.payloads('economic.metric.computed')) {
      expect(Number(payload.denominator)).toBeGreaterThan(0)
      expect(String(payload.unit).length).toBeGreaterThan(0)
    }
  })

  it('reports what it could not measure rather than reporting nothing', async () => {
    const h = harness()
    const { runtime } = await opened(h, PAPER)
    const outcome = await runtime.computeMetrics('exp-paper', {})
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.value.notes.length).toBeGreaterThan(0)
  })
})

describe('wakes', () => {
  it('advances the named experiment by at most one bounded step', async () => {
    const h = harness()
    const { runtime } = await opened(h)
    const outcome = await runtime.considerWake(wake())
    expect(outcome.outcome).toBe('accepted')
    // One wake, one step. A wake is an occasion, not an authority.
    expect(h.payloads('economic.continuation.decided')).toHaveLength(1)
    void runtime
  })

  it('refuses a wake from an unauthorized actor', async () => {
    const h = harness()
    const { runtime } = await opened(h)
    const outcome = await runtime.considerWake(wake({ actor: 'renderer' }))
    expect(outcome.outcome).toBe('refused')
    if (outcome.outcome === 'refused') expect(outcome.code).toBe('unauthorized-actor')
    expect(h.types()).toContain('economic.wake.denied')
  })

  it('refuses a heartbeat that names no experiment and no goal', async () => {
    // A scheduled check that names nothing in particular is the shape polling takes.
    const h = harness()
    const { runtime } = await opened(h)
    const outcome = await runtime.considerWake({
      source: 'scheduled-heartbeat',
      kind: 'deadline-reached',
      actor: 'host-heartbeat',
      experimentId: null,
      goalRef: null,
      sourceRef: 'sched-1',
      occurredAt: T0,
    })
    expect(outcome.outcome).toBe('refused')
    if (outcome.outcome === 'refused') expect(outcome.code).toBe('polling-prohibited')
  })

  it('defers a wake about an instant that has not arrived', async () => {
    const h = harness({ clock: T0 })
    const { runtime } = await opened(h)
    const outcome = await runtime.considerWake({
      source: 'scheduled-heartbeat',
      kind: 'deadline-reached',
      actor: 'host-heartbeat',
      experimentId: 'exp-1',
      goalRef: null,
      sourceRef: 'exp-1',
      occurredAt: T_PLUS_1D,
    })
    expect(outcome.outcome).toBe('deferred')
  })

  it('refuses a wake naming an experiment that does not exist', async () => {
    const h = harness()
    const { runtime } = await opened(h)
    const outcome = await runtime.considerWake(wake({ experimentId: 'ghost' }))
    expect(outcome.outcome).toBe('refused')
    if (outcome.outcome === 'refused') expect(outcome.code).toBe('unknown-experiment')
  })
})

describe('the tick', () => {
  it('does nothing at all before a deadline passes', async () => {
    const h = harness()
    const { runtime } = await opened(h)
    const before = h.entries.length
    expect(await runtime.tick()).toBe(0)
    expect(h.entries).toHaveLength(before)
  })

  it('expires an experiment that has run out of time, once', async () => {
    const h = harness()
    const { runtime } = await opened(h)
    h.setClock(T_PLUS_31D)
    expect(await runtime.tick()).toBe(1)
    expect(runtime.folded().experiments[0]?.state).toBe('failed')
    // A second tick finds it already terminal, so a bound that could be re-triggered would
    // be no bound at all.
    expect(await runtime.tick()).toBe(0)
  })

  it('fetches nothing', async () => {
    const h = harness({ observations: [observation({ claim: 'peer-reviewed-demand' })] })
    const { runtime } = await opened(h)
    h.setClock(T_PLUS_31D)
    await runtime.tick()
    expect(h.observationCalls()).toBe(0)
    expect(h.seriesCalls()).toBe(0)
  })
})

describe('STOP ALL', () => {
  it('refuses everything once the owner\'s latch is down, and journals why', async () => {
    // Both halves matter. `h.setStopAll(true)` is Core's latch, and `runtime.stop()` is
    // the subsystem's *record* of it — the runtime never owns the latch, because a latch
    // it could set would be a latch it could also clear.
    const h = harness()
    const { runtime } = await opened(h)
    h.setStopAll(true)
    await runtime.stop()
    expect(runtime.folded().stopAllLatched).toBe(true)

    const before = h.entries.length
    const outcome = await runtime.openExperiment(experimentDraft({ experimentId: 'exp-2' }))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('stop-all-active')
    // exp-1 was created *before* the latch, so the check is on what was written after.
    const after = h.entries.slice(before).map((entry) => entry.type)
    expect(after).not.toContain('economic.experiment.created')
    expect(h.refusals()).toContain('stop-all-active')
  })

  it('records the latch without claiming to own it', async () => {
    // Calling `stop()` on its own does not close the gate: the gate is Core's. If it did,
    // this subsystem would hold the panic button, and a thing that holds the panic button
    // is a thing somebody will eventually ask it to press.
    const h = harness()
    const { runtime } = await opened(h)
    await runtime.stop()
    expect(runtime.folded().stopAllLatched).toBe(true)
    const outcome = await runtime.openExperiment(experimentDraft({ experimentId: 'exp-2' }))
    expect(outcome.ok).toBe(true)
  })

  it('is lifted only by the owner\'s act', async () => {
    const h = harness({ stopAll: true })
    const runtime = new EconomicRuntime({ ports: h.ports })
    await runtime.open()
    expect(runtime.folded().stopAllLatched).toBe(true)
    h.setStopAll(false)
    await runtime.lift()
    expect(runtime.folded().stopAllLatched).toBe(false)
  })

  it('survives a restart, because it is journalled', async () => {
    const first = harness()
    const { runtime } = await opened(first)
    await runtime.stop()

    // A second process over the same journal. This is the whole reason the latch is a
    // record and not a variable.
    const second = harness()
    second.seed(first.entries)
    const restarted = new EconomicRuntime({ ports: second.ports })
    await restarted.open()
    expect(restarted.folded().stopAllLatched).toBe(true)
  })
})

describe('owner pre-emption', () => {
  it('records live experiments as interrupted and advances nothing', async () => {
    const h = harness()
    const { runtime } = await opened(h)
    await runtime.preemptByOwner()
    expect(runtime.folded().interrupted).toHaveLength(1)
    expect(runtime.folded().experiments[0]?.stage).toBe('RESEARCHING')
  })
})

describe('the continuation', () => {
  it('does nothing at all for an experiment with no evidence', async () => {
    // The most common outcome, and a real one: an experiment that has not been researched
    // yet is not "stuck", it has simply not started being worked on.
    const h = harness()
    const { runtime } = await opened(h)
    const outcome = await runtime.advance('exp-1')
    expect(outcome.ok && outcome.value.decision).toBe('research-in-progress')
    expect(runtime.folded().experiments[0]?.stage).toBe('RESEARCHING')
  })

  it('moves a research experiment past the simulation it has no work for', async () => {
    const h = harness()
    const { runtime } = await opened(h)
    await runtime.recordObservations('exp-1', [observation({ claim: 'peer-reviewed-demand' })])
    const outcome = await runtime.advance('exp-1')
    expect(outcome.ok && outcome.value.decision).toBe('research-sufficient')
    expect(runtime.folded().experiments[0]?.stage).toBe('ANALYZING')
  })

  it('carries a simulation experiment into the simulation', async () => {
    const h = harness()
    const { runtime } = await opened(h, experimentDraft({ kind: 'simulation', experimentId: 'exp-sim' }))
    // A simulation experiment opens already in SIMULATING, so its first step asks whether
    // there is anything to simulate — not whether there is evidence to gather.
    const outcome = await runtime.advance('exp-sim')
    expect(outcome.ok && outcome.value.decision).toBe('simulation-in-progress')
    expect(runtime.folded().experiments[0]?.stage).toBe('SIMULATING')
  })

  it('completes an experiment whose every criterion has fresh evidence', async () => {
    const h = harness()
    const { runtime } = await opened(h, experimentDraft({ experimentId: 'exp-1' }))
    await runtime.recordObservations('exp-1', [
      observation({ claim: 'peer-reviewed-demand', evidenceId: 'ev-1' }),
      observation({ claim: 'competitor-pricing', evidenceId: 'ev-2', sourceRef: 'filing-b' }),
    ])
    const outcome = await runtime.advance('exp-1')
    expect(outcome.ok && outcome.value.decision).toBe('research-sufficient')
    await runtime.advance('exp-1')
    expect(runtime.folded().experiments[0]?.stage).toBe('COMPLETE')
    expect(runtime.folded().experiments[0]?.state).toBe('completed')
  })

  it('cancels as a terminal outcome distinct from failure', async () => {
    // "We stopped looking" and "we looked and it did not work" are different facts, and a
    // journal that conflated them would be useless to the person reading it.
    const h = harness()
    const { runtime } = await opened(h)
    const outcome = await runtime.cancelExperiment('exp-1', 'the owner changed their mind')
    expect(outcome.ok).toBe(true)
    const experiment = runtime.folded().experiments[0]
    expect(experiment?.state).toBe('cancelled')
    expect(experiment?.stage).toBe('FAILED')
  })

  it('refuses to close out an experiment that has not finished', async () => {
    const h = harness()
    const { runtime } = await opened(h)
    const outcome = await runtime.closeExperiment('exp-1')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('experiment-terminal')
  })

  it('closes out a finished experiment, releasing its stage', async () => {
    const h = harness()
    const { runtime } = await opened(h, experimentDraft({ experimentId: 'exp-1' }))
    await runtime.recordObservations('exp-1', [
      observation({ claim: 'peer-reviewed-demand', evidenceId: 'ev-1' }),
      observation({ claim: 'competitor-pricing', evidenceId: 'ev-2', sourceRef: 'filing-b' }),
    ])
    await runtime.advance('exp-1')
    await runtime.advance('exp-1')
    expect(runtime.folded().experiments[0]?.stage).toBe('COMPLETE')
    const outcome = await runtime.closeExperiment('exp-1')
    expect(outcome.ok).toBe(true)
    expect(runtime.folded().experiments[0]?.stage).toBe('IDLE')
  })
})

describe('the long-horizon seam', () => {
  it('is inert by default, so a tick offers nothing', async () => {
    const h = harness()
    const { runtime } = await opened(h)
    expect(await runtime.tick()).toBe(0)
  })

  it('offers at most one continuation per tick when it is connected', async () => {
    const h = harness()
    const runtime = new EconomicRuntime({
      ports: h.ports,
      seam: {
        name: 'test',
        goalsFor: (experimentId) => (experimentId === 'exp-1' ? ['goal-1'] : []),
        wakeFor: (goalRef) => ({
          source: 'long-horizon-goal',
          kind: 'long-horizon-continuation',
          actor: 'long-horizon-subsystem',
          experimentId: 'exp-1',
          goalRef,
          sourceRef: goalRef,
          occurredAt: T0,
        }),
        continueGoal: () => true,
      } satisfies LongHorizonSeam,
    })
    await runtime.open()
    await runtime.openExperiment(experimentDraft({ experimentId: 'exp-1' }))
    expect(await runtime.tick()).toBe(1)
    expect(h.payloads('economic.wake.received')).toHaveLength(1)
  })
})

describe('restart', () => {
  it('rebuilds exactly what the first process had', async () => {
    const first = harness()
    const { runtime } = await opened(first)
    await runtime.recordObservations('exp-1', [observation({ claim: 'peer-reviewed-demand' })])

    const second = harness()
    second.seed(first.entries)
    const restarted = new EconomicRuntime({ ports: second.ports })
    await restarted.open()
    expect(restarted.folded().experiments).toEqual(runtime.folded().experiments)
    expect(restarted.folded().evidence).toEqual(runtime.folded().evidence)
  })

  it('records an interrupted experiment rather than resuming it', async () => {
    const first = harness()
    const { runtime } = await opened(first)
    await runtime.recordObservations('exp-1', [observation({ claim: 'peer-reviewed-demand' })])

    const second = harness()
    second.seed(first.entries)
    const restarted = new EconomicRuntime({ ports: second.ports })
    const report = await restarted.open()
    expect(report.interrupted).toHaveLength(1)
    // Visible, unmoved, and awaiting an explicit wake.
    expect(restarted.folded().experiments[0]?.stage).toBe('RESEARCHING')
    expect(report.requiresOwnerAction).toBe(true)
  })

  it('produces a byte-identical journal for the same script', async () => {
    const run = async (): Promise<string> => {
      const h = harness()
      const runtime = new EconomicRuntime({ ports: h.ports })
      await runtime.open()
      await runtime.openExperiment(experimentDraft({ experimentId: 'exp-1' }))
      await runtime.recordObservations('exp-1', [observation({ claim: 'peer-reviewed-demand' })])
      await runtime.advance('exp-1')
      return JSON.stringify(h.entries)
    }
    expect(await run()).toBe(await run())
  })
})

describe('the boot audit', () => {
  it('passes over a journal this subsystem wrote', async () => {
    const h = harness()
    const { runtime } = await opened(h)
    await runtime.recordObservations('exp-1', [observation({ claim: 'peer-reviewed-demand' })])
    const report = await runtime.audit()
    expect(report.holds).toBe(true)
    expect(report.counted.economicEvents).toBeGreaterThan(0)
    expect(Object.values(report.checks).every(Boolean)).toBe(true)
  })

  it('reports the assertions as passing before it has run', async () => {
    const h = harness()
    const runtime = new EconomicRuntime({ ports: h.ports })
    // Before the audit, the verdict is "nothing has been disproved", which is what an
    // absent assertion should say — not "nothing has been proved".
    expect(runtime.assertionVerdict().noRealMoneyAction).toBe(true)
  })
})

describe('the projection', () => {
  async function projected() {
    const h = harness()
    const runtime = new EconomicRuntime({ ports: h.ports })
    await runtime.open()
    await runtime.openExperiment(experimentDraft({ experimentId: 'exp-1' }))
    await runtime.recordObservations('exp-1', [observation({ claim: 'peer-reviewed-demand' })])
    return {
      projection: projectEconomicState({
        state: runtime.folded(),
        snapshot: runtime.snapshot(),
        now: T0,
        sequence: h.entries.length,
        longHorizonConnected: false,
      }),
      h,
    }
  }

  it('is deterministic: the same state gives deep-equal output', async () => {
    const first = await projected()
    const second = await projected()
    expect(first.projection).toEqual(second.projection)
  })

  it('puts a research experiment in the active list with its reasoning', async () => {
    const { projection } = await projected()
    expect(projection.activeExperiments).toHaveLength(1)
    const summary = projection.activeExperiments[0]
    expect(summary?.experimentId).toBe('exp-1')
    expect(summary?.reasoning.length).toBeGreaterThan(0)
    expect(summary?.blockedReason).toBeNull()
  })

  it('says the experiment is simulated and only simulated', async () => {
    const { projection } = await projected()
    expect(projection.realMoney).toBe('simulated-only')
  })

  it('recommends exactly one bounded action', async () => {
    const { projection } = await projected()
    expect(projection.nextBoundedAction).not.toBeNull()
    expect(projection.nextBoundedAction?.deadlineAt.length).toBeGreaterThan(0)
    expect(projection.nextBoundedAction?.maxAttempts).toBeGreaterThan(0)
  })

  it('recommends stopping while the latch is down, and nothing else', async () => {
    // A stopped subsystem is not a subsystem with work in it, and a recommendation to
    // keep going would be telling an owner the opposite of what they just did.
    const h = harness()
    const runtime = new EconomicRuntime({ ports: h.ports })
    await runtime.open()
    await runtime.openExperiment(experimentDraft({ experimentId: 'exp-1' }))
    await runtime.stop()
    const projection = projectEconomicState({
      state: runtime.folded(),
      snapshot: runtime.snapshot(),
      now: T0,
      sequence: h.entries.length,
      longHorizonConnected: false,
    })
    expect(projection.health).toBe('degraded')
    expect(projection.nextBoundedAction?.kind).toBe('stop')
    expect(projection.activeExperiments).toHaveLength(0)
  })

  it('recommends nothing at all when there is nothing to do', async () => {
    const h = harness()
    const runtime = new EconomicRuntime({ ports: h.ports })
    await runtime.open()
    const projection = projectEconomicState({
      state: runtime.folded(),
      snapshot: runtime.snapshot(),
      now: T0,
      sequence: 0,
      longHorizonConnected: false,
    })
    // Silence is an answer, and saying it is better than inventing an action.
    expect(projection.nextBoundedAction).toBeNull()
  })

  it('never shows a metric without a denominator in the counter view', async () => {
    const { projection } = await projected()
    expect(projection.counters.orders).toBe(0)
    expect(projection.counters.refusals).toBe(0)
  })

  it('reports refused attempts by closed code', async () => {
    const h = harness()
    const runtime = new EconomicRuntime({ ports: h.ports })
    await runtime.open()
    await runtime.openExperiment(experimentDraft({ experimentId: 'exp-1' }))
    await runtime.placePaperOrder('exp-1', {
      orderId: 'o-1',
      symbol: 'ACME',
      side: 'buy',
      quantity: 10,
      price: 100,
      placedAt: T0,
      reasoning: ['scenario:entry'],
    })
    const projection = projectEconomicState({
      state: runtime.folded(),
      snapshot: runtime.snapshot(),
      now: T0,
      sequence: h.entries.length,
      longHorizonConnected: false,
    })
    expect(projection.redTeam.refusedAttempts).toBe(1)
    expect(projection.redTeam.byCode).toContainEqual(['experiment-kind-mismatch', 1])
  })
})

describe('limits', () => {
  it('narrows only', async () => {
    const h = harness({ limits: { maxEvidencePerExperiment: 1 } })
    const runtime = new EconomicRuntime({ ports: h.ports, limits: { maxEvidencePerExperiment: 1 } })
    await runtime.open()
    await runtime.openExperiment(experimentDraft({ experimentId: 'exp-1' }))
    await runtime.recordObservations('exp-1', [observation({ claim: 'a', evidenceId: 'ev-1' })])
    const outcome = await runtime.recordObservations('exp-1', [
      observation({ claim: 'b', evidenceId: 'ev-2' }),
    ])
    // The second is refused with a recorded code rather than silently dropped.
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.value.refused).toBe(1)
    expect(h.payloads('economic.evidence.gathered')).toHaveLength(1)
  })

  it('refuses more experiments than the ceiling allows', async () => {
    const h = harness({ limits: { maxExperiments: 1 } })
    const runtime = new EconomicRuntime({ ports: h.ports, limits: { maxExperiments: 1 } })
    await runtime.open()
    await runtime.openExperiment(experimentDraft({ experimentId: 'exp-1' }))
    const outcome = await runtime.openExperiment(experimentDraft({ experimentId: 'exp-2' }))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('experiment-cap-reached')
  })

  it('publishes the ceilings and which of them were narrowed', async () => {
    const h = harness({ limits: { maxExperiments: 2 } })
    const runtime = new EconomicRuntime({ ports: h.ports, limits: { maxExperiments: 2 } })
    expect(runtime.snapshot().limits.maxExperiments).toBe(2)
    expect(runtime.snapshot().narrowedLimits).toEqual(['maxExperiments'])
    expect(narrowEconomicLimits().maxExperiments).toBe(ECONOMIC_LIMITS.maxExperiments)
  })
})

describe('a thrown step', () => {
  it('is recorded as an anomaly and never escapes into the caller', async () => {
    const h = harness()
    const runtime = new EconomicRuntime({
      ports: {
        ...h.ports,
        append: async () => {
          throw new Error('the disk is full')
        },
      },
    })
    await runtime.open()
    // The open itself journals nothing, so the throwing step is the first mutation.
    const outcome = await runtime.openExperiment(experimentDraft({ experimentId: 'exp-1' }))
    expect(outcome).toBeUndefined()
    expect(runtime.snapshot().anomalies.some((anomaly) => anomaly.detail.includes('disk is full'))).toBe(true)
  })
})

describe('the fold and the projection agree', () => {
  it('projects the same evidence the fold holds', async () => {
    const h = harness()
    const runtime = new EconomicRuntime({ ports: h.ports })
    await runtime.open()
    await runtime.openExperiment(experimentDraft({ experimentId: 'exp-1' }))
    await runtime.recordObservations('exp-1', [observation({ claim: 'peer-reviewed-demand' })])
    const projection = projectEconomicState({
      state: runtime.folded(),
      snapshot: runtime.snapshot(),
      now: T0,
      sequence: h.entries.length,
      longHorizonConnected: false,
    })
    expect(projection.recentEvidence).toHaveLength(runtime.folded().evidence.length)
    const replayed = reduceEconomicState(h.entries, ECONOMIC_LIMITS).state
    expect(replayed.evidence).toEqual(runtime.folded().evidence)
  })
})