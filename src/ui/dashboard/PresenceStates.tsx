import { PRESENCE_STATES, PRESENCE_TONE, type PresenceState } from '../../core/presence'
import { shellStore, useShell } from '../store'

/**
 * The deterministic presence control.
 *
 * Phase 1 has no model, so presence cannot be driven by cognition. A visible,
 * local control is the honest version: the states, the transitions and the
 * rendering are real, and what drives them is declared rather than faked.
 *
 * It lives at the top of the workspace, next to the design lab, because both are
 * "how Freya is being drawn" controls and belong together rather than one of
 * them being buried under the canvas.
 */
export function PresenceStates({ state }: { state: PresenceState }) {
  return (
    <div className="presence-states">
      <div className="presence-states-head">
        <span className="demo-tag">Demo</span>
        <span className="presence-states-title">Presence state</span>
        <span className="presence-states-value" style={{ color: PRESENCE_TONE[state].accent }}>
          {PRESENCE_TONE[state].label}
        </span>
      </div>
      <div className="presence-states-body" role="group" aria-label="Demo presence state">
        {PRESENCE_STATES.map((candidate) => (
          <button
            key={candidate}
            type="button"
            className="presence-chip"
            aria-pressed={candidate === state}
            onClick={() => shellStore.dispatch({ type: 'presence.set', state: candidate })}
          >
            {PRESENCE_TONE[candidate].label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** The same control, reading presence from the store itself. */
export function PresenceStatesConnected() {
  const state = useShell((s) => s.presence.state)
  return <PresenceStates state={state} />
}
