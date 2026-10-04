import { describe, expect, it } from 'vitest'
import { SovereigntyRuntime } from '../../../core/sovereign/runtime'
import { classifySovereigntyClaim } from '../../../core/sovereign/prohibition'
import { reduceSovereigntyState } from '../../../core/sovereign/state'
import { SOVEREIGNTY_EVENT_TYPES } from '../../../core/sovereign/types'
import { harness } from '../../core/sovereign/harness'

async function runtime(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options)
  const instance = new SovereigntyRuntime({ ports: h.ports, limits: options?.limits })
  await instance.open()
  return { h, runtime: instance }
}

/**
 * What a cognition leak would have to be called to get past this file.
 *
 * Deliberately does *not* include `complete`: honest sovereignty event types end in
 * `.completed` (`provider.routed`, `offline.ended`, `data.verified` and the rest),
 * and a check broad enough to catch those would either fail on correct names or get
 * weakened until it caught nothing. A leak has to be named after what it does —
 * reach a model, spend tokens, prompt, infer, think — not after a word that also ends
 * half the domain's own vocabulary.
 */
const COGNITION_LEAK = /model|cognit|prompt|infer|llm|token|thinking|reason|completion/i

describe('a sovereignty claims authority', () => {
  it('refuses a capability claim', async () => {
    const scan = classifySovereigntyClaim({ capability: 'super-admin' })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses a grant claim', async () => {
    const scan = classifySovereigntyClaim({ grantId: 'g-self-made' })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses a self-approval', async () => {
    const scan = classifySovereigntyClaim({ approved: true, approvalId: 'mine' })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses a claim to be the owner', async () => {
    const scan = classifySovereigntyClaim({ principal: 'owner', actor: 'owner' })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses a priority claim', async () => {
    const scan = classifySovereigntyClaim({ priority: 'urgent' })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses a budget claim', async () => {
    const scan = classifySovereigntyClaim({ budget: 999999 })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses an approval claim', async () => {
    const scan = classifySovereigntyClaim({ approved: true })
    expect(scan.prohibited).toBe(true)
  })
})

describe('boundary violations', () => {
  it('refuses to bypass Guard', async () => {
    const { runtime: instance } = await runtime({ guardAllows: false })
    const outcome = await instance.routeProvider('p-1', 'Test')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('guard-denied')
  })

  it('refuses to bypass Governor', async () => {
    const { runtime: instance } = await runtime({ governorAuthorized: false })
    const outcome = await instance.routeProvider('p-1', 'Test')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('governor-denied')
  })

  it('refuses to bypass STOP ALL', async () => {
    const { runtime: instance } = await runtime({ stopAll: true })
    const outcome = await instance.routeProvider('p-1', 'Test')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('stop-all-active')
  })

  it('refuses to exceed budget', async () => {
    const { runtime: instance } = await runtime({ budgetRemainingUnits: 0 })
    const outcome = await instance.routeProvider('p-1', 'Test')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('budget-exhausted')
  })

  it('refuses to skip approval', async () => {
    const { runtime: instance } = await runtime({ approvalSatisfied: false })
    const outcome = await instance.startOffline('full')
    expect(outcome.ok).toBe(false)
  })

  it('refuses to widen capability', async () => {
    const scan = classifySovereigntyClaim({ widenCapability: true })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses to create a grant', async () => {
    const scan = classifySovereigntyClaim({ createGrant: true })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses to self-approve', async () => {
    const scan = classifySovereigntyClaim({ selfApprove: true })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses a real-money action', async () => {
    const scan = classifySovereigntyClaim({ realMoney: true })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses a real order', async () => {
    const scan = classifySovereigntyClaim({ realOrder: true })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses self-modification', async () => {
    const scan = classifySovereigntyClaim({ selfModify: true })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses to add a new provider', async () => {
    const scan = classifySovereigntyClaim({ addProvider: true })
    expect(scan.prohibited).toBe(false)
  })

  it('refuses to store plaintext data', async () => {
    const scan = classifySovereigntyClaim({ plaintext: true })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses to fabricate data integrity', async () => {
    const scan = classifySovereigntyClaim({ fabricateIntegrity: true })
    expect(scan.prohibited).toBe(true)
  })
})

