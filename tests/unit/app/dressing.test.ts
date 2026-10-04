import { describe, expect, it } from 'vitest'
import { DEFAULT_DRESSING, DRESSING_KEY, DressingStore, parseDressing } from '../../../src/app/dressing/store'

describe('dressing table store', () => {
  it('defaults to Freya on the city backdrop, rings on, in app form', () => {
    expect(DEFAULT_DRESSING).toMatchObject({ centre: 'freya', style: 'lattice', background: 'city', rings: 'on', form: 'brain' })
  })

  it('rejects unknown values and keeps the known ones', () => {
    const parsed = parseDressing({ centre: 'nope', style: 'flow', background: 'city', rings: 'off', form: 'chibi' })
    expect(parsed.centre).toBe('freya')
    expect(parsed.style).toBe('flow')
    expect(parsed.background).toBe('city')
    expect(parsed.rings).toBe('off')
    expect(parsed.form).toBe('chibi')
  })

  it('persists a choice and reloads it', () => {
    const memory = new Map<string, string>()
    const storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => void memory.set(key, value) }
    const store = new DressingStore(storage)
    store.update({ centre: 'galaxy', background: 'aurora' })
    expect(memory.has(DRESSING_KEY)).toBe(true)
    expect(new DressingStore(storage).getSnapshot()).toMatchObject({ centre: 'galaxy', background: 'aurora' })
  })

  it('resets to the defaults', () => {
    const store = new DressingStore()
    store.update({ form: 'adult' })
    store.reset()
    expect(store.getSnapshot()).toEqual(DEFAULT_DRESSING)
  })
})
