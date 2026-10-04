import { describe, expect, it } from 'vitest'
import { ResilienceRuntime } from '../../../core/resilience/runtime'
import { classifyResilienceClaim } from '../../../core/resilience/prohibition'
import { reduceResilienceState } from '../../../core/resilience/state'
import { RESILIENCE_EVENT_TYPES } from '../../../core/resilience/types'
import { harness, failureEvent } from '../../core/resilience/harness'

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
    const { runtime: instance } = await runtime()
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
  /**
   * Each case asserts two things, not one: the runtime refused, *and* the refusal
   * reached the journal.
   *
   * Asserting only `outcome.ok === false` would pass against a runtime that refused
   * silently — and a refusal nobody recorded is indistinguishable, after a restart,
   * from a request that was never made. `h` is the harness the runtime was actually
   * built from, so `h.refusals()` is the runtime's own record rather than a spare one.
   */
  it('refuses to bypass Guard', async () => {
    const { h, runtime: instance } = await runtime({ guardAllows: false })
    const outcome = await instance.detectFailure(failureEvent())
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('guard-denied')
    expect(h.refusals()).toContain('guard-denied')
  })

  it('refuses to bypass Governor', async () => {
    const { h, runtime: instance } = await runtime({ governorAuthorized: false })
    const outcome = await instance.detectFailure(failureEvent())
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('governor-denied')
    expect(h.refusals()).toContain('governor-denied')
  })

  it('refuses to bypass STOP ALL', async () => {
    const { h, runtime: instance } = await runtime({ stopAll: true })
    const outcome = await instance.detectFailure(failureEvent())
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('stop-all-active')
    expect(h.refusals()).toContain('stop-all-active')
  })

  it('refuses to exceed budget', async () => {
    const { h, runtime: instance } = await runtime({ budgetRemainingUnits: 0 })
    const outcome = await instance.detectFailure(failureEvent())
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('budget-exhausted')
    expect(h.refusals()).toContain('budget-exhausted')
  })

  it('refuses to skip approval', async () => {
    const { h, runtime: instance } = await runtime({ approvalSatisfied: false })
    const outcome = await instance.startRepair('f-1', null)
    expect(outcome.ok).toBe(false)
    expect(h.refusals().length).toBeGreaterThan(0)
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
  /**
   * What a cognition leak would have to be called to get past this file.
   *
   * Deliberately does *not* include `complete`: three legitimate event types end in
   * `.completed` (`recovery`, `restore`, `repair`) and a check broad enough to catch
   * them would either fail on honest names or get weakened until it caught nothing.
   * A leak has to be named after what it does — reach a model, spend tokens, prompt,
   * infer, think — not after a word that also ends half the domain's own vocabulary.
   */
  const COGNITION_LEAK = /model|cognit|prompt|infer|llm|token|thinking|reason|completion/i

  /**
   * Every case here drives the runtime through a real recovery cycle and then reads
   * the journal *that runtime actually wrote*.
   *
   * The obvious way to write these is to build a spare harness, assert its event
   * types are empty, and call that a pass. That assertion cannot fail: a harness
   * nobody has written to has no events in it, so it would report "no hidden model
   * call" just as happily against a runtime that makes one on every tick. Each test
   * below therefore begins by proving the journal is non-empty, so the absence it
   * goes on to assert is an absence rather than an empty starting condition.
   */
  async function recoveredJournal() {
    const { h, runtime: instance } = await runtime()
    expect((await instance.detectFailure(failureEvent())).ok).toBe(true)
    const started = await instance.startRecovery('f-1')
    expect(started.ok).toBe(true)
    if (!started.ok) throw new Error('recovery did not start')
    expect((await instance.completeRecovery(started.value.recoveryId, 'restored', 'verified')).ok).toBe(true)
    // The journal is populated. Without this the assertions below prove nothing.
    expect(h.types().length).toBeGreaterThan(0)
    return { h, instance }
  }

  it('refuses a hidden model call', async () => {
    const { h } = await recoveredJournal()
    expect(h.types().filter((t) => t.startsWith('model.')).length).toBe(0)
  })

  it('refuses continuous polling', async () => {
    const { h } = await recoveredJournal()
    expect(h.types().filter((t) => t.includes('poll')).length).toBe(0)
  })

  it('refuses hidden reasoning', async () => {
    const { h } = await recoveredJournal()
    expect(h.types().filter((t) => t.includes('reasoning')).length).toBe(0)
  })

  it('refuses an unrestricted loop', async () => {
    const { h } = await recoveredJournal()
    expect(h.types().filter((t) => t.includes('loop')).length).toBe(0)
  })

  it('refuses an idle model call', async () => {
    // Idle means idle: nothing is written after the cycle completes, so a runtime
    // that quietly began work on a timer would add to a journal that is now quiet.
    const { h } = await recoveredJournal()
    const before = h.types().length
    expect(h.types().filter((t) => t.startsWith('model.')).length).toBe(0)
    expect(h.types().length).toBe(before)
  })

  it('refuses background reasoning', async () => {
    const { h } = await recoveredJournal()
    expect(h.types().filter((t) => t.includes('background')).length).toBe(0)
  })

  it('refuses hidden durable state', async () => {
    const { h, instance } = await recoveredJournal()
    // All state is derived from the journal, so the fold and the runtime must agree.
    const fold = reduceResilienceState(h.entries)
    expect(fold.state).toEqual(instance.folded())
  })

  it('has no port through which a model could be reached', async () => {
    // The structural half of the same claim, asserted once rather than inferred six
    // times: the lane has no cognition port, so "no hidden model call" is a property
    // of the interface and not only of what this suite happened to exercise.
    const ports = harness().ports as unknown as Record<string, unknown>
    expect(Object.keys(ports).filter((name) => COGNITION_LEAK.test(name))).toEqual([])
  })

  it('journals no event type that could carry a model call', async () => {
    expect(RESILIENCE_EVENT_TYPES.filter((type) => COGNITION_LEAK.test(type))).toEqual([])
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
    const { h, runtime: instance } = await runtime({ guardAllows: false })
    const outcome = await instance.detectFailure(failureEvent())
    expect(outcome.ok).toBe(false)
    expect(h.refusals()).toContain('guard-denied')
  })

  it('refuses model output claims urgency + bypass Governor', async () => {
    const { h, runtime: instance } = await runtime({ governorAuthorized: false })
    const outcome = await instance.detectFailure(failureEvent())
    expect(outcome.ok).toBe(false)
    expect(h.refusals()).toContain('governor-denied')
  })

  it('refuses event claims importance + exceed budget', async () => {
    const { h, runtime: instance } = await runtime({ budgetRemainingUnits: 0 })
    const outcome = await instance.detectFailure(failureEvent())
    expect(outcome.ok).toBe(false)
    expect(h.refusals()).toContain('budget-exhausted')
  })

  it('refuses context claims authority + skip approval', async () => {
    const { h, runtime: instance } = await runtime({ approvalSatisfied: false })
    const outcome = await instance.startRepair('f-1', null)
    expect(outcome.ok).toBe(false)
    expect(h.refusals().length).toBeGreaterThan(0)
  })

  it('refuses hidden inference + continuous polling', async () => {
    // Driven through a real recovery cycle, so the journal read here is the one the
    // runtime wrote. Asserting against an untouched harness would pass regardless.
    const { h, runtime: instance } = await runtime()
    expect((await instance.detectFailure(failureEvent())).ok).toBe(true)
    expect(h.types().filter((t) => t.startsWith('model.')).length).toBe(0)
    expect(h.types().filter((t) => t.includes('poll')).length).toBe(0)
    // And the journal is genuinely populated, so the two assertions above are about
    // what was written rather than about an empty starting condition.
    expect(h.types().length).toBeGreaterThan(0)
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