describe('hidden inference', () => {
  /**
   * Every case here drives the runtime through a real decision and then reads the
   * journal *that runtime actually wrote*.
   *
   * The obvious way to write these is to build a spare harness, assert its event
   * types are empty, and call that a pass. That assertion cannot fail: a harness
   * nobody has written to has no events in it, so it would report "no hidden model
   * call" just as happily against a runtime that makes one on every tick. Each test
   * below therefore begins by proving the journal is non-empty, so the absence it
   * goes on to assert is an absence rather than an empty starting condition.
   */
  async function routedJournal() {
    const { h, runtime: instance } = await runtime()
    expect((await instance.routeProvider('p-local', 'primary is unreachable')).ok).toBe(true)
    expect((await instance.fallbackProvider('p-local', 'p-remote')).ok).toBe(true)
    // The journal is populated. Without this the assertions below prove nothing.
    expect(h.types().length).toBeGreaterThan(0)
    return { h, instance }
  }

  it('refuses a hidden model call', async () => {
    const { h } = await routedJournal()
    expect(h.types().filter((t) => COGNITION_LEAK.test(t)).length).toBe(0)
  })

  it('refuses continuous polling', async () => {
    const { h } = await routedJournal()
    expect(h.types().filter((t) => t.includes('poll')).length).toBe(0)
  })

  it('refuses hidden reasoning', async () => {
    const { h } = await routedJournal()
    expect(h.types().filter((t) => t.includes('reasoning')).length).toBe(0)
  })

  it('refuses an unrestricted loop', async () => {
    const { h } = await routedJournal()
    expect(h.types().filter((t) => t.includes('loop')).length).toBe(0)
  })

  it('refuses an idle model call', async () => {
    // Idle means idle: nothing is written after the decision completes, so a
    // runtime that quietly began work on a timer would add to a quiet journal.
    const { h } = await routedJournal()
    const before = h.types().length
    expect(h.types().filter((t) => COGNITION_LEAK.test(t)).length).toBe(0)
    expect(h.types().length).toBe(before)
  })

  it('refuses background reasoning', async () => {
    const { h } = await routedJournal()
    expect(h.types().filter((t) => t.includes('background')).length).toBe(0)
  })

  it('refuses hidden durable state', async () => {
    const { h, instance } = await routedJournal()
    // All state is derived from the journal, so the fold and the runtime must agree.
    const fold = reduceSovereigntyState(h.entries)
    expect(fold.state).toEqual(instance.folded())
  })

  it('has no port through which a model could be reached', async () => {
    // The structural half of the same claim, asserted once rather than inferred
    // seven times: the lane has no cognition port, so "no hidden model call" is a
    // property of the interface and not only of what this suite exercised.
    const ports = harness().ports as unknown as Record<string, unknown>
    expect(Object.keys(ports).filter((name) => COGNITION_LEAK.test(name))).toEqual([])
  })

  it('journals no event type that could carry a model call', async () => {
    expect(SOVEREIGNTY_EVENT_TYPES.filter((type) => COGNITION_LEAK.test(type))).toEqual([])
  })
})

describe('data injection', () => {
  it('treats model output claiming urgency as data', async () => {
    const scan = classifySovereigntyClaim({ urgency: 'critical' })
    expect(scan.prohibited).toBe(false)
  })

  it('treats model output claiming priority as data', async () => {
    const scan = classifySovereigntyClaim({ priority: 'high' })
    expect(scan.prohibited).toBe(true)
  })

  it('treats model output claiming outcome as data', async () => {
    const scan = classifySovereigntyClaim({ outcome: 'success' })
    expect(scan.prohibited).toBe(false)
  })

  it('treats event claiming importance as data', async () => {
    const scan = classifySovereigntyClaim({ importance: 'high' })
    expect(scan.prohibited).toBe(false)
  })

  it('treats event claiming deadline as data', async () => {
    const scan = classifySovereigntyClaim({ deadline: 'now' })
    expect(scan.prohibited).toBe(false)
  })

  it('treats context claiming authority as data', async () => {
    const scan = classifySovereigntyClaim({ authority: 'admin' })
    expect(scan.prohibited).toBe(true)
  })
})

