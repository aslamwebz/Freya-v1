import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BACKGROUNDS,
  BRAIN_STYLES,
  DEFAULT_LAB,
  LAB_OPTIONS,
  PIECES,
  cycleLab,
  loadLabState,
  onLabChange,
  publishLab,
  saveLabState,
} from '../../src/presence/labState'

describe('design lab state', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('ships with the liquid orb on deep space, full extras and rings on', () => {
    expect(DEFAULT_LAB).toEqual({
      bg: 'space',
      piece: 'orb',
      style: 'current',
      clean: '0',
      rings: '1',
    })
    expect(loadLabState()).toEqual(DEFAULT_LAB)
  })

  it('exposes exactly the reference option set', () => {
    expect([...BACKGROUNDS]).toEqual(['city', 'space', 'grid', 'aurora', 'obsidian'])
    expect([...PIECES]).toEqual(['brain', 'reactor', 'orb', 'tesseract', 'galaxy'])
    expect([...BRAIN_STYLES]).toEqual(['current', 'slices', 'flow', 'glass'])
    expect(Object.keys(LAB_OPTIONS).sort()).toEqual(['bg', 'clean', 'piece', 'rings', 'style'])
  })

  it('round-trips every choice through local storage', () => {
    const chosen = { bg: 'grid', piece: 'galaxy', style: 'flow', clean: '1', rings: '0' } as const
    saveLabState(chosen)
    expect(loadLabState()).toEqual(chosen)
  })

  it('falls back to defaults for a value it does not recognise', () => {
    window.localStorage.setItem('freya.lab.piece', 'wormhole')
    window.localStorage.setItem('freya.lab.bg', 'space')
    const loaded = loadLabState()
    expect(loaded.piece).toBe(DEFAULT_LAB.piece)
    expect(loaded.bg).toBe('space')
  })

  it('survives storage being unavailable', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    expect(() => saveLabState({ ...DEFAULT_LAB, piece: 'reactor' })).not.toThrow()
    expect(loadLabState()).toEqual(DEFAULT_LAB)
    setItem.mockRestore()
    getItem.mockRestore()
  })

  it('cycles through every option and wraps back to the start', () => {
    let state = DEFAULT_LAB
    const seen: string[] = []
    for (let i = 0; i < PIECES.length; i += 1) {
      state = cycleLab(state, 'piece')
      seen.push(state.piece)
    }
    expect([...seen].sort()).toEqual([...PIECES].sort())
    expect(state.piece).toBe(DEFAULT_LAB.piece)
    expect(cycleLab(state, 'piece').piece).not.toBe(state.piece)
  })

  it('notifies subscribers and stops after unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = onLabChange(listener)

    publishLab({ ...DEFAULT_LAB, piece: 'tesseract' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ piece: 'tesseract' })

    unsubscribe()
    publishLab({ ...DEFAULT_LAB, piece: 'reactor' })
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
