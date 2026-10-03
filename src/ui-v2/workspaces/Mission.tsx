import { Badge, Button, Panel, Field, Progress, EmptyState } from '../primitives/Controls'
import { DataView, Filters, ListRow, type WorkspaceProps } from './shared'
const names: Record<string, string> = { 'mission-roadmap': 'Workspace foundation', 'mission-community': 'Grow a connected community', 'mission-world': 'A more connected world' }
export function Mission({ snapshot, view, update }: WorkspaceProps) {
  return <div className="f-workspace">
    <div className="f-toolbar"><Filters options={['All', 'active', 'draft', 'paused']} selected={view.filter} onSelect={(filter) => update({ filter })} />
      <Field label="Search missions" placeholder="Find an outcome…" value={view.query} onChange={(event) => update({ query: event.target.value })} /></div>
    <DataView resource={snapshot.mission} empty="Missions unavailable">{(data) => {
      const rows = data.rows.filter((row) => (view.filter === 'All' || row.status === view.filter) &&
        (names[row.id] ?? row.id).toLowerCase().includes(view.query.toLowerCase()))
      return <><div className="f-summary-line"><span>{rows.length} missions</span><span>Intent → work → evidence</span></div>
        <div className="f-card-grid">{rows.map((row) => <Panel key={row.id} title="Mission" meta={<Badge tone={row.needsAttention ? 'attention' : 'cognition'}>{row.status}</Badge>}>
          <h3 className="f-narrative">{names[row.id] ?? row.id}</h3>
          <p className="f-muted">Build a considered foundation for what comes next.</p>
          <Progress label={`Completed steps for ${names[row.id] ?? row.id}`} value={row.runs ? row.verifiedRuns / row.runs * 100 : null} />
          <p className="f-progress-caption">{row.verifiedRuns} completed / {row.runs} steps</p>
          <Button onClick={() => update({ selected: row.id })}>Inspect outcome <span aria-hidden="true">↗</span></Button>
          {view.selected === row.id && <div className="f-inline-inspector">
            <h4>Milestones</h4>
            <ListRow icon="mission" title="Define success criteria" detail="Completed" />
            <ListRow icon="mission" title="Build prototype" detail="In progress" />
            <ListRow icon="mission" title="User testing" detail="Pending" />
            <h4>Linked Agents</h4>
            <ListRow icon="workforce" title="Research Agent" detail="Active" />
            <ListRow icon="workforce" title="Strategy Agent" detail="Planning" />
            <h4>Approvals</h4>
            <ListRow icon="mission" title="Design review" detail="Pending" />
            <Badge>Preview</Badge>
          </div>}
        </Panel>)}</div>{!rows.length && <EmptyState title="No matching outcomes" detail="Try another search or filter." />}</>
    }}</DataView>
  </div>
}