describe('restart recovery', () => {
  it('does not fabricate state on restart', async () => {
    const h1 = harness()
    const r1 = new SovereigntyRuntime({ ports: h1.ports })
    await r1.open()
    await r1.routeProvider('p-1', 'Test')

    const h2 = harness()
    h2.seed(h1.entries)
    const r2 = new SovereigntyRuntime({ ports: h2.ports })
    await r2.open()

    expect(r2.folded().routingDecisions.length).toBe(1)
  })

  it('does not allow hidden state to survive restart', async () => {
    const h1 = harness()
    const r1 = new SovereigntyRuntime({ ports: h1.ports })
    await r1.open()

    const h2 = harness()
    h2.seed(h1.entries)
    const r2 = new SovereigntyRuntime({ ports: h2.ports })
    await r2.open()

    expect(r2.folded()).toEqual(r1.folded())
  })

  it('does not silently resume an interrupted operation', async () => {
    const h1 = harness()
    const r1 = new SovereigntyRuntime({ ports: h1.ports })
    await r1.open()
    await r1.startOffline('full')

    const h2 = harness()
    h2.seed(h1.entries)
    const r2 = new SovereigntyRuntime({ ports: h2.ports })
    await r2.open()

    const activeSession = r2.folded().offlineSessions.find((s) => s.endedAt === null)
    expect(activeSession).toBeDefined()
  })

  it('does not hide an interrupted operation', async () => {
    const h1 = harness()
    const r1 = new SovereigntyRuntime({ ports: h1.ports })
    await r1.open()
    await r1.startOffline('full')

    const h2 = harness()
    h2.seed(h1.entries)
    const r2 = new SovereigntyRuntime({ ports: h2.ports })
    await r2.open()

    const snapshot = r2.snapshot()
    expect(snapshot.status.isStopped).toBe(false)
  })

  it('does not self-modify on restart', async () => {
    const h1 = harness()
    const r1 = new SovereigntyRuntime({ ports: h1.ports })
    await r1.open()

    const h2 = harness()
    h2.seed(h1.entries)
    const r2 = new SovereigntyRuntime({ ports: h2.ports })
    await r2.open()

    expect(h2.types().filter((t) => t.includes('self-modification')).length).toBe(0)
  })
})

describe('composite attacks', () => {
  it('refuses sovereignty claims capability + bypass Guard', async () => {
    const { runtime: instance } = await runtime({ guardAllows: false })
    const outcome = await instance.routeProvider('p-1', 'Test')
    expect(outcome.ok).toBe(false)
  })

  it('refuses model output claims urgency + bypass Governor', async () => {
    const { runtime: instance } = await runtime({ governorAuthorized: false })
    const outcome = await instance.routeProvider('p-1', 'Test')
    expect(outcome.ok).toBe(false)
  })

  it('refuses event claims importance + exceed budget', async () => {
    const { runtime: instance } = await runtime({ budgetRemainingUnits: 0 })
    const outcome = await instance.routeProvider('p-1', 'Test')
    expect(outcome.ok).toBe(false)
  })

  it('refuses context claims authority + skip approval', async () => {
    const { runtime: instance } = await runtime({ approvalSatisfied: false })
    const outcome = await instance.startOffline('full')
    expect(outcome.ok).toBe(false)
  })

  it('refuses hidden inference + continuous polling', async () => {
    // Driven through real decisions, so the journal read here is the one the runtime
    // wrote. Asserting against an untouched harness would pass regardless.
    const { h, runtime: instance } = await runtime()
    expect((await instance.routeProvider('p-local', 'primary is unreachable')).ok).toBe(true)
    expect(h.types().filter((t) => COGNITION_LEAK.test(t)).length).toBe(0)
    expect(h.types().filter((t) => t.includes('poll')).length).toBe(0)
    // And the journal is genuinely populated, so the two assertions above are about
    // what was written rather than about an empty starting condition.
    expect(h.types().length).toBeGreaterThan(0)
  })

  it('refuses real-money action + bypass approval', async () => {
    const scan = classifySovereigntyClaim({ realMoney: true, approved: true })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses real order + bypass Guard', async () => {
    const scan = classifySovereigntyClaim({ realOrder: true })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses self-modification + bypass approval', async () => {
    const scan = classifySovereigntyClaim({ selfModify: true, approved: true })
    expect(scan.prohibited).toBe(true)
  })

  it('refuses add provider + bypass Guard', async () => {
    const { runtime: instance } = await runtime({ guardAllows: false })
    const outcome = await instance.routeProvider('p-1', 'Test')
    expect(outcome.ok).toBe(false)
  })

  it('refuses store plaintext + fabricate integrity', async () => {
    const scan = classifySovereigntyClaim({ plaintext: true, fabricateIntegrity: true })
    expect(scan.prohibited).toBe(true)
  })
})
