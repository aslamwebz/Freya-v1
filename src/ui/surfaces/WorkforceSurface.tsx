import { useEffect, useState } from 'react'
import type {
  WorkforceCommandOutcome,
  WorkforceProjection,
  WorkforceWorkerView,
} from '../../../core/protocol/workforce'
import { NO_WORKFORCE_DOMAIN_REASON } from '../../../core/protocol/workforce'
import { workforceMirror } from '../../platform/workforceClient'
import { useWorkforce } from '../../core/useWorkforce'

/**
 * THE WORKFORCE VIEW.
 *
 * This window answers one question: *who is working, and what does Core say
 * they are doing?* Everything on screen came from a `WorkforceProjection` that
 * Core built. There is no local roster, no optimistic row, and no simulated
 * worker — including when there is nothing to show, in which case the window
 * says that a Workforce domain does not exist rather than presenting an empty
 * team as though everybody had gone home.
 *
 * ## What it deliberately does not do
 *
 * There is not one control in this file. No button, no input, no drag target:
 * a workforce surface that could *do* something would be a renderer exercising
 * Workforce authority, and Workforce authority belongs to Core (issue #10) —
 * not to a window, not to Electron, and least of all to whatever process is
 * rendering this. The strongest version of that property is structural, so
 * that is what it is: this component submits nothing. The one command the lane
 * owns, `workforce.status.read`, goes out once on mount carrying no payload,
 * and its only job is to make a refusal visible instead of leaving a stale view
 * quietly on screen.
 *
 * ## Claims are drawn as claims
 *
 * A worker's `claims` render with the word "Claimed" attached and are never
 * merged into the `capabilities` list, because one is what a worker *says* and
 * the other is what Core *assigned* — and a surface that flattened the two
 * would be laundering an agent's self-description into authority on screen.
 * Neither list is a grant: Guard holds the grant, and no function here can
 * reach it.
 *
 * ## The geometry rules this window does not get to break
 *
 * It is an absolutely positioned surface in a sibling layer, like every other.
 * It cannot reflow the shell grid, cannot move the orb, and cannot change the
 * brain.
 */

/** Refusal text is ours and bounded, like everything else this project renders. */
const MAX_REASON_CHARS = 220

