import { useEffect, useRef, useState } from 'react'
import { coreMirror, ensureCoreAttached } from '../../platform/coreClient'
import type { CoreStatus } from '../../../core/protocol/core-protocol'
import { openSurface } from '../surfaceActions'
import { Icon, type IconName } from '../icons'
import { StatusArea } from './StatusArea'

/**
 * The top bar, and the only one.
 *
 * Brand, command bar, clock, kernel status and system controls all live in a
 * single row. The security and settings icons used to sit in the status area as
 * well, which meant the same two icons twice on one screen — so the status area
 * gave them up and this is the one place they exist.
 *
 * ## Dropdowns, not windows
 *
 * The icons here do not open surfaces. They open a panel attached to the icon
 * that opened it, showing the current state of that system, with a button that
 * opens the full surface if you want it.
 *
 * The reason is that "what is my security posture" and "I want to change it" are
 * different requests, and a status check should not cost a 1366x768 window that
 * has to be dragged out of the way afterwards. The panel answers the first; the
 * button is there for the second, and says so on its face.
 *
 * ## What the status line claims
 *
 * "Kernel" is the Core. It is `connected` when a status has arrived over the
 * bridge, `not ready` while the process is still starting, and `unreachable`
 * when there is no bridge at all. It never shows a state Core has not reported.
 */
type PanelId = 'security' | 'settings' | null

export function TopBar() {
  const [status, setStatus] = useState<CoreStatus | null>(null)
  const [panel, setPanel] = useState<PanelId>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const core = coreMirror()

  useEffect(() => {
    void ensureCoreAttached()
    return core.subscribe(setStatus)
  }, [core])

  // One dropdown at a time, and clicking away or pressing Escape closes it.
  useEffect(() => {
    if (panel === null) return
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setPanel(null)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPanel(null)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [panel])

  const toggle = (id: Exclude<PanelId, null>) => setPanel((current) => (current === id ? null : id))

  return (
    <div className="topbar" ref={rootRef}>
      <StatusArea />

      <div className="topbar-status" role="status" aria-live="polite">
        <KernelStatus status={status} />
      </div>

      <div className="topbar-controls">
        <ControlButton
          id="security"
          icon="shield"
          label="Security"
          open={panel === 'security'}
          onToggle={() => toggle('security')}
          danger={status?.stopAll.active === true}
        >
          <SecurityPanel status={status} onOpenSurface={() => { setPanel(null); openSurface('security') }} />
        </ControlButton>

        <ControlButton
          id="settings"
          icon="settings"
          label="Settings"
          open={panel === 'settings'}
          onToggle={() => toggle('settings')}
        >
          <SettingsPanel status={status} onOpenSurface={() => { setPanel(null); openSurface('settings') }} />
        </ControlButton>
      </div>
    </div>
  )
}

function KernelStatus({ status }: { status: CoreStatus | null }) {
  if (status === null) {
    // No status has arrived. Saying "connecting" would be a claim; saying
    // nothing would hide a Core that is not there.
    return (
      <span className="kernel" data-state="unknown">
        <i aria-hidden="true" />
        Kernel <b>not ready</b>
      </span>
    )
  }
  const stopped = status.stopAll.active
  return (
    <span className="kernel" data-state={stopped ? 'stopped' : 'connected'}>
      <i aria-hidden="true" />
      Kernel <b>{stopped ? 'stopped' : 'connected'}</b>
      <span className="kernel-sep" aria-hidden="true">·</span>
      <span className="kernel-detail">seq {status.eventSequence}</span>
    </span>
  )
}

function ControlButton({
  id,
  icon,
  label,
  open,
  onToggle,
  danger,
  children,
}: {
  id: Exclude<PanelId, null>
  icon: IconName
  label: string
  open: boolean
  onToggle: () => void
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="topbar-control">
      <button
        type="button"
        className="topbar-icon"
        aria-expanded={open}
        aria-controls={`topbar-panel-${id}`}
        aria-label={label}
        title={label}
        data-danger={danger === true || undefined}
        onClick={onToggle}
      >
        <Icon name={icon} />
      </button>
      {open ? (
        <div className="topbar-panel" id={`topbar-panel-${id}`} role="dialog" aria-label={label}>
          {children}
        </div>
      ) : null}
    </div>
  )
}

function SecurityPanel({
  status,
  onOpenSurface,
}: {
  status: CoreStatus | null
  onOpenSurface: () => void
}) {
  return (
    <>
      <h3>Security</h3>
      {status === null ? (
        <p className="topbar-note">No status from the kernel yet.</p>
      ) : (
        <dl className="topbar-facts">
          <div>
            <dt>Posture</dt>
            <dd>{status.stopAll.active ? 'Stopped' : 'Running'}</dd>
          </div>
          <div>
            <dt>Guard</dt>
            <dd>{status.guard.defaultOutcome} by default</dd>
          </div>
          <div>
            <dt>Governor</dt>
            <dd>
              {status.governor.status === 'unknown'
                ? 'not known yet'
                : status.governor.status === 'deny_all'
                  ? 'refusing all'
                  : 'ready'}
            </dd>
          </div>
          <div>
            <dt>Grants</dt>
            <dd>{status.governor.grantsActive} active</dd>
          </div>
          <div>
            <dt>Inference</dt>
            <dd>{status.durableUsage.calls} durable</dd>
          </div>
        </dl>
      )}
      <button type="button" className="topbar-open" onClick={onOpenSurface}>
        Open Security Center
      </button>
    </>
  )
}

function SettingsPanel({
  status,
  onOpenSurface,
}: {
  status: CoreStatus | null
  onOpenSurface: () => void
}) {
  const providers = status?.providers ?? []
  return (
    <>
      <h3>Settings</h3>
      <dl className="topbar-facts">
        <div>
          <dt>Providers</dt>
          <dd>{providers.length === 0 ? 'none registered' : providers.length}</dd>
        </div>
        <div>
          <dt>Live calls</dt>
          <dd>{providers.some((p) => p.liveEnabled) ? 'possible' : 'not possible'}</dd>
        </div>
        <div>
          <dt>Event log</dt>
          <dd>{status === null ? 'unknown' : `seq ${status.eventSequence}`}</dd>
        </div>
      </dl>
      <button type="button" className="topbar-open" onClick={onOpenSurface}>
        Open Settings
      </button>
    </>
  )
}
