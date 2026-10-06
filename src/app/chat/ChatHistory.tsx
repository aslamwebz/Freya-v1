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
 *
 * Chats is the one place that is *not* a plain row — it carries the conversation
 * list underneath it. That made collapsing the rail a special case: hiding this
 * block for a 64px column would take the Chats workspace with it, so instead the
 * head stays as an icon-only row and behaves like every other place (it navigates)
 * while the disclosure it normally performs is meaningless at that width.
 */
export function ChatHistory({ onOpen, collapsed = false, current = false }: {
  onOpen?: () => void
  collapsed?: boolean
  current?: boolean
}) {
  const mirror = conversationMirror()
  const projection = useSyncExternalStore(mirror.subscribe, () => mirror.projection, () => null)
  // The list folds like the reference's rail groups, except the title itself is
  // the control: click it to show and hide the conversations.
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

  // History is reusable only by explicit row selection. Generic Chats/New
  // entry creates first, then opens the workspace, so a restored conversation can
  // never leak into a new interaction.
  const startNew = async (): Promise<void> => {
    await mirror.create()
    onOpen?.()
  }

  const read = async (conversationId: string): Promise<void> => {
    await mirror.read(conversationId)
    onOpen?.()
  }

  const archive = async (conversationId: string): Promise<void> => {
    const wasActive = conversationId === active
    const outcome = await mirror.archive(conversationId)
    if (outcome.operation !== 'archived' || !wasActive) return

    // Closing the active chat must not silently select another old conversation.
    // History is reused only when the owner clicks that exact history row.
    await mirror.create()
    onOpen?.()
  }

  return (
    <div className="chats-history" data-collapsed={!open || undefined}>
      <header className="chats-history-head">
        {/* Entering Chats from another workspace is a New Chat action. History
            reuse only happens on a conversation row below. Once already in Chat,
            the heading goes back to being the disclosure control for that history. */}
        <button type="button" className="chats-history-title" aria-expanded={collapsed ? undefined : open}
          aria-current={current ? 'page' : undefined}
          aria-label={!current ? 'Start a new chat' : collapsed ? 'Start a new chat' : (open ? 'Hide the conversation list' : 'Show the conversation list')}
          onClick={() => {
            if (!current || collapsed) { void startNew(); return }
            setOpen((value) => !value)
          }}>
          <Glyph name="chat" size={20} style={open && !collapsed ? undefined : { opacity: 0.75 }} />
          <span>Chats</span>
        </button>
        <button
          type="button"
          className="chats-new"
          disabled={busy}
          aria-label="Start a new conversation"
          title={busy ? 'Freya is answering — stop the response before starting a new conversation' : 'Start a new conversation'}
          onClick={() => { void startNew() }}
        >
          <Glyph name="plus" size={12} />
          <span>New</span>
        </button>
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
                onClick={() => { void read(conversation.conversationId) }}
              >
                <span className="chats-history-copy"><b>{conversation.title}</b></span>
                {busy && conversation.conversationId === active ? (
                  <span className="chats-history-dot" aria-label="Freya is answering in this conversation" />
                ) : null}
              </button>
              <button
                type="button"
                className="chats-history-close"
                aria-label={`Close ${conversation.title}`}
                title="Close conversation"
                disabled={busy && conversation.conversationId === active}
                onClick={() => { void archive(conversation.conversationId) }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )) : null}
    </div>
  )
}