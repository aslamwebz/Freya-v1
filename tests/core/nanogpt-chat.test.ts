// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCore, type Core, type CoreOptions } from '../../core/index'
import {
  NanoGptProvider,
  readNanoGptConfig,
  type NanoGptConfig,
} from '../../core/model/nanogpt-provider'
import { CONVERSATION_LIMITS } from '../../core/conversation/types'
import type { CoreCommandName, CoreCommandResult } from '../../core/protocol/core-protocol'
import type { ConversationTurnView } from '../../core/protocol/conversation'

/**
 * NanoGPT as the real chat provider, through the seams that already exist.
 *
 * Everything here drives the *production* path — `handleCommand`, the Guard,
 * the Mind, the Governor, the Model Gateway, and the real `NanoGptProvider`
 * class — with only the transport replaced. A `fetchImpl` stands in for the
 * network; nothing else is faked. That makes each assertion a fact about the
 * shipped code rather than about a parallel test implementation:
 *
 *   - the catalogue is parsed from the OpenAI-compatible shape and junk is
 *     refused rather than rendered;
 *   - a selected model reaches the provider body of the *next* turn, and an
 *     unselectable one is refused before anything can be spent;
 *   - missing keys, provider errors and network failures all end in truthful
 *     turn outcomes, never an echo or a fabricated assistant message;
 *   - the credential exists in exactly one place — the transport header — and
 *     appears in no journal line, projection, activity row or transcript;
 *   - idle Freya performs zero calls, and even the catalogue waits for a
 *     person to ask;
 *   - a selection carries no power: budgets, STOP ALL and the compiled turn
 *     context behave exactly as they did before the selector existed.
 */

const SECRET = 'sk-test-never-echoed-8f2b'
const DEFAULT_MODEL = 'openai/gpt-4.1-nano'
const SELECTED_MODEL = 'anthropic/claude-sonnet-5'
const BASE_URL = 'https://nano-gpt.com/api/v1'

let dir = ''
let core: Core | null = null

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-nanogpt-chat-'))
})

afterEach(async () => {
  await core?.stop('test-teardown')
  core = null
  await rm(dir, { recursive: true, force: true })
})

function config(over: Partial<NanoGptConfig> = {}): NanoGptConfig {
  return {
    apiKey: SECRET,
    baseUrl: BASE_URL,
    model: DEFAULT_MODEL,
    liveEnabled: true,
    ...over,
  }
}

function options(over: Partial<CoreOptions> = {}): CoreOptions {
  return { dataPath: join(dir, 'events.jsonl'), ...over }
}

interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body?: Record<string, unknown>
}

/**
 * A transport that records what left the process and answers as directed.
 *
 * The headers are captured as a plain object because the assertion that matters
 * — the key appears *here and nowhere else* — cannot be made after the fact.
 */
function recordingFetch(
  reply: (call: RecordedCall, index: number) => Promise<Reply> | Reply,
): { calls: RecordedCall[]; impl: typeof fetch } {
  const calls: RecordedCall[] = []
  const impl = (async (url: unknown, init?: RequestInit) => {
    const record: RecordedCall = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      ),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    }
    calls.push(record)
    const answer = await reply(record, calls.length - 1)
    return {
      ok: answer.ok,
      status: answer.status,
      json: async () => answer.json,
    } as unknown as Response
  }) as unknown as typeof fetch
  return { calls, impl }
}

interface Reply {
  ok: boolean
  status: number
  json: unknown
}

function reply(json: unknown, ok = true, status = 200): Reply {
  return { ok, status, json }
}

function chatBody(model: string, text: string): Reply {
  return reply({
    model,
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 11, completion_tokens: 6 },
  })
}

