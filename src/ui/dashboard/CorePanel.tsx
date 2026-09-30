import { useEffect, useState } from 'react'
import type { CoreCommandName, CoreStatus } from '../../../core/protocol/core-protocol'
import { coreMirror, ensureCoreAttached, type CoreMirror } from '../../platform/coreClient'
import { Panel } from './primitives'

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
      <div className="panel-foot core-foot">
        <CoreButton
          core={core}
          command="security.stopAll"
          disabled={status?.stopAll.active === true || !status}
          label="Stop all"
          title="Latch Core so it refuses cognition until resumed"
        />
        <CoreButton
          core={core}
          command="security.resume"
          disabled={status?.stopAll.active !== true || !status}
          label="Resume"
          title="Clear the stop latch. Only the owner can do this."
        />
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

function CoreButton({
  core,
  command,
  label,
  title,
  disabled,
}: {
  core: CoreMirror
  command: CoreCommandName
  label: string
  title: string
  disabled: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  return (
    <>
      <button
        type="button"
        className="link-pill"
        title={title}
        disabled={disabled || busy}
        onClick={() => {
          setBusy(true)
          setNote(null)
          // The panel does not decide the outcome: Core does, and the reply is
          // what gets shown. A refused command says why.
          void core
            .submit(command, { reason: 'operator pressed the panel control' })
            .then((result) => {
              if (result.ok) setNote(null)
              else setNote(result.refusal?.reason ?? result.error?.message ?? 'refused')
            })
            .catch((error: unknown) => setNote(String(error)))
            .finally(() => setBusy(false))
        }}
      >
        {label}
      </button>
      {note ? <span className="core-note">{note}</span> : null}
    </>
  )
}
