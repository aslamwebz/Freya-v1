import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { manager } from '../boot'
import { shellStore, useShell } from '../store'
import { submitCommand } from '../commandPath'
import { Icon, type IconName } from '../icons'
import { surfaceTypes, type SurfaceType } from '../../core/surfaces/types'

/**
 * The chat bar, which is what the floating dock used to be.
 *
 * It replaces a row of surface buttons with the thing those buttons were
 * standing in for: somewhere to talk to Freya. The surface switcher is still
 * here, on the left, because window management is a promise this shell makes —
 * minimising a window has to leave a way to bring it back.
 *
 * ## What it does and does not do
 *
 * It submits through `submitCommand`, which is the same path the header's
 * command bar uses: renderer → typed client → Core → durable event → Core's
 * reply. Nothing is acknowledged locally. When Core has not answered, this bar
 * shows nothing, because showing something would be a claim about a system that
 * has not spoken yet.
 *
 * Model replies are not connected. The transcript says so once, plainly, rather
 * than leaving an empty pane to be interpreted as a reply that is coming.
 */
const SURFACES: { type: SurfaceType; icon: IconName }[] = [
  { type: 'chat', icon: 'relay' },
  { type: 'search', icon: 'search' },
  { type: 'work', icon: 'work' },
  { type: 'mission', icon: 'mission' },
  { type: 'vault', icon: 'vault' },
  { type: 'harness', icon: 'harness' },
  { type: 'foundry', icon: 'foundry' },
  { type: 'team', icon: 'team' },
]

export function ChatBar({ onToggle }: { onToggle: (type: SurfaceType) => void }) {
  const chat = useShell((s) => s.chat)
  const listening = useShell((s) => s.listening)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const logRef = useRef<HTMLDivElement | null>(null)

  const surfaces = useSyncExternalStore(manager.subscribe, () => manager.surfaces)
  const focusedId = manager.focused?.id

  // Keep the newest line in view without stealing focus from the input.
  useEffect(() => {
    const log = logRef.current
    if (log) log.scrollTop = log.scrollHeight
  }, [chat.length])

  const send = () => {
    const text = draft.trim()
    if (!text || busy) return
    setDraft('')
    setBusy(true)
    void submitCommand(text, 'chat-bar').finally(() => setBusy(false))
  }

  return (
    <div className="chatbar">
      <div className="chatbar-switcher" role="toolbar" aria-label="Work surfaces">
        {SURFACES.map(({ type, icon }) => {
          const descriptor = surfaceTypes[type]
          const open = surfaces.find((s) => s.type === type)
          const active = Boolean(open && !open.layout.minimized)
          return (
            <button
              key={type}
              type="button"
              className="chatbar-surface"
              aria-pressed={active}
              aria-label={descriptor.title}
              title={
                open
                  ? `${descriptor.title}${open.layout.minimized ? ' (minimised)' : ''}`
                  : descriptor.title
              }
              data-focused={open?.id === focusedId || undefined}
              onClick={() => onToggle(type)}
            >
              <Icon name={icon} />
              {open?.layout.minimized ? <em className="chatbar-badge">min</em> : null}
            </button>
          )
        })}
        <span className="sr-only" aria-live="polite">
          {focusedId ? `Focused surface ${focusedId}` : 'No surface focused'}
        </span>
      </div>

      <div className="chatbar-main">
        <div className="chatbar-log" ref={logRef} role="log" aria-label="Conversation with Freya">
          {chat.length === 0 ? (
            <p className="chatbar-empty">
              Nothing sent yet. Commands you send here reach Freya Core and are recorded; model
              replies are not connected yet.
            </p>
          ) : (
            chat.map((line) => (
              <p key={line.id} className="chatbar-line" data-role={line.role} data-refused={line.refused || undefined}>
                <span className="chatbar-who">{line.role === 'you' ? 'You' : 'Freya'}</span>
                <span className="chatbar-text">{line.text}</span>
              </p>
            ))
          )}
        </div>

        <form
          className="chatbar-form"
          onSubmit={(event) => {
            event.preventDefault()
            send()
          }}
        >
          <button
            type="button"
            className="chatbar-mic"
            aria-pressed={listening}
            aria-label={listening ? 'Stop listening' : 'Start listening'}
            title="Voice input boundary — the microphone is a UI state, not a recording"
            onClick={() => shellStore.dispatch({ type: 'voice.toggle', listening: !listening })}
          >
            <Icon name="mic" />
          </button>
          <input
            type="text"
            className="chatbar-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={listening ? "I'm listening…" : 'Tell Freya what to do…'}
            aria-label="Message Freya"
            aria-busy={busy}
            spellCheck={false}
            autoComplete="off"
          />
          <button
            type="submit"
            className="chatbar-send"
            aria-label="Send"
            title="Send to Freya Core"
            disabled={draft.trim().length === 0 || busy}
          >
            <Icon name="send" />
          </button>
        </form>
      </div>
    </div>
  )
}
