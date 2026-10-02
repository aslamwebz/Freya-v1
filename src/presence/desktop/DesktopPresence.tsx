import { useEffect, useRef, useState } from 'react'
import type { PresenceFrame } from '../../../core/presence/protocol'
import { PresenceStage, type PresenceStageInterface } from './PresenceStage'

/**
 * The desktop presence component.
 *
 * The entire UI of the presence window. It subscribes to presence frames from
 * the host and draws them. It holds no Core state, makes no model calls, and
 * decides nothing.
 *
 * ## What it shows
 *
 * - The presence orb (Three.js stage).
 * - A small status line (the frame's detail).
 * - A bounded cue card when Core chose to cue.
 * - A voice indicator when a capture or synthesis is active.
 *
 * ## What it does not show
 *
 * - No command bar.
 * - No conversation.
 * - No work board.
 * - No security controls.
 * - No way to submit commands or read Core state.
 *
 * The presence window is a presentation layer only. A renderer compromise
 * gets an attacker exactly what this window shows: a state, an animation,
 * and a bounded cue.
 */

export function DesktopPresence() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const stageRef = useRef<PresenceStageInterface | null>(null)
  const [frame, setFrame] = useState<PresenceFrame | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false

    const boot = async () => {
      const canvas = canvasRef.current
      if (disposed || !canvas) return

      try {
        const stage = new PresenceStage({
          canvas,
          onReady: () => {
            stageRef.current = stage
          },
        })
        stageRef.current = stage
      } catch (error) {
        setFailure(error instanceof Error ? (error.stack ?? error.message) : String(error))
      }
    }

    void boot()

    // Subscribe to presence frames from the host.
    const bridge = (window as unknown as {
      freyaPresence?: {
        onPresenceFrame: (handler: (frame: PresenceFrame) => void) => () => void
        toggleInteraction: () => void
        forceClickThrough: () => void
      }
    }).freyaPresence

    let unsubscribe: (() => void) | null = null
    if (bridge) {
      unsubscribe = bridge.onPresenceFrame((newFrame) => {
        setFrame(newFrame)
        stageRef.current?.renderFrame(newFrame)
      })
    }

    // Handle resize.
    const onResize = () => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      stageRef.current?.resize(Math.round(rect.width), Math.round(rect.height))
    }
    window.addEventListener('resize', onResize)

    // Handle click-through toggle on click.
    const onClick = () => {
      bridge?.toggleInteraction()
    }
    window.addEventListener('click', onClick)

    // Handle Escape to force click-through.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        bridge?.forceClickThrough()
      }
    }
    window.addEventListener('keydown', onKeyDown)

    return () => {
      disposed = true
      unsubscribe?.()
      window.removeEventListener('resize', onResize)
      window.removeEventListener('click', onClick)
      window.removeEventListener('keydown', onKeyDown)
      stageRef.current?.dispose()
      stageRef.current = null
    }
  }, [])

  return (
    <div className="desktop-presence" data-state={frame?.state ?? 'idle'}>
      <canvas ref={canvasRef} className="desktop-presence-canvas" aria-hidden="true" />
      {failure ? (
        <p className="desktop-presence-fallback" role="status">
          The presence could not start: {failure}.
        </p>
      ) : null}
      {frame ? (
        <div className="desktop-presence-hud">
          <span className="desktop-presence-detail">{frame.detail}</span>
          {frame.voiceCapture.active ? (
            <span className="desktop-presence-voice" data-kind="capture">
              Listening
            </span>
          ) : null}
          {frame.voiceSynthesis.active ? (
            <span className="desktop-presence-voice" data-kind="synthesis">
              Speaking
            </span>
          ) : null}
          {frame.attention ? (
            <span className="desktop-presence-cue" data-kind="attention">
              {frame.attention.cueCode ?? 'Attention'}
            </span>
          ) : null}
          {frame.personalityCue ? (
            <span className="desktop-presence-cue" data-kind="personality">
              {frame.personalityCue.kind}
            </span>
          ) : null}
          {frame.work?.label ? (
            <span className="desktop-presence-work">{frame.work.label}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
