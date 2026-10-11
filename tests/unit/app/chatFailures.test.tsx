import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Chats } from '../../../src/app/chat/Chats'
import { describeActivity } from '../../../core/protocol/activity'
import { resetConversationMirror, ensureConversationAttached } from '../../../src/platform/conversationClient'
import { resetCoreMirror } from '../../../src/platform/coreClient'
import type { ConversationProjection } from '../../../core/protocol/conversation'
import { sharedRightWorkspaceStore } from '../../../src/app/chat/rightWorkspaceStore'

const reason = 'no configured provider can serve this request'
let current: ConversationProjection
beforeEach(async () => {
  resetConversationMirror(); resetCoreMirror()
  sharedRightWorkspaceStore().reset()
  current = { persistence: { mode: 'encrypted', reason: null }, conversations: [], activeConversationId: 'c1', messages: [], activeTurn: null, cognition: { available: true, reason: null }, stopAll: { active: false, activatedAt: null }, maxMessageCharacters: 4000, faults: [] }
  const failure = describeActivity({ type: 'conversation.turn.failed', sequence: 1, at: Date.now(), payload: { conversationId: 'c1', turnId: 't1', reason } })!
  window.freyaHost = {
    isDesktop: true, coreConversation: async () => current, onCoreConversation: () => () => {},
    coreActivity: async () => [failure], onCoreActivity: () => () => {},
    coreSubmit: async () => ({ requestId: 'r', ok: true, conversation: { operation: 'listed', conversations: [] } }),
  } as unknown as typeof window.freyaHost
  await ensureConversationAttached()
})
afterEach(() => { cleanup(); resetConversationMirror(); resetCoreMirror(); delete (window as unknown as { freyaHost?: unknown }).freyaHost })
function mount(issue = '') {
  return render(<Chats issue={issue} researchView={null} browserOpen={false} browserPercent={52} onBrowserPercentChange={() => {}} browserRequestedUrl={null} onBrowserOpenUrl={() => {}} onBrowserRequestedUrlHandled={() => {}} onBrowserClose={() => {}} />)
}
it('shows one failure when the command reply and journal report the same reason', async () => {
  mount(reason)
  await screen.findByText(`Turn failed: ${reason}`)
  expect(document.querySelectorAll('.chats-issue p')).toHaveLength(1)
})
it('does not show another conversation’s failed turn', async () => {
  current = { ...current, activeConversationId: 'c2' }
  await ensureConversationAttached().then(mirror => mirror.attach())
  await act(async () => { mount() })
  await waitFor(() => expect(screen.getByText('Ready')).toBeInTheDocument())
  expect(document.querySelector('.chats-issue')).toBeNull()
})
it('maps only conversation and turn identifiers for failure association, never the raw payload', () => {
  const row = describeActivity({ type: 'conversation.turn.failed', sequence: 1, at: 1, payload: { conversationId: 'c1', turnId: 't1', reason: 'timeout', prompt: 'private prompt' } })
  expect(row).toMatchObject({ conversationId: 'c1', turnId: 't1' })
  expect(JSON.stringify(row)).not.toContain('private prompt')
  expect(row).not.toHaveProperty('payload')
})
it('connects all eight rail icons to the existing collapsible workspace and preserves selection and width', async () => {
  mount()
  const rail = screen.getByRole('tablist', { name: 'Workspace content types' })
  expect(within(rail).getAllByRole('tab').map(tab => tab.getAttribute('aria-label'))).toEqual(['Browser', 'Sources', 'Canvas', 'Docs', 'Media', 'Charts', 'Execution', 'Files'])
  expect(document.querySelector('#chats-right-panel')).toBeNull()
  fireEvent.click(within(rail).getByRole('tab', { name: 'Sources' }))
  expect(document.querySelector('#chats-right-panel')).toBeInTheDocument()
  act(() => sharedRightWorkspaceStore().setPercent(64))
  fireEvent.click(within(rail).getByRole('tab', { name: 'Sources' }))
  expect(document.querySelector('#chats-right-panel')).toBeNull()
  expect(rail).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Expand right workspace' }))
  expect(within(rail).getByRole('tab', { name: 'Sources' })).toHaveAttribute('aria-selected', 'true')
  expect(sharedRightWorkspaceStore().getSnapshot().percent).toBe(64)
  fireEvent.click(within(rail).getByRole('tab', { name: 'Files' }))
  expect(document.querySelector('#chats-right-panel')).toHaveAttribute('data-active-tab', 'files')
})
