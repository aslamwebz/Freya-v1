import type { CoreView } from '../../ui-v2/state/contract'
import './core-health.css'

/** Health warnings remain inspectable while the rest of the workspace runs. */
export function CoreHealth({ core }: { core: CoreView }) {
  const temporary = !core.persistenceDurable
  return <details className="hd-core-health">
    <summary className="hd-pill needs">{temporary ? 'TEMPORARY' : 'DEGRADED'}</summary>
    <div className="hd-core-health-detail">
      <p>{core.operational ? 'Core is operational with reduced health.' : 'Core cannot currently serve commands.'}</p>
      {temporary ? <p>Event history for this session will not survive a restart. Chat storage is reported separately in Chats.</p> : null}
      {core.faults.length > 0 ? <ul>{core.faults.map((fault, index) => <li key={index}>{fault}</li>)}</ul> : <p>{core.persistenceReason ?? 'Core reports reduced health.'}</p>}
      <p>Diagnostics: {core.diagnosticsPath ?? 'No diagnostics path is available.'}</p>
      {core.diagnosticsWriteFailures > 0 ? <p>{core.diagnosticsWriteFailures} diagnostics write(s) failed. The log may be incomplete.</p> : null}
    </div>
  </details>
}
