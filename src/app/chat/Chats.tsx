import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  conversationList,
  conversationMirror,
  ensureConversationAttached,
  visibleMessages,
} from '../../platform/conversationClient'
import { Glyph } from '../../ui-v2/primitives/Glyph'
import type { WorkspaceResearchView } from './modes'
import { RichMessage } from './RichMessage'
import { MediaGrid } from './MediaCards'
import { BrowserWorkspace } from './BrowserWorkspace'
import { ActivityFeed } from './ActivityFeed'
import './chat.css'

function timeLabel(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

function ResearchWorkspace({ view, onOpenLink }: { view: WorkspaceResearchView; onOpenLink: (url: string) => void }) {
  const outcome = view.outcome

  if (outcome.operation === 'refused') {
    return <section className="chats-research-card chats-research-refused"><b>Research unavailable</b><p>{outcome.reason ?? 'Core refused this research request.'}</p></section>
  }

  if (view.mode === 'deep-research') {
    const result = outcome.result
    if (!result) return <section className="chats-research-card"><b>Deep Research</b><p>No research result was returned.</p></section>
    return (
      <section className="chats-research-card" data-mode="deep">
        <header className="chats-research-head">
          <span><Glyph name="mind" size={17} /><b>Deep Research</b></span>
          <small data-state={result.state}>{result.state}</small>
        </header>
        {result.findings.length > 0 ? (
          <div className="chats-findings">
            {result.findings.map((finding, index) => <p key={index}><span>{index + 1}</span>{finding.text}</p>)}
          </div>
        ) : <p className="chats-research-muted">No supported findings were produced.</p>}
        {result.conflicts.length > 0 ? (
          <details className="chats-research-drawer">
            <summary>Conflicts <b>{result.conflicts.length}</b></summary>
            <div>{result.conflicts.map((conflict, index) => <p key={index}>{conflict.text}</p>)}</div>
          </details>
        ) : null}
        {result.uncertainties.length > 0 ? (
          <details className="chats-research-drawer">
            <summary>Uncertainties <b>{result.uncertainties.length}</b></summary>
            <div>{result.uncertainties.map((item, index) => <p key={index}>{item}</p>)}</div>
          </details>
        ) : null}
        <details className="chats-research-drawer">
          <summary>Sources <b>{result.sources.length}</b></summary>
          <div className="chats-source-list">
            {result.sources.map((source) => (
              <button key={source.sourceId} type="button" onClick={() => onOpenLink(source.url)}>
                <span><b>{source.title}</b><small>{source.domain}</small></span><Glyph name="arrow" size={13} />
              </button>
            ))}
          </div>
        </details>
      </section>
    )
  }

  const session = outcome.session
  if (!session) return <section className="chats-research-card"><b>Freya's Eye</b><p>No Eye session was returned.</p></section>
  const collections = ['Videos Found', 'Images Found', 'Audio Found', 'Files Found', 'Sources'] as const

  return (
    <section className="chats-research-card" data-mode="eye">
      <header className="chats-research-head">
        <span><Glyph name="focus" size={17} /><b>Freya's Eye</b></span>
        <small data-state={session.state}>{session.state}</small>
      </header>
      <div className="chats-eye-intent">
        <strong>{session.intent.subject}</strong>
        <span>{session.resultCount} / {session.intent.targetCount}</span>
        <small>{session.intent.mediaType}</small>
        {session.intent.site ? <small>{session.intent.site}</small> : null}
        {session.intent.constraints.map((constraint) => <small key={constraint}>{constraint}</small>)}
        {session.intent.exclusions.map((exclusion) => <small key={exclusion}>not {exclusion}</small>)}
      </div>
      <p className="chats-eye-persistence" data-durable={session.persistence.durable || undefined}>
        {session.persistence.durable ? 'Encrypted in Vault' : (session.persistence.reason ?? 'Ephemeral session')}
      </p>
      <div className="chats-eye-collections">
        {collections.map((collection) => {
          const rows = session.results.filter((result) => result.collection === collection)
          if (rows.length === 0) return null
          return (
            <details key={collection} className="chats-research-drawer">
              <summary>{collection} <b>{rows.length}</b></summary>
              <div className="chats-eye-results">
                {rows.map((result) => (
                  <button
                    key={result.resultId}
                    type="button"
                    className="chats-eye-result-card"
                    data-media={result.mediaType}
                    onClick={() => onOpenLink(result.url)}
                  >
                    <span className="chats-eye-rank">{result.mediaType === 'video' ? '▶' : result.rank}</span>
                    <span>
                      <b>{result.title}</b>
                      <small>{result.sourceDomain} · {result.confidence}</small>
                      <em>{result.snippet}</em>
                    </span>
                    <span className="chats-eye-open"><Glyph name="world" size={12} /> Open</span>
                  </button>
                ))}
              </div>
            </details>
          )
        })}
      </div>
    </section>
  )
}

/**
 * Chats is a first-class Freya workspace.
 *
 * The shell owns the one global composer; this view owns conversation selection
 * and the transcript only. Nothing is inserted optimistically: conversations,
 * messages, running state and persistence all come from Core's projection.
 */
export function Chats({
  researchView,
  busy = false,
  browserOpen,
  browserRequestedUrl,
  onBrowserOpenUrl,
  onBrowserRequestedUrlHandled,
  onBrowserClose,
}: {
  researchView: WorkspaceResearchView | null
  busy?: boolean
  browserOpen: boolean
  browserRequestedUrl: string | null
  onBrowserOpenUrl: (url: string) => void
  onBrowserRequestedUrlHandled: () => void
  onBrowserClose: () => void
}) {
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
  const workspaceBusy = generating || busy
  const activeConversation = conversations.find((conversation) => conversation.conversationId === projection?.activeConversationId) ?? null
  const workspaceLabel = researchView?.mode === 'eye' ? 'FREYA · EYE' : researchView?.mode === 'deep-research' ? 'FREYA · DEEP RESEARCH' : 'FREYA · CHAT'
  const workspaceTitle = researchView?.mode === 'eye'
    ? (researchView.outcome.session?.intent.subject ?? "Freya's Eye")
    : researchView?.mode === 'deep-research'
      ? 'Deep Research'
      : (activeConversation?.title ?? 'New conversation')
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
    <div className="chats" data-browser-open={browserOpen || undefined}>
      {/*
        Conversation history lives in the left rail. This workspace owns the
        transcript and, when opened, Freya's bounded browser controller.
      */}
      <section className="chats-thread" aria-label="Conversation">
        <header className="chats-workspace-head">
          <div className="chats-workspace-identity">
            <span className="chats-freya-sigil" aria-hidden="true"><i /><i /><b /></span>
            <span><small>{workspaceLabel}</small><b>{workspaceTitle}</b></span>
          </div>
          <span className="chats-workspace-state" data-busy={workspaceBusy || undefined}>
            <i aria-hidden="true" />{workspaceBusy ? 'Working' : 'Ready'}
          </span>
        </header>

        <div className="chats-log" role="log" ref={logRef}>
          {messages.length === 0 && researchView === null ? (
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
                <div className="chats-bubble">
                  {message.role === 'assistant'
                    ? <RichMessage
                        content={message.content}
                        onOpenLink={onBrowserOpenUrl}
                        enableCodeCopy
                        enableToc
                        collapseAbove={2400}
                        provenance={
                          message.media !== undefined && message.media.length > 0
                            ? { retrieved: message.media.length }
                            : undefined
                        }
                      />
                    : <p className="chats-user-text">{message.content}</p>}
                  {/* What the lookups behind this answer returned. Drawn from the
                      message Core stored, never recovered from the prose: a card needs
                      an address, and an address read out of a sentence is a guess. */}
                  {message.role === 'assistant' && message.media !== undefined && message.media.length > 0 ? (
                    <MediaGrid items={message.media} onOpenBrowserUrl={onBrowserOpenUrl} />
                  ) : null}
                </div>
              </div>
            </article>
          ))}
          {researchView ? <ResearchWorkspace view={researchView} onOpenLink={onBrowserOpenUrl} /> : null}
          {generating ? (
            <article className="chats-turn" data-role="assistant" aria-live="polite">
              <span className="chats-turn-avatar chats-turn-avatar-live" aria-hidden="true"><Glyph name="core" size={15} /></span>
              <div className="chats-turn-content">
                <header><b>Freya</b><span className="chats-live-label">{projection?.activeTurn?.providerExecuting ? 'thinking' : 'preparing'}</span></header>
                <div className="chats-bubble chats-thinking"><i /><i /><i /></div>
                <ActivityFeed active={generating} />
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
      {browserOpen ? (
        <BrowserWorkspace
          requestedUrl={browserRequestedUrl}
          onRequestedUrlHandled={onBrowserRequestedUrlHandled}
          onClose={onBrowserClose}
        />
      ) : null}
    </div>
  )
}
