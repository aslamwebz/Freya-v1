import { Badge, Panel, Progress, Button, EmptyState } from '../primitives/Controls'
import { Avatar } from '../primitives/Avatar'
import { Glyph } from '../primitives/Glyph'
import { Compass, AttentionRing } from './Presence'
import { DataView, type WorkspaceProps } from './shared'
import type { WorkspaceId } from './catalog'
import { useState } from 'react'

export function Home({ snapshot, view, update, open, panels }: WorkspaceProps & { open: (id: WorkspaceId) => void; panels: readonly string[] }) {
  const [draggedPanel, setDraggedPanel] = useState<string | null>(null)
  const [dragOverPanel, setDragOverPanel] = useState<string | null>(null)
  const selectFocus = (value: string) => update({ filter: value })
  const attention = snapshot.attention
  const live = attention.status === 'ready' || attention.status === 'stale' ? attention.data : null
  const panelOrder = view.panelOrder.length > 0 ? view.panelOrder : panels

  const handleDragStart = (panelId: string) => setDraggedPanel(panelId)
  const handleDragOver = (e: React.DragEvent<HTMLElement>, panelId: string) => {
    e.preventDefault()
    setDragOverPanel(panelId)
  }
  const handleDragEnd = () => {
    if (draggedPanel && dragOverPanel && draggedPanel !== dragOverPanel) {
      const currentPanels = [...panelOrder]
      const fromIdx = currentPanels.indexOf(draggedPanel)
      const toIdx = currentPanels.indexOf(dragOverPanel)
      currentPanels.splice(fromIdx, 1)
      currentPanels.splice(toIdx, 0, draggedPanel)
      update({ panelOrder: currentPanels })
    }
    setDraggedPanel(null)
    setDragOverPanel(null)
  }

  return <DataView resource={snapshot.home} empty="Home unavailable">{home => {
    const mode = home.attention.profiles.find(profile => profile.id === view.filter) ?? home.attention.profiles.find(profile => profile.id === 'Product') ?? home.attention.profiles[0] ?? { id: '', label: 'No focus selected', presence: 'attentive' as const, focused: home.attention.focused, distribution: [] as readonly number[] }

    return <div className="f-home-grid">
    <div className="f-home-left">
      {panelOrder.includes('focus') && <Panel title="Current focus" className="f-focus-panel" meta={<Button className="f-panel-action" aria-label="Open current focus" onClick={() => open('mission')}>•••</Button>} draggable onDragStart={() => handleDragStart('focus')} onDragOver={(e) => handleDragOver(e, 'focus')} onDragEnd={handleDragEnd} style={{ opacity: draggedPanel === 'focus' ? 0.5 : 1 }}>
        {home.focus ? <>
          <h3 className="f-narrative">{home.focus.title}</h3>
          <p className="f-muted">{home.focus.detail}</p>
          <div className="f-progress-line"><Progress label="Focus progress" value={home.focus.progress} />
            {/* Nothing reports a percentage for a Mission, so no figure is invented. */}
            {home.focus.progress !== null && <span>{home.focus.progress}%</span>}</div>
        </> : <EmptyState title="No focus reported" detail="Core has not described what it is doing." />}
        {home.attention.profiles.length > 0 && <div className="f-tags">{home.attention.profiles.map(profile => <Button key={profile.id} aria-pressed={mode.id === profile.id} onClick={() => selectFocus(profile.id)}>{profile.id}</Button>)}
          <Button className="f-circle-button" aria-label="Open roadmap" onClick={() => open('mission')}>+</Button></div>}
      </Panel>}
      {panelOrder.includes('mission') && <Panel title="Mission" className="f-home-mission" meta={home.goals ? <Badge>{home.goals.filter(goal => view.checked.includes(goal.id)).length}/{home.goals.length}</Badge> : <Badge tone="cognition">Preview</Badge>} draggable onDragStart={() => handleDragStart('mission')} onDragOver={(e) => handleDragOver(e, 'mission')} onDragEnd={handleDragEnd} style={{ opacity: draggedPanel === 'mission' ? 0.5 : 1 }}>
        {home.mission ? <h3 className="f-narrative">{home.mission}</h3> : <EmptyState title="No Missions yet" detail="A Mission records what Freya is trying to accomplish." />}
        {/* Only shown when titles exist. Live projections carry no Mission titles. */}
        {home.goals && <div className="f-mission-checklist">{home.goals.map(goal => <label key={goal.id}>
          <input type="checkbox" checked={view.checked.includes(goal.id)} onChange={event => update({ checked: event.target.checked ? [...view.checked, goal.id] : view.checked.filter(item => item !== goal.id) })} />
          <span>{goal.text}</span></label>)}</div>}
      </Panel>}
    </div>
    <div className="f-home-centre"><Compass presence={mode.presence} onFocus={home.attention.profiles.length > 0 ? selectFocus : undefined} /></div>
    <div className="f-home-right">
      {panelOrder.includes('attention') && <Panel title="Attention" className="f-attention-panel" draggable onDragStart={() => handleDragStart('attention')} onDragOver={(e) => handleDragOver(e, 'attention')} onDragEnd={handleDragEnd} style={{ opacity: draggedPanel === 'attention' ? 0.5 : 1 }}>
        {home.attention.profiles.length > 0 ? <div className="f-attention">
          <AttentionRing value={mode.focused} />
          <div className="f-attention-caption"><strong>{mode.label}</strong><small>{home.attention.caption}</small></div>
          <div className="f-attention-bars">{home.attention.categories.map((label, index) => <div key={label}><span>{label}</span><i><b style={{ width: `${mode.distribution[index] ?? 0}%` }} data-accent={index % 3} /></i><small>{mode.distribution[index] ?? 0}%</small></div>)}</div>
        </div> : live ? <div className="f-attention">
          <div className="f-attention-caption"><strong>Core reports {live.focus}</strong><small>{home.attention.caption}</small></div>
          <div className="f-attention-bars">{[
            ['Ingested', live.ingested], ['Decisions', live.decisions], ['Cued', live.cued],
            ['Spoke', live.spoke], ['Interrupted', live.interrupted], ['Budget exceeded', live.budgetExceeded],
          ].map(([label, value], index) => <div key={String(label)}><span>{label}</span><i><b style={{ width: `${Math.min(100, Number(value))}%` }} data-accent={index % 3} /></i><small>{value}</small></div>)}</div>
          <p className="f-muted">{live.inboxCount} in the attention inbox.</p>
        </div> : <EmptyState title="Attention not reporting" detail="Nothing is watching, so nothing can be called clear." />}
      </Panel>}
      {/* A panel with no projection behind it is omitted, not filled with a fixture. */}
      {panelOrder.includes('people') && home.people && <Panel title="People" className="f-people-panel" meta={<Button className="f-panel-action" aria-label="Open people connections" onClick={() => open('world')}>•••</Button>} draggable onDragStart={() => handleDragStart('people')} onDragOver={(e) => handleDragOver(e, 'people')} onDragEnd={handleDragEnd} style={{ opacity: draggedPanel === 'people' ? 0.5 : 1 }}><div className="f-people-preview">
        <div><p>Key people</p><div className="f-avatar-stack">{home.people.slice(0, 4).map(person => <Button className="f-person-avatar" key={person.id} aria-label={`View ${person.name}`} onClick={() => open('world')}><Avatar index={person.avatar} size={36} /></Button>)}
          {(home.morePeople ?? 0) > 0 && <span>+{home.morePeople}</span>}</div></div>
        <ul><li><Glyph name="relay" size={13} /><Button className="f-inline-action" onClick={() => open('relay')}>{home.messages ?? 0} new messages</Button></li>
          <li><Glyph name="people" size={13} />{home.followUps ?? 0} follow-up today</li><li><Glyph name="mission" size={13} />{home.meetingPrep ?? 0} meeting prep items</li></ul>
      </div></Panel>}
      {panelOrder.includes('workforce') && <Panel title="Workforce" className="f-home-workforce" meta={snapshot.workforce.status === 'ready' || snapshot.workforce.status === 'stale' ? <Badge tone="positive">{snapshot.workforce.data.total} {snapshot.workforce.source === 'preview' ? 'in preview' : 'reported'}</Badge> : undefined} draggable onDragStart={() => handleDragStart('workforce')} onDragOver={(e) => handleDragOver(e, 'workforce')} onDragEnd={handleDragEnd} style={{ opacity: draggedPanel === 'workforce' ? 0.5 : 1 }}>
        <DataView resource={snapshot.workforce} empty="Workforce unavailable">{data => data.rows.length ? <div className="f-workforce-rows">{data.rows.map((row, index) =>
          <Button className="f-worker-row" key={row.id} onClick={() => open('workforce')}>
            <span className={`f-worker-ring f-worker-ring--${index % 4}`} data-state={row.state} aria-hidden="true" /><span><strong>{row.specialization ?? row.id}</strong><small>{row.state}</small></span>
            <span className="f-worker-avatars"><Avatar index={index} size={25} /><Avatar index={index + 1} size={25} /></span><Glyph name="arrow" size={15} />
          </Button>)}</div> : <EmptyState title="No active team" detail="Your agents will appear here." />}</DataView>
      </Panel>}
    </div>
    <div className="f-home-bottom">
      {panelOrder.includes('world') && home.world && <Panel title="World" className="f-home-world" meta={<Button className="f-panel-action" aria-label="Open world" onClick={() => open('world')}>•••</Button>} draggable onDragStart={() => handleDragStart('world')} onDragOver={(e) => handleDragOver(e, 'world')} onDragEnd={handleDragEnd} style={{ opacity: draggedPanel === 'world' ? 0.5 : 1 }}>
        <div className="f-world-preview"><div className="f-world-visual" role="img" aria-label="Illustrative connected Earth">
          <svg viewBox="0 0 240 180" aria-hidden="true"><path className="f-world-route" d="M30 140Q80 5 210 120M25 80Q130 160 190 30M60 170Q90 90 210 120" />
            <circle className="f-world-node" cx="80" cy="110" r="3" /><circle className="f-world-node" cx="180" cy="100" r="3" /><circle className="f-world-node" cx="140" cy="45" r="2" /></svg>
        </div><div className="f-world-updates">{home.world.map(item => <Button key={item.id} onClick={() => open('world')}><Glyph name={item.icon} size={15} /><span><b>{item.title}</b><small>{item.detail}</small></span><span aria-hidden="true">›</span></Button>)}</div></div>
      </Panel>}
      {panelOrder.includes('memory') && <Panel title="Recent memory" className="f-home-memory" meta={<Button className="f-panel-action" aria-label="Open memory timeline" onClick={() => open('life')}>•••</Button>} draggable onDragStart={() => handleDragStart('memory')} onDragOver={(e) => handleDragOver(e, 'memory')} onDragEnd={handleDragEnd} style={{ opacity: draggedPanel === 'memory' ? 0.5 : 1 }}>
        <DataView resource={snapshot.activity} empty="Memory unavailable">{memories => memories.length ? <div className="f-memory-list">{[...memories].sort((left, right) => right.at - left.at).slice(0, 5).map((memory, index) =>
          <Button className="f-memory-row" key={memory.id} onClick={() => open('life')}><span className={`f-memory-icon f-memory-icon--${index}`}><Glyph name={['memory', 'mission', 'relay', 'world', 'create'][index]!} size={15} /></span>
            <span>{memory.text}</span><small>{new Date(memory.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</small></Button>)}</div> : <EmptyState title="No memories yet" detail="Your recent activity will appear here." />}</DataView>
      </Panel>}
    </div>
    {!panels.length && <EmptyState title="Your Home, your choice." detail="Use Customize to bring back the panels you want." />}
  </div>}}</DataView>
}