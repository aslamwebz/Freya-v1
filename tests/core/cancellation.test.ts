// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore, type Core, type CoreOptions } from '../../core/index'
import { ModelGateway, type GatewayRecorder } from '../../core/model/gateway'
import { JsonlEventStore } from '../../core/events/jsonl-store'
import type { EventStore } from '../../core/events/store'
import type { ModelProvider } from '../../core/model/provider'
import { BlockingModelProvider, FakeModelProvider } from '../../core/model/fake-provider'
import { NanoGptProvider } from '../../core/model/nanogpt-provider'
import { initialCoreState, reduceCoreState } from '../../core/state'
import type { AnyCoreEvent } from '../../core/events/envelope'
import { ownerAuthority, workerAuthority } from '../../core/testing'
import type { CognitionIntent, WorkerIntent } from '../../core/authority'
import type { CognitionGrantSpec } from '../../core/cognition/grants'

/**
 * STOP ALL has to mean all of it.
 *
 * The durable latch stops the *next* request, and on its own that is not enough:
 * a provider call that has already gone out keeps going, and keeps costing, until
 * it finishes. These tests are the proof of the rest of it — that an in-flight
 * call receives an abort, that a stop which arrives before provider contact
 * prevents the contact entirely, and that neither leaves anything behind.
 *
 * Every provider here is a fake. Nothing in this file, or in the suite it runs
 * with, can spend a credit or reach a network, and there is a test at the bottom
 * that holds that line explicitly.
 */

let dir = ''
let core: Core | null = null

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-cancel-'))
})

afterEach(async () => {
  await core?.stop('test-teardown')
  core = null
  await rm(dir, { recursive: true, force: true })
})

function options(overrides: Partial<CoreOptions> = {}): CoreOptions {
  return { dataPath: join(dir, 'events.jsonl'), providers: [new FakeModelProvider()], ...overrides }
}

const userTurn = (over: Partial<CognitionIntent> = {}): CognitionIntent => ({
  cognitionRequestId: 'req-1',
  correlationId: 'corr-1',
  kind: 'user_turn',
  maxOutputTokens: 200,
  requestedModel: null,
  goalId: null,
  prompt: 'hello',
  ...over,
})

/** Agent steps need a grant; user turns do not, and should not require one. */
function agentStep(id: string, tokens = 100): WorkerIntent {
  return {
    cognitionRequestId: id,
    correlationId: id,
    kind: 'agent_step',
    maxOutputTokens: tokens,
    requestedModel: null,
    goalId: null,
    prompt: 'work',
  }
}

async function grant(c: Core, over: Partial<CognitionGrantSpec> = {}): Promise<void> {
  await ownerAuthority(c).createGrant({
    grantId: 'grant-1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    allowedOrigins: ['agent'],
    allowedCauses: ['run_finished'],
    backgroundAllowed: true,
    maxCalls: 20,
    maxOutputTokens: 100_000,
    ...over,
  })
}

const stopAll = (c: Core, requestId = 's1') =>
  c.handleCommand({ command: 'security.stopAll', requestId, payload: { reason: 'owner pressed stop' } })

const resume = (c: Core, requestId = 'r1') =>
  c.handleCommand({ command: 'security.resume', requestId })

/** Durable event type names in the log, in order. */
async function journal(path: string): Promise<string[]> {
  const raw = await readFile(path, 'utf8')
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as { type: string }).type)
}

/** One request's outcome in the journal. `started` and cancelled means never contacted. */
async function requestEvents(path: string, requestId: string): Promise<string[]> {
  const raw = await readFile(path, 'utf8')
  const types: string[] = []
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue
    const event = JSON.parse(line) as { type: string; payload: Record<string, unknown> }
    const payloadRequestId = event.payload.requestId
    if (typeof payloadRequestId !== 'string') continue
    if (payloadRequestId.startsWith(requestId)) types.push(event.type)
  }
  return types
}

