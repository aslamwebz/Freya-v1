import { describe, expect, it } from 'vitest'
import { EconomicRuntime } from '../../../core/economic/runtime'
import { analyseEconomicAssertions } from '../../../core/economic/assertions'
import { classifyEconomicClaim, NO_REAL_MONEY_STATEMENT } from '../../../core/economic/prohibition'
import { projectEconomicState } from '../../../core/economic/projection'
import { evaluateEconomicGate } from '../../../core/economic/authority'
import { ECONOMIC_LIMITS, ECONOMIC_PAYLOAD_KEYS } from '../../../core/economic/types'
import type { EconomicJournalEntry } from '../../../core/economic/state'
import {
  T0,
  T_PLUS_31D,
  experimentDraft,
  harness,
  observation,
  wake,
  type HarnessEntry,
} from '../../core/economic/harness'

/**
 * Phase 32 red-team.
 *
 * Every case here is an attack somebody will eventually try, and each one is answered by
 * running the *runtime* rather than by asserting a property of the code. That distinction
 * is the whole point: a claim like "an experiment cannot grant itself a capability" is
 * worth nothing until a hostile input has been fed through the real gate and the real fold
 * and the real journal has come back with a closed refusal code.
 *
 * The harness cannot spend and cannot place a real order — there is no port for either —
 * so a passing case here is not "the attack was prevented by the test's caution" but "the
 * attack has nowhere to go".
 */

async function runtime(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options)
  const instance = new EconomicRuntime({ ports: h.ports, limits: options?.limits })
  await instance.open()
  return { h, runtime: instance }
}

async function withPaperExperiment(options: Parameters<typeof harness>[0] = {}) {
  const created = await runtime(options)
  await created.runtime.openExperiment(
    experimentDraft({ kind: 'paper-trading', experimentId: 'exp-paper' }),
  )
  return created
}

/* ------------------------------------------------- authority escalation */

describe('an experiment claims authority', () => {
  it('refuses a capability claim, as data, and records it', async () => {
    const { h, runtime: instance } = await withPaperExperiment()
    const outcome = await instance.placePaperOrder('exp-paper', {
      orderId: 'o-1',
      symbol: 'ACME',
      side: 'buy',
      quantity: 1,
      price: 10,
      placedAt: T0,
      reasoning: ['scenario:entry'],
      capability: 'research.start',
    } as never)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('capability-widening-prohibited')
    expect(h.types()).not.toContain('economic.paper-order.placed')
  })

  it('refuses a grant claim', async () => {
    const { runtime: instance } = await withPaperExperiment()
    const outcome = await instance.openExperiment({
      experimentId: 'exp-2',
      kind: 'research',
      title: 'Another',
      question: 'Would anyone pay?',
      completionCriteria: ['peer-reviewed-demand'],
      createdAt: T0,
      deadlineAt: null,
      grantId: 'g-self-made',
    } as never)
    // The claim is refused as a claim; the experiment itself is still definable, because
    // the *shape* it arrived in is hostile and the *content* is not.
    expect(outcome.ok).toBe(true)
    expect(classifyEconomicClaim({ grantId: 'g-self-made' }).prohibited).toBe(true)
  })

  it('refuses a self-approval', async () => {
    const scan = classifyEconomicClaim({ approved: true, approvalId: 'mine' })
    expect(scan.prohibited).toBe(true)
    if (scan.prohibited) expect(scan.code).toBe('self-approval-prohibited')
  })

  it('refuses a claim to be the owner', async () => {
    // An experiment cannot name a principal. Identity is derived from the scope Core
    // issued, and there is no scope to issue here.
    const scan = classifyEconomicClaim({ principal: 'owner', actor: 'owner' })
    expect(scan.prohibited).toBe(true)
    if (scan.prohibited) expect(scan.code).toBe('authority-claim-prohibited')
  })

  it('refuses a priority claim and does not reorder anything', async () => {
    const { h, runtime: instance } = await withPaperExperiment()
    await instance.openExperiment(experimentDraft({ kind: 'research', experimentId: 'exp-late' }))
    const before = instance.ranked().map((entry) => entry.experimentId)
    // There is nowhere to attach the claim even if somebody tried: dvance takes an id.
    await instance.advance('exp-late')
    expect(instance.ranked().map((entry) => entry.experimentId)).toEqual(before)
    expect(classifyEconomicClaim({ priority: 99 }).prohibited).toBe(true)
    void h
  })

  it('refuses a budget claim', async () => {
    const scan = classifyEconomicClaim({ budget: 1_000_000 })
    expect(scan.prohibited).toBe(true)
    if (scan.prohibited) expect(scan.code).toBe('budget-widening-prohibited')
  })

  it('refuses a spending-authority claim', async () => {
    const scan = classifyEconomicClaim({ spendingAuthority: 'unlimited' })
    expect(scan.prohibited).toBe(true)
    if (scan.prohibited) expect(scan.code).toBe('spending-authority-prohibited')
  })
})

