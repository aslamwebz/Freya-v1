// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  derivePhase26PresenceState,
  phase26Animation,
  phase26Detail,
  applyTransition,
  canTransitionPresence,
  emptyTransitionHistory,
  transitionTimedOut,
  PHASE26_PRESENCE_LIMITS,
  PHASE26_PRESENCE_STATES,
  type Phase26PresenceInput,
  type Phase26PresenceState,
} from '../../../core/natural-presence'

const NOW = '2026-10-01T12:00:00.000Z'

function input(over: Partial<Phase26PresenceInput> = {}): Phase26PresenceInput {
  return {
    stopAllActive: false,
    integrityCorrupt: false,
    degraded: false,
    synthesisActive: false,
    captureActive: false,
    providerCallInFlight: false,
    runExecuting: false,
    attentionDirective: null,
    personalityCue: null,
    ...over,
  }
}

describe('presence.derive', () => {
  it('derive.idle: nothing happening', () => {
    expect(derivePhase26PresenceState(input())).toBe('idle')
  })

  it('derive.listening: voice capture active', () => {
    expect(derivePhase26PresenceState(input({ captureActive: true }))).toBe('listening')
  })

  it('derive.no-thinking: a provider call in flight is working, never thinking', () => {
    // Phase 13 parity: `thinking` is reserved vocabulary with no door. The only
    // honest live signal is a provider call in flight, which is `working`.
    expect(derivePhase26PresenceState(input({ providerCallInFlight: true }))).toBe('working')
    expect(PHASE26_PRESENCE_STATES).toContain('thinking')
    expect(phase26Animation('thinking')).toBe('spin')
  })

  it('derive.speaking: synthesis active', () => {
    expect(derivePhase26PresenceState(input({ synthesisActive: true }))).toBe('speaking')
  })

  it('derive.working: provider call or run executing', () => {
    expect(derivePhase26PresenceState(input({ providerCallInFlight: true }))).toBe('working')
    expect(derivePhase26PresenceState(input({ runExecuting: true }))).toBe('working')
  })

  it('derive.attention: attention directive or personality cue', () => {
    expect(derivePhase26PresenceState(input({ attentionDirective: { id: 'a' } }))).toBe('attention')
    expect(derivePhase26PresenceState(input({ personalityCue: { id: 'p' } }))).toBe('attention')
  })

  it('derive.error: STOP ALL or integrity corrupt', () => {
    expect(derivePhase26PresenceState(input({ stopAllActive: true }))).toBe('error')
    expect(derivePhase26PresenceState(input({ integrityCorrupt: true }))).toBe('error')
  })

  it('derive.degraded: a subsystem has faulted', () => {
    expect(derivePhase26PresenceState(input({ degraded: true }))).toBe('degraded')
  })

  it('STOP ALL outranks every other fact', () => {
    const state = derivePhase26PresenceState(
      input({ stopAllActive: true, runExecuting: true, synthesisActive: true, attentionDirective: {} }),
    )
    expect(state).toBe('error')
  })

  it('precedence: STOP ALL > integrity > degraded > speaking > listening > working > attention > idle', () => {
    const cases: readonly [Partial<Phase26PresenceInput>, Phase26PresenceState][] = [
      [
        {
          stopAllActive: true,
          integrityCorrupt: true,
          degraded: true,
          synthesisActive: true,
          captureActive: true,
          providerCallInFlight: true,
          runExecuting: true,
          attentionDirective: {},
          personalityCue: {},
        },
        'error',
      ],
      [
        {
          integrityCorrupt: true,
          degraded: true,
          synthesisActive: true,
          captureActive: true,
          providerCallInFlight: true,
          runExecuting: true,
          attentionDirective: {},
          personalityCue: {},
        },
        'error',
      ],
      [
        {
          degraded: true,
          synthesisActive: true,
          captureActive: true,
          providerCallInFlight: true,
          runExecuting: true,
          attentionDirective: {},
          personalityCue: {},
        },
        'degraded',
      ],
      [
        { synthesisActive: true, captureActive: true, providerCallInFlight: true, attentionDirective: {}, personalityCue: {} },
        'speaking',
      ],
      [{ captureActive: true, providerCallInFlight: true, attentionDirective: {}, personalityCue: {} }, 'listening'],
      [{ providerCallInFlight: true, runExecuting: true, attentionDirective: {}, personalityCue: {} }, 'working'],
      [{ runExecuting: true, attentionDirective: {}, personalityCue: {} }, 'working'],
      [{ attentionDirective: {}, personalityCue: {} }, 'attention'],
      [{ personalityCue: {} }, 'attention'],
      [{}, 'idle'],
    ]
    for (const [facts, expected] of cases) {
      expect(derivePhase26PresenceState(input(facts))).toBe(expected)
    }
  })

  it('thinking is unreachable from every combination of real Core facts', () => {
    const bools = [false, true] as const
    for (const stopAllActive of bools)
      for (const integrityCorrupt of bools)
        for (const degraded of bools)
          for (const synthesisActive of bools)
            for (const captureActive of bools)
              for (const providerCallInFlight of bools)
                for (const runExecuting of bools)
                  for (const attentionDirective of [null, {}] as const)
                    for (const personalityCue of [null, {}] as const) {
                      const state = derivePhase26PresenceState({
                        stopAllActive,
                        integrityCorrupt,
                        degraded,
                        synthesisActive,
                        captureActive,
                        providerCallInFlight,
                        runExecuting,
                        attentionDirective,
                        personalityCue,
                      })
                      expect(state).not.toBe('thinking')
                    }
  })

  it('animation and detail are fixed per state', () => {
    expect(phase26Animation('idle')).toBe('breathe')
    expect(phase26Animation('speaking')).toBe('wave')
    expect(phase26Detail('idle', input())).toBe('Standing by.')
    expect(phase26Detail('error', input({ stopAllActive: true }))).toContain('Stopped')
  })
})

