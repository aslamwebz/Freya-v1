import { useEffect, useMemo, useState } from 'react'
import type { OfficeProjection, OfficeStation } from '../../../core/office/projection'
import { OFFICE_FLOOR } from '../../../core/office/types'
import { officeMirror } from '../../platform/officeClient'
import { useOffice } from '../../core/useOffice'
import { workMirror } from '../../platform/workClient'

/**
 * THE OFFICE.
 *
 * A truthful spatial view of real Work/Workforce/Core state. The office is not
 * a simulation or a game board: every station corresponds to one real thing
 * Core owns, and every field of a station is the real state of that thing.
 *
 * ## What it deliberately does not do
 *
 * There is no idle animation, no fake progress, no phantom worker and no
 * decorative activity. A station exists because a real Run, worker, approval
 * or piece of history exists in Core. A station's state is the real state of
 * the thing it represents. If Core says nothing is running, the office says
 * nothing is running — in words, with Freya's station reading `idle`.
 *
 * There is no "mark as done", no "invent a station" and no "fabricate a
 * percentage". The Office owns no action authority: redirect and cancel go
 * through the existing authorized Core commands (`work.run.cancel`,
 * `work.run.pause`, `work.run.resume`, `work.approval.decide`), and the only
 * Office-specific command is the bounded presence request.
 *
 * ## The geometry rules this window does not get to break
 *
 * It is an absolutely positioned surface in a sibling layer, like every other.
 * It cannot reflow the shell grid, cannot move the orb, and cannot change the
 * brain — those live in `.presence-overlay`, outside the grid, and are sized from
 * the viewport alone.
 */

