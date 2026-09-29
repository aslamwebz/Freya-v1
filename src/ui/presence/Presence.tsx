import { useEffect, useRef, useState } from 'react'
import { PRESENCE_STATES, PRESENCE_TONE, type PresenceState } from '../../core/presence'
import { useShell, shellStore } from '../store'
import { FreyaMark } from '../icons'
import { PresenceRenderer } from './renderer'

const READOUTS: { label: string; value: (elapsed: number) => string }[] = [
  { label: 'Cognitive load', value: (t) => `${Math.round(clamp(6 + Math.sin(t * 0.7) * 4, 0, 99))}%` },
  { label: 'State', value: () => '—' },
  { label: 'Inference spent', value: () => '0.00' },
]

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })
  useEffect(() => {
    if (!window.matchMedia) return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return reduced
}

export function Presence() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rendererRef = useRef<PresenceRenderer | null>(null)
  const state = useShell((s) => s.presence.state)
  const [readoutTick, setReadoutTick] = useState(0)
  const reduced = useReducedMotion()

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const renderer = new PresenceRenderer(canvas, { reducedMotion: reduced })
    rendererRef.current = renderer
    renderer.setState(shellStore.getState().presence.state)
    renderer.start()

    const onResize = () => renderer.resize()
    const onVisibility = () => renderer.setVisible(!document.hidden)
    window.addEventListener('resize', onResize)
    document.addEventListener('visibilitychange', onVisibility)
    if (reduced) renderer.stop()

    return () => {
      window.removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVisibility)
      renderer.dispose()
      rendererRef.current = null
    }
  }, [reduced])

  useEffect(() => {
    rendererRef.current?.setState(state)
  }, [state])

  // Telemetry text refreshes off the render loop; the canvas does not re-render.
  useEffect(() => {
    if (reduced) return
    const id = setInterval(() => setReadoutTick((n) => n + 1), 900)
    return () => clearInterval(id)
  }, [reduced])

  const elapsed = (Date.now() - useShell((s) => s.presence.since)) / 1000
  void readoutTick

  return (
    <div className="presence" data-state={state}>
      <canvas ref={canvasRef} className="presence-canvas" aria-hidden="true" />
      <div className="presence-mark">
        <FreyaMark size={54} id="presence-mark" />
      </div>

      <div className="hud-labels" aria-hidden="true">
        <HudLabel
          label="Cognitive load"
          value={READOUTS[0]?.value(elapsed) ?? '—'}
          className="hud-a"
        />
        <HudLabel label="State" value={PRESENCE_TONE[state].label} className="hud-b" />
        <HudLabel label="Inference spent" value="0.00" className="hud-c" />
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        Freya is {PRESENCE_TONE[state].label.toLowerCase()}.
      </p>

      <PresenceControls state={state} />
    </div>
  )
}

function HudLabel({ label, value, className }: { label: string; value: string; className: string }) {
  return (
    <div className={`hud-label ${className}`}>
      <b>{label}</b>
      <span>{value}</span>
    </div>
  )
}

function PresenceControls({ state }: { state: PresenceState }) {
  const tone = PRESENCE_TONE[state]
  return (
    <div className="presence-console">
      <div className="presence-console-head">
        <span className="demo-tag">Demo</span>
        <span className="presence-console-title">Presence state</span>
        <span className="presence-console-state" style={{ color: tone.accent }}>
          {tone.label}
        </span>
      </div>
      <div className="presence-console-body" role="group" aria-label="Demo presence state">
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
      <p className="presence-console-note">
        Local demo control. No model is called, and no inference is consumed.
      </p>
    </div>
  )
}
