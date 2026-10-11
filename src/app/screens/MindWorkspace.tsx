import type { UiSnapshot } from '../../ui-v2/state/contract'
import { MIND_SECTIONS } from '../state/routes'
import { MindPage } from './Mind'
import { ContextTabs, WorkspaceFrame } from './WorkspaceFrame'
import { ResourceGate } from './WorkspaceResource'

const labels = { overview: 'Overview', system: 'System', map: 'Map', focus: 'Focus & Attention', memory: 'Memory and Learning', self: 'Self and Continuity' } as const

export function MindWorkspace({ section, snapshot, onNavigate }: {
  section: string; snapshot: UiSnapshot; onNavigate: (path: string) => void
}) {
  return <WorkspaceFrame title="Freya" description="Freya’s current state, attention, memory and continuity." icon="mind">
    <ContextTabs label="Freya sections" tabs={MIND_SECTIONS.map(id => ({ id, label: labels[id] }))}
      selected={section} onSelect={id => onNavigate(`mind/${id}`)}>
      <ResourceGate resource={snapshot.mind} title={labels[section as keyof typeof labels]}>{data => section === 'memory' ? <>
        <article className="uw-record"><h2>Memory continuity</h2>
          <p>{data.self.durable ? 'Saved across restarts' : data.self.reason ?? 'Memory is available in this session only.'}</p>
          <p>{data.owner.contextHealth === 'ready' ? `${data.owner.contextItems} context items` : data.owner.contextReason ?? 'Context not connected'}</p>
          <p>{data.owner.personalityHealth === 'ready' ? `${data.owner.relationshipItems} relationship items` : data.owner.personalityReason ?? 'Relationships not connected'}</p>
        </article><p className="uw-summary">Memory contents are not connected to this view. These counts describe what Freya reports.</p>
      </> : <MindPage snapshot={snapshot} page={section as 'overview' | 'focus' | 'self'} />}</ResourceGate>
    </ContextTabs>
  </WorkspaceFrame>
}