export function OfficeSurface() {
  const projection = useOffice()
  const mirror = officeMirror()
  const work = workMirror()

  const [selected, setSelected] = useState<OfficeStation | null>(null)
  const [busy, setBusy] = useState(false)
  const [reply, setReply] = useState<string | null>(null)
  const [tone, setTone] = useState<'ok' | 'refused'>('ok')

  useEffect(() => {
    void mirror.attach()
  }, [mirror])

  // The selected station is a snapshot. When the projection changes, the
  // selected station may have changed state or disappeared, so we re-resolve
  // it from the latest projection rather than holding a stale copy.
  const current = useMemo(() => {
    if (selected === null || projection === null) return null
    if (selected.kind === 'freya') return projection.freya
    return projection.stations.find((station) => station.stationId === selected.stationId) ?? null
  }, [selected, projection])

  if (projection === null) {
    return (
      <div className="office-surface">
        <p className="office-absent">Waiting for Freya Core to report the office.</p>
      </div>
    )
  }

  if (projection.health !== 'ready') {
    return (
      <div className="office-surface">
        <p className="office-absent" role="status">
          {projection.reason ?? 'the Office is not available'}
        </p>
      </div>
    )
  }

  const report = (outcome: { ok: boolean; operation: string; reason?: string }): boolean => {
    setTone(outcome.ok ? 'ok' : 'refused')
    setReply(outcome.reason ?? (outcome.ok ? `Core: ${outcome.operation}.` : null))
    return outcome.ok
  }

  const act = async (task: () => Promise<{ ok: boolean; operation: string; reason?: string }>) => {
    setBusy(true)
    setReply(null)
    try {
      return report(await task())
    } finally {
      setBusy(false)
    }
  }

  const requestPresence = (workerId: string) =>
    act(async () => {
      const outcome = await mirror.requestPresence(workerId)
      return { ok: outcome.ok, operation: outcome.operation, reason: outcome.reason }
    })

  const cancelRun = (runId: string) =>
    act(async () => {
      const outcome = await work.cancelRun(runId, 'cancelled from the Office')
      return { ok: outcome.ok, operation: outcome.operation, reason: outcome.reason }
    })

  const pauseRun = (runId: string) =>
    act(async () => {
      const outcome = await work.pauseRun(runId)
      return { ok: outcome.ok, operation: outcome.operation, reason: outcome.reason }
    })

  const resumeRun = (runId: string) =>
    act(async () => {
      const outcome = await work.resumeRun(runId)
      return { ok: outcome.ok, operation: outcome.operation, reason: outcome.reason }
    })

  const decide = (approvalId: string, decision: 'approved' | 'denied') =>
    act(async () => {
      const outcome = await work.decide(approvalId, decision, `${decision} from the Office`)
      return { ok: outcome.ok, operation: outcome.operation, reason: outcome.reason }
    })

  return (
    <div className="office-surface" data-stations={projection.stations.length}>
      <section className="office-posture">
        <b>{projection.freya?.state === 'working' ? 'WORKING' : projection.freya?.state === 'locked' ? 'LOCKED' : projection.freya?.state === 'error' ? 'ERROR' : 'IDLE'}</b>
        <span>
          The Office is a read-only spatial view of real Work and Workforce state. A station exists because a
          real Run, worker or approval exists in Core — nothing here is invented, animated or decorative.
        </span>
        {projection.counts.floorStationsHidden > 0 ||
        projection.counts.workforceStationsHidden > 0 ||
        projection.counts.approvalStationsHidden > 0 ||
        projection.counts.historyHidden > 0 ? (
          <span className="office-limits">
            Showing {projection.counts.floorStationsShown} of {projection.counts.runsLive} live runs,{' '}
            {projection.counts.workforceStationsShown} of {projection.counts.workers} workers,{' '}
            {projection.counts.approvalStationsShown} of {projection.counts.approvalsPending} pending approvals,{' '}
            {projection.counts.historyShown} of {projection.counts.runs} history entries. The rest are kept in
            Freya's journal and still counted, just not shown here.
          </span>
        ) : null}
      </section>

      <div className="office-floor" style={{ width: OFFICE_FLOOR.width, height: OFFICE_FLOOR.height }}>
        {projection.freya ? (
          <Station station={projection.freya} selected={current?.stationId === projection.freya.stationId} onSelect={setSelected} />
        ) : null}
        {projection.stations.map((station) => (
          <Station key={station.stationId} station={station} selected={current?.stationId === station.stationId} onSelect={setSelected} />
        ))}
      </div>

      {current ? (
        <StationDetail
          station={current}
          projection={projection}
          busy={busy}
          onCancelRun={cancelRun}
          onPauseRun={pauseRun}
          onResumeRun={resumeRun}
          onDecide={decide}
          onRequestPresence={requestPresence}
          onClose={() => setSelected(null)}
        />
      ) : null}

      {reply ? (
        <p className="office-reply" data-tone={tone} role={tone === 'refused' ? 'alert' : 'status'}>
          {reply}
        </p>
      ) : null}

      <section className="office-section">
        <h3>History</h3>
        <p className="office-note">
          Journaled metadata only: what ran, when, how it ended and whether it verified. No step input, no
          observation content, no task titles.
        </p>
        {projection.history.length === 0 ? (
          <p className="office-none">No run has finished yet.</p>
        ) : (
          <ul className="office-history">
            {projection.history.map((entry) => (
              <li key={entry.entryId} data-status={entry.status}>
                <span className="office-history-kind">{entry.kind}</span>
                <span className="office-history-status">{entry.status}</span>
                <span className="office-history-progress">
                  {entry.stepsVerified} of {entry.stepsTotal} verified
                  {entry.stepsFailed > 0 ? `, ${entry.stepsFailed} failed` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function Station({
  station,
  selected,
  onSelect,
}: {
  station: OfficeStation
  selected: boolean
  onSelect: (station: OfficeStation) => void
}) {
  return (
    <button
      type="button"
      className="office-station"
      data-kind={station.kind}
      data-state={station.state}
      data-zone={station.zone}
      data-selected={selected}
      style={{ left: station.position.x, top: station.position.y }}
      onClick={() => onSelect(station)}
      aria-label={`${station.kind} station: ${station.label}, ${station.state}`}
    >
      <span className="office-station-label">{station.label}</span>
      <span className="office-station-state">{station.state}</span>
      {station.kind === 'run' && station.counts.stepsTotal > 0 ? (
        <span className="office-station-progress">
          {station.counts.stepsVerified}/{station.counts.stepsTotal} verified
        </span>
      ) : null}
      {station.kind === 'worker' && station.openAssignments > 0 ? (
        <span className="office-station-progress">{station.openAssignments} open</span>
      ) : null}
      {station.kind === 'approval' && station.approval ? (
        <span className="office-station-progress">risk {station.approval.risk}</span>
      ) : null}
    </button>
  )
}

function StationDetail({
  station,
  projection,
  busy,
  onCancelRun,
  onPauseRun,
  onResumeRun,
  onDecide,
  onRequestPresence,
  onClose,
}: {
  station: OfficeStation
  projection: OfficeProjection
  busy: boolean
  onCancelRun: (runId: string) => Promise<boolean>
  onPauseRun: (runId: string) => Promise<boolean>
  onResumeRun: (runId: string) => Promise<boolean>
  onDecide: (approvalId: string, decision: 'approved' | 'denied') => Promise<boolean>
  onRequestPresence: (workerId: string) => Promise<boolean>
  onClose: () => void
}) {
  const pendingPresence = projection.presenceRequests.find((request) => request.workerId === station.entityId)

  return (
    <div className="office-detail" data-kind={station.kind} role="dialog" aria-label={`${station.kind} detail`}>
      <div className="office-detail-head">
        <b>{station.label}</b>
        <span className="office-detail-status">{station.status}</span>
        <button type="button" className="office-detail-close" onClick={onClose} aria-label="Close detail">
          ×
        </button>
      </div>
      <p className="office-detail-reason">{station.reason}</p>
      <p className="office-detail-detail">{station.detail}</p>

      {station.kind === 'run' ? (
        <div className="office-detail-section">
          <h4>Progress</h4>
          <p className="office-detail-counts">
            {station.counts.stepsVerified} of {station.counts.stepsTotal} steps verified
            {station.counts.stepsFailed > 0 ? `, ${station.counts.stepsFailed} failed` : ''} ·{' '}
            {station.counts.actions} actions · {station.counts.attempts} attempts
          </p>
          {station.activeStepKey ? <p className="office-detail-active">Active step: {station.activeStepKey}</p> : null}
        </div>
      ) : null}

      {station.kind === 'worker' ? (
        <div className="office-detail-section">
          <h4>Assignments</h4>
          <p className="office-detail-counts">
            {station.openAssignments} open assignment{station.openAssignments === 1 ? '' : 's'}
          </p>
          {pendingPresence ? (
            <p className="office-detail-presence">
              Presence requested at {new Date(pendingPresence.requestedAt).toLocaleTimeString()}
              {pendingPresence.fulfilled ? ' · fulfilled' : ' · pending'}
            </p>
          ) : null}
        </div>
      ) : null}

      {station.kind === 'approval' && station.approval ? (
        <div className="office-detail-section">
          <h4>Approval</h4>
          <p className="office-detail-counts">
            Needs <code>{station.approval.requiredCapability}</code> · risk {station.approval.risk}
          </p>
        </div>
      ) : null}

      <div className="office-detail-actions">
        {station.kind === 'run' && station.status === 'running' ? (
          <button
            type="button"
            className="office-button office-button-small"
            disabled={busy}
            onClick={() => void onPauseRun(station.entityId)}
          >
            Pause
          </button>
        ) : null}
        {station.kind === 'run' && station.status === 'paused' ? (
          <button
            type="button"
            className="office-button office-button-small"
            disabled={busy}
            onClick={() => void onResumeRun(station.entityId)}
          >
            Resume
          </button>
        ) : null}
        {station.kind === 'run' && (station.status === 'running' || station.status === 'paused' || station.status === 'waiting' || station.status === 'awaiting_approval') ? (
          <button
            type="button"
            className="office-button office-button-small"
            disabled={busy}
            onClick={() => void onCancelRun(station.entityId)}
          >
            Cancel
          </button>
        ) : null}
        {station.kind === 'approval' ? (
          <>
            <button
              type="button"
              className="office-button office-button-primary office-button-small"
              disabled={busy}
              onClick={() => void onDecide(station.entityId, 'approved')}
            >
              Approve
            </button>
            <button
              type="button"
              className="office-button office-button-small"
              disabled={busy}
              onClick={() => void onDecide(station.entityId, 'denied')}
            >
              Deny
            </button>
          </>
        ) : null}
        {station.kind === 'worker' && !pendingPresence ? (
          <button
            type="button"
            className="office-button office-button-small"
            disabled={busy}
            onClick={() => void onRequestPresence(station.entityId)}
          >
            Request presence
          </button>
        ) : null}
      </div>
    </div>
  )
}
