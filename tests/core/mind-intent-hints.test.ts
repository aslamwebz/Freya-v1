// @vitest-environment node
/**
 * Mind-level regression tests for the structured-intent handover.
 *
 * The web-search and browser-use buttons used to **prepend** "find on the web: "
 * and "use your browser: " onto the owner's text. That changed the stored user
 * message. The Mind-level contract is now that:
 *
 *  - `text` reaches the conversation store exactly as the renderer sent it,
 *    with no directive added, removed or rewritten;
 *  - `intents` reaches the Mind as a separate object, and the Mind reads it to
 *    seed an initial tool call;
 *  - the conversation journal never sees a `text` field that disagrees with
 *    the store.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCore, type Core, type CoreOptions } from '../../core/index'
import { FakeModelProvider } from '../../core/model/fake-provider'
import { MemoryConversationStore } from '../../core/conversation/memory-store'
import type { ConversationCommandOutcome } from '../../core/protocol/conversation'

let dir = ''
let core: Core | null = null

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-mind-intent-'))
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

async function submitWithHints(
  c: Core,
  conversationId: string,
  text: string,
  intents: { readonly webSearch?: boolean; readonly browserUse?: boolean } | undefined,
  requestId = 't1',
) {
  const result = await c.handleCommand({
    command: 'conversation.turn.submit',
    requestId,
    payload: { conversationId, text, ...(intents !== undefined ? { intents } : {}) },
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

describe('a turn with intent hints stores the owner\'s exact text', () => {
  it('webSearch hint does not prepend "find on the web" to the stored user message', async () => {
    const c = await started()
    const conversationId = await newConversation(c)

    // The user message is stored *before* the turn spends anything on a
    // provider. Even when the turn outcome is not "completed" (e.g. the test
    // core has no tool registry wired, which is the normal Core without a
    // Searcher attached), the stored text is the text the renderer sent.
    const turn = await submitWithHints(c, conversationId, 'open the pricing page', { webSearch: true })
    expect(['completed', 'failed']).toContain(turn.outcome)

    const read = await readMessages(c, conversationId)
    expect(read.messages[0]?.role).toBe('user')
    expect(read.messages[0]?.content).toBe('open the pricing page')
    // The whole point of this file.
    expect(read.messages[0]?.content).not.toMatch(/find on the web/i)
    expect(read.messages[0]?.content).not.toMatch(/^.{0,32}: /)
  })

  it('browserUse hint with a URL does not prepend "use your browser" to the stored user message', async () => {
    const c = await started()
    const conversationId = await newConversation(c)

    const text = 'tell me what https://example.com/pricing says'
    const turn = await submitWithHints(c, conversationId, text, { browserUse: true })
    expect(['completed', 'failed']).toContain(turn.outcome)

    const read = await readMessages(c, conversationId)
    expect(read.messages[0]?.content).toBe(text)
    expect(read.messages[0]?.content).not.toMatch(/use your browser/i)
  })

  it('an empty hint set is identical to sending without hints', async () => {
    const c = await started()
    const conversationId = await newConversation(c)

    const plain = await submitWithHints(c, conversationId, 'explain recursion', undefined)
    expect(plain.outcome).toBe('completed')

    const conversationIdTwo = await newConversation(c)
    const empty = await submitWithHints(c, conversationIdTwo, 'explain recursion', {})
    expect(empty.outcome).toBe('completed')

    const readOne = await readMessages(c, conversationId)
    const readTwo = await readMessages(c, conversationIdTwo)
    expect(readOne.messages[0]?.content).toBe(readTwo.messages[0]?.content)
    expect(readOne.messages[0]?.content).toBe('explain recursion')
  })

  it('does not store the text as wrapped even when hints are present in the same payload', async () => {
    const c = await started()
    const conversationId = await newConversation(c)

    const text = 'give me a brief summary of the platform'
    await submitWithHints(c, conversationId, text, { webSearch: true, browserUse: false })

    const read = await readMessages(c, conversationId)
    expect(read.messages[0]?.content).toBe(text)
  })
})

describe('a turn with malformed hint payloads falls back to text-derived routing', () => {
  it('a non-boolean value on a hint key does not mutate the text', async () => {
    const c = await started()
    const conversationId = await newConversation(c)

    // A renderer that smuggles `webSearch: "yes"` would otherwise be a renderer
    // that decided to look something up. The Mind ignores the bad value.
    const text = 'explain how HTTP caching works'
    const result = await c.handleCommand({
      command: 'conversation.turn.submit',
      requestId: 'malformed',
      payload: { conversationId, text, intents: { webSearch: 'yes' as unknown as boolean } },
    })
    const outcome = result.conversation as ConversationCommandOutcome
    expect(outcome.operation).toBe('turn')

    const read = await readMessages(c, conversationId)
    expect(read.messages[0]?.content).toBe(text)
  })

  it('extra hint keys are silently dropped on the wire', async () => {
    const c = await started()
    const conversationId = await newConversation(c)

    const text = 'explain what a database index is'
    const result = await c.handleCommand({
      command: 'conversation.turn.submit',
      requestId: 'extra',
      payload: {
        conversationId,
        text,
        intents: {
          webSearch: false,
          // Smuggled keys do not reach the Mind. A renderer that could add
          // a key could add a routing rule.
          executeCapability: true as unknown as boolean,
        },
      },
    })
    const outcome = result.conversation as ConversationCommandOutcome
    expect(outcome.operation).toBe('turn')

    const read = await readMessages(c, conversationId)
    expect(read.messages[0]?.content).toBe(text)
  })
})