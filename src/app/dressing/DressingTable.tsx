import { useState, useSyncExternalStore } from 'react'
import {
  BACKGROUNDS,
  CENTRES,
  CENTRE_STYLES,
  FORMS,
  RINGS,
  type DressingStore,
} from './store'

/**
 * The dressing table.
 *
 * Single-user: no dev gate, no "presentation only" hedge. It swaps the centre
 * design, the shell's skin, and Freya's form. Every change applies immediately
 * and is remembered on this machine.
 */

const LABELS: Record<string, string> = {
  brain: 'Brain', orb: 'Orb', reactor: 'Reactor', tesseract: 'Tesseract', galaxy: 'Galaxy',
  lattice: 'Lattice', slices: 'Slices', flow: 'Flow',
  obsidian: 'Obsidian', space: 'Deep space', city: 'City', aurora: 'Aurora', grid: 'Grid',
  on: 'On', off: 'Off', chibi: 'Chibi', adult: 'Adult',
}

function Group({ label, options, value, onPick }: { label: string; options: readonly string[]; value: string; onPick: (value: string) => void }) {
  return (
    <div className="d-row">
      <span>{label}</span>
      <div className="d-opts">
        {options.map((option) => (
          <button key={option} type="button" className="d-opt" aria-pressed={value === option} onClick={() => onPick(option)}>
            {LABELS[option] ?? option}
          </button>
        ))}
      </div>
    </div>
  )
}

export function DressingTable({ store }: { store: DressingStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [open, setOpen] = useState(false)
  return (
    <div className="d-lab">
      <button type="button" className="d-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="d-dot" aria-hidden="true" />Dressing table
      </button>
      {open ? (
        <div className="d-scrim" onClick={() => setOpen(false)}>
          <div className="d-panel" role="dialog" aria-label="Dressing table" onClick={(event) => event.stopPropagation()}>
            <header className="d-head"><b>Dressing table</b><button type="button" className="d-close" aria-label="Close the dressing table" onClick={() => setOpen(false)}>Close</button></header>
            <p className="d-note">How Freya looks, never what she does. Stored on this machine.</p>

            <h3>Centre</h3>
            <Group label="Design" options={CENTRES} value={state.centre} onPick={(value) => store.update({ centre: value as typeof state.centre })} />
            <Group label="Style" options={CENTRE_STYLES} value={state.style} onPick={(value) => store.update({ style: value as typeof state.style })} />

            <h3>App</h3>
            <Group label="Background" options={BACKGROUNDS} value={state.background} onPick={(value) => store.update({ background: value as typeof state.background })} />
            <Group label="Outer rings" options={RINGS} value={state.rings} onPick={(value) => store.update({ rings: value as typeof state.rings })} />

            <h3>Freya</h3>
            <Group label="Form" options={FORMS} value={state.form} onPick={(value) => store.update({ form: value as typeof state.form })} />

            <footer className="d-foot"><button type="button" className="d-opt" onClick={() => store.reset()}>Reset</button></footer>
          </div>
        </div>
      ) : null}
    </div>
  )
}
