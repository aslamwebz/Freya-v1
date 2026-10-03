import { Badge, Panel } from '../primitives/Controls'
import { Compass, DataView, ListRow, type WorkspaceProps } from './shared'
export function BrainCore({ snapshot }: WorkspaceProps) {
  return <div className="f-brain-grid"><Compass />    <Panel title="Core state" meta={<Badge>Sample telemetry</Badge>}>
    <DataView resource={snapshot.core} empty="Core unavailable">{(data) => <>
      <h3 className="f-narrative">One intelligence.<br />Many ways to connect.</h3>
      <ListRow icon="core" title="Lifecycle" detail={data.lifecycle} />
      <ListRow icon="life" title="Sequence" detail={`${data.sequence} events`} />
      <ListRow icon="mind" title="Active requests" detail={`${data.activeRequests} in flight`} />
      <ListRow icon="mission" title="Integrity" detail={data.integrity} />
      <ListRow icon="world" title="Faults" detail={`${data.faultCount} recorded`} />
      <ListRow icon="relay" title="Stopped" detail={data.stopped ? 'Yes' : 'No'} />
    </>}</DataView></Panel>
    <Panel title="Memory">
      <ListRow icon="life" title="Episodes" detail="1,247 stored" />
      <ListRow icon="mind" title="Relationships" detail="3,891 mapped" />
      <ListRow icon="world" title="Concepts" detail="847 indexed" />
    </Panel>
    <Panel title="Attention">
      <ListRow icon="mission" title="Inbox" detail="12 pending" />
      <ListRow icon="relay" title="Processed today" detail="47 events" />
      <ListRow icon="mind" title="Focus state" detail="Deep work" />
    </Panel>
  </div>
}
