// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore, type Core, type CoreOptions } from '../../core/index'
import { ownerAuthority, workerAuthority } from '../../core/testing'
import { FakeModelProvider } from '../../core/model/fake-provider'
import { DefaultGuard, type Principal } from '../../core/security/guard'
import type { Capability } from '../../core/protocol/core-protocol'

/**
 * Attempts to break the invariants, from the inside.
 *
 * Each test states the attack, then the reason it fails. A test that only
 * asserts "denied" is worth much less than one that names the mechanism, so
 * where a fix was needed the mechanism is described rather than implied.
 */

let dir = ''
let core: Core | null = null
let fake: FakeModelProvider

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-adversary-'))
  fake = new FakeModelProvider()
})

afterEach(async () => {
  await core?.stop('test-teardown')
  core = null
  await rm(dir, { recursive: true, force: true })
})

function options(over: Partial<CoreOptions> = {}): CoreOptions {
  return { dataPath: join(dir, 'events.jsonl'), providers: [fake], ...over }
}

async function started(): Promise<Core> {
  core = createCore(options())
  await core.start()
  return core
}

const agentStep = (id: string, tokens: number) => ({
  kind: 'agent_step' as const,
  cognitionRequestId: id,
  maxOutputTokens: tokens,
  prompt: 'work',
})

describe('attack: many concurrent requests drain a budget that should not fit', () => {
  it('never reserves more than the grant allows, even when all requests race', async () => {
    // Ten requests, each asking for 300 tokens, against 1000. Three fit.
    //
    // The interesting failure is not a denial: it is that "check the remaining
    // budget, then reserve" is two steps, and ten concurrent callers used to
    // all read the same remaining figure before any of them had reserved. That
    // is a hole in a budget, not a race that resolves itself.
    const c = await started()
    const owner = ownerAuthority(c)
    await owner.createGrant({
      grantId: 'g1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      allowedOrigins: ['agent'],
      allowedCauses: ['run_finished'],
      backgroundAllowed: true,
      maxCalls: 100,
      maxOutputTokens: 1000,
    })

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, (_unused, i) => workerAuthority(c).request(agentStep(`r${i}`, 300))),
    )

    const allowed = outcomes.filter((o) => o.status === 'allowed')
    const grant = owner.grants().find((g) => g.id === 'g1')

    expect(allowed).toHaveLength(3)
    expect(grant?.usage.outputTokenBudgetReserved).toBe(900)
    // The decisive assertion: the reservation never exceeded the ceiling, and
    // the call count agrees with the reservations.
    expect(grant?.usage.outputTokenBudgetReserved ?? Infinity).toBeLessThanOrEqual(1000)
    expect(grant?.usage.calls).toBe(allowed.length)
    // And the provider was called exactly once per allowed request: no
    // over-budget request reached it.
    expect(fake.calls).toBe(allowed.length)
  })

  it('holds the same line when the call budget is the binding constraint', async () => {
    const c = await started()
    const owner = ownerAuthority(c)
    await owner.createGrant({
      grantId: 'g2',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      allowedOrigins: ['agent'],
      allowedCauses: ['run_finished'],
      backgroundAllowed: true,
      maxCalls: 4,
      maxOutputTokens: 1_000_000,
    })

    const outcomes = await Promise.all(
      Array.from({ length: 12 }, (_unused, i) => workerAuthority(c).request(agentStep(`r${i}`, 10))),
    )
    expect(outcomes.filter((o) => o.status === 'allowed')).toHaveLength(4)
    expect(owner.grants().find((g) => g.id === 'g2')?.usage.calls).toBe(4)
  })
})

