import { useEffect, useRef, useState } from 'react'
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
import { Presence } from '../presence/Presence'
import { DesignLab } from '../presence/DesignLab'
import { PresenceStatesConnected } from './dashboard/PresenceStates'
import { voiceEnvelope } from '../presence/voiceEnvelope'
import type { PresenceHandle } from '../presence/PresenceView'
import { ChatBar } from './shell/ChatBar'
import { SurfaceLayer } from './surfaces/SurfaceLayer'
import { toggleSurface } from './surfaceActions'
import { FreyaMark } from './icons'
import { loadLabState, onLabChange } from '../presence/labState'

export function App() {
  const [ready, setReady] = useState(false)
  // Hydrated at runtime, before the first paint of the workspace. Until the
  // runtime says otherwise the shell assumes a shipped build, so the development
  // controls cannot flash on screen in a production window.
  const dev = useShell((state) => state.runtime.dev)
  const ringCanvas = useRef<HTMLCanvasElement | null>(null)
  const [background, setBackground] = useState(() => loadLabState().bg)

  useEffect(() => onLabChange((lab) => setBackground(lab.bg)), [])
  const [failure, setFailure] = useState<string | null>(null)
  // The stage handle, lifted: the design lab now lives at the top of the
  // workspace and still has to be able to drive the presence.
  const [presenceHandle, setPresenceHandle] = useState<PresenceHandle | null>(null)

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
              <DesignLab
                handle={presenceHandle}
                onSimulateUser={() => voiceEnvelope.simulateUser()}
                onSimulateReply={() => voiceEnvelope.simulateReply()}
              />
              <PresenceStatesConnected />
            </div>
          ) : null}

          <Presence ringCanvas={ringCanvas} onReady={setPresenceHandle} />
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
