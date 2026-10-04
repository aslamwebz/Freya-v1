import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  analyseEconomicAssertions,
  forbiddenKeysIn,
  passingEconomicAssertions,
  scanEconomicSource,
} from '../../../core/economic/assertions'
import { ECONOMIC_ASSERTIONS, ECONOMIC_PAYLOAD_KEYS, type EconomicEventType } from '../../../core/economic/types'
import type { EconomicJournalEntry } from '../../../core/economic/state'
import { harness, T0, experimentDraft, observation } from './harness'

/**
 * The Phase 32 assertions.
 *
 * A promise about money is worth only as much as the thing that tests it, so these tests
 * do two jobs. The first half feeds the analyser journals that *should* pass and checks
 * it says so. The second half forges the journals it exists to catch and checks that every
 * single one is caught — because an assertion that has never been seen to fire is
 * indistinguishable from an assertion that cannot.
 */

function entry(type: string, payload: Record<string, unknown>): EconomicJournalEntry {
  return { type, recordedAt: T0, payload }
}

const CLEAN = [
  entry('economic.experiment.created', {
    experimentId: 'exp-1',
    kind: 'research',
    state: 'draft',
    title: 'A bounded question',
    question: 'Would anyone pay for this?',
    criteria: 'peer-reviewed-demand',
    criteriaCount: 1,
    progress: 0,
    deadlineAt: '2026-03-31T09:00:00.000Z',
    createdAt: T0,
    updatedAt: T0,
  }),
  entry('economic.experiment.state-changed', {
    experimentId: 'exp-1',
    from: 'IDLE',
    to: 'RESEARCHING',
    signal: 'experiment-opened',
    progress: 0,
    reasoning: 'criteria-unmet',
    updatedAt: T0,
  }),
]

describe('a journal this subsystem wrote', () => {
  it('passes every assertion', () => {
    const report = analyseEconomicAssertions({ entries: CLEAN })
    expect(report.violations).toEqual([])
    expect(report.holds).toBe(true)
    for (const id of ECONOMIC_ASSERTIONS) expect(report.checks[id], id).toBe(true)
  })

  it('counts what it read', () => {
    const report = analyseEconomicAssertions({ entries: CLEAN })
    expect(report.counted.economicEvents).toBe(2)
    expect(report.counted.experimentsCreated).toBe(1)
    expect(report.counted.modelCallsAttributedToEconomic).toBe(0)
  })
})

describe('real money', () => {
  const REAL_VENUE_PAYLOADS = [
    'venue',
    'broker',
    'brokerage',
    'exchange',
    'account',
    'accountId',
    'wallet',
    'custodian',
    'currencyPair',
    'realOrder',
  ]

  it.each(REAL_VENUE_PAYLOADS)('reports %s as a real order', (key) => {
    const report = analyseEconomicAssertions({
      entries: [entry('economic.paper-order.placed', { ...(CLEAN[1]?.payload as object), [key]: 'somewhere' })],
    })
    expect(report.checks.noRealOrder).toBe(false)
    expect(report.violations.some((violation) => violation.code === 'real-venue-key-in-payload')).toBe(true)
  })

  const REAL_MONEY_PAYLOADS = ['capital', 'notional', 'withdrawal', 'deposit', 'live', 'realMoney']

  it.each(REAL_MONEY_PAYLOADS)('reports %s as real money', (key) => {
    const report = analyseEconomicAssertions({
      entries: [entry('economic.paper-order.placed', { ...(CLEAN[1]?.payload as object), [key]: 100 })],
    })
    expect(report.checks.noRealMoneyAction).toBe(false)
    expect(report.violations.some((violation) => violation.code === 'real-money-key-in-payload')).toBe(true)
  })

  it('reports every forbidden key the door also refuses', () => {
    // The scan at the boundary and the anomaly in the journal must agree, or one of them
    // is protecting a door the other one left open.
    for (const key of ['venue', 'broker', 'capital', 'live', 'capability', 'grant', 'approved']) {
      expect(forbiddenKeysIn({ [key]: 'x' }), key).toEqual([key])
    }
    expect(forbiddenKeysIn({ experimentId: 'exp-1' })).toEqual([])
  })
})

