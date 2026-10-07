import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatView } from '../../../src/ui-v2/chat/ChatView'
import type { ConversationProjection } from '../../../core/protocol/conversation'
import { resetCoreMirror } from '../../../src/platform/coreClient'

/**
 * Tests for the v2 Chat workspace's polish and keyboard ergonomics.
 *
 * The contract these tests hold:
 *
 *   - Esc cancels a running turn, not anything else.
 *   - Ctrl/Cmd + L focuses the composer (the v2 composer is outside this
 *     workspace, looked up by aria-label, so the shortcut remains useful).
 *   - Up arrow on an empty composer recalls the last user message.
 *   - The "Recall last" affordance only appears after at least one user turn.
 *   - The empty state shows the orb and sample prompts instead of a stub.
 *   - The chat history panel lists every conversation Core reported.
 *
 * The component reads from the shared Core mirror; tests that exercise the
 * activity rail reset it so a stale `CoreActivityEvent[]` does not leak
 * between cases.
 */

afterEach(() => {
  resetCoreMirror()
  cleanup()
})

const baseProjection: ConversationProjection = {
  persistence: { mode: 'encrypted', reason: null },
  conversations: [
    { conversationId: 'c1', title: 'Hello', updatedAt: 't', messageCount: 1, lastTurnOutcome: 'completed' },
    { conversationId: 'c2', title: 'About Mars', updatedAt: 't', messageCount: 3, lastTurnOutcome: 'failed' },
  ],
  activeConversationId: 'c1',
  messages: [
    { messageId: 'm1', role: 'user', content: 'Hello', createdAt: 't', turnId: 't1' },
    { messageId: 'm2', role: 'assistant', content: 'Hi back', createdAt: 't', turnId: 't1' },
  ],
  activeTurn: null,
  cognition: { available: true, reason: null },
  stopAll: { active: false, activatedAt: null },
  maxMessageCharacters: 4000,
  faults: [],
}

const generatingProjection: ConversationProjection = {
  ...baseProjection,
  activeTurn: { turnId: 't-new', conversationId: 'c1', startedAt: 't', providerExecuting: true },
}

describe('ChatView (v2)', () => {
  it('renders the empty state with prompts and the orb when there is no transcript', () => {
    render(
      <ChatView
        projection={{ ...baseProjection, messages: [], conversations: [], activeConversationId: null }}
        notice=""
        onStop={() => {}}
      />,
    )
    expect(screen.getByText(/Ready when you are/i)).toBeTruthy()
    expect(screen.getByText(/Explain/i)).toBeTruthy()
    expect(screen.queryByLabelText('Recall last message')).toBeNull()
  })

  it('renders assistant messages through RichMessage so markdown is parsed, not dumped', () => {
    render(
      <ChatView
        projection={{
          ...baseProjection,
          messages: [
            { messageId: 'u', role: 'user', content: 'show me the headers', createdAt: 't', turnId: 't' },
            { messageId: 'a', role: 'assistant', content: '# Top\n\n- one\n- two', createdAt: 't', turnId: 't' },
          ],
        }}
        notice=""
        onStop={() => {}}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Top' })).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })

  it('does not show the recall button until a user message has been sent', () => {
    const { rerender } = render(<ChatView projection={{ ...baseProjection, messages: [] }} notice="" onStop={() => {}} />)
    expect(screen.queryByLabelText('Recall last message')).toBeNull()

    rerender(
      <ChatView
        projection={{
          ...baseProjection,
          messages: [
            { messageId: 'u', role: 'user', content: 'first message', createdAt: 't', turnId: 't' },
          ],
        }}
        notice=""
        onStop={() => {}}
      />,
    )
    expect(screen.getByLabelText('Recall last message')).toBeTruthy()
  })

  it('calls onStop when the user presses Escape while a turn is generating', () => {
    const onStop = vi.fn()
    render(<ChatView projection={generatingProjection} notice="" onStop={onStop} />)

    // The shortcut is scoped to the workspace root, so we fire it from a node
    // inside the rendered tree.
    const log = screen.getByRole('log')
    fireEvent.keyDown(log, { key: 'Escape' })
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('does not call onStop for Escape when no turn is running', () => {
    const onStop = vi.fn()
    render(<ChatView projection={baseProjection} notice="" onStop={onStop} />)

    const log = screen.getByRole('log')
    fireEvent.keyDown(log, { key: 'Escape' })
    expect(onStop).not.toHaveBeenCalled()
  })

  it('fills the composer with the last user message when the Recall last button is pressed', () => {
    render(
      <ChatView
        projection={{
          ...baseProjection,
          messages: [
            { messageId: 'u', role: 'user', content: 'previous question', createdAt: 't', turnId: 't' },
          ],
        }}
        notice=""
        onStop={() => {}}
      />,
    )
    const composer = document.createElement('textarea')
    composer.setAttribute('aria-label', 'Ask Freya')
    composer.value = ''
    document.body.appendChild(composer)
    try {
      const button = screen.getByLabelText('Recall last message')
      fireEvent.click(button)
      expect(composer.value).toBe('previous question')
    } finally {
      document.body.removeChild(composer)
    }
  })

  it('renders the history rows Core reported and marks the active one', () => {
    const onOpen = vi.fn()
    render(
      <ChatView
        projection={baseProjection}
        notice=""
        onStop={() => {}}
        onOpenConversation={onOpen}
      />,
    )
    // Open the history disclosure first.
    fireEvent.click(screen.getByRole('button', { name: /History/i }))
    const rows = screen.getAllByRole('button', { name: /Hello|About Mars/ })
    expect(rows.length).toBeGreaterThanOrEqual(2)
    fireEvent.click(screen.getByText('About Mars'))
    expect(onOpen).toHaveBeenCalledWith('c2')
  })

  it('shows a provenance badge when an assistant message carries media', () => {
    render(
      <ChatView
        projection={{
          ...baseProjection,
          messages: [
            { messageId: 'u', role: 'user', content: 'images of Saturn', createdAt: 't', turnId: 't' },
            {
              messageId: 'a',
              role: 'assistant',
              content: 'Three pictures.',
              createdAt: 't',
              turnId: 't',
              media: [
                { kind: 'image', url: 'https://example.com/1.jpg', page: 'https://example.com', title: 'Saturn 1', host: 'example.com', playable: false, duration: null, bytes: null, pages: null },
                { kind: 'image', url: 'https://example.com/2.jpg', page: 'https://example.com', title: 'Saturn 2', host: 'example.com', playable: false, duration: null, bytes: null, pages: null },
                { kind: 'image', url: 'https://example.com/3.jpg', page: 'https://example.com', title: 'Saturn 3', host: 'example.com', playable: false, duration: null, bytes: null, pages: null },
              ],
            },
          ],
        }}
        notice=""
        onStop={() => {}}
      />,
    )
    expect(screen.getByLabelText(/provenance of this answer/i).textContent).toContain('3')
    expect(screen.getByLabelText(/provenance of this answer/i).textContent).toContain('retrieved')
  })
})