const CATALOG_BODY = {
  object: 'list',
  data: [
    // The configured default is *not* a catalogue row: it is already the
    // "Provider default" option, and listing it twice would double-render it.
    { id: DEFAULT_MODEL, object: 'model', created: 1, owned_by: 'openai' },
    { id: SELECTED_MODEL, object: 'model', created: 2, owned_by: 'anthropic' },
    // Junk that must be refused by the parser rather than rendered or trusted.
    { object: 'model', created: 3 },
    { id: 'not-a-model-object', object: 'image', created: 4 },
    'a bare string',
    { id: SELECTED_MODEL, object: 'model', created: 5 },
    { id: 'x'.repeat(300), object: 'model', created: 6 },
  ],
}

function provider(fetchImpl: typeof fetch, cfg: NanoGptConfig | null = config()): NanoGptProvider {
  return new NanoGptProvider({ config: cfg, fetchImpl })
}

let requestCount = 0
function submit(core: Core, command: CoreCommandName, payload?: unknown): Promise<CoreCommandResult> {
  requestCount += 1
  return core.handleCommand({ command, requestId: `req-${requestCount}`, ...(payload === undefined ? {} : { payload }) })
}

async function createdConversationId(result: CoreCommandResult): Promise<string> {
  const outcome = result.conversation as { conversation?: { conversationId: string } } | undefined
  const id = outcome?.conversation?.conversationId
  if (typeof id !== 'string') throw new Error('conversation.create did not return a conversation')
  return id
}

function turnOf(result: CoreCommandResult): ConversationTurnView {
  const outcome = result.conversation as { turn?: ConversationTurnView } | undefined
  if (!outcome?.turn) throw new Error('expected a turn outcome')
  return outcome.turn
}

describe('readNanoGptConfig', () => {
  it('needs all three values and never guesses one', () => {
    expect(readNanoGptConfig({})).toBeNull()
    expect(readNanoGptConfig({ NANOGPT_API_KEY: 'k', NANOGPT_BASE_URL: 'https://x' })).toBeNull()
    expect(
      readNanoGptConfig({ NANOGPT_API_KEY: 'k', NANOGPT_BASE_URL: 'https://x', NANOGPT_MODEL: 'm' }),
    ).not.toBeNull()
    // Whitespace-only is absence, and the live flag is exact.
    expect(readNanoGptConfig({ NANOGPT_API_KEY: '  ', NANOGPT_BASE_URL: 'https://x', NANOGPT_MODEL: 'm' })).toBeNull()
    expect(
      readNanoGptConfig({ NANOGPT_API_KEY: 'k', NANOGPT_BASE_URL: 'https://x', NANOGPT_MODEL: 'm', FREYA_ALLOW_LIVE_MODEL: 'yes' })!
        .liveEnabled,
    ).toBe(false)
  })
})

describe('the model catalogue', () => {
  it('reads GET /models at the configured base, with the key in the header only', async () => {
    const fetch_ = recordingFetch(() => reply(CATALOG_BODY))
    core = createCore(options({ providers: [provider(fetch_.impl)] }))
    await core.start()

    const result = await submit(core, 'model.catalog.read')
    expect(result.ok).toBe(true)
    const outcome = result.model!
    expect(outcome.operation).toBe('catalog')
    expect(outcome.defaultModel).toBe(DEFAULT_MODEL)
    // Parsed, deduplicated, and junk-free: exactly the one valid, non-default id.
    expect(outcome.models).toEqual([{ id: SELECTED_MODEL, ownedBy: 'anthropic' }])

    expect(fetch_.calls).toHaveLength(1)
    const call = fetch_.calls[0]!
    // The documented base already carries /v1 — the path must not double it.
    expect(call.url).toBe(`${BASE_URL}/models`)
    expect(call.method).toBe('GET')
    expect(call.headers.authorization).toBe(`Bearer ${SECRET}`)
  })

  it('adds the /v1 segment only when the base omits it', async () => {
    const fetch_ = recordingFetch(() => reply(CATALOG_BODY))
    const bare = createCore(
      options({ providers: [provider(fetch_.impl, config({ baseUrl: 'https://nano-gpt.com/api' }))] }),
    )
    core = bare
    await bare.start()
    await submit(bare, 'model.catalog.read')
    expect(fetch_.calls[0]!.url).toBe('https://nano-gpt.com/api/v1/models')
  })

  it('refuses truthfully when there is no key, and never calls the network', async () => {
    const fetch_ = recordingFetch(() => reply(CATALOG_BODY))
    core = createCore(options({ providers: [provider(fetch_.impl, null)] }))
    await core.start()

    const result = await submit(core, 'model.catalog.read')
    expect(result.ok).toBe(false)
    expect(result.model!.operation).toBe('refused')
    expect(result.refusal!.reason).toMatch(/NANOGPT_API_KEY/)
    expect(fetch_.calls).toHaveLength(0)
  })

  it('names the status code, not the body, when the catalogue endpoint fails', async () => {
    const fetch_ = recordingFetch(() => reply({ error: `secret-bearing body ${SECRET}` }, false, 401))
    core = createCore(options({ providers: [provider(fetch_.impl)] }))
    await core.start()
    const result = await submit(core, 'model.catalog.read')
    expect(result.ok).toBe(false)
    expect(result.refusal!.reason).toMatch(/401/)
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })

  it('refuses a body whose data is not a list rather than rendering it', async () => {
    const fetch_ = recordingFetch(() => reply({ object: 'list', data: { id: 'not-an-array' } }))
    core = createCore(options({ providers: [provider(fetch_.impl)] }))
    await core.start()
    const result = await submit(core, 'model.catalog.read')
    expect(result.ok).toBe(false)
    expect(result.refusal!.reason).toMatch(/not a list/i)
  })
})

