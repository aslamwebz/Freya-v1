import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CoreActivityEvent } from '../../../core/protocol/activity'
import {
  conversationList,
  conversationMirror,
  ensureConversationAttached,
  visibleMessages,
} from '../../platform/conversationClient'
import { coreMirror, ensureActivityAttached } from '../../platform/coreClient'
import { researchMirror } from '../../platform/researchClient'
import { Glyph } from '../../ui-v2/primitives/Glyph'
import type { WorkspaceResearchView } from './modes'
import { AssistantMessageView } from './AssistantMessageView'
import { MediaGrid } from './MediaCards'
import { DockedBrowser, type DockedTabOrigin } from './BrowserWorkspace'
import { EyeSessionControls } from './EyeSessionControls'
import { openResearchCitationInDockedBrowser } from './eyeHandoff'
import { ActivityFeed } from './ActivityFeed'
import './chat.css'

/**
 * How long a recorded failure stays worth reporting.
 *
 * The activity stream is replayed from the journal, so the newest turn-ending
 * event in it may be from a run last week. A timeout is news for as long as it
 * is the turn that just ended, and a stale error pinned above the composer
 * forever is worse than none at all.
 */
const FAULT_WINDOW_MS = 120_000

/**
 * The last thing that ended a turn, if it ended badly.
 *
 * Read from what Core journalled rather than from anything a model said about
 * itself: `conversation.turn.failed` carries the provider's own sentence — a
 * timeout, a refusal, a dropped connection — and a turn that completed clears it,
 * because the honest state after a good answer is "nothing went wrong".
 */
function latestTurnFault(events: readonly CoreActivityEvent[], now: number): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.kind !== 'conversation.turn.failed' && event.kind !== 'conversation.turn.completed') continue
    if (now - event.at > FAULT_WINDOW_MS) return null
    return event.kind === 'conversation.turn.failed' ? event.text : null
  }
  return null
}

