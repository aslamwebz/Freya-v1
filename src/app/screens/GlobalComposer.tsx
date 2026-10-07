import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Glyph } from '../../ui-v2/primitives/Glyph'
import { ModelSelector } from './ModelSelector'
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
 * The draft and the listening toggle live here, so a
 * keystroke in the composer re-renders the composer and its two selectors —
 * never the dashboard, its panels or the centre. The draft is handed up only on
 * submit, which keeps the real conversation send contract (App still owns the
 * bridge call) while removing per-keystroke board reconciliation.
 *
 * Nothing is printed above the field any more: "Freya is thinking" and every
 * local problem left this bar and now arrive in the conversation, where the chat
 * folds them into one hide/show section.
 *
 * The attach button asks the host for files through the real bridge function and
 * puts whatever comes back into the attachment tray. It is the renderer end of a
 * read that happens entirely in the main process: this window never sees a path it
 * could ask to read, only a bounded result it can label.
 */
export function GlobalComposer({
  generating,
  defaultModel,
  voice,
  voiceTranscript,
  onSend,
  onStopResponse,
  onVoicePress,
  onVoiceRelease,
  maxMessageCharacters,
  onNotice,
}: {
  generating: boolean
  defaultModel: string | null
  voice: VoiceView
  voiceTranscript: { id: number; text: string } | null
  onSend: (
    text: string,
    mode: ComposerMode,
    intents?: { readonly webSearch?: boolean; readonly browserUse?: boolean },
  ) => Promise<boolean>
  onStopResponse: () => void
  onVoicePress: () => void
  onVoiceRelease: (cancelled?: boolean) => void
  maxMessageCharacters: number | null
  /**
   * Where a local problem goes.
   *
   * The composer used to print its notices in a panel floating above itself. The
   * chat now owns the one place a person reads what went wrong, so the composer
   * reports rather than displays.
   */
  onNotice?: (message: string) => void
}) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [attaching, setAttaching] = useState(false)
  const [mode, setMode] = useState<ComposerMode>('chat')
  // Independent toggles apply to subsequent messages until the owner turns them off.
  const [wantWeb, setWantWeb] = useState(false)
  const [wantBrowser, setWantBrowser] = useState(false)
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (voiceTranscript === null) return
    setText(current => current.trim().length === 0
      ? voiceTranscript.text
      : `${current} ${voiceTranscript.text}`)
  }, [voiceTranscript])

  /**
   * Auto-grow the textarea up to the CSS cap, then let the field's own
   * scrollbar take over so the dock's controls row never moves. The cap lives
   * in CSS (`max-height: 160px`); once the natural content height crosses it,
   * `overflow-y: auto` on the field draws the scrollbar and the height stops
   * growing.
   */
  useEffect(() => {
    const field = textAreaRef.current
    if (!field) return
    field.style.height = 'auto'
    field.style.height = `${field.scrollHeight}px`
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
    // The owner's exact words reach Core as `value`. The two intent buttons
    // travel as structured metadata only — never as text prefixes. The old
    // behaviour prefixed "find on the web: " and "use your browser: " onto
    // the user's text and corrupted the stored message; that class is closed
    // by passing the text through unchanged and reporting the directives
    // separately.
    //
    // The draft is deliberately *not* cleared on a successful send. The owner
    // can keep iterating on it, or wipe it with the platform's clear shortcut,
    // and an interrupted turn never silently consumes the words it was sent.
    onNotice?.('')
    setSending(true)
    try {
      await onSend(value, mode, { webSearch: wantWeb, browserUse: wantBrowser })
    } finally {
      setSending(false)
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
    onNotice?.('')
    setAttaching(true)
    try {
      const picked = await pickAttachments()
      if (!picked.ok) {
        onNotice?.(picked.reason)
        return
      }
      if (picked.attachments.length === 0) return

      const { notices } = attachmentTray.add(picked.attachments)
      // A file the host refused to read is reported here, in the same sentence the
      // host wrote, rather than appearing in the tray as a name that leads nowhere.
      const refused = picked.attachments
        .filter((file) => file.detail !== null && file.kind === 'unsupported')
        .map((file) => file.detail as string)
      onNotice?.([...refused, ...notices].join(' ') || '')
    } finally {
      setAttaching(false)
    }
  }

  return <footer className="hd-dock" data-state={voice.capturing ? 'listening' : generating ? 'responding' : 'idle'}>
    <AttachmentTray />
    {/*
      The dock is now a two-row stack with no dividers between the rows. The
      textarea owns the top row and grows up to a cap before its own scrollbar
      appears, so a long draft never grows the bar taller than a screen of
      messages. The controls row beneath it stays fixed regardless of how tall
      the textarea gets, so the send control never moves while you type.
    */}
    <form aria-label="Freya composer" onSubmit={event => { event.preventDefault(); void submit() }} className="hd-dock-form">
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
      <div className="hd-dock-controls">
        <VoiceDockButton voice={voice} onPress={onVoicePress} onRelease={onVoiceRelease} />
        <div className="hd-tools">
          <button
            type="button"
            className="hd-tool"
            aria-label="Attach a file"
            disabled={attaching}
            onClick={() => { void attach() }}
          ><Glyph name="attach" size={18} /></button>
          <ModeSelector mode={mode} onChange={setMode} />
          {/* Toggle state survives sending; press again to turn a capability off. */}
          <button
            type="button"
            className="hd-tool hd-tool-search hd-intent-toggle"
            role="switch"
            aria-checked={wantWeb}
            aria-label="Web search"
            title={wantWeb ? 'Web search is on. Click to turn off.' : 'Web search is off. Click to turn on.'}
            onClick={() => setWantWeb((value) => !value)}
          >
            <span>Web search</span>
            <span className="hd-switch-track" aria-hidden="true"><span className="hd-switch-thumb" /></span>
            <span className="hd-switch-state" aria-hidden="true">{wantWeb ? 'On' : 'Off'}</span>
          </button>
          <button
            type="button"
            className="hd-tool hd-tool-browser hd-intent-toggle"
            role="switch"
            aria-checked={wantBrowser}
            aria-label="Browser"
            title={wantBrowser ? 'Browser use is on. Click to turn off.' : 'Browser use is off. Click to turn on.'}
            onClick={() => setWantBrowser((value) => !value)}
          >
            <span>Browser</span>
            <span className="hd-switch-track" aria-hidden="true"><span className="hd-switch-thumb" /></span>
            <span className="hd-switch-state" aria-hidden="true">{wantBrowser ? 'On' : 'Off'}</span>
          </button>
          <ModelSelector defaultModel={defaultModel} />
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
      </div>
      <span className="hd-sr-only" role="status" aria-live="polite">
        {generating ? 'Freya is responding.' : sending ? 'Sending your message.' : ''}
      </span>
    </form>
  </footer>
}
