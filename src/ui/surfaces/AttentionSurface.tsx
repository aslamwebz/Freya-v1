import { useEffect, useState } from 'react'
import type {
  AttentionCommandOutcome,
  AttentionProjection,
} from '../../../core/protocol/attention'
import { NO_ATTENTION_DOMAIN_REASON } from '../../../core/protocol/attention'
import {
  ATTENTION_EVENT_KINDS,
  type AttentionEventKind,
} from '../../../core/attention/types'
import { attentionMirror } from '../../platform/attentionClient'
import { useAttention } from '../../core/useAttention'

/**
 * THE ATTENTION VIEW.
 *
 * This window answers two questions: *what arrived*, and *what did Core decide to
 * do about it*. Everything on screen arrived in an `AttentionProjection` that Core
 * built. There is no local importance, no local urgency, no local queue and no
 * optimistic row — including when there is nothing to show, in which case the
 * window says plainly that this build has no Attention domain rather than rendering
 * "nothing needs attention" as though Freya were watching and chose silence.
 *
 * ## What it deliberately does not do
 *
 * It cannot invent an urgency, an importance or an interruption. Those are closed
 * labels Core assigned, printed verbatim. The event's **text** never appears in the
 * projection — only its measured length — and the one way to read a retained event
 * is the explicit, per-event read below, which asks Core for exactly one event
 * rather than holding a standing feed.
 *
 * ## What it can do, and only what Core permits
 *
 * Two owner actions: submit an authorized event, and register a bounded schedule.
 * Neither carries a source, an importance, an urgency, an outcome, a budget or a
 * cooldown. Core fixes the source to `owner` and decides everything else. There is
 * no control here that ticks the scheduler, because a renderer that could make a
 * schedule fire could make Freya speak on demand.
 */

const MAX_REASON_CHARS = 220

