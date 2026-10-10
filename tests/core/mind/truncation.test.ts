// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EventFabric } from '../../../core/events/fabric'
import type { EventStore } from '../../../core/events/store'
import type { AnyCoreEvent } from '../../../core/events/envelope'
import { MemoryConversationStore } from '../../../core/conversation/memory-store'
import { ModelGateway, type GatewayRecorder } from '../../../core/model/gateway'
import type { ModelCallOptions, ModelProvider, ModelRequest, ModelResult } from '../../../core/model/provider'
import { MindService, TRUNCATION_REASON, renderTruncatedAnswer } from '../../../core/mind/mind'
import {
  MindToolRegistry,
  createWebSearchTool,
  type MindTool,
  type ToolSource,
} from '../../../core/mind/tools'
import { DefaultGuard } from '../../../core/security/guard'
import type { OwnerAuthority } from '../../../core/authority'
import { CognitionService } from '../../../core/cognition/service'
import { initialCoreState } from '../../../core/state'
import type { Capability } from '../../../core/protocol/core-protocol'

/**
 * A turn whose answer was cut off.
 *
 * The rule under test is Freya's own: never present an incomplete result as a
 * complete one. A model that hits its output budget returns `finish_reason:
 * "length"` with truncated or empty content, and storing that as though it were a
 * finished answer is a lie told to the person who asked.
 *
 * What these tests pin:
 *
 *   - a finished answer is untouched, byte-identical, and the turn `completed`;
 *   - a cut-off answer is not `completed`, the transcript says so in plain words,
 *     and nothing anywhere invents the missing text;
 *   - a reply that stopped to ask for a *tool* is not a cut-off answer, however
 *     much it looks like one;
 *   - a reply cut off *while emitting a tool call* is a cut-off answer, and no tool
 *     runs on its possibly-partial arguments;
 *   - nothing is retried: a cut-off answer costs one call, not two;
 *   - empty content with `finish=stop` is finished-and-empty, not truncation.
 *
 * The whole real path runs here — Mind, Cognition Service, Governor, grant store,
 * Model Gateway — over a scripted provider. Nothing reaches a network.
 */

const T0 = new Date('2026-07-01T09:00:00.000Z')
const CONVERSATION_ID = 'c1'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-truncation-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/* --------------------------------------------------------------- plumbing */

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

/** One scripted reply: what the model said, and why it stopped. */
interface Reply {
  readonly text: string
  /**
   * Left out on purpose in some scripts. A provider that reports no reason is the
   * pre-existing shape of every fake in this suite, and it must keep working.
   */
  readonly finishReason?: 'stop' | 'length' | 'tool_calls'
}

class ScriptedProvider implements ModelProvider {
  readonly id = 'scripted'
  readonly kind = 'fake' as const
  readonly live = false
  calls = 0

  constructor(private readonly script: readonly Reply[]) {}

  status() {
    return {
      id: this.id,
      kind: 'fake' as const,
      status: 'configured' as const,
      model: 'scripted-1',
      detail: 'A scripted provider for the truncation tests.',
      liveEnabled: false,
    }
  }

  async complete(request: ModelRequest, options: ModelCallOptions): Promise<ModelResult> {
    if (options.signal.aborted) throw new Error('aborted before the provider was contacted')
    this.calls += 1
    const reply = this.script[Math.min(this.calls - 1, this.script.length - 1)] ?? { text: '' }
    return {
      requestId: request.requestId,
      providerId: this.id,
      model: 'scripted-1',
      text: reply.text,
      inputTokens: 10,
      outputTokens: 10,
      ...(reply.finishReason === undefined ? {} : { finishReason: reply.finishReason }),
    }
  }
}

function toolCall(name: string, args: Record<string, string>): string {
  return `FREYA_TOOL_CALL\n${JSON.stringify({ tool: name, ...args })}\nFREYA_TOOL_CALL_END`
}

const SOURCE: ToolSource = {
  title: 'A real page',
  url: 'https://example.org/real',
  sourceDomain: 'example.org',
  snippet: 'the actual finding',
  rank: 1,
  retrievedAt: T0.toISOString(),
}

/** The search tool, over a seam that records what it was asked. */
function searchTool(log: { queries: string[] }): MindTool {
  return createWebSearchTool({
    searchWeb: async (query: string) => {
      log.queries.push(query)
      return [SOURCE]
    },
    now: () => T0,
  })
}

