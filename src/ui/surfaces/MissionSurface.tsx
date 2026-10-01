import { useCallback, useEffect, useState } from 'react'
import type { MissionAction, MissionSummaryView } from '../../../core/missions/types'
import { missionMirror, type MissionCommandOutcome } from '../../platform/missionClient'
import { useMission } from '../../core/useMission'

/**
 * THE MISSION BOARD.
 *
 * A Mission is a persistent outcome, so this window answers three questions and no
 * fourth:
 *
 *   1. **What did I ask for, and what state is it in?** One row per Mission, with its
 *      real status.
 *   2. **Is anything happening underneath it?** Child Run counts by their actual Work
 *      status, and a step rather than a percentage.
 *   3. **Is this thing durable?** `persistence` is stated plainly, and `FORGETS ON
 *      QUIT` is shown when the store is ephemeral.
 *
 * ## What it deliberately does not do
 *
 * There is no "mark as done" button that sets a status. The only route to `completed`
 * is "Ask to complete", which submits `mission.requestCompletion` — and Core completes
 * the Mission *only if a code-owned verifier establishes the outcome*. A window that
 * could conclude a Mission would make the entire verification boundary decorative.
 *
 * There is also no percentage. A Mission has no denominator: it is not a fraction of
 * anything, it is an outcome that either was established or was not. Showing "60%"
 * would mean inventing a quantity that does not exist and watching it change.
 *
 * And a failed child Run does not fail the Mission. One failed attempt is not a failed
 * outcome, so the row says `needs attention` and stays active — the distinction being
 * the entire reason Missions exist separately from Runs.
 *
 * ## What it cannot see
 *
 * The Mission's title, intent and success criteria do not arrive here. They live in
 * the encrypted Mission store and would mean a standing feed of everything the owner
 * asked Freya to do, held by any window that happens to be open. So this board shows
 * ids, statuses and counts, and a Mission reads as a row rather than a document.
 *
 * ## The geometry rules this window does not get to break
 *
 * It is an absolutely positioned surface in a sibling layer, like every other. It
 * cannot reflow the shell grid, cannot move the orb, and cannot change the brain.
 */

/** Refusal text is ours and bounded, like everything else this project renders. */
const MAX_REASON_CHARS = 220

/**
 * What each action is honestly called.
 *
 * "Ask Freya to complete this" rather than "Mark complete", because that is what
 * happens: a request goes to Core and a verifier decides. A button labelled as an
 * outcome would promise something the click does not deliver.
 */
const ACTION_LABELS: Record<MissionAction, string> = {
  activate: 'Activate',
  pause: 'Pause',
  resume: 'Resume',
  requestCompletion: 'Ask to complete',
  cancel: 'Cancel',
  fail: 'Conclude as not achieved',
}

/** Actions that end a Mission, listed last and styled apart from the reversible ones. */
const TERMINAL_ACTIONS: readonly MissionAction[] = ['requestCompletion', 'cancel', 'fail']

