import { useEffect, useState } from 'react'
import { PRESENCE_TONE } from '../../core/presence'
import { useShell } from '../store'
import { openSurface } from '../surfaceActions'
import { Icon } from '../icons'

const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
const day = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' })

export function StatusArea() {
  const [now, setNow] = useState(() => new Date())
  const presence = useShell((s) => s.presence.state)
  const runtime = useShell((s) => s.runtime)
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

      <span className="status-sep" aria-hidden="true" />

      <button
        type="button"
        className="round"
        aria-label="Security"
        title="Security"
        onClick={() => openSurface('security')}
      >
        <Icon name="shield" />
      </button>
      <button
        type="button"
        className="round"
        aria-label="Settings"
        title="Settings"
        onClick={() => openSurface('settings')}
      >
        <Icon name="settings" />
      </button>

      <span className="sr-only">
        Freya {runtime.version}, {runtime.platform}
      </span>
    </div>
  )
}
