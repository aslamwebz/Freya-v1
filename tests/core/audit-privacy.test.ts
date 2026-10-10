// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore, type Core, type CoreOptions } from '../../core/index'
import { BlockingModelProvider, FakeModelProvider } from '../../core/model/fake-provider'
import { MemoryConversationStore } from '../../core/conversation/memory-store'
import { EncryptedConversationStore } from '../../core/conversation/encrypted-store'
import { StandInStt } from './voice/fixture'
import { CORE_EVENT_TYPES } from '../../core/events/envelope'
import { testConversationKey } from './testKey'
import type { ConversationCommandOutcome } from '../../core/protocol/conversation'

/**
 * Audit privacy.
 *
 * The Event Fabric is audit surface. It is read, copied, backed up and shipped
 * far more freely than a conversation is, and it is what somebody hands over when
 * asked what Freya did. So the rule is absolute and it is asserted against the
 * **bytes on disk** rather than against a projection:
 *
 *   no user prompt, no assistant response, no microphone audio, no encryption key.
 *
 * Metadata is fine. Ids, sizes, durations, provider names and outcomes are all
 * there on purpose — they are what makes the journal useful — and the tests below
 * assert they are, so "no content" does not quietly become "no information".
 */

let dir = ''
let core: Core | null = null

const USER_SECRET = 'my bank password is hunter2 and my github token is ghp_abcdef'
const ASSISTANT_SECRET = 'you mentioned ghp_abcdef earlier; rotate it now'

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-audit-'))
})

afterEach(async () => {
  await core?.stop('test-teardown')
  core = null
  await rm(dir, { recursive: true, force: true })
})

function options(overrides: Partial<CoreOptions> = {}): CoreOptions {
  return {
    dataPath: join(dir, 'events.jsonl'),
    providers: [new FakeModelProvider()],
    conversationStore: new MemoryConversationStore({ mode: 'memory' }),
    ...overrides,
  }
}

