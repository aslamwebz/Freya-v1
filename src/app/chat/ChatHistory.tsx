import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { CONVERSATION_LIMITS } from '../../../core/conversation/types'
import type { ConversationCommandOutcome } from '../../../core/protocol/conversation'
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
 * In the shipping sidebar, primary navigation is separate from this context list.
 * The contextual heading folds saved conversations without changing the workspace.
 */
export function ChatHistory({ onOpen, collapsed = false, current = false, contextual = false }: {
  onOpen?: () => void
  collapsed?: boolean
  current?: boolean
  contextual?: boolean
}) {
  const mirror = conversationMirror()
  const projection = useSyncExternalStore(mirror.subscribe, () => mirror.projection, () => null)
  // The list folds like the reference's rail groups, except the title itself is
  // the control: click it to show and hide the conversations.
  const [open, setOpen] = useState(true)
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [title, setTitle] = useState('')

  useEffect(() => {
    // The list is a pull, so it asks for one. `ensureConversationAttached` is
    // idempotent, so this is the same subscription the transcript already made
    // rather than a second one.
    void ensureConversationAttached().then((attached) => {
      void attached.list().then((outcome) => {
        if (outcome.operation === 'refused') setError(outcome.reason)
      })
    })
  }, [])

  const conversations = conversationList(projection)
  const active = projection?.activeConversationId ?? null
  const busy = projection?.activeTurn != null
  const unavailable = projection === null || projection.persistence.mode === 'unavailable'
  const filtered = conversations.filter((conversation) => conversation.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))

  const perform = async (action: () => Promise<ConversationCommandOutcome>, success: (outcome: ConversationCommandOutcome) => void): Promise<void> => {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    setError('')
    try {
      const outcome = await action()
      if (outcome.operation === 'refused') setError(outcome.reason)
      else success(outcome)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Freya could not complete that action.')
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }

  const startNew = async (): Promise<void> => {
    await perform(() => mirror.create(), (outcome) => { if (outcome.operation === 'created') { setQuery(''); onOpen?.() } })
  }

  const read = async (conversationId: string): Promise<void> => {
    await perform(() => mirror.read(conversationId), (outcome) => {
      if (outcome.operation !== 'read') return
      if (outcome.conversation === null) { setError('That conversation is no longer available.'); return }
      onOpen?.()
    })
  }

  const archive = async (conversationId: string): Promise<void> => {
    const wasActive = conversationId === active
    await perform(async () => {
      const outcome = await mirror.archive(conversationId)
      if (outcome.operation !== 'archived' || !outcome.archived) return outcome
      if (editing === conversationId) setEditing(null)
      return wasActive ? mirror.create() : outcome
    }, (outcome) => { if (wasActive && outcome.operation === 'created') onOpen?.() })
  }

  return (
    <div className="chats-history" data-collapsed={!open || undefined}>
      <header className="chats-history-head">
        {/*
          The heading is a navigation control, not a "new chat" button.
          Clicking it from any other workspace opens the Chat index (the list
          of saved conversations); clicking it from the Chat screen toggles the
          list's disclosure. New conversations are started with the bare `+`
          button beside it — that is the only path that creates one, so a click
          on the title can never quietly eat the conversation the owner was in.
        */}
        <button type="button" className="chats-history-title" aria-expanded={current ? open : undefined}
          aria-current={current && !contextual ? 'page' : undefined}
          aria-label={!current || collapsed ? 'Open Chats' : (open ? 'Hide the conversation list' : 'Show the conversation list')}
          onClick={() => {
            if (!current || collapsed) { setOpen(true); onOpen?.(); return }
            setOpen((value) => !value)
          }}>
          <Glyph name="chat" size={20} style={open && !collapsed ? undefined : { opacity: 0.75 }} />
          <span>{contextual ? 'Conversations' : 'Chats'}</span>
        </button>
        <button
          type="button"
          className="chats-new"
          disabled={busy || pending || unavailable}
          aria-label="Start a new conversation"
          title={busy ? 'Freya is answering — stop the response before starting a new conversation' : 'Start a new conversation'}
          onClick={() => { void startNew() }}
        >
          <Glyph name="plus" size={14} />
        </button>
      </header>

      {error && !collapsed ? <div className="chats-history-error" role="alert"><p>{error}</p><button type="button" disabled={pending} onClick={() => { void perform(async () => { await mirror.attach(); return mirror.list() }, () => {}) }}>Retry connection</button></div> : null}
      {open && !collapsed ? <>
        <input className="chats-history-search" type="search" aria-label="Search conversations" placeholder="Search conversations" value={query} onChange={(event) => setQuery(event.target.value)} />
        {pending ? <p className="chats-history-empty" role="status">Updating conversations…</p> : null}
        {filtered.length === 0 ? (
        <p className="chats-history-empty">
          {projection === null
            ? 'Connecting to Freya Core…'
            : unavailable ? 'Conversations are unavailable.' : query.trim() ? 'No matching conversations.' : 'No conversations yet.'}
        </p>
      ) : (
        <ul className="chats-history-list">
          {filtered.map((conversation) => (
            <li key={conversation.conversationId}>
              {editing === conversation.conversationId ? (
                <form className="chats-history-rename" onSubmit={(event) => {
                  event.preventDefault()
                  void perform(() => mirror.rename(conversation.conversationId, title), (outcome) => { if (outcome.operation === 'renamed') setEditing(null) })
                }}>
                  <input autoFocus aria-label="Conversation title" maxLength={CONVERSATION_LIMITS.maxTitleCharacters} value={title} disabled={pending} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape' && !pending) setEditing(null) }} />
                  <button type="submit" disabled={pending || !title.trim()}>Save title</button>
                  <button type="button" aria-label="Cancel rename" disabled={pending} onClick={() => setEditing(null)}>Cancel</button>
                </form>
              ) : <>
              <button
                type="button"
                className="chats-history-item"
                aria-current={conversation.conversationId === active ? 'true' : undefined}
                title={`${conversation.title} · ${conversation.messageCount} message${conversation.messageCount === 1 ? '' : 's'}`}
                disabled={pending || unavailable}
                onClick={() => { void read(conversation.conversationId) }}
              >
                <span className="chats-history-mark" aria-hidden="true"><Glyph name="chat" size={20} /></span>
                <span className="chats-history-copy"><b>{conversation.title}</b></span>
                {busy && conversation.conversationId === active ? (
                  <span className="chats-history-dot" aria-label="Freya is answering in this conversation" />
                ) : null}
              </button>
              <button type="button" className="chats-history-rename-button" aria-label={`Rename ${conversation.title}`} title="Rename conversation" disabled={pending || unavailable} onClick={() => { setEditing(conversation.conversationId); setTitle(conversation.title) }}>⋯</button>
              <button
                type="button"
                className="chats-history-close"
                aria-label={`Close ${conversation.title}`}
                title="Close conversation"
                disabled={pending || unavailable || (busy && conversation.conversationId === active)}
                onClick={() => { void archive(conversation.conversationId) }}
              >
                ×
              </button>
              </>}
            </li>
          ))}
        </ul>
      )}</> : null}
    </div>
  )
}