describe('authority escalation in the journal', () => {
  const AUTHORITY_PAYLOADS = ['capability', 'capabilities', 'grant', 'grantId', 'authority', 'verdict', 'principal', 'priority']

  it.each(AUTHORITY_PAYLOADS)('reports %s as an escalation attempt', (key) => {
    const report = analyseEconomicAssertions({
      entries: [entry('economic.gate.decided', { ...(CLEAN[1]?.payload as object), [key]: 'x' })],
    })
    expect(report.checks.noAuthorityEscalation).toBe(false)
  })

  it('reports a budget key separately from any other authority shape', () => {
    // "You have a bigger budget" and "you have a capability" are different attacks and
    // they deserve different words in a release gate's output.
    const report = analyseEconomicAssertions({
      entries: [entry('economic.gate.decided', { ...(CLEAN[1]?.payload as object), budget: 10_000 })],
    })
    expect(report.checks.noBudgetWidening).toBe(false)
    expect(report.violations.some((violation) => violation.code === 'budget-key-in-payload')).toBe(true)
  })

  it('reports an approval on any economic event', () => {
    const report = analyseEconomicAssertions({
      entries: [entry('economic.refusal.recorded', { ...(CLEAN[1]?.payload as object), approved: true })],
    })
    expect(report.checks.noSelfApproval).toBe(false)
  })

  it('reports a token or a model in any economic event', () => {
    // The economic subsystem makes no model call and holds no token count; a payload
    // carrying either is hidden reasoning reaching for the journal.
    const report = analyseEconomicAssertions({
      entries: [entry('economic.gate.decided', { ...(CLEAN[1]?.payload as object), maxOutputTokens: 4000 })],
    })
    expect(report.checks.noHiddenReasoning).toBe(false)
  })
})

describe('inference', () => {
  it('reports a model call that referenced an economic wake', () => {
    // Phase 32 declares it spends nothing. This is how that declaration is checked
    // against a whole journal rather than taken on trust.
    const report = analyseEconomicAssertions({
      entries: [
        ...CLEAN,
        entry('economic.wake.received', {
          wakeId: 'w-1',
          source: 'experiment-transition',
          kind: 'experiment-transitioned',
          wakeKey: 'experiment-transition|experiment-transitioned|exp-1',
          experimentId: 'exp-1',
          goalRef: '',
          sourceRef: 'exp-1',
          occurredAt: T0,
          observedAt: T0,
        }),
        entry('cognition.requested', { requestId: 'req-1', correlationId: 'w-1' }),
        entry('model.request.started', { requestId: 'req-1', grantId: 'g-1' }),
      ],
    })
    expect(report.checks.noModelCallWithoutWake).toBe(false)
    expect(report.counted.modelCallsAttributedToEconomic).toBeGreaterThan(0)
  })

  it('reports a model call made while STOP ALL was latched', () => {
    const report = analyseEconomicAssertions({
      entries: [
        entry('security.stop_all.activated', { by: 'owner', reason: 'because' }),
        entry('cognition.requested', { requestId: 'req-1' }),
      ],
      stopAllActive: true,
    })
    expect(report.checks.noIdleModelCall).toBe(false)
  })

  it('reports economic work written while STOP ALL was latched', () => {
    const report = analyseEconomicAssertions({
      entries: [
        entry('economic.stopped', { experimentId: '', stage: 'IDLE', code: 'stop-all-latched' }),
        entry('economic.evidence.gathered', { ...(CLEAN[1]?.payload as object) }),
      ],
    })
    expect(report.checks.noIdleModelCall).toBe(false)
    expect(report.violations.some((violation) => violation.code === 'work-while-stopped')).toBe(true)
  })

  it('does not report the latch\'s own entries as work despite it', () => {
    // Recording what the stop interrupted is bookkeeping about the stop, not work despite
    // it, and a check that flagged it would push somebody to stop recording interruptions.
    const report = analyseEconomicAssertions({
      entries: [
        entry('economic.stopped', { experimentId: '', stage: 'IDLE', code: 'stop-all-latched' }),
        entry('economic.reconciled', { code: 'restart-recovery', from: 'RESEARCHING', experimentId: 'exp-1', atStage: 'RESEARCHING' }),
        entry('economic.refusal.recorded', {
          refusalId: 'r-1',
          code: 'stop-all-active',
          subject: 'boundary',
          experimentId: '',
          wakeId: '',
          at: T0,
        }),
        entry('economic.unstopped', { code: 'stop-latch-cleared' }),
      ],
    })
    expect(report.violations.filter((violation) => violation.code === 'work-while-stopped')).toEqual([])
  })
})

