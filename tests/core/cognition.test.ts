// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore, type Core, type CoreOptions } from '../../core/index'
import {
  FakeModelProvider,
  FailingModelProvider,
  FaultedModelProvider,
  SilentModelProvider,
  HangingModelProvider,
} from '../../core/model/fake-provider'
import { ownerAuthority } from '../../core/testing'
import type { CognitionIntent } from '../../core/authority'
import type { CognitionGrantSpec } from '../../core/cognition/grants'
import type { CoreStatus } from '../../core/protocol/core-protocol'

/**
 * The guarantees that must not regress:
 *   - a denied request costs nothing and touches no provider;
 *   - a finite grant is finite, across a restart;
 *   - a spent call is spent even when the provider then fails;
 *   - STOP ALL survives a restart, because it is derived, not remembered;
 *   - nothing that merely *observes* Core causes a provider call.
 */

let dir = ''
let core: Core | null = null

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-core-'))
})

afterEach(async () => {
  await core?.stop('test-teardown')
  core = null
  await rm(dir, { recursive: true, force: true })
})

/**
 * Tests inject their provider explicitly. There is no implicit echo provider
 * to fall back on, so every test that wants one has to ask for it by name.
 */
function options(overrides: Partial<CoreOptions> = {}): CoreOptions {
  return { dataPath: join(dir, 'events.jsonl'), providers: [new FakeModelProvider()], ...overrides }
}

/**
 * Build an intent. There is no `actor`, no `origin`, no `cause` and no
 * `background` field to set, because none of them is the caller's to choose.
 */
function call(overrides: Partial<CognitionIntent> = {}): CognitionIntent {
  return {
    cognitionRequestId: 'req-1',
    correlationId: 'corr-1',
    kind: 'user_turn',
    maxOutputTokens: 200,
    requestedModel: null,
    goalId: null,
    prompt: 'hello',
    ...overrides,
  }
}

const grantSpec = (over: Partial<CognitionGrantSpec> = {}): CognitionGrantSpec => ({
  grantId: 'grant-1',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  allowedOrigins: ['agent', 'system', 'workflow'],
  allowedCauses: ['run_finished', 'scheduled_grant'],
  backgroundAllowed: true,
  maxCalls: 2,
  maxOutputTokens: 1000,
  ...over,
})

/** Create a grant as the owner. Goes through Guard, like every other path. */
async function grant(c: Core, over: Partial<CognitionGrantSpec> = {}) {
  return ownerAuthority(c).createGrant(grantSpec(over))
}

