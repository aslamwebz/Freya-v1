import { useShell } from '../store'
import { DemoTag, Meter, Panel } from './primitives'
import { openSurface } from '../surfaceActions'

/** What Freya is focused on. The primary card — the reference's strongest pattern. */
export function FocusPanel() {
  const focus = useShell((s) => s.dashboard.focus)

  return (
    <Panel
      title="Current focus"
      meta={
        <>
          <DemoTag />
          <span className="panel-meta-value">{focus.progress}% complete</span>
        </>
      }
    >
      <div className="focus">
        <div className="focus-tile" aria-hidden="true">
          M
        </div>
        <div>
          <h3>{focus.title}</h3>
          <p>{focus.detail}</p>
        </div>
      </div>
      <Meter value={focus.progress} label={`${focus.title} progress`} />
      <div className="stat-strip">
        {focus.stats.map((stat) => (
          <div key={stat.label}>
            <span>{stat.label}</span>
            <b>{stat.value}</b>
          </div>
        ))}
      </div>
      <div className="panel-foot">
        <button type="button" className="link-pill" onClick={() => openSurface('mission')}>
          Open mission <span aria-hidden="true">→</span>
        </button>
      </div>
    </Panel>
  )
}

export function WorkPanel() {
  const work = useShell((s) => s.dashboard.work)

  return (
    <Panel
      title="Active work"
      meta={
        <>
          <DemoTag />
          <span className="count">{work.length}</span>
        </>
      }
    >
      <ul className="rows">
        {work.map((row) => (
          <li key={row.id} className="work-row">
            <div className="work-row-head">
              <b>{row.title}</b>
              <span className="work-row-pct">{row.progress}%</span>
            </div>
            <Meter value={row.progress} label={`${row.title} progress`} />
            <div className="work-row-foot">
              <span>{row.next}</span>
              <span>{row.due}</span>
            </div>
          </li>
        ))}
      </ul>
      <div className="panel-foot">
        <button type="button" className="link-pill" onClick={() => openSurface('work')}>
          Open work surface <span aria-hidden="true">→</span>
        </button>
      </div>
    </Panel>
  )
}

export function AttentionPanel() {
  const attention = useShell((s) => s.dashboard.attention)

  return (
    <Panel
      title="Needs you"
      meta={
        <>
          <DemoTag />
          <span className="count count-hot">{attention.length}</span>
        </>
      }
    >
      <ul className="rows">
        {attention.map((row) => (
          <li key={row.id} className="attention-row" data-severity={row.severity}>
            <span className={`attention-icon attention-${row.severity}`} aria-hidden="true">
              {row.severity === 'critical' ? '!' : '?'}
            </span>
            <div>
              <b>{row.title}</b>
              <small>{row.detail}</small>
            </div>
            <time>{row.due}</time>
          </li>
        ))}
      </ul>
      <p className="panel-note">
        Approvals are a first-class outcome. Nothing here can be approved in Phase 0.
      </p>
    </Panel>
  )
}

export function WorkforcePanel() {
  const workforce = useShell((s) => s.dashboard.workforce)

  return (
    <Panel
      title="Workforce"
      meta={
        <>
          <DemoTag />
          <span className="count">{workforce.length}</span>
        </>
      }
    >
      <ul className="rows">
        {workforce.map((row) => (
          <li key={row.id} className="workforce-row">
            <span className="avatar" data-seed={row.id.charCodeAt(0)} aria-hidden="true">
              {row.name.slice(0, 1)}
            </span>
            <div>
              <b>{row.name}</b>
              <small>{row.role}</small>
            </div>
            <span className={`workforce-status workforce-${row.status}`}>
              <i aria-hidden="true" />
              {row.status}
            </span>
          </li>
        ))}
      </ul>
      <p className="panel-note">No agent exists in Phase 0. These rows are layout only.</p>
    </Panel>
  )
}

export function ActivityPanel() {
  const activity = useShell((s) => s.dashboard.activity)

  return (
    <Panel
      title="Recent activity"
      meta={
        <>
          <DemoTag />
          <span className="count">{activity.length}</span>
        </>
      }
    >
      <ul className="activity">
        {activity.map((row) => (
          <li key={row.id} data-tone={row.tone}>
            <i aria-hidden="true" />
            <span>{row.text}</span>
            <time>{row.ago}</time>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

export function RuntimePanel() {
  const runtime = useShell((s) => s.runtime)
  return (
    <Panel title="Runtime">
      <dl className="runtime">
        <div>
          <dt>Host</dt>
          <dd>{runtime.platform}</dd>
        </div>
        <div>
          <dt>Build</dt>
          <dd>
            v{runtime.version} {runtime.dev ? '· dev' : '· packaged'}
          </dd>
        </div>
        <div>
          <dt>Inference</dt>
          <dd>0 calls · idle Freya costs nothing</dd>
        </div>
        <div>
          <dt>Layout</dt>
          <dd>{runtime.workspaceFile ? 'workspace.json' : 'browser storage'}</dd>
        </div>
      </dl>
    </Panel>
  )
}
