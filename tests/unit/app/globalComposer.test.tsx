import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GlobalComposer } from '../../../src/app/screens/GlobalComposer'
import type { VoiceView } from '../../../src/app/voice/useVoiceDock'
import { attachmentTray } from '../../../src/app/chat/attachments'
import { sharedComposerDraftStore } from '../../../src/app/chat/composerDraftStore'

afterEach(() => {
  cleanup()
  attachmentTray.clear()
  sharedComposerDraftStore().reset()
})

function input(): HTMLTextAreaElement {
  return screen.getByRole('textbox', { name: 'Ask Freya' }) as HTMLTextAreaElement
}

function voice(): VoiceView {
  return {
    state: 'unreachable',
    projection: null,
    interim: '',
    micEnabled: false,
    capturing: false,
    speaking: false,
    muted: false,
    notice: '',
    wakeArmed: false,
    unavailableReason: 'Voice unavailable in this test.',
    capabilities: {
      capture: false,
      recognition: { available: false, local: false, detail: 'not available in this test' },
    },
    voices: [],
    config: null,
    configBusy: false,
  }
}

describe('GlobalComposer', () => {
  it('keeps the draft when Core does not accept the send', async () => {
    const onSend = vi.fn(async () => false)

    render(
      <GlobalComposer
        generating={false}
        defaultModel={null}
        voice={voice()}
        voiceTranscript={null}
        onVoicePress={vi.fn()}
        onVoiceRelease={vi.fn()}
        maxMessageCharacters={8000}


        onSend={onSend}
        onStopResponse={vi.fn()}
      />,
    )

    fireEvent.change(input(), { target: { value: 'do not lose me' } })
    fireEvent.submit(screen.getByRole('form', { name: 'Freya composer' }))

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('do not lose me', 'chat', { webSearch: false, browserUse: false }))
    expect(input().value).toBe('do not lose me')
  })

  it('clears the accepted draft so the bar is ready for the next message', async () => {
    const onSend = vi.fn(async () => true)

    render(
      <GlobalComposer
        generating={false}
        defaultModel={null}
        voice={voice()}
        voiceTranscript={null}
        onVoicePress={vi.fn()}
        onVoiceRelease={vi.fn()}
        maxMessageCharacters={8000}


        onSend={onSend}
        onStopResponse={vi.fn()}
      />,
    )

    fireEvent.change(input(), { target: { value: 'hello freya' } })
    fireEvent.submit(screen.getByRole('form', { name: 'Freya composer' }))

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('hello freya', 'chat', { webSearch: false, browserUse: false }))
    await waitFor(() => expect(input().value).toBe(''))
  })

  it('sends the selected Freya mode with the draft', async () => {
    const onSend = vi.fn(async () => true)

    render(
      <GlobalComposer
        generating={false}
        defaultModel={null}
        voice={voice()}
        voiceTranscript={null}
        onVoicePress={vi.fn()}
        onVoiceRelease={vi.fn()}
        maxMessageCharacters={8000}


        onSend={onSend}
        onStopResponse={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Chat/i }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Freya's Eye/i }))
    fireEvent.change(input(), { target: { value: 'find 100 cat videos' } })
    fireEvent.submit(screen.getByRole('form', { name: 'Freya composer' }))

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('find 100 cat videos', 'eye', { webSearch: false, browserUse: false }))
  })

  it('turns the send control into a real stop-response control while generating', () => {
    const onStopResponse = vi.fn()

    render(
      <GlobalComposer
        generating
        defaultModel={null}
        voice={voice()}
        voiceTranscript={null}
        onVoicePress={vi.fn()}
        onVoiceRelease={vi.fn()}
        maxMessageCharacters={8000}


        onSend={vi.fn(async () => true)}
        onStopResponse={onStopResponse}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Stop response' }))
    expect(onStopResponse).toHaveBeenCalledTimes(1)
  })
})


