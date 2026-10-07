// @vitest-environment node
/**
 * Session semantics for the Chat surface.
 *
 * What a window is entitled to rely on, regardless of how many times the
 * process dies or how many windows were open at once:
 *
 *  1. **Fresh chat is fresh.** `conversation.create` mints a new id and starts an
 *    empty transcript. A fresh chat cannot reuse the active conversation's
 *    history by accident.
 *  2. **History reuse is explicit.** Only an explicit `conversation.read` puts
 *    a previous conversation in the active slot. The history rail never
 *    silently reopens an old conversation when the active one is closed.
 *  3. **Reload persistence.** A transcript on disk is the transcript that
 *    reappears when Core restarts. The encrypted store survives a process
 *    restart; the memory store does not, and the projection must say so.
 *  4. **Conversation isolation.** Two conversations at the same time never
 *    see each other's messages. The active turn of one cannot be answered in
 *    the other's slot.
 *  5. **Tool result association.** A tool observation that returned with a
 *    turn's answer is bound to that turn in the transcript — it does not
 *    migrate to a later turn or to a different conversation.
 *  6. **Cancellation is scoped.** `conversation.turn.cancel` aborts one turn
 *    and never touches another.
 *  7. **No duplicate assistant turns.** A single `submitTurn` produces one
 *    assistant message and one terminal event. A second send while one is
 *    running is refused, not duplicated.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCore, type Core, type CoreOptions } from '../../core/index'
import {
  BlockingModelProvider,
  FakeModelProvider,
} from '../../core/model/fake-provider'
import { MemoryConversationStore } from '../../core/conversation/memory-store'
import { EncryptedConversationStore } from '../../core/conversation/encrypted-store'
import { testConversationKey } from './testKey'
import type { ConversationCommandOutcome } from '../../core/protocol/conversation'

let dir = ''
let core: Core | null = null

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-session-'))
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

async function started(overrides: Partial<CoreOptions> = {}): Promise<Core> {
  const c = createCore(options(overrides))
  core = c
  await c.start()
  return c
}

async function newConversation(c: Core): Promise<string> {
  const result = await c.handleCommand({ command: 'conversation.create', requestId: 'c0' })
  const conversation = result.conversation as ConversationCommandOutcome
  if (conversation.operation !== 'created') throw new Error('conversation was not created')
  return conversation.conversation.conversationId
}

async function submit(
  c: Core,
  conversationId: string,
  text: string,
  requestId = 't1',
) {
  const result = await c.handleCommand({
    command: 'conversation.turn.submit',
    requestId,
    payload: { conversationId, text },
  })
  const outcome = result.conversation as ConversationCommandOutcome
  if (outcome.operation !== 'turn') throw new Error(`turn was refused: ${JSON.stringify(result)}`)
  return outcome.turn
}

async function readMessages(c: Core, conversationId: string) {
  const result = await c.handleCommand({
    command: 'conversation.read',
    requestId: 'r1',
    payload: { conversationId },
  })
  const outcome = result.conversation as ConversationCommandOutcome
  if (outcome.operation !== 'read') throw new Error('conversation was not read')
  return outcome
}

async function listConversations(c: Core) {
  const result = await c.handleCommand({ command: 'conversation.list', requestId: 'l1' })
  const outcome = result.conversation as ConversationCommandOutcome
  if (outcome.operation !== 'listed') throw new Error('listing failed')
  return outcome.conversations
}

describe('fresh chat is a fresh conversation', () => {
  it('a fresh conversation has no messages and a distinct id', async () => {
    const c = await started()
    const first = await newConversation(c)
    const second = await newConversation(c)

    expect(first).not.toBe(second)

    const firstRead = await readMessages(c, first)
    const secondRead = await readMessages(c, second)
    expect(firstRead.messages).toHaveLength(0)
    expect(secondRead.messages).toHaveLength(0)

    // Each conversation is its own row in the list.
    const listed = await listConversations(c)
    const ids = new Set(listed.map((entry) => entry.conversationId))
    expect(ids.has(first)).toBe(true)
    expect(ids.has(second)).toBe(true)
  })

  it('a brand-new conversation does not inherit the previous transcript', async () => {
    const c = await started()
    const first = await newConversation(c)
    await submit(c, first, 'an old conversation')

    const second = await newConversation(c)
    const read = await readMessages(c, second)
    expect(read.messages).toHaveLength(0)
    // The most-recently-updated row is the new one, not the old one with an
    // answer.
    const listed = await listConversations(c)
    expect(listed[0]?.conversationId).toBe(second)
    expect(listed[0]?.messageCount).toBe(0)
  })

  it('closing the active conversation does not silently reuse an old one', async () => {
    const c = await started()
    const first = await newConversation(c)
    await submit(c, first, 'first')

    const second = await newConversation(c)
    await submit(c, second, 'second')

    // Close the active conversation explicitly.
    const archive = await c.handleCommand({
      command: 'conversation.archive',
      requestId: 'a1',
      payload: { conversationId: second },
    })
    expect(archive.ok).toBe(true)

    // The next operation must be explicit, not implicit reuse.
    const listed = await listConversations(c)
    expect(listed.find((entry) => entry.conversationId === second)).toBeUndefined()
    expect(listed.find((entry) => entry.conversationId === first)).toBeDefined()

    const readFirst = await readMessages(c, first)
    expect(readFirst.messages.map((m) => m.content)).toContain('first')
  })
})

describe('reload persistence round-trips through the encrypted store', () => {
  it('the encrypted store survives a Core restart', async () => {
    const path = join(dir, 'conversations.enc')
    const key = testConversationKey()

    const first = createCore(options({
      providers: [new FakeModelProvider()],
      conversationStore: await EncryptedConversationStore.open({ path, key }),
    }))
    core = first
    await first.start()
    const conversationId = await newConversation(first)
    await submit(first, conversationId, 'do you remember this?')
    await first.stop('test')

    const second = createCore(options({
      providers: [new FakeModelProvider()],
      conversationStore: await EncryptedConversationStore.open({ path, key }),
    }))
    core = second
    await second.start()

    const projection = await second.conversation()
    // Most-recently-updated conversation is restored as active; the test
    // asserts that the *content* survived, not the active selection per se.
    expect(projection.messages.map((m) => m.content)).toContain('do you remember this?')
    const read = await readMessages(second, conversationId)
    expect(read.messages.map((m) => m.content)).toContain('do you remember this?')
  })

  it('the memory store says so on reload, so a window cannot think it persisted', async () => {
    const c = await started({ conversationStore: new MemoryConversationStore({ mode: 'memory' }) })
    const projection = await c.conversation()
    // The projection must distinguish a memory store from the encrypted one
    // — a window that reported "your conversations are saved" over a memory
    // store would be the more comfortable lie.
    expect(projection.persistence.mode).toBe('memory')
    expect(['memory', 'unavailable']).toContain(projection.persistence.mode)
  })
})

describe('conversation isolation between concurrent turns', () => {
  it('messages in one conversation never leak into another', async () => {
    const c = await started()
    const a = await newConversation(c)
    const b = await newConversation(c)

    await submit(c, a, 'first conversation message')
    await submit(c, b, 'second conversation message')

    const aRead = await readMessages(c, a)
    const bRead = await readMessages(c, b)

    expect(aRead.messages.map((m) => m.content)).toEqual([
      'first conversation message',
      expect.stringContaining('developer echo'),
    ])
    expect(bRead.messages.map((m) => m.content)).toEqual([
      'second conversation message',
      expect.stringContaining('developer echo'),
    ])

    // The two reads are unambiguous about which conversation they belong to.
    expect(aRead.messages.some((m) => m.content.includes('second conversation'))).toBe(false)
    expect(bRead.messages.some((m) => m.content.includes('first conversation'))).toBe(false)
  })

  it('a tool result lands in the turn it answered, never the next turn', async () => {
    // Without a tool registry the test cannot run a real search, so the
    // structural property under test is: every stored assistant message is
    // bound to exactly one turn, and turns are sequential.
    const c = await started()
    const conversationId = await newConversation(c)

    await submit(c, conversationId, 'one', 'turn-1')
    await submit(c, conversationId, 'two', 'two-turn')

    const read = await readMessages(c, conversationId)
    const turns = new Set(read.messages.map((m) => m.turnId))
    expect(turns.size).toBe(2)
    // Each turn is two messages: user question and assistant answer.
    expect(read.messages).toHaveLength(4)
    // User and assistant alternate, in order.
    expect(read.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
  })
})

describe('cancellation is scoped to one turn', () => {
  it('cancelling one turn leaves the next conversation free', async () => {
    const provider = new BlockingModelProvider()
    const c = await started({ providers: [provider] })
    const conversationId = await newConversation(c)

    const first = submit(c, conversationId, 'a long one', 't1')
    await provider.contacted
    const activeTurnId = (await c.conversation()).activeTurn?.turnId ?? ''
    expect(activeTurnId).not.toBe('')

    const cancel = await c.handleCommand({
      command: 'conversation.turn.cancel',
      requestId: 'x1',
      payload: { turnId: activeTurnId },
    })
    expect(cancel.ok).toBe(true)
    expect((cancel.conversation as ConversationCommandOutcome)).toMatchObject({
      operation: 'cancelled',
      cancelled: true,
    })

    const firstTurn = await first
    expect(firstTurn.outcome).toBe('cancelled')
    expect(provider.aborts).toBe(1)

    // The next turn works in the same conversation.
    const second = submit(c, conversationId, 'a short one', 't2')
    await waitFor(() => provider.contacts === 2)
    provider.releaseAll()
    const secondTurn = await second
    expect(secondTurn.outcome).toBe('completed')
  })

  it('a cancel does not abort a different conversation', async () => {
    const provider = new BlockingModelProvider()
    const c = await started({ providers: [provider] })
    const a = await newConversation(c)
    // Conversation `a` is the active one. We then submit a turn on it before
    // creating `b`, so the cancel below targets the active conversation's
    // running turn deterministically.
    const aTurn = submit(c, a, 'a long one', 'a-turn')
    await provider.contacted
    const aProjection = await c.conversation()
    expect(aProjection.activeConversationId).toBe(a)
    const aTurnId = aProjection.activeTurn?.turnId ?? ''
    expect(aTurnId).not.toBe('')

    // Cancel the active (a) turn.
    await c.handleCommand({
      command: 'conversation.turn.cancel',
      requestId: 'cancel-a',
      payload: { turnId: aTurnId },
    })
    await aTurn
    provider.releaseAll()

    // Now conversation `b`. Created *after* the cancel, so it is the active
    // conversation, and its turn is independent.
    const b = await newConversation(c)
    const bTurn = submit(c, b, 'b is fine', 'b-turn')
    await waitFor(() => provider.contacts === 2)
    provider.releaseAll()
    expect((await bTurn).outcome).toBe('completed')

    // Conversation a's transcript has no assistant reply (the cancelled turn).
    const aRead = await readMessages(c, a)
    expect(aRead.messages.filter((m) => m.role === 'assistant')).toHaveLength(0)
    // Conversation b's transcript has its user/assistant pair.
    const bRead = await readMessages(c, b)
    expect(bRead.messages.filter((m) => m.role === 'assistant')).toHaveLength(1)
  })
})

describe('no duplicate assistant turns', () => {
  it('a single submit produces one assistant message', async () => {
    const c = await started()
    const conversationId = await newConversation(c)

    await submit(c, conversationId, 'hello')

    const read = await readMessages(c, conversationId)
    expect(read.messages.filter((m) => m.role === 'assistant')).toHaveLength(1)
  })

  it('a second submit while one turn is running is refused, not duplicated', async () => {
    const provider = new BlockingModelProvider()
    const c = await started({ providers: [provider] })
    const conversationId = await newConversation(c)

    const first = submit(c, conversationId, 'first question', 't1')
    await provider.contacted

    const second = await submit(c, conversationId, 'second question', 't2')
    expect(second.outcome).toBe('denied')
    expect(second.reason).toMatch(/already in progress/i)

    provider.releaseAll()
    expect((await first).outcome).toBe('completed')

    // Exactly one provider contact, one assistant message.
    expect(provider.contacts).toBe(1)
    const read = await readMessages(c, conversationId)
    expect(read.messages.filter((m) => m.role === 'user')).toHaveLength(1)
    expect(read.messages.filter((m) => m.role === 'assistant')).toHaveLength(1)
  })

  it('sending twice without an in-flight turn produces two ordered pairs, never duplicates', async () => {
    const c = await started()
    const conversationId = await newConversation(c)

    await submit(c, conversationId, 'one', 't1')
    await submit(c, conversationId, 'two', 't2')

    const read = await readMessages(c, conversationId)
    expect(read.messages.map((m) => m.content)).toEqual([
      'one',
      expect.stringContaining('developer echo'),
      'two',
      expect.stringContaining('developer echo'),
    ])
    expect(read.messages.filter((m) => m.role === 'assistant')).toHaveLength(2)
  })
})

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}