describe('cognition service', () => {
  it('refuses a non-user request with no grant and calls no provider', async () => {
    core = createCore(options())
    const status = await core.start()
    const before = status.sessionUsage.calls

    // No grant, and nobody is waiting: the only correct answer is no.
    const outcome = await ownerAuthority(core).request(
      call({ kind: 'agent_step' }),
    )

    expect(outcome.status).toBe('denied')
    expect(core.status().sessionUsage.calls).toBe(before)
    expect(core.status().durableUsage.calls).toBe(before)
  })

  it('allows an explicit user turn with no grant, because the human is present', async () => {
    core = createCore(options())
    await core.start()

    // The single grantless path. Locked down deliberately: if this ever starts
    // demanding a grant, ordinary replies break; if it ever widens, silence
    // starts spending.
    const outcome = await ownerAuthority(core).request(call())

    expect(outcome.status).toBe('allowed')
    expect(core.status().sessionUsage.calls).toBe(1)
  })

  it('refuses an agent step against a grant that forbids unattended work', async () => {
    core = createCore(options())
    await core.start()
    await grant(core, { backgroundAllowed: false })

    // `agent_step` is background by definition now, so it needs a grant that
    // says background work is allowed. The impersonation cases — a worker
    // claiming a user turn — are in authority.test.ts.
    const outcome = await ownerAuthority(core).request(call({ kind: 'agent_step' }))

    expect(outcome.status).toBe('denied')
    expect(core.status().sessionUsage.calls).toBe(0)
  })

  it('spends nothing on a background request the grant does not cover', async () => {
    core = createCore(options())
    await core.start()
    await grant(core, { backgroundAllowed: false })

    const outcome = await ownerAuthority(core).request(
      call({ kind: 'scheduled_task' }),
    )

    expect(outcome.status).toBe('denied')
    expect(core.status().sessionUsage.calls).toBe(0)
  })

  it('allows a granted request and records the call durably', async () => {
    core = createCore(options())
    await core.start()
    await grant(core)

    const outcome = await ownerAuthority(core).request(
      call({ kind: 'agent_step' }),
    )

    expect(outcome.status).toBe('allowed')
    expect(core.status().sessionUsage.calls).toBe(1)
    expect(core.status().durableUsage.calls).toBe(1)
  })

  it('stops at the grant ceiling rather than spending beyond it', async () => {
    core = createCore(options())
    await core.start()
    await grant(core, { maxCalls: 2 })

    const granted = call({ kind: 'agent_step' })
    expect((await ownerAuthority(core).request({ ...granted, cognitionRequestId: 'a' })).status).toBe('allowed')
    expect((await ownerAuthority(core).request({ ...granted, cognitionRequestId: 'b' })).status).toBe('allowed')
    const third = await ownerAuthority(core).request({ ...granted, cognitionRequestId: 'c' })

    expect(third.status).toBe('denied')
    expect(core.status().sessionUsage.calls).toBe(2)
  })

  it('keeps a spent call spent when the provider fails', async () => {
    const failing = new FailingModelProvider()
    const c = createCore(options({ providers: [failing] }))
    await c.start()
    await grant(c, { maxCalls: 1 })

    const outcome = await ownerAuthority(c).request(
      call({ kind: 'agent_step' }),
    )
    expect(outcome.status).toBe('failed')
    expect(failing.calls).toBe(1)

    // The allowance is spent at authorisation, so a failure does not refund it.
    await c.stop('test')
    const fresh = createCore(options())
    await fresh.start()
    core = fresh
    const recovered = ownerAuthority(fresh).grants().find((g) => g.id === 'grant-1')
    expect(recovered?.usage.calls).toBe(1)
  })

  it('contains a provider failure without taking Core down', async () => {
    const failing = new FailingModelProvider()
    const c = createCore(options({ providers: [failing] }))
    await c.start()
    await grant(c, { maxCalls: 5 })

    const outcome = await ownerAuthority(c).request(
      call({ kind: 'agent_step' }),
    )

    expect(outcome.status).toBe('failed')
    expect(c.lifecycle).toBe('ready')
    // One attempt, no retry.
    expect(failing.calls).toBe(1)
    core = c
  })

  it('does not route to a provider that reports itself faulted', async () => {
    const faulted = new FaultedModelProvider()
    const c = createCore(options({ providers: [faulted] }))
    await c.start()
    await grant(c, { maxCalls: 3 })

    const outcome = await ownerAuthority(c).request(
      call({ kind: 'agent_step' }),
    )

    // Declining to route is different from routing and failing; neither spends.
    expect(outcome.status).toBe('failed')
    expect(faulted.calls).toBe(0)
    expect(c.lifecycle).toBe('ready')
    core = c
  })

  it('rejects a grant that could never be spent', async () => {
    core = createCore(options())
    await core.start()
    await expect(grant(core, { maxCalls: 0 })).rejects.toThrow()
    await expect(grant(core, { maxCalls: 1.5 })).rejects.toThrow()
    await expect(grant(core, { maxCalls: 1, maxOutputTokens: 0 })).rejects.toThrow()
    await expect(
      grant(core, { expiresAt: new Date(Date.now() - 1_000).toISOString() }),
    ).rejects.toThrow()
    expect(ownerAuthority(core).grants()).toHaveLength(0)
  })
})

describe('durable recovery', () => {
  it('carries the grant budget across a restart', async () => {
    const first = createCore(options())
    await first.start()
    await grant(first, { maxCalls: 2 })
    const req = call({ kind: 'agent_step' })
    await ownerAuthority(first).request({ ...req, cognitionRequestId: 'a' })
    await first.stop('test')

    const second = createCore(options())
    await second.start()
    core = second

    const recovered = ownerAuthority(second).grants().find((g) => g.id === 'grant-1')
    expect(recovered?.usage.calls).toBe(1)
    expect(recovered?.maxCalls).toBe(2)
    // The remaining call is available; the spent one is not refunded.
    expect((await ownerAuthority(second).request({ ...req, cognitionRequestId: 'b' })).status).toBe('allowed')
    expect((await ownerAuthority(second).request({ ...req, cognitionRequestId: 'c' })).status).toBe('denied')
  })

  it('restores a durable call total that includes calls from earlier sessions', async () => {
    const first = createCore(options())
    await first.start()
    await grant(first)
    await ownerAuthority(first).request(
      call({ kind: 'agent_step' }),
    )
    await first.stop('test')

    const second = createCore(options())
    await second.start()
    core = second

    expect(second.status().sessionUsage.calls).toBe(0)
    expect(second.status().durableUsage.calls).toBe(1)
  })
})

