import { Badge, Button, Field, Panel } from '../primitives/Controls'
import { Glyph } from '../primitives/Glyph'
import { Filters, PendingView, isLiveMode, type WorkspaceProps } from './shared'
const stages = [
  ['Idea', 'Capture the opportunity.', 'mind'], ['Specification', 'Define the goal and constraints.', 'relay'],
  ['Prototype', 'Make the idea tangible.', 'core'], ['Evaluation', 'Test, verify and refine.', 'life'], ['Capability', 'Review before release.', 'forge'],
]
const creations = [
  { name: 'Market intelligence studio', type: 'Apps', status: 'Deployed', icon: 'world', version: 'v1.2' },
  { name: 'Research companion', type: 'Agents', status: 'In Evaluation', icon: 'mind', version: 'v0.9' },
  { name: 'Data insight builder', type: 'Tools', status: 'In Build', icon: 'core', version: 'v0.3' },
  { name: 'Strategic planning', type: 'Skills', status: 'Deployed', icon: 'mission', version: 'v1.0' },
  { name: 'Content studio', type: 'Workflows', status: 'In Build', icon: 'forge', version: 'v0.4' },
]
export function Forge({ snapshot, view, update }: WorkspaceProps) {
  if (isLiveMode(snapshot)) {
    return <div className="f-workspace"><PendingView title="Forge is not wired yet"
      detail="No live Foundry projection exists. The creations above are concept art from the design preview, not verified capabilities. The Foundry domain wires into a later phase." /></div>
  }
  const all = [...creations, ...view.concepts.map((name) => ({ name, type: 'Ideas', status: 'Concept', icon: 'forge', version: 'v0.1' }))]
  const filtered = all.filter((item) => (view.filter === 'All' || view.filter === item.type) && item.name.toLowerCase().includes(view.query.toLowerCase()))
  return <div className="f-workspace"><div className="f-forge-intro"><div><p className="f-eyebrow">Your creation partner</p>
    <h2 className="f-narrative f-large">Ideas into intelligence.<br />Possibility into capability.</h2><p className="f-muted">Design. Build. Test. Refine.</p></div>
    <Panel title="New concept"><form onSubmit={(event) => { event.preventDefault(); if (view.draft.trim()) update({ concepts: [...view.concepts, view.draft.trim()], draft: '' }) }}>
      <Field label="Concept name" value={view.draft} placeholder="What would you like to explore?" onChange={(event) => update({ draft: event.target.value })} />
      <Button type="submit" variant="primary" disabled={!view.draft.trim()}>Add concept</Button><p className="f-muted">Turn ideas into real capabilities — tools, skills, and apps that expand what Freya and your teams can do.</p></form></Panel></div>
    <div className="f-forge-stages">{stages.map(([title, detail, icon], index) => <div key={title} className="f-stage">
      <span className="f-stage-number">{index + 1}</span><Glyph name={icon ?? 'core'} size={38} /><h3>{title}</h3><p>{detail}</p></div>)}</div>
    <Panel title="My creations"><div className="f-toolbar"><Filters options={['All', 'Apps', 'Agents', 'Tools', 'Skills', 'Workflows', 'Ideas']} selected={view.filter} onSelect={(filter) => update({ filter })} />
      <Field label="Search creations" value={view.query} onChange={(event) => update({ query: event.target.value })} /></div>
      <div className="f-card-grid">{filtered.map((item) => <div className="f-creation" key={item.name}>
        <Glyph name={item.icon} size={36} />
        <Badge tone={item.status === 'Deployed' ? 'positive' : item.status === 'In Evaluation' ? 'attention' : 'cognition'}>{item.type}</Badge>
        <h3>{item.name}</h3>
        <p className="f-muted">{item.status} · {item.version}</p>
        <div className="f-creation-actions">
          <Button>Open</Button>
          <Button>Edit</Button>
          <Button>Deploy</Button>
        </div>
      </div>)}</div>
      {!filtered.length && <p className="f-muted">No matching concepts.</p>}
    </Panel>
  </div>
}
