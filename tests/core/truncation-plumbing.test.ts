// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { EventFabric } from '../../core/events/fabric'
import type { EventStore } from '../../core/events/store'
import type { AnyCoreEvent } from '../../core/events/envelope'
import { NanoGptProvider, type NanoGptConfig } from '../../core/model/nanogpt-provider'
import { ModelGateway, type GatewayRecorder } from '../../core/model/gateway'
import {
  isTruncationReason,
  isTruncationSignal,
  readFinishReason,
  resolveFinish,
  type ModelCallOptions,
  type ModelProvider,
  type ModelRequest,
  type ModelResult,
} from '../../core/model/provider'
import { CognitionService, cognitionOutcomeTruncated } from '../../core/cognition/service'
import { DefaultGuard } from '../../core/security/guard'
import { initialCoreState } from '../../core/state'
import type { ProviderStatus } from '../../core/protocol/core-protocol'

/**
 * Does the finish reason survive the trip from the wire to the Mind?
 *
 * The defect this covers is a *dropped field*, so the tests here are shaped like
 * a wire: one fact enters at the provider and each hop is asked whether it is still
 * there. A hop that quietly discarded it would leave every downstream test passing
 * for the wrong reason — a Mind that only checks what it is handed cannot tell a
 * caller that handed it nothing.
 *
 * Each hop is exercised against the real class it belongs to — the real
 * `NanoGptProvider` over a stub transport, the real `ModelGateway`, the real
 * `CognitionService` over a real Governor and a real grant store — with only the
 * network replaced. Nothing here can reach a network or spend anything.
 */

/* ------------------------------------------------------------ the vocabulary */

describe('the finish-reason vocabulary', () => {
  it('narrows what the endpoint actually sends and calls anything else "other"', () => {
    expect(readFinishReason('stop')).toBe('stop')
    expect(readFinishReason('length')).toBe('length')
    expect(readFinishReason('tool_calls')).toBe('tool_calls')
    expect(readFinishReason('content_filter')).toBe('content_filter')
    // An endpoint that invents a spelling must produce "said something else",
    // never a silent `stop` — absence of a claim is not a favourable claim.
    expect(readFinishReason('max_tokens_exceeded')).toBe('other')
    // Not a string at all is the same as having said nothing.
    expect(readFinishReason(undefined)).toBeNull()
    expect(readFinishReason(null)).toBeNull()
    expect(readFinishReason('')).toBeNull()
    expect(readFinishReason(7)).toBeNull()
    expect(readFinishReason({ reason: 'length' })).toBeNull()
  })

  it('calls exactly one reason truncation, and a tool call is not it', () => {
    expect(isTruncationReason('length')).toBe(true)
    // The distinction that matters most: a turn that stopped to ask for a tool did
    // what it was asked to do.
    expect(isTruncationReason('tool_calls')).toBe(false)
    expect(isTruncationReason('stop')).toBe(false)
    expect(isTruncationReason('content_filter')).toBe(false)
    expect(isTruncationReason('other')).toBe(false)
    // An unreported reason is not evidence of a cut-off answer.
    expect(isTruncationReason(null)).toBe(false)
    expect(isTruncationReason(undefined)).toBe(false)
  })

  it('reads truncation structurally, from either field, and never from the text', () => {
    expect(isTruncationSignal({ finishReason: 'length' })).toBe(true)
    expect(isTruncationSignal({ finishReason: 'length', truncated: true })).toBe(true)
    expect(isTruncationSignal({ truncated: true })).toBe(true)
    expect(isTruncationSignal({ finishReason: 'tool_calls', truncated: false })).toBe(false)
    expect(isTruncationSignal({})).toBe(false)
    // Empty content is not a truncation signal, and neither is a short answer.
    expect(isTruncationSignal({ finishReason: 'stop', text: '' } as never)).toBe(false)
  })

  it('resolveFinish adds only the two finish fields', () => {
    const before: ModelResult = {
      requestId: 'r1',
      providerId: 'p',
      model: 'm',
      text: 'an answer',
      inputTokens: 3,
      outputTokens: 4,
    }
    const after = resolveFinish({ ...before, finishReason: 'stop' })
    expect(after.finishReason).toBe('stop')
    expect(after.truncated).toBe(false)
    // Everything a normally-finished answer carries is byte-identical.
    expect({ ...after, finishReason: undefined, truncated: undefined }).toEqual(before)
  })
})

/* -------------------------------------------------------------- hop 1: wire */

