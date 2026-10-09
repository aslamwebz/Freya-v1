import { afterEach, expect, it } from 'vitest'
import { conversationMirror, createConversationMirror, resetConversationMirror, restoreConversationSelection } from '../../../src/platform/conversationClient'
import type { ConversationProjection } from '../../../core/protocol/conversation'

const projection: ConversationProjection = {
  persistence: { mode: 'encrypted', reason: null }, conversations: [],
  activeConversationId: 'c1', messages: [], activeTurn: null,
  cognition: { available: true, reason: null }, stopAll: { active: false, activatedAt: null },
  maxMessageCharacters: 4000, faults: [],
}
afterEach(() => { resetConversationMirror(); delete (window as unknown as { freyaHost?: unknown }).freyaHost })

it('restores the saved selection through Core before the shell opens', async () => {
  let push!: (next: ConversationProjection) => void
  const older = { conversationId: 'older', title: 'Older selected chat', updatedAt: '2026-10-08T12:00:00Z', messageCount: 1, lastTurnOutcome: null }
  const stored = { ...projection, conversations: [older], activeConversationId: 'newest' }
  window.freyaHost = {
    isDesktop: true,
    onCoreConversation: (listener: typeof push) => { push = listener; return () => {} },
    coreConversation: async () => stored,
    coreSubmit: async (command: string, payload: { conversationId: string }) => {
      if (command !== 'conversation.read' || payload.conversationId !== 'older') throw new Error('Unexpected command')
      push({ ...stored, activeConversationId: 'older', messages: [{ messageId: 'old-message', turnId: 't1', role: 'user', content: 'Saved older transcript', createdAt: '2026-10-08T12:00:00Z' }] })
      return { conversation: { operation: 'read', conversation: older, messages: [] } }
    },
  } as unknown as typeof window.freyaHost
  await restoreConversationSelection('older')
  expect(conversationMirror().projection?.activeConversationId).toBe('older')
  expect(conversationMirror().projection?.messages[0]?.content).toBe('Saved older transcript')
})

it('keeps Core fallback selection when the saved conversation is no longer visible', async () => {
  window.freyaHost = {
    isDesktop: true, onCoreConversation: () => () => {}, coreConversation: async () => projection,
    coreSubmit: async () => { throw new Error('Must not open absent or archived history') },
  } as unknown as typeof window.freyaHost
  await restoreConversationSelection('archived')
  expect(conversationMirror().projection?.activeConversationId).toBe('c1')
})

it('restores selection when the desktop snapshot precedes Core startup', async () => {
  let push!: (next: ConversationProjection) => void
  const older = { conversationId: 'older', title: 'Saved thread', updatedAt: '2026-10-08T12:00:00Z', messageCount: 0, lastTurnOutcome: null }
  const ready = { ...projection, conversations: [older] }
  window.freyaHost = {
    isDesktop: true, coreConversation: async () => null,
    onCoreConversation: (listener: typeof push) => { push = listener; return () => {} },
    coreSubmit: async () => {
      push({ ...ready, activeConversationId: 'older' })
      return { conversation: { operation: 'read', conversation: older, messages: [] } }
    },
  } as unknown as typeof window.freyaHost
  const restoring = restoreConversationSelection('older')
  await new Promise<void>(done => setTimeout(done, 0))
  push(ready)
  await restoring
  expect(conversationMirror().projection?.activeConversationId).toBe('older')
})

it('keeps a pushed transcript when the initial snapshot finishes late', async () => {
  let push!: (next: ConversationProjection) => void
  let resolve!: (next: ConversationProjection) => void
  window.freyaHost = {
    isDesktop: true,
    onCoreConversation: (listener: typeof push) => { push = listener; return () => {} },
    coreConversation: () => new Promise<ConversationProjection>((done) => { resolve = done }),
  } as unknown as typeof window.freyaHost
  const mirror = createConversationMirror()
  const attaching = mirror.attach()
  push({ ...projection, messages: [{ messageId: 'm1', turnId: 't1', role: 'user', content: 'Keep this message', createdAt: '2026-10-09T12:00:00Z' }] })
  resolve(projection)
  await attaching
  expect(mirror.projection?.messages[0]?.content).toBe('Keep this message')
  mirror.reset()
})

it('reports failed attachment as an unavailable projection and allows reconnecting', async () => {
  let fail = true
  window.freyaHost = {
    isDesktop: true, onCoreConversation: () => () => {},
    coreConversation: async () => { if (fail) throw new Error('IPC disconnected'); return projection },
  } as unknown as typeof window.freyaHost
  const mirror = createConversationMirror()
  await expect(mirror.attach()).resolves.toBeTypeOf('function')
  expect(mirror.projection?.persistence.mode).toBe('unavailable')
  expect(mirror.projection?.faults.join(' ')).toContain('IPC disconnected')
  fail = false
  await mirror.attach()
  expect(mirror.projection?.persistence.mode).toBe('encrypted')
  mirror.reset()
})