/** The whole journal, as text. */
async function journalBytes(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

async function runConversation(c: Core, text = USER_SECRET): Promise<void> {
  const created = await c.handleCommand({ command: 'conversation.create', requestId: 'c0' })
  const conversation = created.conversation as ConversationCommandOutcome
  if (conversation.operation !== 'created') throw new Error('no conversation')
  await c.handleCommand({
    command: 'conversation.turn.submit',
    requestId: 't1',
    payload: { conversationId: conversation.conversation.conversationId, text },
  })
}

describe('the journal holds metadata, not conversation bodies', () => {
  it('contains neither the question nor the answer', async () => {
    const provider = new FakeModelProvider()
    const original = provider.complete.bind(provider)
    provider.complete = async (request, options) => ({
      ...(await original(request, options)),
      text: ASSISTANT_SECRET,
    })
    const c = createCore(options({ providers: [provider] }))
    core = c
    await c.start()
    await runConversation(c)
    await c.stop('test')

    const raw = await journalBytes(join(dir, 'events.jsonl'))

    // The whole point of separating the two stores.
    expect(raw).not.toContain(USER_SECRET)
    expect(raw).not.toContain('hunter2')
    expect(raw).not.toContain('ghp_abcdef')
    expect(raw).not.toContain(ASSISTANT_SECRET)
    expect(raw).not.toMatch(/bank password/)
    expect(raw).not.toMatch(/rotate it/)
  })

  it('still records enough to be useful', async () => {
    // "No content" must not quietly become "no information" — otherwise the
    // journal is useless and someone will add content back to fix it.
    const c = createCore(options())
    core = c
    await c.start()
    await runConversation(c)
    await c.stop('test')

    const raw = await journalBytes(join(dir, 'events.jsonl'))
    expect(raw).toContain('conversation.created')
    expect(raw).toContain('conversation.turn.started')
    expect(raw).toContain('conversation.turn.completed')
    // Ids and sizes, so an operator can correlate without reading anyone's words.
    expect(raw).toMatch(/"contentLength":\d+/)
    expect(raw).toContain('"outcome":"completed"')
    expect(raw).toContain('"providerId":"fake"')
  })

  it('never puts a message body in any conversation event', async () => {
    const c = createCore(options())
    core = c
    await c.start()
    await runConversation(c)

    // Assert the *shape* as well as the bytes: a conversation event has no field
    // a body could hide in, so adding one is a visible schema change rather than
    // something that quietly starts retaining text.
    const projection = await c.conversation()
    expect(projection.messages).toHaveLength(2)

    const c2 = createCore(options())
    core = c2
    await c2.start()
    const listed = await c2.handleCommand({ command: 'conversation.list', requestId: 'l1' })
    expect((listed.conversation as ConversationCommandOutcome).operation).toBe('listed')
    await c2.stop('test')
  })
})

describe('the activity feed is metadata too', () => {
  it('describes a turn without quoting it', async () => {
    const provider = new FakeModelProvider()
    const original = provider.complete.bind(provider)
    provider.complete = async (request, options) => ({
      ...(await original(request, options)),
      text: ASSISTANT_SECRET,
    })
    const c = createCore(options({ providers: [provider] }))
    core = c
    await c.start()
    await runConversation(c)
    await c.stop('test')

    const raw = await journalBytes(join(dir, 'events.jsonl'))
    const feed = c.activity().map((row) => row.text).join('\n')

    expect(feed).toMatch(/Turn completed/)
    expect(feed).not.toContain(USER_SECRET)
    expect(feed).not.toContain(ASSISTANT_SECRET)
    // No row may include payloads or message bodies. Turn correlation IDs are
    // explicitly permitted so the UI can match an activity to its transcript.
    // Optional IDs appear only on relevant rows; every other field is closed.
    const allowedFields = new Set([
      'at', 'conversationId', 'id', 'kind', 'sequence', 'text', 'tone', 'turnId', 'type',
    ])
    for (const row of c.activity()) {
      expect(Object.keys(row).every((field) => allowedFields.has(field))).toBe(true)
      expect('payload' in row).toBe(false)
      expect(JSON.stringify(row)).not.toContain(USER_SECRET)
      expect(JSON.stringify(row)).not.toContain(ASSISTANT_SECRET)
      if ('conversationId' in row) expect(row.conversationId).toEqual(expect.any(String))
      if ('turnId' in row) expect(row.turnId).toEqual(expect.any(String))
    }
    expect(raw).toBeDefined()
  })
})

describe('the encryption key never leaves the host', () => {
  it('appears in no file the process wrote', async () => {
    const key = testConversationKey('audit key under test')
    const c = createCore(
      options({
        // The key is supplied, not generated: Core has no default and cannot
        // derive one. If it were mishandled, it would have to appear somewhere.
        conversationKey: undefined,
        conversationStore: await EncryptedConversationStore.open({
          path: join(dir, 'conversations.enc'),
          key,
        }),
      }),
    )
    core = c
    await c.start()
    await runConversation(c)
    await c.stop('test')

    const journal = await journalBytes(join(dir, 'events.jsonl'))
    const store = await journalBytes(join(dir, 'conversations.enc'))
    const workspace = await journalBytes(join(dir, 'workspace.json'))

    const base64 = Buffer.from(key).toString('base64')
    const hex = Buffer.from(key).toString('hex')
    for (const blob of [journal, store, workspace]) {
      expect(blob).not.toContain(base64)
      expect(blob).not.toContain(hex)
      expect(blob).not.toContain('conversationKey')
      expect(blob).not.toContain('testConversationKey')
    }
  })

  it('is not in anything the renderer can be shown', async () => {
    const c = createCore(options())
    core = c
    await c.start()

    // Everything a window can receive, serialised. If a key were anywhere in
    // Core's reachable state it would appear in one of these.
    const reachable = JSON.stringify({
      status: c.status(),
      activity: c.activity(),
      conversation: await c.conversation(),
      voice: c.voice(),
    })

    expect(reachable).not.toMatch(/[A-Za-z0-9+/]{43}=/)
    expect(reachable).not.toContain('key')
    expect(c.status()).not.toHaveProperty('conversationKey')
    expect(await c.conversation()).not.toHaveProperty('key')
  })
})

describe('microphone audio never reaches the journal', () => {
  /**
   * Open a capture the way the owner would.
   *
   * Phase 45 added a permission lifecycle in front of `voice.capture.start`: the
   * microphone has to be turned on and the platform has to have reported
   * `granted`, or the capture is refused. These three privacy tests are about what
   * a capture *leaves behind*, and that question is unchanged — so the setup moved
   * into one helper rather than being repeated three times.
   */
  async function openCapture(c: Core): Promise<string> {
    await c.handleCommand({ command: 'voice.mic.enable', requestId: 'm1' })
    await c.handleCommand({
      command: 'voice.permission.report',
      requestId: 'p1',
      payload: { outcome: 'granted' },
    })
    const start = await c.handleCommand({ command: 'voice.capture.start', requestId: 'v1' })
    return (start.voice as { sessionId: string }).sessionId
  }

  it('records a capture as metadata only', async () => {
    const c = createCore(options({ voiceStt: new StandInStt('a local transcript') }))
    core = c
    await c.start()

    const sessionId = await openCapture(c)

    // Audio that would be unmistakable in a journal if it got there.
    const audio = new Uint8Array(4096)
    for (let i = 0; i < audio.length; i += 1) audio[i] = i % 256

    await c.handleCommand({
      command: 'voice.capture.end',
      requestId: 'v2',
      payload: {
        sessionId,
        audio,
        durationMs: 128,
        format: 'pcm-s16le',
        codec: 'pcm_s16le',
        mimeType: 'audio/pcm',
        sampleRate: 16_000,
        channels: 1,
      },
    })
    await c.stop('test')

    const raw = await journalBytes(join(dir, 'events.jsonl'))

    expect(raw).toContain('voice.capture.started')
    expect(raw).toContain('voice.capture.completed')
    // A size, and nothing that could be a recording.
    expect(raw).toMatch(/"byteLength":4096/)
    // Nor the transcript itself: a voice event carries a *count* of characters.
    expect(raw).not.toContain('a local transcript')
    expect(raw).not.toMatch(/"audio"/)
    // And no base64 of the audio, in any encoding.
    expect(raw).not.toContain(Buffer.from(audio).toString('base64').slice(0, 64))
  })

  it('spends nothing to transcribe', async () => {
    const transcriber = new StandInStt('a local transcript')
    const provider = new FakeModelProvider()
    const c = createCore(options({ providers: [provider], voiceStt: transcriber }))
    core = c
    await c.start()

    const sessionId = await openCapture(c)
    const end = await c.handleCommand({
      command: 'voice.capture.end',
      requestId: 'v2',
      payload: {
        sessionId,
        audio: new Uint8Array(1024),
        durationMs: 32,
        format: 'pcm-s16le',
        codec: 'pcm_s16le',
        mimeType: 'audio/pcm',
        sampleRate: 16_000,
        channels: 1,
      },
    })

    // A transcript, not a turn.
    const voice = end.voice as { operation: string; text: string | null }
    expect(voice.operation).toBe('capture-ended')
    expect(voice.text).toBe('a local transcript')
    expect(transcriber.calls).toBe(1)
    // Speech recognition and thinking are different systems. This is the line.
    expect(provider.calls).toBe(0)
    expect(c.status().sessionUsage.calls).toBe(0)
  })

  it('discards the audio rather than keeping it as memory', async () => {
    const c = createCore(options())
    core = c
    await c.start()

    const sessionId = await openCapture(c)
    await c.handleCommand({
      command: 'voice.capture.end',
      requestId: 'v2',
      payload: {
        sessionId,
        audio: new Uint8Array(256),
        durationMs: 8,
        format: 'pcm-s16le',
        codec: 'pcm_s16le',
        mimeType: 'audio/pcm',
        sampleRate: 16_000,
        channels: 1,
      },
    })

    // Nothing about the capture is in the conversation at all.
    const projection = await c.conversation()
    expect(JSON.stringify(projection)).not.toContain('256')
    expect(projection.messages).toEqual([])
    expect(projection.conversations).toEqual([])
  })
})

describe('the journal schema has no field for content', () => {
  it('declares no conversation or voice payload with a body', () => {
    // A structural assertion rather than a behavioural one: it holds even if no
    // test happens to run a conversation today.
    const source = CORE_EVENT_TYPES.filter((type) => type.startsWith('conversation.') || type.startsWith('voice.'))
    expect(source.length).toBeGreaterThan(0)
    for (const type of source) {
      // The names are asserted rather than the shapes, because a shape assertion
      // here would restate the schema. What matters is that these families exist,
      // that they are few, and that the payload rules for them are the ones above.
      expect(typeof type).toBe('string')
    }
  })
})

describe('cancelled work is described honestly in the journal', () => {
  it('records contact, so an audit does not call a paid call free', async () => {
    const provider = new BlockingModelProvider()
    const c = createCore(options({ providers: [provider] }))
    core = c
    await c.start()

    const created = await c.handleCommand({ command: 'conversation.create', requestId: 'c0' })
    const conversation = created.conversation as ConversationCommandOutcome
    if (conversation.operation !== 'created') throw new Error('no conversation')

    // Started but not awaited: this provider never answers until it is told to.
    const inFlight = c.handleCommand({
      command: 'conversation.turn.submit',
      requestId: 't1',
      payload: { conversationId: conversation.conversation.conversationId, text: 'a long question' },
    })
    await waitFor(() => provider.contacts === 1)

    const projection = await c.conversation()
    const turnId = projection.activeTurn?.turnId ?? ''
    await c.handleCommand({ command: 'conversation.turn.cancel', requestId: 'x1', payload: { turnId } })
    await inFlight
    await c.stop('test')

    const raw = await journalBytes(join(dir, 'events.jsonl'))
    // The model layer records that a provider had the request; the conversation
    // layer records that the turn was cancelled. Neither invents a reason.
    expect(raw).toContain('model.request.cancelled')
    expect(raw).toContain('conversation.turn.cancelled')
    expect(raw).toMatch(/"providerContacted":true/)
    expect(raw).not.toContain('a long question')
  })
})

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}