describe('STOP ALL', () => {
  it('refuses cognition while latched and recovers the latch after a restart', async () => {
    const first = createCore(options())
    await first.start()
    await grant(first)

    const stop = await first.handleCommand({ command: 'security.stopAll', requestId: 's1' })
    expect(stop.ok).toBe(true)
    expect(stop.durableSequence).toBeGreaterThan(0)

    const before = first.status().sessionUsage.calls
    const refused = await ownerAuthority(first).request(
      call({ kind: 'agent_step' }),
    )
    expect(refused.status).toBe('denied')
    expect(first.status().sessionUsage.calls).toBe(before)
    await first.stop('test')

    // The latch is derived from the log, so a restart cannot quietly reopen it.
    const second = createCore(options())
    await second.start()
    core = second
    expect(second.status().stopAll.active).toBe(true)
    expect(second.status().governor.status).toBe('deny_all')
    expect(
      (await ownerAuthority(second).request(
        call({ kind: 'agent_step' }),
      )).status,
    ).toBe('denied')

    const resume = await second.handleCommand({ command: 'security.resume', requestId: 's2' })
    expect(resume.ok).toBe(true)
    expect(second.status().stopAll.active).toBe(false)
  })
})

describe('command surface', () => {
  it('records an owner command durably and reports the sequence', async () => {
    core = createCore(options())
    await core.start()

    const result = await core.handleCommand({
      command: 'core.command.submit',
      requestId: 'c1',
      payload: { text: 'build the thing' },
    })

    expect(result.ok).toBe(true)
    expect(result.durableSequence).toBeGreaterThan(0)
    // The status is real, not a local optimistic value.
    expect(result.status?.lifecycle).toBe('ready')
  })

  it('refuses a malformed command rather than guessing', async () => {
    core = createCore(options())
    await core.start()
    const status = await core.start()

    await expect(
      core.handleCommand({ command: 'core.command.submit', requestId: 'c1', payload: {} }),
    ).resolves.toMatchObject({ ok: false, refusal: expect.objectContaining({ reason: expect.any(String) }) })
    await expect(
      core.handleCommand({ command: 'core.command.submit', requestId: 'c1', payload: { text: 'x'.repeat(4001) } }),
    ).resolves.toMatchObject({ ok: false })
    await expect(
      core.handleCommand({ command: 'nope.nope' as never, requestId: 'c1' }),
    ).resolves.toMatchObject({ ok: false })
    await expect(
      core.handleCommand({ command: 'core.status.read', requestId: '' }),
    ).resolves.toMatchObject({ ok: false })
    expect(status.durableUsage.calls).toBe(0)
  })

  it('never lets a status read or a subscription spend anything', async () => {
    core = createCore(options())
    await core.start()
    const before = core.status().durableUsage.calls

    const seen: CoreStatus[] = []
    const dispose = core.subscribe((s) => seen.push(s))
    for (let i = 0; i < 20; i += 1) {
      await core.handleCommand({ command: 'core.status.read', requestId: `r${i}` })
      core.status()
    }
    dispose()

    expect(seen.length).toBeGreaterThan(0)
    expect(core.status().durableUsage.calls).toBe(before)
    expect(core.status().sessionUsage.calls).toBe(0)
  })
})

