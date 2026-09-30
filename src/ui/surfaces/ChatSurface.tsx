import { useCallback, useEffect, useMemo, useState } from 'react'
import { useShell } from '../store'
import {
  conversationList,
  conversationMirror,
  ensureConversationAttached,
  visibleMessages,
} from '../../platform/conversationClient'
import type { ConversationProjection, VoiceProjection } from '../../../core/protocol/conversation'
import { MicButton } from './MicButton'

/**
 * Chat — a real conversation with a real Freya behind it.
 *
 * Every fact on this screen came from Core. There is no local transcript, no
 * optimistic message, and no "typing…" indicator: the composer is disabled while
 * a turn is running, the transcript appears when Core says it is stored, and
 * "no provider" is a sentence rather than a spinner that never resolves.
 *
 * ## The three states that are easy to fake
 *
 * - **A response is generating.** Driven by `activeTurn` in the projection, which
 *   Core populates from its own bookkeeping. Not from a local flag set on click.
 * - **There is no provider.** Reported by Core, with the reason, before anyone
 *   presses Send. Freya does not echo the question back and call it an answer.
 * - **The last turn failed.** Shown as the turn's own outcome, in the transcript,
 *   next to the question that caused it — not as a toast that has gone by.
 *
 * ## What this surface cannot do
 *
 * It cannot send a privileged command, choose a model, name a grant, or reach a
 * provider. The only door is `conversation.turn.submit`, and the Mind behind it
 * compiles the context, creates the turn's grant and asks the Governor.
 */