describe('GlobalComposer keyboard and bounds', () => {
  it('Enter sends while Shift+Enter keeps a newline in the draft', async () => {
    const onSend = vi.fn(async () => true)

    render(
      <GlobalComposer
        generating={false}
        defaultModel={null}
        voice={voice()}
        voiceTranscript={null}
        onVoicePress={vi.fn()}
        onVoiceRelease={vi.fn()}
        maxMessageCharacters={8000}


        onSend={onSend}
        onStopResponse={vi.fn()}
      />,
    )

    fireEvent.change(input(), { target: { value: 'first line' } })
    fireEvent.keyDown(input(), { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()

    fireEvent.change(input(), { target: { value: 'first line\nsecond line' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('first line\nsecond line', 'chat', { webSearch: false, browserUse: false }))
  })

  it('takes the message ceiling from Core instead of inventing a renderer limit', () => {
    render(
      <GlobalComposer
        generating={false}
        defaultModel={null}
        voice={voice()}
        voiceTranscript={null}
        onVoicePress={vi.fn()}
        onVoiceRelease={vi.fn()}
        maxMessageCharacters={1234}


        onSend={vi.fn(async () => true)}
        onStopResponse={vi.fn()}
      />,
    )

    expect(input().maxLength).toBe(1234)
  })

  it('Ctrl+Enter sends the message from multiline draft', async () => {
    const onSend = vi.fn(async () => true)
    render(
      <GlobalComposer
        generating={false}
        defaultModel={null}
        voice={voice()}
        voiceTranscript={null}
        onVoicePress={vi.fn()}
        onVoiceRelease={vi.fn()}
        maxMessageCharacters={8000}
        onSend={onSend}
        onStopResponse={vi.fn()}
      />,
    )

    fireEvent.change(input(), { target: { value: 'line 1\nline 2' } })
    fireEvent.keyDown(input(), { key: 'Enter', ctrlKey: true })

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('line 1\nline 2', 'chat', { webSearch: false, browserUse: false }))
  })

  it('Escape key triggers onStopResponse while generating', () => {
    const onStopResponse = vi.fn()
    render(
      <GlobalComposer
        generating
        defaultModel={null}
        voice={voice()}
        voiceTranscript={null}
        onVoicePress={vi.fn()}
        onVoiceRelease={vi.fn()}
        maxMessageCharacters={8000}
        onSend={vi.fn(async () => true)}
        onStopResponse={onStopResponse}
      />,
    )

    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(onStopResponse).toHaveBeenCalledTimes(1)
  })

  it('preserves draft per conversation when switching conversations', async () => {
    const onSend = vi.fn(async () => true)
    const { rerender } = render(
      <GlobalComposer
        generating={false}
        defaultModel={null}
        voice={voice()}
        voiceTranscript={null}
        onVoicePress={vi.fn()}
        onVoiceRelease={vi.fn()}
        maxMessageCharacters={8000}
        onSend={onSend}
        onStopResponse={vi.fn()}
        conversationId="conv-1"
      />,
    )

    // Type in conv-1
    fireEvent.change(input(), { target: { value: 'Draft for conversation 1' } })
    expect(input().value).toBe('Draft for conversation 1')

    // Switch to conv-2
    rerender(
      <GlobalComposer
        generating={false}
        defaultModel={null}
        voice={voice()}
        voiceTranscript={null}
        onVoicePress={vi.fn()}
        onVoiceRelease={vi.fn()}
        maxMessageCharacters={8000}
        onSend={onSend}
        onStopResponse={vi.fn()}
        conversationId="conv-2"
      />,
    )

    // Field should be empty for conv-2
    expect(input().value).toBe('')

    // Type in conv-2
    fireEvent.change(input(), { target: { value: 'Draft for conversation 2' } })
    expect(input().value).toBe('Draft for conversation 2')

    // Switch back to conv-1
    rerender(
      <GlobalComposer
        generating={false}
        defaultModel={null}
        voice={voice()}
        voiceTranscript={null}
        onVoicePress={vi.fn()}
        onVoiceRelease={vi.fn()}
        maxMessageCharacters={8000}
        onSend={onSend}
        onStopResponse={vi.fn()}
        conversationId="conv-1"
      />,
    )

    // Conv-1 draft is preserved!
    expect(input().value).toBe('Draft for conversation 1')
  })

  it('displays character counter near limit and alerts when over limit', () => {
    render(
      <GlobalComposer
        generating={false}
        defaultModel={null}
        voice={voice()}
        voiceTranscript={null}
        onVoicePress={vi.fn()}
        onVoiceRelease={vi.fn()}
        maxMessageCharacters={100}
        onSend={vi.fn(async () => true)}
        onStopResponse={vi.fn()}
      />,
    )

    // Under 90% (80 chars) -> no counter
    fireEvent.change(input(), { target: { value: 'a'.repeat(50) } })
    expect(screen.queryByText(/100/)).toBeNull()

    // 92 chars -> near limit counter appears
    fireEvent.change(input(), { target: { value: 'a'.repeat(92) } })
    expect(screen.getByText('92 / 100')).toBeInTheDocument()
    expect(screen.getByText('92 / 100')).toHaveClass('near-limit')

    // Over limit
    fireEvent.change(input(), { target: { value: 'a'.repeat(105) } })
    expect(screen.getByRole('alert')).toHaveTextContent('105 / 100 (limit exceeded)')
    expect(screen.getByRole('alert')).toHaveClass('over-limit')
  })

  it('handles drag and drop overlay and files drop', async () => {
    const onNotice = vi.fn()
    render(
      <GlobalComposer
        generating={false}
        defaultModel={null}
        voice={voice()}
        voiceTranscript={null}
        onVoicePress={vi.fn()}
        onVoiceRelease={vi.fn()}
        maxMessageCharacters={8000}
        onSend={vi.fn(async () => true)}
        onStopResponse={vi.fn()}
        onNotice={onNotice}
      />,
    )

    const form = screen.getByRole('form', { name: 'Freya composer' })

    // Drag enter with Files
    fireEvent.dragEnter(form, { dataTransfer: { types: ['Files'] } })
    expect(screen.getByText(/Drop files or pictures here to attach/)).toBeInTheDocument()

    // Drop text file
    const file = new File(['sample code'], 'test.ts', { type: 'text/typescript' })
    fireEvent.drop(form, { dataTransfer: { files: [file], types: ['Files'] } })

    await waitFor(() => {
      expect(attachmentTray.getSnapshot()).toHaveLength(1)
      expect(attachmentTray.getSnapshot()[0]?.name).toBe('test.ts')
    })
  })

  it('handles clipboard image paste', async () => {
    const onNotice = vi.fn()
    render(
      <GlobalComposer
        generating={false}
        defaultModel={null}
        voice={voice()}
        voiceTranscript={null}
        onVoicePress={vi.fn()}
        onVoiceRelease={vi.fn()}
        maxMessageCharacters={8000}
        onSend={vi.fn(async () => true)}
        onStopResponse={vi.fn()}
        onNotice={onNotice}
      />,
    )

    const imageBytes = new Uint8Array([137, 80, 78, 71])
    const file = new File([imageBytes], 'clipboard.png', { type: 'image/png' })
    const mockItem = {
      kind: 'file',
      type: 'image/png',
      getAsFile: () => file,
    } as unknown as DataTransferItem

    fireEvent.paste(input(), {
      clipboardData: {
        files: [],
        items: [mockItem],
      },
    })

    await waitFor(() => {
      expect(attachmentTray.getSnapshot()).toHaveLength(1)
      expect(attachmentTray.getSnapshot()[0]?.kind).toBe('image')
      expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('Picture attached from clipboard.'))
    })
  })
})