describe('the selected model reaches the provider', () => {
  it('sends the selection on subsequent turns and never replaces it with a default', async () => {
    const fetch_ = recordingFetch((call, index) =>
      call.url.endsWith('/models')
        ? reply(CATALOG_BODY)
        : chatBody(String((call.body as { model?: string })?.model ?? ''), `answer ${index}`),
    )
    core = createCore(options({ providers: [provider(fetch_.impl)] }))
    await core.start()

    const created = await submit(core, 'conversation.create', { title: 'chat' })
    const conversationId = await createdConversationId(created)

    // Turn one, no selection: the provider's own configured model answers.
    const first = turnOf(await submit(core, 'conversation.turn.submit', { conversationId, text: 'first question' }))
    expect(first.outcome).toBe('completed')
    const firstCall = fetch_.calls.find((call) => call.url.endsWith('/chat/completions'))!
    expect(firstCall.body!.model).toBe(DEFAULT_MODEL)

    // Select from the catalogue, then ask again: *this* turn carries the name.
    await submit(core, 'model.catalog.read')
    const selected = await submit(core, 'model.select', { model: SELECTED_MODEL })
    expect(selected.ok).toBe(true)
    expect(selected.model!.operation).toBe('selected')
    expect(selected.model!.selected).toBe(SELECTED_MODEL)

    const second = turnOf(await submit(core, 'conversation.turn.submit', { conversationId, text: 'second question' }))
    expect(second.outcome).toBe('completed')
    const secondCall = fetch_.calls.filter((call) => call.url.endsWith('/chat/completions'))[1]!
    expect(secondCall.body!.model).toBe(SELECTED_MODEL)
    expect(second.model).toBe(SELECTED_MODEL)

    // Clearing goes back to the default on the next turn, honestly.
    const cleared = await submit(core, 'model.select', {})
    expect(cleared.model!.selected).toBeNull()
    await submit(core, 'conversation.turn.submit', { conversationId, text: 'third question' })
    const thirdCall = fetch_.calls.filter((call) => call.url.endsWith('/chat/completions'))[2]!
    expect(thirdCall.body!.model).toBe(DEFAULT_MODEL)

    // The provider call is shaped like the API it claims to speak: bearer
    // header, completions path, and the code-owned output ceiling.
    expect(secondCall.headers.authorization).toBe(`Bearer ${SECRET}`)
    expect(secondCall.url).toBe(`${BASE_URL}/chat/completions`)
    expect(secondCall.body!.max_tokens).toBe(CONVERSATION_LIMITS.maxOutputTokensPerTurn)
  })

  it('refuses a model no configured provider can serve, keeps the old selection, and fails truthfully when the endpoint rejects it', async () => {
    let chatStatus = 200
    const fetch_ = recordingFetch((call) =>
      call.url.endsWith('/models')
        ? reply(CATALOG_BODY)
        : chatStatus === 200
          ? chatBody(String((call.body as { model?: string })?.model ?? ''), 'ok')
          : reply({ error: `The model ${(call.body as { model?: string })?.model} was not found` }, false, 404),
    )
    core = createCore(options({ providers: [provider(fetch_.impl)] }))
    await core.start()
    const created = await submit(core, 'conversation.create')
    const conversationId = await createdConversationId(created)

    // Before any catalogue exists, only the provider's own model is servable.
    const early = await submit(core, 'model.select', { model: SELECTED_MODEL })
    expect(early.ok).toBe(false)
    expect(early.refusal!.reason).toMatch(/can serve model/)

    await submit(core, 'model.catalog.read')
    const bogus = await submit(core, 'model.select', { model: 'not/a/listed/model' })
    expect(bogus.ok).toBe(false)
    expect(bogus.model!.operation).toBe('refused')

    await submit(core, 'model.select', { model: SELECTED_MODEL })
    // Malformed selections are refused at Core too, not only at the bridge.
    for (const bad of [{ model: 42 }, { model: 'x'.repeat(300) }, { model: '' }]) {
      const rejected = await submit(core, 'model.select', bad)
      expect(rejected.ok, JSON.stringify(bad)).toBe(false)
    }
    // The valid selection survived all of them: the next turn still carries it.
    const turn = turnOf(await submit(core, 'conversation.turn.submit', { conversationId, text: 'after refusals' }))
    expect(turn.outcome).toBe('completed')
    const chatCall = fetch_.calls.filter((call) => call.url.endsWith('/chat/completions')).at(-1)!
    expect(chatCall.body!.model).toBe(SELECTED_MODEL)

    // And when the endpoint itself rejects the model, the turn says so: failed,
    // provider contacted, no assistant message. Nothing is quietly answered
    // with the default model to make the failure look like success.
    chatStatus = 404
    const broken = turnOf(await submit(core, 'conversation.turn.submit', { conversationId, text: 'again' }))
    expect(broken.outcome).toBe('failed')
    expect(broken.reason).toMatch(/404/)
    expect(broken.providerContacted).toBe(true)
    expect(broken.assistantMessage).toBeNull()
    expect(chatStatus).toBe(404)
  })
})

