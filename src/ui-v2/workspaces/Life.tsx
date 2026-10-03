import { Badge, Panel } from '../primitives/Controls'
import { Filters, ListRow, type WorkspaceProps } from './shared'
const moments = [
  { time: 'Earlier', title: 'A first conversation', detail: 'Ideas, foundations and becoming.', icon: 'relay', kind: 'Conversation' },
  { time: 'Yesterday', title: 'A new connection', detail: 'A project takes shape.', icon: 'world', kind: 'Connection' },
  { time: 'Today', title: 'A moment of clarity', detail: 'A considered next step.', icon: 'mind', kind: 'Reflection' },
  { time: 'Tomorrow', title: 'Room for possibility', detail: 'A plan waiting to be explored.', icon: 'mission', kind: 'Intention' },
  { time: 'Further ahead', title: 'A brighter tomorrow', detail: 'A future we can build toward.', icon: 'forge', kind: 'Possibility' },
]
export function Life({ view, update }: WorkspaceProps) {
  return <div className="f-workspace"><div className="f-toolbar">
    <Filters options={['All', 'Conversation', 'Connection', 'Reflection', 'Intention', 'Possibility']} selected={view.filter} onSelect={(filter) => update({ filter })} />
    <Badge>Timeline</Badge></div>
    <div className="f-timeline">{moments.filter((moment) => view.filter === 'All' || moment.kind === view.filter).map((moment) =>
      <div className="f-timeline-moment" key={moment.time}><span className="f-eyebrow">{moment.time}</span>
        <Panel title={moment.kind}><span className="f-timeline-art" aria-hidden="true" /><h3 className="f-narrative">{moment.title}</h3><p className="f-muted">{moment.detail}</p></Panel><i /></div>)}</div>
    <div className="f-card-grid">
      <Panel title="Today at a glance">
        <h3 className="f-narrative">A day of momentum.</h3>
        <p className="f-muted">Work, conversation and experience belong to the same story.</p>
        <ListRow icon="mission" title="Missions" detail="2 active" />
        <ListRow icon="relay" title="Conversations" detail="3 today" />
        <ListRow icon="mind" title="Reflections" detail="1 new" />
      </Panel>
      <Panel title="Themes">
        <ListRow icon="forge" title="Growth" detail="New possibilities" />
        <ListRow icon="world" title="Connection" detail="Shared understanding" />
        <ListRow icon="mind" title="Learning" detail="Experience with context" />
      </Panel>
      <Panel title="Reflections">
        <h3 className="f-narrative">What changed?<br />What did we learn?</h3>
        <p className="f-muted">The timeline connects events to their evidence and outcomes.</p>
        <ListRow icon="mission" title="Progress on roadmap" detail="72% complete" />
        <ListRow icon="world" title="Community growth" detail="127 new members" />
      </Panel>
      <Panel title="Milestones">
        <ListRow icon="mission" title="Phase 19 launch" detail="Mar 2025" />
        <ListRow icon="forge" title="First 1000 users" detail="Apr 2025" />
        <ListRow icon="world" title="Global expansion" detail="Q3 2025" />
      </Panel>
      <Panel title="Patterns">
        <ListRow icon="mind" title="Peak productivity" detail="Mornings, 9-11 AM" />
        <ListRow icon="relay" title="Communication rhythm" detail="Daily check-ins" />
        <ListRow icon="mission" title="Completion rate" detail="84% on time" />
      </Panel>
    </div>
  </div>
}
