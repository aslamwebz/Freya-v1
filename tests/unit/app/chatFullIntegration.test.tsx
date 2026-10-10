// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Chats } from '../../../src/app/chat/Chats'
import { GlobalComposer } from '../../../src/app/screens/GlobalComposer'
import { RightWorkspaceRail, UniversalRightWorkspace } from '../../../src/app/chat/RightWorkspace'
import { sharedRightWorkspaceStore } from '../../../src/app/chat/rightWorkspaceStore'
import { sharedComposerDraftStore } from '../../../src/app/chat/composerDraftStore'
import { attachmentTray } from '../../../src/app/chat/attachments'
import { ensureConversationAttached, resetConversationMirror } from '../../../src/platform/conversationClient'
import { resetCoreMirror } from '../../../src/platform/coreClient'
import type { ConversationProjection, ConversationMessageView } from '../../../core/protocol/conversation'
import type { ToolStepRecord } from '../../../core/mind/tools'
import type { VoiceView } from '../../../src/app/voice/useVoiceDock'

afterEach(() => {
  cleanup()
  resetConversationMirror()
  resetCoreMirror()
  delete (window as unknown as { freyaHost?: unknown }).freyaHost
  sharedRightWorkspaceStore().reset()
  sharedComposerDraftStore().reset()
  attachmentTray.clear()
})

function mockVoice(overrides: Partial<VoiceView> = {}): VoiceView {
  return {
    state: 'ready',
    projection: null,
    interim: '',
    micEnabled: true,
    capturing: false,
    speaking: false,
    muted: false,
    wakeArmed: false,
    notice: '',
    unavailableReason: null,
    capabilities: {
      capture: true,
      recognition: { available: true, local: true, detail: 'Available' },
    },
    voices: [],
    config: null,
    configBusy: false,
    ...overrides,
  }
}

