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

  it('projects a surface summary onto the shell state', () => {
    const opened = apply([
      {
        type: 'surface.opened',
        id: 'chat-1',
        surface: null,
        summary: { open: 1, minimized: 0, focused: 'chat-1' },
      },
    ])
    expect(opened.surfaces).toEqual({ open: 1, minimized: 0, focused: 'chat-1' })

    const minimized = apply(
      [
        {
          type: 'surface.state.changed',
          id: 'chat-1',
          surface: null,
          summary: { open: 1, minimized: 1, focused: null },
        },
      ],
      opened,
    )
    expect(minimized.surfaces).toEqual({ open: 1, minimized: 1, focused: null })
  })

  it('does not churn state when a surface event carries an unchanged summary', () => {
    const before = apply([
      {
        type: 'surface.opened',
        id: 'chat-1',
        surface: null,
        summary: { open: 1, minimized: 0, focused: 'chat-1' },
      },
    ])
    const after = reduce(before, {
      type: 'surface.moved',
      id: 'chat-1',
      surface: null,
      summary: { open: 1, minimized: 0, focused: 'chat-1' },
    })
    expect(after).toBe(before)
  })

  it('marks every dashboard fixture as demo data', () => {
    expect(initialState().dashboard.demo).toBe(true)
  })

  it('starts with an empty surface projection', () => {
    expect(initialState().surfaces).toEqual({ open: 0, minimized: 0, focused: null })
  })
})

describe('every presence change goes through transition validation', () => {
  it('a submitted command cannot unlock a locked Freya', () => {
    const locked = apply([{ type: 'presence.set', state: 'locked' }])
    const after = reduce(locked, { type: 'command.submit', text: 'open the vault' })

    expect(after.presence.state).toBe('locked')
    // The command itself is still recorded; only the presence is refused.
    expect(after.lastCommand).toBe('open the vault')
  })

  it('the microphone cannot listen while locked', () => {
    const locked = apply([{ type: 'presence.set', state: 'locked' }])
    const after = reduce(locked, { type: 'voice.toggle', listening: true })

    expect(after.presence.state).toBe('locked')
    expect(after.listening).toBe(false)
  })

  it('the microphone cannot listen while errored', () => {
    const errored = apply([{ type: 'presence.set', state: 'error' }])
    const after = reduce(errored, { type: 'voice.toggle', listening: true })

    expect(after.presence.state).toBe('error')
    expect(after.listening).toBe(false)
  })

  it('a restored workspace cannot clear an error', () => {
    const errored = apply([{ type: 'presence.set', state: 'error' }])
    const after = reduce(errored, {
      type: 'workspace.restored',
      nav: 'vault',
      presence: 'working',
    })

    expect(after.presence.state).toBe('error')
    // The navigation half of the restore still applies.
    expect(after.nav).toBe('vault')
  })

  it('a restored workspace may restore the state it legitimately saved', () => {
    const working = apply([{ type: 'presence.set', state: 'working' }])
    const after = reduce(working, {
      type: 'workspace.restored',
      nav: 'work',
      presence: 'working',
    })
    expect(after.presence.state).toBe('working')
    expect(after.nav).toBe('work')
  })

  it('turning the microphone off always returns to idle when that is legal', () => {
    const listening = apply([{ type: 'voice.toggle', listening: true }])
    const after = reduce(listening, { type: 'voice.toggle', listening: false })
    expect(after.presence.state).toBe('idle')
    expect(after.listening).toBe(false)
  })
})
