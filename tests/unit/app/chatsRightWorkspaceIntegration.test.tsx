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

describe('Chats Universal Right Workspace Integration', () => {
  it('toggles the right workspace via the workspace toggle button in the header', async () => {
    const projection: ConversationProjection = {
      persistence: { mode: 'encrypted', reason: null },
      conversations: [],
      activeConversationId: 'c1',
      messages: [],
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

    const onBrowserClose = vi.fn()
    render(
      <Chats
        researchView={null}
        browserOpen={false}
        browserPercent={52}
        onBrowserPercentChange={() => {}}
        browserRequestedUrl={null}
        onBrowserOpenUrl={() => {}}
        onBrowserRequestedUrlHandled={() => {}}
        onBrowserClose={onBrowserClose}
      />,
    )

    const toggleBtn = screen.getByRole('button', { name: /Expand right workspace/ })
    expect(toggleBtn).toBeInTheDocument()

    // Expand
    fireEvent.click(toggleBtn)
    expect(screen.getByRole('region', { name: 'Universal Right Workspace' })).toBeInTheDocument()
    expect(screen.getByRole('separator', { name: 'Resize workspace' })).toBeInTheDocument()

    // Collapse
    const collapseBtn = screen.getByRole('button', { name: /Collapse right workspace/ })
    fireEvent.click(collapseBtn)
    expect(screen.queryByRole('region', { name: 'Universal Right Workspace' })).toBeNull()
  })

  it('resizes the workspace column via arrow keys on the divider', async () => {
    const projection: ConversationProjection = {
      persistence: { mode: 'encrypted', reason: null },
      conversations: [],
      activeConversationId: 'c1',
      messages: [],
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

    const onPercentChange = vi.fn()
    render(
      <Chats
        researchView={null}
        browserOpen={true}
        browserPercent={52}
        onBrowserPercentChange={onPercentChange}
        browserRequestedUrl={null}
        onBrowserOpenUrl={() => {}}
        onBrowserRequestedUrlHandled={() => {}}
        onBrowserClose={() => {}}
      />,
    )

    const divider = screen.getByRole('separator', { name: 'Resize workspace' })
    fireEvent.keyDown(divider, { key: 'ArrowLeft' })
    expect(onPercentChange).toHaveBeenCalledWith(54)

    fireEvent.keyDown(divider, { key: 'ArrowRight' })
    expect(onPercentChange).toHaveBeenCalledWith(50)
  })

  it('opens execution steps in the right workspace when clicking Inspect in workspace on a turn', async () => {
    const projection: ConversationProjection = {
      persistence: { mode: 'encrypted', reason: null },
      conversations: [],
      activeConversationId: 'c1',
      messages: [
        {
          messageId: 'm1',
          turnId: 't1',
          role: 'assistant',
          content: 'I executed the search and formatted the results.',
          createdAt: '2026-10-09T12:00:00Z',
          steps: [
            {
              index: 1,
              tool: 'web_search',
              capability: 'search.web',
              outcome: 'ok',
              executed: true,
              sourceCount: 3,
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
        browserPercent={52}
        onBrowserPercentChange={() => {}}
        browserRequestedUrl={null}
        onBrowserOpenUrl={() => {}}
        onBrowserRequestedUrlHandled={() => {}}
        onBrowserClose={() => {}}
      />,
    )

    const inspectBtn = screen.getByRole('button', { name: 'Inspect execution steps in right workspace' })
    fireEvent.click(inspectBtn)

    // Workspace opens and activates execution tab
    expect(screen.getByRole('region', { name: 'Universal Right Workspace' })).toBeInTheDocument()
    const execTab = screen.getByRole('tab', { name: /Execution/ })
    expect(execTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Step #1')).toBeInTheDocument()
    expect(screen.getAllByText('web_search').length).toBeGreaterThanOrEqual(1)
  })

  it('opens chart in the right workspace when clicking View in workspace on a chart', async () => {
    const projection: ConversationProjection = {
      persistence: { mode: 'encrypted', reason: null },
      conversations: [],
      activeConversationId: 'c1',
      messages: [
        {
          messageId: 'm1',
          turnId: 't1',
          role: 'assistant',
          content: 'Here is the latency breakdown chart.',
          createdAt: '2026-10-09T12:00:00Z',
          charts: [
            {
              title: 'Service Latencies',
              kind: 'bar',
              unit: 'ms',
              points: [
                { label: 'DNS', value: 12 },
                { label: 'TLS', value: 28 },
                { label: 'TTFB', value: 65 },
              ],
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
        browserPercent={52}
        onBrowserPercentChange={() => {}}
        browserRequestedUrl={null}
        onBrowserOpenUrl={() => {}}
        onBrowserRequestedUrlHandled={() => {}}
        onBrowserClose={() => {}}
      />,
    )

    const viewChartBtn = screen.getByRole('button', { name: 'View Service Latencies in right workspace' })
    fireEvent.click(viewChartBtn)

    // Workspace opens and activates charts tab
    expect(screen.getByRole('region', { name: 'Universal Right Workspace' })).toBeInTheDocument()
    const chartsTab = screen.getByRole('tab', { name: /Charts/ })
    expect(chartsTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getAllByText('Service Latencies').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('DNS').length).toBeGreaterThanOrEqual(1)
  })
})
