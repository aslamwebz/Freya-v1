import { useState } from 'react'
import { Glyph } from '../../ui-v2/primitives/Glyph'

/** The thinking levels the composer offers. */
export const THINK = ['None', 'Think', 'Deep', 'Fast'] as const

/**
 * The thinking-level picker, self-contained so its open/closed state never
 * re-renders the board.
 */
export function ThinkingSelector() {
  const [open, setOpen] = useState(false)
  const [level, setLevel] = useState<typeof THINK[number]>('Think')

  return (
    <div className="hd-select">
      <button type="button" className="hd-tool hd-tool-think" aria-label="Thinking level" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <Glyph name="mind" size={18} /><span>{level}</span><Glyph name="chevron" size={13} />
      </button>
      {open && <ul className="hd-menu" role="listbox" aria-label="Thinking level">
        {THINK.map(entry => <li key={entry}><button type="button" role="option" aria-selected={entry === level} onClick={() => { setLevel(entry); setOpen(false) }}>{entry}</button></li>)}
      </ul>}
    </div>
  )
}
