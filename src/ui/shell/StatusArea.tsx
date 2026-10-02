import { useEffect, useState } from 'react'
import { PRESENCE_TONE } from '../../core/presence'
import { usePersonality } from '../../core/usePersonality'
import { projectionCueLine } from '../../presence/expressionCue'
import { useShell } from '../store'

const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
const day = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' })

export function StatusArea() {
  const [now, setNow] = useState(() => new Date())
  const presence = useShell((s) => s.presence.state)
  const runtime = useShell((s) => s.runtime)
  const personality = usePersonality()
  // The one expression cue Core offered this turn, or nothing. A held cue and
  // an absent domain both answer null, so this line never invents a gesture —
  // and its words come from a closed table this file does not write.
  const cue = projectionCueLine(personality)
  const tone = PRESENCE_TONE[presence]

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="status">
      <div className="status-clock">
        <b>{clock.format(now)}</b>
        <small>{day.format(now)}</small>
      </div>

      <div className="status-chip" style={{ color: tone.accent }} title="Presence state (demo)">
        <span className="status-dot" style={{ background: tone.accent, color: tone.accent }} />
        {tone.label}
      </div>

      {cue === null ? null : (
        <span className="status-cue" title="Expression cue offered by Core">
          {cue}
        </span>
      )}

      <span className="sr-only">
        Freya {runtime.version}, {runtime.platform}
      </span>
    </div>
  )
}
