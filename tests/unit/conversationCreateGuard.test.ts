// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationProjection } from '../../core/protocol/conversation'
import type { CoreCommandResult } from '../../core/protocol/core-protocol'
import {
  createConversationMirror,
  resetConversationMirror,
} from '../../src/platform/conversationClient'

function projection(over: Partial<ConversationProjection> = {}): ConversationProjection {
  return {
    persistence: { mode: 'ephemeral', reason: 'test store' },
    conversations: [
      { conversationId: 'c1', title: 'Saved', updatedAt: '2026-10-01T09:00:00.000Z', messageCount: 4, lastTurnOutcome: null },
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

describe('new conversation semantics', () => {
  it('always asks Core to create a new conversation', async () => {
    mount()
    const mirror = createConversationMirror()
    await mirror.attach()
    await mirror.create()
    expect(submitted).toEqual([{ command: 'conversation.create', payload: undefined }])
  })

  it('does not reuse an existing empty conversation automatically', async () => {
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
    expect(submitted).toEqual([{ command: 'conversation.create', payload: undefined }])
  })

  it('reuses history only through an explicit read', async () => {
    mount()
    const mirror = createConversationMirror()
    await mirror.attach()
    await mirror.read('c1')
    expect(submitted).toEqual([{ command: 'conversation.read', payload: { conversationId: 'c1' } }])
  })
})
