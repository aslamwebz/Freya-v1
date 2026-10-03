import { Badge, EmptyState, Panel } from '../primitives/Controls'
import { DataView, ListRow, isLiveMode, type WorkspaceProps } from './shared'
/**
 * Brain / Core is cognition telemetry, not Adult Freya's face or body. The design
 * preview showed Freya's portrait here; a live window must not, because that would
 * present Core telemetry as Freya's embodiment. The portrait is deliberately absent and
 * the surface reads as the instrument panel it is.
 */
export function BrainCore({ snapshot }: WorkspaceProps) {
  const liveMode = isLiveMode(snapshot)
  const attention = snapshot.attention
  const attentionData = attention.status === 'ready' || attention.status === 'stale' ? attention.data : null
  return <div className="f-brain-grid">
    <Panel title="Core state" meta={<Badge>{liveMode ? 'Live telemetry' : 'Sample telemetry'}</Badge>}>
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
      {liveMode
        ? <EmptyState title="Memory is not wired yet" detail="The Brain projection is not part of this snapshot. Brain metadata wires into a later phase." />
        : <><ListRow icon="life" title="Episodes" detail="1,247 stored" />
          <ListRow icon="mind" title="Relationships" detail="3,891 mapped" />
          <ListRow icon="world" title="Concepts" detail="847 indexed" /></>}
    </Panel>
    <Panel title="Attention">
      {liveMode
        ? (attentionData ? <>
            <ListRow icon="mission" title="Focus" detail={attentionData.focus} />
            <ListRow icon="relay" title="Inbox" detail={`${attentionData.inboxCount} pending`} />
            <ListRow icon="mind" title="Ingested" detail={`${attentionData.ingested} events`} />
            <ListRow icon="mission" title="Decisions" detail={`${attentionData.decisions} made`} />
          </> : <EmptyState title="Attention not reporting" detail="Nothing is watching, so nothing can be called clear." />)
        : <><ListRow icon="mission" title="Inbox" detail="12 pending" />
          <ListRow icon="relay" title="Processed today" detail="47 events" />
          <ListRow icon="mind" title="Focus state" detail="Deep work" /></>}
    </Panel>
  </div>
}
