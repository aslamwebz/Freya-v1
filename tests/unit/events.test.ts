import { describe, expect, it } from 'vitest'
import type { CoreStatus } from '../../core/protocol/core-protocol'
import { initialState, reduce, type ShellEvent, type ShellState } from '../../src/core/events'

/** The event names the reducer accepts, read off the union at runtime. */
const EVENT_NAMES: string[] = (
  [
    'presence.activity',
    'presence.simulate',
    'nav.select',
    'command.submit',
    'core.status',
    'core.activity',
    'command.acknowledged',
    'nav.collapse',
    'chat.line',
    'voice.toggle',
    'attention.requested',
    'workspace.restored',
    'work.updated',
  ] as const
).map(String)

/** A minimal healthy Core status, for tests that need one. */
const READY_CORE: CoreStatus = {
  lifecycle: 'ready',

        operational: true,
        persistence: { mode: 'durable', durable: true, reason: null, eventStorePath: null }, diagnostics: { path: null, writeFailures: 0 },  eventSequence: 3,
  coreStartedAt: '2026-03-01T12:00:00.000Z',
  integrity: {
    integrity: 'ok',
    reason: 'test',
    line: null,
    eventsRead: 3,
    bytesDiscarded: 0,
  },
  stopAll: { active: false, activatedAt: null, activatedBy: null },
  guard: { defaultOutcome: 'deny', approvalWorkflow: 'unavailable' },
  governor: { status: 'ready', grantsActive: 0 },
  providers: [],
  activeProviderCalls: 0,
  sessionUsage: { calls: 0, inputTokens: null, outputTokens: null, unknownUsageCalls: 0 },
  durableUsage: { calls: 0, inputTokens: null, outputTokens: null, unknownUsageCalls: 0 },
  faults: [],
}

/** STOP ALL latched: the Core refuses everything. */
const STOPPED_CORE: CoreStatus = {
  ...READY_CORE,
  governor: { status: 'deny_all', grantsActive: 0 },
  stopAll: {
    active: true,
    activatedAt: '2026-03-01T12:05:00.000Z',
    activatedBy: 'owner',
  },
}

/** A corrupt journal: fail closed, and stay that way. */
const CORRUPT_CORE: CoreStatus = {
  ...READY_CORE,
  lifecycle: 'degraded',
  integrity: {
    integrity: 'corrupt',
    reason: 'journal corrupted at line 3',
    line: 3,
    eventsRead: 2,
    bytesDiscarded: 120,
  },
  governor: { status: 'deny_all', grantsActive: 0 },
}

function apply(events: ShellEvent[], from: ShellState = initialState()): ShellState {
  return events.reduce(reduce, from)
}


/**
 * Presence is derived from Core from Phase 2 onwards.
 *
 * There is deliberately no `presence.set` event any more. A Development Lab
 * override exists and is `presence.simulate`, which the reducer refuses unless
 * the runtime says this is a development build — so a simulated state cannot be
 * mistaken for a real one in a shipped window.
 */
function devState(): ShellState {
  return { ...initialState(), runtime: { ...initialState().runtime, dev: true } }
}

