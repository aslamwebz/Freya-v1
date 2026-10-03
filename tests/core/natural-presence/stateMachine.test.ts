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
  type Phase26PresenceInput,
} from '../../../core/natural-presence'

const NOW = '2026-10-01T12:00:00.000Z'

function input(over: Partial<Phase26PresenceInput> = {}): Phase26PresenceInput {
  return {
    stopAllActive: false,
    integrityCorrupt: false,
    degraded: false,
    synthesisActive: false,
    captureActive: false,
    cognitionRequested: false,
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

  it('derive.thinking: cognition requested', () => {
    expect(derivePhase26PresenceState(input({ cognitionRequested: true }))).toBe('thinking')
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

  it('animation and detail are fixed per state', () => {
    expect(phase26Animation('idle')).toBe('breathe')
    expect(phase26Animation('speaking')).toBe('wave')
    expect(phase26Detail('idle', input())).toBe('Standing by.')
    expect(phase26Detail('error', input({ stopAllActive: true }))).toContain('Stopped')
  })
})

describe('presence.transition', () => {
  it('allows the eight expanded transitions', () => {
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
})
