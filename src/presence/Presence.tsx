import { useEffect, useRef, useState, type RefObject } from 'react'
import { PRESENCE_STATES, PRESENCE_TONE, type PresenceState } from '../core/presence'
import { shellStore, useShell } from '../ui/store'
import { DesignLab } from './DesignLab'
import { PresenceView, type PresenceHandle } from './PresenceView'
import { voiceEnvelope } from './voiceEnvelope'

/**
 * The presence: Freya's visible state, and the design lab that controls how it
 * is drawn.
 *
 * Three inputs reach the stage and only three: the presence state from the
 * shell store, the voice envelope, and the design lab. Nothing here calls a
 * model — the rendering is deterministic and local.
 */

/** How bright the stage runs for each presence state. */
const ACTIVITY: Record<PresenceState, number> = {
  idle: 0.12,
  listening: 0.55,
  thinking: 0.5,
  working: 0.8,
  'needs-user': 0.62,
  locked: 0.05,
  error: 0.45,
}

export function Presence({ ringCanvas }: { ringCanvas: RefObject<HTMLCanvasElement | null> }) {
  const state = useShell((s) => s.presence.state)
  const listening = useShell((s) => s.listening)
  const [handle, setHandle] = useState<PresenceHandle | null>(null)
  const [labels, setLabels] = useState<[string, string][]>([])

  // Turning the microphone on means "you are speaking", locally. Turning it off
  // hands the turn to Freya, exactly as a real push-to-talk would.
  useEffect(() => {
    if (listening) voiceEnvelope.simulateUser()
    else if (voiceEnvelope.active) voiceEnvelope.simulateReply()
  }, [listening])

  const activity = useRef(ACTIVITY.idle)
  activity.current = ACTIVITY[state]

  return (
    <div className="presence" data-state={state}>
      <PresenceView
        activity={activity.current}
        ringCanvas={ringCanvas}
        onLabels={setLabels}
        onReady={setHandle}
      />

      <div className="hud-labels" aria-hidden="true">
        <Hud className="hud-a" label={labels[0]?.[0] ?? 'Cognitive load'} value={labels[0]?.[1] ?? '—'} />
        <Hud className="hud-b" label={labels[1]?.[0] ?? 'State'} value={labels[1]?.[1] ?? '—'} />
        <Hud className="hud-c" label={labels[2]?.[0] ?? 'Inference spent'} value={labels[2]?.[1] ?? '0.00'} />
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        Freya is {PRESENCE_TONE[state].label.toLowerCase()}.
      </p>

      <div className="presence-controls">
        <DesignLab
          handle={handle}
          onSimulateUser={() => voiceEnvelope.simulateUser()}
          onSimulateReply={() => voiceEnvelope.simulateReply()}
        />
        <PresenceStates state={state} />
      </div>
    </div>
  )
}

function Hud({ className, label, value }: { className: string; label: string; value: string }) {
  return (
    <div className={`hud-label ${className}`}>
      <b>{label}</b>
      <span>{value}</span>
    </div>
  )
}

/**
 * The deterministic state control.
 *
 * Phase 0 has no model, so presence cannot be driven by cognition. A visible,
 * local control is the honest version: the states, the transitions and the
 * rendering are real, and what drives them is declared rather than faked.
 */
function PresenceStates({ state }: { state: PresenceState }) {
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
