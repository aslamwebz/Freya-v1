import { describe, expect, it } from 'vitest'
import { initialState, reduce, type ShellEvent, type ShellState } from '../../src/core/events'
import { PRESENCE_DETAIL } from '../../src/core/presence'

function apply(events: ShellEvent[], from: ShellState = initialState()): ShellState {
  return events.reduce(reduce, from)
}

describe('event reducer', () => {
  it('transitions presence and stamps the moment it happened', () => {
    const state = apply([{ type: 'presence.set', state: 'listening' }])
    expect(state.presence.state).toBe('listening')
    expect(state.presence.detail).toBe(PRESENCE_DETAIL.listening)
    expect(state.presence.since).toBeGreaterThan(0)
  })

  it('refuses an illegal presence transition and leaves state untouched', () => {
    const locked = apply([{ type: 'presence.set', state: 'locked' }])
    const next = reduce(locked, { type: 'presence.set', state: 'working' })

    expect(next).toBe(locked)
    expect(next.presence.state).toBe('locked')
  })

  it('is a no-op when the presence is already in the requested state', () => {
    const idle = initialState()
    expect(reduce(idle, { type: 'presence.set', state: 'idle' })).toBe(idle)
  })

  it('clamps reported presence activity to 0..1', () => {
    expect(apply([{ type: 'presence.activity', value: 4 }]).presence.activity).toBe(1)
    expect(apply([{ type: 'presence.activity', value: -3 }]).presence.activity).toBe(0)
    expect(apply([{ type: 'presence.activity', value: 0.4 }]).presence.activity).toBe(0.4)
  })

  it('toggles voice and moves presence between listening and idle', () => {
    const listening = apply([{ type: 'voice.toggle', listening: true }])
    expect(listening.listening).toBe(true)
    expect(listening.presence.state).toBe('listening')

    const idle = reduce(listening, { type: 'voice.toggle', listening: false })
    expect(idle.listening).toBe(false)
    expect(idle.presence.state).toBe('idle')
  })

  it('records a submitted command, moves presence to working, and raises a notice', () => {
    const state = apply([{ type: 'command.submit', text: '  summarise my notes  ' }])

    expect(state.lastCommand).toBe('summarise my notes')
    expect(state.commandDraft).toBe('')
    expect(state.presence.state).toBe('working')
    expect(state.notices).toHaveLength(1)
    expect(state.notices[0]?.text).toContain('no model is attached')
  })

  it('ignores an empty command', () => {
    const before = initialState()
    expect(reduce(before, { type: 'command.submit', text: '   ' })).toBe(before)
  })

  it('keeps the notice stack bounded', () => {
    const state = apply(
      Array.from({ length: 9 }, (_, i) => ({ type: 'command.submit', text: `n${i}` }) as ShellEvent),
    )
    expect(state.notices.length).toBeLessThanOrEqual(4)
  })

  it('applies a demo event to the dashboard projection', () => {
    const state = apply([
      { type: 'attention.requested', count: 2 },
      { type: 'work.updated', note: 'surface restored' },
    ])

    expect(state.attention.requested).toBe(2)
    expect(state.attention.lastNote).toBe('surface restored')
  })

  it('restores nav and presence from a workspace snapshot', () => {
    const state = apply([{ type: 'workspace.restored', nav: 'vault', presence: 'working' }])
    expect(state.nav).toBe('vault')
    expect(state.presence.state).toBe('working')
  })

  it('routes surface events out rather than duplicating them into the snapshot', () => {
    const before = initialState()
    const after = reduce(before, {
      type: 'surface.opened',
      id: 'chat-1',
      surface: null,
    })
    expect(after).toBe(before)
  })

  it('marks every dashboard fixture as demo data', () => {
    expect(initialState().dashboard.demo).toBe(true)
  })
})