describe('presence.transition', () => {
  it('allows the eight expanded transitions (thinking edges stay legal but reserved)', () => {
    const pairs: [string, string][] = [
      ['idle', 'listening'],
      ['listening', 'thinking'],
      ['thinking', 'speaking'],
      ['speaking', 'idle'],
      ['working', 'attention'],
      ['attention', 'idle'],
      ['error', 'idle'],
      ['degraded', 'idle'],
    ]
    for (const [from, to] of pairs) {
      expect(canTransitionPresence(from as never, to as never)).toBe(true)
    }
    // The `thinking` edges are protocol-legal, exactly as in Phase 13, but no
    // derivation produces `thinking`; the edges are inert until a future phase
    // introduces a real "turn running, no provider call yet" Core fact.
    expect(canTransitionPresence('listening', 'thinking')).toBe(true)
    expect(canTransitionPresence('thinking', 'speaking')).toBe(true)
  })

  it('refuses an illegal transition', () => {
    expect(canTransitionPresence('error', 'working')).toBe(false)
    const result = applyTransition(emptyTransitionHistory(), 'error', 'working', 'x', NOW, 10)
    expect(result.ok).toBe(false)
  })

  it('appends a legal transition with a bounded duration', () => {
    const result = applyTransition(emptyTransitionHistory(), 'idle', 'listening', 'capture started', NOW, 40)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.history.transitions.length).toBe(1)
    expect(result.transition?.to).toBe('listening')
    expect(result.transition?.timedOut).toBe(false)
  })

  it('marks a transition that exceeds the duration as timed out', () => {
    expect(transitionTimedOut(PHASE26_PRESENCE_LIMITS.maxTransitionDurationMs + 1)).toBe(true)
    const result = applyTransition(emptyTransitionHistory(), 'idle', 'listening', 'slow', NOW, 9_999)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.transition?.timedOut).toBe(true)
  })

  it('history-bounded: the oldest transition is removed past 16', () => {
    let history = emptyTransitionHistory()
    // Alternate between two legal states so every transition is legal.
    for (let i = 0; i < PHASE26_PRESENCE_LIMITS.maxTransitionHistoryEntries + 3; i += 1) {
      const from = i % 2 === 0 ? 'idle' : 'listening'
      const to = i % 2 === 0 ? 'listening' : 'idle'
      const result = applyTransition(history, from, to, `step ${i}`, NOW, 10)
      expect(result.ok).toBe(true)
      if (result.ok) history = result.history
    }
    expect(history.transitions.length).toBe(PHASE26_PRESENCE_LIMITS.maxTransitionHistoryEntries)
    expect(history.transitions[0]?.reason).toBe('step 3')
  })

  it('a same-state transition is a no-op', () => {
    const result = applyTransition(emptyTransitionHistory(), 'idle', 'idle', 'noop', NOW, 0)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.transition).toBeNull()
    expect(result.history.transitions.length).toBe(0)
  })

  it('transition.duration: non-finite and negative durations are refused fail-closed', () => {
    for (const durationMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -0.5]) {
      const result = applyTransition(emptyTransitionHistory(), 'idle', 'listening', 'x', NOW, durationMs)
      expect(result.ok).toBe(false)
    }
  })

  it('transition.duration: a finite upper clamp is preserved and NaN never enters history', () => {
    const huge = applyTransition(emptyTransitionHistory(), 'idle', 'listening', 'huge', NOW, 1e30)
    expect(huge.ok).toBe(true)
    if (huge.ok) {
      expect(huge.transition?.durationMs).toBe(Number.MAX_SAFE_INTEGER)
      expect(Number.isFinite(huge.transition?.durationMs ?? Number.NaN)).toBe(true)
    }
    const max = applyTransition(
      emptyTransitionHistory(),
      'idle',
      'listening',
      'max',
      NOW,
      Number.MAX_SAFE_INTEGER,
    )
    expect(max.ok).toBe(true)
    if (max.ok) expect(max.transition?.durationMs).toBe(Number.MAX_SAFE_INTEGER)
    // A NaN duration must never produce a history carrying a non-finite value.
    const nan = applyTransition(emptyTransitionHistory(), 'idle', 'listening', 'nan', NOW, Number.NaN)
    expect(nan.ok).toBe(false)
  })

  it('transition.reason: control characters are stripped and a control-only reason is refused', () => {
    const stripped = applyTransition(emptyTransitionHistory(), 'idle', 'listening', 'ok\u0000\u001f', NOW, 10)
    expect(stripped.ok).toBe(true)
    if (stripped.ok) expect(stripped.transition?.reason).toBe('ok')
    const controlOnly = applyTransition(
      emptyTransitionHistory(),
      'idle',
      'listening',
      '\u0000\u001f\u007f',
      NOW,
      10,
    )
    expect(controlOnly.ok).toBe(false)
  })
})
