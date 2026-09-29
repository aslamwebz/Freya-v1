import { useState } from 'react'

type HarnessTab = 'terminal' | 'browser' | 'agent'

const TABS: { id: HarnessTab; label: string; boundary: string; detail: string }[] = [
  {
    id: 'terminal',
    label: 'Terminal',
    boundary: 'No shell is started',
    detail:
      'Harness terminals will be PTYs owned by the main process, so a session survives a reload of this surface. node-pty is deliberately not installed in Phase 0.',
  },
  {
    id: 'browser',
    label: 'Browser',
    boundary: 'No browser is launched',
    detail:
      'Browser surfaces will host a real view under capability scope. Phase 0 grants no capabilities at all, so nothing can be opened.',
  },
  {
    id: 'agent',
    label: 'Agent session',
    boundary: 'No agent exists',
    detail:
      'An agent session is a Run bound to a surface id. Until the Workforce system exists there is nothing to attach to this surface.',
  },
]

/**
 * Harness — the execution surface.
 *
 * Tab switching and layout are real. Execution is not, and the panel says so in
 * the first line rather than showing a fake prompt.
 */
export function HarnessSurface() {
  const [tab, setTab] = useState<HarnessTab>('terminal')
  const active = TABS.find((entry) => entry.id === tab) ?? TABS[0]

  return (
    <div className="harness">
      <div className="harness-tabs" role="tablist" aria-label="Harness surfaces">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            id={`harness-tab-${entry.id}`}
            aria-selected={entry.id === tab}
            aria-controls="harness-panel"
            className="harness-tab"
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div
        className="harness-panel"
        id="harness-panel"
        role="tabpanel"
        aria-labelledby={`harness-tab-${active?.id ?? 'terminal'}`}
      >
        <p className="harness-boundary">{active?.boundary}</p>
        <p className="harness-detail">{active?.detail}</p>
        <div className="harness-frame" aria-hidden="true">
          <span className="harness-frame-bar">
            <i />
            <i />
            <i />
          </span>
        </div>
      </div>
    </div>
  )
}