describe('the NanoGPT provider', () => {
  const CONFIG: NanoGptConfig = {
    apiKey: 'sk-test-never-echoed',
    baseUrl: 'https://nano-gpt.com/api/v1',
    model: 'openai/gpt-4.1-nano',
    liveEnabled: true,
  }

  /** A transport that answers one chat completion with exactly this JSON. */
  function transport(json: unknown): typeof fetch {
    return (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => json,
        headers: new Headers(),
      }) as unknown as Response) as unknown as typeof fetch
  }

  async function completeWith(json: unknown): Promise<ModelResult> {
    const provider = new NanoGptProvider({ config: CONFIG, fetchImpl: transport(json) })
    const request: ModelRequest = {
      requestId: 'r1',
      messages: [{ role: 'user', content: 'a question' }],
      prompt: 'a question',
      maxOutputTokens: 512,
      model: null,
    }
    return provider.complete(request, { signal: new AbortController().signal })
  }

  function chat(reason: unknown, content: string): unknown {
    return {
      model: CONFIG.model,
      choices: [{ message: { content }, finish_reason: reason }],
      usage: { prompt_tokens: 11, completion_tokens: 6 },
    }
  }

  it('reports a length-limited answer as truncated', async () => {
    // The measured defect: max_tokens reached, reply cut mid-sentence.
    const result = await completeWith(chat('length', 'the reply began like th'))
    expect(result.finishReason).toBe('length')
    expect(result.truncated).toBe(true)
    // The text is passed through untouched — the truncation is reported, not repaired.
    expect(result.text).toBe('the reply began like th')
    expect(result.inputTokens).toBe(11)
    expect(result.outputTokens).toBe(6)
  })

  it('reports a length-limited answer that produced nothing at all', async () => {
    const result = await completeWith(chat('length', ''))
    expect(result.finishReason).toBe('length')
    expect(result.truncated).toBe(true)
    expect(result.text).toBe('')
  })

  it('does not call a finished or tool-stopping answer truncated', async () => {
    const stopped = await completeWith(chat('stop', 'a whole answer'))
    expect(stopped.finishReason).toBe('stop')
    expect(stopped.truncated).toBe(false)

    const toolish = await completeWith(chat('tool_calls', ''))
    expect(toolish.finishReason).toBe('tool_calls')
    expect(toolish.truncated).toBe(false)
  })

  it('reports "not stated" as null rather than guessing stop', async () => {
    // A provider or gateway that omits the field must not be read as having
    // finished; but it also must not be read as having been cut off.
    const result = await completeWith(chat(undefined, 'an answer'))
    expect(result.finishReason).toBeNull()
    expect(result.truncated).toBe(false)
  })

  it('keeps an empty answer with finish=stop as a finished, empty answer', async () => {
    // Documented decision, asserted here so it cannot drift: this is NOT
    // truncation. `stop` is the provider asserting it finished on its own terms,
    // and empty content with `stop` really happens. Truncation is a claim about
    // the output budget, so it is read only from `length` — inferring it from
    // emptiness would relabel a terse model as a broken one.
    const result = await completeWith(chat('stop', ''))
    expect(result.truncated).toBe(false)
  })
})

/* ------------------------------------------------- hops 2 and 3: the gateway */

function memoryEventStore(): EventStore {
  const events: AnyCoreEvent[] = []
  return {
    append: async (event: AnyCoreEvent) => {
      events.push(event)
    },
    readAll: async () => [...events],
    readAfter: async (afterSequence: number) => events.filter((e) => e.sequence > afterSequence),
    lastSequence: async () => events[events.length - 1]?.sequence ?? 0,
    describe: () => 'memory',
    close: async () => undefined,
  }
}

const silentRecorder: GatewayRecorder = {
  started: async () => undefined,
  completed: async () => undefined,
  failed: async () => undefined,
  cancelled: async () => undefined,
}

/** A provider that returns exactly the result a test hands it. */
class StubProvider implements ModelProvider {
  readonly id = 'stub'
  readonly kind = 'fake' as const
  readonly live = false
  calls = 0

  constructor(private readonly result: Omit<ModelResult, 'requestId' | 'providerId'>) {}

  status(): ProviderStatus {
    return {
      id: this.id,
      kind: 'fake',
      status: 'configured',
      model: 'stub-1',
      detail: 'A stub provider for the truncation plumbing tests.',
      liveEnabled: false,
    }
  }

  async complete(request: ModelRequest, options: ModelCallOptions): Promise<ModelResult> {
    if (options.signal.aborted) throw new Error('aborted before the provider was contacted')
    this.calls += 1
    return { requestId: request.requestId, providerId: this.id, ...this.result }
  }
}

