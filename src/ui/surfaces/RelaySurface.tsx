import { useState } from 'react'
import type {
  RelayCommandOutcome,
  RelayProjection,
  RelayReadResult,
  RelayWriteResult,
} from '../../../core/protocol/relay'
import { NO_RELAY_DOMAIN_REASON } from '../../../core/protocol/relay'
import { relayMirror } from '../../platform/relayClient'
import { useRelay } from '../../core/useRelay'

/**
 * THE RELAY VIEW.
 *
 * This window answers three questions: *what is connected*, *what is waiting on
 * your decision*, and *what settled*. Everything on screen arrived in a
 * `RelayProjection` that Core built. There is no local availability, no local
 * approval, no local budget and no optimistic row — including when there is
 * nothing to show, in which case the window says plainly that this build has no
 * Relay domain rather than rendering "no connectors" as though Freya had
 * checked and found none.
 *
 * ## What it deliberately does not do
 *
 * It cannot forge connector availability, widen a capability or execute a write
 * without an approval Core holds. Availability is Core's report, printed
 * verbatim. A write request creates a pending approval and the action runs only
 * after the owner decides — the surface shows "awaiting approval" and nothing
 * else until Core says it settled.
 *
 * ## What it can do, and only what Core permits
 *
 * Request a read on a connector, request a write, and decide a pending
 * approval. None of these carries a capability, a credential, a budget or a
 * connector registration. Core validates, gates and decides.
 */

const MAX_REASON_CHARS = 220