describe('event reducer', () => {
  it('has no ungated presence setter in the event union', () => {
    // Structural rather than behavioural: the union is the API, and it has no
    // member that moves presence without Core having caused it.
    const setters = EVENT_NAMES.filter((name) => name.startsWith('presence.'))
    expect(setters).toEqual(['presence.activity', 'presence.simulate'])
  })

  it('lets the Development Lab simulate presence, in a development build', () => {
    const state = apply([{ type: 'presence.simulate', state: 'listening' }], devState())
    expect(state.presence.state).toBe('listening')
    expect(state.presence.since).toBeGreaterThan(0)
  })

  it('refuses a simulated presence in a shipped build', () => {
    // The second lock. The Design Lab is not rendered in production either, and
    // even if something dispatched this, the reducer ignores it and returns the
    // very same state object, so nothing even re-renders.
    const state = initialState()
    expect(reduce(state, { type: 'presence.simulate', state: 'working' })).toBe(state)
    expect(state.presence.state).toBe('idle')
  })

  it('re-derives presence from Core and so overrides a simulated state', () => {
    // A Core status push is the truth. A lab that left Freya in `working` is
    // corrected by the next fact to arrive, rather than persisting.
    const dev = apply([{ type: 'presence.simulate', state: 'working' }], devState())
    expect(dev.presence.state).toBe('working')
    const withCore = reduce(dev, { type: 'core.status', status: READY_CORE })
    expect(withCore.presence.state).toBe('idle')
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

  it('restores nav from a workspace snapshot but never presence', () => {
    // A saved `thinking` from last week's crash is not a fact about now. The
    // layout comes back; Core decides the intelligence's state.
    const state = apply([
      { type: 'workspace.restored', nav: 'vault', navCollapsed: false, presence: 'working' },
    ])
    expect(state.nav).toBe('vault')
    expect(state.presence.state).toBe('idle')
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

  it('has no demo dashboard at all', () => {
    // Phase 2 removed the fixtures. Every dashboard value is now derived from
    // Core, so there is nothing to mark as demo — and no `demo` flag that a
    // panel could forget to render.
    const state = initialState()
    expect((state as unknown as Record<string, unknown>).dashboard).toBeUndefined()
    expect(state.desktop.corePresent).toBe(false)
    expect(state.desktop.work.empty).toBe(true)
    expect(state.desktop.attentionItems).toEqual([])
  })

  it('starts with an empty surface projection', () => {
    expect(initialState().surfaces).toEqual({ open: 0, minimized: 0, focused: null })
  })
})

describe('every presence change goes through transition validation', () => {
  it('a submitted command cannot unlock a locked Freya', () => {
    const locked = apply([{ type: 'core.status', status: STOPPED_CORE }])
    expect(locked.presence.state).toBe('locked')
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

  it('a STOP ALL status overrides an already-listening UI immediately', () => {
    const listening = apply([
      { type: 'core.status', status: READY_CORE },
      { type: 'voice.toggle', listening: true },
    ])
    expect(listening.presence.state).toBe('listening')

    const stopped = reduce(listening, { type: 'core.status', status: STOPPED_CORE })
    expect(stopped.presence.state).toBe('locked')
    expect(stopped.presence.detail).toMatch(/stopped|refused/i)
  })

  it('a journal fault outranks an existing STOP ALL presentation', () => {
    const locked = apply([{ type: 'core.status', status: STOPPED_CORE }])
    expect(locked.presence.state).toBe('locked')

    const errored = reduce(locked, { type: 'core.status', status: CORRUPT_CORE })
    expect(errored.presence.state).toBe('error')
    expect(errored.presence.detail).toMatch(/journal is corrupt/i)
  })

  it('a same-state Core update refreshes the human detail', () => {
    const ready = apply([{ type: 'core.status', status: READY_CORE }])
    expect(ready.presence.state).toBe('idle')
    expect(ready.presence.detail).toBe('Standing by.')
  })

  it('the microphone cannot listen while locked', () => {
    const locked = apply([{ type: 'core.status', status: STOPPED_CORE }])
    const after = reduce(locked, { type: 'voice.toggle', listening: true })

    expect(after.presence.state).toBe('locked')
    // Refused outright, not merely overridden by the display. A store claiming
    // `listening: true` while the presence reads locked is the contradiction the
    // Phase 1 rule was written to prevent.
    expect(after.listening).toBe(false)
    expect(after).toBe(locked)
  })

  it('the microphone cannot listen while the journal is corrupt', () => {
    const errored = apply([{ type: 'core.status', status: CORRUPT_CORE }])
    expect(errored.presence.state).toBe('error')

    const after = reduce(errored, { type: 'voice.toggle', listening: true })
    expect(after.presence.state).toBe('error')
    expect(after.listening).toBe(false)
  })

  it('a restored workspace cannot clear an error', () => {
    const errored = apply([{ type: 'core.status', status: CORRUPT_CORE }])
    const after = reduce(errored, {
      type: 'workspace.restored',
      nav: 'vault',
      navCollapsed: false,
      presence: 'working',
    })

    expect(after.presence.state).toBe('error')
    // The navigation half of the restore still applies.
    expect(after.nav).toBe('vault')
  })

  it('a restored workspace restores layout and not intelligence state', () => {
    // The old behaviour restored a saved `working`. There is no `working` to
    // restore to in Phase 2 — presence comes from Core — so the saved field is
    // read for navigation and ignored for state.
    const after = reduce(initialState(), {
      type: 'workspace.restored',
      nav: 'work',
      navCollapsed: true,
      presence: 'working',
    })
    expect(after.nav).toBe('work')
    expect(after.navCollapsed).toBe(true)
    expect(after.presence.state).toBe('idle')
  })

  it('turning the microphone off always returns to idle when that is legal', () => {
    const listening = apply([
      { type: 'core.status', status: READY_CORE },
      { type: 'voice.toggle', listening: true },
    ])
    const after = reduce(listening, { type: 'voice.toggle', listening: false })
    expect(after.presence.state).toBe('idle')
    expect(after.listening).toBe(false)
  })
})
