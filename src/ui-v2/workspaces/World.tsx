import { useId } from 'react'
import { Badge, Button, Panel, Field, EmptyState } from '../primitives/Controls'
import { Filters, ListRow, PendingView, isLiveMode, type WorkspaceProps } from './shared'
const entities = [
  { id: 'sarah', name: 'Sarah Chen', kind: 'People', detail: 'Product lead · Key collaborator', x: 23, y: 24, role: 'Product Lead', org: 'Freya Labs', location: 'San Francisco, CA' },
  { id: 'alex', name: 'Alex Morgan', kind: 'People', detail: 'Research collaborator', x: 16, y: 58, role: 'Research Lead', org: 'Freya Labs', location: 'London, UK' },
  { id: 'roadmap', name: 'Product roadmap', kind: 'Projects', detail: 'Workspace design · Shared project', x: 76, y: 24, status: 'Active', progress: '72%' },
  { id: 'studio', name: 'Design studio', kind: 'Projects', detail: 'A place for ideas and capabilities', x: 84, y: 56, status: 'In development', progress: '45%' },
  { id: 'lisbon', name: 'Lisbon', kind: 'Places', detail: 'Place · Shared context', x: 30, y: 83, type: 'Office' },
  { id: 'mission', name: 'A connected future', kind: 'Missions', detail: 'Outcome · Shared intention', x: 68, y: 83, status: 'On track' },
]
export function World({ snapshot, view, update }: WorkspaceProps) {
  if (isLiveMode(snapshot)) {
    return <div className="f-workspace"><PendingView title="World is not wired yet"
      detail="No live World projection exists. The connections above are concept art from the design preview, not Freya's real world. Phase 22 wires this to the Self & World model." /></div>
  }
  const id = useId()
  const visible = entities.filter((entity) => (view.filter === 'All' || view.filter === entity.kind) && entity.name.toLowerCase().includes(view.query.toLowerCase()))
  const selected = entities.find((entity) => entity.id === view.selected)
  return <div className="f-workspace">
    <div className="f-toolbar"><Filters options={['All', 'People', 'Projects', 'Places', 'Missions']} selected={view.filter} onSelect={(filter) => update({ filter })} />
      <Field label="Search the world" value={view.query} placeholder="People, projects, places…" onChange={(event) => update({ query: event.target.value })} /></div>
    <div className="f-world-grid"><Panel title="World model" meta={<Badge>{entities.length} connections</Badge>}>
      <Button aria-pressed={view.presentation === 'list'} onClick={() => update({ presentation: view.presentation === 'list' ? 'graph' : 'list' })}>{view.presentation === 'list' ? 'Show graph' : 'Show list'}</Button>
      {!visible.length ? <EmptyState title="No matching connections" detail="Try another search or category." /> : view.presentation === 'list' ? <div className="f-entity-list">{visible.map((entity) => <Button key={entity.id} onClick={() => update({ selected: entity.id })}>{entity.name} · {entity.kind}</Button>)}</div> :
      <div className="f-graph"><svg preserveAspectRatio="none" viewBox="0 0 100 100" aria-hidden="true"><defs><radialGradient id={id}><stop stopColor="currentColor" stopOpacity=".2" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></radialGradient></defs><circle cx="50" cy="50" r="40" fill={`url(#${id})`} />
        <circle cx="50" cy="50" r="23" fill="none" stroke="currentColor" strokeWidth=".2" /><circle cx="50" cy="50" r="42" fill="none" stroke="currentColor" strokeWidth=".1" />
        {visible.map((entity) => <path key={entity.id} d={`M50 50 Q${entity.x} 50 ${entity.x} ${entity.y}`} fill="none" stroke="currentColor" strokeWidth=".3" />)}</svg>
        <div className="f-graph-centre"><b>FREYA</b><small>Understand · Connect · Act</small></div>
        {visible.map((entity) => <Button key={entity.id} className="f-graph-node" style={{ left: `${entity.x}%`, top: `${entity.y}%` }} aria-pressed={view.selected === entity.id} onClick={() => update({ selected: entity.id })}><span>{entity.name}</span><small>{entity.kind}</small></Button>)}
      </div>}
    </Panel><Panel title="Selected connection">
      {selected ? <>
        <h3 className="f-narrative">{selected.name}</h3>
        <Badge tone="cognition">{selected.kind}</Badge>
        <p className="f-muted">{selected.detail}</p>
        {selected.kind === 'People' && <>
          <ListRow icon="mission" title="Role" detail={selected.role ?? 'Not specified'} />
          <ListRow icon="world" title="Organization" detail={selected.org ?? 'Not specified'} />
          <ListRow icon="relay" title="Location" detail={selected.location ?? 'Not specified'} />
        </>}
        {selected.kind === 'Projects' && <>
          <ListRow icon="mission" title="Status" detail={selected.status ?? 'Unknown'} />
          <ListRow icon="forge" title="Progress" detail={selected.progress ?? '0%'} />
        </>}
      </> : <>
        <h3 className="f-narrative">Every connection has context.</h3>
        <p className="f-muted">Choose a node to inspect a person, project, place or Mission.</p>
      </>}
    </Panel></div>
  </div>
}
