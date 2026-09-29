import { useEffect, useRef, useState } from 'react'
import { useShell } from './store'
import { startShell } from './boot'
import { CommandBar } from './shell/CommandBar'
import { StatusArea } from './shell/StatusArea'
import { Navigation } from './shell/Navigation'
import { SurfaceDock } from './shell/SurfaceDock'
import {
  ActivityPanel,
  AttentionPanel,
  FocusPanel,
  RuntimePanel,
  WorkforcePanel,
  WorkPanel,
} from './dashboard/Panels'
import { Presence } from '../presence/Presence'
import { SurfaceLayer } from './surfaces/SurfaceLayer'
import { toggleSurface } from './surfaceActions'
import { FreyaMark } from './icons'
import { loadLabState, onLabChange } from '../presence/labState'

export function App() {
  const [ready, setReady] = useState(false)
  const ringCanvas = useRef<HTMLCanvasElement | null>(null)
  const [background, setBackground] = useState(() => loadLabState().bg)

  useEffect(() => onLabChange((lab) => setBackground(lab.bg)), [])
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    startShell()
      .then(() => {
        if (!cancelled) setReady(true)
      })
      .catch((error: unknown) => {
        if (!cancelled) setFailure(error instanceof Error ? error.message : String(error))
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (failure) {
    return (
      <div className="boot-error" role="alert">
        <h1>Freya could not start</h1>
        <p>{failure}</p>
      </div>
    )
  }

  return (
    <div className="app" data-ready={ready}>
      <canvas ref={ringCanvas} className="presence-rings" aria-hidden="true" />
      <div className="atmosphere" data-bg={background} aria-hidden="true" />
      <div className="atmosphere-veil" aria-hidden="true" />

      <div className="shell">
        <header className="header">
          <div className="brand">
            <FreyaMark size={44} id="brand-mark" />
            <div>
              <b>FREYA</b>
              <small>Personal intelligence</small>
            </div>
          </div>
          <CommandBar />
          <StatusArea />
        </header>

        <Navigation />

        <div className="column column-left">
          <FocusPanel />
          <WorkPanel />
          <AttentionPanel />
        </div>

        <main className="column column-center">
          <Presence ringCanvas={ringCanvas} />
          <SurfaceDock onToggle={toggleSurface} />
        </main>

        <div className="column column-right">
          <RuntimePanel />
          <WorkforcePanel />
          <ActivityPanel />
        </div>
      </div>

      <SurfaceLayer />
      <NoticeStack />
    </div>
  )
}

function NoticeStack() {
  const notices = useShell((s) => s.notices)
  if (notices.length === 0) return null
  return (
    <div className="notice-stack" role="status" aria-live="polite">
      {notices.map((notice) => (
        <div key={notice.id} className="notice" data-tone={notice.tone}>
          {notice.text}
        </div>
      ))}
    </div>
  )
}
