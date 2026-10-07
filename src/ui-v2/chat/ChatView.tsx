import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConversationProjection, ConversationSummaryView } from '../../../core/protocol/conversation'
import { conversationList, visibleMessages } from '../../platform/conversationClient'
import { RichMessage } from '../../app/chat/RichMessage'
import { MediaGrid } from '../../app/chat/MediaCards'
import { ActivityFeed } from '../../app/chat/ActivityFeed'
import '../../app/chat/chat.css'
import '../../app/chat/media.css'
import './chat-v2.css'

/**
 * Chat — Freya's v2 Chat workspace, as a faithful view over Core.
 *
 * What is and isn't here is decided by what Core is willing to say. Every
 * message and every running turn is rendered from the conversation projection;
 * there is no local transcript and no optimistic placeholder. Markdown is rendered
 * through the deliberately-small reader in `app/chat/RichMessage.tsx`, which
 * refuses HTML interpretation and closes its vocabulary at code, strong,
 * emphasis and explicit http(s) links. Media found by Core is drawn as cards;
 * each card opens a real preview, not a remote fetch by the window.
 *
 * The activity rail beneath a generating answer is a read of Core's own
 * `CoreActivityEvent` stream — never a sentence the renderer invented.
 */
export function ChatView({
  projection,
  notice,
  onStop,
  onOpenLink,
  onOpenConversation,
  onCreateConversation,
}: {
  projection: ConversationProjection | null
  notice: string
  onStop: () => void
  /** Open a URL through Freya's own browser surface, when one is attached. */
  onOpenLink?: (url: string) => void
  /** Switch the active conversation. */
  onOpenConversation?: (conversationId: string) => void
  /** Start a fresh conversation. */
  onCreateConversation?: () => void
}) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const [lastUserText, setLastUserText] = useState<string | null>(null)

  const messages = visibleMessages(projection)
  const conversations = useMemo<readonly ConversationSummaryView[]>(
    () => conversationList(projection),
    [projection],
  )
  const generating = projection?.activeTurn != null
  const stopped = projection?.stopAll.active === true
  const canThink = projection?.cognition.available === true
  const saveWarning = projection?.persistence.mode !== 'encrypted'
    ? projection?.persistence.reason ?? null
    : null

  useEffect(() => {
    for (const message of messages) {
      if (message.role === 'user') setLastUserText(message.content)
    }
  }, [messages])

  // Keyboard shortcuts scoped to this workspace.
  // - Esc cancels a running turn.
  // - Ctrl/Cmd + L focuses the global composer (looked up by aria-label, since
  //   the v2 composer lives in the shell's footer rather than inside this view).
  // - ↑ on an empty composer recalls the last user message.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const insideRoot = target !== null && root.contains(target)
      if (!insideRoot) return
      if (event.key === 'Escape' && generating) {
        event.preventDefault()
        onStop()
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l') {
        event.preventDefault()
        const composer = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Ask Freya"]')
        composer?.focus()
        return
      }
    }
    root.addEventListener('keydown', onKey)
    return () => root.removeEventListener('keydown', onKey)
  }, [generating, onStop])

  const recallLast = useCallback(() => {
    if (!lastUserText) return
    const composer = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Ask Freya"]')
    if (!composer) return
    composer.focus()
    composer.value = lastUserText
    composer.dispatchEvent(new Event('input', { bubbles: true }))
  }, [lastUserText])

  if (projection === null) {
    return (
      <div className="f-chat" ref={rootRef}>
        <p className="f-chat-empty" role="status">Waiting for Freya Core to report the conversation.</p>
      </div>
    )
  }

  return (
    <div className="f-chat" ref={rootRef}>
      {saveWarning !== null ? (
        <p className="f-chat-boundary" role="status">{saveWarning}</p>
      ) : null}

      <header className="f-chat-head">
        <div className="f-chat-head-left">
          <h2 className="f-chat-title">Conversation</h2>
          <small className="f-chat-sub">
            {generating
              ? 'Freya is answering.'
              : stopped
                ? 'Freya is stopped.'
                : canThink
                  ? 'Ready for the next message.'
                  : 'No cognition provider is available.'}
          </small>
        </div>
        <div className="f-chat-head-right">
          <button
            type="button"
            className="f-chat-history-toggle"
            aria-pressed={showHistory}
            aria-expanded={showHistory}
            aria-controls="f-chat-history"
            onClick={() => setShowHistory((value) => !value)}
            disabled={conversations.length === 0 && !onCreateConversation}
          >
            History · {conversations.length}
          </button>
          {onCreateConversation ? (
            <button
              type="button"
              className="f-chat-new"
              onClick={() => onCreateConversation()}
              disabled={generating}
            >
              New
            </button>
          ) : null}
        </div>
      </header>

      {showHistory && conversations.length > 0 ? (
        <section className="f-chat-history" id="f-chat-history" aria-label="Conversations">
          {conversations.map((conversation) => (
            <button
              key={conversation.conversationId}
              type="button"
              className="f-chat-history-row"
              data-active={conversation.conversationId === projection.activeConversationId || undefined}
              onClick={() => onOpenConversation?.(conversation.conversationId)}
              disabled={!onOpenConversation}
            >
              <span className="f-chat-history-title">{conversation.title}</span>
              <small>
                {conversation.messageCount} message{conversation.messageCount === 1 ? '' : 's'}
                {conversation.lastTurnOutcome ? ` · ${conversation.lastTurnOutcome}` : ''}
              </small>
            </button>
          ))}
        </section>
      ) : null}

      <div className="f-chat-log" role="log" aria-label="Conversation">
        {messages.length === 0 ? (
          <div className="f-chat-empty-state" role="status">
            <span className="f-chat-empty-orb" aria-hidden="true">
              <i /><i /><span />
            </span>
            <small>FREYA</small>
            <h3>Ready when you are.</h3>
            <p>Ask anything. Freya will assemble what she knows, think once, and say what she actually has.</p>
            <ul className="f-chat-empty-prompts">
              <li><kbd>Explain</kbd> what the activity feed shows during a turn.</li>
              <li><kbd>Find on the web</kbd> for recent news about cognitive architecture.</li>
              <li><kbd>Use your browser</kbd> to summarise a page.</li>
              <li><kbd>Open</kbd> a long answer: contents table, code copy, and sources all live there.</li>
            </ul>
          </div>
        ) : (
          messages.map((message) => (
            <article
              key={message.messageId}
              className="f-chat-turn"
              data-role={message.role}
            >
              <header>
                <b>{message.role === 'user' ? 'You' : 'Freya'}</b>
                <time>{new Date(message.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</time>
              </header>
              {message.role === 'assistant' ? (
                <RichMessage
                  content={message.content}
                  onOpenLink={onOpenLink}
                  enableCodeCopy
                  enableToc
                  collapseAbove={2200}
                  provenance={
                    message.media && message.media.length > 0
                      ? { retrieved: message.media.length }
                      : undefined
                  }
                />
              ) : (
                <p className="f-chat-user-text">{message.content}</p>
              )}
              {message.role === 'assistant' && message.media && message.media.length > 0 ? (
                <MediaGrid items={message.media} onOpenBrowserUrl={onOpenLink} />
              ) : null}
            </article>
          ))
        )}

        {generating ? (
          <article className="f-chat-turn" data-role="assistant" data-state="generating" aria-live="polite">
            <header><b>Freya</b><small>thinking</small></header>
            <p className="f-chat-thinking" aria-label="Freya is thinking">
              <i /><i /><i />
              <span>{projection.activeTurn?.providerExecuting ? 'Thinking.' : 'Getting ready to think.'}</span>
            </p>
            <ActivityFeed active={generating} />
          </article>
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
        <p className="f-chat-boundary" role="status">{notice}</p>
      ) : null}

      {lastUserText ? (
        <button
          type="button"
          className="f-chat-recall"
          aria-label="Recall last message"
          title="Press Up arrow on the composer to recall the last message"
          onClick={recallLast}
        >
          Recall last
        </button>
      ) : null}
    </div>
  )
}