import type { ConversationProjection } from '../../../core/protocol/conversation'

/**
 * The conversation, as plain text.
 *
 * A pure view over Core's projection: it renders exactly the messages Core
 * reported, the turn Core says is running, and the sentences Core gave for the
 * states that are easy to fake (no provider, stopped, a failed turn). There is no
 * local transcript and no optimistic message, so what is on screen is what Core
 * holds.
 *
 * Model output is untrusted content and is rendered as characters, never as
 * markup — there is no path from an answer to an element, a link or a script.
 */
export function ChatView({
  projection,
  notice,
  onStop,
}: {
  projection: ConversationProjection | null
  notice: string
  onStop: () => void
}) {
  if (projection === null) {
    return (
      <div className="f-chat">
        <p className="f-chat-empty">Waiting for Freya Core to report the conversation.</p>
      </div>
    )
  }

  const generating = projection.activeTurn !== null
  const stopped = projection.stopAll.active
  const canThink = projection.cognition.available
  const saveWarning = projection.persistence.mode !== 'encrypted' ? projection.persistence.reason : null

  return (
    <div className="f-chat">
      {saveWarning !== null ? (
        <p className="f-chat-boundary" role="status">
          {saveWarning}
        </p>
      ) : null}

      <div className="f-chat-log" role="log" aria-label="Conversation">
        {projection.messages.length === 0 ? (
          <p className="f-chat-empty">
            Ask Freya something. She will assemble what she knows, think once, and say what she
            actually has.
          </p>
        ) : (
          projection.messages.map((message) => (
            <p key={message.messageId} className="f-chat-turn" data-role={message.role}>
              <b>{message.role === 'user' ? 'You' : 'Freya'}</b>
              <span>{message.content}</span>
            </p>
          ))
        )}

        {generating ? (
          <p className="f-chat-turn" data-role="assistant" data-state="generating">
            <b>Freya</b>
            <span>{projection.activeTurn?.providerExecuting ? 'Thinking.' : 'Getting ready to think.'}</span>
          </p>
        ) : null}
      </div>

      {generating ? (
        <button type="button" className="f-chat-stop" onClick={onStop}>
          Stop response
        </button>
      ) : null}

      {stopped ? (
        <p className="f-chat-boundary" role="status">
          Freya is stopped. Every model request is refused until you resume from Security.
        </p>
      ) : null}

      {!stopped && !generating && !canThink ? (
        <p className="f-chat-boundary" role="status">
          {projection.cognition.reason ?? 'No cognition provider is currently available.'}
        </p>
      ) : null}

      {notice ? (
        <p className="f-chat-boundary" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  )
}