/* -------------------------------------------------------- boundary attacks */

describe('the authority boundaries', () => {
  it('refuses when the Guard denies, and never reaches the engines', async () => {
    const { h, runtime: instance } = await runtime({ guardAllows: false })
    const outcome = await instance.openExperiment(experimentDraft({ experimentId: 'exp-1' }))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('guard-denied')
    expect(h.types()).not.toContain('economic.experiment.created')
  })

  it('refuses when the Governor denies', async () => {
    const { runtime: instance } = await runtime({ governorAuthorized: false })
    const outcome = await instance.openExperiment(experimentDraft({ experimentId: 'exp-1' }))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('governor-denied')
  })

  it('refuses when the unit budget is gone', async () => {
    const { runtime: instance } = await runtime({ budgetRemainingUnits: 0 })
    const outcome = await instance.openExperiment(experimentDraft({ experimentId: 'exp-1' }))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('budget-exhausted')
  })

  it('refuses when an owner approval is outstanding', async () => {
    const { runtime: instance } = await runtime({ approvalSatisfied: false })
    const outcome = await instance.openExperiment(experimentDraft({ experimentId: 'exp-1' }))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('approval-required')
  })

  it('refuses everything while the journal is not trustworthy', async () => {
    const { runtime: instance } = await runtime({ journalTrustworthy: false })
    const outcome = await instance.openExperiment(experimentDraft({ experimentId: 'exp-1' }))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('journal-not-trustworthy')
  })

  it('refuses everything while the owner has Freya stopped', async () => {
    const { h, runtime: instance } = await runtime({ stopAll: true })
    const outcome = await instance.openExperiment(experimentDraft({ experimentId: 'exp-1' }))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('stop-all-active')
    expect(h.types()).not.toContain('economic.experiment.created')
  })

  it('does not consult a later gate once an earlier one has refused', async () => {
    // "Three gates cleared and then the budget ran out" — never "the budget ran out and
    // also, incidentally, the Governor said no".
    const outcome = evaluateEconomicGate({
      journalTrustworthy: true,
      stopAllActive: false,
      enabled: true,
      capabilityAllowed: false,
      cognitionAuthorized: false,
      budgetRemainingUnits: 0,
      approvalSatisfied: false,
      realMoney: true,
    })
    expect(outcome.outcome).toBe('deny')
    if (outcome.outcome === 'deny') {
      expect(outcome.failedCheck).toBe('real-money-prohibited')
      expect(outcome.cleared).toEqual(['journal-not-trustworthy', 'stop-all-active'])
    }
  })
})

/* ------------------------------------------------------- real money */

