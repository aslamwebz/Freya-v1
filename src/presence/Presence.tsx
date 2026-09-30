import { useEffect, useRef, useState, type RefObject } from 'react'
import { PRESENCE_TONE, type PresenceState } from '../core/presence'
import { useShell } from '../ui/store'
import { PresenceView, type PresenceHandle } from './PresenceView'
import { voiceEnvelope } from './voiceEnvelope'

/**
 * The presence: Freya's visible state.
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

/**
 * The centrepiece, and nothing else.
 *
 * The design lab and the presence controls used to live in here, which tied them
 * to the width of this column. The lab is now a large fixed panel and the
 * controls sit at the top of the workspace, so this renders the canvas and its
 * readouts and nothing that wants to be somewhere else.
 */
export function Presence({
  ringCanvas,
  onReady,
}: {
  ringCanvas: RefObject<HTMLCanvasElement | null>
  /** The stage handle, lifted so the lab can drive it from the top of the page. */
  onReady: (handle: PresenceHandle | null) => void
}) {
  const state = useShell((s) => s.presence.state)
  const listening = useShell((s) => s.listening)
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
        activity={activity.current ?? ACTIVITY.idle}
        ringCanvas={ringCanvas}
        onLabels={setLabels}
        onReady={onReady}
      />

      <div className="hud-labels" aria-hidden="true">
        <Hud className="hud-a" label={labels[0]?.[0] ?? 'Cognitive load'} value={labels[0]?.[1] ?? '—'} />
        <Hud className="hud-b" label={labels[1]?.[0] ?? 'State'} value={labels[1]?.[1] ?? '—'} />
        <Hud className="hud-c" label={labels[2]?.[0] ?? 'Inference spent'} value={labels[2]?.[1] ?? '0.00'} />
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        Freya is {PRESENCE_TONE[state].label.toLowerCase()}.
      </p>
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
