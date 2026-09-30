import { useShell } from '../store'
import { Panel } from './primitives'
import { openSurface } from '../surfaceActions'
import type { DesktopProjection, StatusFact, UsageFact } from '../../core/desktopProjection'

/**
 * The dashboard panels.
 *
 * Every value rendered here comes out of the projection — a pure function over
 * Core's status and Core's activity feed. No panel interprets a raw field, and
 * no panel holds state of its own, which is the only way several panels can be
 * trusted to agree with each other.
 *
 * The panels that have nothing to show say so in words. Phase 2 has no work
 * subsystem, no agents and no missions, so "No active work" is the correct
 * content of that panel, not a placeholder for content that does not exist.
 */

function useDesktop(): DesktopProjection {
  return useShell((state) => state.desktop)
}

function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 5) return 'now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/* ------------------------------------------------------------------ left */

/**
 * What Freya is doing, stated plainly.
 *
 * Reads the derived presence rather than a stored one, so the sentence under the
 * name and the name itself cannot come from different places.
 */
export function FocusPanel() {
  const desktop = useDesktop()
  const running = desktop.activity.some((row) => row.id.startsWith('provider:started'))

  return (
    <Panel
      title="Current focus"
      meta={<span className="panel-meta-value">{desktop.headline}</span>}
    >
      <div className="focus">
        <div className="focus-tile" data-state={desktop.presence} aria-hidden="true">
          {desktop.presence.charAt(0).toUpperCase()}
        </div>
        <div>
          <h3>{desktop.presenceDetail}</h3>
          <p>
            {running
              ? 'A model request is in flight. Core authorised it; the Governor decided.'
              : 'Freya is not doing anything. It acts when you ask, and never on its own.'}
          </p>
        </div>
      </div>
      <div className="stat-strip">
        <div>
          <span>Model calls this session</span>
          <b>{desktop.usage.session.calls}</b>
        </div>
        <div>
          <span>Since launch</span>
          <b>{desktop.usage.durable.calls}</b>
        </div>
        <div>
          <span>Grants active</span>
          <b>{desktop.grantsActive}</b>
        </div>
      </div>
    </Panel>
  )
}

/**
 * Active work.
 *
 * Empty, and honest about being empty. The previous version of this panel showed
 * three fictional milestones with progress bars, which made an application with
 * no work subsystem look like one with three projects in flight.
 */
export function WorkPanel() {
  const desktop = useDesktop()

  return (
    <Panel title="Active work" meta={<span className="count">{desktop.work.active}</span>}>
      {desktop.work.empty ? (
        <p className="empty-state">
          <b>{desktop.work.summary}</b>
          <span>{desktop.work.detail}</span>
        </p>
      ) : null}
      <div className="panel-foot">
        <button type="button" className="link-pill" onClick={() => openSurface('work')}>
          Open work surface <span aria-hidden="true">→</span>
        </button>
      </div>
    </Panel>
  )
}

/* ----------------------------------------------------------------- right */

/**
 * The compact system area.
 *
 * Six rows, in the order a person reads them: is it running, is it safe, can it
 * trust its own history, will it let me act, could it spend money, and has it.
 *
 * The last row is the one worth reading twice. Usage is reported by providers and
 * a failure is billed even when nothing is reported, so the figure is a floor
 * whenever anything is unaccounted for, and the label says so.
 */
export function SystemPanel() {
  const desktop = useDesktop()

  return (
    <Panel
      title="System"
      meta={
        <span className="panel-meta-value" data-attention={desktop.attention}>
          {desktop.attention === 'none'
            ? 'all clear'
            : desktop.attention === 'urgent'
              ? 'needs you'
              : 'check'}
        </span>
      }
    >
      <dl className="runtime core-facts">
        {desktop.system.map((row) => (
          <SystemRow key={row.id} row={row} />
        ))}
      </dl>
      {desktop.providers.map((provider) => (
        <p className="provider-line" key={provider.id} data-tone={provider.tone}>
          <b>{provider.name}</b>
          <span>
            {provider.state}
            {provider.model ? ` · ${provider.model}` : ''}
          </span>
          {provider.detail ? <em>{provider.detail}</em> : null}
        </p>
      ))}
      <UsageRows session={desktop.usage.session} durable={desktop.usage.durable} />
    </Panel>
  )
}