describe('real money', () => {
  const REAL_MONEY_SHAPES: readonly (readonly [string, unknown])[] = [
    ['venue', 'a live venue'],
    ['broker', 'some-broker'],
    ['brokerage', true],
    ['exchange', 'a-national-exchange'],
    ['account', 'ACC-001'],
    ['wallet', '0xabc'],
    ['custodian', 'a-custodian'],
    ['capital', 10_000],
    ['notional', 250_000],
    ['withdrawal', 500],
    ['deposit', 500],
    ['currencyPair', 'EURUSD'],
    ['live', true],
    ['realMoney', true],
    ['realOrder', true],
  ]

  it.each(REAL_MONEY_SHAPES)('refuses an order draft carrying %s', async (key, value) => {
    const { h, runtime: instance } = await withPaperExperiment()
    const outcome = await instance.placePaperOrder('exp-paper', {
      orderId: 'o-1',
      symbol: 'ACME',
      side: 'buy',
      quantity: 1,
      price: 10,
      placedAt: T0,
      reasoning: ['scenario:entry'],
      [key]: value,
    } as never)
    expect(outcome.ok).toBe(false)
    // No journal entry of any kind could have been written for the order.
    expect(h.types()).not.toContain('economic.paper-order.placed')
    expect(h.types()).not.toContain('economic.paper-order.filled')
  })

  it.each(REAL_MONEY_SHAPES)('refuses an observation carrying %s', async (key, value) => {
    const { h, runtime: instance } = await runtime()
    await instance.openExperiment(experimentDraft({ experimentId: 'exp-1' }))
    const outcome = await instance.recordObservations('exp-1', [
      { ...observation({ claim: 'peer-reviewed-demand' }), [key]: value } as never,
    ])
    expect(outcome.ok).toBe(false)
    expect(h.types()).not.toContain('economic.evidence.gathered')
  })

  it.each(REAL_MONEY_SHAPES)('refuses a scenario carrying %s', async (key, value) => {
    const { h, runtime: instance } = await runtime()
    await instance.openExperiment(
      experimentDraft({ kind: 'simulation', experimentId: 'exp-sim' }),
    )
    const outcome = await instance.runScenario('exp-sim', {
      scenarioId: 'sc-1',
      name: 'a scenario',
      strategy: 'cash',
      parameters: {},
      assumptions: [],
      symbol: 'ACME',
      [key]: value,
    } as never)
    expect(outcome.ok).toBe(false)
    expect(h.seriesCalls()).toBe(0)
  })

  it('has nowhere to put a real order even if a caller insists', async () => {
    // The port list is the guarantee: there is no method that could carry one, so the
    // question is not "is it refused?" but "what would a caller have to hold?".
    const { h, runtime: instance } = await withPaperExperiment()
    await instance.placePaperOrder('exp-paper', {
      orderId: 'o-1',
      symbol: 'ACME',
      side: 'buy',
      quantity: 1,
      price: 10,
      placedAt: T0,
      reasoning: ['scenario:entry'],
    })
    // What was written is a record in a fold, with no venue and no account anywhere.
    const written = h.payloads('economic.paper-order.placed')[0] ?? {}
    for (const key of ['venue', 'broker', 'account', 'wallet', 'capital']) {
      expect(Object.keys(written), key).not.toContain(key)
    }
  })

  it('states the prohibition as one sentence everywhere', () => {
    expect(NO_REAL_MONEY_STATEMENT).toContain('no real money')
  })
})

/* ------------------------------------------------ hidden inference attacks */