describe('the payload vocabulary', () => {
  it('reports an unknown economic event type', () => {
    const report = analyseEconomicAssertions({ entries: [entry('economic.secret.exit', {})] })
    expect(report.checks.noHiddenDurableState).toBe(false)
  })

  it('reports a key outside the closed vocabulary', () => {
    const report = analyseEconomicAssertions({
      entries: [entry('economic.gate.decided', { ...(CLEAN[1]?.payload as object), mood: 'curious' })],
    })
    expect(report.checks.noHiddenDurableState).toBe(false)
    expect(report.violations.some((violation) => violation.code === 'unknown-payload-key')).toBe(true)
  })

  it('reports an oversized string', () => {
    const report = analyseEconomicAssertions({
      entries: [
        entry('economic.experiment.created', {
          ...(CLEAN[0]?.payload as object),
          title: 'a'.repeat(400),
        }),
      ],
    })
    expect(report.checks.noHiddenDurableState).toBe(false)
  })

  it('enumerates every event type in its payload table', () => {
    for (const type of Object.keys(ECONOMIC_PAYLOAD_KEYS) as EconomicEventType[]) {
      expect(Array.isArray(ECONOMIC_PAYLOAD_KEYS[type])).toBe(true)
      expect(ECONOMIC_PAYLOAD_KEYS[type].length).toBeGreaterThan(0)
    }
  })
})

describe('the structural scan', () => {
  it('reports a timer', () => {
    const findings = scanEconomicSource({ 'runtime.ts': 'export function tick() { setInterval(work, 30_000) }' })
    expect(findings.length).toBeGreaterThan(0)
    expect(findings.some((finding) => finding.assertion === 'noContinuousPolling')).toBe(true)
  })

  it('reports a loop with no condition at all', () => {
    const findings = scanEconomicSource({ 'loop.ts': 'for (;;) { work() }' })
    expect(findings.some((finding) => finding.assertion === 'noUnrestrictedLoops')).toBe(true)
  })

  it('does not report a comment explaining why there is no timer', () => {
    const findings = scanEconomicSource({
      'runtime.ts': '/** There is deliberately no setInterval here. */\nexport function tick() { return 0 }',
    })
    expect(findings).toEqual([])
  })

  it('finds nothing in this lane\'s own source', () => {
    // The check is only worth running if it is run over the thing it is about, and this
    // is that thing: Phase 32 claims to schedule nothing and to contain no unbounded loop.
    const directory = join(process.cwd(), 'core', 'economic')
    const sources: Record<string, string> = {}
    for (const file of readdirSync(directory)) {
      if (file.endsWith('.ts')) sources[file] = readFileSync(join(directory, file), 'utf8')
    }
    expect(Object.keys(sources).length).toBeGreaterThan(10)
    expect(scanEconomicSource(sources)).toEqual([])
  })

  it('folds structural findings into the report', () => {
    const report = analyseEconomicAssertions({
      entries: CLEAN,
      structural: scanEconomicSource({ 'somewhere.ts': 'while (true) { go() }' }),
    })
    expect(report.holds).toBe(false)
    expect(report.checks.noUnrestrictedLoops).toBe(false)
  })
})

describe('the passing verdict', () => {
  it('lists every assertion', () => {
    const verdict = passingEconomicAssertions()
    for (const id of ECONOMIC_ASSERTIONS) expect(verdict[id], id).toBe(true)
  })
})

describe('a real runtime journal', () => {
  it('passes the assertions the runtime itself produced', async () => {
    const h = harness()
    const { EconomicRuntime } = await import('../../../core/economic/runtime')
    const runtime = new EconomicRuntime({ ports: h.ports })
    await runtime.open()
    await runtime.openExperiment(experimentDraft({ experimentId: 'exp-1' }))
    await runtime.recordObservations('exp-1', [observation({ claim: 'peer-reviewed-demand' })])
    await runtime.advance('exp-1')
    const report = await runtime.audit()
    expect(report.holds).toBe(true)
    expect(report.violations).toEqual([])
  })
})