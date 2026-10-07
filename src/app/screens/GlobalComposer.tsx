import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Glyph } from '../../ui-v2/primitives/Glyph'
import { ModelSelector } from './ModelSelector'
import { ThinkingSelector } from './ThinkingSelector'
import { ModeSelector } from './ModeSelector'
import type { ComposerMode } from '../chat/modes'
import type { VoiceView } from '../voice/useVoiceDock'
import { attachmentLabel, attachmentTray, pickAttachments } from '../chat/attachments'

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
 * Pending files, above the field.
 *
 * Each one is named, labelled with its type and size, and removable on its own —
 * because a person who attached the wrong screenshot has to be able to say so
 * before the turn goes, not after. The removal button carries the file name in
 * its accessible name, so two chips are never two identically-labelled buttons.
 *
 * The tray is read from a store rather than from props: `HomeDashboard` fixes this
 * component's prop list, and the send path in `App.tsx` reads the same store. The
 * bytes never pass through this component — it holds names, sizes and types.
 */
function AttachmentTray() {
  const drafts = useSyncExternalStore(
    attachmentTray.subscribe,
    attachmentTray.getSnapshot,
    attachmentTray.getSnapshot,
  )
  if (drafts.length === 0) return null

  return <ul
    aria-label="Pending attachments"
    style={{
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: '100%',
      margin: '0 0 8px',
      padding: 0,
      listStyle: 'none',
      display: 'flex',
      flexWrap: 'wrap',
      gap: 6,
    }}
  >
    {drafts.map((draft) => <li key={draft.id}>
      <span className="hd-tool" style={{ gap: 6 }} title={draft.detail ?? draft.name}>
        <Glyph name="attach" size={12} />
        <span>{draft.name}</span>
        <small style={{ opacity: 0.7 }}>{attachmentLabel(draft)}</small>
        <button
          type="button"
          aria-label={`Remove ${draft.name}`}
          onClick={() => attachmentTray.remove(draft.id)}
        >
          <Glyph name="win-close" size={11} />
        </button>
      </span>
    </li>)}
  </ul>
}

