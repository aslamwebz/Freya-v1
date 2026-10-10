import { useState, type CSSProperties } from 'react'
import { OFFICE_FLOOR, type OfficeProjection, type OfficeStation } from '../../../core/office/types'
import { useAppOps } from '../state/ops'
import portrait from '../../ui-v2/assets/freya-portrait.webp'
import './office-room.css'

/** A presentation of the existing Office projection. Camera controls never submit commands. */
export function OfficeScene() {
  return <OfficeRoom projection={useAppOps().office} />
}

export function OfficeRoom({ projection }: { projection: OfficeProjection | null }) {
  const [angle, setAngle] = useState(-24)
  const [zoom, setZoom] = useState(1)
  const [flat, setFlat] = useState(false)
  const [selected, select] = useState<string | null>(null)

  if (!projection || projection.health !== 'ready') return <div className="uw-empty">
    <h2>Office scene not connected</h2><p>{projection?.reason ?? 'Waiting for Freya to report the Office.'}</p>
  </div>

  const stations = projection.freya ? [projection.freya, ...projection.stations] : projection.stations
  // Derive selection on every projection so removed workers cannot leave stale details behind.
  const current = stations.find(station => station.stationId === selected) ?? projection.freya ?? stations[0] ?? null
  const hidden = projection.counts.floorStationsHidden + projection.counts.workforceStationsHidden + projection.counts.approvalStationsHidden
  return <div className="or-office">
    <div className="or-toolbar" role="group" aria-label="Office view controls">
      <button type="button" aria-label="Rotate office left" disabled={flat} onClick={() => setAngle(value => Math.max(-60, value - 12))}>↶</button>
      <button type="button" aria-label="Rotate office right" disabled={flat} onClick={() => setAngle(value => Math.min(60, value + 12))}>↷</button>
      <label>Zoom <input aria-label="Office zoom" type="range" min="0.7" max="1.3" step="0.1" value={zoom} onChange={event => setZoom(Number(event.target.value))} /></label>
      <button type="button" onClick={() => { setAngle(-24); setZoom(1); setFlat(false) }}>Reset office view</button>
      <button type="button" aria-pressed={flat} onClick={() => setFlat(value => !value)}>Flat view</button>
      <span>{projection.counts.workersWorking} agents working · {projection.counts.approvalsPending} awaiting approval</span>
    </div>
    <div className="or-viewport" data-flat={flat || undefined}>
      <div className="or-room" role="group" aria-label="Office floor"
        style={{ '--office-turn': `${angle}deg`, '--office-zoom': zoom } as CSSProperties}>
        <div className="or-wall or-wall-back" aria-hidden="true"><span>FREYA / OFFICE</span><i /><i /><i /></div>
        <div className="or-wall or-wall-side" aria-hidden="true" />
        <div className="or-zone or-zone-agents" aria-hidden="true">Agents</div>
        <div className="or-zone or-zone-runs" aria-hidden="true">Work in progress</div>
        <div className="or-zone or-zone-approvals" aria-hidden="true">Decisions</div>
        {stations.map(station => <Station key={station.stationId} station={station} selected={current?.stationId === station.stationId} onSelect={() => select(station.stationId)} />)}
      </div>
    </div>
    {!projection.stations.length && <p className="uw-summary">No agent workstations reported. Freya’s reported presence is shown.</p>}
    {hidden > 0 && <p className="uw-summary">{hidden} additional stations are not shown in this bounded view.</p>}
    <div className="or-directory" role="group" aria-label="Office station list">
      {stations.map(station => <button type="button" key={station.stationId} aria-label={`Select ${station.label} · ${station.state}`}
        aria-pressed={current?.stationId === station.stationId} onClick={() => select(station.stationId)}>
        <b>{station.label}</b><span>{station.state}</span>
      </button>)}
    </div>
    <section className="or-detail uw-record" role="region" aria-label="Station details">
      {current ? <><div><h2>{current.label}</h2><span className="uw-status">{current.state}</span></div>
        {current.status !== current.state && <p>{current.kind === 'freya' ? 'Core status' : 'Status'}: {current.status}</p>}
        <p>{current.detail}</p><p>{current.reason}</p><small className="uw-id">{current.entityId}</small>
        {current.kind === 'run' && <p>{current.counts.stepsVerified} verified steps of {current.counts.stepsTotal} · {current.counts.stepsFailed} failed</p>}
        {current.kind === 'worker' && <p>{current.openAssignments} open assignments</p>}
      </> : <p>No stations reported.</p>}
    </section>
    <p className="or-caption">Workstations reflect Freya’s Office. Changing the view does not change the work.</p>
  </div>
}

function Station({ station, selected, onSelect }: { station: OfficeStation; selected: boolean; onSelect: () => void }) {
  // Core's virtual worker grid extends into its run grid. Compress the worker
  // zone in the presentation to keep both grids distinct without altering Core.
  const x = station.zone === 'workforce' ? station.position.x * .65 : station.position.x
  return <button className="or-station" type="button" data-kind={station.kind} data-state={station.state}
    aria-label={`Inspect ${station.label} · ${station.state}`} aria-pressed={selected} onClick={onSelect}
    style={{ left: `${x / OFFICE_FLOOR.width * 100}%`, top: `${station.position.y / OFFICE_FLOOR.height * 100}%` }}>
    <span className="or-desk" aria-hidden="true"><i className="or-desk-top" /><i className="or-desk-front" /><i className="or-desk-side" /><i className="or-monitor" /></span>
    <span className="or-person" aria-hidden="true">{station.kind === 'freya' ? <img src={portrait} alt="" /> : <><i className="or-person-head" /><i className="or-person-body" /></>}</span>
    <span className="or-name"><b>{station.label}</b><small>{station.state}</small></span>
  </button>
}
