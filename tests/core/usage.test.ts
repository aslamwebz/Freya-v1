// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore, type Core, type CoreOptions } from '../../core/index'
import { ownerAuthority, workerAuthority } from '../../core/testing'
import { accumulateUsage, accumulateReported, emptyUsage } from '../../core/model/usage'
import { FakeModelProvider, SilentModelProvider } from '../../core/model/fake-provider'
import type { ModelProvider, ModelRequest, ModelResult } from '../../core/model/provider'
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

  async complete(_request: ModelRequest): Promise<ModelResult> {
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
})
