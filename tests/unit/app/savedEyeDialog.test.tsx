// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Chats } from '../../../src/app/chat/Chats'
import { ensureConversationAttached, resetConversationMirror } from '../../../src/platform/conversationClient'
import { resetCoreMirror } from '../../../src/platform/coreClient'
import { sharedRightWorkspaceStore } from '../../../src/app/chat/rightWorkspaceStore'
import type { ConversationProjection } from '../../../core/protocol/conversation'
import type { WorkspaceResearchView } from '../../../src/app/chat/modes'

vi.mock('../../../src/platform/researchClient', () => ({ researchMirror: () => ({ listSessions: async () => ({ operation: 'session-list', sessions: [] }) }) }))

afterEach(() => { cleanup(); resetConversationMirror(); resetCoreMirror(); sharedRightWorkspaceStore().reset(); delete window.freyaHost })

it('closes saved Eye searches using Close, Escape, or the backdrop and restores trigger focus', async () => {
  const projection: ConversationProjection = {
    persistence: { mode: 'encrypted', reason: null }, conversations: [], activeConversationId: 'c1', messages: [], activeTurn: null,
    cognition: { available: true, reason: null }, stopAll: { active: false, activatedAt: null }, maxMessageCharacters: 4000, faults: [],
  }
  window.freyaHost = {
    isDesktop: true, onCoreConversation: () => () => {}, coreConversation: async () => projection,
    onCoreActivity: () => () => {}, coreActivity: async () => [], coreSubmit: async () => ({ conversation: { operation: 'listed', conversations: [] } }),
  } as unknown as typeof window.freyaHost
  await ensureConversationAttached()
  render(<Chats researchView={null} onResearchViewChange={() => {}} browserOpen={false} browserPercent={52} onBrowserPercentChange={() => {}} browserRequestedUrl={null} onBrowserOpenUrl={() => {}} onBrowserRequestedUrlHandled={() => {}} onBrowserClose={() => {}} />)
  const trigger = screen.getByRole('button', { name: 'Saved Eye searches' })
  for (const closeUsing of ['button', 'Escape', 'backdrop']) {
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: 'Saved Eye searches' })
    const close = within(dialog).getByRole('button', { name: 'Close saved Eye searches' })
    expect(close).toHaveFocus()
    if (closeUsing === 'button') fireEvent.click(close)
    else if (closeUsing === 'Escape') fireEvent.keyDown(close, { key: 'Escape' })
    else fireEvent.click(dialog)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger).toHaveFocus()
  }
})

it.each([
  ['https://www.youtube.com/watch?v=abcdefghijk', 'https://www.youtube.com/embed/abcdefghijk'],
  ['https://example.org/unsupported-video', null],
])('previews an Eye video finding before opening its browser page: %s', async (url, embed) => {
  const view: WorkspaceResearchView = { mode: 'eye', outcome: { operation: 'session-read', session: {
    sessionId: 'videos', ownerText: 'Find videos', state: 'completed', intentVersion: 1,
    intent: { subject: 'Videos', targetCount: 1, mediaType: 'video', constraints: [], exclusions: [], site: null },
    page: 1, resultCount: 1, createdAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T00:00:00Z', lastError: null,
    persistence: { durable: false, mode: 'ephemeral', reason: 'Ephemeral' },
    results: [{ resultId: 'video-1', title: 'Video finding', url, snippet: 'A found video', sourceDomain: 'example.org', rank: 1,
      retrievedAt: '2026-10-11T00:00:00Z', mediaType: 'video', confidence: 'probable', collection: 'Videos Found', vertical: 'videos', metadata: { duration: '2:30' } }],
  } } }
  const onBrowserOpenUrl = vi.fn()
  render(<Chats researchView={view} browserOpen={false} browserPercent={52} onBrowserPercentChange={() => {}} browserRequestedUrl={null} onBrowserOpenUrl={onBrowserOpenUrl} onBrowserRequestedUrlHandled={() => {}} onBrowserClose={() => {}} />)
  fireEvent.click(screen.getByText('Videos Found'))
  fireEvent.click(screen.getByRole('button', { name: /Video finding/ }))
  const dialog = screen.getByRole('dialog', { name: 'Media preview' })
  expect(onBrowserOpenUrl).not.toHaveBeenCalled()
  if (embed) expect(within(dialog).getByTitle('Video finding')).toHaveAttribute('src', embed)
  expect(within(dialog).getByRole('button', { name: "Open this page in Freya's browser" })).toBeInTheDocument()
})