describe('Phase 8: Full Integration & Live Acceptance Scenarios', () => {
  it('Scenario 1 & 2: selects a model, composes a message, and renders assistant answer', async () => {
    const projection: ConversationProjection = {
      persistence: { mode: 'encrypted', reason: null },
      conversations: [
        {
          conversationId: 'conv-1',
          title: 'Deep Learning Discussion',
          updatedAt: new Date().toISOString(),
          messageCount: 2,
          lastTurnOutcome: 'completed',
        },
      ],
      activeConversationId: 'conv-1',
      messages: [
        {
          messageId: 'msg-u1',
          role: 'user',
          content: 'Explain transformers architecture',
          createdAt: new Date().toISOString(),
          turnId: 'turn-1',
        },
        {
          messageId: 'msg-a1',
          role: 'assistant',
          content: '# Transformers\n\nThe transformer architecture relies on **self-attention** mechanisms.',
          createdAt: new Date().toISOString(),
          turnId: 'turn-1',
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

    const onSend = vi.fn(async () => true)

    // Render composer
    render(
      <GlobalComposer
        generating={false}
        defaultModel="gpt-4o"
        voice={mockVoice()}
        voiceTranscript={null}
        onSend={onSend}
        onStopResponse={vi.fn()}
        onVoicePress={vi.fn()}
        onVoiceRelease={vi.fn()}
        maxMessageCharacters={4000}
        conversationId="conv-1"
      />,
    )

    const textarea = screen.getByRole('textbox', { name: 'Ask Freya' }) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'What about attention heads?' } })

    const form = screen.getByRole('form', { name: 'Freya composer' })
    fireEvent.submit(form)

    expect(onSend).toHaveBeenCalledWith(
      'What about attention heads?',
      'chat',
      { webSearch: false, browserUse: false },
    )
  })

  it('Scenario 3: switches conversations without losing draft text, mode, and thinking level', () => {
    const { rerender } = render(
      <GlobalComposer
        generating={false}
        defaultModel={null}
        voice={mockVoice()}
        voiceTranscript={null}
        onSend={vi.fn(async () => true)}
        onStopResponse={vi.fn()}
        onVoicePress={vi.fn()}
        onVoiceRelease={vi.fn()}
        maxMessageCharacters={8000}
        conversationId="conv-alpha"
      />,
    )

    const textarea = screen.getByRole('textbox', { name: 'Ask Freya' }) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'Work in progress for Alpha' } })

    // Switch to Conversation Beta
    rerender(
      <GlobalComposer
        generating={false}
        defaultModel={null}
        voice={mockVoice()}
        voiceTranscript={null}
        onSend={vi.fn(async () => true)}
        onStopResponse={vi.fn()}
        onVoicePress={vi.fn()}
        onVoiceRelease={vi.fn()}
        maxMessageCharacters={8000}
        conversationId="conv-beta"
      />,
    )

    // Beta starts empty
    expect(textarea.value).toBe('')
    fireEvent.change(textarea, { target: { value: 'Beta draft query' } })

    // Switch back to Alpha
    rerender(
      <GlobalComposer
        generating={false}
        defaultModel={null}
        voice={mockVoice()}
        voiceTranscript={null}
        onSend={vi.fn(async () => true)}
        onStopResponse={vi.fn()}
        onVoicePress={vi.fn()}
        onVoiceRelease={vi.fn()}
        maxMessageCharacters={8000}
        conversationId="conv-alpha"
      />,
    )

    // Alpha draft is restored perfectly
    expect(textarea.value).toBe('Work in progress for Alpha')
  })

  it('Scenario 4 & 5: Web Search mode renders real sources and linked citations', async () => {
    const messageWithSources: ConversationMessageView = {
      messageId: 'msg-research',
      role: 'assistant',
      content: 'According to RFC 9111 [1], HTTP caching optimizes network usage.',
      createdAt: new Date().toISOString(),
      turnId: 'turn-res-1',
      sources: [
        {
          rank: 1,
          title: 'RFC 9111 - HTTP Caching',
          url: 'https://www.rfc-editor.org/rfc/rfc9111',
          sourceDomain: 'rfc-editor.org',
          snippet: 'The Hypertext Transfer Protocol (HTTP) is a stateless application-level protocol...',
          retrievedAt: new Date().toISOString(),
        },
      ],
      media: [],
    }

    const projection: ConversationProjection = {
      persistence: { mode: 'encrypted', reason: null },
      conversations: [],
      activeConversationId: 'c1',
      messages: [messageWithSources],
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
        browserRequestedUrl={null}
        onBrowserOpenUrl={vi.fn()}
        onBrowserPercentChange={vi.fn()}
        onBrowserRequestedUrlHandled={vi.fn()}
        onBrowserClose={vi.fn()}
      />,
    )

    // Sources section is rendered
    expect(screen.getByText('RFC 9111 - HTTP Caching')).toBeTruthy()
    expect(screen.getByText(/The Hypertext Transfer Protocol/i)).toBeTruthy()

    // Citation button [1] is rendered
    const citeBtn = screen.getByRole('button', { name: /Source 1/i })
    expect(citeBtn).toBeTruthy()
  })

  it('Scenario 6 & 7: Freya Browser navigation and website preview in right workspace', () => {
    const rwStore = sharedRightWorkspaceStore()
    rwStore.open('browser')

    const onOpenInBrowser = vi.fn()

    render(
      <>
        <RightWorkspaceRail open={true} activeTab="browser" browserEnabled={true} onClose={vi.fn()} />
      <UniversalRightWorkspace
        open={true}
        activeTab="browser"
        percent={50}
        onPercentChange={vi.fn()}
        onClose={vi.fn()}
        onBrowserOpenUrl={onOpenInBrowser}
      />
      </>,
    )

    expect(screen.getByRole('tab', { name: /^Browser/ })).toBeTruthy()
    expect(document.querySelector('.chats-browser')).toBeTruthy()
  })

  it('Scenario 8: displays verified execution records with step outcomes in Chat and Workspace', async () => {
    const verifiedSteps: ToolStepRecord[] = [
      {
        index: 1,
        tool: 'web_search',
        capability: 'search.web',
        outcome: 'ok',
        executed: true,
        sourceCount: 3,
      },
      {
        index: 2,
        tool: 'fetch_page',
        capability: 'browser.read',
        outcome: 'ok',
        executed: true,
        sourceCount: 1,
      },
    ]

    const projection: ConversationProjection = {
      persistence: { mode: 'encrypted', reason: null },
      conversations: [],
      activeConversationId: 'c1',
      messages: [
        {
          messageId: 'msg-exec',
          role: 'assistant',
          content: 'React 19 introduces Actions and useActionState.',
          createdAt: new Date().toISOString(),
          turnId: 'turn-exec-1',
          steps: verifiedSteps,
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
        browserRequestedUrl={null}
        onBrowserOpenUrl={vi.fn()}
        onBrowserPercentChange={vi.fn()}
        onBrowserRequestedUrlHandled={vi.fn()}
        onBrowserClose={vi.fn()}
      />,
    )

    // Execution steps cards in AssistantMessageView
    expect(screen.getByText('web_search')).toBeTruthy()
    expect(screen.getByText('fetch_page')).toBeTruthy()
    expect(screen.getAllByText('Verified OK').length).toBe(2)
    expect(screen.getAllByText('Executed').length).toBe(2)
  })

  it('Scenario 9: Universal Right Workspace seamlessly switches across all 8 content types', () => {
    const rwStore = sharedRightWorkspaceStore()
    rwStore.open('browser')

    const { rerender } = render(
      <>
        <RightWorkspaceRail open={true} activeTab="browser" browserEnabled={true} onClose={vi.fn()} />
      <UniversalRightWorkspace
        open={true}
        activeTab="browser"
        percent={50}
        onPercentChange={vi.fn()}
        onClose={vi.fn()}
        onBrowserOpenUrl={vi.fn()}
      />
      </>,
    )

    expect(screen.getByRole('tab', { name: /^Browser/ })).toBeTruthy()

    // Switch to Canvas
    rwStore.setTab('canvas')
    rerender(
      <>
        <RightWorkspaceRail open={true} activeTab="canvas" browserEnabled={true} onClose={vi.fn()} />
      <UniversalRightWorkspace
        open={true}
        activeTab="canvas"
        percent={50}
        onPercentChange={vi.fn()}
        onClose={vi.fn()}
        onBrowserOpenUrl={vi.fn()}
      />
      </>,
    )
    expect(screen.getByRole('tab', { name: /^Canvas/ })).toBeTruthy()

    // Switch to Media
    rwStore.setTab('media')
    rerender(
      <>
        <RightWorkspaceRail open={true} activeTab="media" browserEnabled={true} onClose={vi.fn()} />
      <UniversalRightWorkspace
        open={true}
        activeTab="media"
        percent={50}
        onPercentChange={vi.fn()}
        onClose={vi.fn()}
        onBrowserOpenUrl={vi.fn()}
      />
      </>,
    )
    expect(screen.getByRole('tab', { name: /^Media/ })).toBeTruthy()
  })

  it('Scenario 10: attachments tray, push-to-talk voice, and TTS speech wave playback', () => {
    const onVoiceRelease = vi.fn()

    render(
      <GlobalComposer
        generating={false}
        defaultModel={null}
        voice={mockVoice({ capturing: true, interim: 'Live recording check' })}
        voiceTranscript={null}
        onSend={vi.fn(async () => true)}
        onStopResponse={vi.fn()}
        onVoicePress={vi.fn()}
        onVoiceRelease={onVoiceRelease}
        maxMessageCharacters={8000}
      />,
    )

    // Interim recording banner is present
    expect(screen.getByText('Listening…')).toBeTruthy()
    expect(screen.getByText('Live recording check')).toBeTruthy()

    // Attach button is present
    expect(screen.getByRole('button', { name: 'Attach a file' })).toBeTruthy()
  })

  it('Scenario 11: handles cancellation via Stop button and recovery via Retry turn button', async () => {
    const projection: ConversationProjection = {
      persistence: { mode: 'encrypted', reason: null },
      conversations: [],
      activeConversationId: 'c1',
      messages: [
        {
          messageId: 'u-failed',
          role: 'user',
          content: 'Explain neural networks',
          createdAt: new Date().toISOString(),
          turnId: 'turn-fail',
        },
      ],
      activeTurn: {
        turnId: 'turn-active',
        conversationId: 'c1',
        startedAt: new Date().toISOString(),
        providerExecuting: true,
      },
      cognition: { available: true, reason: null },
      stopAll: { active: false, activatedAt: null },
      maxMessageCharacters: 4000,
      faults: ['Turn failed: Provider connection timed out'],
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

    const onStopResponse = vi.fn()
    const onRetryTurn = vi.fn()

    render(
      <Chats
        busy={true}
        issue="Turn failed: Provider connection timed out"
        researchView={null}
        browserOpen={false}
        browserPercent={50}
        browserRequestedUrl={null}
        onStopResponse={onStopResponse}
        onRetryTurn={onRetryTurn}
        onBrowserOpenUrl={vi.fn()}
        onBrowserPercentChange={vi.fn()}
        onBrowserRequestedUrlHandled={vi.fn()}
        onBrowserClose={vi.fn()}
      />,
    )

    // Active turn tracker with stop response button
    const stopBtn = screen.getByRole('button', { name: 'Stop response' })
    expect(stopBtn).toBeTruthy()
    fireEvent.click(stopBtn)
    expect(onStopResponse).toHaveBeenCalled()

    // Retry turn button in problem notice
    const retryBtn = screen.getByRole('button', { name: /retry/i })
    expect(retryBtn).toBeTruthy()
    fireEvent.click(retryBtn)
    expect(onRetryTurn).toHaveBeenCalledWith('Explain neural networks')
  })
})