async function harness(
  options: { script?: readonly Reply[]; tools?: MindTool[] | null } = {},
) {
  const provider = new ScriptedProvider(options.script ?? [{ text: 'a plain answer', finishReason: 'stop' }])
  const store = memoryEventStore()
  const fabric = await EventFabric.open({ store, now: () => T0 })
  const conversations = new MemoryConversationStore({ mode: 'memory' })
  await conversations.putConversation({
    conversationId: CONVERSATION_ID,
    title: 'a conversation',
    createdAt: T0.toISOString(),
    updatedAt: T0.toISOString(),
  })

  const queries: string[] = []
  const toolList: MindTool[] = options.tools ?? [searchTool({ queries })]
  const registry = new MindToolRegistry({
    tools: toolList,
    guard: new DefaultGuard(),
    principal: { id: 'owner', capabilities: new Set<Capability>(['search.web']), trusted: true },
    stopped: () => false,
  })

  const gateway = new ModelGateway({ providers: [provider], recorder: silentRecorder, now: () => T0 })
  const cognition = new CognitionService({ fabric, gateway, guard: new DefaultGuard(), now: () => T0 }, initialCoreState())
  const authority: OwnerAuthority = cognition.ownerAuthority()

  const mind = new MindService({
    fabric,
    store: conversations,
    authority,
    gateway,
    now: () => T0,
    newId: (() => {
      let n = 0
      return () => `id-${(n += 1).toString().padStart(4, '0')}`
    })(),
    // An empty list is how "no registry" is expressed here, so the default is the
    // single-call path and the tool cases opt in.
    ...(toolList.length === 0 ? {} : { tools: registry }),
  })

  return {
    mind,
    provider,
    queries,
    conversations,
    readMessages: async () => (await conversations.readConversation(CONVERSATION_ID))?.messages ?? [],
    turns: async () => (await conversations.readConversation(CONVERSATION_ID))?.turns ?? [],
    events: async () => store.readAll(),
  }
}

const submit = (h: { mind: MindService }, text = 'a question', turnId = 't1') =>
  h.mind.runTurn({ conversationId: CONVERSATION_ID, turnId, text })

const transcriptOf = async (h: { readMessages: () => Promise<readonly { content: string }[]> }) => {
  const messages = await h.readMessages()
  return messages.map((message) => message.content)
}

/* --------------------------------------------- a finished answer is untouched */

describe('a finished answer', () => {
  it('is stored verbatim and the turn completes', async () => {
    // The control. Everything else in this file is a deviation from this, so it is
    // pinned first and pinned exactly: one call, the model's own bytes, `completed`.
    const h = await harness({ script: [{ text: 'a whole answer', finishReason: 'stop' }] })

    const result = await submit(h)

    expect(result.outcome).toBe('completed')
    expect(h.provider.calls).toBe(1)
    expect(result.assistantMessage?.content).toBe('a whole answer')
    expect(result.reason).toBeNull()
    expect((await transcriptOf(h))[1]).toBe('a whole answer')
    const turn = (await h.turns())[0]
    expect(turn?.outcome).toBe('completed')
    expect(turn?.assistantMessageId).toBe(result.assistantMessage?.messageId)
  })

  it('behaves identically when the provider reports no reason at all', async () => {
    // Backward compatibility with every provider and fake written before this field
    // existed: silence about the reason is not a claim about the output budget.
    const h = await harness({ script: [{ text: 'a whole answer' }] })

    const result = await submit(h)

    expect(result.outcome).toBe('completed')
    expect(result.assistantMessage?.content).toBe('a whole answer')
    expect((await h.turns())[0]?.outcome).toBe('completed')
  })

  it('treats empty content with finish=stop as finished and empty, not as truncation', async () => {
    // Documented decision, asserted so it cannot drift in either direction.
    // `stop` is the provider saying it finished on its own terms, and an empty
    // reply with `stop` genuinely happens. Truncation is read only from `length`;
    // inferring it from emptiness would relabel a terse model as a broken one, and
    // would make every empty answer a failed turn.
    const h = await harness({ script: [{ text: '', finishReason: 'stop' }] })

    const result = await submit(h)

    expect(result.outcome).toBe('completed')
    expect(result.assistantMessage?.content).toBe('')
    expect((await transcriptOf(h))[1]).toBe('')
  })

  it('completes the tool loop for an answer that needed no tool', async () => {
    // The loop's normal shape, unchanged: one call, the model's own bytes.
    const h = await harness({ script: [{ text: 'just an answer', finishReason: 'stop' }] })

    const result = await submit(h)

    expect(result.outcome).toBe('completed')
    expect(h.provider.calls).toBe(1)
    expect(result.assistantMessage?.content).toBe('just an answer')
  })

  it('completes the single-call path identically when no registry is wired', async () => {
    // `tools: null` is the ordinary chat path: no registry, no envelope parsing, no
    // second call. A finished answer there is exactly as it was before this change.
    const h = await harness({ script: [{ text: 'just an answer', finishReason: 'stop' }], tools: null })

    const result = await submit(h)

    expect(result.outcome).toBe('completed')
    expect(h.provider.calls).toBe(1)
    expect(result.assistantMessage?.content).toBe('just an answer')
    expect((await transcriptOf(h))[1]).toBe('just an answer')
  })

  it('refuses a cut-off answer on the single-call path too', async () => {
    // Both paths ask the same question through the same helper. A truncation check
    // that existed only in the loop would leave ordinary chat — the path almost
    // every turn takes — still storing half an answer as a finished one.
    const h = await harness({ script: [{ text: 'it began and then', finishReason: 'length' }], tools: null })

    const result = await submit(h)

    expect(result.outcome).toBe('failed')
    expect(h.provider.calls).toBe(1)
    const answer = result.assistantMessage?.content ?? ''
    expect(answer).toContain('it began and then')
    expect(answer).toContain('cut off before it finished')
  })
})

