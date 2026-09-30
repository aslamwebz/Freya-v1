import { useEffect, useRef, useState } from 'react'
import type { CoreStatus } from '../../../core/protocol/core-protocol'
import { coreMirror, ensureCoreAttached } from '../../platform/coreClient'

/**
 * The Security surface.
 *
 * Every value here is Core's. The surface keeps no business state of its own:
 * `stopAll`, the Governor's status, the guard's posture, the grant count, the
 * provider list and the event sequence all come from the projection, and a
 * control here is a command whose reply is what changes the screen.
 *
 * ## Why STOP ALL needs arming
 *
 * Stopping everything is the right move in an emergency and the wrong move in a
 * hurry. A single button next to the resume button is one stray click from
 * halting every inference Freya can do, and the effect is durable: it survives
 * a restart, so a misclick does not expire.
 *
 * So stopping takes two deliberate steps — press, then confirm — and confirming
 * is what actually sends the command. The armed state is local and expires on
 * its own after a few seconds, so walking away cannot leave a loaded trigger
 * sitting on screen.
 *
 * Resuming takes one explicit press, because refusing to restart is the safe
 * failure and being unable to is not.
 */

/** How long the armed state survives without a confirming press. */
const ARM_TIMEOUT_MS = 6000

type ArmState =
  | { armed: false; armedAt: number | null }
  | { armed: true; armedAt: number }

export function SecuritySurface() {
  const [status, setStatus] = useState<CoreStatus | null>(null)
  const [arm, setArm] = useState<ArmState>({ armed: false, armedAt: null })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const core = coreMirror()
  const confirmRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    void ensureCoreAttached()
    return core.subscribe(setStatus)
  }, [core])

  // An armed trigger that nobody confirms goes away by itself.
  useEffect(() => {
    if (!arm.armed) return
    const timer = window.setTimeout(() => setArm({ armed: false, armedAt: null }), ARM_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [arm])

  useEffect(() => {
    if (arm.armed) confirmRef.current?.focus()
  }, [arm])

  const send = async (command: 'security.stopAll' | 'security.resume', reason: string) => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await core.submit(command, { reason, origin: 'security-surface' })
      // The reply decides what is shown. A refusal is shown as a refusal.
      setMessage(
        result.ok
          ? null
          : `Refused — ${result.refusal?.reason ?? result.error?.message ?? 'no reason given'}`,
      )
    } catch (error: unknown) {
      setMessage(`Could not reach Freya Core — ${error instanceof Error ? error.message : 'unknown'}`)
    } finally {
      setBusy(false)
    }
  }

  if (!status) {
    return (
      <div className="security-surface">
        <p className="security-absent">Waiting for Freya Core to report its state.</p>
      </div>
    )
  }

  const stopped = status.stopAll.active

  return (
    <div className="security-surface" data-stopped={stopped}>
      <div className="security-posture" data-tone={stopped ? 'stopped' : 'normal'}>
        <b>{stopped ? 'STOPPED' : 'RUNNING'}</b>
        <span>
          {stopped
            ? 'Core refuses all cognition until someone resumes it. This survives a restart.'
            : 'Core is ready to think, under a Governor and a Guard.'}
        </span>
      </div>

      <section className="security-section security-controls">
        <h3>Controls</h3>
        {stopped ? (
          <div className="security-resume">
            <p>
              Core is stopped. Resuming allows cognition again; it does not create any grants, and
              it is the only way out of a stop.
            </p>
            <button
              type="button"
              className="security-button security-resume-button"
              disabled={busy}
              onClick={() => void send('security.resume', 'resumed from the Security surface')}
            >
              {busy ? 'Resuming…' : 'Resume Core'}
            </button>
          </div>
        ) : arm.armed ? (
          <div className="security-armed" role="alertdialog" aria-label="Confirm stop all">
            <p>
              This stops every inference Freya can make, including scheduled work, and it stays
              stopped after a restart until you resume it.
            </p>
            <div className="security-armed-row">
              <button
                ref={confirmRef}
                type="button"
                className="security-button security-stop-confirm"
                disabled={busy}
                onClick={() => {
                  setArm({ armed: false, armedAt: null })
                  void send('security.stopAll', 'confirmed from the Security surface')
                }}
              >
                Yes, stop everything
              </button>
              <button
                type="button"
                className="security-button security-cancel"
                onClick={() => setArm({ armed: false, armedAt: null })}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="security-stop">
            <p>
              In an emergency, stop everything. You will be asked to confirm, and only you can
              resume.
            </p>
            <button
              type="button"
              className="security-button security-stop-arm"
              disabled={busy}
              onClick={() => setArm({ armed: true, armedAt: Date.now() })}
            >
              Stop all…
            </button>
          </div>
        )}
        {message ? (
          <p className="security-message" role="alert">
            {message}
          </p>
        ) : null}
        {stopped && status.stopAll.activatedBy ? (
          <p className="security-fineprint">
            Stopped {status.stopAll.activatedAt ?? 'at an unknown time'} by {status.stopAll.activatedBy}.
          </p>
        ) : null}
      </section>
      <section className="security-section">
        <h3>Guard</h3>
        <dl className="security-facts">
          <div>
            <dt>Default outcome</dt>
            <dd>
              {status.guard.defaultOutcome} — anything not explicitly permitted is refused
            </dd>
          </div>
          <div>
            <dt>Approval</dt>
            <dd>
              {status.guard.approvalWorkflow === 'unavailable'
                ? 'No approval workflow exists, so approval-required capabilities are refused'
                : status.guard.approvalWorkflow}
            </dd>
          </div>
        </dl>
      </section>

      <section className="security-section">
        <h3>Governor</h3>
        <dl className="security-facts">
          <div>
            <dt>Status</dt>
            <dd>{describeGovernor(status)}</dd>
          </div>
          <div>
            <dt>Active grants</dt>
            <dd>{status.governor.grantsActive}</dd>
          </div>
          <div>
            <dt>Inference</dt>
            <dd>
              {status.sessionUsage.calls} this session · {status.durableUsage.calls} durable
            </dd>
          </div>
        </dl>
      </section>

      <section className="security-section">
        <h3>Providers</h3>
        {status.providers.length === 0 ? (
          <p className="security-none">No provider is registered.</p>
        ) : (
          <ul className="security-providers">
            {status.providers.map((provider) => (
              <li key={provider.id} data-state={provider.status}>
                <b>{provider.id}</b>
                <span>{provider.status}</span>
                <em>{provider.model ?? 'no model'}</em>
                <small>{provider.detail}</small>
                {provider.liveEnabled ? <i className="security-live">live calls possible</i> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="security-section">
        <h3>Audit log</h3>
        <dl className="security-facts">
          <div>
            <dt>Event sequence</dt>
            <dd>{status.eventSequence}</dd>
          </div>
          <div>
            <dt>Core started</dt>
            <dd>{status.coreStartedAt ?? 'unknown'}</dd>
          </div>
        </dl>
        {status.faults.length > 0 ? (
          <ul className="security-faults">
            {status.faults.map((fault) => (
              <li key={fault}>{fault}</li>
            ))}
          </ul>
        ) : null}
      </section>

    </div>
  )
}

function describeGovernor(status: CoreStatus): string {
  if (status.governor.status === 'unknown') return 'not known yet — Core is still starting'
  if (status.governor.status === 'deny_all') return 'refusing everything, because Core is stopped'
  return 'ready'
}
