import type { UiSnapshot } from '../../ui-v2/state/contract'
import { OFFICE_SECTIONS } from '../state/routes'
import { ContextTabs, WorkspaceFrame } from '../screens/WorkspaceFrame'
import { SkillsSurface } from '../../ui/surfaces/SkillsSurface'
import { OfficeScene } from './OfficeRoom'
import { AgentRoster } from './AgentRoster'
import { ToolInventory } from './ToolInventory'
import './war-room.css'

const labels = { agents: 'Agents', skills: 'Skills', tools: 'Tools', scene: 'Scene' } as const

export function WarRoomWorkspace({ section, snapshot, onNavigate }: {
  section: string; snapshot: UiSnapshot; onNavigate: (path: string) => void
}) {
  return <WorkspaceFrame title="War Room" description="Your agents, their skills and the tools available to Freya." icon="workforce">
    <ContextTabs label="War Room sections" tabs={OFFICE_SECTIONS.map(id => ({ id, label: labels[id] }))}
      selected={section} onSelect={id => onNavigate(`office/${id}`)}>
      {section === 'agents' ? <AgentRoster resource={snapshot.workforce} />
        : section === 'skills' ? <div className="wr-inventory"><SkillsSurface /></div>
        : section === 'scene' ? <OfficeScene /> : <ToolInventory />}
    </ContextTabs>
  </WorkspaceFrame>
}
