import { useEffect, useState } from 'react'
import {
  BACKGROUNDS,
  BRAIN_STYLES,
  DEFAULT_LAB,
  LAB_OPTIONS,
  PIECES,
  cycleLab,
  loadLabState,
  publishLab,
  saveLabState,
  type Background,
  type BrainStyle,
  type LabState,
  type Piece,
} from './labState'
import type { PresenceHandle } from './PresenceView'

/**
 * The design lab.
 *
 * A presentation control surface for the presence: which centrepiece, which
 * background, which brain style, and whether the surrounding furniture is on.
 * It changes how Freya looks and never what she does — that is the shell
 * store's job.
 *
 * Keyboard: B background, P centrepiece, 1–4 brain style, C extras, R rings.
 */

const BACKGROUND_LABELS: Record<Background, string> = {
  city: 'City',
  space: 'Deep space',
  grid: 'Grid lab',
  aurora: 'Aurora',
  obsidian: 'Obsidian',
}

const PIECE_LABELS: Record<Piece, string> = {
  brain: 'Brain',
  reactor: 'Arc reactor',
  orb: 'Liquid orb',
  tesseract: 'Tesseract',
  galaxy: 'Galaxy',
}

const STYLE_LABELS: Record<BrainStyle, string> = {
  current: 'Current',
  slices: 'A · Slices',
  flow: 'B · Flow',
  glass: 'C · Glass',
}

export function DesignLab({
  handle,
  onSimulateUser,
  onSimulateReply,
}: {
  handle: PresenceHandle | null
  onSimulateUser: () => void
  onSimulateReply: () => void
}) {
  const [lab, setLab] = useState<LabState>(DEFAULT_LAB)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const restored = loadLabState()
    setLab(restored)
    handle?.applyLab(restored)
  }, [handle])

  const update = (next: LabState) => {
    setLab(next)
    saveLabState(next)
    publishLab(next)
    handle?.applyLab(next)
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 'escape') {
        setOpen(false)
        return
      }
      if (key === 'b') update(cycleLab(lab, 'bg'))
      else if (key === 'p') update(cycleLab(lab, 'piece'))
      else if (key === 'c') update(cycleLab(lab, 'clean'))
      else if (key === 'r') update(cycleLab(lab, 'rings'))
      else if (['1', '2', '3', '4'].includes(key)) {
        const style = BRAIN_STYLES[Number(key) - 1]
        if (style) update({ ...lab, style })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lab])

  const group = (key: keyof LabState, values: readonly string[], labels: Record<string, string>) => (
    <div className="lab-row" data-key={key}>
      <span>{LAB_LABELS[key]}</span>
      <div data-group={key}>
        {values.map((value) => (
          <button
            key={value}
            type="button"
            className="opt"
            aria-pressed={lab[key] === value}
            onClick={() => update({ ...lab, [key]: value } as LabState)}
          >
            {labels[value] ?? value}
          </button>
        ))}
      </div>
    </div>
  )

  return (
    <div className="lab">
      <button
        type="button"
        className="lab-toggle"
        aria-expanded={open}
        aria-controls="design-lab-panel"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="lab-dot" aria-hidden="true" />
        Design lab
      </button>

      <div className="lab-panel" id="design-lab-panel" hidden={!open}>
        <p className="lab-note">
          Presentation only. These choices change how Freya looks, never what she does, and they are
          stored locally on this machine.
        </p>

        {group('bg', BACKGROUNDS, BACKGROUND_LABELS)}
        {group('piece', PIECES, PIECE_LABELS)}

        <div className="lab-row" data-only="brain" hidden={lab.piece !== 'brain'}>
          <span>Brain style</span>
          <div data-group="style">
            {BRAIN_STYLES.map((style) => (
              <button
                key={style}
                type="button"
                className="opt"
                aria-pressed={lab.style === style}
                onClick={() => update({ ...lab, style })}
              >
                {STYLE_LABELS[style]}
              </button>
            ))}
          </div>
        </div>

        {group('clean', LAB_OPTIONS.clean, { '0': 'Full', '1': 'Clean' })}
        {group('rings', LAB_OPTIONS.rings, { '0': 'Off', '1': 'On' })}

        <div className="lab-row">
          <span>Test voice reaction</span>
          <div>
            <button type="button" className="opt" onClick={onSimulateUser}>
              You speak
            </button>
            <button type="button" className="opt" onClick={onSimulateReply}>
              Freya replies
            </button>
          </div>
        </div>

        <div className="lab-foot">
          <small>B background · P centrepiece · 1–4 style · C extras · R rings</small>
          <button
            type="button"
            className="opt"
            onClick={() => {
              const next: LabState = {
                bg: pick(BACKGROUNDS),
                piece: pick(PIECES),
                style: pick(BRAIN_STYLES),
                clean: '0',
                rings: '1',
              }
              update(next)
            }}
          >
            Shuffle
          </button>
        </div>
      </div>
    </div>
  )
}

const LAB_LABELS: Record<keyof LabState, string> = {
  bg: 'Background',
  piece: 'Centrepiece',
  style: 'Brain style',
  clean: 'Extras',
  rings: 'Outer rings',
}

function pick<T>(values: readonly T[]): T {
  return values[Math.floor(Math.random() * values.length)] as T
}
