import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ChatHistory } from '../../../src/app/chat/ChatHistory'
import { ensureConversationAttached, resetConversationMirror } from '../../../src/platform/conversationClient'
import type { ConversationProjection } from '../../../core/protocol/conversation'

let fail = false
const saved: ConversationProjection = {
  persistence: { mode: 'encrypted', reason: null },
  conversations: [
    { conversationId: 'c1', title: 'Saturn research', updatedAt: '2026-10-09T12:00:00Z', messageCount: 2, lastTurnOutcome: 'completed' },
    { conversationId: 'c2', title: 'Writing ideas', updatedAt: '2026-10-09T11:00:00Z', messageCount: 0, lastTurnOutcome: null },
  ], activeConversationId: 'c1', messages: [], activeTurn: null,
  cognition: { available: true, reason: null }, stopAll: { active: false, activatedAt: null }, maxMessageCharacters: 4000, faults: [],
}
beforeEach(async () => {
  fail = false
  resetConversationMirror()
  window.freyaHost = {
    isDesktop: true, coreConversation: async () => saved, onCoreConversation: () => () => {},
    coreSubmit: async (command: string) => ({ requestId: 'r', ok: !fail,
      conversation: fail ? { operation: 'refused', reason: 'Vault temporarily unavailable' }
        : command === 'conversation.read' ? { operation: 'read', conversation: saved.conversations[0], messages: [] }
          : { operation: 'listed', conversations: saved.conversations },
    }),
  } as unknown as typeof window.freyaHost
  await ensureConversationAttached()
})
afterEach(() => { cleanup(); resetConversationMirror(); delete (window as unknown as { freyaHost?: unknown }).freyaHost })

it('filters saved titles without changing the active conversation', async () => {
  render(<ChatHistory current />)
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search conversations' }), { target: { value: 'SATURN' } })
  expect(screen.getByRole('button', { name: 'Saturn research' })).toHaveAttribute('aria-current', 'true')
  expect(screen.queryByRole('button', { name: 'Writing ideas' })).toBeNull()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'unmatched' } })
  expect(screen.getByText(/no matching conversations/i)).toBeInTheDocument()
})

it('stays on the current screen and shows the reason when opening history is refused', async () => {
  const open = vi.fn()
  render(<ChatHistory onOpen={open} />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Saturn research' })).toBeEnabled())
  fail = true
  fireEvent.click(screen.getByRole('button', { name: 'Saturn research' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Vault temporarily unavailable')
  expect(open).not.toHaveBeenCalled()
})

it('provides inline rename with cancel that preserves the saved title', () => {
  render(<ChatHistory current />)
  fireEvent.click(screen.getByRole('button', { name: 'Rename Saturn research' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Conversation title' }), { target: { value: 'Rings' } })
  fireEvent.click(screen.getByRole('button', { name: 'Cancel rename' }))
  expect(screen.getByRole('button', { name: 'Saturn research' })).toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: 'Conversation title' })).toBeNull()
})
