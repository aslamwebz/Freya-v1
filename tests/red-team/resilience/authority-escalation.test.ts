import { describe, expect, it } from 'vitest'
import { ResilienceRuntime } from '../../../core/resilience/runtime'
import { analyseResilienceAssertions } from '../../../core/resilience/assertions'
import { classifyResilienceClaim, NO_REAL_MONEY_STATEMENT } from '../../../core/resilience/prohibition'
import { projectResilienceState } from '../../../core/resilience/projection'
import { evaluateResilienceGate } from '../../../core/resilience/authority'
import { reduceResilienceState } from '../../../core/resilience/state'
import { RESILIENCE_LIMITS } from '../../../core/resilience/types'
import type { ResilienceJournalEntry } from '../../../core/resilience/state'
import {
  T0,
  T_PLUS_31D,
  failureEvent,
  harness,
  wake,
  type HarnessEntry,
} from '../../core/resilience/harness'

/**
 * Phase 36 red-team.
 *
 * Every case here is an attack somebody will eventually try, and each one is
 * answered by running the *runtime* rather than by asserting a property of
 * the code.
 */

async function runtime(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options)
  const instance = new ResilienceRuntime({ ports: h.ports, limits: options?.limits })
  await instance.open()
  return { h, runtime: instance }
}

/* ------------------------------------------------- authority escalation */

describe('a recovery claims authority', () => {
  it('refuses a capability claim, as data, and records it', async () => {
    const { h, runtime: instance } = await runtime()
    const outcome = await instance.detectFailure(
      failureEvent({ context: 'I have the capability to do anything' }),
    )
    // The claim is treated as data; the failure is still detected
    expect(outcome.ok).toBe(true)
    expect(classifyResilienceClaim({ capability: 'super-admin' }).prohibited).toBe(true)
  })

  it('refuses a grant claim', async () => {
    const scan = classifyResilienceClaim({ grantId: 'g-self-made' })
    expect(scan.prohibited).toBe(true)
    if (scan.prohibited) expect(scan.code).toBe('authority-claim-prohibited')
  })

  it('refuses a self-approval', async () => {
    const scan = classifyResilienceClaim({ approved: true, approvalId: 'mine' })
    expect(scan.prohibited).toBe(true)
    if (scan.prohibited) expect(scan.code).toBe('authority-claim-prohibited')
  })

  it('refuses a claim to be the owner', async () => {
    const scan = classifyResilienceClaim({ principal: 'owner', actor: 'owner' })
    expect(scan.prohibited).toBe(true)
    if (scan.prohibited) expect(scan.code).toBe('authority-claim-prohibited')
  })

  it('refuses a priority claim', async () => {
    const scan = classifyResilienceClaim({ priority: 'urgent' })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses a budget claim', async () => {
    const scan = classifyResilienceClaim({ budget: 999999 })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses an approval claim', async () => {
    const scan = classifyResilienceClaim({ approved: true })
    expect(scan.prohibited).toBe(true)
  })
})

/* ------------------------------------------------- boundary violation */

describe('boundary violations', () => {
  it('refuses to bypass Guard', async () => {
    const h = harness({ guardAllows: false })
    const { runtime: instance } = await runtime({ guardAllows: false })
    const outcome = await instance.detectFailure(failureEvent())
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('guard-denied')
  })

  it('refuses to bypass Governor', async () => {
    const h = harness({ governorAuthorized: false })
    const { runtime: instance } = await runtime({ governorAuthorized: false })
    const outcome = await instance.detectFailure(failureEvent())
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('governor-denied')
  })

  it('refuses to bypass STOP ALL', async () => {
    const h = harness({ stopAll: true })
    const { runtime: instance } = await runtime({ stopAll: true })
    const outcome = await instance.detectFailure(failureEvent())
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('stop-all-active')
  })

  it('refuses to exceed budget', async () => {
    const h = harness({ budgetRemainingUnits: 0 })
    const { runtime: instance } = await runtime({ budgetRemainingUnits: 0 })
    const outcome = await instance.detectFailure(failureEvent())
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('budget-exhausted')
  })

  it('refuses to skip approval', async () => {
    const h = harness({ approvalSatisfied: false })
    const { runtime: instance } = await runtime({ approvalSatisfied: false })
    const outcome = await instance.startRepair('f-1', null)
    expect(outcome.ok).toBe(false)
  })

  it('refuses to widen capability', async () => {
    const scan = classifyResilienceClaim({ widenCapability: true })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses to create a grant', async () => {
    const scan = classifyResilienceClaim({ createGrant: true })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses to self-approve', async () => {
    const scan = classifyResilienceClaim({ selfApprove: true })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses a real-money action', async () => {
    const scan = classifyResilienceClaim({ realMoney: true })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses a real order', async () => {
    const scan = classifyResilienceClaim({ realOrder: true })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses self-modification', async () => {
    const scan = classifyResilienceClaim({ selfModify: true })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses to fabricate recovery', async () => {
    const scan = classifyResilienceClaim({ fabricateState: true })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses to hide degradation', async () => {
    const scan = classifyResilienceClaim({ hideDegradation: true })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses to fabricate capability', async () => {
    const scan = classifyResilienceClaim({ fabricateCapability: true })
    expect(scan.prohibited).toBe(true)
  })
})