describe('turn failures are truth', () => {
  it('a missing key refuses the turn before any provider exists', async () => {
    const fetch_ = recordingFetch(() => chatBody('m', 'should never run'))
    core = createCore(options({ providers: [provider(fetch_.impl, null)] }))
    await core.start()
    expect(core.status().providers[0]!.status).toBe('unconfigured')

    const created = await submit(core, 'conversation.create')
    const conversationId = await createdConversationId(created)
    const turn = turnOf(await submit(core, 'conversation.turn.submit', { conversationId, text: 'hello?' }))
    expect(turn.outcome).toBe('failed')
    expect(turn.reason).toMatch(/no configured provider/i)
    expect(turn.assistantMessage).toBeNull()
    expect(turn.providerContacted).toBe(false)
    expect(fetch_.calls).toHaveLength(0)
    expect(core.status().sessionUsage.calls).toBe(0)

    // And the transcript holds the question and no answer — not a fabricated one.
    const read = await submit(core, 'conversation.read', { conversationId })
    const messages = (read.conversation as { messages: { role: string; content: string }[] }).messages
    expect(messages.map((m) => m.role)).toEqual(['user'])
  })

  it('an HTTP error fails the turn with the provider named as contacted', async () => {
    const fetch_ = recordingFetch((call) =>
      call.url.endsWith('/models') ? reply(CATALOG_BODY) : reply({ error: 'server said things' }, false, 500),
    )
    core = createCore(options({ providers: [provider(fetch_.impl)] }))
    await core.start()
    const created = await submit(core, 'conversation.create')
    const conversationId = await createdConversationId(created)

    const turn = turnOf(await submit(core, 'conversation.turn.submit', { conversationId, text: 'hello?' }))
    expect(turn.outcome).toBe('failed')
    expect(turn.reason).toMatch(/500/)
    expect(turn.providerContacted).toBe(true)
    expect(turn.assistantMessage).toBeNull()
    // A contacted-then-failed call declares its usage a gap, not zero.
    expect(core.status().sessionUsage.unknownUsageCalls).toBe(1)
  })

  it('a network failure fails the turn and never retries', async () => {
    const fetch_ = recordingFetch(() => {
      throw new TypeError('fetch failed')
    })
    core = createCore(options({ providers: [provider(fetch_.impl)] }))
    await core.start()
    const created = await submit(core, 'conversation.create')
    const conversationId = await createdConversationId(created)
    const turn = turnOf(await submit(core, 'conversation.turn.submit', { conversationId, text: 'hello?' }))
    expect(turn.outcome).toBe('failed')
    expect(turn.assistantMessage).toBeNull()
    expect(fetch_.calls.filter((call) => call.url.endsWith('/chat/completions'))).toHaveLength(1)
  })
})

