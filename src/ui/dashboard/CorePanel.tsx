import { useEffect, useState } from 'react'
import type { CoreStatus } from '../../../core/protocol/core-protocol'
import { coreMirror, ensureCoreAttached } from '../../platform/coreClient'
import { Panel } from './primitives'
import { openSurface } from '../surfaceActions'

/**
 * The Core panel: Core's own account of itself.
 *
 * Everything shown here is a value Core produced. The renderer does not
 * compute a lifecycle, does not keep a counter, and does not fall back to a
 * reassuring default — when Core is unreachable the panel says so, because a
 * panel that looks healthy while the Core is down is worse than no panel.
 */

export function CorePanel() {
  const [status, setStatus] = useState<CoreStatus | null>(null)
  // The shared mirror attaches itself, so the effect only has to listen.
  const core = coreMirror()

  useEffect(() => {
    void ensureCoreAttached()
    // Only this panel's listener is disposed. The bridge subscription is
    // shared and outlives any one panel.
    return core.subscribe(setStatus)
  }, [core])

  return (
    <Panel
      title="Core"
      meta={
        status ? (
          <span className="panel-meta-value" data-lifecycle={status.lifecycle}>
            {status.lifecycle}
          </span>
        ) : (
          <span className="panel-meta-value">connecting</span>
        )
      }
    >
      {status ? <CoreFacts status={status} /> : <p className="core-absent">No Core status yet.</p>}
      {/* No controls here. Stopping and resuming live in the Security surface,
          where they are deliberate rather than one click away. */}
      <div className="panel-foot core-foot">
        <button
          type="button"
          className="link-pill"
          onClick={() => openSurface('security')}
        >
          {status?.stopAll.active ? 'Core is stopped — open Security' : 'Open Security'}
          <span aria-hidden="true">→</span>
        </button>
      </div>
    </Panel>
  )
}

function CoreFacts({ status }: { status: CoreStatus }) {
  return (
    <dl className="runtime core-facts">
      <div>
        <dt>Governor</dt>
        <dd>{status.governor.status}</dd>
      </div>
      <div>
        <dt>Guard</dt>
        <dd>
          {status.guard.defaultOutcome} by default · {status.guard.approvalWorkflow === 'unavailable'
            ? 'no approval flow'
            : status.guard.approvalWorkflow}
        </dd>
      </div>
      <div>
        <dt>Grants</dt>
        <dd>
          {status.governor.grantsActive} active
          {status.stopAll.active ? ' · stopped' : ''}
        </dd>
      </div>
      <div>
        <dt>Providers</dt>
        <dd>
          {status.providers.length === 0
            ? 'none configured'
            : status.providers
                .map((p) => `${p.id}: ${p.status}`)
                .join(' · ')}
        </dd>
      </div>
      <div>
        <dt>Inference</dt>
        {/* Real counters. Not an estimate, and not a hard-coded reassurance. */}
        <dd>
          {status.sessionUsage.calls} this session · {status.durableUsage.calls} durable
        </dd>
      </div>
      <div>
        <dt>Event log</dt>
        <dd>seq {status.eventSequence}</dd>
      </div>
      {status.stopAll.active ? (
        <div>
          <dt>Stopped</dt>
          <dd>
            since {status.stopAll.activatedAt ?? 'unknown'} by {status.stopAll.activatedBy ?? 'unknown'}
          </dd>
        </div>
      ) : null}
      {status.faults.map((fault) => (
        <div key={fault}>
          <dt>Fault</dt>
          <dd>{fault}</dd>
        </div>
      ))}
    </dl>
  )
}

