import type { Resource, WorkforceView } from '../../ui-v2/state/contract'
import { ResourceGate } from '../screens/WorkspaceResource'

const STARTER_NAMES = ['Alpha', 'Beta'] as const

/** Names and working states come from Core; absent starter slots are explicit. */
export function AgentRoster({ resource }: { resource: Resource<WorkforceView> }) {
  const data = (resource.status === 'ready' || resource.status === 'stale') && resource.source === 'live' ? resource.data : null
  const missing = STARTER_NAMES.filter(name => !data?.rows.some(worker => worker.name?.toLowerCase() === name.toLowerCase()))
  return <div className="wr-inventory">
    <ResourceGate resource={resource} title="Agents">{data => <>
      <p className="uw-summary">{data.total} agents reported · {data.working} working</p>
      <div className="wr-agent-grid">{data.rows.map(worker => <article className="uw-record wr-agent" key={worker.id}>
        <div className="wr-agent-heading"><span className="wr-agent-monogram" aria-hidden="true">{(worker.name ?? worker.id).slice(0, 1).toUpperCase()}</span>
          <div><h2>{worker.name ?? worker.id}</h2><span className="uw-status">{worker.state}</span></div></div>
        <p>{worker.specialization ?? 'No specialization reported'}</p>
        {worker.assignment && <p>Assigned to {worker.assignment.label} · {worker.assignment.kind}</p>}
        {worker.capabilities && <p className="wr-agent-capabilities">{worker.capabilities.length ? `Capabilities: ${worker.capabilities.join(', ')}` : 'No capabilities assigned'}</p>}
        <small className="uw-id">{worker.id}</small>
      </article>)}</div>
    </>}</ResourceGate>
    {missing.length > 0 && <div className="wr-agent-grid">{missing.map(name => <article className="uw-record wr-agent" data-unreported="true" key={name}>
      <div className="wr-agent-heading"><span className="wr-agent-monogram" aria-hidden="true">{name[0]}</span><div><h2>{name}</h2><span className="uw-status">{data ? 'Not reported' : 'Not connected'}</span></div></div>
      <p>{data ? `Core has not reported an agent named ${name}.` : 'Waiting for the agent roster from Core.'}</p>
      <small>This slot does not create an agent or assign permissions.</small>
    </article>)}</div>}
  </div>
}
