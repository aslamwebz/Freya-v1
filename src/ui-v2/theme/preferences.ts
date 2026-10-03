import { THEMES, type ThemeId } from './tokens'
export { THEMES, type ThemeId }
export type Theme = ThemeId
export interface Preferences {
  readonly version: 1
  readonly theme: ThemeId
  readonly mode: 'app' | 'immersive'
  readonly density: 'comfortable' | 'compact'
  readonly textScale: 1 | 1.125 | 1.25
  readonly backdrop: 'cosmos' | 'quiet' | 'solid'
  readonly reducedEffects: boolean
  readonly homePanels: readonly string[]
}
export const PREFERENCES_KEY = 'freya.ui-v2.preferences.v1'
export const DEFAULT_PREFERENCES: Preferences = Object.freeze({
  version: 1, theme: 'abyss', mode: 'app', density: 'comfortable',
  textScale: 1, backdrop: 'cosmos', reducedEffects: false, homePanels: Object.freeze(['focus', 'mission', 'attention', 'people', 'world', 'memory', 'workforce']),
})
export interface PreferenceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}
const LEGACY_THEMES: Record<string, ThemeId> = { aurora: 'abyss', pearl: 'dawn', midnight: 'abyss' }
export function parsePreferences(input: unknown): Preferences {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return DEFAULT_PREFERENCES
  const value = input as Record<string, unknown>
  if (value.version !== 1) return DEFAULT_PREFERENCES
  const theme = typeof value.theme === 'string' ? LEGACY_THEMES[value.theme] ?? value.theme : value.theme
  return Object.freeze({
    version: 1,
    theme: THEMES.includes(theme as ThemeId) ? theme as ThemeId : 'abyss',
    mode: value.mode === 'immersive' ? 'immersive' : 'app',
    density: value.density === 'compact' ? 'compact' : 'comfortable',
    textScale: value.textScale === 1.125 || value.textScale === 1.25 ? value.textScale : 1,
    backdrop: value.backdrop === 'quiet' || value.backdrop === 'solid' ? value.backdrop : 'cosmos',
    reducedEffects: value.reducedEffects === true,
    homePanels: Array.isArray(value.homePanels) ? Object.freeze([...new Set(value.homePanels.filter((id) => typeof id === 'string' && ['focus', 'mission', 'attention', 'people', 'world', 'memory', 'workforce'].includes(id)))]) : DEFAULT_PREFERENCES.homePanels,
  })
}
/** Owns appearance only. Domain data and credentials never enter this store. */
export class PreferencesStore {
  private state: Preferences = DEFAULT_PREFERENCES
  private listeners = new Set<() => void>()
  constructor(private storage?: PreferenceStorage) {
    try {
      const saved = storage?.getItem(PREFERENCES_KEY)
      if (saved) this.state = parsePreferences(JSON.parse(saved))
    } catch { /* Invalid or unavailable storage uses defaults. */ }
  }
  getSnapshot = (): Preferences => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  update(patch: Partial<Omit<Preferences, 'version'>>): void {
    const next = parsePreferences({ ...this.state, ...patch, version: 1 })
    if (JSON.stringify(next) === JSON.stringify(this.state)) return
    this.state = next
    try { this.storage?.setItem(PREFERENCES_KEY, JSON.stringify(next)) } catch { /* In-memory controls still work. */ }
    for (const listener of this.listeners) listener()
  }
  reset(): void { this.update(DEFAULT_PREFERENCES) }
}
