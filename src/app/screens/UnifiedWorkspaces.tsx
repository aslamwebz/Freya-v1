import type { UiSnapshot } from '../../ui-v2/state/contract'
import { MISSION_SECTIONS, LIBRARY_SECTIONS, resolveRoute } from '../state/routes'
import { MindWorkspace } from './MindWorkspace'
import { WorkflowsWorkspace } from '../workflows/WorkflowsWorkspace'
import { WorldWorkspace } from '../world/WorldWorkspace'
import { ContextTabs, WorkspaceFrame } from './WorkspaceFrame'
import { WarRoomWorkspace } from '../office/WarRoomWorkspace'
import { GoalRecords } from './GoalRecords'
import { NotConnected, ResourceGate } from './WorkspaceResource'
export { NotConnected } from './WorkspaceResource'

export function UnifiedWorkspace({ path, snapshot, onNavigate }: { path: string; snapshot: UiSnapshot; onNavigate: (path: string) => void }) {
  const route = resolveRoute(path)
  if (route.destination === 'mind') return <MindWorkspace section={route.section} snapshot={snapshot} onNavigate={onNavigate} />
  if (route.destination === 'workflows') return <WorkflowsWorkspace section={route.section} core={snapshot.core} onNavigate={onNavigate} />
  if (route.destination === 'world') return <WorldWorkspace section={route.section} onNavigate={onNavigate} />
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
      }}</ResourceGate> : route.section === 'activity' ? <ResourceGate resource={snapshot.activity} title="Activity">{data => data.length ? <div className="uw-records">
        {data.map(item => <article className="uw-record" key={item.id}><h2>{item.text}</h2><p><time dateTime={new Date(item.at).toISOString()}>{new Date(item.at).toLocaleString('en-GB')}</time> · Event {item.sequence}</p></article>)}
      </div> : <p className="uw-empty">No recent activity reported.</p>}</ResourceGate>
        : <GoalRecords />}
    </ContextTabs>
  </WorkspaceFrame>
  if (route.destination === 'library') {
    const section = route.section.split('/')[0]!
    return <WorkspaceFrame title="Library" description="Knowledge, people and source material, with links to their origin." icon="memory">
      <ContextTabs label="Library sections" tabs={LIBRARY_SECTIONS.map(id => ({ id, label: id[0]!.toUpperCase() + id.slice(1) }))}
        selected={section} onSelect={id => onNavigate(`library/${id}`)}>
        {section === 'knowledge' ? <ResourceGate resource={snapshot.mind} title="Knowledge">{data => data.self.world?.health === 'ready' ? <><article className="uw-record"><h2>World knowledge</h2><p>{data.self.world.entities} entities · {data.self.world.edges} connections · {data.self.world.evidenceRecords} evidence records</p><p>{data.self.world.conflicts} conflicts · {data.self.world.uncertainties} uncertainties · {data.self.world.withheld} private records withheld</p></article><p className="uw-summary">The shared knowledge catalogue is not connected to this view yet. Freya’s current state and memory continuity are in Mind.</p></> : <NotConnected title="Knowledge">{data.self.world?.reason ?? 'The shared knowledge catalogue is not connected to this view yet. Freya’s current state and memory continuity are in Mind.'}</NotConnected>}</ResourceGate>
          : section === 'people' ? <ResourceGate resource={snapshot.mind} title="People">{data => data.owner.personalityHealth === 'ready' ? <><article className="uw-record"><h2>Relationships</h2><p>{data.owner.relationshipItems} relationship items · {data.owner.admittedItems} admitted items</p></article><p className="uw-summary">Individual people and relationship records are not connected to this view yet.</p></> : <NotConnected title="People">{data.owner.personalityReason}</NotConnected>}</ResourceGate>
          : <NotConnected title={section === 'files' ? 'Files' : 'Search'}>{section === 'files' ? 'The shared file library is not available yet. Conversation attachments and generated files remain in Chats.' : 'Library-wide search is not available yet. Web search remains available in Chats.'}</NotConnected>}
      </ContextTabs>
    </WorkspaceFrame>
  }
  if (route.destination === 'office') return <WarRoomWorkspace section={route.section} snapshot={snapshot} onNavigate={onNavigate} />
  return null
}
