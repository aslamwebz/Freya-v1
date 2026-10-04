import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  conversationList,
  conversationMirror,
  ensureConversationAttached,
  visibleMessages,
} from '../../platform/conversationClient'
import { Glyph } from '../../ui-v2/primitives/Glyph'
import './chat.css'

function timeLabel(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

/**
 * Chats is a first-class Freya workspace.
 *
 * The shell owns the one global composer; this view owns conversation selection
 * and the transcript only. Nothing is inserted optimistically: conversations,
 * messages, running state and persistence all come from Core's projection.
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
  const activeConversation = conversations.find((conversation) => conversation.conversationId === projection?.activeConversationId) ?? null
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
          <div className="chats-head-title"><Glyph name="chat" size={18} /><span><b>Chats</b><small>{conversations.length} saved</small></span></div>
          <button type="button" className="chats-new" disabled={generating} onClick={() => { setNotice(''); void mirror.create() }}>
            <Glyph name="plus" size={15} /><span>New</span>
          </button>
        </header>
        <div className="chats-sessions">
          {conversations.length === 0
            ? <div className="chats-list-empty"><span className="chats-list-empty-ring" aria-hidden="true" /><b>No conversations yet</b><small>Your conversations will live here.</small></div>
            : conversations.map((conversation) => (
              <button key={conversation.conversationId} type="button" className="chats-session"
                aria-current={conversation.conversationId === projection?.activeConversationId ? 'true' : undefined}
                onClick={() => { setNotice(''); void mirror.read(conversation.conversationId) }}>
                <span className="chats-session-mark"><Glyph name="chat" size={14} /></span>
                <span className="chats-session-copy"><b>{conversation.title}</b><small>{conversation.messageCount} message{conversation.messageCount === 1 ? '' : 's'}</small></span>
                <span className="chats-session-chevron" aria-hidden="true">›</span>
              </button>
            ))}
        </div>
      </aside>

      <section className="chats-thread" aria-label="Conversation">
        <header className="chats-workspace-head">
          <div className="chats-workspace-identity">
            <span className="chats-freya-sigil" aria-hidden="true"><i /><i /><b /></span>
            <span><small>FREYA · CHAT</small><b>{activeConversation?.title ?? 'New conversation'}</b></span>
          </div>
          <span className="chats-workspace-state" data-busy={generating || undefined}>
            <i aria-hidden="true" />{generating ? 'Thinking' : 'Ready'}
          </span>
        </header>

        <div className="chats-log" role="log" ref={logRef}>
          {messages.length === 0 ? (
            <div className="chats-empty-state">
              <div className="chats-empty-orb" aria-hidden="true"><i /><i /><span /></div>
              <small>FREYA</small>
              <h2>Ready when you are.</h2>
              <p>Start below. This conversation stays in the same Freya workspace while you move between tabs.</p>
            </div>
          ) : messages.map((message) => (
            <article key={message.messageId} className="chats-turn" data-role={message.role}>
              <span className="chats-turn-avatar" aria-hidden="true">
                {message.role === 'user' ? 'A' : <Glyph name="core" size={15} />}
              </span>
              <div className="chats-turn-content">
                <header><b>{message.role === 'user' ? 'You' : 'Freya'}</b><time>{timeLabel(message.createdAt)}</time></header>
                <div className="chats-bubble">{message.content}</div>
              </div>
            </article>
          ))}
          {generating ? (
            <article className="chats-turn" data-role="assistant" aria-live="polite">
              <span className="chats-turn-avatar chats-turn-avatar-live" aria-hidden="true"><Glyph name="core" size={15} /></span>
              <div className="chats-turn-content">
                <header><b>Freya</b><span className="chats-live-label">{projection?.activeTurn?.providerExecuting ? 'thinking' : 'preparing'}</span></header>
                <div className="chats-bubble chats-thinking"><i /><i /><i /></div>
              </div>
            </article>
          ) : null}
        </div>

        {boundaries.length > 0 ? (
          <div className="chats-status-stack" aria-live="polite">
            {boundaries.map(message => <p key={message} className="chats-boundary" role="status">{message}</p>)}
          </div>
        ) : null}
      </section>
    </div>
  )
}
