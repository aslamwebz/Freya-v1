import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { manager } from '../boot'
import { shellStore, useShell } from '../store'
import { submitCommand } from '../commandPath'
import { conversationMirror } from '../../platform/conversationClient'
import { useConversation, useConversationId, useConversationMessages } from '../../core/useConversation'
import { MicButton } from '../surfaces/MicButton'
import { useVoice } from '../../core/useVoice'
import { Icon, type IconName } from '../icons'
import { surfaceTypes, type SurfaceType } from '../../core/surfaces/types'
import { launcherSurfaces } from '../surfaces/registry'

/**
 * The chat bar, which is what the floating dock used to be.
 *
 * It replaces a row of surface buttons with the thing those buttons were
 * standing in for: somewhere to talk to Freya. The surface switcher is still
 * here, on the left, because window management is a promise this shell makes —
 * minimising a window has to leave a way to bring it back.
 *
 * ## One conversation, one path
 *
 * This bar and the Chat surface submit through the *same* Mind, the same grant
 * and the same Gateway. There is no second chat implementation and no "quick
 * send" that skips the pipeline — a message typed here is a conversation turn in
 * every respect except which window it was typed in, because "one intelligence,
 * many surfaces" means the surfaces do not get their own brains.
 *
 * ## Ask or command
 *
 * Two modes, chosen explicitly and visibly. The distinction is not cosmetic:
 * ordinary text is a conversation turn, and a command is a privileged act that
 * Guard evaluates. Silently treating a sentence as a privileged command is how a
 * chat window becomes a shell, so it cannot happen here — `Command` is a mode you
 * put Freya in, not a prefix it guesses at.
 */
const LAUNCHER_ICON: Partial<Record<SurfaceType, IconName>> = {
  chat: 'relay',
  search: 'search',
  work: 'work',
  mission: 'mission',
  vault: 'vault',
  harness: 'harness',
  security: 'shield',
}

type InputMode = 'ask' | 'command'

export function ChatBar({ onToggle }: { onToggle: (type: SurfaceType) => void }) {
  const chat = useShell((s) => s.chat)
  const listening = useShell((s) => s.listening)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<InputMode>('ask')
  const logRef = useRef<HTMLDivElement | null>(null)

  const surfaces = useSyncExternalStore(manager.subscribe, () => manager.surfaces)
  const focusedId = manager.focused?.id
  const conversation = useConversation()
  const voice = useVoice()
  const messages = useConversationMessages()
  const conversationId = useConversationId()
  const generating = conversation?.activeTurn != null

  // Keep the newest line in view without stealing focus from the input.
  useEffect(() => {
    const log = logRef.current
    if (log) log.scrollTop = log.scrollHeight
  }, [chat.length, conversation?.messages.length])

  const send = async () => {
    const text = draft.trim()
    if (!text || busy) return
    setDraft('')
    setBusy(true)
    try {
      if (mode === 'command') {
        // The command path: recorded durably, no cognition. Kept because some
        // things genuinely are commands, and because it must never be something a
        // sentence can trigger by accident.
        await submitCommand(text, 'chat-bar')
        return
      }
      // The conversation path. A refusal or a failure is reported as itself, and
      // the message stays in the transcript because Core stored it.
      const target = await conversationId()
      if (target === null) {
        shellStore.dispatch({
          type: 'command.acknowledged',
          ok: false,
          detail: 'Freya has no conversation available, so the message was not sent.',
        })
        return
      }
      const outcome = await conversationMirror().submitTurn(target, text)
      if (outcome.operation === 'turn' && outcome.turn.outcome !== 'completed') {
        shellStore.dispatch({
          type: 'command.acknowledged',
          ok: false,
          detail: outcome.turn.reason ?? 'That turn did not complete.',
        })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="chatbar">
      <div className="chatbar-switcher" role="toolbar" aria-label="Work surfaces">
        {launcherSurfaces().map((definition) => {
          const type = definition.type
          const icon = LAUNCHER_ICON[type] ?? 'work'
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
          {messages.length === 0 && chat.length === 0 ? (
            <p className="chatbar-empty">
              Nothing said yet. Ask Freya something — she will think once and answer once.
            </p>
          ) : (
            <>
              {messages.map((message) => (
                <p
                  key={message.messageId}
                  className="chatbar-line"
                  data-role={message.role}
                >
                  <span className="chatbar-who">{message.role === 'user' ? 'You' : 'Freya'}</span>
                  {/* Plain text: model output is untrusted content, never markup. */}
                  <span className="chatbar-text">{message.content}</span>
                </p>
              ))}
              {/* Command acknowledgements, which are Core's reply and not a turn.
                  Only the command path writes these. */}
              {chat.map((line) => (
                <p
                  key={`command-${line.id}`}
                  className="chatbar-line"
                  data-role="command"
                  data-refused={line.refused || undefined}
                >
                  <span className="chatbar-who">Core</span>
                  <span className="chatbar-text">{line.text}</span>
                </p>
              ))}
            </>
          )}
        </div>

        <form
          className="chatbar-form"
          onSubmit={(event) => {
            event.preventDefault()
            void send()
          }}
        >
          <div className="chatbar-modes" role="group" aria-label="Input mode">
            <button
              type="button"
              className="chatbar-mode"
              aria-pressed={mode === 'ask'}
              onClick={() => setMode('ask')}
              title="Talk to Freya. She will think once and answer once."
            >
              Ask
            </button>
            <button
              type="button"
              className="chatbar-mode"
              aria-pressed={mode === 'command'}
              onClick={() => setMode('command')}
              title="Send a command. Recorded by Core; no model is asked."
            >
              Command
            </button>
          </div>
          {/* The same press-to-record control the Chat surface uses. One voice
              implementation, one conversation pipeline, two composers — which is
              what "one intelligence, many surfaces" has to mean in practice. */}
          <MicButton
            voice={voice}
            onTranscript={(text) => setDraft((current) => (current.length > 0 ? `${current} ${text}` : text))}
          />
          <input
            type="text"
            className="chatbar-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={
              mode === 'command'
                ? 'Send a command to Freya Core…'
                : listening
                  ? "I'm listening…"
                  : 'Tell Freya something…'
            }
            aria-label={mode === 'command' ? 'Command Freya' : 'Message Freya'}
            aria-busy={busy}
            spellCheck={false}
            autoComplete="off"
          />
          {generating ? (
            <button
              type="button"
              className="chatbar-stop"
              aria-label="Stop this response"
              onClick={() => {
                const turnId = conversation?.activeTurn?.turnId
                if (turnId) void conversationMirror().cancelTurn(turnId)
              }}
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              className="chatbar-send"
              aria-label="Send"
              title={mode === 'command' ? 'Send command to Freya Core' : 'Send to Freya'}
              disabled={draft.trim().length === 0 || busy}
            >
              <Icon name="send" />
            </button>
          )}
        </form>
      </div>
    </div>
  )
}
