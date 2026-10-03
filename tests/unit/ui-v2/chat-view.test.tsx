import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ChatView } from '../../../src/ui-v2/chat/ChatView'
import type { ConversationProjection } from '../../../core/protocol/conversation'

afterEach(cleanup)

function projection(overrides: Partial<ConversationProjection> = {}): ConversationProjection {
  return {
    persistence: { mode: 'encrypted', reason: null },
    conversations: [],
    activeConversationId: 'c1',
    messages: [],
    activeTurn: null,
    cognition: { available: true, reason: null },
    stopAll: { active: false, activatedAt: null },
    maxMessageCharacters: 4000,
    faults: [],
    ...overrides,
  }
}

describe('ChatView', () => {
  it('renders Core messages as plain text, labelled by role', () => {
    render(
      <ChatView
        projection={projection({
          messages: [
            { messageId: 'm1', role: 'user', content: 'Hi Freya', createdAt: 't', turnId: 'r1' },
            { messageId: 'm2', role: 'assistant', content: 'Hello — I am here.', createdAt: 't', turnId: 'r1' },
          ],
        })}
        notice=""
        onStop={() => {}}
      />,
    )
    expect(screen.getByText('Hi Freya')).toBeInTheDocument()
    expect(screen.getByText('Hello — I am here.')).toBeInTheDocument()
    expect(screen.getByText('You')).toBeInTheDocument()
    expect(screen.getByText('Freya')).toBeInTheDocument()
  })

  it('shows the running turn using Core’s own providerExecuting signal', () => {
    render(
      <ChatView
        projection={projection({
          activeTurn: { turnId: 'r1', conversationId: 'c1', startedAt: 't', providerExecuting: true },
        })}
        notice=""
        onStop={() => {}}
      />,
    )
    expect(screen.getByText('Thinking.')).toBeInTheDocument()
  })

  it('states the reason cognition is unavailable rather than pretending to wait', () => {
    render(
      <ChatView
        projection={projection({ cognition: { available: false, reason: 'No provider is configured.' } })}
        notice=""
        onStop={() => {}}
      />,
    )
    expect(screen.getByText('No provider is configured.')).toBeInTheDocument()
  })

  it('says it is waiting for Core when no projection has arrived', () => {
    render(<ChatView projection={null} notice="" onStop={() => {}} />)
    expect(screen.getByText(/waiting for freya core/i)).toBeInTheDocument()
  })
})