function bounded(text: string): string {
  return text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS - 1)}…` : text
}

function describeCounts(projection: AttentionProjection): string {
  const c = projection.counts
  if (c.decisions === 0) return 'no decisions yet'
  const parts: string[] = [`${c.decisions} ${c.decisions === 1 ? 'decision' : 'decisions'}`]
  parts.push(`${c.doNothing} do-nothing`)
  if (c.remembered > 0) parts.push(`${c.remembered} remembered`)
  if (c.cued > 0) parts.push(`${c.cued} cued`)
  if (c.spoke > 0) parts.push(`${c.spoke} spoke`)
  if (c.interrupted > 0) parts.push(`${c.interrupted} interrupted`)
  if (c.budgetExceeded > 0) parts.push(`${c.budgetExceeded} budget hits`)
  return parts.join(' · ')
}

function outcomeLine(projection: AttentionProjection): string | null {
  const last = projection.lastDecision
  if (last === null) return null
  return `${last.outcome} · ${last.importance} importance · ${last.urgency} urgency · ${last.reason} · from ${last.source}`
}

export function AttentionSurface() {
  const projection = useAttention()
  const [outcome, setOutcome] = useState<AttentionCommandOutcome | null>(null)
  const [kind, setKind] = useState<AttentionEventKind>('reminder')
  const [text, setText] = useState('')
  const [detail, setDetail] = useState<{ eventId: string; text: string } | null>(null)

  useEffect(() => {
    let alive = true
    void attentionMirror()
      .read()
      .then(() => {
        if (!alive) return
      })
    return () => {
      alive = false
    }
  }, [])

  const submitEvent = async (): Promise<void> => {
    const answer = await attentionMirror().ingest({ kind, text })
    setOutcome(answer)
    if (answer.ok) setText('')
  }

  const registerSchedule = async (): Promise<void> => {
    const answer = await attentionMirror().schedule({
      kind,
      text,
      dueAt: new Date(Date.now() + 60_000).toISOString(),
    })
    setOutcome(answer)
    if (answer.ok) setText('')
  }

  const readOne = async (eventId: string): Promise<void> => {
    const event = await attentionMirror().readEvent(eventId)
    setDetail(event === null ? null : { eventId, text: event.text })
  }

  if (projection === null) {
    return (
      <div className="attention-surface" data-health="absent">
        <p className="attention-absent">
          Attention is not available. Core has not reported a projection, and this window will not
          guess at one.
        </p>
      </div>
    )
  }

  if (projection.health !== 'ready') {
    const noDomain = projection.reason === NO_ATTENTION_DOMAIN_REASON
    return (
      <div className="attention-surface" data-health="unavailable">
        <div className="attention-posture" data-ready="false" data-domain={noDomain ? 'absent' : 'unknown'}>
          <b>{noDomain ? 'NO ATTENTION DOMAIN' : 'ATTENTION UNAVAILABLE'}</b>
          <span>{bounded(projection.reason ?? 'Core reports no Attention domain, so there is nothing to show.')}</span>
          <span>
            Nothing on this screen is simulated. “Nothing needs attention” is a Core decision; it is
            never this window’s guess.
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="attention-surface" data-health="ready">
      <div className="attention-posture" data-ready="true">
        <b>ATTENTION</b>
        <span>{describeCounts(projection)}</span>
        <span>
          Focus: {projection.focus}. Every label below is Core’s own; this window cannot invent an
          urgency, an importance or an interruption.
        </span>
      </div>

      {outcome !== null && !outcome.ok ? (
        <p className="attention-notice" role="status">
          Core refused that: {bounded(outcome.reason ?? 'no reason given')}
        </p>
      ) : null}

      <section className="attention-section" aria-label="Last decision">
        <h2>Last decision</h2>
        {outcomeLine(projection) === null ? (
          <p className="attention-none">Core has decided nothing yet.</p>
        ) : (
          <p className="attention-decision">{outcomeLine(projection)}</p>
        )}
        {projection.directive === null ? (
          <p className="attention-none">No cue offered.</p>
        ) : (
          <p className="attention-directive" data-outcome={projection.directive.outcome}>
            {projection.directive.outcome}: {projection.directive.cueCode ?? 'no cue code'} (
            {projection.directive.importance} importance, {projection.directive.urgency} urgency)
          </p>
        )}
      </section>

      <section className="attention-section" aria-label="Submit an event">
        <h2>Submit an event</h2>
        <label>
          Kind
          <select value={kind} onChange={(event) => setKind(event.target.value as AttentionEventKind)}>
            {ATTENTION_EVENT_KINDS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          What happened
          <input value={text} onChange={(event) => setText(event.target.value)} maxLength={1000} />
        </label>
        <button type="button" onClick={() => void submitEvent()}>
          Submit to Core
        </button>
        <button type="button" onClick={() => void registerSchedule()}>
          Schedule for a minute from now
        </button>
        <p className="attention-note">
          Core assigns the source (`owner`), the importance, the urgency and the outcome. This form
          cannot name any of them.
        </p>
      </section>

      <section className="attention-section" aria-label="Schedules">
        <h2>Schedules</h2>
        {projection.schedules.length === 0 ? (
          <p className="attention-none">Core holds no schedules.</p>
        ) : (
          <ul className="attention-schedules">
            {projection.schedules.map((schedule) => (
              <li key={schedule.scheduleId} data-status={schedule.status}>
                {schedule.kind} · due {schedule.dueAt} · {schedule.status}
                {schedule.intervalMs === null
                  ? ' · once'
                  : ` · every ${Math.round(schedule.intervalMs / 1000)}s (${schedule.repeats}/${schedule.maxRepeats})`}
                {schedule.status === 'pending' ? (
                  <button
                    type="button"
                    onClick={() => void attentionMirror().cancelSchedule(schedule.scheduleId).then(setOutcome)}
                  >
                    Cancel
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="attention-section" aria-label="Retained events">
        <h2>Retained events</h2>
        {projection.inbox.length === 0 ? (
          <p className="attention-none">Core retained nothing.</p>
        ) : (
          <ul className="attention-inbox">
            {projection.inbox.map((item) => (
              <li key={item.eventId} data-outcome={item.outcome ?? 'none'}>
                {item.source} · {item.kind} · {item.textLength} characters · {item.outcome ?? 'no decision'}
                <button type="button" onClick={() => void readOne(item.eventId)}>
                  Read
                </button>
              </li>
            ))}
          </ul>
        )}
        {detail === null ? null : (
          <p className="attention-detail" data-event={detail.eventId}>
            {bounded(detail.text)}
          </p>
        )}
        <p className="attention-note">
          Metadata only. The event text stays in Core and comes back only from the explicit read
          above, one event at a time — never a standing feed.
        </p>
      </section>

      <p className="attention-limits">
        Budgets: {projection.limits.maxInterruptsPerWindow} interruptions per{' '}
        {Math.round(projection.limits.budgetWindowMs / 60000)} minutes ·{' '}
        {projection.limits.maxSpeaksPerWindowPerSource} speaks per source · cooldown{' '}
        {Math.round(projection.limits.cooldownAfterInterruptMs / 60000)} minutes after an
        interruption.
      </p>
    </div>
  )
}
