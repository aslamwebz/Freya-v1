/**
 * Design lab state.
 *
 * The lab is a *presentation* control surface, not product state: it chooses how
 * the presence is drawn, not what Freya is doing. It is kept here, separate from
 * the shell store, and persisted separately.
 *
 * Defaults are the ones Freya ships with: the liquid orb on deep space, outer
 * rings on.
 *
 * There is an "extras" toggle no longer. It used to hide the beam furniture
 * around the centrepiece, and with the pedestal and the beam gone it would have
 * been a control that changed nothing — worse than no control, because it looks
 * like it is doing something.
 */

export const BACKGROUNDS = ['city', 'space', 'grid', 'aurora', 'obsidian'] as const
export type Background = (typeof BACKGROUNDS)[number]

export const PIECES = ['brain', 'reactor', 'orb', 'tesseract', 'galaxy'] as const
export type Piece = (typeof PIECES)[number]

export const BRAIN_STYLES = ['current', 'slices', 'flow', 'glass'] as const
export type BrainStyle = (typeof BRAIN_STYLES)[number]

export const CLEAN_MODES = ['0', '1'] as const

export const LAB_OPTIONS = {
  bg: BACKGROUNDS,
  piece: PIECES,
  style: BRAIN_STYLES,
  rings: CLEAN_MODES,
} as const

export interface LabState {
  bg: Background
  piece: Piece
  style: BrainStyle
  rings: '0' | '1'
}

export const DEFAULT_LAB: LabState = {
  bg: 'space',
  piece: 'orb',
  style: 'current',
  rings: '1',
}

const STORAGE_PREFIX = 'freya.lab.'

export function loadLabState(): LabState {
  try {
    const stored = window.localStorage
    const read = <K extends keyof LabState>(key: K): LabState[K] => {
      const value = stored.getItem(STORAGE_PREFIX + key)
      const allowed: readonly string[] = LAB_OPTIONS[key]
      return allowed.includes(String(value)) ? (value as LabState[K]) : DEFAULT_LAB[key]
    }
    return {
      bg: read('bg'),
      piece: read('piece'),
      style: read('style'),
      rings: read('rings'),
    }
  } catch {
    return { ...DEFAULT_LAB }
  }
}

export function saveLabState(state: LabState): void {
  try {
    for (const [key, value] of Object.entries(state)) {
      window.localStorage.setItem(STORAGE_PREFIX + key, value)
    }
  } catch {
    /* storage unavailable — the lab simply will not remember its choices */
  }
}


export function cycleLab<K extends keyof LabState>(state: LabState, key: K): LabState {
  const options: readonly LabState[K][] = LAB_OPTIONS[key] as unknown as readonly LabState[K][]
  const index = options.indexOf(state[key])
  return { ...state, [key]: options[(index + 1) % options.length] ?? options[0] }
}

/**
 * A one-line observer so the shell can react to a background change without the
 * design lab having to know that the shell exists.
 */
type LabListener = (state: LabState) => void
const listeners = new Set<LabListener>()

export function onLabChange(listener: LabListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function publishLab(state: LabState): void {
  for (const listener of listeners) listener(state)
}
