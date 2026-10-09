import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { Chats } from '../../../src/app/chat/Chats'
import { ensureConversationAttached, resetConversationMirror } from '../../../src/platform/conversationClient'
import { resetCoreMirror } from '../../../src/platform/coreClient'
import type { ConversationProjection } from '../../../core/protocol/conversation'

afterEach(() => { cleanup(); resetConversationMirror(); resetCoreMirror(); delete window.freyaHost })
it('renders typed tool steps on an assistant turn with no media, sources or charts', async () => {
  const projection: ConversationProjection = {
    persistence: { mode: 'encrypted', reason: null }, conversations: [], activeConversationId: 'c1',
    messages: [{ messageId: 'm1', turnId: 't1', role: 'assistant', content: 'The browser request was blocked.', createdAt: '2026-10-09T12:00:00Z',
      steps: [{ index: 1, tool: 'browser_tabs', capability: 'browser.read', outcome: 'denied', executed: false, sourceCount: 0 }] }],
    activeTurn: null, cognition: { available: true, reason: null }, stopAll: { active: false, activatedAt: null }, maxMessageCharacters: 4000, faults: [],
  }
  window.freyaHost = {
    isDesktop: true, onCoreConversation: () => () => {}, coreConversation: async () => projection,
    onCoreActivity: () => () => {}, coreActivity: async () => [],
    coreSubmit: async () => ({ conversation: { operation: 'listed', conversations: [] } }),
  } as unknown as typeof window.freyaHost
  await ensureConversationAttached()
  render(<Chats researchView={null} browserOpen={false} browserPercent={52} onBrowserPercentChange={() => {}} browserRequestedUrl={null} onBrowserOpenUrl={() => {}} onBrowserRequestedUrlHandled={() => {}} onBrowserClose={() => {}} />)
  expect(screen.getByText('What Freya did for this answer')).toBeInTheDocument()
  expect(screen.getByText(/Blocked.*did not run/)).toBeInTheDocument()
})
