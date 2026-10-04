import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  conversationList,
  conversationMirror,
  ensureConversationAttached,
  visibleMessages,
} from '../../platform/conversationClient'
import { Glyph } from '../../ui-v2/primitives/Glyph'
import './chat.css'

/**
 * Chats — the conversation as a real tab, not a modal.
 *
 * The left rail lists sessions (each a real Core conversation, switchable, with
 * "New chat" to start another). The right side is the live transcript. Writing
 * happens in the one global composer (the dock), so the tab carries no second
 * input of its own. The mirror is the renderer's only window onto the
 * conversation and talks to the live host bridge regardless of which adapter
 * the shell draws its cards from. Nothing is inserted locally: a message appears
 * when Core stores it.
 */
export function Chats() {
  const mirror = conversationMirror()
  const projection = useSyncExternalStore(mirror.subscribe, () => mirror.projection, () => null)
  const [notice, setNotice] = useState('')
  const logRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void ensureConversationAttached().then((attached) => {
      void attached.list().then((outcome) => {
        if (outcome.operation === 'refused') setNotice(outcome.reason)
      })
    })
  }, [])

  const conversations = conversationList(projection)
  const messages = visibleMessages(projection)
  const generating = projection?.activeTurn != null
  const boundaries = [...new Set([
    projection?.persistence && projection.persistence.mode !== 'encrypted'
      ? (projection.persistence.reason ?? 'Chats are not being saved securely.')
      : '',
    projection && !projection.cognition.available
      ? (projection.cognition.reason ?? 'No cognition provider is available.')
      : '',
    notice,
  ].filter(Boolean))]

  useEffect(() => {
    const log = logRef.current
    if (log) log.scrollTop = log.scrollHeight
  }, [messages.length, generating])

  return (
    <div className="chats">
      <aside className="chats-list" aria-label="Chats">
        <header className="chats-head">
          <b>Chats</b>
          <button type="button" className="chats-new" disabled={generating} onClick={() => { setNotice(''); void mirror.create() }}>
            <Glyph name="plus" size={15} /><span>New chat</span>
          </button>
        </header>
        <div className="chats-sessions">
          {conversations.length === 0
            ? <p className="chats-empty">No chats yet.</p>
            : conversations.map((conversation) => (
              <button key={conversation.conversationId} type="button" className="chats-session"
                aria-current={conversation.conversationId === projection?.activeConversationId ? 'true' : undefined}
                onClick={() => { setNotice(''); void mirror.read(conversation.conversationId) }}>
                <Glyph name="chat" size={16} />
                <span className="chats-session-title">{conversation.title}</span>
                <small>{conversation.messageCount}</small>
              </button>
            ))}
        </div>
      </aside>
      <section className="chats-thread" aria-label="Conversation">
        <div className="chats-log" role="log" ref={logRef}>
          {messages.length === 0
            ? <p className="chats-empty">Say something to Freya.</p>
            : messages.map((message) => (
              <p key={message.messageId} className="chats-msg" data-role={message.role}>
                <b>{message.role === 'user' ? 'You' : 'Freya'}</b><span>{message.content}</span>
              </p>
            ))}
          {generating ? (
            <p className="chats-msg" data-role="assistant">
              <b>Freya</b><span>{projection?.activeTurn?.providerExecuting ? 'Thinking.' : 'Getting ready to think.'}</span>
            </p>
          ) : null}
        </div>
        {boundaries.map(message => <p key={message} className="chats-boundary" role="status">{message}</p>)}
      </section>
    </div>
  )
}
