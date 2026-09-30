import { useState } from 'react'
import { useShell } from '../store'
import { submitCommand } from '../commandPath'

interface Turn {
  id: number
  role: 'you' | 'freya'
  text: string
}

let turnId = 0

/**
 * Chat — a real conversation surface with a real input, and an honest boundary
 * at the end of it. Typing works. Freya does not answer, and the interface says
 * so rather than pretending.
 */
export function ChatSurface() {
  const listening = useShell((s) => s.listening)
  const [draft, setDraft] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])

  const send = () => {
    const text = draft.trim()
    if (!text) return
    turnId += 1
    const turn: Turn = { id: turnId, role: 'you', text }
    setTurns((current) => [...current, turn])
    setDraft('')
    // The same path as the command bar: Core records it, and the acknowledgement
    // says what Core said. The local turn below is presentation only.
    void submitCommand(text, 'chat-surface')
  }

  return (
    <div className="chat">
      <div className="chat-log" role="log" aria-label="Conversation">
        {turns.length === 0 ? (
          <div className="chat-empty">
            <p>
              This surface exists to prove the windowing model. Move it, resize it, minimise it,
              maximise it, close it — then reopen Freya and it comes back where you left it.
            </p>
          </div>
        ) : (
          turns.map((turn) => (
            <p key={turn.id} className="chat-turn" data-role={turn.role}>
              <b>{turn.role === 'you' ? 'You' : 'Freya'}</b>
              <span>{turn.text}</span>
            </p>
          ))
        )}
        {turns.length > 0 ? (
          <p className="chat-turn" data-role="freya">
            <b>Freya</b>
            <span className="chat-boundary">
              Held. No model is connected in Phase 0, and the governor is not implemented, so this
              message was never going to be generated. Inference spent: zero.
            </span>
          </p>
        ) : null}
      </div>

      <form
        className="chat-compose"
        onSubmit={(event) => {
          event.preventDefault()
          send()
        }}
      >
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={listening ? 'Listening… (demo)' : 'Type a message to Freya'}
          aria-label="Message Freya"
          spellCheck={false}
        />
        <button type="submit" className="chat-send" disabled={!draft.trim()} aria-label="Send">
          <span aria-hidden="true">→</span>
        </button>
      </form>
    </div>
  )
}