/* ------------------------------------------------------- a cut-off answer */

describe('an answer cut off by the output budget', () => {
  it('is not completed, and the transcript says so in plain words', async () => {
    const h = await harness({ script: [{ text: 'the reply began like thi', finishReason: 'length' }] })

    const result = await submit(h)

    // The truthful outcome. Not `completed`, because that claims an answer exists.
    expect(result.outcome).toBe('failed')
    expect(result.reason).toBe(TRUNCATION_REASON)

    const answer = result.assistantMessage?.content ?? ''
    expect(answer).toContain('cut off before it finished')
    // The words the model really produced are kept, and the sentence about them is
    // in the same message, so there is no reading in which they look finished.
    expect(answer).toContain('the reply began like thi')
    expect(answer.indexOf('the reply began like thi')).toBeLessThan(answer.indexOf('cut off before it finished'))

    // Nothing was invented: the stored text is exactly the model's bytes plus the
    // code-written sentence, and there is no trailing continuation of the thought.
    expect(answer.startsWith('the reply began like thi')).toBe(true)
    expect(answer).toBe(renderTruncatedAnswer('the reply began like thi'))
  })

  it('says so in the durable turn record and the terminal event', async () => {
    const h = await harness({ script: [{ text: 'half an ans', finishReason: 'length' }] })

    const result = await submit(h)

    const turn = (await h.turns())[0]
    expect(turn?.outcome).toBe('failed')
    expect(turn?.reason).toContain('cut off before it finished')
    // The message id is set, so recovery cannot later find a terminal turn with no
    // message and re-report it as `interrupted`.
    expect(turn?.assistantMessageId).toBe(result.assistantMessage?.messageId)
    // A provider was asked, generated, and was probably billed: the turn says so.
    expect(turn?.providerId).toBe('scripted')

    const terminal = (await h.events()).filter((event) => event.type === 'conversation.turn.failed')
    expect(terminal).toHaveLength(1)
    const payload = terminal[0]?.payload as { outcome: string; reason: string | null } | undefined
    expect(payload?.outcome).toBe('failed')
    expect(payload?.reason).toContain('cut off before it finished')
  })

  it('reports the provider as contacted, because it was', async () => {
    // The default for a `failed` turn is "not contacted", which would record a paid
    // call as a free one. The model generated the words now in the transcript.
    const h = await harness({ script: [{ text: 'half an ans', finishReason: 'length' }] })

    const result = await submit(h)

    expect(result.providerContacted).toBe(true)
  })

  it('spends exactly one call, and never asks for a bigger budget', async () => {
    // The rule is to refuse to present the answer, not to buy a second one. What a
    // turn costs is not this code's decision to make on the owner's behalf.
    const h = await harness({ script: [{ text: 'half an ans', finishReason: 'length' }] })

    await submit(h)

    expect(h.provider.calls).toBe(1)
  })

  it('handles a cut-off answer that produced no text at all', async () => {
    // `length` with empty content is the same defect wearing a thinner disguise: the
    // budget went before the model wrote anything.
    const h = await harness({ script: [{ text: '', finishReason: 'length' }] })

    const result = await submit(h)

    expect(result.outcome).toBe('failed')
    const answer = result.assistantMessage?.content ?? ''
    expect(answer).toContain('cut off before it finished')
    expect(answer).toContain('produced no text at all')
    expect(h.provider.calls).toBe(1)
  })

  it('leaves the owner question untouched above the notice', async () => {
    const h = await harness({ script: [{ text: 'half', finishReason: 'length' }] })

    await submit(h, 'what happens to a truncated turn?')

    const transcript = await transcriptOf(h)
    expect(transcript[0]).toBe('what happens to a truncated turn?')
    expect(transcript).toHaveLength(2)
    expect(transcript[1]).toContain('cut off before it finished')
  })
})

