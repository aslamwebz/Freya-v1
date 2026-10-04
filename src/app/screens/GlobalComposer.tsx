import { useState } from 'react'
import { Glyph } from '../../ui-v2/primitives/Glyph'
import { ModelSelector } from './ModelSelector'
import { ThinkingSelector } from './ThinkingSelector'

/**
 * The global dock composer, self-contained.
 *
 * The draft, the listening toggle and the local voice notice live here, so a
 * keystroke in the composer re-renders the composer and its two selectors —
 * never the dashboard, its panels or the centre. The draft is handed up only on
 * submit, which keeps the real conversation send contract (App still owns the
 * bridge call) while removing per-keystroke board reconciliation.
 */
export function GlobalComposer({ generating, notice, defaultModel, onSend, onStopResponse }: {
  generating: boolean
  notice: string
  defaultModel: string | null
  onSend: (text: string) => Promise<boolean>
  onStopResponse: () => void
}) {
  const [text, setText] = useState('')
  const [listening, setListening] = useState(false)
  const [voiceNotice, setVoiceNotice] = useState('')
  const [sending, setSending] = useState(false)

  const submit = async () => {
    const value = text.trim()
    if (value.length === 0 || generating || sending) return
    setVoiceNotice('')
    setSending(true)
    try {
      const accepted = await onSend(value)
      if (accepted) setText('')
    } finally {
      setSending(false)
    }
  }

  return <footer className="hd-dock" data-state={listening ? 'listening' : generating ? 'responding' : 'idle'}>
    <form aria-label="Freya composer" onSubmit={event => { event.preventDefault(); void submit() }}>
      <button type="button" className="hd-mic" aria-pressed={listening} aria-label={listening ? 'Stop listening' : 'Start voice input'} onClick={() => { setListening(value => !value); setVoiceNotice('Voice capture is not connected yet. You can type to Freya.') }}><Glyph name="mic" size={22} /></button>
      <label className="hd-input"><span className="hd-sr-only">Ask Freya</span><input value={text} onChange={event => setText(event.target.value)} placeholder={listening ? 'Listening…' : generating ? 'Freya is responding…' : 'Ask Freya...'} /></label>
      <span className="hd-wave" aria-hidden="true">{Array.from({ length: 5 }, (_, i) => <i key={i} style={{ animationDelay: `${i * 0.13}s` }} />)}</span>
      <div className="hd-tools">
        <button type="button" className="hd-tool" aria-label="Attach a file" onClick={() => setVoiceNotice('Attachments are not connected yet.')}><Glyph name="attach" size={18} /></button>
        <ModelSelector defaultModel={defaultModel} />
        <ThinkingSelector />
      </div>
      {generating
        ? <button className="hd-send hd-stop-response" type="button" aria-label="Stop response" title="Stop this response" onClick={onStopResponse}><span className="hd-stop-square" aria-hidden="true" /></button>
        : <button className="hd-send" type="submit" aria-label={sending ? 'Sending message' : 'Send message'} disabled={!text.trim() || sending}>{sending ? <span className="hd-send-orb" aria-hidden="true" /> : <Glyph name="send" size={20} />}</button>}
    </form>
    {(notice || voiceNotice || generating) && <p className="hd-notice" role="status">{notice || voiceNotice || 'Freya is thinking…'}</p>}
  </footer>
}
