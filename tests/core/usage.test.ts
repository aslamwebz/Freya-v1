// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore, type Core, type CoreOptions } from '../../core/index'
import { ownerAuthority, workerAuthority } from '../../core/testing'
import { accumulateUsage, accumulateReported, emptyUsage } from '../../core/model/usage'
import {
  FailingModelProvider,
  FakeModelProvider,
  FaultedModelProvider,
  SilentModelProvider,
} from '../../core/model/fake-provider'
import type { ModelCallOptions, ModelProvider, ModelRequest, ModelResult } from '../../core/model/provider'
import type { ProviderStatus } from '../../core/protocol/core-protocol'

/**
 * Usage accounting, in every order it can happen in.
 *
 * The bug this covers: a report *replaced* the running total with one call's
 * figures, so two calls that each reported 12 tokens showed 12 rather than 24,
 * and a call that reported nothing set the total to null, discarding everything
 * that had been accounted for before it.
 *
 * The other half is what must *not* happen: an unreported call must never be
 * treated as a free one, and the authorisation budget must stay independent of
 * anything a provider says.
 */

let dir = ''
let core: Core | null = null

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-usage-'))
})

afterEach(async () => {
  await core?.stop('test-teardown')
  core = null
  await rm(dir, { recursive: true, force: true })
})

function options(over: Partial<CoreOptions> = {}): CoreOptions {
  return { dataPath: join(dir, 'events.jsonl'), ...over }
}

async function started(over: Partial<CoreOptions> = {}): Promise<Core> {
  core = createCore(options(over))
  await core.start()
  return core
}

const step = (id: string, tokens: number) => ({
  kind: 'agent_step' as const,
  cognitionRequestId: id,
  correlationId: id,
  maxOutputTokens: tokens,
  prompt: 'work',
})

/** A provider whose reported figures are scripted, call by call. */
class ScriptedProvider implements ModelProvider {
  readonly id = 'scripted'
  readonly kind = 'fake' as const
  readonly live = false
  calls = 0
  constructor(private readonly script: (number | null)[]) {}

  status(): ProviderStatus {
    return {
      id: this.id,
      kind: this.kind,
      status: 'configured',
      model: 'scripted-model',
      detail: 'Reports whatever the test told it to.',
      liveEnabled: false,
    }
  }

  async complete(_request: ModelRequest, _options: ModelCallOptions): Promise<ModelResult> {
    const reported = this.script[this.calls] ?? null
    this.calls += 1
    return {
      requestId: _request.requestId,
      providerId: this.id,
      model: 'scripted-model',
      text: 'ok',
      inputTokens: reported,
      outputTokens: reported,
    }
  }
}

async function withGrant(c: Core, over: Partial<Parameters<ReturnType<typeof ownerAuthority>['createGrant']>[0]> = {}) {
  return ownerAuthority(c).createGrant({
    grantId: 'g1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    allowedOrigins: ['agent'],
    allowedCauses: ['run_finished'],
    backgroundAllowed: true,
    maxCalls: 20,
    maxOutputTokens: 100_000,
    ...over,
  })
}

describe('the accumulator itself', () => {
  it('adds reported figures rather than replacing the total', () => {
    let usage = emptyUsage()
    usage = accumulateUsage(usage, { inputTokens: 10, outputTokens: 4 })
    usage = accumulateUsage(usage, { inputTokens: 10, outputTokens: 4 })
    expect(usage).toMatchObject({ inputTokens: 20, outputTokens: 8, unknownUsageCalls: 0 })
  })

  it('records an unreported call as unknown rather than as zero', () => {
    let usage = emptyUsage()
    usage = accumulateUsage(usage, { inputTokens: 10, outputTokens: 4 })
    usage = accumulateUsage(usage, { inputTokens: null, outputTokens: null })
    // The known figure survives; the gap is declared.
    expect(usage).toMatchObject({ inputTokens: 10, outputTokens: 4, unknownUsageCalls: 1 })
  })

  it('treats a partially reported call as unknown', () => {
    const usage = accumulateUsage(emptyUsage(), { inputTokens: 10, outputTokens: null })
    expect(usage.unknownUsageCalls).toBe(1)
  })

  it('leaves an untouched field alone when accumulating a report', () => {
    const grantish = { calls: 3, outputTokenBudgetReserved: 900, inputTokens: null, outputTokens: null, unknownUsageCalls: 0 }
    const after = accumulateReported(grantish, { inputTokens: 5, outputTokens: 2 })
    // The budget is authorisation arithmetic and must not move because a
    // provider said something.
    expect(after.outputTokenBudgetReserved).toBe(900)
    expect(after.calls).toBe(3)
    expect(after).toMatchObject({ inputTokens: 5, outputTokens: 2, unknownUsageCalls: 0 })
  })
})