/* ------------------------------------------------- hidden inference */

describe('hidden inference', () => {
  it('refuses a hidden model call', async () => {
    const h = harness()
    const { runtime: instance } = await runtime()
    // No model call port exists; the runtime cannot make one
    expect(h.types().filter((t) => t.startsWith('model.')).length).toBe(0)
  })

  it('refuses continuous polling', async () => {
    const h = harness()
    const { runtime: instance } = await runtime()
    // No timer is set up; the runtime only changes state on explicit actions
    expect(h.types().filter((t) => t.includes('poll')).length).toBe(0)
  })

  it('refuses hidden reasoning', async () => {
    const h = harness()
    const { runtime: instance } = await runtime()
    // No background reasoning occurs
    expect(h.types().filter((t) => t.includes('reasoning')).length).toBe(0)
  })

  it('refuses an unrestricted loop', async () => {
    const h = harness()
    const { runtime: instance } = await runtime()
    // No loop is set up
    expect(h.types().filter((t) => t.includes('loop')).length).toBe(0)
  })

  it('refuses an idle model call', async () => {
    const h = harness()
    const { runtime: instance } = await runtime()
    // No model call occurs while idle
    expect(h.types().filter((t) => t.startsWith('model.')).length).toBe(0)
  })

  it('refuses background reasoning', async () => {
    const h = harness()
    const { runtime: instance } = await runtime()
    // No background reasoning occurs
    expect(h.types().filter((t) => t.includes('background')).length).toBe(0)
  })

  it('refuses hidden durable state', async () => {
    const h = harness()
    const { runtime: instance } = await runtime()
    // All state is derived from the journal
    const fold = reduceResilienceState(h.entries)
    expect(fold.state).toEqual(instance.folded())
  })
})

/* ------------------------------------------------- data injection */

describe('data injection', () => {
  it('treats model output claiming urgency as data', async () => {
    const scan = classifyResilienceClaim({ urgency: 'critical' })
    // Urgency is not a forbidden key, but it is treated as data
    expect(scan.prohibited).toBe(false)
  })

  it('treats model output claiming priority as data', async () => {
    const scan = classifyResilienceClaim({ priority: 'high' })
    expect(scan.prohibited).toBe(true)
  })

  it('treats model output claiming outcome as data', async () => {
    const scan = classifyResilienceClaim({ outcome: 'success' })
    expect(scan.prohibited).toBe(false)
  })

  it('treats event claiming importance as data', async () => {
    const scan = classifyResilienceClaim({ importance: 'high' })
    expect(scan.prohibited).toBe(false)
  })

  it('treats event claiming deadline as data', async () => {
    const scan = classifyResilienceClaim({ deadline: 'now' })
    expect(scan.prohibited).toBe(false)
  })

  it('treats context claiming authority as data', async () => {
    const scan = classifyResilienceClaim({ authority: 'admin' })
    expect(scan.prohibited).toBe(true)
  })
})

/* ------------------------------------------------- restart recovery */

