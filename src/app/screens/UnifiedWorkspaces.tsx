import type { ReactNode } from 'react'
import type { Resource, UiSnapshot } from '../../ui-v2/state/contract'
import { MISSION_SECTIONS, LIBRARY_SECTIONS, OFFICE_SECTIONS, resolveRoute } from '../state/routes'
import { Mind } from './Mind'
import { ContextTabs, WorkspaceFrame } from './WorkspaceFrame'

export function NotConnected({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="uw-empty"><h2>{title}</h2><p>{title} not connected.</p><p>{children ?? 'This view cannot read those records yet.'}</p></div>
}

function liveData<T>(resource: Resource<T>): T | null {
  return (resource.status === 'ready' || resource.status === 'stale') && resource.source === 'live' ? resource.data : null
}

function ResourceGate<T>({ resource, title, children }: { resource: Resource<T>; title: string; children: (data: T) => ReactNode }) {
  const data = liveData(resource)
  if (data === null) return <NotConnected title={title}>{resource.status === 'loading' ? 'Waiting for Freya to report.' : 'reason' in resource ? resource.reason : 'Live records are not available in this window.'}</NotConnected>
  return <><p className="uw-source" role="status">{resource.status === 'stale' ? `Last known records · ${resource.reason}` : 'Live records'}</p>{children(data)}</>
}

export function UnifiedWorkspace({ path, snapshot, onNavigate }: { path: string; snapshot: UiSnapshot; onNavigate: (path: string) => void }) {
  const route = resolveRoute(path)
  if (route.destination === 'missions') return <WorkspaceFrame title="Missions" description="Outcomes, execution and the evidence behind them." icon="mission">
    <ContextTabs label="Missions sections" tabs={MISSION_SECTIONS.map(id => ({ id, label: id[0]!.toUpperCase() + id.slice(1) }))}
      selected={route.section} onSelect={id => onNavigate(`missions/${id}`)}>
      {route.section === 'missions' ? <ResourceGate resource={snapshot.mission} title="Missions">{data => <>
        <p className="uw-summary">{data.total} reported · {data.hidden} not shown · {data.durable ? 'Saved across restarts' : 'Available in this session'}</p>
        {data.rows.length ? <div className="uw-records">{data.rows.map(row => <article className="uw-record" key={row.id}>
          <h2>{row.id}</h2><span className="uw-status">{row.status}</span><p>{row.runs} runs · {row.verifiedRuns} verified{row.needsAttention ? ' · Needs your attention' : ''}</p>
        </article>)}</div> : <p className="uw-empty">No missions reported.</p>}
      </>}</ResourceGate> : route.section === 'runs' ? <ResourceGate resource={snapshot.mind} title="Runs">{data => {
        const runs = data.threads.filter(thread => thread.kind === 'run')
        return <><p className="uw-summary">Recent execution reported by Freya. Full run history is not connected.</p>{runs.length ? <div className="uw-records">{runs.map(run => <article className="uw-record" key={run.id}><h2>{run.id}</h2><span className="uw-status">{run.status}</span><p>{run.detail ?? 'No additional detail reported'}</p></article>)}</div> : <p className="uw-empty">No runs reported.</p>}</>
      }}</ResourceGate> : <NotConnected title={route.section[0]!.toUpperCase() + route.section.slice(1)}>
        {route.section === 'goals' ? 'Long-term goals are kept separately from bounded missions. Their records are not available here yet.'
          : route.section === 'heartbeat' ? 'Scheduled mission check-ins are not available here yet.'
          : route.section === 'chats' ? 'Mission-linked conversations are not available here yet. Open Chats to continue a conversation.'
          : 'Mission files are not available here yet.'}
      </NotConnected>}
    </ContextTabs>
  </WorkspaceFrame>
  if (route.destination === 'library') {
    const section = route.section.split('/')[0]!
    return <WorkspaceFrame title="Library" description="Freya’s mind, knowledge and source material in one place." icon="memory">
      <ContextTabs label="Library sections" tabs={LIBRARY_SECTIONS.map(id => ({ id, label: id[0]!.toUpperCase() + id.slice(1) }))}
        selected={section} onSelect={id => onNavigate(`library/${id}`)}>
        {section === 'mind' ? <ContextTabs label="Mind sections" tabs={[{ id: 'overview', label: 'Overview' }, { id: 'focus', label: 'Focus' }, { id: 'memory', label: 'Memory' }]}
          selected={route.section.split('/')[1] ?? 'overview'} onSelect={id => onNavigate(id === 'overview' ? 'library/mind' : `library/mind/${id}`)}>
          {route.section === 'mind/focus' ? <ResourceGate resource={snapshot.mind} title="Focus">{data => data.attention.health === 'ready' ? <article className="uw-record"><h2>{data.attention.focus}</h2><p>{data.attention.inboxCount} retained attention events</p><p>{data.attention.lastDecision ? `${data.attention.lastDecision.outcome} · ${data.attention.lastDecision.reason}` : 'No attention decision reported.'}</p></article> : <NotConnected title="Focus">{data.attention.reason}</NotConnected>}</ResourceGate>
            : route.section === 'mind/memory' ? <ResourceGate resource={snapshot.mind} title="Memory">{data => <><article className="uw-record"><h2>Memory continuity</h2><p>{data.self.durable ? 'Saved across restarts' : data.self.reason ?? 'Memory is available in this session only.'}</p><p>{data.owner.contextHealth === 'ready' ? `${data.owner.contextItems} context items` : data.owner.contextReason ?? 'Context not connected'}</p><p>{data.owner.personalityHealth === 'ready' ? `${data.owner.relationshipItems} relationship items` : data.owner.personalityReason ?? 'Relationships not connected'}</p></article><p className="uw-summary">Memory contents are not connected to this view. These counts describe what Freya reports.</p></>}</ResourceGate>
            : <ResourceGate resource={snapshot.mind} title="Mind">{() => { const slots = Mind({ snapshot }); return <div className="uw-mind-grid"><div>{slots.left}</div><div>{slots.right}</div><div className="uw-mind-bottom">{slots.bottom}</div></div> }}</ResourceGate>}
        </ContextTabs> : section === 'world' ? <ResourceGate resource={snapshot.mind} title="World">{data => data.self.world?.health === 'ready' ? <><article className="uw-record"><h2>World knowledge</h2><p>{data.self.world.entities} entities · {data.self.world.edges} connections · {data.self.world.evidenceRecords} evidence records</p><p>{data.self.world.conflicts} conflicts · {data.self.world.uncertainties} uncertainties · {data.self.world.withheld} private records withheld</p></article><p className="uw-summary">The knowledge catalogue is not connected to this view yet.</p></> : <NotConnected title="World">{data.self.world?.reason}</NotConnected>}</ResourceGate>
          : section === 'people' ? <ResourceGate resource={snapshot.mind} title="People">{data => data.owner.personalityHealth === 'ready' ? <><article className="uw-record"><h2>Relationships</h2><p>{data.owner.relationshipItems} relationship items · {data.owner.admittedItems} admitted items</p></article><p className="uw-summary">Individual people and relationship records are not connected to this view yet.</p></> : <NotConnected title="People">{data.owner.personalityReason}</NotConnected>}</ResourceGate>
          : <NotConnected title={section === 'files' ? 'Files' : 'Search'}>{section === 'files' ? 'The shared file library is not available yet. Conversation attachments and generated files remain in Chats.' : 'Library-wide search is not available yet. Web search remains available in Chats.'}</NotConnected>}
      </ContextTabs>
    </WorkspaceFrame>
  }
  if (route.destination === 'office') return <WorkspaceFrame title="Office" description="Your agents and the work they are doing." icon="workforce">
    <ContextTabs label="Office sections" tabs={OFFICE_SECTIONS.map(id => ({ id, label: id === 'scene' ? 'Office scene' : 'Agents' }))}
      selected={route.section} onSelect={id => onNavigate(`office/${id}`)}>
      {route.section === 'scene' ? <NotConnected title="Office scene">The Office scene is being connected to the agent view.</NotConnected>
        : <ResourceGate resource={snapshot.workforce} title="Agents">{data => <>
          <p className="uw-summary">{data.total} agents reported · {data.working} working</p>
          {data.rows.length ? <div className="uw-records">{data.rows.map(worker => <article className="uw-record" key={worker.id}>
            <h2>{worker.specialization ?? worker.id}</h2><span className="uw-status">{worker.state}</span><p className="uw-id">{worker.id}</p>
          </article>)}</div> : <p className="uw-empty">No agents reported.</p>}
        </>}</ResourceGate>}
    </ContextTabs>
  </WorkspaceFrame>
  return null
}
