import { useEffect, useRef, useState, type RefObject } from 'react'
import type { LabState } from './labState'
import { voiceEnvelope } from './voiceEnvelope'
import type { PresenceStage } from './stage/PresenceStage'
import type { RingLayer } from './stage/RingLayer'

/**
 * The presence view.
 *
 * It owns the two WebGL contexts — the stage in the centre column and the
 * full-window background rings — and nothing else. The stage's clock drives
 * both, so there is exactly one animation loop in Freya.
 *
 * Both modules are imported lazily: three.js is a large chunk and a shell that
 * never reaches the presence should not pay for it.
 */

export interface PresenceHandle {
  applyLab(lab: LabState): void
  resize(): void
}

interface Props {
  activity: number
  ringCanvas: RefObject<HTMLCanvasElement | null>
  onLabels: (labels: [string, string][]) => void
  onReady: (handle: PresenceHandle | null) => void
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

export function PresenceView({ activity, ringCanvas, onLabels, onReady }: Props) {
  const stageCanvas = useRef<HTMLCanvasElement | null>(null)
  const host = useRef<HTMLDivElement | null>(null)

  // Held in refs so a presence-state change never re-creates the WebGL context.
  const activityRef = useRef(activity)
  const labelsRef = useRef(onLabels)
  const readyRef = useRef(onReady)
  activityRef.current = activity
  labelsRef.current = onLabels
  readyRef.current = onReady

  const [failure, setFailure] = useState<string | null>(null)
  const reducedMotion = useReducedMotion()

  useEffect(() => {
    let disposed = false
    const cleanup: { current: (() => void) | null } = { current: null }

    const boot = async () => {
      const [{ PresenceStage: Stage }, { RingLayer: Rings }] = await Promise.all([
        import('./stage/PresenceStage'),
        import('./stage/RingLayer'),
      ])
      const canvas = stageCanvas.current
      const ring = ringCanvas.current
      const element = host.current
      if (disposed || !canvas || !ring || !element) return

      let stage: PresenceStage | null = null
      let rings: RingLayer | null = null

      try {
        stage = new Stage({
          canvas,
          reducedMotion: reducedMotion,
          onLabels: (labels) => labelsRef.current(labels),
          voice: () => voiceEnvelope.sample(),
          onFrame: (time, delta) => {
            if (!rings) return
            const voice = voiceEnvelope.sample()
            rings.update(time, delta, voice.user, voice.ai, voice.morph)
            rings.render()
          },
        })
        rings = new Rings(ring, Math.min(window.devicePixelRatio || 1, 1.5))

        const sync = () => {
          const rect = element.getBoundingClientRect()
          stage?.resize(rect.width, rect.height)
          rings?.resize()
          if (stage && rings) {
            const centre = stage.centreOnScreen(rect)
            rings.setCentre(centre.x, centre.y, centre.pixelsPerUnit)
          }
        }
        const paint = () => {
          stage?.setActivity(activityRef.current)
          stage?.renderOnce()
        }

        sync()
        stage.start()
        if (reducedMotion) paint()

        readyRef.current({
          applyLab: (lab) => stage?.applyLab(lab),
          resize: sync,
        })

        const onResize = () => {
          sync()
          if (reducedMotion) paint()
        }
        const onVisibility = () => {
          const hidden = document.hidden
          stage?.setVisible(!hidden)
          rings?.setVisible(!hidden)
        }
        window.addEventListener('resize', onResize)
        document.addEventListener('visibilitychange', onVisibility)

        cleanup.current = () => {
          window.removeEventListener('resize', onResize)
          document.removeEventListener('visibilitychange', onVisibility)
          stage?.dispose()
          rings?.dispose()
        }
      } catch (error) {
        setFailure(error instanceof Error ? (error.stack ?? error.message) : String(error))
      }
    }

    void boot()

    return () => {
      disposed = true
      cleanup.current?.()
      cleanup.current = null
      readyRef.current(null)
    }
  }, [reducedMotion, ringCanvas])

  return (
    <div className="presence-stage" ref={host}>
      <canvas ref={stageCanvas} className="presence-canvas" aria-hidden="true" />
      {failure ? (
        <p className="presence-fallback" role="status">
          The presence could not start: {failure}. This machine did not give Freya a WebGL context, so
          the intelligence is shown as a still frame. The rest of the shell is unaffected.
        </p>
      ) : null}
    </div>
  )
}
