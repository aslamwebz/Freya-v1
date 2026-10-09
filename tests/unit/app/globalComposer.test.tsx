import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GlobalComposer } from '../../../src/app/screens/GlobalComposer'
import type { VoiceView } from '../../../src/app/voice/useVoiceDock'

afterEach(cleanup)

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
})
