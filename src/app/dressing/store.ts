/**
 * The dressing table — Freya's wardrobe.
 *
 * A presentation store, not product state: it chooses how the centre, the shell
 * and Freya's form are drawn, never what Freya is doing. It is kept separate from
 * the shell and persisted on its own, in the same spirit as the appearance
 * preferences.
 */

export const CENTRES = ['brain', 'orb', 'reactor', 'tesseract', 'galaxy'] as const
export type Centre = (typeof CENTRES)[number]

export const CENTRE_STYLES = ['lattice', 'slices', 'flow'] as const
export type CentreStyle = (typeof CENTRE_STYLES)[number]

export const BACKGROUNDS = ['obsidian', 'space', 'city', 'aurora', 'grid'] as const
export type Background = (typeof BACKGROUNDS)[number]

export const RINGS = ['on', 'off'] as const
export type Rings = (typeof RINGS)[number]

export const FORMS = ['brain', 'chibi', 'adult'] as const
export type Form = (typeof FORMS)[number]

export interface DressingState {
  readonly centre: Centre
  readonly style: CentreStyle
  readonly background: Background
  readonly rings: Rings
  readonly form: Form
}

export const DEFAULT_DRESSING: DressingState = Object.freeze({
  centre: 'brain',
  style: 'lattice',
  background: 'city',
  rings: 'on',
  form: 'brain',
})

export const DRESSING_KEY = 'freya.dressing.v1'

export interface DressingStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function parseDressing(input: unknown): DressingState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return DEFAULT_DRESSING
  const value = input as Record<string, unknown>
  const pick = <T extends string>(allowed: readonly T[], candidate: unknown, fallback: T): T =>
    allowed.includes(candidate as T) ? (candidate as T) : fallback
  return Object.freeze({
    centre: pick(CENTRES, value.centre, DEFAULT_DRESSING.centre),
    style: pick(CENTRE_STYLES, value.style, DEFAULT_DRESSING.style),
    background: pick(BACKGROUNDS, value.background, DEFAULT_DRESSING.background),
    rings: pick(RINGS, value.rings, DEFAULT_DRESSING.rings),
    form: pick(FORMS, value.form, DEFAULT_DRESSING.form),
  })
}

export class DressingStore {
  private state: DressingState = DEFAULT_DRESSING
  private readonly listeners = new Set<() => void>()
  constructor(private readonly storage?: DressingStorage) {
    try {
      const saved = storage?.getItem(DRESSING_KEY)
      if (saved) this.state = parseDressing(JSON.parse(saved))
    } catch {
      /* invalid or unavailable storage uses defaults */
    }
  }
  getSnapshot = (): DressingState => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  update(patch: Partial<DressingState>): void {
    const next = parseDressing({ ...this.state, ...patch })
    if (JSON.stringify(next) === JSON.stringify(this.state)) return
    this.state = next
    try {
      this.storage?.setItem(DRESSING_KEY, JSON.stringify(next))
    } catch {
      /* in-memory choices still work */
    }
    for (const listener of this.listeners) listener()
  }
  reset(): void {
    this.update(DEFAULT_DRESSING)
  }
}
