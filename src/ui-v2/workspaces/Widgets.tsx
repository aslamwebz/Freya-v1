import { Badge, Button, Panel } from '../primitives/Controls'
import { WORKSPACES, type WorkspaceId } from './catalog'
import { Glyph } from '../primitives/Glyph'
export function Widgets({ open }: { open: (id: WorkspaceId) => void }) {
  return <div className="f-card-grid">{WORKSPACES.filter((space) => space.id !== 'widgets' && space.id !== 'home').map((space) =>
    <Panel key={space.id} title={space.label} meta={<Badge>Widget</Badge>}>
      <Glyph name={space.symbol} size={34} />
      <h3 className="f-narrative">{space.label}</h3>
      <p className="f-muted">{space.description}</p>
      <div className="f-widget-actions">
        <Button onClick={() => open(space.id)}>Open</Button>
        <Button>Configure</Button>
        <Button>Pin to desktop</Button>
      </div>
    </Panel>)}</div>
}
