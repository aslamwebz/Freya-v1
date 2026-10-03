import { describe, expect, it } from 'vitest'
import { PreferencesStore, DEFAULT_PREFERENCES, parsePreferences } from '../../../src/ui-v2/theme/preferences'

describe('theme preference migration', () => {
  it('defaults to abyss', () => { expect(DEFAULT_PREFERENCES.theme).toBe('abyss') })
  it('maps a legacy aurora value onto abyss', () => {
    expect(parsePreferences({ version: 1, theme: 'aurora' }).theme).toBe('abyss')
  })
  it('accepts the new ids', () => {
    expect(parsePreferences({ version: 1, theme: 'vessel' }).theme).toBe('vessel')
  })
  it('persists and reloads', () => {
    const mem = new Map<string, string>()
    const store = new PreferencesStore({ getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v) })
    store.update({ theme: 'dawn' })
    expect(new PreferencesStore({ getItem: (k) => mem.get(k) ?? null, setItem: () => {} }).getSnapshot().theme).toBe('dawn')
  })
})