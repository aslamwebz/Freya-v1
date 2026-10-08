import { useEffect, useMemo, useState } from 'react'
import type { CoreActivityEvent } from '../../../core/protocol/activity'
import { coreMirror, ensureActivityAttached } from '../../platform/coreClient'
import './ActivityFeed.css'

/**
 * Activity rail — what Core actually did while the answer was forming.
 *
 * This component never invents a sentence. Every row is one entry of
 * `CoreActivityEvent` Core already wrote: a model request started, a search
 * retrieved N results, a turn failed, a worker stopped. The `text` field is
 * Core's own one-sentence summary, and `describeActivity` (in
 * `core/protocol/activity.ts`) is the function that enforces the closed
 * vocabulary. A renderer that showed "Freya is thinking about…" instead would
 * be guessing at intent — exactly the kind of model-authored status the
 * architecture refuses.
 *
 * The rail is bounded in two ways the test contract checks:
 *
 *  - **Windowed in time.** Only rows from the last `windowMs` milliseconds
 *    are kept, so a stale row from a previous turn cannot appear under the
 *    next. `windowMs` defaults to the turn budget because that is what a
 *    user reads against.
 *  - **Capped in count.** At most `maxRows` are rendered. A long turn emits
 *    many events; the rail shows the newest few, and the truncation is
 *    stated in the footer so the user knows more happened.
 *
 * The component subscribes once to the shared Core mirror and never writes
 * to it. When `windowMs` is zero or the parent has stopped being interested,
 * the subscription is disposed so an unmount cannot leave a live listener
 * attached to a closed bridge.
 */

export interface ActivityFeedProps {
  /**
   * True while a turn is being processed. When false, the rail clears and
   * hides so a finished transcript does not show a stale "turn started".
   */
  readonly active: boolean
  /** Time window in ms. Rows older than this are not rendered. Default: 90s. */
  readonly windowMs?: number
  /** Maximum rows to render. Default: 6. */
  readonly maxRows?: number
}

const DEFAULT_WINDOW_MS = 90_000
const DEFAULT_MAX_ROWS = 6

/**
 * Decide whether a row belongs in the chat rail.
 *
 * Core emits dozens of kinds; only the ones that say something a person
 * reading a chat answer would want to read are surfaced here. Anything else
 * would either be noisy or — worse — repeat a fact the transcript already
 * shows ("turn completed" beside an answer that just arrived).
 */
function chatRailKind(kind: CoreActivityEvent['kind']): boolean {
  switch (kind) {
    case 'provider.started':
    case 'provider.completed':
    case 'provider.failed':
    case 'provider.cancelled':
    case 'work.run.started':
    case 'work.run.completed':
    case 'work.run.failed':
    case 'work.run.cancelled':
    case 'work.step.verified':
    case 'work.approval.requested':
    case 'work.approval.decided':
    case 'mission.activated':
    case 'mission.failed':
    case 'mission.completed':
    case 'mission.blocked':
    case 'mission.limit.exceeded':
    case 'mission.intent.corrected':
    case 'lifeloop.woke':
    case 'lifeloop.refused':
      return true
    default:
      // 'conversation.turn.completed' / 'conversation.turn.failed' belong on
      // the turn itself; the rail deliberately does not show them so the
      // answer row stays the canonical "how the turn ended".
      return false
  }
}

function toneLabel(tone: CoreActivityEvent['tone']): string {
  switch (tone) {
    case 'good':
      return 'ok'
    case 'bad':
      return 'fail'
    case 'warn':
      return 'warn'
    case 'busy':
      return 'busy'
    default:
      return 'note'
  }
}

function relativeTime(at: number, now: number): string {
  const delta = Math.max(0, now - at)
  if (delta < 1_000) return 'now'
  if (delta < 60_000) return `${String(Math.round(delta / 1_000))}s`
  return `${String(Math.round(delta / 60_000))}m`
}

/**
 * Pure projection: turn the unbounded activity stream into the bounded rail.
 *
 * Exported so the test can exercise the projection without rendering React.
 * The behaviour it locks down is the rail's promise: only the kinds we said
 * we would, only inside the time window, capped at the row limit, newest
 * first, with the truncation honestly stated.
 */
export function projectActivityRail(
  events: readonly CoreActivityEvent[],
  now: number,
  windowMs: number,
  maxRows: number,
): { rows: CoreActivityEvent[]; hidden: number } {
  const cutoff = now - windowMs
  const eligible = events.filter((event) => event.at >= cutoff && chatRailKind(event.kind))
  // Newest first; activity rows are written with monotonic sequence by Core.
  const ordered = [...eligible].sort((a, b) => b.at - a.at)
  const rows = ordered.slice(0, maxRows)
  const hidden = Math.max(0, eligible.length - rows.length)
  return { rows, hidden }
}

export function ActivityFeed({
  active,
  windowMs = DEFAULT_WINDOW_MS,
  maxRows = DEFAULT_MAX_ROWS,
}: ActivityFeedProps) {
  const mirror = coreMirror()
  const [events, setEvents] = useState<CoreActivityEvent[]>(() => mirror.activity)
  const [now, setNow] = useState<number>(() => Date.now())

  useEffect(() => {
    let disposed = false
    let disposeSubscription: (() => void) | null = null
    void ensureActivityAttached().then(() => {
      if (disposed) return
      disposeSubscription = mirror.subscribeActivity(setEvents)
    })
    return () => {
      disposed = true
      disposeSubscription?.()
    }
  }, [mirror])

  // Tick the relative-time labels so a row that said "now" reads as "3s".
  useEffect(() => {
    if (!active) return
    const handle = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(handle)
  }, [active])

  const { rows, hidden } = useMemo(
    () => projectActivityRail(events, now, windowMs, maxRows),
    [events, now, windowMs, maxRows],
  )

  if (!active || rows.length === 0) return null

  return (
    <section className="f-activity" aria-label="Activity during this turn" role="status" data-testid="activity-feed">
      <header className="f-activity-head">
        <span className="f-activity-dot" aria-hidden="true" />
        <b>Activity</b>
        <small>{String(rows.length)} event{rows.length === 1 ? '' : 's'}</small>
      </header>
      <ol className="f-activity-rows">
        {rows.map((event) => (
          <li key={event.id} data-tone={event.tone} className="f-activity-row">
            <span className="f-activity-tag" aria-hidden="true">{toneLabel(event.tone)}</span>
            <span className="f-activity-text">{event.text}</span>
            <time className="f-activity-time" dateTime={new Date(event.at).toISOString()}>{relativeTime(event.at, now)}</time>
          </li>
        ))}
      </ol>
      {hidden > 0 ? (
        <footer className="f-activity-foot">
          <small>{String(hidden)} more event{hidden === 1 ? '' : 's'} not shown.</small>
        </footer>
      ) : null}
    </section>
  )
}