describe('providers', () => {
  it('reports the echo provider honestly when a developer opts in', async () => {
    core = createCore(options({ providers: undefined, developerProvider: 'echo', env: {} }))
    await core.start()
    const providers = core.status().providers
    const fake = providers.find((p) => p.id === 'fake')
    const nano = providers.find((p) => p.id === 'nanogpt')
    // A local fake is never a live external call, even when it is the one selected.
    expect(fake?.liveEnabled).toBe(false)
    expect(nano?.status).toBe('unconfigured')
    expect(nano?.liveEnabled).toBe(false)
    expect(JSON.stringify(core.status())).not.toMatch(/apiKey|authorization|bearer/i)
  })

  it('keeps a configured nanogpt provider disabled without the explicit live flag', async () => {
    core = createCore(
      options({
        providers: undefined,
        env: {
          NANOGPT_API_KEY: 'secret-value',
          NANOGPT_BASE_URL: 'https://example.invalid',
          NANOGPT_MODEL: 'some-model',
        },
      }),
    )
    await core.start()
    const nano = core.status().providers.find((p) => p.id === 'nanogpt')
    expect(nano?.status).toBe('disabled')
    expect(nano?.model).toBe('some-model')
    expect(JSON.stringify(core.status())).not.toContain('secret-value')
  })

  it('registers no provider at all when nothing is configured', async () => {
    // The production default with no credentials: NanoGPT, unconfigured, and
    // no echo provider waiting behind it.
    core = createCore(options({ providers: undefined, env: {} }))
    await core.start()
    const providers = core.status().providers
    expect(providers.map((p) => p.id)).toEqual(['nanogpt'])
    expect(providers[0]?.status).toBe('unconfigured')
    expect(providers.some((p) => p.id === 'fake')).toBe(false)
  })

  it('reports an unserviceable request rather than falling back to an echo', async () => {
    core = createCore(options({ providers: undefined, env: {} }))
    await core.start()

    const outcome = await ownerAuthority(core).request(call())

    // An owner turn is authorised without a grant, so the refusal here is not a
    // policy one: there is simply nothing configured that could answer. Saying
    // "denied" would blame the wrong thing, and returning the prompt back would
    // be worse.
    expect(outcome.status).toBe('failed')
    expect(outcome.status === 'failed' && outcome.reason).toMatch(/no configured provider/i)
    // No provider was constructed, let alone called.
    expect(core.status().sessionUsage.calls).toBe(0)
  })

  it('does not call a live provider during start, replay or status reads', async () => {
    const fake = new FakeModelProvider()
    const c = createCore(options())
    await c.start()
    await c.status()
    await c.stop('test')
    expect(fake.calls).toBe(0)
  })
})

describe('the output token budget', () => {
  /**
   * These are service-level tests on purpose. A Governor test proves the rule;
   * it does not prove that the service reserves before spending, which is the
   * part that can silently be skipped.
   */

  const agentCall = (id: string, tokens: number) =>
    call({
      cognitionRequestId: id,
      correlationId: id,
      kind: 'agent_step',
      maxOutputTokens: tokens,
    })

  it('reserves the requested allowance before the provider is called', async () => {
    const fake = new FakeModelProvider()
    core = createCore(options({ providers: [fake] }))
    await core.start()
    await grant(core, { maxCalls: 5, maxOutputTokens: 1000 })

    // At the moment the provider runs, the durable reservation already exists.
    let reservedWhenCalled: number | null = null
    const original = fake.complete.bind(fake)
    ;(fake as unknown as { complete: typeof original }).complete = async (req, options) => {
      reservedWhenCalled = ownerAuthority(core!).grants()[0]?.usage.outputTokenBudgetReserved ?? null
      return original(req, options)
    }

    await ownerAuthority(core).request(agentCall('a', 300))

    expect(reservedWhenCalled).toBe(300)
    expect(ownerAuthority(core).grants()[0]?.usage.outputTokenBudgetReserved).toBe(300)
  })

  it('exhausts the token budget across repeated real requests', async () => {
    core = createCore(options())
    await core.start()
    // A call budget that will not be what stops us: 10 calls allowed, 1000
    // output tokens, and every request asks for 300.
    await grant(core, { maxCalls: 10, maxOutputTokens: 1000 })

    for (const id of ['a', 'b', 'c']) {
      expect((await ownerAuthority(core).request(agentCall(id, 300))).status).toBe('allowed')
    }
    // 900 of 1000 reserved. A fourth 300-token request does not fit.
    const denied = await ownerAuthority(core).request(agentCall('d', 300))
    expect(denied.status).toBe('denied')
    expect(ownerAuthority(core).grants()[0]?.usage.calls).toBe(3)
    expect(ownerAuthority(core).grants()[0]?.usage.outputTokenBudgetReserved).toBe(900)

    // A smaller request still fits in what is left.
    expect((await ownerAuthority(core).request(agentCall('e', 100))).status).toBe('allowed')
    expect(ownerAuthority(core).grants()[0]?.usage.outputTokenBudgetReserved).toBe(1000)
    expect((await ownerAuthority(core).request(agentCall('f', 1))).status).toBe('denied')
  })

  it('does not refund the reservation when the provider reports less', async () => {
    const fake = new FakeModelProvider()
    core = createCore(options({ providers: [fake] }))
    await core.start()
    await grant(core, { maxCalls: 10, maxOutputTokens: 1000 })

    await ownerAuthority(core).request(agentCall('a', 400))
    // The fake reports a small figure. The budget still shows 400 reserved:
    // usage is a report, not a correction.
    expect(fake.lastUsage).not.toBeNull()
    expect(ownerAuthority(core).grants()[0]?.usage.outputTokenBudgetReserved).toBe(400)
    expect(ownerAuthority(core).grants()[0]?.usage.outputTokens).not.toBeNull()
  })

  it('keeps charging a provider that reports no usage at all', async () => {
    const silent = new SilentModelProvider()
    core = createCore(options({ providers: [silent] }))
    await core.start()
    await grant(core, { maxCalls: 10, maxOutputTokens: 1000 })

    for (const id of ['a', 'b', 'c']) {
      expect((await ownerAuthority(core).request(agentCall(id, 300))).status).toBe('allowed')
    }
    // Unknown usage must not read as free. The reservation is what moved.
    expect(ownerAuthority(core).grants()[0]?.usage.outputTokenBudgetReserved).toBe(900)
    expect(ownerAuthority(core).grants()[0]?.usage.outputTokens).toBeNull()
    expect((await ownerAuthority(core).request(agentCall('d', 300))).status).toBe('denied')
  })

  it('keeps the reservation when the provider fails', async () => {
    const failing = new FailingModelProvider()
    core = createCore(options({ providers: [failing] }))
    await core.start()
    await grant(core, { maxCalls: 10, maxOutputTokens: 1000 })

    const outcome = await ownerAuthority(core).request(agentCall('a', 400))
    expect(outcome.status).toBe('failed')
    // The call never produced anything, and the allowance is still spent.
    expect(ownerAuthority(core).grants()[0]?.usage.outputTokenBudgetReserved).toBe(400)
    expect(ownerAuthority(core).grants()[0]?.usage.calls).toBe(1)
  })

  it('carries the reserved budget across a restart', async () => {
    const first = createCore(options())
    await first.start()
    await grant(first, { maxCalls: 10, maxOutputTokens: 1000 })
    for (const id of ['a', 'b']) {
      await ownerAuthority(first).request(agentCall(id, 300))
    }
    await first.stop('test')

    const second = createCore(options())
    await second.start()
    core = second

    const recovered = ownerAuthority(second).grants().find((g) => g.id === 'grant-1')
    expect(recovered?.usage.outputTokenBudgetReserved).toBe(600)
    expect(recovered?.usage.calls).toBe(2)

    // 400 left. One more 300 fits; the one after does not.
    expect((await ownerAuthority(second).request(agentCall('c', 300))).status).toBe('allowed')
    expect((await ownerAuthority(second).request(agentCall('d', 300))).status).toBe('denied')
  })

  it('charges a crashed Core for the call it never completed', async () => {
    // A provider that never answers. The reservation is durable before the call
    // goes out, so a process that dies mid-flight still spent it.
    const hanging = new HangingModelProvider()
    const first = createCore(options({ providers: [hanging] }))
    await first.start()
    await grant(first, { maxCalls: 10, maxOutputTokens: 1000 })

    void ownerAuthority(first).request(agentCall('a', 500)).catch(() => undefined)
    // Let the reservation land, then walk away without stopping cleanly.
    await new Promise((resolve) => setTimeout(resolve, 60))
    await first.stop('killed mid-flight')

    const second = createCore(options())
    await second.start()
    core = second
    const recovered = ownerAuthority(second).grants().find((g) => g.id === 'grant-1')
    expect(recovered?.usage.outputTokenBudgetReserved).toBe(500)
  })
})

