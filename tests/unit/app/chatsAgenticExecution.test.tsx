// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Chats } from '../../../src/app/chat/Chats'
import { ensureConversationAttached, resetConversationMirror } from '../../../src/platform/conversationClient'
import { resetCoreMirror } from '../../../src/platform/coreClient'
import { sharedRightWorkspaceStore } from '../../../src/app/chat/rightWorkspaceStore'
import type { ConversationProjection } from '../../../core/protocol/conversation'

afterEach(() => {
  cleanup()
  resetConversationMirror()
  resetCoreMirror()
  delete window.freyaHost
  sharedRightWorkspaceStore().reset()
})

describe('Chats Agentic Execution Experience', () => {
  it('renders ActiveTurnTracker during active turn generation and allows stopping', async () => {
    const projection: ConversationProjection = {
      persistence: { mode: 'encrypted', reason: null },
      conversations: [],
      activeConversationId: 'c1',
      messages: [
        {
          messageId: 'm1',
          role: 'user',
          content: 'Research quantum computing benchmarks',
          createdAt: new Date().toISOString(),
          turnId: 't1',
        },
      ],
      activeTurn: {
        turnId: 't2',
        conversationId: 'c1',
        startedAt: new Date(Date.now() - 2000).toISOString(),
        providerExecuting: true,
      },
      cognition: { available: true, reason: null },
      stopAll: { active: false, activatedAt: null },
      maxMessageCharacters: 4000,
      faults: [],
    }

    const onStopResponse = vi.fn()

    window.freyaHost = {
      isDesktop: true,
      onCoreConversation: () => () => {},
      coreConversation: async () => projection,
      onCoreActivity: () => () => {},
      coreActivity: async () => [],
      coreSubmit: async () => ({ conversation: { operation: 'listed', conversations: [] } }),
    } as unknown as typeof window.freyaHost

    await ensureConversationAttached()

    render(
      <Chats
        researchView={null}
        browserOpen={false}
        browserPercent={50}
        onBrowserPercentChange={() => {}}
        browserRequestedUrl={null}
        onBrowserOpenUrl={() => {}}
        onBrowserRequestedUrlHandled={() => {}}
        onBrowserClose={() => {}}
        onStopResponse={onStopResponse}
      />,
    )

    expect(screen.getByTestId('active-turn-tracker')).toBeInTheDocument()
    expect(screen.getByText('Generating response')).toBeInTheDocument()

    const stopBtn = screen.getByRole('button', { name: 'Stop response' })
    fireEvent.click(stopBtn)
    expect(onStopResponse).toHaveBeenCalledTimes(1)
  })

  it('renders Retry turn button on failure and calls onRetryTurn with the last user prompt', async () => {
    const projection: ConversationProjection = {
      persistence: { mode: 'encrypted', reason: null },
      conversations: [],
      activeConversationId: 'c1',
      messages: [
        {
          messageId: 'm1',
          role: 'user',
          content: 'Compare solar and wind efficiency stats',
          createdAt: new Date().toISOString(),
          turnId: 't1',
        },
      ],
      activeTurn: null,
      cognition: { available: true, reason: null },
      stopAll: { active: false, activatedAt: null },
      maxMessageCharacters: 4000,
      faults: [],
    }

    const onRetryTurn = vi.fn()

    window.freyaHost = {
      isDesktop: true,
      onCoreConversation: () => () => {},
      coreConversation: async () => projection,
      onCoreActivity: () => () => {},
      coreActivity: async () => [
        {
          id: 'conversation.turn.failed:1',
          kind: 'conversation.turn.failed',
          type: 'conversation.turn.failed',
          sequence: 1,
          at: Date.now() - 1000,
          text: 'Turn failed: provider connection timed out after 30s',
          tone: 'bad',
          conversationId: 'c1',
          turnId: 't1',
        },
      ],
      coreSubmit: async () => ({ conversation: { operation: 'listed', conversations: [] } }),
    } as unknown as typeof window.freyaHost

    await ensureConversationAttached()

    render(
      <Chats
        issue="Turn failed: provider connection timed out after 30s"
        researchView={null}
        browserOpen={false}
        browserPercent={50}
        onBrowserPercentChange={() => {}}
        browserRequestedUrl={null}
        onBrowserOpenUrl={() => {}}
        onBrowserRequestedUrlHandled={() => {}}
        onBrowserClose={() => {}}
        onRetryTurn={onRetryTurn}
      />,
    )

    expect(screen.getByText('That did not finish')).toBeInTheDocument()
    expect(screen.getByText('Turn failed: provider connection timed out after 30s')).toBeInTheDocument()

    const retryBtn = screen.getByRole('button', { name: 'Retry failed turn' })
    expect(retryBtn).toBeInTheDocument()
    fireEvent.click(retryBtn)

    expect(onRetryTurn).toHaveBeenCalledWith('Compare solar and wind efficiency stats')
  })

  it('connects verified tool execution steps on assistant messages to Right Workspace execution tab', async () => {
    const projection: ConversationProjection = {
      persistence: { mode: 'encrypted', reason: null },
      conversations: [],
      activeConversationId: 'c1',
      messages: [
        {
          messageId: 'm1',
          role: 'user',
          content: 'Look up recent weather in Paris',
          createdAt: new Date().toISOString(),
          turnId: 't1',
        },
        {
          messageId: 'm2',
          role: 'assistant',
          content: 'Paris weather is 18°C and partly cloudy.',
          createdAt: new Date().toISOString(),
          turnId: 't1',
          steps: [
            {
              index: 1,
              tool: 'web_search',
              capability: 'search.web',
              outcome: 'ok',
              executed: true,
              sourceCount: 2,
            },
          ],
        },
      ],
      activeTurn: null,
      cognition: { available: true, reason: null },
      stopAll: { active: false, activatedAt: null },
      maxMessageCharacters: 4000,
      faults: [],
    }

    window.freyaHost = {
      isDesktop: true,
      onCoreConversation: () => () => {},
      coreConversation: async () => projection,
      onCoreActivity: () => () => {},
      coreActivity: async () => [],
      coreSubmit: async () => ({ conversation: { operation: 'listed', conversations: [] } }),
    } as unknown as typeof window.freyaHost

    await ensureConversationAttached()

    render(
      <Chats
        researchView={null}
        browserOpen={false}
        browserPercent={50}
        onBrowserPercentChange={() => {}}
        browserRequestedUrl={null}
        onBrowserOpenUrl={() => {}}
        onBrowserRequestedUrlHandled={() => {}}
        onBrowserClose={() => {}}
      />,
    )

    // Initially workspace is closed
    expect(screen.queryByRole('region', { name: 'Universal Right Workspace' })).toBeNull()

    const inspectBtn = screen.getByRole('button', { name: 'Inspect execution steps in right workspace' })
    fireEvent.click(inspectBtn)

    // Right workspace opens to execution tab
    expect(screen.getByRole('region', { name: 'Universal Right Workspace' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /^Execution/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('1 verified steps')).toBeInTheDocument()
  })
})
