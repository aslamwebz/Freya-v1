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

  it('records nothing on a submit, because the reducer is not the command path', () => {
    // `command.submit` is a request that the command path handles. The reducer
    // only ever records what Core replied, so a command cannot look accepted
    // before Core has answered.
    const state = apply([{ type: 'command.submit', text: 'summarise my notes' }])
    expect(state.notices).toHaveLength(0)
    expect(state.presence.state).toBe('idle')
  })

  it('does not move presence to working for a command nothing is working on', () => {
    // Phase 0 put Freya into 'working' here, which spun the presence ring for a
    // command that did nothing at all. Execution is still not connected, so
    // 'working' would be a claim about the world.
    const state = apply([
      {
        type: 'command.acknowledged',
        ok: true,
        detail: 'Freya Core received the command and recorded it (event #7).',
        durableSequence: 7,
      },
    ])
    expect(state.presence.state).toBe('idle')
    expect(state.commandDraft).toBe('')
    expect(state.notices[0]?.text).toContain('Freya Core received the command')
    // The sequence is shown, so the claim is checkable rather than reassuring.
    expect(state.notices[0]?.text).toContain('event #7')
  })

  it('shows Core refusal as a refusal, and does not claim success', () => {
    const state = apply([
      {
        type: 'command.acknowledged',
        ok: false,
        detail: 'Freya Core refused the command — command text is too long',
      },
    ])
    expect(state.notices[0]?.tone).toBe('urgent')
    expect(state.notices[0]?.text).toMatch(/refused/i)
    expect(state.notices[0]?.text).not.toMatch(/received the command/i)
  })

  it('keeps the notice stack bounded', () => {
    const state = apply(
      Array.from(
        { length: 9 },
        (_, i) => ({ type: 'command.acknowledged', ok: true, detail: `n${i}` }) as ShellEvent,
      ),
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
    const after = reduce(locked, {
      type: 'command.acknowledged',
      ok: true,
      detail: 'Freya Core received the command and recorded it.',
    })

    // A command, acknowledged or not, is not a presence transition. Nothing
    // about a submission can move a locked Freya, because nothing about a
    // submission is a reason to change state.
    expect(after.presence.state).toBe('locked')
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