describe('real turns carry the compiled context', () => {
  it('the second turn sends identity, history and the current question', async () => {
    const fetch_ = recordingFetch((call, index) =>
      chatBody(String((call.body as { model?: string })?.model ?? ''), `reply ${index}`),
    )
    core = createCore(options({ providers: [provider(fetch_.impl)] }))
    await core.start()
    const created = await submit(core, 'conversation.create')
    const conversationId = await createdConversationId(created)

    await submit(core, 'conversation.turn.submit', { conversationId, text: 'what is the plan for tuesday' })
    await submit(core, 'conversation.turn.submit', { conversationId, text: 'and for wednesday' })

    const bodies = fetch_.calls
      .filter((call) => call.url.endsWith('/chat/completions'))
      .map((call) => call.body!.messages as { role: string; content: string }[])
    const second = bodies[1]!
    // Identity first, as a system turn; the first exchange as real history;
    // the new question last. This is the Phase 9 compiled packet arriving at
    // the provider, not a bare string with the selection bolted on.
    expect(second[0]!.role).toBe('system')
    expect(second.some((m) => m.role === 'user' && m.content.includes('what is the plan for tuesday'))).toBe(true)
    expect(second.some((m) => m.role === 'assistant' && m.content.includes('reply 0'))).toBe(true)
    expect(second.at(-1)!.content).toContain('and for wednesday')
    // The first turn had no history yet.
    expect(bodies[0]!.filter((m) => m.role === 'assistant')).toHaveLength(0)
  })
})

describe('idle Freya spends nothing', () => {
  it('boot, projections, status polling and a chat surface open no socket', async () => {
    const fetch_ = recordingFetch(() => reply(CATALOG_BODY))
    core = createCore(options({ providers: [provider(fetch_.impl)] }))
    await core.start()

    const status = core.status()
    expect(status.providers[0]!.status).toBe('configured')
    expect(status.activeProviderCalls).toBe(0)
    await core.conversation()
    core.activity()
    await submit(core, 'core.status.read')
    await submit(core, 'cognition.status.read')
    await submit(core, 'conversation.list')

    // Not one network touch — and that *includes* the catalogue: even a
    // metadata read happens only when a person commands it.
    expect(fetch_.calls).toHaveLength(0)
    expect(core.status().sessionUsage.calls).toBe(0)
    expect(core.status().activeProviderCalls).toBe(0)
  })
})

