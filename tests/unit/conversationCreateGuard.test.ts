// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationProjection } from '../../core/protocol/conversation'
import type { CoreCommandResult } from '../../core/protocol/core-protocol'
import {
  createConversationMirror,
  resetConversationMirror,
} from '../../src/platform/conversationClient'

/*
 * One empty conversation at a time.
 *
 * Every New-chat button in every window goes through the mirror's `create`, so
 * the guard lives there: when the projection already shows a conversation with
 * no messages, pressing New selects that one instead of minting a twin that
 * would sit on the list indistinguishable forever.
 */

function projection(over: Partial<ConversationProjection> = {}): ConversationProjection {
  return {
    persistence: { mode: 'ephemeral', reason: 'test store' },
    conversations: [
      { conversationId: 'c1', title: 'Test chat', updatedAt: '2026-10-01T09:00:00.000Z', messageCount: 0, lastTurnOutcome: null },
    ],
    activeConversationId: 'c1',
    messages: [],
    activeTurn: null,
    cognition: { available: true, reason: null },
    stopAll: { active: false, activatedAt: null },
    maxMessageCharacters: 8000,
    faults: [],
    ...over,
  }
}

let current: ConversationProjection
let submitted: { command: string; payload?: unknown }[]

function mount(over: Partial<ConversationProjection> = {}): void {
  current = projection(over)
  submitted = []
  ;(window as unknown as { freyaHost: unknown }).freyaHost = {
    isDesktop: true,
    coreConversation: async () => current,
    onCoreConversation: (_listener: (p: ConversationProjection) => void) => () => {},
    coreSubmit: async (command: string, payload?: unknown): Promise<CoreCommandResult> => {
      submitted.push({ command, payload })
      return { requestId: 'r', ok: true }
    },
  }
}

beforeEach(() => {
  resetConversationMirror()
  ;(window as unknown as { freyaHost?: unknown }).freyaHost = undefined
})

afterEach(() => {
  resetConversationMirror()
  delete (window as unknown as { freyaHost?: unknown }).freyaHost
  vi.restoreAllMocks()
})

describe('the mirror will not duplicate an empty conversation', () => {
  it('creates a conversation only when nothing on the list is empty', async () => {
    mount({
      conversations: [
        { conversationId: 'c1', title: 'Saved', updatedAt: '2026-10-01T09:00:00.000Z', messageCount: 4, lastTurnOutcome: null },
      ],
      activeConversationId: 'c1',
    })
    const mirror = createConversationMirror()
    await mirror.attach()
    await mirror.create()
    expect(submitted.map((entry) => entry.command)).toEqual(['conversation.create'])
  })

  it('presses New nowhere when an empty conversation already exists', async () => {
    mount({ activeConversationId: 'c1' })
    const mirror = createConversationMirror()
    await mirror.attach()
    const outcome = await mirror.create()
    expect(outcome.operation).toBe('refused')
    expect(submitted).toEqual([])
  })

  it('selects the existing empty conversation when another is active', async () => {
    mount({
      conversations: [
        { conversationId: 'c1', title: 'Saved', updatedAt: '2026-10-01T09:00:00.000Z', messageCount: 4, lastTurnOutcome: null },
        { conversationId: 'c2', title: 'Fresh', updatedAt: '2026-10-01T09:30:00.000Z', messageCount: 0, lastTurnOutcome: null },
      ],
      activeConversationId: 'c1',
    })
    const mirror = createConversationMirror()
    await mirror.attach()
    await mirror.create()
    expect(submitted.map((entry) => entry.command)).toEqual(['conversation.read'])
    expect(submitted[0]?.payload).toEqual({ conversationId: 'c2' })
  })
})