describe('the command journal', () => {
  it('records that a command arrived without recording what it said', async () => {
    core = createCore(options())
    await core.start()
    const path = join(dir, 'events.jsonl')
    const secret = 'my bank password is hunter2 and my github token is ghp_abcdef'

    const result = await core.handleCommand({
      command: 'core.command.submit',
      requestId: 'c1',
      payload: { text: secret, origin: 'command-bar' },
    })
    expect(result.ok).toBe(true)

    // The file on disk, not a projection of it.
    const raw = await readFile(path, 'utf8')
    expect(raw).not.toContain('hunter2')
    expect(raw).not.toContain('ghp_abcdef')
    expect(raw).not.toContain('bank password')
    expect(raw).toContain('command.received')

    // What is there is metadata a person can act on.
    const received = raw
      .split('\n')
      .filter((line) => line.includes('command.received'))
      .map((line) => JSON.parse(line) as { payload: Record<string, unknown> })
    expect(received).toHaveLength(1)
    expect(received[0]?.payload).toMatchObject({
      contentLength: secret.length,
      source: 'command-bar',
    })
    expect(received[0]?.payload).not.toHaveProperty('text')
  })

  it('keeps command text out of every state projection too', async () => {
    core = createCore(options())
    await core.start()
    await core.handleCommand({
      command: 'core.command.submit',
      requestId: 'c1',
      payload: { text: 'a secret plan', origin: 'command-bar' },
    })
    expect(JSON.stringify(core.status())).not.toContain('a secret plan')
  })
})