function bounded(text: string | undefined): string {
  if (text === undefined) return ''
  return text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS - 1)}…` : text
}

/**
 * Counts in words.
 *
 * Only the ones that say something. A row reading "3 runs, 1 completed, 1 failed,
 * 1 queued" tells a person what is true; the same row reading twelve zeroes tells them
 * the renderer has a field it does not need.
 */
function describeCounts(mission: MissionSummaryView): string {
  const c = mission.counts
  const parts: string[] = []
  if (c.total === 0) return 'no Work attached yet'
  parts.push(`${c.total} ${c.total === 1 ? 'run' : 'runs'}`)
  if (c.completed > 0) parts.push(`${c.completed} completed`)
  if (c.verified > 0) parts.push(`${c.verified} fully verified`)
  if (c.failed > 0) parts.push(`${c.failed} failed`)
  if (c.running > 0) parts.push(`${c.running} running`)
  if (c.queued > 0) parts.push(`${c.queued} queued`)
  if (c.awaitingApproval > 0) parts.push(`${c.awaitingApproval} awaiting you`)
  return parts.join(', ')
}

export function MissionSurface() {
  const projection = useMission()
  const [notice, setNotice] = useState<string>('')
  const [busy, setBusy] = useState<string>('')

  // A notice belongs to the Mission it came from, so a refusal on one row does not
  // read as a verdict on another.
  const [noticeFor, setNoticeFor] = useState<string>('')

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 6_000)
    return () => clearTimeout(timer)
  }, [notice])

  const act = useCallback(async (missionId: string, action: MissionAction) => {
    const mirror = missionMirror()
    setBusy(`${missionId}:${action}`)
    setNotice('')
    let outcome: MissionCommandOutcome
    switch (action) {
      case 'activate':
        outcome = await mirror.activate(missionId)
        break
      case 'pause':
        outcome = await mirror.pause(missionId)
        break
      case 'resume':
        outcome = await mirror.resume(missionId)
        break
      case 'requestCompletion':
        outcome = await mirror.requestCompletion(missionId)
        break
      case 'cancel':
        outcome = await mirror.cancel(missionId)
        break
      case 'fail':
        outcome = await mirror.fail(missionId)
        break
    }
    setBusy('')
    setNoticeFor(missionId)
    // Core's own words, in every case. A window that invented its own success message
    // would be reporting something it cannot check.
    setNotice(
      outcome.ok
        ? `${ACTION_LABELS[action]} — Core says ${outcome.operation}`
        : bounded(outcome.reason ?? `${ACTION_LABELS[action]} was refused`),
    )
  }, [])

  if (projection === null) {
    return (
      <div className="mission-surface">
        <p className="mission-absent">Missions are not available. Core has not reported yet.</p>
      </div>
    )
  }

  if (projection.persistence.mode === 'unavailable') {
    return (
      <div className="mission-surface">
        <p className="mission-absent">
          Missions are not available in this build. There is no Mission engine behind this
          window, rather than a Mission engine that is failing quietly.
        </p>
      </div>
    )
  }

  return (
    <div className="mission-surface">
      <div className="mission-posture" data-durable={projection.persistence.durable ? 'true' : 'false'}>
        <b>{projection.persistence.durable ? 'ENCRYPTED AT REST' : 'FORGETS ON QUIT'}</b>
        <span>
          {projection.persistence.durable
            ? 'Mission text is held in its own encrypted store, under its own key.'
            : bounded(
                projection.persistence.reason ??
                  'This machine has no secure storage, so Mission text is kept in memory only.',
              )}
        </span>
      </div>

      {projection.missions.length === 0 ? (
        <p className="mission-none">
          No Missions. Nothing has been asked for yet — which is a fact about the
          projection, not an absence of the subsystem.
        </p>
      ) : (
        <div className="mission-list">
          {projection.missions.map((mission) => (
            <article
              key={mission.missionId}
              className="mission-row"
              data-status={mission.status}
              data-attention={mission.needsAttention ? 'true' : 'false'}
              data-mission-id={mission.missionId}
            >
              <header>
                <h3>{mission.status}</h3>
                <code>{mission.missionId}</code>
              </header>

              <p className="mission-counts">{describeCounts(mission)}</p>

              {/*
                A failed child Run is visible and is not a conclusion. This line is the
                whole reason a Mission is not a Run: the outcome is still open, and the
                board says so rather than quietly turning red.
              */}
              {mission.needsAttention ? (
                <p className="mission-attention">
                  A child Run needs attention. The Mission is still {mission.status} — a failed
                  attempt is not a failed outcome.
                </p>
              ) : null}

              {mission.verification ? (
                <p className="mission-verification" data-state={mission.verification.state}>
                  Verification: {mission.verification.state}
                  {mission.verification.state === 'requested'
                    ? ' — asked, and nobody has answered yet'
                    : ''}
                </p>
              ) : null}

              {mission.reason ? <p className="mission-reason">{mission.reason}</p> : null}

              {notice && noticeFor === mission.missionId ? (
                <p className="mission-notice">{notice}</p>
              ) : null}

              {/*
                Only what Core says is available. A terminal Mission offers nothing at
                all, because a control Core would refuse teaches its user that buttons
                lie.
              */}
              {mission.availableActions.length > 0 ? (
                <div className="mission-actions">
                  {[...mission.availableActions]
                    .sort((a, b) => {
                      const terminal = (x: MissionAction) => (TERMINAL_ACTIONS.includes(x) ? 1 : 0)
                      return terminal(a) - terminal(b)
                    })
                    .map((action) => (
                      <button
                        key={action}
                        type="button"
                        data-action={action}
                        data-terminal={TERMINAL_ACTIONS.includes(action) ? 'true' : 'false'}
                        disabled={busy === `${mission.missionId}:${action}`}
                        onClick={() => {
                          void act(mission.missionId, action)
                        }}
                      >
                        {ACTION_LABELS[action]}
                      </button>
                    ))}
                </div>
              ) : (
                <p className="mission-settled">Settled. There is nothing left to decide.</p>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  )
}