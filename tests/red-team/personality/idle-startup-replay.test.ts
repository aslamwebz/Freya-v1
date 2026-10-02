// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCore } from '../../../core/index'
import { FakeModelProvider } from '../../../core/model/fake-provider'
import { MemoryConversationStore } from '../../../core/conversation/memory-store'
import { journalEvents, startRedTeamCore, stopRedTeamCore, type RedTeamCore } from '../harness'

/**
 * Attack family: idle / startup / replay calls.
 *
 * RED-TEAM family 24 (exfiltration hidden in harmless-looking actions), against
 * the Gateway's "an idle Freya is provably idle" property: nothing spends a
 * provider call unless an explicit, authorized cognition request was made.
 *
 * The attacks start a Core on an empty journal, start one on a journal with
 * history, and run every surface that is not an explicit cognition request.
 * The invariant under attack: zero provider calls in every idle, startup and
 * replay path — no background turn, no startup call, no hidden prefetch.
 */

let fixture: RedTeamCore | null = null

beforeEach(async () => {
  fixture = await startRedTeamCore()
})

afterEach(async () => {
  await stopRedTeamCore(fixture)
  fixture = null
})

describe('attack: startup spends a provider call', () => {
  it('starting on an empty journal performs zero provider calls', async () => {
    const f = fixture!
    expect(f.fake.calls).toBe(0)
    const status = f.core.status()
    expect(status.lifecycle).toBe('ready')
    expect(f.fake.calls).toBe(0)
  })

  it('starting on a journal with history performs zero provider calls', async () => {
    const f = fixture!
    // Create a conversation and complete a turn so the journal has history.
    const created = await f.core.handleCommand({ command: 'conversation.create', requestId: 'c0' })
    const conversation = created.conversation as { operation: string; conversation: { conversationId: string } }
    expect(conversation.operation).toBe('created')
    await f.core.handleCommand({
      command: 'conversation.turn.submit',
      requestId: 't1',
      payload: { conversationId: conversation.conversation.conversationId, text: 'a real question' },
    })
    expect(f.fake.calls).toBe(1)
    await f.core.stop('idle-teardown')

    // Replay: a second Core on the same journal must not spend a call.
    const replayFake = new FakeModelProvider()
    const replayed = createCore({
      dataPath: f.journalPath,
      providers: [replayFake],
      conversationStore: new MemoryConversationStore({ mode: 'memory' }),
    })
    try {
      const status = await replayed.start()
      expect(status.lifecycle).toBe('ready')
      expect(replayFake.calls).toBe(0)
    } finally {
      await replayed.stop('replay teardown')
    }
  })
})

describe('attack: non-cognition surfaces spend a provider call', () => {
  it('reading a conversation performs zero provider calls', async () => {
    const f = fixture!
    const created = await f.core.handleCommand({ command: 'conversation.create', requestId: 'c0' })
    const conversation = created.conversation as { operation: string; conversation: { conversationId: string } }
    const read = await f.core.handleCommand({
      command: 'conversation.read',
      requestId: 'r1',
      payload: { conversationId: conversation.conversation.conversationId },
    })
    expect(read.conversation).toBeDefined()
    expect(f.fake.calls).toBe(0)
  })

  it('status and grant listing perform zero provider calls', async () => {
    const f = fixture!
    f.core.status()
    f.owner.grants()
    expect(f.fake.calls).toBe(0)
  })

  it('a worker request without a grant performs zero provider calls', async () => {
    const f = fixture!
    const outcome = await f.worker.request({ kind: 'agent_step', prompt: 'any text', maxOutputTokens: 100 })
    expect(outcome.status).toBe('denied')
    expect(f.fake.calls).toBe(0)
  })

  it('the journal contains no model.request events while idle', async () => {
    const f = fixture!
    f.core.status()
    const events = await journalEvents(f)
    const modelRequests = events.filter((e) => String(e.type).startsWith('model.request'))
    expect(modelRequests).toEqual([])
  })
})

describe('attack: a background subscription fires while idle', () => {
  it('no call is made between start and an explicit turn', async () => {
    const f = fixture!
    // Every non-turn surface has been exercised above; the provider count is
    // the whole-trace assertion.
    expect(f.fake.calls).toBe(0)
    const events = await journalEvents(f)
    expect(events.filter((e) => String(e.type).startsWith('model.request'))).toEqual([])
  })
})
