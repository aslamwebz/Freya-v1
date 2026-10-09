import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Glyph } from '../../ui-v2/primitives/Glyph'
import { ModelSelector } from './ModelSelector'
import { ModeSelector } from './ModeSelector'
import { ThinkingSelector, readStoredThinkingLevel, type ThinkingLevel } from './ThinkingSelector'
import type { ComposerMode } from '../chat/modes'
import type { VoiceView } from '../voice/useVoiceDock'
import {
  attachmentLabel,
  attachmentTray,
  ingestBrowserFiles,
  ingestClipboardData,
  pickAttachments,
} from '../chat/attachments'
import { sharedRightWorkspaceStore } from '../chat/rightWorkspaceStore'
import { sharedComposerDraftStore } from '../chat/composerDraftStore'
import { conversationMirror } from '../../platform/conversationClient'

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
        <button
          type="button"
          style={{ background: 'transparent', border: 0, color: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', padding: 0, font: 'inherit' }}
          onClick={() => sharedRightWorkspaceStore().openFiles(draft.id)}
          title={`Preview ${draft.name} in right workspace`}
        >
          <Glyph name="attach" size={12} />
          <span>{draft.name}</span>
          <small style={{ opacity: 0.7 }}>{attachmentLabel(draft)}</small>
        </button>
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
  conversationId: propConversationId,
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
  onNotice?: (message: string) => void
  conversationId?: string | null
}) {
  const projection = useSyncExternalStore(
    conversationMirror().subscribe,
    () => conversationMirror().projection,
    () => conversationMirror().projection,
  )
  const activeConversationId =
    propConversationId !== undefined
      ? propConversationId
      : (projection?.activeConversationId ?? null)
  const draftStore = sharedComposerDraftStore()

  // Initialize draft from store
  const initialDraft = draftStore.getDraft(activeConversationId)
  const [text, setText] = useState(initialDraft.text)
  const [sending, setSending] = useState(false)
  const [attaching, setAttaching] = useState(false)
  const [mode, setMode] = useState<ComposerMode>(initialDraft.mode)
  const [wantWeb, setWantWeb] = useState(initialDraft.wantWeb)
  const [wantBrowser, setWantBrowser] = useState(initialDraft.wantBrowser)
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(
    (initialDraft.thinkingLevel as ThinkingLevel) || readStoredThinkingLevel(),
  )
  const [dragOver, setDragOver] = useState(false)
  const dragCounterRef = useRef(0)
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null)
  const prevConvRef = useRef<string | null>(activeConversationId)

  const drafts = useSyncExternalStore(
    attachmentTray.subscribe,
    attachmentTray.getSnapshot,
    attachmentTray.getSnapshot,
  )

  // Sync draft across conversation switching
  useEffect(() => {
    if (prevConvRef.current === activeConversationId) return
    // Save draft for previous conversation
    draftStore.setDraft(prevConvRef.current, {
      text,
      mode,
      wantWeb,
      wantBrowser,
      thinkingLevel,
    })
    // Restore draft for new conversation
    const saved = draftStore.getDraft(activeConversationId)
    setText(saved.text)
    setMode(saved.mode)
    setWantWeb(saved.wantWeb)
    setWantBrowser(saved.wantBrowser)
    if (saved.thinkingLevel) setThinkingLevel(saved.thinkingLevel as ThinkingLevel)
    prevConvRef.current = activeConversationId
  }, [activeConversationId, text, mode, wantWeb, wantBrowser, thinkingLevel, draftStore])

  const handleTextChange = useCallback(
    (value: string) => {
      setText(value)
      draftStore.setDraft(activeConversationId, { text: value })
    },
    [activeConversationId, draftStore],
  )

  const handleModeChange = useCallback(
    (newMode: ComposerMode) => {
      setMode(newMode)
      draftStore.setDraft(activeConversationId, { mode: newMode })
    },
    [activeConversationId, draftStore],
  )

  const handleWantWebToggle = useCallback(() => {
    setWantWeb((prev) => {
      const next = !prev
      draftStore.setDraft(activeConversationId, { wantWeb: next })
      return next
    })
  }, [activeConversationId, draftStore])

  const handleWantBrowserToggle = useCallback(() => {
    setWantBrowser((prev) => {
      const next = !prev
      draftStore.setDraft(activeConversationId, { wantBrowser: next })
      return next
    })
  }, [activeConversationId, draftStore])

  const handleThinkingChange = useCallback(
    (level: ThinkingLevel) => {
      setThinkingLevel(level)
      draftStore.setDraft(activeConversationId, { thinkingLevel: level })
    },
    [activeConversationId, draftStore],
  )

  useEffect(() => {
    if (voiceTranscript === null) return
    handleTextChange(
      text.trim().length === 0 ? voiceTranscript.text : `${text} ${voiceTranscript.text}`,
    )
  }, [voiceTranscript])

  /**
   * Auto-grow textarea up to cap
   */
  useEffect(() => {
    const field = textAreaRef.current
    if (!field) return
    field.style.height = 'auto'
    field.style.height = `${field.scrollHeight}px`
  }, [text])

  const inFlight = sending || generating
  const isOverLimit =
    maxMessageCharacters !== null &&
    maxMessageCharacters > 0 &&
    text.length > maxMessageCharacters
  const nearLimit =
    maxMessageCharacters !== null &&
    maxMessageCharacters > 0 &&
    text.length >= Math.floor(maxMessageCharacters * 0.9)

  const submit = async () => {
    const value = text.trim()
    if ((value.length === 0 && drafts.length === 0) || generating || sending) return
    if (isOverLimit) {
      onNotice?.(`Message exceeds maximum length of ${maxMessageCharacters} characters.`)
      return
    }

    const textToSend =
      value.length > 0
        ? value
        : drafts.length === 1
          ? 'Please review this attached file.'
          : 'Please review these attached files.'

    onNotice?.('')
    setSending(true)
    try {
      const accepted = await onSend(textToSend, mode, { webSearch: wantWeb, browserUse: wantBrowser })
      if (accepted) {
        setText('')
        draftStore.clearDraft(activeConversationId)
      }
    } finally {
      setSending(false)
    }
  }

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
      const refused = picked.attachments
        .filter((file) => file.detail !== null && file.kind === 'unsupported')
        .map((file) => file.detail as string)
      onNotice?.([...refused, ...notices].join(' ') || '')
    } finally {
      setAttaching(false)
    }
  }

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    dragCounterRef.current += 1
    if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
      setDragOver(true)
    }
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    dragCounterRef.current -= 1
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0
      setDragOver(false)
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy'
    }
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    dragCounterRef.current = 0
    setDragOver(false)
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onNotice?.('')
      const outcome = await ingestBrowserFiles(e.dataTransfer.files)
      if (outcome.notices.length > 0) {
        onNotice?.(outcome.notices.join(' '))
      }
    }
  }

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (e.clipboardData) {
      const outcome = await ingestClipboardData(e.clipboardData)
      if (outcome.handled) {
        e.preventDefault()
        if (outcome.notices.length > 0) {
          onNotice?.(outcome.notices.join(' '))
        }
      }
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // ArrowUp on empty text: recall last user message
    if (event.key === 'ArrowUp' && text.length === 0) {
      const messages = projection?.messages ?? []
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg && msg.role === 'user' && msg.content) {
          event.preventDefault()
          handleTextChange(msg.content)
          break
        }
      }
      return
    }

    // Escape: cancel generation if in flight
    if (event.key === 'Escape') {
      if (generating) {
        event.preventDefault()
        onStopResponse()
        return
      }
    }

    // Ctrl+Enter or Cmd+Enter: send
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      void submit()
      return
    }

    // Plain Enter: send (unless shiftKey or composing)
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void submit()
      return
    }
  }

  return (
    <footer
      className="hd-dock"
      data-state={voice.capturing ? 'listening' : generating ? 'responding' : 'idle'}
    >
      <AttachmentTray />
      <form
        aria-label="Freya composer"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
        className="hd-dock-form"
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {dragOver ? (
          <div className="hd-composer-drop-overlay" aria-live="polite">
            <Glyph name="attach" size={20} />
            <span>Drop files or pictures here to attach</span>
          </div>
        ) : null}
        <label className="hd-input">
          <span className="hd-sr-only">Ask Freya</span>
          <textarea
            ref={textAreaRef}
            aria-label="Ask Freya"
            value={text}
            rows={1}
            maxLength={
              maxMessageCharacters && maxMessageCharacters > 0 ? maxMessageCharacters : undefined
            }
            onChange={(event) => handleTextChange(event.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={
              voice.capturing
                ? 'Listening…'
                : generating
                  ? 'Freya is responding…'
                  : 'Ask Freya...'
            }
          />
          {nearLimit || isOverLimit ? (
            <small
              className={`hd-input-count ${isOverLimit ? 'over-limit' : 'near-limit'}`}
              role={isOverLimit ? 'alert' : 'status'}
              aria-live="polite"
            >
              {text.length} / {maxMessageCharacters}
              {isOverLimit ? ' (limit exceeded)' : ''}
            </small>
          ) : null}
        </label>
        <div className="hd-dock-controls">
          <VoiceDockButton voice={voice} onPress={onVoicePress} onRelease={onVoiceRelease} />
          <div className="hd-tools">
            <button
              type="button"
              className="hd-tool"
              aria-label="Attach a file"
              disabled={attaching}
              onClick={() => {
                void attach()
              }}
            >
              <Glyph name="attach" size={18} />
            </button>
            <ModeSelector mode={mode} onChange={handleModeChange} />
            <button
              type="button"
              className="hd-tool hd-tool-search hd-intent-toggle"
              role="switch"
              aria-checked={wantWeb}
              aria-label="Web search"
              title={
                wantWeb
                  ? 'Web search is on. Click to turn off.'
                  : 'Web search is off. Click to turn on.'
              }
              onClick={handleWantWebToggle}
            >
              <span>Web search</span>
              <span className="hd-switch-track" aria-hidden="true">
                <span className="hd-switch-thumb" />
              </span>
              <span className="hd-switch-state" aria-hidden="true">
                {wantWeb ? 'On' : 'Off'}
              </span>
            </button>
            <button
              type="button"
              className="hd-tool hd-tool-browser hd-intent-toggle"
              role="switch"
              aria-checked={wantBrowser}
              aria-label="Browser"
              title={
                wantBrowser
                  ? 'Browser use is on. Click to turn off.'
                  : 'Browser use is off. Click to turn on.'
              }
              onClick={handleWantBrowserToggle}
            >
              <span>Browser</span>
              <span className="hd-switch-track" aria-hidden="true">
                <span className="hd-switch-thumb" />
              </span>
              <span className="hd-switch-state" aria-hidden="true">
                {wantBrowser ? 'On' : 'Off'}
              </span>
            </button>
            <ThinkingSelector value={thinkingLevel} onChange={handleThinkingChange} />
            <ModelSelector defaultModel={defaultModel} />
          </div>
          {inFlight ? (
            <button
              className="hd-send hd-send-busy"
              type="button"
              aria-label={generating ? 'Stop response' : 'Sending message'}
              title={generating ? 'Stop this response (Escape)' : 'Sending'}
              disabled={!generating}
              onClick={onStopResponse}
            >
              <span className="hd-send-orb" aria-hidden="true" />
            </button>
          ) : (
            <button
              className="hd-send"
              type="submit"
              aria-label="Send message"
              disabled={(!text.trim() && drafts.length === 0) || isOverLimit}
            >
              <Glyph name="send" size={20} />
            </button>
          )}
        </div>
        <span className="hd-sr-only" role="status" aria-live="polite">
          {generating ? 'Freya is responding.' : sending ? 'Sending your message.' : ''}
        </span>
      </form>
    </footer>
  )
}