describe('the key exists only in the transport header', () => {
  it('no journal line, projection, activity row or transcript carries it', async () => {
    const fetch_ = recordingFetch((call) =>
      call.url.endsWith('/models')
        ? reply(CATALOG_BODY)
        : chatBody(String((call.body as { model?: string })?.model ?? ''), 'a secret-free answer'),
    )
    core = createCore(options({ providers: [provider(fetch_.impl)] }))
    await core.start()

    const created = await submit(core, 'conversation.create')
    const conversationId = await createdConversationId(created)
    await submit(core, 'model.catalog.read')
    await submit(core, 'model.select', { model: SELECTED_MODEL })
    const turn = turnOf(await submit(core, 'conversation.turn.submit', { conversationId, text: 'say something' }))
    expect(turn.outcome).toBe('completed')
    // A failing selection and a failing provider too: every error path must
    // be secret-free, and error text is exactly where echoes hide.
    await submit(core, 'model.select', { model: 'not/listed' })

    const journal = await readFile(join(dir, 'events.jsonl'), 'utf8')
    expect(journal).not.toContain(SECRET)
    expect(JSON.stringify(core.status())).not.toContain(SECRET)
    expect(JSON.stringify(core.activity())).not.toContain(SECRET)
    expect(JSON.stringify(await core.conversation())).not.toContain(SECRET)
    // Detail strings, refusal reasons, and the answer itself are all clean;
    // the only place the key appears at all is the recorded header.
    expect(fetch_.calls.some((call) => call.headers.authorization === `Bearer ${SECRET}`)).toBe(true)
    const bodyText = JSON.stringify(fetch_.calls.map((call) => call.body))
    expect(bodyText).not.toContain(SECRET)
  })
})

describe('a selection changes the model and nothing else', () => {
  it('STOP ALL still refuses every turn, selection set or not', async () => {
    const fetch_ = recordingFetch((call) =>
      call.url.endsWith('/models')
        ? reply(CATALOG_BODY)
        : chatBody(String((call.body as { model?: string })?.model ?? DEFAULT_MODEL), 'stopped soon'),
    )
    core = createCore(options({ providers: [provider(fetch_.impl)] }))
    await core.start()
    const created = await submit(core, 'conversation.create')
    const conversationId = await createdConversationId(created)
    await submit(core, 'model.catalog.read')
    await submit(core, 'model.select', { model: SELECTED_MODEL })

    const stop = await submit(core, 'security.stopAll', { reason: 'test latch' })
    expect(stop.ok).toBe(true)

    const after = await submit(core, 'conversation.turn.submit', { conversationId, text: 'anything?' })
    // The turn fails truthfully with the stop named — and the provider never
    // got the selection, because the selection is not authority. The user's
    // words are stored and the turn reports `denied`; nothing is asked for.
    expect(after.ok).toBe(true)
    const afterTurn = turnOf(after)
    expect(afterTurn.outcome).toBe('denied')
    expect(afterTurn.providerContacted).toBe(false)
    expect(afterTurn.assistantMessage).toBeNull()
    expect(fetch_.calls.filter((call) => call.url.endsWith('/chat/completions'))).toHaveLength(0)
    expect(core.status().activeProviderCalls).toBe(0)
  })

  it('commands cannot reach a provider except through a turn', async () => {
    const fetch_ = recordingFetch((call) =>
      call.url.endsWith('/models')
        ? reply(CATALOG_BODY)
        : chatBody(String((call.body as { model?: string })?.model ?? DEFAULT_MODEL), 'plain'),
    )
    core = createCore(options({ providers: [provider(fetch_.impl)] }))
    await core.start()
    // A turn payload that *names* a model is read as text fields only — the
    // window has no `model` argument on `conversation.turn.submit`, and adding
    // one to the payload changes nothing about what reaches the provider.
    const created = await submit(core, 'conversation.create')
    const conversationId = await createdConversationId(created)
    await submit(core, 'conversation.turn.submit', { conversationId, text: 'hi', model: 'injected/model' })
    const chatCall = fetch_.calls.find((call) => call.url.endsWith('/chat/completions'))!
    // The provider sees the default because no selection was ever made through
    // `model.select` — not the string that arrived beside the text.
    expect(chatCall.body!.model).toBe(DEFAULT_MODEL)
  })
})