/* ---------------------------------------------- tool calls are not truncation */

describe('a reply that stopped to ask for a tool', () => {
  it('is a tool observation, never a cut-off answer', async () => {
    // The exclusion that matters most. `tool_calls` is a normal finish reason: the
    // model did what it was asked to do and stopped to do it. Treating it as
    // truncation would fail every turn in which a lookup succeeded.
    const h = await harness({
      script: [
        { text: toolCall('web_search', { query: 'a thing' }), finishReason: 'tool_calls' },
        { text: 'here is what I found', finishReason: 'stop' },
      ],
    })

    const result = await submit(h)

    expect(result.outcome).toBe('completed')
    expect(h.provider.calls).toBe(2)
    expect(h.queries).toEqual(['a thing'])
    const answer = result.assistantMessage?.content ?? ''
    expect(answer).toContain('here is what I found')
    expect(answer).not.toContain('cut off')
  })
})

describe('a reply cut off while emitting a tool call', () => {
  it('is reported as truncation, and no tool runs on half-written arguments', async () => {
    // The subtle case. A strict parser would call this envelope "not closed", the
    // loop would tell the model its request could not be read, and the turn would
    // end as though Freya had merely made a formatting mistake — the silent
    // downgrade the finish reason exists to prevent.
    const h = await harness({
      script: [{ text: 'FREYA_TOOL_CALL\n{"tool":"web_search","query":"a th', finishReason: 'length' }],
    })

    const result = await submit(h)

    expect(result.outcome).toBe('failed')
    expect(result.reason).toContain('cut off before it finished')
    expect(h.queries).toEqual([])
    // No second call was spent trying to repair a reply known to be incomplete.
    expect(h.provider.calls).toBe(1)
    expect(result.assistantMessage?.content ?? '').toContain('cut off before it finished')
  })

  it('is reported as truncation even when the tool envelope happens to parse', async () => {
    // `length` means the budget ran out, so the arguments cannot be trusted to be
    // what the model meant to send, however complete they look. Executing a lookup
    // from them would be spending the owner's authority on a guess.
    const h = await harness({
      script: [{ text: toolCall('web_search', { query: 'a thing' }), finishReason: 'length' }],
    })

    const result = await submit(h)

    expect(result.outcome).toBe('failed')
    expect(h.queries).toEqual([])
    expect(result.assistantMessage?.content ?? '').toContain('cut off before it finished')
  })

  it('still reports the lookups it did complete before it was cut off', async () => {
    // A turn that looked something up and *then* ran out of room must not pretend
    // the lookup did not happen, and must not present the fragment as an answer.
    const h = await harness({
      script: [
        { text: toolCall('web_search', { query: 'a thing' }), finishReason: 'tool_calls' },
        { text: 'based on what I found, and then it cut', finishReason: 'length' },
      ],
    })

    const result = await submit(h)

    expect(result.outcome).toBe('failed')
    expect(h.queries).toEqual(['a thing'])
    const answer = result.assistantMessage?.content ?? ''
    expect(answer).toContain('based on what I found, and then it cut')
    expect(answer).toContain('web_search')
    expect(answer).toContain('cut off before it finished')
  })
})

/* ------------------------------------------------------- the notice itself */

describe('renderTruncatedAnswer', () => {
  it('never invents the missing text and never claims the answer is finished', () => {
    const rendered = renderTruncatedAnswer('it began')
    expect(rendered).toContain('it began')
    expect(rendered).toContain('cut off before it finished')
    expect(rendered).toContain('never generated')
    // No completion, no ellipsis standing in for one, no second attempt's words.
    expect(rendered).not.toContain('…')
    expect(rendered).not.toContain('...')
  })

  it('keeps a tool footer beside the notice when one exists', () => {
    const footer = '\n—\nWhat Freya did for this answer:\nUsed the "web_search" lookup and read 1 result.'
    const rendered = renderTruncatedAnswer('partial', footer)
    expect(rendered).toContain('Used the "web_search" lookup and read 1 result.')
    expect(rendered).toContain('cut off before it finished')
  })

  it('closes unclosed think tags so the notice is not swallowed into reasoning', () => {
    const unclosed = '<think>\nplanning a long response...'
    const rendered = renderTruncatedAnswer(unclosed)
    expect(rendered).toContain('</think>')
    const thinkEnd = rendered.indexOf('</think>')
    const noticeStart = rendered.indexOf('cut off before it finished')
    expect(thinkEnd).toBeGreaterThan(0)
    expect(noticeStart).toBeGreaterThan(thinkEnd)
  })
})