describe('two calls with reported usage', () => {
  it('sums the grant and the global totals', async () => {
    const c = await started({ providers: [new ScriptedProvider([10, 20])] })
    await withGrant(c)

    await workerAuthority(c).request(step('a', 100))
    await workerAuthority(c).request(step('b', 100))

    const usage = ownerAuthority(c).grants()[0]?.usage
    expect(usage).toMatchObject({
      calls: 2,
      inputTokens: 30,
      outputTokens: 30,
      unknownUsageCalls: 0,
    })
    expect(c.status().durableUsage).toMatchObject({
      calls: 2,
      inputTokens: 30,
      outputTokens: 30,
      unknownUsageCalls: 0,
    })
  })
})

describe('reported then unreported', () => {
  it('keeps the known figure and counts the gap', async () => {
    const c = await started({ providers: [new ScriptedProvider([10, null])] })
    await withGrant(c)

    await workerAuthority(c).request(step('a', 100))
    await workerAuthority(c).request(step('b', 100))

    // The second call reported nothing. That must not erase the first, and must
    // not be read as a call that cost nothing.
    expect(ownerAuthority(c).grants()[0]?.usage).toMatchObject({
      calls: 2,
      inputTokens: 10,
      outputTokens: 10,
      unknownUsageCalls: 1,
    })
    expect(c.status().durableUsage).toMatchObject({ inputTokens: 10, unknownUsageCalls: 1 })
  })
})

describe('unreported then reported', () => {
  it('does not start from null once a figure finally arrives', async () => {
    const c = await started({ providers: [new ScriptedProvider([null, 20])] })
    await withGrant(c)

    await workerAuthority(c).request(step('a', 100))
    await workerAuthority(c).request(step('b', 100))

    expect(ownerAuthority(c).grants()[0]?.usage).toMatchObject({
      calls: 2,
      // The unknown call is still unknown; the reported one is counted on top of
      // what is known rather than resetting the record to null.
      inputTokens: 20,
      outputTokens: 20,
      unknownUsageCalls: 1,
    })
  })

  it('marks the durable total a lower bound by counting the gap', async () => {
    const c = await started({ providers: [new ScriptedProvider([null, 20])] })
    await withGrant(c)
    await workerAuthority(c).request(step('a', 100))
    await workerAuthority(c).request(step('b', 100))

    const durable = c.status().durableUsage
    expect(durable.inputTokens).toBe(20)
    // This is the signal a caller must check before presenting a total as exact.
    expect(durable.unknownUsageCalls).toBe(1)
  })
})

describe('a provider that never reports at all', () => {
  it('counts every call as unknown and reports no total', async () => {
    const c = await started({ providers: [new SilentModelProvider()] })
    await withGrant(c)
    await workerAuthority(c).request(step('a', 100))
    await workerAuthority(c).request(step('b', 100))

    const usage = ownerAuthority(c).grants()[0]?.usage
    expect(usage).toMatchObject({ calls: 2, inputTokens: null, outputTokens: null, unknownUsageCalls: 2 })
    expect(c.status().durableUsage).toMatchObject({
      calls: 2,
      inputTokens: null,
      outputTokens: null,
      unknownUsageCalls: 2,
    })
  })
})

describe('restart and replay', () => {
  it('rebuilds both totals from the log', async () => {
    const first = await started({ providers: [new ScriptedProvider([10, 20])] })
    await withGrant(first)
    await workerAuthority(first).request(step('a', 100))
    await workerAuthority(first).request(step('b', 100))
    await first.stop('test')

    const second = await started({ providers: [new FakeModelProvider()] })
    const usage = ownerAuthority(second).grants()[0]?.usage
    expect(usage).toMatchObject({ calls: 2, inputTokens: 30, outputTokens: 30, unknownUsageCalls: 0 })
    // The durable total is replayed, not re-counted from this session.
    expect(second.status().durableUsage).toMatchObject({ calls: 2, inputTokens: 30, unknownUsageCalls: 0 })
    // And the session counter starts empty, because this Core made no calls.
    expect(second.status().sessionUsage.calls).toBe(0)
  })

  it('preserves an unknown call across a restart', async () => {
    const first = await started({ providers: [new ScriptedProvider([10, null])] })
    await withGrant(first)
    await workerAuthority(first).request(step('a', 100))
    await workerAuthority(first).request(step('b', 100))
    await first.stop('test')

    const second = await started()
    expect(ownerAuthority(second).grants()[0]?.usage).toMatchObject({
      inputTokens: 10,
      unknownUsageCalls: 1,
    })
  })
})