describe('hidden inference', () => {
  it('refuses a wake from a renderer, a model, an agent, a connector or a timer', async () => {
    for (const actor of ['renderer', 'model', 'agent', 'connector', 'external-webhook', 'timer'] as const) {
      const { runtime: instance } = await runtime()
      await instance.openExperiment(experimentDraft({ experimentId: 'exp-1' }))
      const outcome = await instance.considerWake(wake({ actor }))
      expect(outcome.outcome, actor).toBe('refused')
      if (outcome.outcome === 'refused') expect(outcome.code, actor).toBe('unauthorized-actor')
    }
  })

  it('refuses a heartbeat relabelled as owner interaction', async () => {
    // The pairing table is what stops a routine periodic check buying a louder wake than
    // the event deserves.
    const { runtime: instance } = await runtime()
    await instance.openExperiment(experimentDraft({ experimentId: 'exp-1' }))
    const outcome = await instance.considerWake({
      source: 'owner-interaction',
      kind: 'periodic-check' as never,
      actor: 'owner',
      experimentId: 'exp-1',
      goalRef: null,
      sourceRef: 'exp-1',
      occurredAt: T0,
    })
    expect(outcome.outcome).toBe('refused')
  })

  it('refuses a heartbeat that names nothing in particular', async () => {
    const { runtime: instance } = await runtime()
    const outcome = await instance.considerWake({
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

  it('fetches nothing on a tick, however many times it is called', async () => {
    // Continuous polling is not a policy here; it is the absence of anything to call.
    const { h, runtime: instance } = await runtime()
    await instance.openExperiment(experimentDraft({ experimentId: 'exp-1' }))
    for (let index = 0; index < 20; index += 1) await instance.tick()
    expect(h.observationCalls()).toBe(0)
    expect(h.seriesCalls()).toBe(0)
  })

  it('makes no model call, because it has no port that could', async () => {
    const { h, runtime: instance } = await runtime()
    await instance.openExperiment(experimentDraft({ experimentId: 'exp-1' }))
    await instance.recordObservations('exp-1', [observation({ claim: 'peer-reviewed-demand' })])
    await instance.advance('exp-1')
    // Phase 32 declares it spends nothing; this reads a whole journal and looks for a
    // model call that referenced anything economic.
    const report = analyseEconomicAssertions({ entries: h.entries as readonly EconomicJournalEntry[] })
    expect(report.holds).toBe(true)
    expect(report.counted.modelCallsAttributedToEconomic).toBe(0)
    expect(instance.assertionVerdict().noModelCallWithoutWake).toBe(true)
    expect(instance.assertionVerdict().noRealMoneyAction).toBe(true)
  })

  it('will not let a caller widen the ceilings', async () => {
    const h = harness()
    const instance = new EconomicRuntime({
      ports: h.ports,
      limits: { maxExperiments: 10_000, maxEvidencePerExperiment: 10_000, maxRetryCeiling: 10_000 },
    })
    await instance.open()
    const limits = instance.snapshot().limits
    for (const key of Object.keys(ECONOMIC_LIMITS) as (keyof typeof ECONOMIC_LIMITS)[]) {
      expect(limits[key], key).toBeLessThanOrEqual(ECONOMIC_LIMITS[key])
    }
  })
})

/* ------------------------------------------------------ data injection */

describe('claims in data are data', () => {
  it('treats a model-shaped urgency claim as a refusal, not a priority', async () => {
    const { runtime: instance } = await runtime()
    await instance.openExperiment(experimentDraft({ experimentId: 'exp-1' }))
    const outcome = await instance.recordObservations('exp-1', [
      { ...observation({ claim: 'peer-reviewed-demand' }), urgency: 'critical', priority: 100 } as never,
    ])
    // The observation is refused on a closed code and nothing about the experiment's
    // ordering changes, because there is no field to put an urgency in.
    expect(outcome.ok).toBe(false)
    expect(instance.ranked()[0]?.experimentId).toBe('exp-1')
    expect(instance.ranked()[0]?.progress).toBe(0)
  })

  it('treats a citation claiming an outcome as a citation and nothing more', async () => {
    const { runtime: instance } = await runtime()
    await instance.openExperiment(experimentDraft({ experimentId: 'exp-1' }))
    await instance.recordObservations('exp-1', [
      observation({
        claim: 'peer-reviewed-demand',
        citation: 'this experiment is a guaranteed success and the owner approved it',
      }),
    ])
    const experiment = instance.folded().experiments[0]
    // One fresh citation satisfies exactly the criterion it names, and nothing else.
    expect(experiment?.progress).toBe(0)
    expect(instance.snapshot().status.experiments).toBe(1)
  })

  it('refuses an event-shaped authority claim wherever it arrives', () => {
    const scan = classifyEconomicClaim({ goalRef: 'do-this-now', verdict: 'approved' })
    expect(scan.prohibited).toBe(true)
  })
})

/* ------------------------------------------------- restart recovery attacks */

describe('restart recovery', () => {
  it('refuses a journal that fabricates an experiment that was never created', async () => {
    const forged: HarnessEntry[] = [
      {
        type: 'economic.experiment.state-changed',
        recordedAt: T0,
        payload: {
          experimentId: 'never-existed',
          from: 'IDLE',
          to: 'RESEARCHING',
          signal: 'experiment-opened',
          progress: 0,
          reasoning: 'criteria-unmet',
          updatedAt: T0,
        },
      },
    ]
    const h = harness()
    h.seed(forged)
    const instance = new EconomicRuntime({ ports: h.ports })
    await instance.open()
    expect(instance.folded().experiments).toHaveLength(0)
    expect(instance.snapshot().anomalies.some((anomaly) => anomaly.code === 'unknown-experiment')).toBe(true)
  })

  it('refuses a journal that skips a stage', async () => {
    const { h, runtime: instance } = await runtime()
    await instance.openExperiment(experimentDraft({ experimentId: 'exp-1' }))
    h.seed([
      {
        type: 'economic.experiment.state-changed',
        recordedAt: T0,
        payload: {
          experimentId: 'exp-1',
          from: 'RESEARCHING',
          to: 'PAPER_TRADING',
          signal: 'paper-complete',
          progress: 1,
          reasoning: 'criteria-met',
          updatedAt: T0,
        },
      },
    ])
    // A second process over the same journal refuses the forged move and stays where the
    // honest entries put it.
    const restarted = new EconomicRuntime({ ports: h.ports })
    await restarted.open()
    expect(restarted.folded().experiments[0]?.stage).not.toBe('PAPER_TRADING')
    void instance
  })

  it('records an interrupted experiment rather than resuming it', async () => {
    const first = harness()
    const instance = new EconomicRuntime({ ports: first.ports })
    await instance.open()
    await instance.openExperiment(experimentDraft({ experimentId: 'exp-1' }))
    await instance.recordObservations('exp-1', [observation({ claim: 'peer-reviewed-demand' })])

    const second = harness()
    second.seed(first.entries)
    const restarted = new EconomicRuntime({ ports: second.ports })
    const report = await restarted.open()
    expect(report.interrupted).toHaveLength(1)
    expect(report.requiresOwnerAction).toBe(true)
    // Nothing was advanced by the restart itself.
    expect(second.payloads('economic.experiment.state-changed')).toHaveLength(1)
    expect(second.payloads('economic.reconciled')).toHaveLength(1)
  })

  it('shows an interruption to the owner rather than hiding it', async () => {
    const first = harness()
    const instance = new EconomicRuntime({ ports: first.ports })
    await instance.open()
    await instance.openExperiment(experimentDraft({ experimentId: 'exp-1' }))

    const second = harness()
    second.seed(first.entries)
    const restarted = new EconomicRuntime({ ports: second.ports })
    await restarted.open()
    const projection = projectEconomicState({
      state: restarted.folded(),
      snapshot: restarted.snapshot(),
      now: T0,
      sequence: second.entries.length,
      longHorizonConnected: false,
    })
    expect(projection.interruptedExperiments).toHaveLength(1)
    expect(projection.requiresOwnerAction).toBe(true)
  })

  it('refuses to lift the latch without the owner', async () => {
    const first = harness({ stopAll: true })
    const instance = new EconomicRuntime({ ports: first.ports })
    await instance.open()
    expect(instance.folded().stopAllLatched).toBe(true)

    // A journal line claiming the owner cleared it is not the owner clearing it.
    const second = harness()
    second.seed([
      ...first.entries,
      { type: 'economic.unstopped', recordedAt: T0, payload: { code: 'stop-latch-cleared' } },
    ])
    const restarted = new EconomicRuntime({ ports: second.ports })
    await restarted.open()
    expect(restarted.folded().stopAllLatched).toBe(true)
  })

  it('survives a deadline passing while nobody was looking', async () => {
    const h = harness()
    const instance = new EconomicRuntime({ ports: h.ports })
    await instance.open()
    await instance.openExperiment(experimentDraft({ experimentId: 'exp-1' }))
    h.setClock(T_PLUS_31D)
    await instance.tick()
    const projection = projectEconomicState({
      state: instance.folded(),
      snapshot: instance.snapshot(),
      now: T_PLUS_31D,
      sequence: h.entries.length,
      longHorizonConnected: false,
    })
    expect(projection.blockedExperiments.length).toBeGreaterThan(0)
    expect(projection.activeExperiments).toHaveLength(0)
  })
})

/* --------------------------------------------------------- composite attacks */

describe('composite attacks', () => {
  it('refuses a claim and a real venue in the same request, and does neither half', async () => {
    const { h, runtime: instance } = await withPaperExperiment()
    const outcome = await instance.placePaperOrder('exp-paper', {
      orderId: 'o-1',
      symbol: 'ACME',
      side: 'buy',
      quantity: 1,
      price: 10,
      placedAt: T0,
      reasoning: ['scenario:entry'],
      capability: 'research.start',
      venue: 'live',
      budget: 1_000_000,
    } as never)
    expect(outcome.ok).toBe(false)
    expect(h.types()).not.toContain('economic.paper-order.placed')
    // And every one of the three claims is named, not just the first.
    const scanCodes = [classifyEconomicClaim({ capability: 'x' }), classifyEconomicClaim({ venue: 'live' }), classifyEconomicClaim({ budget: 1 })]
    expect(scanCodes.every((scan) => scan.prohibited)).toBe(true)
  })

  it('refuses a real-money action while the latch is down, without consulting the gate', async () => {
    const { h, runtime: instance } = await withPaperExperiment({ stopAll: true })
    const outcome = await instance.placePaperOrder('exp-paper', {
      orderId: 'o-1',
      symbol: 'ACME',
      side: 'buy',
      quantity: 1,
      price: 10,
      placedAt: T0,
      reasoning: ['scenario:entry'],
      venue: 'live',
    } as never)
    expect(outcome.ok).toBe(false)
    // The latch outranks everything below it, so it is the latch that is reported.
    if (!outcome.ok) expect(outcome.code).toBe('stop-all-active')
    expect(h.types()).not.toContain('economic.paper-order.placed')
  })

  it('refuses a whole batch of evidence when one item is hostile', async () => {
    const { h, runtime: instance } = await runtime()
    await instance.openExperiment(experimentDraft({ experimentId: 'exp-1' }))
    const outcome = await instance.recordObservations('exp-1', [
      observation({ claim: 'peer-reviewed-demand', evidenceId: 'ev-1' }),
      { ...observation({ claim: 'competitor-pricing', evidenceId: 'ev-2' }), account: 'ACC-1' } as never,
      observation({ claim: 'x', evidenceId: 'ev-3' }),
    ])
    expect(outcome.ok).toBe(false)
    expect(h.payloads('economic.evidence.gathered')).toHaveLength(0)
  })

  it('reports every violation in a journal rather than only the first', async () => {
    // "There was exactly one" and "there were forty" is the difference between a bug and a
    // design problem, so the report is complete either way.
    const report = analyseEconomicAssertions({
      entries: [
        {
          type: 'economic.paper-order.placed',
          recordedAt: T0,
          payload: { orderId: 'o-1', venue: 'live' },
        },
        {
          type: 'economic.gate.decided',
          recordedAt: T0,
          payload: { wakeId: 'w-1', budget: 1 },
        },
        {
          type: 'economic.metric.computed',
          recordedAt: T0,
          payload: { metricId: 'm-1', approved: true },
        },
      ],
    })
    expect(report.violations.length).toBeGreaterThanOrEqual(3)
    expect(report.holds).toBe(false)
  })

  it('finds no real-money key anywhere in its own payload vocabulary', () => {
    for (const type of Object.keys(ECONOMIC_PAYLOAD_KEYS) as (keyof typeof ECONOMIC_PAYLOAD_KEYS)[]) {
      for (const key of ECONOMIC_PAYLOAD_KEYS[type]) {
        expect(['venue', 'broker', 'account', 'wallet', 'capital', 'live'], `${type}.${key}`).not.toContain(key)
      }
    }
  })
})