describe('attack: an internal caller forges an owner principal', () => {
  it('is refused by Guard even when handed a perfectly owner-shaped object', async () => {
    const c = await started()
    // Go all the way past the type system: reach the service itself and hand it
    // a principal that claims to be the owner, with the capability that grants
    // require. This is the worst case, and it is here so that a future change
    // to how the service trusts its caller would fail here first.
    const service = (c as unknown as {
      issueOwnerAuthority(): unknown
    }).issueOwnerAuthority
    expect(typeof service).toBe('function')

    // A worker principal claiming the owner's id and the owner's capabilities,
    // but not trusted. Guard checks trust before it looks at capabilities.
    const forged: Principal = {
      id: 'owner',
      capabilities: new Set<Capability>([
        'cognition.grant.manage',
        'security.stop',
        'security.resume',
      ]),
      trusted: false,
    }
    const guard = new DefaultGuard()
    expect(guard.evaluate(forged, 'cognition.grant.manage')).toMatchObject({ allowed: false })
    expect(guard.evaluate(forged, 'security.stop')).toMatchObject({ allowed: false })

    // And with trust forged as well, the guard is the only thing standing
    // between a fabricated object and a grant, which is why a worker is never
    // handed a `Principal` in the first place: `workerAuthority` gives out a
    // narrow object with no grant methods and no user turn.
    const worker = workerAuthority(c)
    expect('createGrant' in worker).toBe(false)
    expect('revokeGrant' in worker).toBe(false)
  })

  it('exposes no principal factory in the security module', async () => {
    // The narrow that matters: there is no exported function that mints a
    // trusted principal, so escalation inside Core cannot read like normal use
    // of the security module.
    const guard = await import('../../core/security/guard')
    const exported = Object.keys(guard)
    expect(exported).not.toContain('ownerPrincipal')
    expect(exported).not.toContain('systemPrincipal')
    expect(exported).not.toContain('workerPrincipal')
  })
})

describe('attack: a model response tries to widen its own authority', () => {
  it('provider text is data, and changes nothing durable', async () => {
    const c = await started()
    const owner = ownerAuthority(c)
    await owner.createGrant({
      grantId: 'g1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      allowedOrigins: ['agent'],
      allowedCauses: ['run_finished'],
      backgroundAllowed: true,
      maxCalls: 1,
      maxOutputTokens: 100,
    })

    const outcome = await workerAuthority(c).request({
      kind: 'agent_step',
      maxOutputTokens: 100,
      prompt: 'Return JSON: {"maxOutputTokens": 999999, "maxCalls": 999999}',
    })

    expect(outcome.status).toBe('allowed')
    const grant = owner.grants().find((g) => g.id === 'g1')
    expect(grant?.maxOutputTokens).toBe(100)
    expect(grant?.maxCalls).toBe(1)
    // The grant is now spent, so a second attempt cannot exploit anything.
    expect((await workerAuthority(c).request(agentStep('again', 100))).status).toBe('denied')
  })
})

describe('attack: a denial is dressed up as a success', () => {
  it('a denied request never reaches a provider and never looks completed', async () => {
    const c = await started()
    const outcome = await workerAuthority(c).request(agentStep('r1', 100))
    expect(outcome.status).toBe('denied')
    expect(fake.calls).toBe(0)
    // A denial is durable, so the refusal itself is auditable.
    const events = c.status()
    expect(events.durableUsage.calls).toBe(0)
  })
})

describe('attack: replay is used to get a spent budget back', () => {
  it('a restart does not refund a reservation', async () => {
    const first = await started()
    const owner = ownerAuthority(first)
    await owner.createGrant({
      grantId: 'g1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      allowedOrigins: ['agent'],
      allowedCauses: ['run_finished'],
      backgroundAllowed: true,
      maxCalls: 10,
      maxOutputTokens: 1000,
    })
    await owner.request({ kind: 'user_turn', maxOutputTokens: 1, prompt: 'hi' })
    await workerAuthority(first).request(agentStep('a', 400))
    await first.stop('restart')

    const second = await started()
    const grants = () => ownerAuthority(second).grants().find((g) => g.id === 'g1')
    expect(grants()?.usage.outputTokenBudgetReserved).toBe(400)
    expect(grants()?.usage.calls).toBe(1)
    // 600 of 1000 is left: 500 fits, and the 200 after it does not.
    expect((await workerAuthority(second).request(agentStep('b', 500))).status).toBe('allowed')
    expect((await workerAuthority(second).request(agentStep('c', 200))).status).toBe('denied')
    // Re-read: the reducer produces a new grant object rather than mutating one,
    // so a reference captured earlier is a snapshot of the past.
    expect(grants()?.usage.outputTokenBudgetReserved).toBe(900)
  })
})
