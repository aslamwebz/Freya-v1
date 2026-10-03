import { describe, expect, it } from 'vitest'
import { WindowsStore, WINDOWS_KEY } from '../../../src/ui-v2/windows/model'
describe('immersive window layout', () => {
  it('reopens singleton windows and restores minimized views', () => {
    const store = new WindowsStore({ width: 1000, height: 700 })
    store.open('mission')
    store.minimize('mission')
    expect(store.getSnapshot().active).toBeNull()
    store.open('mission')
    expect(store.getSnapshot().windows).toHaveLength(1)
    expect(store.getSnapshot().windows[0]?.minimized).toBe(false)
    expect(store.getSnapshot().active).toBe('mission')
  })
  it('clamps moved and resized windows to the usable frame', () => {
    const store = new WindowsStore({ width: 1000, height: 700 })
    store.open('mission')
    store.move('mission', 900, -70)
    expect(store.boundsFor('mission')).toMatchObject({ x: 420, y: 0 })
    store.resize('mission', 4000, 4000)
    expect(store.boundsFor('mission')).toEqual({ x: 420, y: 0, width: 580, height: 700 })
    store.resize('mission', -5, 20)
    expect(store.boundsFor('mission')).toMatchObject({ width: 300, height: 220 })
  })
  it('keeps pinned windows above ordinary windows while allowing movement', () => {
    const store = new WindowsStore({ width: 1200, height: 800 })
    store.open('mind'); store.pin('mind'); store.open('mission'); store.focus('mission')
    expect(store.layerFor('mind')).toBeGreaterThan(store.layerFor('mission'))
    store.move('mind', 50, 60)
    expect(store.boundsFor('mind')).toMatchObject({ x: 50, y: 60 })
  })
  it('maximizes within the frame and restores desktop geometry', () => {
    const store = new WindowsStore({ width: 1000, height: 700 })
    store.open('world')
    const original = store.boundsFor('world')
    store.maximize('world')
    expect(store.boundsFor('world')).toEqual({ x: 0, y: 0, width: 1000, height: 700 })
    store.maximize('world')
    expect(store.boundsFor('world')).toEqual(original)
  })
  it('retains desktop geometry when a narrow viewport turns windows into sheets', () => {
    const store = new WindowsStore({ width: 1200, height: 800 })
    store.open('world'); store.move('world', 100, 90)
    const desktop = store.boundsFor('world')
    store.setViewport({ width: 390, height: 650 })
    expect(store.boundsFor('world')).toEqual({ x: 0, y: 0, width: 390, height: 650 })
    store.move('world', 900, 900)
    store.setViewport({ width: 1200, height: 800 })
    expect(store.boundsFor('world')).toEqual(desktop)
  })
  it('validates saved layouts and discards private or malformed fields', () => {
    const data = new Map<string, string>()
    const port = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } }
    data.set(WINDOWS_KEY, JSON.stringify({ version: 1, windows: [
      { id: 'world', bounds: { x: -500, y: 0, width: 900, height: 500 }, pinned: true, private: 'sentinel' },
      { id: 'world', bounds: { x: 0, y: 0, width: 300, height: 220 } },
      { id: 'administrator', bounds: { x: 0, y: 0, width: 300, height: 220 } },
    ] }))
    const store = new WindowsStore({ width: 1000, height: 700 }, port)
    expect(store.getSnapshot().windows).toHaveLength(1)
    expect(store.boundsFor('world')?.x).toBe(0)
    store.focus('world')
    expect(data.get(WINDOWS_KEY)).not.toContain('sentinel')
    expect(new WindowsStore({ width: 1000, height: 700 }, port).getSnapshot().windows[0]?.pinned).toBe(true)
  })
  it('ignores non-finite geometry and can reset a layout', () => {
    const store = new WindowsStore({ width: 1000, height: 700 })
    store.open('mission')
    const before = store.getSnapshot()
    store.move('mission', Number.NaN, 20)
    expect(store.getSnapshot()).toBe(before)
    store.reset()
    expect(store.getSnapshot().windows).toHaveLength(0)
  })
})
