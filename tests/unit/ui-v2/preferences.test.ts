import { describe, expect, it } from 'vitest'
import { DEFAULT_PREFERENCES, parsePreferences, PreferencesStore, PREFERENCES_KEY } from '../../../src/ui-v2/theme/preferences'

describe('Phase 19 preferences', () => {
  it('recovers unsupported versions and invalid presentation values', () => {
    expect(parsePreferences({ version: 19, theme: 'pearl' })).toEqual(DEFAULT_PREFERENCES)
    expect(parsePreferences({ version: 1, theme: 'gold', mode: 'admin', textScale: 9 })).toEqual(DEFAULT_PREFERENCES)
  })
  it('persists only presentation fields and restores a supported theme', () => {
    const storage = new Map<string, string>()
    const port = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) } }
    storage.set(PREFERENCES_KEY, JSON.stringify({ version: 1, theme: 'pearl', secret: 'private-content' }))
    const store = new PreferencesStore(port)
    store.update({ mode: 'immersive', density: 'compact' })
    const restored = new PreferencesStore(port)
    expect(restored.getSnapshot()).toMatchObject({ theme: 'pearl', mode: 'immersive', density: 'compact' })
    expect(storage.get(PREFERENCES_KEY)).not.toContain('private-content')
    expect(Object.isFrozen(restored.getSnapshot())).toBe(true)
  })
  it('publishes changes once, keeps snapshots stable, and resets preferences', () => {
    const store = new PreferencesStore()
    let changes = 0
    const dispose = store.subscribe(() => changes++)
    const first = store.getSnapshot()
    store.update({ theme: 'aurora' })
    expect(store.getSnapshot()).toBe(first)
    store.update({ theme: 'midnight', reducedEffects: true })
    expect(changes).toBe(1)
    store.reset()
    expect(store.getSnapshot()).toEqual(DEFAULT_PREFERENCES)
    expect(changes).toBe(2)
    dispose()
    store.update({ theme: 'pearl' })
    expect(changes).toBe(2)
  })
  it('survives blocked storage and corrupt JSON without losing in-memory settings', () => {
    const store = new PreferencesStore({ getItem: () => '{bad', setItem: () => { throw new Error('blocked') } })
    store.update({ theme: 'pearl' })
    expect(store.getSnapshot().theme).toBe('pearl')
  })
  it('restores panel choices and rejects unknown or duplicate panel ids', () => {
    const storage = new Map<string, string>()
    const port = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) } }
    const store = new PreferencesStore(port)
    store.update({ homePanels: ['focus', 'focus', 'memory', 'private-content'] })
    expect(new PreferencesStore(port).getSnapshot().homePanels).toEqual(['focus', 'memory'])
    expect(storage.get(PREFERENCES_KEY)).not.toContain('private-content')
    store.update({ homePanels: [] })
    expect(new PreferencesStore(port).getSnapshot().homePanels).toEqual([])
  })})
