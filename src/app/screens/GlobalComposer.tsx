import { useEffect, useState } from 'react'
import { Glyph } from '../../ui-v2/primitives/Glyph'
import { ModelSelector } from './ModelSelector'
import { ThinkingSelector } from './ThinkingSelector'
import { ModeSelector } from './ModeSelector'
import type { ComposerMode } from '../chat/modes'
import type { VoiceView } from '../voice/useVoiceDock'

function VoiceDockButton({ voice, onPress, onRelease }: {
  voice: VoiceView
  onPress: () => void
  onRelease: (cancelled?: boolean) => void
}) {
  const [holding, setHolding] = useState(false)

  const label = voice.capturing
    ? 'Release to stop recording'
    : voice.speaking
      ? 'Hold to interrupt Freya and speak'
      : (voice.unavailableReason ?? 'Hold to speak to Freya')

  return <button
    type="button"
    className="hd-mic"
    aria-label={label}
    aria-pressed={voice.capturing}
    aria-describedby={voice.unavailableReason ? 'hd-mic-detail' : undefined}
    disabled={voice.state === 'unsupported' || !voice.capabilities.capture}
    data-capturing={voice.capturing || undefined}
    data-voice-state={voice.state}
    onPointerDown={event => {
      if (voice.capturing) return
      event.preventDefault()
      setHolding(true)
      onPress()
    }}
    onPointerUp={() => {
      if (!holding) return
      setHolding(false)
      onRelease(false)
    }}
    onPointerCancel={() => {
      if (!holding) return
      setHolding(false)
      onRelease(true)
    }}
    onPointerLeave={() => {
      if (!holding) return
      setHolding(false)
      onRelease(false)
    }}
    onContextMenu={event => event.preventDefault()}
    onDoubleClick={() => {
      if (!holding) return
      setHolding(false)
      onRelease(true)
    }}
    title={label}
  >
    <Glyph name="mic" size={22} />
    <span className="hd-sr-only" role="status" aria-live="polite">
      {voice.capturing ? 'Recording locally. Release to stop.' : ''}
    </span>
    {voice.unavailableReason
      ? <span className="hd-sr-only" id="hd-mic-detail">{voice.unavailableReason}</span>
      : null}
  </button>
}

/**
 * The global dock composer, self-contained.
 *
 * The draft, the listening toggle and the local voice notice live here, so a
 * keystroke in the composer re-renders the composer and its two selectors —
 * never the dashboard, its panels or the centre. The draft is handed up only on
 * submit, which keeps the real conversation send contract (App still owns the
 * bridge call) while removing per-keystroke board reconciliation.
 */
export function GlobalComposer({
  generating,
  notice,
  defaultModel,
  voice,
  voiceTranscript,
  onSend,
  onStopResponse,
  onVoicePress,
  onVoiceRelease,
}: {
  generating: boolean
  notice: string
  defaultModel: string | null
  voice: VoiceView
  voiceTranscript: { id: number; text: string } | null
  onSend: (text: string, mode: ComposerMode) => Promise<boolean>
  onStopResponse: () => void
  onVoicePress: () => void
  onVoiceRelease: (cancelled?: boolean) => void
}) {
  const [text, setText] = useState('')
  const [voiceNotice, setVoiceNotice] = useState('')
  const [sending, setSending] = useState(false)
  const [mode, setMode] = useState<ComposerMode>('chat')

  useEffect(() => {
    if (voiceTranscript === null) return
    setText(current => current.trim().length === 0
      ? voiceTranscript.text
      : `${current} ${voiceTranscript.text}`)
  }, [voiceTranscript])

  const submit = async () => {
    const value = text.trim()
    if (value.length === 0 || generating || sending) return
    setVoiceNotice('')
    setSending(true)
    try {
      const accepted = await onSend(value, mode)
      if (accepted) setText('')
    } finally {
      setSending(false)
    }
  }

  return <footer className="hd-dock" data-state={voice.capturing ? 'listening' : generating ? 'responding' : 'idle'}>
    <form aria-label="Freya composer" onSubmit={event => { event.preventDefault(); void submit() }}>
      <VoiceDockButton voice={voice} onPress={onVoicePress} onRelease={onVoiceRelease} />
      <label className="hd-input"><span className="hd-sr-only">Ask Freya</span><input value={text} onChange={event => setText(event.target.value)} placeholder={voice.capturing ? 'Listening…' : generating ? 'Freya is responding…' : 'Ask Freya...'} /></label>
      <span className="hd-wave" aria-hidden="true">{Array.from({ length: 5 }, (_, i) => <i key={i} style={{ animationDelay: `${i * 0.13}s` }} />)}</span>
      <div className="hd-tools">
        <button type="button" className="hd-tool" aria-label="Attach a file" onClick={() => setVoiceNotice('Attachments are not connected yet.')}><Glyph name="attach" size={18} /></button>
        <ModeSelector mode={mode} onChange={setMode} />
        <ModelSelector defaultModel={defaultModel} />
        <ThinkingSelector />
      </div>
      {generating
        ? <button className="hd-send hd-stop-response" type="button" aria-label="Stop response" title="Stop this response" onClick={onStopResponse}><span className="hd-stop-square" aria-hidden="true" /></button>
        : <button className="hd-send" type="submit" aria-label={sending ? 'Sending message' : 'Send message'} disabled={!text.trim() || sending}>{sending ? <span className="hd-send-orb" aria-hidden="true" /> : <Glyph name="send" size={20} />}</button>}
    </form>
    {(voice.notice || notice || voiceNotice || generating) && <p className="hd-notice" role="status">{voice.notice || notice || voiceNotice || 'Freya is thinking…'}</p>}
  </footer>
}