function SystemRow({ row }: { row: StatusFact }) {
  return (
    <div className="runtime-row" data-tone={row.tone}>
      <dt>{row.label}</dt>
      <dd>
        <b>{row.value}</b>
        <span>{row.detail}</span>
      </dd>
    </div>
  )
}

function UsageRows({ session, durable }: { session: UsageFact; durable: UsageFact }) {
  return (
    <div className="usage-rows">
      <UsageRow label="This session" usage={session} />
      <UsageRow label="Since launch" usage={durable} />
    </div>
  )
}

function UsageRow({ label, usage }: { label: string; usage: UsageFact }) {
  return (
    <div className="usage-row" data-exact={usage.exact}>
      <span>{label}</span>
      <b>{usage.calls} calls</b>
      <em>
        {usage.inputTokens === null && usage.outputTokens === null
          ? 'no tokens reported'
          : `${(usage.inputTokens ?? 0).toLocaleString()} in · ${(usage.outputTokens ?? 0).toLocaleString()} out`}
      </em>
      {/* Stated, not implied: a lower bound presented as a total is how a bill
          becomes a surprise. */}
      {usage.exact ? null : (
        <i className="usage-caveat">
          at least — {usage.unknownUsageCalls} call{usage.unknownUsageCalls === 1 ? '' : 's'} unaccounted for
        </i>
      )}
    </div>
  )
}

/**
 * What needs a person.
 *
 * An empty list means exactly that. It is not a place to put tips.
 */
export function AttentionPanel() {
  const desktop = useDesktop()

  return (
    <Panel
      title="Needs you"
      meta={<span className="count">{desktop.attentionItems.length}</span>}
    >
      {desktop.attentionItems.length === 0 ? (
        <p className="empty-state">
          <b>Nothing needs you</b>
          <span>
            No decision is outstanding and nothing has failed. Freya will raise an item here when
            that stops being true.
          </span>
        </p>
      ) : (
        <ul className="rows">
          {desktop.attentionItems.map((item) => (
            <li key={item.id} className="attention-row" data-severity={item.severity}>
              <div className="attention-row-head">
                <b>{item.title}</b>
                <span className="work-row-pct">{item.severity === 'critical' ? 'critical' : 'decision'}</span>
              </div>
              <p>{item.detail}</p>
              {item.action ? (
                <button
                  type="button"
                  className="link-pill"
                  onClick={() => openSurface(item.action!.surface as never)}
                >
                  {item.action.label} <span aria-hidden="true">→</span>
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

/**
 * Recent activity, from durable Core events.
 *
 * A projection of the journal and nothing more. There is no second activity log
 * on disk: if this panel is empty it is because Core has not done anything worth
 * reporting, and closing the window loses nothing.
 */
export function ActivityPanel() {
  const desktop = useDesktop()
  const now = Date.now()
  const rows = desktop.activity.slice(-12).reverse()

  return (
    <Panel title="Recent activity" meta={<span className="count">{desktop.activity.length}</span>}>
      {rows.length === 0 ? (
        <p className="empty-state">
          <b>No activity yet</b>
          <span>Built from durable Core events. Freya has not recorded anything to show.</span>
        </p>
      ) : (
        <ul className="rows activity-rows">
          {rows.map((row) => (
            <li key={row.id} className="activity-row" data-tone={row.tone}>
              <span className="activity-dot" aria-hidden="true" />
              {/* `text` comes from Core's mapping, which cannot carry command
                  text. The journal never held it and neither does this. */}
              <span className="activity-text">{row.text}</span>
              <span className="activity-ago">{ago(row.at, now)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

/** Host identity. Presentation only, and not a system fact. */
export function RuntimePanel() {
  const runtime = useShell((state) => state.runtime)

  return (
    <Panel title="Runtime">
      <dl className="runtime">
        <div className="runtime-row" data-tone="info">
          <dt>Freya</dt>
          <dd>
            <b>v{runtime.version}</b>
            <span>{runtime.platform}</span>
          </dd>
        </div>
      </dl>
    </Panel>
  )
}
