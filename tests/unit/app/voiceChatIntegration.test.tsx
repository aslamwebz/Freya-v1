import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GlobalComposer } from '../../../src/app/screens/GlobalComposer'
import { Chats } from '../../../src/app/chat/Chats'
import { MediaGrid } from '../../../src/app/chat/MediaCards'
import { UniversalRightWorkspace } from '../../../src/app/chat/RightWorkspace'
import { sharedRightWorkspaceStore } from '../../../src/app/chat/rightWorkspaceStore'
import { attachmentTray } from '../../../src/app/chat/attachments'
import { sharedComposerDraftStore } from '../../../src/app/chat/composerDraftStore'
import { ensureConversationAttached, resetConversationMirror } from '../../../src/platform/conversationClient'
import { resetCoreMirror } from '../../../src/platform/coreClient'
import type { VoiceView } from '../../../src/app/voice/useVoiceDock'
import type { MediaItem } from '../../../core/media/types'
import type { ConversationProjection } from '../../../core/protocol/conversation'

afterEach(() => {
  cleanup()
  attachmentTray.clear()
  sharedComposerDraftStore().reset()
  sharedRightWorkspaceStore().reset()
  resetConversationMirror()
  resetCoreMirror()
  delete (window as unknown as { freyaHost?: unknown }).freyaHost
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

describe('Phase 7: Voice & Multimodal Chat Integration', () => {
  describe('GlobalComposer Voice Experience', () => {
    it('displays live interim transcript and listening status when voice is capturing', () => {
      const onVoiceRelease = vi.fn()
      render(
        <GlobalComposer
          generating={false}
          defaultModel={null}
          voice={mockVoice({
            capturing: true,
            interim: 'Hello Freya what is quantum computing',
          })}
          voiceTranscript={null}
          onSend={vi.fn(async () => true)}
          onStopResponse={vi.fn()}
          onVoicePress={vi.fn()}
          onVoiceRelease={onVoiceRelease}
          maxMessageCharacters={8000}
        />,
      )

      expect(screen.getByText('Listening…')).toBeTruthy()
      expect(screen.getByText('Hello Freya what is quantum computing')).toBeTruthy()

      // Discard button cancels recording
      const cancelButton = screen.getByRole('button', { name: 'Discard voice recording' })
      fireEvent.click(cancelButton)
      expect(onVoiceRelease).toHaveBeenCalledWith(true)
    })

    it('displays transcribing state when voice state is transcribing', () => {
      render(
        <GlobalComposer
          generating={false}
          defaultModel={null}
          voice={mockVoice({
            capturing: true,
            state: 'transcribing',
            interim: 'Finishing speech...',
          })}
          voiceTranscript={null}
          onSend={vi.fn(async () => true)}
          onStopResponse={vi.fn()}
          onVoicePress={vi.fn()}
          onVoiceRelease={vi.fn()}
          maxMessageCharacters={8000}
        />,
      )

      expect(screen.getByText('Transcribing…')).toBeTruthy()
      expect(screen.getByText('Finishing speech...')).toBeTruthy()
    })

    it('cancels voice recording when Escape is pressed while capturing', () => {
      const onVoiceRelease = vi.fn()
      render(
        <GlobalComposer
          generating={false}
          defaultModel={null}
          voice={mockVoice({
            capturing: true,
            interim: 'Cancelled sentence',
          })}
          voiceTranscript={null}
          onSend={vi.fn(async () => true)}
          onStopResponse={vi.fn()}
          onVoicePress={vi.fn()}
          onVoiceRelease={onVoiceRelease}
          maxMessageCharacters={8000}
        />,
      )

      const textarea = screen.getByRole('textbox', { name: 'Ask Freya' })
      fireEvent.keyDown(textarea, { key: 'Escape' })
      expect(onVoiceRelease).toHaveBeenCalledWith(true)
    })

    it('renders permission-denied warning badge and tooltip when mic is blocked', () => {
      render(
        <GlobalComposer
          generating={false}
          defaultModel={null}
          voice={mockVoice({
            state: 'permission-denied',
            unavailableReason: 'Microphone permission was denied. Turn it back on in system settings.',
          })}
          voiceTranscript={null}
          onSend={vi.fn(async () => true)}
          onStopResponse={vi.fn()}
          onVoicePress={vi.fn()}
          onVoiceRelease={vi.fn()}
          maxMessageCharacters={8000}
        />,
      )

      expect(screen.getByTitle('Microphone permission required')).toBeTruthy()
      expect(
        screen.getAllByText('Microphone permission was denied. Turn it back on in system settings.').length,
      ).toBeGreaterThanOrEqual(1)
    })

    it('renders wake mode badge when wake is armed', () => {
      render(
        <GlobalComposer
          generating={false}
          defaultModel={null}
          voice={mockVoice({
            wakeArmed: true,
          })}
          voiceTranscript={null}
          onSend={vi.fn(async () => true)}
          onStopResponse={vi.fn()}
          onVoicePress={vi.fn()}
          onVoiceRelease={vi.fn()}
          maxMessageCharacters={8000}
        />,
      )

      expect(screen.getByTitle("Wake armed: say 'Freya'")).toBeTruthy()
    })

    it('smoothly appends voice transcripts into composer draft without losing state', () => {
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
        />,
      )

      const textarea = screen.getByRole('textbox', { name: 'Ask Freya' }) as HTMLTextAreaElement
      fireEvent.change(textarea, { target: { value: 'Note:' } })

      // Voice transcript arrives
      rerender(
        <GlobalComposer
          generating={false}
          defaultModel={null}
          voice={mockVoice()}
          voiceTranscript={{ id: 101, text: 'please review this data' }}
          onSend={vi.fn(async () => true)}
          onStopResponse={vi.fn()}
          onVoicePress={vi.fn()}
          onVoiceRelease={vi.fn()}
          maxMessageCharacters={8000}
        />,
      )

      expect(textarea.value).toBe('Note: please review this data')
    })
  })

  describe('Chats Text-to-Speech Playback', () => {
    it('renders read aloud button on assistant messages and triggers speech and wave pulse', async () => {
      const projection: ConversationProjection = {
        persistence: { mode: 'encrypted', reason: null },
        conversations: [],
        activeConversationId: 'c1',
        messages: [
          {
            messageId: 'm1',
            role: 'assistant',
            content: 'Quantum computing uses qubits instead of classical bits.',
            createdAt: new Date().toISOString(),
            turnId: 'turn-999',
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

      const onSpeakTurn = vi.fn()
      const onStopSpeaking = vi.fn()

      const { rerender } = render(
        <Chats
          researchView={null}
          browserOpen={false}
          browserPercent={50}
          browserRequestedUrl={null}
          voiceCanSpeak={true}
          voiceSpeaking={false}
          onSpeakTurn={onSpeakTurn}
          onStopSpeaking={onStopSpeaking}
          onBrowserOpenUrl={vi.fn()}
          onBrowserPercentChange={vi.fn()}
          onBrowserRequestedUrlHandled={vi.fn()}
          onBrowserClose={vi.fn()}
        />,
      )

      const readAloudBtn = screen.getByRole('button', { name: /read this answer aloud/i })
      expect(readAloudBtn).toBeTruthy()

      // Click Read Aloud
      fireEvent.click(readAloudBtn)
      expect(onSpeakTurn).toHaveBeenCalledWith('turn-999')

      // Rerender as actively speaking
      rerender(
        <Chats
          researchView={null}
          browserOpen={false}
          browserPercent={50}
          browserRequestedUrl={null}
          voiceCanSpeak={true}
          voiceSpeaking={true}
          onSpeakTurn={onSpeakTurn}
          onStopSpeaking={onStopSpeaking}
          onBrowserOpenUrl={vi.fn()}
          onBrowserPercentChange={vi.fn()}
          onBrowserRequestedUrlHandled={vi.fn()}
          onBrowserClose={vi.fn()}
        />,
      )

      const stopBtn = screen.getByRole('button', { name: /stop reading aloud/i })
      expect(stopBtn).toBeTruthy()
      expect(stopBtn.getAttribute('data-speaking')).toBe('true')
      expect(document.querySelector('.chats-speaking-pulse')).toBeTruthy()

      // Click Stop
      fireEvent.click(stopBtn)
      expect(onStopSpeaking).toHaveBeenCalled()
    })
  })

  describe('Multimodal Audio and Media Interactions', () => {
    const sampleAudioItem: MediaItem = {
      kind: 'audio',
      url: 'https://example.com/podcast.mp3',
      page: 'https://example.com/episodes/1',
      title: 'AI Revolution Podcast',
      host: 'example.com',
      duration: '42:15',
      bytes: 25000000,
      pages: null,
      playable: true,
    }

    it('renders an audio card for audio items in MediaGrid', () => {
      render(<MediaGrid items={[sampleAudioItem]} />)

      const audioBtn = screen.getByRole('button', { name: /listen to ai revolution podcast/i })
      expect(audioBtn).toBeTruthy()
      expect(screen.getByText('AI Revolution Podcast')).toBeTruthy()
      expect(screen.getByText(/42:15/)).toBeTruthy()
    })

    it('opens audio player in overlay when clicking the audio card', () => {
      render(<MediaGrid items={[sampleAudioItem]} />)

      const audioBtn = screen.getByRole('button', { name: /listen to ai revolution podcast/i })
      fireEvent.click(audioBtn)

      expect(screen.getByRole('dialog', { name: 'Media preview' })).toBeTruthy()
      const player = screen.getByLabelText('AI Revolution Podcast')
      expect(player.tagName.toLowerCase()).toBe('audio')
      expect(player.getAttribute('src')).toBe('https://example.com/podcast.mp3')
    })

    it('renders playable audio frame in UniversalRightWorkspace MediaView', () => {
      const rwStore = sharedRightWorkspaceStore()
      rwStore.open('media')

      render(
        <UniversalRightWorkspace
          open={true}
          activeTab="media"
          percent={50}
          onPercentChange={vi.fn()}
          onClose={vi.fn()}
          onBrowserOpenUrl={vi.fn()}
          mediaItems={[sampleAudioItem]}
        />,
      )

      const player = screen.getByLabelText('AI Revolution Podcast')
      expect(player.tagName.toLowerCase()).toBe('audio')
      expect(player.getAttribute('src')).toBe('https://example.com/podcast.mp3')
      expect(screen.getByText('Copy Audio URL')).toBeTruthy()
    })
  })
})
