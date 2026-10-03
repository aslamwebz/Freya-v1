import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  conversationList,
  conversationMirror,
  ensureConversationAttached,
  visibleMessages,
} from '../../platform/conversationClient'
import { sendMessage } from '../../ui-v2/chat/sendMessage'

/**
 * Chat — real sessions, real turns.
 *
 * The mirror is the renderer's only window onto the conversation, and it talks to
 * the live host bridge regardless of which adapter the shell is drawing cards
 * from. So sessions, the transcript and the composer all reach real Core, while
 * the rest of the shell may still be showing the design sample data.
 *
 * Nothing is inserted locally: a message appears when Core stores it, the running
 * turn is Core's `activeTurn`, and "no provider" is Core's own sentence.
 */
export function ChatPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const mirror = conversationMirror()
  const projection = useSyncExternalStore(mirror.subscribe, () => mirror.projection, () => null)
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    void ensureConversationAttached().then((attached) => {
      void attached.list().then((outcome) => {
        if (outcome.operation === 'refused') setNotice(outcome.reason)
      })
    })
  }, [open])

  if (!open) return null

  const conversations = conversationList(projection)
  const messages = visibleMessages(projection)
  const generating = projection?.activeTurn != null

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (text.length === 0 || generating) return
    setBusy(true)
    setNotice('')
    const result = await sendMessage(mirror, projection?.activeConversationId ?? null, text)
    if (result.ok) setDraft('')
    else setNotice(result.notice)
    setBusy(false)
  }

  return (
    <div className="chat-scrim" onClick={onClose}>
      <div className="chat-panel" role="dialog" aria-label="Chat" onClick={(event) => event.stopPropagation()}>
        <header className="chat-head">
          <b>Chat with Freya</b>
          <div className="chat-actions">
            <button type="button" className="chat-btn" onClick={() => { setNotice(''); void mirror.create() }}>New session</button>
            <button type="button" className="chat-btn" aria-label="Close chat" onClick={onClose}>Close</button>
          </div>
        </header>
        <div className="chat-body">
          <aside className="chat-sessions" aria-label="Sessions">
            {conversations.length === 0
              ? <p className="chat-empty">No sessions yet.</p>
              : conversations.map((conversation) => (
                <button key={conversation.conversationId} type="button" className="chat-session"
                  aria-current={conversation.conversationId === projection?.activeConversationId ? 'true' : undefined}
                  onClick={() => { setNotice(''); void mirror.read(conversation.conversationId) }}>
                  <span>{conversation.title}</span>
                  <small>{conversation.messageCount} message{conversation.messageCount === 1 ? '' : 's'}</small>
                </button>
              ))}
          </aside>
          <section className="chat-thread" aria-label="Conversation">
            <div className="chat-log" role="log">
              {messages.length === 0
                ? <p className="chat-empty">Say something to Freya.</p>
                : messages.map((message) => (
                  <p key={message.messageId} className="chat-msg" data-role={message.role}>
                    <b>{message.role === 'user' ? 'You' : 'Freya'}</b><span>{message.content}</span>
                  </p>
                ))}
              {generating ? (
                <p className="chat-msg" data-role="assistant">
                  <b>Freya</b><span>{projection?.activeTurn?.providerExecuting ? 'Thinking.' : 'Getting ready to think.'}</span>
                </p>
              ) : null}
            </div>
            {projection && !projection.cognition.available ? (
              <p className="chat-boundary" role="status">{projection.cognition.reason ?? 'No cognition provider is available.'}</p>
            ) : null}
            {notice ? <p className="chat-boundary" role="status">{notice}</p> : null}
            <form className="chat-compose" onSubmit={(event) => { event.preventDefault(); void send() }}>
              <input aria-label="Message Freya" value={draft} onChange={(event) => setDraft(event.target.value)}
                placeholder={generating ? 'Freya is answering…' : 'Message Freya…'} disabled={generating || busy} spellCheck={false} />
              <button type="submit" className="chat-btn chat-send" disabled={!draft.trim() || generating || busy}>Send</button>
            </form>
          </section>
        </div>
      </div>
    </div>
  )
}
