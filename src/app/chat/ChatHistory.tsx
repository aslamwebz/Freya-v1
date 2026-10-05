import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  conversationList,
  conversationMirror,
  ensureConversationAttached,
} from '../../platform/conversationClient'
import { Glyph } from '../../ui-v2/primitives/Glyph'
import './chat.css'

/**
 * The conversation list, and nothing else.
 *
 * It lives in the rail, directly under the Chats group head, so "what can I go
 * back to" is in the same column as "where can I go". What it renders is Core's
 * projection and nothing of its own. There is no local conversation array, no
 * optimistic row, and no cached title: every row here was built by Core and
 * arrived on the conversation channel, which is what makes "3 saved" mean
 * three conversations exist rather than three rows were drawn.
 */
export function ChatHistory({ onOpen }: { onOpen?: () => void }) {
  const mirror = conversationMirror()
  const projection = useSyncExternalStore(mirror.subscribe, () => mirror.projection, () => null)
  // The list folds like the reference's rail groups: the chevron on the group
  // head is the one control, and the conversations are the thing it hides.
  const [open, setOpen] = useState(true)

  useEffect(() => {
    // The list is a pull, so it asks for one. `ensureConversationAttached` is
    // idempotent, so this is the same subscription the transcript already made
    // rather than a second one.
    void ensureConversationAttached().then((attached) => {
      void attached.list()
    })
  }, [])

  const conversations = conversationList(projection)
  const active = projection?.activeConversationId ?? null
  const busy = projection?.activeTurn != null

  const read = (conversationId: string): void => {
    void mirror.read(conversationId)
    onOpen?.()
  }

  return (
    <div className="chats-history" data-collapsed={!open || undefined}>
      <header className="chats-history-head">
        <button type="button" className="chats-history-title" aria-label="Open the Chats workspace" onClick={() => onOpen?.()}>
          <Glyph name="chat" size={16} />
          <span>Chats</span>
        </button>
        <span className="chats-history-tools">
          <button
            type="button"
            className="chats-new"
            disabled={busy}
            aria-label="Start a new conversation"
            title={busy ? 'Freya is answering — stop the response before starting a new conversation' : 'Start a new conversation'}
            onClick={() => {
              void mirror.create()
              onOpen?.()
            }}
          >
            <Glyph name="plus" size={12} />
            <span>New</span>
          </button>
          <button
            type="button"
            className="chats-history-fold"
            aria-expanded={open}
            aria-label={open ? 'Hide the conversation list' : 'Show the conversation list'}
            onClick={() => setOpen((value) => !value)}
          >
            <Glyph name="chevron" size={13} style={open ? undefined : { transform: 'rotate(-90deg)' }} />
          </button>
        </span>
      </header>

      {open ? (conversations.length === 0 ? (
        <p className="chats-history-empty">
          {projection === null
            ? 'Connecting to Freya Core…'
            : 'No conversations yet. The first one you start will be listed here.'}
        </p>
      ) : (
        <ul className="chats-history-list">
          {conversations.map((conversation) => (
            <li key={conversation.conversationId}>
              <button
                type="button"
                className="chats-history-item"
                aria-current={conversation.conversationId === active ? 'true' : undefined}
                title={`${conversation.title} · ${conversation.messageCount} message${conversation.messageCount === 1 ? '' : 's'}`}
                onClick={() => read(conversation.conversationId)}
              >
                <span className="chats-history-copy"><b>{conversation.title}</b></span>
                {busy && conversation.conversationId === active ? (
                  <span className="chats-history-dot" aria-label="Freya is answering in this conversation" />
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )) : null}
    </div>
  )
}