function bounded(text: string): string {
  return text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS - 1)}…` : text
}

function connectorStatus(projection: RelayProjection): string {
  const parts = projection.connectors.map(
    (connector) => `${connector.label}: ${connector.status}`,
  )
  return parts.join(' · ')
}

function riskLabel(risk: string): string {
  switch (risk) {
    case 'read':
      return 'read'
    case 'routine':
      return 'routine'
    case 'consequential':
      return 'consequential'
    default:
      return risk
  }
}

export function RelaySurface() {
  const projection = useRelay()
  const [outcome, setOutcome] = useState<RelayCommandOutcome | null>(null)
  const [readOutcome, setReadOutcome] = useState<RelayCommandOutcome | null>(null)

  // Write form state.
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [eventTitle, setEventTitle] = useState('')
  const [eventStart, setEventStart] = useState('')
  const [eventEnd, setEventEnd] = useState('')
  const [issueRepo, setIssueRepo] = useState('')
  const [issueTitle, setIssueTitle] = useState('')
  const [issueBody, setIssueBody] = useState('')
  const [readQuery, setReadQuery] = useState('')

  if (projection === null) {
    return (
      <div className="relay-surface" data-health="absent">
        <p className="relay-absent">
          Relay is not available. Core has not reported a projection, and this window will not guess
          at one.
        </p>
      </div>
    )
  }

  if (projection.health !== 'ready') {
    const noDomain = projection.reason === NO_RELAY_DOMAIN_REASON
    return (
      <div className="relay-surface" data-health="unavailable">
        <div className="relay-posture" data-ready="false" data-domain={noDomain ? 'absent' : 'unknown'}>
          <b>{noDomain ? 'NO RELAY DOMAIN' : 'RELAY UNAVAILABLE'}</b>
          <span>{bounded(projection.reason ?? 'Core reports no Relay domain, so there is nothing to show.')}</span>
          <span>
            Nothing on this screen is simulated. “No connectors” is a Core report; it is never this
            window’s guess.
          </span>
        </div>
      </div>
    )
  }

  const requestWrite = async (command: string, payload: Record<string, unknown>): Promise<void> => {
    const answer = await relayMirror().requestWrite({ command: command as never, ...payload } as never)
    setOutcome(answer)
  }

  const requestRead = async (command: string, payload: Record<string, unknown>): Promise<void> => {
    const answer = await relayMirror().requestRead({ command: command as never, ...payload } as never)
    setReadOutcome(answer)
  }

  const decide = async (approvalId: string, decision: 'approved' | 'denied'): Promise<void> => {
    const answer = await relayMirror().decide(approvalId, decision)
    setOutcome(answer)
  }

  const emailReady = to.trim().length > 0 && subject.trim().length > 0
  const eventReady = eventTitle.trim().length > 0 && eventStart.trim().length > 0 && eventEnd.trim().length > 0
  const issueReady = issueRepo.trim().length > 0 && issueTitle.trim().length > 0

  return (
    <div className="relay-surface" data-health="ready">
      <div className="relay-posture" data-ready="true">
        <b>RELAY</b>
        <span>{connectorStatus(projection)}</span>
        <span>
          Every action below is approved by you before it runs. This window cannot forge a connector,
          widen a permission or execute a write without an approval Core holds.
        </span>
      </div>

      {outcome !== null && !outcome.ok ? (
        <p className="relay-notice" role="status">
          Core refused that: {bounded(outcome.reason ?? 'no reason given')}
        </p>
      ) : null}

      <section className="relay-section" aria-label="Pending approvals">
        <h2>Pending approvals</h2>
        {projection.pendingApprovals.length === 0 ? (
          <p className="relay-none">Nothing is waiting on your decision.</p>
        ) : (
          <ul className="relay-approvals">
            {projection.pendingApprovals.map((approval) => (
              <li key={approval.approvalId} data-risk={approval.risk}>
                <span className="relay-approval-summary">{bounded(approval.summary)}</span>
                <span className="relay-approval-meta">
                  {approval.connector}.{approval.action} · {riskLabel(approval.risk)} · requested{' '}
                  {approval.requestedAt}
                </span>
                <button type="button" onClick={() => void decide(approval.approvalId, 'approved')}>
                  Approve
                </button>
                <button type="button" onClick={() => void decide(approval.approvalId, 'denied')}>
                  Deny
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="relay-section" aria-label="Read connectors">
        <h2>Read</h2>
        <label>
          Query
          <input value={readQuery} onChange={(event) => setReadQuery(event.target.value)} maxLength={2000} />
        </label>
        <div className="relay-actions">
          <button
            type="button"
            onClick={() => void requestRead('relay.email.read', { query: readQuery })}
            disabled={!projection.connectors.some((c) => c.connector === 'email' && c.status === 'ready')}
          >
            Read email
          </button>
          <button
            type="button"
            onClick={() => void requestRead('relay.calendar.read', { query: readQuery })}
            disabled={!projection.connectors.some((c) => c.connector === 'calendar' && c.status === 'ready')}
          >
            Read calendar
          </button>
          <button
            type="button"
            onClick={() => void requestRead('relay.github.read', { repo: issueRepo })}
            disabled={!projection.connectors.some((c) => c.connector === 'github' && c.status === 'ready')}
          >
            Read GitHub issues
          </button>
        </div>
        {readOutcome !== null && readOutcome.ok && isReadResult(readOutcome.result) ? (
          <p className="relay-read" data-kind={readOutcome.result.kind}>
            {describeReadResult(readOutcome.result)}
          </p>
        ) : null}
        {readOutcome !== null && !readOutcome.ok ? (
          <p className="relay-notice" role="status">
            Read refused: {bounded(readOutcome.reason ?? 'no reason given')}
          </p>
        ) : null}
        <p className="relay-note">
          A read executes directly under Core’s gates. It never creates an approval and never mutates
          anything.
        </p>
      </section>

      <section className="relay-section" aria-label="Compose email">
        <h2>Email</h2>
        <label>
          To
          <input value={to} onChange={(event) => setTo(event.target.value)} maxLength={4096} />
        </label>
        <label>
          Subject
          <input value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={998} />
        </label>
        <label>
          Body
          <textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={100000} />
        </label>
        <div className="relay-actions">
          <button
            type="button"
            disabled={!emailReady}
            onClick={() =>
              void requestWrite('relay.email.draft.create', {
                to,
                subject,
                body,
                idempotencyKey: `draft-${Date.now()}`,
              })
            }
          >
            Save draft
          </button>
          <button
            type="button"
            disabled={!emailReady}
            onClick={() =>
              void requestWrite('relay.email.send', {
                to,
                subject,
                body,
                idempotencyKey: `send-${Date.now()}`,
              })
            }
          >
            Send
          </button>
        </div>
        <p className="relay-note">
          A draft is never a send. Both create a pending approval; the action runs only after you
          decide. There is no hidden BCC — the recipient list is exactly what you see.
        </p>
      </section>

      <section className="relay-section" aria-label="Calendar">
        <h2>Calendar</h2>
        <label>
          Title
          <input value={eventTitle} onChange={(event) => setEventTitle(event.target.value)} maxLength={2000} />
        </label>
        <label>
          Starts
          <input value={eventStart} onChange={(event) => setEventStart(event.target.value)} maxLength={64} />
        </label>
        <label>
          Ends
          <input value={eventEnd} onChange={(event) => setEventEnd(event.target.value)} maxLength={64} />
        </label>
        <button
          type="button"
          disabled={!eventReady}
          onClick={() =>
            void requestWrite('relay.calendar.create', {
              title: eventTitle,
              startsAt: eventStart,
              endsAt: eventEnd,
              idempotencyKey: `event-${Date.now()}`,
            })
          }
        >
          Create event
        </button>
        <p className="relay-note">
          Create, update and cancel are distinct actions. The attendee list is exactly what you supply —
          there is no silent invite expansion.
        </p>
      </section>

      <section className="relay-section" aria-label="GitHub">
        <h2>GitHub</h2>
        <label>
          Repo (owner/repo)
          <input value={issueRepo} onChange={(event) => setIssueRepo(event.target.value)} maxLength={256} />
        </label>
        <label>
          Issue title
          <input value={issueTitle} onChange={(event) => setIssueTitle(event.target.value)} maxLength={2000} />
        </label>
        <label>
          Issue body
          <textarea value={issueBody} onChange={(event) => setIssueBody(event.target.value)} maxLength={100000} />
        </label>
        <button
          type="button"
          disabled={!issueReady}
          onClick={() =>
            void requestWrite('relay.github.issue.create', {
              repo: issueRepo,
              title: issueTitle,
              body: issueBody,
              idempotencyKey: `issue-${Date.now()}`,
            })
          }
        >
          Create issue
        </button>
        <p className="relay-note">
          Writes target only repos on Core’s allowlist. Issue and PR creation are separate actions.
          There is no history rewrite and no arbitrary command execution.
        </p>
      </section>

      <section className="relay-section" aria-label="Recent actions">
        <h2>Recent actions</h2>
        {projection.recentActions.length === 0 ? (
          <p className="relay-none">Nothing has settled yet.</p>
        ) : (
          <ul className="relay-actions-list">
            {projection.recentActions.map((action) => (
              <li key={action.actionId} data-status={action.status}>
                {action.connector}.{action.action} · {action.status}
                {action.failureCode === null ? '' : ` · ${action.failureCode}`} ·{' '}
                {action.settledAt ?? action.requestedAt}
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="relay-limits">
        Budgets: {projection.limits.maxActionsPerConnectorPerWindow} actions per connector per{' '}
        {Math.round(projection.limits.budgetWindowMs / 60000)} minutes ·{' '}
        {projection.limits.maxSendsPerWindow} sends · {projection.limits.maxDraftsPerWindow} drafts ·{' '}
        {projection.limits.maxRetries} retries per action.
      </p>
    </div>
  )
}

function isReadResult(result: RelayReadResult | RelayWriteResult | undefined): result is RelayReadResult {
  if (result === undefined) return false
  return (
    result.kind === 'email.messages' ||
    result.kind === 'calendar.events' ||
    result.kind === 'github.issues' ||
    result.kind === 'external.result'
  )
}

function describeReadResult(result: RelayReadResult): string {
  switch (result.kind) {
    case 'email.messages':
      return `${result.messages.length} message(s)`
    case 'calendar.events':
      return `${result.events.length} event(s)`
    case 'github.issues':
      return `${result.issues.length} issue(s)`
    case 'external.result':
      return `external result: ${JSON.stringify(result.data) ?? 'empty'}`
    default:
      return 'unknown result'
  }
}