function bounded(text: string): string {
  return text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS - 1)}…` : text
}

/**
 * Counts in words, from Core's own numbers.
 *
 * Only the ones that say something: a line reading "2 workers · 1 working"
 * tells a person what is true, while four zeroes in a row only say this window
 * has fields it does not need.
 */
function describeCounts(projection: WorkforceProjection): string {
  const c = projection.counts
  if (c.workers === 0 && c.teams === 0) return 'no workers, no teams'
  const parts: string[] = []
  if (c.workers > 0) {
    parts.push(`${c.workers} ${c.workers === 1 ? 'worker' : 'workers'}`)
    if (c.working > 0) parts.push(`${c.working} working`)
    if (c.waiting > 0) parts.push(`${c.waiting} waiting`)
    if (c.idle > 0) parts.push(`${c.idle} idle`)
  } else {
    parts.push('no workers')
  }
  if (c.teams > 0) parts.push(`${c.teams} ${c.teams === 1 ? 'team' : 'teams'}`)
  return parts.join(' · ')
}

/** The name a team's members are shown under. Id when Core gave no worker. */
function memberLabel(workerId: string, workers: readonly WorkforceWorkerView[]): string {
  const worker = workers.find((candidate) => candidate.workerId === workerId)
  return worker === undefined ? workerId : `${worker.name} (${workerId})`
}

export function WorkforceSurface() {
  const projection = useWorkforce()
  const [outcome, setOutcome] = useState<WorkforceCommandOutcome | null>(null)

  /**
   * The single command this surface submits, once per mount: a read with no
   * payload. It exists so a refusal is a sentence on screen rather than a view
   * that has quietly stopped being current.
   */
  useEffect(() => {
    let alive = true
    void workforceMirror().read().then((answer) => {
      if (alive) setOutcome(answer)
    })
    return () => {
      alive = false
    }
  }, [])

  if (projection === null) {
    return (
      <div className="workforce-surface" data-health="absent">
        <p className="workforce-absent">
          The workforce is not available. Core has not reported yet.
        </p>
      </div>
    )
  }

  if (projection.health !== 'ready') {
    // Two different absences, and they must not read as each other: Core has
    // said *no Workforce domain exists* (the truth about this build), or Core
    // has simply not been reached yet (the truth about a window that opened
    // early). Matching the sentence Core itself exported is what keeps the
    // headline honest without this window paraphrasing it into something
    // stronger than Core claimed.
    const noDomain = projection.reason === NO_WORKFORCE_DOMAIN_REASON
    return (
      <div className="workforce-surface" data-health="unavailable">
        <div className="workforce-posture" data-ready="false" data-domain={noDomain ? 'absent' : 'unknown'}>
          <b>{noDomain ? 'NO WORKFORCE DOMAIN' : 'WORKFORCE UNAVAILABLE'}</b>
          <span>
            {bounded(
              projection.reason ??
                'Core reports no Workforce domain, so there is nothing to show.',
            )}
          </span>
          <span>
            Nothing on this screen is simulated. When a Workforce domain exists, its
            workers and teams appear here exactly as Core reports them.
          </span>
        </div>
        {outcome !== null && !outcome.ok ? (
          <p className="workforce-read-notice" role="status">
            Core refused the workforce read: {bounded(outcome.reason ?? 'no reason given')}
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <div className="workforce-surface" data-health="ready">
      <div className="workforce-posture" data-ready="true">
        <b>WORKFORCE</b>
        <span>{describeCounts(projection)}</span>
        <span>
          Read-only. Every name, state and assignment below is Core's own; this window
          cannot move, assign, grant or claim anything.
        </span>
      </div>

      {outcome !== null && !outcome.ok ? (
        <p className="workforce-read-notice" role="status">
          Core refused the workforce read: {bounded(outcome.reason ?? 'no reason given')}
        </p>
      ) : null}

      {projection.workers.length === 0 && projection.teams.length === 0 ? (
        <p className="workforce-none">
          Core reports no workers and no teams. The Workforce domain is running and it is
          empty — which is a fact about the projection, not a paused view.
        </p>
      ) : null}

      {projection.workers.length > 0 ? (
        <section className="workforce-section" aria-label="Workers">
          <h2>Workers</h2>
          <div className="workforce-list">
            {projection.workers.map((worker) => {
              const team = projection.teams.find((t) => t.teamId === worker.teamId) ?? null
              return (
                <article
                  key={worker.workerId}
                  className="workforce-worker"
                  data-worker-id={worker.workerId}
                  data-state={worker.state}
                >
                  <header>
                    <h3>{worker.name}</h3>
                    <code>{worker.workerId}</code>
                    <span className="workforce-state">{worker.state}</span>
                  </header>

                  <p className="workforce-team-line">
                    {team === null ? 'No team.' : `Team: ${team.name} (${team.teamId})`}
                  </p>

                  {worker.specialization !== null ? (
                    <p className="workforce-specialization">{worker.specialization}</p>
                  ) : null}

                  <p className="workforce-assignment">
                    {worker.assignment === null
                      ? 'No assignment.'
                      : `Assigned: ${worker.assignment.label} (${worker.assignment.kind} ${worker.assignment.id})`}
                  </p>

                  {worker.concurrency !== null ? (
                    <p className="workforce-concurrency">
                      {worker.concurrency.active} of {worker.concurrency.limit} slots in use
                    </p>
                  ) : null}

                  {worker.budget !== null ? (
                    <p className="workforce-budget">
                      {worker.budget.label}: {worker.budget.used} of {worker.budget.limit}
                    </p>
                  ) : null}

                  {/*
                    The two lists stay two lists, on purpose. Capabilities are what
                    Core assigned; claims are what the worker said. Rendering them
                    together would make the second look like the first.
                  */}
                  <p className="workforce-capabilities">
                    {worker.capabilities.length === 0
                      ? 'No capabilities assigned by Core.'
                      : `Assigned by Core: ${worker.capabilities.join(', ')}`}
                  </p>

                  {worker.claims.length > 0 ? (
                    <ul className="workforce-claims" aria-label={`Claims by ${worker.name}`}>
                      {worker.claims.map((claim, index) => (
                        <li
                          key={`${claim.kind}:${claim.value}:${index}`}
                          className="workforce-claim"
                          data-claim-kind={claim.kind}
                        >
                          Claimed, not granted — {claim.kind}: {claim.value}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </article>
              )
            })}
          </div>
        </section>
      ) : null}

      {projection.teams.length > 0 ? (
        <section className="workforce-section" aria-label="Teams">
          <h2>Teams</h2>
          <div className="workforce-list">
            {projection.teams.map((team) => (
              <article key={team.teamId} className="workforce-team" data-team-id={team.teamId}>
                <header>
                  <h3>{team.name}</h3>
                  <code>{team.teamId}</code>
                  <span className="workforce-state">{team.state}</span>
                </header>
                {team.purpose !== null ? (
                  <p className="workforce-purpose">{team.purpose}</p>
                ) : null}
                <p className="workforce-members">
                  {team.memberIds.length === 0
                    ? 'No members.'
                    : team.memberIds
                        .map((memberId) => memberLabel(memberId, projection.workers))
                        .join(', ')}
                </p>
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}