export function ChatSurface() {
  const listening = useShell((s) => s.listening)
  const [projection, setProjection] = useState<ConversationProjection | null>(null)
  const [voice, setVoice] = useState<VoiceProjection | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<HTMLDivElement | null>(null)
  const mirror = conversationMirror()

  useEffect(() => {
    let dispose: (() => void) | undefined
    let cancelled = false
    void ensureConversationAttached().then((attached) => {
      if (cancelled) {
        attached.attachVoice?.()
        return
      }
      dispose = attached.subscribe(setProjection)
    })
    void mirror.attachVoice().then(() => mirror.subscribeVoice(setVoice))
    // Load the existing history so a surface opened on day seven is not empty.
    void mirror.list()
    return () => {
      cancelled = true
      dispose?.()
    }
  }, [mirror])

  // Keep the newest line in view without stealing focus from the composer.
  useEffect(() => {
    const log = transcript
    if (log) log.scrollTop = log.scrollHeight
  }, [projection?.messages.length])

  const messages = useMemo(() => visibleMessages(projection), [projection])
  const conversations = useMemo(() => conversationList(projection), [projection])
  const activeTurn = projection?.activeTurn ?? null
  const generating = activeTurn !== null
  const stopped = projection?.stopAll.active === true
  const canThink = projection?.cognition.available === true
  const persistence = projection?.persistence

  const ensureConversation = useCallback(async (): Promise<string | null> => {
    const existing = projection?.activeConversationId
    if (existing) return existing
    const created = await mirror.create()
    return created.operation === 'created' ? created.conversation.conversationId : null
  }, [mirror, projection?.activeConversationId])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (text.length === 0 || sending || generating) return

    const limit = projection?.maxMessageCharacters ?? 0
    if (limit > 0 && text.length > limit) {
      // Refused here, visibly, so an accidental paste does not become a request.
      setNotice(`That message is ${text.length} characters. The limit is ${limit}.`)
      return
    }

    setSending(true)
    setNotice(null)
    try {
      const conversationId = await ensureConversation()
      if (conversationId === null) {
        setNotice('No conversation is available, so the message was not sent.')
        return
      }
      // The draft clears only once Core has the message. A window that clears
      // first would lose a sentence on a failed send.
      const outcome = await mirror.submitTurn(conversationId, text)
      setDraft('')
      if (outcome.operation === 'turn' && outcome.turn.outcome !== 'completed') {
        setNotice(outcome.turn.reason ?? 'That turn did not complete.')
      }
    } catch (error) {
      setNotice(
        `Freya Core could not be reached — ${error instanceof Error ? error.message : 'unknown error'}`,
      )
    } finally {
      setSending(false)
    }
  }, [draft, ensureConversation, generating, mirror, projection?.maxMessageCharacters, sending])

  const stopResponse = useCallback(async () => {
    if (!activeTurn) return
    await mirror.cancelTurn(activeTurn.turnId)
    // No notice and no local state change: the turn's outcome arrives as a
    // projection push, because Core is what knows how it ended.
  }, [activeTurn, mirror])

  const composerDisabled = sending || generating || stopped

  return (
    <div className="chat">
      <div className="chat-side">
        <button
          type="button"
          className="chat-new"
          onClick={() => {
            void mirror.create()
            setNotice(null)
          }}
          disabled={generating}
        >
          New conversation
        </button>
        <ul className="chat-list" aria-label="Conversations">
          {conversations.map((conversation) => (
            <li key={conversation.conversationId}>
              <button
                type="button"
                className="chat-list-item"
                data-active={conversation.conversationId === projection?.activeConversationId || undefined}
                onClick={() => void mirror.read(conversation.conversationId)}
              >
                <span className="chat-list-title">{conversation.title}</span>
                <span className="chat-list-meta">
                  {conversation.messageCount} message{conversation.messageCount === 1 ? '' : 's'}
                  {conversation.lastTurnOutcome ? ` · ${conversation.lastTurnOutcome}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>

        {/* Durability, stated rather than assumed. Someone should know their
            conversation is not being saved before they say something they would
            rather not lose. */}
        {persistence && persistence.mode !== 'encrypted' ? (
          <p className="chat-persistence" data-mode={persistence.mode}>
            {persistence.reason ?? 'Conversations are not being saved.'}
          </p>
        ) : null}
      </div>

      <div className="chat-main">
        <div className="chat-log" role="log" aria-label="Conversation" ref={setTranscript}>
          {messages.length === 0 ? (
            <div className="chat-empty">
              <p>
                Ask Freya something. She will assemble what she knows, think once, and say what she
                actually has.
              </p>
            </div>
          ) : (
            messages.map((message) => (
              <p key={message.messageId} className="chat-turn" data-role={message.role}>
                <b>{message.role === 'user' ? 'You' : 'Freya'}</b>
                {/* Plain text. Model output is untrusted content and is rendered
                    as characters, never as markup — there is no path here from
                    an answer to an element, a link or a script. */}
                <span>{message.content}</span>
              </p>
            ))
          )}

          {generating ? (
            <p className="chat-turn" data-role="freya" data-state="generating">
              <b>Freya</b>
              <span>
                {activeTurn?.providerExecuting
                  ? 'Thinking.'
                  : 'Getting ready to think.'}
              </span>
            </p>
          ) : null}

          {stopped ? (
            <p className="chat-boundary" role="status">
              Freya is stopped. Every model request is refused until you resume from Security.
            </p>
          ) : null}

          {!stopped && !generating && !canThink ? (
            <p className="chat-boundary" role="status">
              {projection?.cognition.reason ?? 'No cognition provider is currently available.'}
            </p>
          ) : null}

          {notice ? (
            <p className="chat-boundary" role="status">
              {notice}
            </p>
          ) : null}
        </div>

        <form
          className="chat-compose"
          onSubmit={(event) => {
            event.preventDefault()
            void send()
          }}
        >
          <MicButton
            voice={voice}
            onTranscript={(text) => setDraft((current) => (current.length > 0 ? `${current} ${text}` : text))}
          />
          <textarea
            className="chat-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter is a newline — the convention everywhere
              // else, and the one that lets someone write a paragraph.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }}
            rows={2}
            placeholder={
              stopped
                ? 'Freya is stopped'
                : generating
                  ? 'Freya is answering…'
                  : listening
                    ? 'Listening…'
                    : 'Message Freya'
            }
            aria-label="Message Freya"
            disabled={composerDisabled}
            spellCheck={false}
          />
          {generating ? (
            <button
              type="button"
              className="chat-stop"
              onClick={() => void stopResponse()}
              aria-label="Stop this response"
              title="Stop this response. Freya stays able to think."
            >
              Stop response
            </button>
          ) : (
            <button
              type="submit"
              className="chat-send"
              disabled={draft.trim().length === 0 || composerDisabled}
              aria-label="Send"
            >
              <span aria-hidden="true">→</span>
            </button>
          )}
        </form>
      </div>
    </div>
  )
}