function timeLabel(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

function ResearchWorkspace({
  view,
  onOpenCitation,
  onChange,
}: {
  view: WorkspaceResearchView
  onChange: (view: WorkspaceResearchView) => void
  onOpenCitation: (url: string) => void
}) {
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
              <button key={source.sourceId} type="button" onClick={() => onOpenCitation(source.url)}>
                <span><b>{source.title}</b><small>{source.domain}</small></span><Glyph name="arrow" size={13} />
              </button>
            ))}
          </div>
        </details>
      </section>
    )
  }

  const session = outcome.session
  if (!session) return <section className="chats-research-card"><b>Freya's Eye</b><EyeSessionControls view={view} onChange={onChange} /><p>Choose a saved collection, or start a new search with Eye.</p></section>
  const collections = ['Videos Found', 'Images Found', 'Audio Found', 'Files Found', 'Sources'] as const

  return (
    <section className="chats-research-card" data-mode="eye">
      <header className="chats-research-head">
        <span><Glyph name="focus" size={17} /><b>Freya's Eye</b></span>
        <small data-state={session.state}>{session.state}</small>
      </header>
      <EyeSessionControls view={view} onChange={onChange} />
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
                    onClick={() => onOpenCitation(result.url)}
                  >
                    <span className="chats-eye-rank">{result.mediaType === 'video' ? '▶' : result.rank}</span>
                    <span>
                      <b>{result.title}</b>
                      <small>{result.sourceDomain} · {result.confidence}{result.providerId ? ` · ${result.providerId}` : ''}</small>
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
  onResearchViewChange,
  busy = false,
  issue = '',
  browserOpen,
  browserPercent,
  onBrowserPercentChange,
  browserRequestedUrl,
  onBrowserOpenUrl,
  onBrowserRequestedUrlHandled,
  onBrowserClose,
}: {
  researchView: WorkspaceResearchView | null
  onResearchViewChange?: (view: WorkspaceResearchView) => void
  busy?: boolean
  /**
   * A problem the shell already knows about, in Core's own words.
   *
   * It arrives here rather than being printed over the composer, so the one place
   * a person reads what went wrong is the conversation it happened in.
   */
  issue?: string
  browserOpen: boolean
  /** Share of the window the browser column takes, as a percentage. */
  browserPercent: number
  onBrowserPercentChange: (percent: number) => void
  browserRequestedUrl: string | null
  onBrowserOpenUrl: (url: string, origin?: DockedTabOrigin) => void
  onBrowserRequestedUrlHandled: () => void
  onBrowserClose: () => void
}) {
  const mirror = conversationMirror()
  const projection = useSyncExternalStore(mirror.subscribe, () => mirror.projection, () => null)
  const [notice, setNotice] = useState('')
  const [fault, setFault] = useState<string | null>(null)
  const [issueOpen, setIssueOpen] = useState(false)
  const logRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void ensureConversationAttached().then((attached) => {
      void attached.list().then((outcome) => {
        if (outcome.operation === 'refused') setNotice(outcome.reason)
      })
    })
  }, [])

  /**
   * Watch for a turn that ended badly.
   *
   * This is the only place a timeout or a dropped provider request can be told
   * to a person: the projection carries which turn is running, never why the last
   * one stopped, so the sentence comes from the event Core already wrote.
   */
  useEffect(() => {
    const activity = coreMirror()
    let disposed = false
    let disposeSubscription: (() => void) | null = null
    const read = (events: readonly CoreActivityEvent[]) => {
      if (!disposed) setFault(latestTurnFault(events, Date.now()))
    }
    void ensureActivityAttached().then(() => {
      if (disposed) return
      read(activity.activity)
      disposeSubscription = activity.subscribeActivity(read)
    })
    return () => {
      disposed = true
      disposeSubscription?.()
    }
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
  const problems = [...new Set([issue, fault].filter(Boolean) as string[])]
  const problemKey = problems.join(' ')

  // A problem opens itself, because a collapsed error is an error nobody reads;
  // after that it stays exactly as the reader left it.
  useEffect(() => {
    setIssueOpen(problems.length > 0)
  }, [problemKey])

  useEffect(() => {
    const log = logRef.current
    if (log) log.scrollTop = log.scrollHeight
  }, [messages.length, generating, problemKey])

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
          {onResearchViewChange ? <button type="button" className="chats-eye-library" onClick={() => { void researchMirror().listSessions().then((outcome) => onResearchViewChange({ mode: 'eye', outcome })) }}>Saved Eye searches</button> : null}
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
          ) : messages.map((message, messageIndex) => (
            <article key={message.messageId} className="chats-turn" data-role={message.role}>
              <span className="chats-turn-avatar" aria-hidden="true">
                {message.role === 'user' ? 'A' : <Glyph name="core" size={15} />}
              </span>
              <div className="chats-turn-content">
                <header><b>{message.role === 'user' ? 'You' : 'Freya'}</b><time>{timeLabel(message.createdAt)}</time></header>
                <div className="chats-bubble">
                  {message.role === 'assistant'
                    ? <AssistantMessageView
                        content={message.content}
                        onOpenLink={(url, provenance) => onBrowserOpenUrl(url, { kind: 'link', from: provenance?.kind === 'source' ? 'citation' : 'chat', ownerText: messages.slice(0, messageIndex).reverse().find((row) => row.role === 'user')?.content ?? '' })}
                        retrieved={message.media?.length ?? 0}
                        mediaCount={message.media?.length ?? 0}
                      >
                      </AssistantMessageView>
                    : <p className="chats-user-text">{message.content}</p>}
                  {/* What the lookups behind this answer returned. Drawn from the
                      message Core stored, never recovered from the prose: a card needs
                      an address, and an address read out of a sentence is a guess. */}
                  {message.role === 'assistant' && message.media !== undefined && message.media.length > 0 ? (
                    <MediaGrid items={message.media} onOpenBrowserUrl={(url, kind) => onBrowserOpenUrl(url, { kind: 'link', from: 'media', ownerText: messages.slice(0, messageIndex).reverse().find((row) => row.role === 'user')?.content ?? '', mediaKind: kind })} />
                  ) : null}
                </div>
              </div>
            </article>
          ))}
          {researchView ? <ResearchWorkspace view={researchView} onChange={onResearchViewChange ?? (() => {})} onOpenCitation={(url) => openResearchCitationInDockedBrowser(researchView, url)} /> : null}
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
          {problems.length > 0 ? (
            /*
             * One place for everything that went wrong, folded away until it is
             * asked for. This used to be a strip above the chat bar that also
             * carried "Freya is thinking", so the loudest thing on the screen was
             * often not a fact. A timeout now arrives here, in Core's words, with
             * the turn it belongs to, and the reader decides whether to open it.
             */
            <details className="chats-issue" open={issueOpen} onToggle={(event) => setIssueOpen(event.currentTarget.open)}>
              <summary>
                <span className="chats-issue-mark" aria-hidden="true">!</span>
                <b>That did not finish</b>
                <small>{problems.length === 1 ? 'Show what happened' : `${problems.length} problems`}</small>
              </summary>
              <div>{problems.map((problem) => <p key={problem}>{problem}</p>)}</div>
            </details>
          ) : null}
        </div>

        {boundaries.length > 0 ? (
          <div className="chats-status-stack" aria-live="polite">
            {boundaries.map(message => <p key={message} className="chats-boundary" role="status">{message}</p>)}
          </div>
        ) : null}
      </section>
      {browserOpen ? <div className="chats-dock-divider" role="separator" aria-label="Resize browser" aria-orientation="vertical" tabIndex={0}
        onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') onBrowserPercentChange(Math.max(28, Math.min(72, browserPercent + (event.key === 'ArrowLeft' ? 2 : -2)))) }}
        onPointerDown={(event) => {
          const divider = event.currentTarget
          divider.setPointerCapture(event.pointerId)
          const container = divider.parentElement!
          const move = (next: PointerEvent) => { const rect = container.getBoundingClientRect(); onBrowserPercentChange(Math.max(28, Math.min(72, 100 * (rect.right - next.clientX) / rect.width))) }
          const finish = () => { divider.removeEventListener('pointermove', move); divider.removeEventListener('pointerup', finish); divider.removeEventListener('pointercancel', finish) }
          divider.addEventListener('pointermove', move); divider.addEventListener('pointerup', finish); divider.addEventListener('pointercancel', finish)
        }} /> : null}
      {browserOpen ? (
        <DockedBrowser
          requestedUrl={browserRequestedUrl}
          requestedOrigin={{ kind: 'link', from: 'chat', ownerText: 'browser workspace' }}
          onRequestedUrlHandled={onBrowserRequestedUrlHandled}
          onClose={onBrowserClose}
        />
      ) : null}
    </div>
  )
}
