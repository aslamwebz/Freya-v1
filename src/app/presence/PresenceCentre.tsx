import { useEffect, useRef, useState } from 'react'
import type { PresenceStage } from '../../presence/stage/PresenceStage'
import type { Piece } from '../../presence/labState'
import type { Centre, CentreStyle } from '../dressing/store'

/**
 * Freya's centre.
 *
 * A thin host over the presence stage: the legacy three.js centrepieces (brain,
 * orb, reactor, tesseract, galaxy) with their instrument furniture and bloom,
 * recoloured from the old gold to this app's cyan + violet. It is the one
 * constant of every screen and the dressing table's Centre/Style/Rings controls
 * drive it through `applyLab`.
 *
 * "Freya" is one of the designs: the portrait is drawn by the screen around the
 * stage, while the stage shows the orb that frames her.
 */

const STYLE_MAP: Record<CentreStyle, 'current' | 'slices' | 'flow'> = {
  lattice: 'current',
  slices: 'slices',
  flow: 'flow',
}

const PIECE_MAP: Record<Centre, Piece> = {
  freya: 'orb',
  brain: 'brain',
  orb: 'orb',
  reactor: 'reactor',
  tesseract: 'tesseract',
  galaxy: 'galaxy',
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false)
  useEffect(() => {
    if (!window.matchMedia) return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return reduced
}

interface Props {
  centre: Centre
  style: CentreStyle
  rings: boolean
  state?: string
}

export function PresenceCentre({ centre, style, rings, state }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<PresenceStage | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const reduced = useReducedMotion()

  // Latest lab choices, read by the async boot so the first frame is correct.
  const labRef = useRef({ centre, style, rings })
  labRef.current = { centre, style, rings }

  useEffect(() => {
    let disposed = false
    let cleanup: (() => void) | null = null

    const boot = async () => {
      try {
        const { PresenceStage: Stage } = await import('../../presence/stage/PresenceStage')
        const canvas = canvasRef.current
        const host = hostRef.current
        if (disposed || !canvas || !host) return

        const stage = new Stage({ canvas, reducedMotion: reduced, onLabels: () => undefined })
        stageRef.current = stage

        const sync = () => {
          const rect = host.getBoundingClientRect()
          stage.resize(Math.max(1, Math.round(rect.width)), Math.max(1, Math.round(rect.height)))
        }
        sync()
        stage.start()
        if (reduced) stage.renderOnce()

        const apply = () => {
          const { centre: c, style: s, rings: r } = labRef.current
          stage.applyLab({ bg: 'space', piece: PIECE_MAP[c], style: STYLE_MAP[s], rings: r ? '1' : '0' })
        }
        apply()

        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync)
        observer?.observe(host)

        cleanup = () => {
          observer?.disconnect()
          stage.dispose()
          stageRef.current = null
        }
      } catch (error) {
        setFailure(error instanceof Error ? error.message : String(error))
      }
    }

    void boot()
    return () => {
      disposed = true
      cleanup?.()
      cleanup = null
    }
  }, [reduced])

  useEffect(() => {
    stageRef.current?.applyLab({ bg: 'space', piece: PIECE_MAP[centre], style: STYLE_MAP[style], rings: rings ? '1' : '0' })
  }, [centre, style, rings])

  return (
    <div className="a-brain" ref={hostRef}>
      <canvas ref={canvasRef} className="a-centre-canvas" role="img" aria-label={`Freya centre: ${centre}${state ? ` (${state})` : ''}`} />
      {failure !== null ? (
        <p className="a-brain-fallback" role="status">
          The centre could not start on this machine ({failure}). The rest of Freya is unaffected.
        </p>
      ) : null}
    </div>
  )
}
