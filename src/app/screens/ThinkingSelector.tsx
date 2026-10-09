import { useEffect, useState } from 'react'
import { Glyph } from '../../ui-v2/primitives/Glyph'

export type ThinkingLevel = 'auto' | 'minimal' | 'low' | 'medium' | 'high'

export const THINKING_LEVEL_KEY = 'freya.thinkingLevel'

export interface ThinkingOption {
  readonly id: ThinkingLevel
  readonly label: string
  readonly shortLabel: string
  readonly description: string
}

export const THINKING_OPTIONS: readonly ThinkingOption[] = [
  { id: 'auto', label: 'Adaptive', shortLabel: 'Auto', description: 'Model adapts thinking automatically' },
  { id: 'minimal', label: 'Fast', shortLabel: 'Fast', description: 'Minimal thinking for quick, direct responses' },
  { id: 'low', label: 'Low', shortLabel: 'Low', description: 'Brief reasoning step before answering' },
  { id: 'medium', label: 'Balanced', shortLabel: 'Med', description: 'Balanced depth, verification, and speed' },
  { id: 'high', label: 'Deep', shortLabel: 'Deep', description: 'Extensive multi-step reasoning and deep analysis' },
]

export function readStoredThinkingLevel(): ThinkingLevel {
  if (typeof window === 'undefined') return 'auto'
  try {
    const raw = window.localStorage.getItem(THINKING_LEVEL_KEY)
    if (raw === 'minimal' || raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'auto') {
      return raw
    }
    return 'auto'
  } catch {
    return 'auto'
  }
}

export function writeStoredThinkingLevel(level: ThinkingLevel): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(THINKING_LEVEL_KEY, level)
  } catch {
    // optional storage
  }
}

export function ThinkingSelector({
  value,
  onChange,
}: {
  readonly value?: string | null
  readonly onChange?: (level: ThinkingLevel) => void
} = {}) {
  const [open, setOpen] = useState(false)
  const [currentLevel, setCurrentLevel] = useState<ThinkingLevel>(() => {
    if (value && (value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'auto')) {
      return value
    }
    return readStoredThinkingLevel()
  })

  useEffect(() => {
    if (value && (value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'auto')) {
      setCurrentLevel(value)
    }
  }, [value])

  const selectedOption = THINKING_OPTIONS.find((opt) => opt.id === currentLevel) ?? THINKING_OPTIONS[0]!

  const handleSelect = (id: ThinkingLevel) => {
    setCurrentLevel(id)
    writeStoredThinkingLevel(id)
    onChange?.(id)
    setOpen(false)
  }

  return (
    <div className="hd-select hd-thinking-select">
      <button
        type="button"
        className="hd-tool hd-tool-thinking"
        role="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Thinking level: ${selectedOption.label}`}
        title={`Thinking level: ${selectedOption.label} — ${selectedOption.description}`}
        onClick={() => setOpen((prev) => !prev)}
      >
        <Glyph name="mind" size={16} />
        <span>{selectedOption.shortLabel}</span>
      </button>
      {open ? (
        <ul className="hd-menu hd-menu-thinking" role="menu" aria-label="Thinking effort level">
          {THINKING_OPTIONS.map((opt) => (
            <li key={opt.id}>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={opt.id === currentLevel}
                onClick={() => handleSelect(opt.id)}
              >
                <span className="hd-thinking-menu-item">
                  <b>{opt.label}</b>
                  <small>{opt.description}</small>
                </span>
                {opt.id === currentLevel ? <span className="hd-menu-check" aria-hidden="true">✓</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
