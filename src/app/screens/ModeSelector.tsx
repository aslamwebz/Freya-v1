import { useState } from 'react'
import { Glyph } from '../../ui-v2/primitives/Glyph'
import { COMPOSER_MODES, type ComposerMode } from '../chat/modes'

export function ModeSelector({ mode, onChange }: {
  mode: ComposerMode
  onChange: (mode: ComposerMode) => void
}) {
  const [open, setOpen] = useState(false)
  const current = COMPOSER_MODES.find((item) => item.id === mode) ?? COMPOSER_MODES[0]!

  return (
    <div className="hd-select hd-mode-select">
      <button
        type="button"
        className="hd-tool hd-tool-mode"
        aria-haspopup="menu"
        aria-expanded={open}
        title={current.description}
        onClick={() => setOpen((value) => !value)}
      >
        <Glyph name={current.icon} size={14} />
        <span>{current.shortLabel}</span>
        <Glyph name="arrow" size={11} />
      </button>
      {open ? (
        <ul className="hd-menu hd-menu-mode" role="menu" aria-label="Freya mode">
          {COMPOSER_MODES.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={item.id === mode}
                onClick={() => {
                  onChange(item.id)
                  setOpen(false)
                }}
              >
                <span className="hd-mode-row-icon"><Glyph name={item.icon} size={16} /></span>
                <span><b>{item.label}</b><small>{item.description}</small></span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