describe('the budget is independent of what a provider reports', () => {
  it('charges the reserved allowance whether or not usage is reported', async () => {
    const c = await started({ providers: [new ScriptedProvider([1, 2])] })
    await withGrant(c, { maxOutputTokens: 1000 })

    await workerAuthority(c).request(step('a', 300))
    await workerAuthority(c).request(step('b', 300))

    const usage = ownerAuthority(c).grants()[0]?.usage
    // Three tokens reported in total, and that has no bearing whatsoever on the
    // 600-token allowance that was reserved. A provider saying "I used one" does
    // not buy back the 300 it was authorised to use.
    expect(usage).toMatchObject({ outputTokens: 3, outputTokenBudgetReserved: 600, calls: 2 })
  })

  it('a provider reporting nothing cannot refund the reservation', async () => {
    const c = await started({ providers: [new SilentModelProvider()] })
    await withGrant(c, { maxCalls: 10, maxOutputTokens: 1000 })
    await workerAuthority(c).request(step('a', 600))
    expect(ownerAuthority(c).grants()[0]?.usage).toMatchObject({
      outputTokenBudgetReserved: 600,
      inputTokens: null,
      unknownUsageCalls: 1,
    })
    // 400 left, so a second 600 does not fit.
    expect((await workerAuthority(c).request(step('b', 600))).status).toBe('denied')
  })

describe('a failed provider attempt has unknown usage', () => {
  /**
   * The rule this covers: reaching a provider may cost money whether or not it
   * answers. `calls` alone said one thing happened, and `unknownUsageCalls` said
   * nothing had been left unaccounted — so a timeout was recorded as free.
   *
   * The distinction that matters is *contacted* versus *never contacted*, and it
   * is carried explicitly by the provider events. Nothing here infers it from
   * a provider's name.
   */
  it('counts nothing at all when no provider was ever selected', async () => {
    // Reports itself unusable, so the gateway declines to route to it. The
    // provider is never contacted, so nothing was spent.
    const faulted = new FaultedModelProvider()
    const c = await started({ providers: [faulted] })
    // A grant, so the request is authorised and genuinely reaches the gateway —
    // otherwise it would be denied before a provider was ever considered.
    await withGrant(c)

    const outcome = await workerAuthority(c).request(step('a', 100))
    expect(outcome.status).toBe('failed')

    expect(c.status().sessionUsage.calls).toBe(0)
    expect(c.status().sessionUsage.unknownUsageCalls).toBe(0)
    expect(c.status().durableUsage.calls).toBe(0)
    expect(c.status().durableUsage.unknownUsageCalls).toBe(0)
    // Never actually called.
    expect(faulted.calls).toBe(0)

    // The grant's provider usage must not record a gap either. Declaring
    // `unknown` here would claim something might have been spent when no
    // provider was ever reached, so nothing can have been.
    const grant = ownerAuthority(c).grants().find((g) => g.id === 'g1')
    expect(grant?.usage.calls).toBe(1)
    expect(grant?.usage.unknownUsageCalls).toBe(0)
    expect(grant?.usage.inputTokens).toBeNull()
    expect(grant?.usage.outputTokens).toBeNull()
    // The authorisation reservation is spent regardless — it is charged before
    // the provider is ever consulted, and a failure is not a refund.
    expect(grant?.usage.outputTokenBudgetReserved).toBe(100)
  })

  it('counts a call and an unknown when the provider throws', async () => {
    const failing = new FailingModelProvider()
    const c = await started({ providers: [failing] })
    await withGrant(c)

    const outcome = await workerAuthority(c).request(step('a', 100))
    expect(outcome.status).toBe('failed')
    expect(failing.calls).toBe(1)

    // Reached, then failed. One call, and its usage is a declared gap.
    expect(c.status().sessionUsage.calls).toBe(1)
    expect(c.status().sessionUsage.unknownUsageCalls).toBe(1)
    expect(c.status().durableUsage.calls).toBe(1)
    expect(c.status().durableUsage.unknownUsageCalls).toBe(1)
  })

  it('counts a call and an unknown when the provider fails after starting work', async () => {
    // A provider that consumed inference and then died mid-stream: the worst
    // case, because work definitely happened and definitely cannot be counted.
    class DiedMidStreamProvider implements ModelProvider {
      readonly id = 'died-mid-stream'
      readonly kind = 'fake' as const
      readonly live = false
      calls = 0

      status(): ProviderStatus {
        return {
          id: this.id,
          kind: this.kind,
          status: 'configured',
          model: 'died-mid-stream-model',
          detail: 'Fails after beginning to answer.',
          liveEnabled: false,
        }
      }

      async complete(_request: ModelRequest, _options: ModelCallOptions): Promise<ModelResult> {
        this.calls += 1
        throw new Error('connection reset after the first tokens')
      }
    }

    const provider = new DiedMidStreamProvider()
    const c = await started({ providers: [provider] })
    await withGrant(c)

    expect((await workerAuthority(c).request(step('a', 100))).status).toBe('failed')

    expect(c.status().sessionUsage.calls).toBe(1)
    expect(c.status().sessionUsage.unknownUsageCalls).toBe(1)
    expect(c.status().durableUsage.calls).toBe(1)
    expect(c.status().durableUsage.unknownUsageCalls).toBe(1)
  })

  it('records unknown usage against the grant, without refunding the budget', async () => {
    const failing = new FailingModelProvider()
    const c = await started({ providers: [failing] })
    await withGrant(c)

    expect((await workerAuthority(c).request(step('a', 200))).status).toBe('failed')

    const grant = ownerAuthority(c).grants().find((g) => g.id === 'g1')
    expect(grant?.usage.calls).toBe(1)
    expect(grant?.usage.unknownUsageCalls).toBe(1)
    expect(grant?.usage.inputTokens).toBeNull()
    expect(grant?.usage.outputTokens).toBeNull()
    // The reservation is authorisation, and it stays spent whatever the
    // provider did. A failure does not hand the allowance back.
    expect(grant?.usage.outputTokenBudgetReserved).toBe(200)
  })

  it('survives a restart, so the unknown usage is not forgotten', async () => {
    const failing = new FailingModelProvider()
    const c = await started({ providers: [failing] })
    await withGrant(c)
    expect((await workerAuthority(c).request(step('a', 200))).status).toBe('failed')
    await c.stop('test')

    const fresh = createCore(options({ providers: [new FakeModelProvider()] }))
    await fresh.start()
    core = fresh

    const usage = fresh.status().durableUsage
    expect(usage.calls).toBe(1)
    expect(usage.unknownUsageCalls).toBe(1)

    // The grant's declared gap is durable too.
    const grant = ownerAuthority(fresh).grants().find((g) => g.id === 'g1')
    expect(grant?.usage.calls).toBe(1)
    expect(grant?.usage.unknownUsageCalls).toBe(1)
  })

  it('adds known totals and an unknown when one call succeeds and one fails', async () => {
    class MixedProvider implements ModelProvider {
      readonly id = 'mixed'
      readonly kind = 'fake' as const
      readonly live = false
      calls = 0

      status(): ProviderStatus {
        return {
          id: this.id,
          kind: this.kind,
          status: 'configured',
          model: 'mixed-model',
          detail: 'Answers once, then fails.',
          liveEnabled: false,
        }
      }

      async complete(request: ModelRequest, _options: ModelCallOptions): Promise<ModelResult> {
        this.calls += 1
        if (this.calls === 1) {
          return {
            requestId: request.requestId,
            providerId: this.id,
            model: 'mixed-model',
            text: 'ok',
            inputTokens: 10,
            outputTokens: 20,
          }
        }
        throw new Error('timeout')
      }
    }

    const provider = new MixedProvider()
    const c = await started({ providers: [provider] })
    await withGrant(c)

    expect((await workerAuthority(c).request(step('a', 100))).status).toBe('allowed')
    expect((await workerAuthority(c).request(step('b', 100))).status).toBe('failed')

    // Two calls. One accounted for, one not.
    expect(c.status().sessionUsage.calls).toBe(2)
    expect(c.status().sessionUsage.inputTokens).toBe(10)
    expect(c.status().sessionUsage.outputTokens).toBe(20)
    expect(c.status().sessionUsage.unknownUsageCalls).toBe(1)

    const grant = ownerAuthority(c).grants().find((g) => g.id === 'g1')
    expect(grant?.usage.calls).toBe(2)
    expect(grant?.usage.outputTokens).toBe(20)
    expect(grant?.usage.unknownUsageCalls).toBe(1)
    // Both reservations spent, whatever the second one did.
    expect(grant?.usage.outputTokenBudgetReserved).toBe(200)
  })

  it('keeps a fully reported call free of unknowns', async () => {
    const c = await started({ providers: [new ScriptedProvider([10, 20])] })
    await withGrant(c)
    await workerAuthority(c).request(step('a', 100))
    await workerAuthority(c).request(step('b', 100))

    expect(c.status().sessionUsage.calls).toBe(2)
    expect(c.status().sessionUsage.inputTokens).toBe(30)
    expect(c.status().sessionUsage.outputTokens).toBe(30)
    expect(c.status().sessionUsage.unknownUsageCalls).toBe(0)
  })
})
})