/**
 * The global dock composer, self-contained.
 *
 * The draft, the listening toggle and the local voice notice live here, so a
 * keystroke in the composer re-renders the composer and its two selectors —
 * never the dashboard, its panels or the centre. The draft is handed up only on
 * submit, which keeps the real conversation send contract (App still owns the
 * bridge call) while removing per-keystroke board reconciliation.
 *
 * The attach button asks the host for files through the real bridge function and
 * puts whatever comes back into the attachment tray. It is the renderer end of a
 * read that happens entirely in the main process: this window never sees a path it
 * could ask to read, only a bounded result it can label.
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
  maxMessageCharacters,
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
  maxMessageCharacters: number | null
}) {
  const [text, setText] = useState('')
  const [voiceNotice, setVoiceNotice] = useState('')
  const [sending, setSending] = useState(false)
  const [attaching, setAttaching] = useState(false)
  const [mode, setMode] = useState<ComposerMode>('chat')
  // Two intents the user can pin to the next message. Either or both, free.
  // Held only between presses; Send clears them and they take effect for the
  // one message they were held for.
  const [wantWeb, setWantWeb] = useState(false)
  const [wantBrowser, setWantBrowser] = useState(false)
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (voiceTranscript === null) return
    setText(current => current.trim().length === 0
      ? voiceTranscript.text
      : `${current} ${voiceTranscript.text}`)
  }, [voiceTranscript])

  useEffect(() => {
    const field = textAreaRef.current
    if (!field) return
    field.style.height = '0px'
    field.style.height = `${Math.min(field.scrollHeight, 132)}px`
  }, [text])

  // A turn is in flight from the moment the draft is submitted until Core reports
  // it finished. `sending` covers only the bridge call; `generating` covers the
  // provider request that follows. The control has to span both, or the orb
  // vanishes and is replaced by a stale send button mid-turn.
  const inFlight = sending || generating

  const nearLimit = maxMessageCharacters !== null &&
    maxMessageCharacters > 0 &&
    text.length >= Math.floor(maxMessageCharacters * 0.9)

  const submit = async () => {
    const value = text.trim()
    if (value.length === 0 || generating || sending) return
    // Wrap the draft with the intents the user has held. The intent layer
    // already detects both phrases, so no new infrastructure is needed — the
    // button just states a path the model would have guessed.
    let body = value
    if (wantWeb && !/^\s*(?:find|search|look up)\b/i.test(body)) body = `find on the web: ${body}`
    if (wantBrowser && !/\bus(?:e|ing)\b.*\bbrowser\b/i.test(body)) body = `use your browser: ${body}`
    const fire = () => {
      setWantWeb(false)
      setWantBrowser(false)
    }
    setVoiceNotice('')
    setSending(true)
    try {
      const accepted = await onSend(body, mode)
      if (accepted) setText('')
      fire()
    } finally {
      setSending(false)
      if (!text) fire()
    }
  }

  /**
   * Ask the host for files.
   *
   * The tray is *not* cleared here. A refusal keeps what the owner picked, and
   * even a successful pick is cleared by `App.tsx` when the turn that carries it
   * is accepted — otherwise a turn Core refused would silently consume the
   * attachments the owner still wanted.
   */
  const attach = async () => {
    if (attaching) return
    setVoiceNotice('')
    setAttaching(true)
    try {
      const picked = await pickAttachments()
      if (!picked.ok) {
        setVoiceNotice(picked.reason)
        return
      }
      if (picked.attachments.length === 0) return

      const { notices } = attachmentTray.add(picked.attachments)
      // A file the host refused to read is reported here, in the same sentence the
      // host wrote, rather than appearing in the tray as a name that leads nowhere.
      const refused = picked.attachments
        .filter((file) => file.detail !== null && file.kind === 'unsupported')
        .map((file) => file.detail as string)
      setVoiceNotice([...refused, ...notices].join(' ') || '')
    } finally {
      setAttaching(false)
    }
  }

  return <footer className="hd-dock" data-state={voice.capturing ? 'listening' : generating ? 'responding' : 'idle'}>
    <AttachmentTray />
    <form aria-label="Freya composer" onSubmit={event => { event.preventDefault(); void submit() }}>
      <VoiceDockButton voice={voice} onPress={onVoicePress} onRelease={onVoiceRelease} />
      <label className="hd-input">
        <span className="hd-sr-only">Ask Freya</span>
        <textarea
          ref={textAreaRef}
          value={text}
          rows={1}
          maxLength={maxMessageCharacters && maxMessageCharacters > 0 ? maxMessageCharacters : undefined}
          onChange={event => setText(event.target.value)}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
            event.preventDefault()
            void submit()
          }}
          placeholder={voice.capturing ? 'Listening…' : generating ? 'Freya is responding…' : 'Ask Freya...'}
        />
        {nearLimit ? <small className="hd-input-count" aria-live="polite">{text.length} / {maxMessageCharacters}</small> : null}
      </label>
      <div className="hd-tools">
        <button
          type="button"
          className="hd-tool"
          aria-label="Attach a file"
          disabled={attaching}
          onClick={() => { void attach() }}
        ><Glyph name="attach" size={18} /></button>
        <ModeSelector mode={mode} onChange={setMode} />
        {/* Two intent buttons. Pressed state means the wrapper is applied at
            Send, then cleared. Pressing the same one again drops the wrapper. */}
        <button
          type="button"
          className="hd-tool hd-tool-search"
          aria-pressed={wantWeb}
          aria-label={wantWeb ? 'Web search is on for the next message' : 'Add web search to the next message'}
          title={wantWeb ? 'Click to drop the search directive' : 'Add web search to the next message'}
          onClick={() => setWantWeb((value) => !value)}
        >
          <Glyph name="search" size={16} />
        </button>
        <button
          type="button"
          className="hd-tool hd-tool-browser"
          aria-pressed={wantBrowser}
          aria-label={wantBrowser ? 'Browser use is on for the next message' : 'Add browser use to the next message'}
          title={wantBrowser ? 'Click to drop the browser directive' : 'Add browser use to the next message'}
          onClick={() => setWantBrowser((value) => !value)}
        >
          <Glyph name="world" size={17} />
        </button>
        <ModelSelector defaultModel={defaultModel} />
        <ThinkingSelector />
      </div>
      {inFlight
        ? <button className="hd-send hd-send-busy" type="button"
            aria-label={generating ? 'Stop response' : 'Sending message'}
            title={generating ? 'Stop this response' : 'Sending'}
            disabled={!generating}
            onClick={onStopResponse}>
          <span className="hd-send-orb" aria-hidden="true" />
        </button>
        : <button className="hd-send" type="submit" aria-label="Send message" disabled={!text.trim()}><Glyph name="send" size={20} /></button>}
      <span className="hd-sr-only" role="status" aria-live="polite">
        {generating ? 'Freya is responding.' : sending ? 'Sending your message.' : ''}
      </span>
    </form>
    {(voice.notice || notice || voiceNotice || generating) && <p className="hd-notice" role="status">{voice.notice || notice || voiceNotice || 'Freya is thinking…'}</p>}
  </footer>
}
