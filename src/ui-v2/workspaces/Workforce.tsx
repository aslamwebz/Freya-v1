import { Badge, Button, Panel } from '../primitives/Controls'
import { Glyph } from '../primitives/Glyph'
import { DataView, Filters, ListRow, isLiveMode, type WorkspaceProps } from './shared'
export function Workforce({ snapshot, view, update }: WorkspaceProps) {
  const liveMode = isLiveMode(snapshot)
  return <div className="f-workspace"><Filters options={['All', 'Researching', 'Planning', 'Creating', 'Reviewing']} selected={view.filter} onSelect={(filter) => update({ filter })} />
    <DataView resource={snapshot.workforce} empty="Workforce unavailable">{(data) => <><div className="f-workforce-summary">
      <div><p className="f-eyebrow">Office / Workforce</p><h2 className="f-narrative f-large">More minds.<br />Greater possibility.</h2></div>
      {/* Only the counts Core actually reported. A live projection carries no uptime or
          active-task figure, so those stats are preview-only rather than invented here. */}
      <div className="f-stat"><b>{data.total}</b><span>Active agents</span></div><div className="f-stat"><b>{data.working}</b><span>Working now</span></div>
      {!liveMode && <><div className="f-stat"><b>98%</b><span>Uptime</span></div><div className="f-stat"><b>24</b><span>Tasks active</span></div></>}</div>
      <div className="f-stations">{data.rows.filter((row) => view.filter === 'All' || row.state === view.filter).map((row) =>
        <Panel key={row.id} title={row.specialization ?? row.id} meta={<Badge tone="cognition">{row.state}</Badge>}>
          <div className="f-station-art" aria-hidden="true"><span /><Glyph name="workforce" size={46} /></div>
          <h3>{row.specialization ?? row.id}</h3><p className="f-muted">A workspace for context, bounded work and evidence.</p>
          <Button onClick={() => update({ selected: view.selected === row.id ? '' : row.id })}>Inspect station</Button>
          {view.selected === row.id && <div className="f-inline-inspector">
            {liveMode ? <>
              <ListRow icon="workforce" title="Worker" detail={row.id} />
              <ListRow icon="workforce" title="State" detail={row.state} />
              <ListRow icon="workforce" title="Specialization" detail={row.specialization ?? 'Not specified'} />
            </> : <>
              <h4>Current Assignment</h4>
              <ListRow icon="mission" title="Task" detail="Market analysis" />
              <ListRow icon="mission" title="Progress" detail="68% complete" />
              <ListRow icon="mission" title="Deadline" detail="2 days" />
              <h4>Budget</h4>
              <ListRow icon="forge" title="Used" detail="$1,240" />
              <ListRow icon="forge" title="Remaining" detail="$3,760" />
              <h4>Verification</h4>
              <ListRow icon="mission" title="Last check" detail="1 hour ago" />
              <ListRow icon="mission" title="Status" detail="Passed" />
              <Badge>Preview</Badge>
            </>}
          </div>}
        </Panel>)}</div></>}</DataView>
  </div>
}