const PERMIT = {
  requestId: 'r1',
  correlationId: 'r1',
  grantId: null,
  providerId: 'auto',
  maxOutputTokens: 512,
  model: null,
}

describe('the Model Gateway', () => {
  async function gatewayOver(provider: ModelProvider): Promise<ModelGateway> {
    return new ModelGateway({ providers: [provider], recorder: silentRecorder })
  }

  it('carries the reason and the derived flag out of the provider', async () => {
    const gateway = await gatewayOver(
      new StubProvider({ model: 'stub-1', text: 'half an ans', inputTokens: 5, outputTokens: 6, finishReason: 'length' }),
    )
    const result = await gateway.execute(PERMIT, 'a question')
    expect(result.finishReason).toBe('length')
    expect(result.truncated).toBe(true)
    expect(result.text).toBe('half an ans')
  })

  it('derives `truncated` for a provider that reported only the reason', async () => {
    // Additivity means a provider written before these fields existed still
    // satisfies the contract. The gateway is where that promise is kept: nobody
    // above it has to know which of the two a given provider sets.
    const gateway = await gatewayOver(
      new StubProvider({ model: 'stub-1', text: 'an answer', inputTokens: 5, outputTokens: 6 }),
    )
    const result = await gateway.execute(PERMIT, 'a question')
    expect(result.finishReason).toBeNull()
    expect(result.truncated).toBe(false)
  })

  it('does not mark a tool-stopping or a finished answer as truncated', async () => {
    const toolish = await gatewayOver(
      new StubProvider({ model: 'stub-1', text: '', inputTokens: 5, outputTokens: 0, finishReason: 'tool_calls' }),
    )
    expect((await toolish.execute(PERMIT, 'a question')).truncated).toBe(false)

    const finished = await gatewayOver(
      new StubProvider({ model: 'stub-1', text: 'an answer', inputTokens: 5, outputTokens: 6, finishReason: 'stop' }),
    )
    expect((await finished.execute(PERMIT, 'a question')).truncated).toBe(false)
  })
})

describe('the Cognition Service', () => {
  async function serviceOver(provider: ModelProvider): Promise<CognitionService> {
    const fabric = await EventFabric.open({ store: memoryEventStore() })
    const gateway = new ModelGateway({ providers: [provider], recorder: silentRecorder })
    const guard = new DefaultGuard()
    return new CognitionService({ fabric, gateway, guard }, initialCoreState())
  }

  it('reports the provider\'s finish reason on the allowed outcome', async () => {
    const cognition = await serviceOver(
      new StubProvider({ model: 'stub-1', text: 'cut off here', inputTokens: 5, outputTokens: 6, finishReason: 'length' }),
    )
    const outcome = await cognition.ownerAuthority().request({
      kind: 'user_turn',
      prompt: 'a question',
      maxOutputTokens: 512,
      goalId: null,
    })

    expect(outcome.status).toBe('allowed')
    if (outcome.status !== 'allowed') throw new Error('expected an allowed outcome')
    expect(outcome.text).toBe('cut off here')
    expect(outcome.finishReason).toBe('length')
    expect(outcome.truncated).toBe(true)
    expect(cognitionOutcomeTruncated(outcome)).toBe(true)
  })

  it('reports no truncation for a finished answer, without changing the text', async () => {
    const cognition = await serviceOver(
      new StubProvider({ model: 'stub-1', text: 'a whole answer', inputTokens: 5, outputTokens: 6, finishReason: 'stop' }),
    )
    const outcome = await cognition.ownerAuthority().request({
      kind: 'user_turn',
      prompt: 'a question',
      maxOutputTokens: 512,
      goalId: null,
    })

    if (outcome.status !== 'allowed') throw new Error('expected an allowed outcome')
    expect(outcome.finishReason).toBe('stop')
    expect(outcome.truncated).toBe(false)
    expect(cognitionOutcomeTruncated(outcome)).toBe(false)
    expect(outcome.text).toBe('a whole answer')
  })

  it('answers the truncation question false for an outcome that has no answer', async () => {
    // A denial or a cancellation returned nothing, so there is nothing that could
    // have been cut off. Asking must not throw and must not guess.
    expect(cognitionOutcomeTruncated({ status: 'denied', requestId: 'r', reason: 'no' })).toBe(false)
    expect(
      cognitionOutcomeTruncated({ status: 'cancelled', requestId: 'r', reason: 'no', providerContacted: true }),
    ).toBe(false)
    expect(
      cognitionOutcomeTruncated({ status: 'failed', requestId: 'r', reason: 'no', providerContacted: true }),
    ).toBe(false)
  })
})