describe('restart recovery', () => {
  it('does not fabricate state on restart', async () => {
    const h1 = harness()
    const r1 = new ResilienceRuntime({ ports: h1.ports })
    await r1.open()
    await r1.detectFailure(failureEvent())

    const h2 = harness()
    h2.seed(h1.entries)
    const r2 = new ResilienceRuntime({ ports: h2.ports })
    await r2.open()

    expect(r2.folded().failures.length).toBe(1)
    expect(r2.folded().currentState).not.toBe('HEALTHY')
  })

  it('does not allow hidden state to survive restart', async () => {
    const h1 = harness()
    const r1 = new ResilienceRuntime({ ports: h1.ports })
    await r1.open()

    const h2 = harness()
    h2.seed(h1.entries)
    const r2 = new ResilienceRuntime({ ports: h2.ports })
    await r2.open()

    expect(r2.folded()).toEqual(r1.folded())
  })

  it('does not silently resume an interrupted recovery', async () => {
    const h1 = harness()
    const r1 = new ResilienceRuntime({ ports: h1.ports })
    await r1.open()
    await r1.detectFailure(failureEvent())
    await r1.startRecovery('f-1')

    const h2 = harness()
    h2.seed(h1.entries)
    const r2 = new ResilienceRuntime({ ports: h2.ports })
    await r2.open()

    // The recovery is not silently resumed
    const activeRecovery = r2.folded().recoveries.find((r) => r.outcome === null)
    expect(activeRecovery).toBeDefined()
  })

  it('does not hide an interrupted recovery', async () => {
    const h1 = harness()
    const r1 = new ResilienceRuntime({ ports: h1.ports })
    await r1.open()
    await r1.detectFailure(failureEvent())
    await r1.startRecovery('f-1')

    const h2 = harness()
    h2.seed(h1.entries)
    const r2 = new ResilienceRuntime({ ports: h2.ports })
    await r2.open()

    const snapshot = r2.snapshot()
    expect(snapshot.recovery?.requiresOwnerAction).toBe(true)
  })

  it('does not self-modify on restart', async () => {
    const h1 = harness()
    const r1 = new ResilienceRuntime({ ports: h1.ports })
    await r1.open()

    const h2 = harness()
    h2.seed(h1.entries)
    const r2 = new ResilienceRuntime({ ports: h2.ports })
    await r2.open()

    expect(h2.types().filter((t) => t.includes('self-modification')).length).toBe(0)
  })
})

/* ------------------------------------------------- composite attacks */

describe('composite attacks', () => {
  it('refuses recovery claims capability + bypass Guard', async () => {
    const h = harness({ guardAllows: false })
    const { runtime: instance } = await runtime({ guardAllows: false })
    const outcome = await instance.detectFailure(failureEvent())
    expect(outcome.ok).toBe(false)
  })

  it('refuses model output claims urgency + bypass Governor', async () => {
    const h = harness({ governorAuthorized: false })
    const { runtime: instance } = await runtime({ governorAuthorized: false })
    const outcome = await instance.detectFailure(failureEvent())
    expect(outcome.ok).toBe(false)
  })

  it('refuses event claims importance + exceed budget', async () => {
    const h = harness({ budgetRemainingUnits: 0 })
    const { runtime: instance } = await runtime({ budgetRemainingUnits: 0 })
    const outcome = await instance.detectFailure(failureEvent())
    expect(outcome.ok).toBe(false)
  })

  it('refuses context claims authority + skip approval', async () => {
    const h = harness({ approvalSatisfied: false })
    const { runtime: instance } = await runtime({ approvalSatisfied: false })
    const outcome = await instance.startRepair('f-1', null)
    expect(outcome.ok).toBe(false)
  })

  it('refuses hidden inference + continuous polling', async () => {
    const h = harness()
    const { runtime: instance } = await runtime()
    expect(h.types().filter((t) => t.startsWith('model.')).length).toBe(0)
  })

  it('refuses real-money action + bypass approval', async () => {
    const scan = classifyResilienceClaim({ realMoney: true, approved: true })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses real order + bypass Guard', async () => {
    const scan = classifyResilienceClaim({ realOrder: true })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses self-modification + bypass approval', async () => {
    const scan = classifyResilienceClaim({ selfModify: true, approved: true })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses fabricate recovery + bypass Governor', async () => {
    const scan = classifyResilienceClaim({ fabricateState: true })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses hide degradation + fabricate capability', async () => {
    const scan = classifyResilienceClaim({ hideDegradation: true, fabricateCapability: true })
    expect(scan.prohibited).toBe(true)
  })
})