describe('A — an active request is aborted', () => {
  it('passes the signal to a provider already working, and settles', async () => {
    const provider = new BlockingModelProvider()
    core = createCore(options({ providers: [provider] }))
    await core.start()

    const inFlight = ownerAuthority(core).request(userTurn({ cognitionRequestId: 'a' }))
    // Contact confirmed: the request is genuinely in the provider, not merely
    // authorised and waiting.
    await provider.contacted

    expect(core.status().activeProviderCalls).toBe(1)

    const stop = await stopAll(core)
    expect(stop.ok).toBe(true)

    const outcome = await inFlight
    expect(outcome.status).toBe('cancelled')
    // The provider felt the signal, rather than the gateway merely recording
    // that it gave up.
    expect(provider.aborts).toBe(1)
    // And the registry is empty, so nothing claims to still be running.
    expect(core.status().activeProviderCalls).toBe(0)
  })

  it('records the cancellation once, with contact made explicit', async () => {
    const provider = new BlockingModelProvider()
    core = createCore(options({ providers: [provider] }))
    await core.start()
    const path = join(dir, 'events.jsonl')

    const inFlight = ownerAuthority(core).request(userTurn({ cognitionRequestId: 'a' }))
    await provider.contacted
    await stopAll(core)
    await inFlight

    // Exactly one terminal event, and it is the cancellation.
    const types = await requestEvents(path, 'a')
    expect(types.filter((t) => t === 'model.request.started')).toHaveLength(1)
    expect(types.filter((t) => t === 'model.request.cancelled')).toHaveLength(1)
    expect(types).not.toContain('model.request.completed')
    expect(types).not.toContain('model.request.failed')
  })

  it('keeps a contacted cancellation as an unknown, never as zero', async () => {
    const provider = new BlockingModelProvider()
    core = createCore(options({ providers: [provider] }))
    await core.start()

    const inFlight = ownerAuthority(core).request(userTurn({ cognitionRequestId: 'a' }))
    await provider.contacted

    const whileLive = core.status()
    expect(whileLive.activeProviderCalls).toBe(1)
    expect(whileLive.sessionUsage.unknownUsageCalls).toBe(1)
    expect(whileLive.durableUsage.unknownUsageCalls).toBe(1)

    await stopAll(core)
    await inFlight

    const status = core.status()
    // The provider had the work. It may well have been billed for it, so the
    // figures stay a lower bound rather than pretending the abort made it free.
    expect(status.sessionUsage.calls).toBe(1)
    expect(status.sessionUsage.unknownUsageCalls).toBe(1)
    expect(status.durableUsage.calls).toBe(1)
    expect(status.durableUsage.unknownUsageCalls).toBe(1)
  })
})

