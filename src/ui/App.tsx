import { useEffect, useState } from 'react'
import { useShell } from './store'
import { startShell } from './boot'
import { CommandBar } from './shell/CommandBar'
import { Navigation } from './shell/Navigation'
import { TopBar } from './shell/TopBar'
import {
  ActivityPanel,
  AttentionPanel,
  FocusPanel,
  RuntimePanel,
  SystemPanel,
  WorkPanel,
} from './dashboard/Panels'
import { PresenceStatesConnected } from './dashboard/PresenceStates'
import { LiveOrb } from '../app/presence/LiveOrb'
import { ChatBar } from './shell/ChatBar'
import { SurfaceLayer } from './surfaces/SurfaceLayer'
import { toggleSurface } from './surfaceActions'
import { FreyaMark } from './icons'

export function App() {
  const [ready, setReady] = useState(false)
  // Hydrated at runtime, before the first paint of the workspace. Until the
  // runtime says otherwise the shell assumes a shipped build, so the development
  // controls cannot flash on screen in a production window.
  const dev = useShell((state) => state.runtime.dev)
  const background = 'space'
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
      <div className="atmosphere" data-bg={background} aria-hidden="true" />
      <div className="atmosphere-veil" aria-hidden="true" />

      <div className="presence-overlay">
        <LiveOrb state="calm" energy={0} />
      </div>

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
          <TopBar />
        </header>

        <Navigation />

        <div className="column column-left">
          <FocusPanel />
          <WorkPanel />
        </div>

        <main className="column column-center">
          {/* Presentation controls, at the top: how Freya is drawn is a
              top-of-workspace concern, not something buried under the canvas. */}
          {/* Development-only. The Design Lab and the presence chips can put
              Freya into any state without Core having done anything, so they are
              not rendered in a shipped window at all. The store refuses the
              matching event outside development too — this is the second of two
              locks, not the only one. */}
          {dev ? (
            <div className="center-top" data-dev-tools="true">
              <PresenceStatesConnected />
            </div>
          ) : null}

        </main>

        <div className="column column-right">
          <SystemPanel />
          <AttentionPanel />
          <ActivityPanel />
          <RuntimePanel />
        </div>

        {/* The chat bar is a row of its own across the whole workspace, not a
            strip wedged into the middle column. It needs the width: a surface
            switcher and a transcript and an input do not fit in 412px. */}
        <ChatBar onToggle={toggleSurface} />
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