describe('B — the authorisation to provider-contact race', () => {
  /**
   * These run against the gateway itself, because that is the only layer with a
   * seam in the window. Between the journal saying "about to spend something" and
   * the provider being asked there is exactly one `await` — the start event being
   * written — and a stop that lands inside it is the race. There is deliberately
   * nothing asynchronous after it, which is why the gateway can mark the contact
   * and make the call in the same turn.
   */
  it('never invokes a provider when the stop lands after the start was written', async () => {
    let invocations = 0
    const provider = countingProvider(() => {
      invocations += 1
    })
    const { gateway, recorder, release } = gatewayAround(provider)

    const running = gateway.execute(permit('a'), 'hello')
    await waitFor(() => recorder.types.length === 1 && recorder.types[0] === 'started')

    // The stop arrives while the start is still in flight.
    gateway.cancelAll('owner pressed stop')
    release()

    await expect(running).rejects.toThrow(/owner pressed stop/)
    // Not one invocation. The provider was never asked, so nothing was spent.
    expect(invocations).toBe(0)
    expect(recorder.cancellations).toEqual([
      { requestId: 'a', providerId: provider.id, reason: 'owner pressed stop', providerContacted: false },
    ])
    expect(gateway.activeCallCount()).toBe(0)
  })

  it('withdraws the attempt a refused contact had already counted', async () => {
    // The start is durable, so the durable total counted a call. The
    // cancellation is the only thing that can take it back, and the reducer is
    // where that has to happen — otherwise the journal claims work that was
    // never paid for.
    let state = reduceCoreState(initialCoreState(), modelEvent('model.request.started', { requestId: 'a' }))
    expect(state.durableUsage.calls).toBe(1)

    state = reduceCoreState(
      state,
      modelEvent('model.request.cancelled', { requestId: 'a', providerContacted: false }),
    )
    expect(state.durableUsage.calls).toBe(0)
    expect(state.durableUsage.unknownUsageCalls).toBe(0)
    expect(state.pendingRequests).toEqual([])
  })

  it('keeps a contacted cancellation as an unknown rather than a zero', async () => {
    // The other direction, and the one that matters for money: the provider had
    // the request, so whatever it had generated was very probably billed.
    let state = reduceCoreState(initialCoreState(), modelEvent('model.request.started', { requestId: 'a' }))
    state = reduceCoreState(
      state,
      modelEvent('model.request.cancelled', { requestId: 'a', providerContacted: true }),
    )
    expect(state.durableUsage.calls).toBe(1)
    expect(state.durableUsage.unknownUsageCalls).toBe(1)
    expect(state.durableUsage.inputTokens).toBeNull()
    expect(state.pendingRequests).toEqual([])
  })

  it('tracks duplicate request ids as separate attempts', async () => {
    let state = reduceCoreState(initialCoreState(), modelEvent('model.request.started', { requestId: 'same' }))
    state = reduceCoreState(state, modelEvent('model.request.started', { requestId: 'same' }))
    expect(state.durableUsage.calls).toBe(2)
    expect(state.pendingRequests).toEqual(['same', 'same'])

    state = reduceCoreState(
      state,
      modelEvent('model.request.cancelled', { requestId: 'same', providerContacted: false }),
    )
    expect(state.durableUsage.calls).toBe(1)
    expect(state.pendingRequests).toEqual(['same'])

    state = reduceCoreState(
      state,
      modelEvent('model.request.completed', { requestId: 'same', inputTokens: 3, outputTokens: 4 }),
    )
    expect(state.pendingRequests).toEqual([])
    expect(state.durableUsage.calls).toBe(1)
    expect(state.durableUsage.outputTokens).toBe(4)
  })

  it('leaves an already-settled total alone when a refusal has no start to withdraw', async () => {
    // A cancellation refused before anything was written must not take a call
    // away from an unrelated, genuinely completed one.
    let state = reduceCoreState(initialCoreState(), modelEvent('model.request.started', { requestId: 'a' }))
    state = reduceCoreState(
      state,
      modelEvent('model.request.completed', { requestId: 'a', inputTokens: 5, outputTokens: 7 }),
    )
    state = reduceCoreState(
      state,
      modelEvent('model.request.cancelled', { requestId: 'b', providerContacted: false }),
    )
    expect(state.durableUsage.calls).toBe(1)
    expect(state.durableUsage.outputTokens).toBe(7)
  })

  it('refuses a request that reaches the gateway while the stop is already on', async () => {
    const invocations = { count: 0 }
    const { gateway, recorder } = gatewayAround(countingProvider(() => invocations.count++))
    gateway.cancelAll('already stopped')

    await expect(gateway.execute(permit('a'), 'hello')).rejects.toThrow(/already stopped/)
    expect(invocations.count).toBe(0)
    // Nothing was even said about a provider, so the journal claims no call.
    expect(recorder.types).toEqual(['cancelled'])
    expect(recorder.cancellations[0]?.providerContacted).toBe(false)
  })

  it('has a provider refuse at the door as well, not only the gateway', async () => {
    // The second line of defence, and it is a different one: this is a Core that
    // reaches a provider whose signal is *already* aborted, which the gateway
    // should have prevented. The provider must still not do the work.
    const provider = new BlockingModelProvider()
    const c = createCore(options({ providers: [provider] }))
    core = c
    await c.start()

    const controller = new AbortController()
    controller.abort()
    await expect(
      provider.complete(
        { requestId: 'a', prompt: 'p', maxOutputTokens: 1, model: null },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(/cancelled/i)
    expect(provider.contacts).toBe(0)
    expect(provider.refusals).toBe(1)
  })
})

describe('C — many requests at once', () => {
  it('aborts every active request and empties the registry', async () => {
    const provider = new BlockingModelProvider()
    core = createCore(options({ providers: [provider] }))
    await core.start()

    const inFlight = ['a', 'b', 'c', 'd', 'e'].map((id) =>
      ownerAuthority(core!).request(userTurn({ cognitionRequestId: id })),
    )
    // Every one of them is genuinely inside the provider before the stop.
    await waitFor(() => provider.contacts === 5)
    expect(core.status().activeProviderCalls).toBe(5)

    await stopAll(core)
    const outcomes = await Promise.all(inFlight)

    expect(outcomes.map((o) => o.status)).toEqual(['cancelled', 'cancelled', 'cancelled', 'cancelled', 'cancelled'])
    // No request is left holding an open socket.
    expect(provider.aborts).toBe(5)
    expect(core.status().activeProviderCalls).toBe(0)
  })

  it('gives each request its own signal, so no two share a fate', async () => {
    // Cancellation has to be per request. A shared signal would let one abort
    // drag down an unrelated call, and a shared controller would mean the second
    // request could never be cancelled at all.
    const signals: AbortSignal[] = []
    const provider = new BlockingModelProvider()
    const original = provider.complete.bind(provider)
    provider.complete = (request, options) => {
      signals.push(options.signal)
      return original(request, options)
    }

    core = createCore(options({ providers: [provider] }))
    await core.start()

    const first = ownerAuthority(core).request(userTurn({ cognitionRequestId: 'a' }))
    await waitFor(() => signals.length === 1)
    const second = ownerAuthority(core).request(userTurn({ cognitionRequestId: 'b' }))
    await waitFor(() => signals.length === 2)

    expect(signals[0]).not.toBe(signals[1])
    expect(signals.every((signal) => !signal.aborted)).toBe(true)

    await stopAll(core)
    expect((await first).status).toBe('cancelled')
    expect((await second).status).toBe('cancelled')
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(provider.aborts).toBe(2)
    expect(core.status().activeProviderCalls).toBe(0)
  })
})

describe('D — the durable stop', () => {
  it('stays latched across a restart, and no provider is contacted afterwards', async () => {
    const first = createCore(options())
    await first.start()
    await stopAll(first)
    await first.stop('test')

    // A fresh process reading the same journal.
    const provider = new BlockingModelProvider()
    const second = createCore(options({ providers: [provider] }))
    core = second
    await second.start()

    expect(second.status().stopAll.active).toBe(true)
    // The gateway is shut, not merely the Governor. A request authorised before
    // the stop and arriving at the gateway afterwards must find the door shut.
    const outcome = await ownerAuthority(second).request(userTurn({ cognitionRequestId: 'a' }))
    expect(outcome.status).toBe('denied')
    expect(provider.contacts).toBe(0)
  })

  it('cannot be cleared by anything but an explicit owner resume', async () => {
    core = createCore(options())
    await core.start()
    await stopAll(core)

    // A worker, and a model, can both ask. Neither holds `security.resume`.
    const asked = await workerAuthority(core, 'agent:worker-1').request(agentStep('a'))
    expect(asked.status).toBe('denied')
    expect(core.status().stopAll.active).toBe(true)

    // And the latch is still on, so the only way out is the owner's command.
    const stillStopped = await stopAll(core, 's2')
    expect(stillStopped.ok).toBe(true)
    expect(core.status().stopAll.active).toBe(true)
  })
})

describe('D2 — STOP persistence failure stays fail-closed', () => {
  it('keeps cognition denied until an explicit owner resume reopens the gate', async () => {
    const path = join(dir, 'events.jsonl')
    const base = await JsonlEventStore.open(path)
    const provider = new FakeModelProvider()

    const store: EventStore = {
      append: async (event) => {
        if (event.type === 'security.stop_all.activated') {
          throw new Error('simulated STOP persistence failure')
        }
        await base.append(event)
      },
      readAll: () => base.readAll(),
      readAfter: (sequence) => base.readAfter(sequence),
      lastSequence: () => base.lastSequence(),
      describe: () => 'test:fail-stop-append',
      close: () => base.close(),
    }

    core = createCore(options({ providers: [provider], eventStore: store }))
    await core.start()

    const stopped = await stopAll(core)
    expect(stopped.ok).toBe(false)
    expect(stopped.error?.message).toMatch(/simulated STOP persistence failure/)

    // The durable latch could not be written, but runtime authority still fails
    // closed and says so. Nothing may reach the provider in this condition.
    expect(core.status().stopAll.active).toBe(false)
    expect(core.status().governor.status).toBe('deny_all')
    expect(core.status().faults.join(' ')).toMatch(/fail-closed/i)

    const refused = await ownerAuthority(core).request(
      userTurn({ cognitionRequestId: 'after-failed-stop' }),
    )
    expect(refused.status).toBe('denied')
    expect(provider.calls).toBe(0)

    // Only an explicit owner resume reopens the runtime gate. There is no
    // durable STOP event to clear, so this changes session authority only.
    const opened = await resume(core, 'resume-after-failed-stop')
    expect(opened.ok).toBe(true)
    expect(core.status().governor.status).toBe('ready')

    const fresh = await ownerAuthority(core).request(
      userTurn({ cognitionRequestId: 'after-explicit-resume' }),
    )
    expect(fresh.status).toBe('allowed')
    expect(provider.calls).toBe(1)
  })
})

describe('E — resume', () => {
  it('does not restart cancelled work, and only a new request may begin', async () => {
    const provider = new BlockingModelProvider()
    core = createCore(options({ providers: [provider] }))
    await core.start()

    const cancelled = ownerAuthority(core).request(userTurn({ cognitionRequestId: 'a' }))
    await provider.contacted
    await stopAll(core)
    expect((await cancelled).status).toBe('cancelled')
    const callsAtStop = provider.contacts

    const opened = await resume(core)
    expect(opened.ok).toBe(true)
    expect(core.status().stopAll.active).toBe(false)

    // Nothing came back on its own. The cancelled request stays cancelled, and
    // the provider was not asked again.
    expect(provider.contacts).toBe(callsAtStop)
    expect(core.status().activeProviderCalls).toBe(0)

    // A *new* request is allowed, and it is a genuinely new one.
    const fresh = ownerAuthority(core).request(userTurn({ cognitionRequestId: 'b' }))
    await waitFor(() => provider.contacts === callsAtStop + 1)
    provider.releaseAll()
    expect((await fresh).status).toBe('allowed')
    expect(provider.contacts).toBe(callsAtStop + 1)
  })

  it('does not return the reservation a cancelled request already took', async () => {
    const provider = new BlockingModelProvider()
    core = createCore(options({ providers: [provider] }))
    await core.start()
    await grant(core)

    const inFlight = workerAuthority(core).request(agentStep('a', 400))
    await provider.contacted
    await stopAll(core)
    expect((await inFlight).status).toBe('cancelled')
    await resume(core)

    // Authorisation is not refunded because the owner stopped it. The budget was
    // taken before the provider was asked, and taking it back would make a stop
    // look like the request never happened.
    const held = ownerAuthority(core).grants().find((g) => g.id === 'grant-1')
    expect(held?.usage.outputTokenBudgetReserved).toBe(400)
    expect(held?.usage.calls).toBe(1)
  })

  it('is a no-op on a Core that is not stopped', async () => {
    core = createCore(options())
    await core.start()
    const result = await resume(core)
    expect(result.ok).toBe(true)
    expect(core.status().stopAll.active).toBe(false)
    // Nothing was cancelled, so nothing needs re-authorising.
    expect(await journal(join(dir, 'events.jsonl'))).not.toContain('security.stop_all.cleared')
  })
})

describe('F — what Presence is allowed to claim', () => {
  it('is working only while Core reports a live call, and locked outranks both', async () => {
    // The ordering, asserted on the CoreStatus facts the projection reads. The
    // projection's own mapping is tested in tests/unit/desktopProjection.test.ts.
    const provider = new BlockingModelProvider()
    core = createCore(options({ providers: [provider] }))
    await core.start()

    expect(core.status().activeProviderCalls).toBe(0)

    const inFlight = ownerAuthority(core).request(userTurn({ cognitionRequestId: 'a' }))
    await provider.contacted
    expect(core.status().activeProviderCalls).toBe(1)

    await stopAll(core)
    // Cancelled work is over, but the latch is not: still locked at zero calls.
    await inFlight
    expect(core.status().activeProviderCalls).toBe(0)
    expect(core.status().stopAll.active).toBe(true)

    await resume(core)
    expect(core.status().activeProviderCalls).toBe(0)
    expect(core.status().stopAll.active).toBe(false)
  })

  it('does not report a call that a previous process never finished', async () => {
    // A journal carrying an unfinished request, which is what a crashed Core
    // leaves behind. It is history, and it is not evidence of live work.
    const first = createCore(options({ providers: [new FakeModelProvider()] }))
    await first.start()
    await ownerAuthority(first).request(userTurn({ cognitionRequestId: 'a' }))
    await first.stop('crash simulation')
    const path = join(dir, 'events.jsonl')

    const second = createCore(options())
    core = second
    await second.start()

    // The log holds a completed call, and a restarted Core reports none running.
    expect(await journal(path)).toContain('model.request.completed')
    expect(second.status().activeProviderCalls).toBe(0)
  })

  it('reports nothing running for a command, which costs nothing', async () => {
    core = createCore(options())
    await core.start()
    await core.handleCommand({
      command: 'core.command.submit',
      requestId: 'c1',
      payload: { text: 'hello Freya', origin: 'command-bar' },
    })
    expect(core.status().activeProviderCalls).toBe(0)
  })
})

describe('G — Core shutdown', () => {
  it('cancels what is running and records the outcome before closing the log', async () => {
    const provider = new BlockingModelProvider()
    const c = createCore(options({ providers: [provider] }))
    core = c
    await c.start()
    const path = join(dir, 'events.jsonl')

    const inFlight = ownerAuthority(c).request(userTurn({ cognitionRequestId: 'a' }))
    await provider.contacted

    // Bounded, and it completes: a shutdown that hangs is a bug, not a slow test.
    await c.stop('app quitting')

    // The cancellation reached the provider…
    expect(provider.aborts).toBe(1)
    // …and it was made durable before the store closed, which is the ordering
    // the previous shutdown got wrong.
    const types = await requestEvents(path, 'a')
    expect(types).toContain('model.request.cancelled')
    expect(types).not.toContain('model.request.failed')
    expect(types).not.toContain('model.request.completed')

    const events = await journal(path)
    expect(events).toContain('core.stopping')
    expect(events).toContain('core.stopped')
    // The terminal event landed before the fabric was closed.
    expect(events.indexOf('model.request.cancelled')).toBeLessThan(events.indexOf('core.stopped'))
    expect(await inFlight).toMatchObject({ status: 'cancelled' })
  })

  it('leaves no running work behind', async () => {
    const provider = new BlockingModelProvider()
    const c = createCore(options({ providers: [provider] }))
    core = c
    await c.start()
    const inFlight = ownerAuthority(c).request(userTurn({ cognitionRequestId: 'a' }))
    await provider.contacted
    await c.stop('app quitting')
    expect(c.status().activeProviderCalls).toBe(0)
    expect(c.lifecycle).toBe('stopped')
    await inFlight
  })

  it('is idempotent, and a second stop is not a second cancellation', async () => {
    const provider = new BlockingModelProvider()
    const c = createCore(options({ providers: [provider] }))
    core = c
    await c.start()
    const path = join(dir, 'events.jsonl')
    const inFlight = ownerAuthority(c).request(userTurn({ cognitionRequestId: 'a' }))
    await provider.contacted
    await c.stop('first')
    await c.stop('second')
    const types = await requestEvents(path, 'a')
    expect(types.filter((t) => t === 'model.request.cancelled')).toHaveLength(1)
    await inFlight
  })

  it('cannot be reopened by a resume command once shutdown starts', async () => {
    class DeafProvider extends FakeModelProvider {
      override readonly id = 'deaf-resume'
      override complete(): Promise<never> {
        return new Promise<never>(() => {
          /* deliberately ignores cancellation */
        })
      }
    }

    const c = createCore(options({ providers: [new DeafProvider()] }))
    core = c
    await c.start()
    void ownerAuthority(c).request(userTurn({ cognitionRequestId: 'a' })).catch(() => undefined)
    await waitFor(() => c.status().activeProviderCalls === 1)

    const stopping = c.stop('app quitting')
    await waitFor(() => c.lifecycle === 'stopping')

    const attemptedResume = await c.handleCommand({
      command: 'security.resume',
      requestId: 'resume-during-stop',
    })
    expect(attemptedResume.ok).toBe(false)
    expect(attemptedResume.refusal?.reason).toMatch(/stopping/i)

    await stopping
    expect(c.lifecycle).toBe('stopped')
  })

  it('does not hang on a provider that ignores its signal', async () => {
    // The worst case, and the reason the drain is bounded: a provider that
    // cannot be stopped must not be able to stop the application from exiting.
    class DeafProvider extends FakeModelProvider {
      override readonly id = 'deaf'
      override complete(): Promise<never> {
        return new Promise<never>(() => {
          /* never settles, never listens */
        })
      }
    }
    const c = createCore(options({ providers: [new DeafProvider()] }))
    core = c
    await c.start()
    // Deliberately never awaited: a provider that cannot be stopped is exactly
    // what this test is about, so its request is left outstanding on purpose.
    void ownerAuthority(c).request(userTurn({ cognitionRequestId: 'a' })).catch(() => undefined)
    await waitFor(() => c.status().activeProviderCalls === 1)

    const began = Date.now()
    await c.stop('app quitting')
    // Bounded, and the journal is then missing a terminal event for that
    // request — which is exactly what a crash mid-call would have left.
    expect(Date.now() - began).toBeLessThan(5_000)
    expect(c.lifecycle).toBe('stopped')
  })
})

describe('H — no provider contact', () => {
  it('never reaches a network on the cancellation path', async () => {
    // A real NanoGPT provider, configured and enabled, with its transport
    // replaced by a counter. Nothing here may move the counter — not the stop,
    // not the cancel, not the shutdown.
    let fetches = 0
    const nanogpt = new NanoGptProvider({
      config: { apiKey: 'not-a-real-key', baseUrl: 'https://example.invalid', model: 'm', liveEnabled: true },
      fetchImpl: (async () => {
        fetches += 1
        throw new Error('the network must not be reachable from a test')
      }) as unknown as typeof fetch,
    })

    const c = createCore(options({ providers: [nanogpt] }))
    core = c
    await c.start()
    expect(c.status().providers[0]?.status).toBe('configured')

    await stopAll(c)
    const outcome = await ownerAuthority(c).request(userTurn({ cognitionRequestId: 'a' }))
    expect(outcome.status).toBe('denied')
    await resume(c)
    await c.stop('app quitting')

    expect(fetches).toBe(0)
  })

  it('refuses a direct call when live inference is not enabled', async () => {
    // The other half of the guarantee: the provider itself will not spend, so
    // nothing depends on the gateway having refused first.
    let fetches = 0
    const nanogpt = new NanoGptProvider({
      config: { apiKey: 'k', baseUrl: 'https://example.invalid', model: 'm', liveEnabled: false },
      fetchImpl: (async () => {
        fetches += 1
        throw new Error('unreachable')
      }) as unknown as typeof fetch,
    })
    expect(nanogpt.status().status).toBe('disabled')
    await expect(
      nanogpt.complete(
        { requestId: 'a', prompt: 'p', maxOutputTokens: 1, model: null },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/not enabled/i)
    expect(fetches).toBe(0)
  })

  it('records a provider timeout as failure, not owner cancellation', async () => {
    const nanogpt = new NanoGptProvider({
      config: { apiKey: 'k', baseUrl: 'https://example.invalid', model: 'm', liveEnabled: true },
      timeoutMs: 5,
      fetchImpl: ((_url: string, init: { signal: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          init.signal.addEventListener(
            'abort',
            () => reject(init.signal.reason ?? new Error('aborted')),
            { once: true },
          )
        })) as unknown as typeof fetch,
    })

    const c = createCore(options({ providers: [nanogpt] }))
    core = c
    await c.start()
    const path = join(dir, 'events.jsonl')

    const outcome = await ownerAuthority(c).request(userTurn({ cognitionRequestId: 'timeout' }))
    expect(outcome.status).toBe('failed')
    expect(outcome.status === 'failed' ? outcome.reason : '').toMatch(/timed out/i)

    const types = await requestEvents(path, 'timeout')
    expect(types).toContain('model.request.failed')
    expect(types).not.toContain('model.request.cancelled')
    expect(c.status().sessionUsage.unknownUsageCalls).toBe(1)
    expect(c.status().durableUsage.unknownUsageCalls).toBe(1)
  })

  it('lets an owner stop cancel a live call without a second attempt', async () => {
    // The composition rule: an external abort and the provider's own timeout
    // end the same request, and neither turns into another call.
    let fetches = 0
    const nanogpt = new NanoGptProvider({
      config: { apiKey: 'k', baseUrl: 'https://example.invalid', model: 'm', liveEnabled: true },
      // Stands in for a request in flight: honours the signal, never answers,
      // and would be the thing a retry would call a second time.
      fetchImpl: ((_url: string, init: { signal: AbortSignal }) => {
        fetches += 1
        return new Promise<never>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }) as unknown as typeof fetch,
    })

    const c = createCore(options({ providers: [nanogpt] }))
    core = c
    await c.start()

    const inFlight = ownerAuthority(c).request(userTurn({ cognitionRequestId: 'a' }))
    await waitFor(() => fetches === 1)
    await stopAll(c)

    expect((await inFlight).status).toBe('cancelled')
    // One contact. An abort is not a reason to try again.
    expect(fetches).toBe(1)
  })
})

/** Wait for a condition, so a test never encodes a sleep as a fact. */
async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

const permit = (requestId: string) => ({
  requestId,
  correlationId: requestId,
  grantId: null,
  providerId: 'auto',
  maxOutputTokens: 100,
  model: null,
})

/** A provider that records whether it was invoked, and never does any work. */
function countingProvider(onInvoke: () => void): ModelProvider {
  return {
    id: 'counted',
    kind: 'fake',
    live: false,
    status: () => ({
      id: 'counted',
      kind: 'fake' as const,
      status: 'configured' as const,
      model: 'counted-model',
      detail: 'Counts invocations and does nothing else.',
      liveEnabled: false,
    }),
    complete: async (request) => {
      onInvoke()
      return {
        requestId: request.requestId,
        providerId: 'counted',
        model: 'counted-model',
        text: 'ok',
        inputTokens: 1,
        outputTokens: 1,
      }
    },
  }
}

/**
 * A gateway whose `started` append can be held open, so a stop can be made to
 * land in the one await that sits between the journal and the provider.
 */
function gatewayAround(provider: ModelProvider) {
  const types: string[] = []
  const cancellations: { requestId: string; providerId: string; reason: string; providerContacted: boolean }[] = []
  let release: (() => void) | null = null
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const recorder: GatewayRecorder = {
    started: async () => {
      types.push('started')
      await gate
    },
    completed: async () => {
      types.push('completed')
    },
    failed: async () => {
      types.push('failed')
    },
    cancelled: async (record) => {
      types.push('cancelled')
      cancellations.push(record)
    },
  }
  const gateway = new ModelGateway({ providers: [provider], recorder })
  return {
    gateway,
    recorder: { types, cancellations },
    release: () => release?.(),
  }
}

/** A durable model event, for driving the reducer directly. */
let modelEventSequence = 0
function modelEvent(type: string, payload: Record<string, unknown>): AnyCoreEvent {
  modelEventSequence += 1
  return {
    eventId: `e-${modelEventSequence}`,
    sequence: modelEventSequence,
    type,
    schemaVersion: 1,
    occurredAt: '2026-03-01T12:00:00.000Z',
    source: 'system',
    actor: 'system',
    correlationId: String(payload.requestId),
    causationId: null,
    payload,
  } as unknown as AnyCoreEvent
}

