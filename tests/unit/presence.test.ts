import { describe, expect, it } from 'vitest'
import { canTransition, isPresenceState, PRESENCE_DETAIL, PRESENCE_STATES } from '../../src/core/presence'

describe('presence model', () => {
  it('declares every state the design calls for', () => {
    expect(PRESENCE_STATES).toContain('idle')
    expect(PRESENCE_STATES).toContain('listening')
    expect(PRESENCE_STATES).toContain('thinking')
    expect(PRESENCE_STATES).toContain('working')
    expect(PRESENCE_STATES).toContain('needs-user')
  })

  it('has a human line for every state', () => {
    for (const state of PRESENCE_STATES) {
      expect(PRESENCE_DETAIL[state].length).toBeGreaterThan(0)
    }
  })

  it('allows idle to be reached from every non-locked, non-error state', () => {
    for (const state of PRESENCE_STATES) {
      if (state === 'locked' || state === 'error') continue
      expect(canTransition(state, 'idle')).toBe(true)
    }
  })

  it('treats locked and error as terminal until cleared', () => {
    expect(canTransition('locked', 'working')).toBe(false)
    expect(canTransition('locked', 'idle')).toBe(true)
    expect(canTransition('error', 'listening')).toBe(false)
    expect(canTransition('error', 'idle')).toBe(true)
  })

  it('lets thinking become working and working become needs-user', () => {
    expect(canTransition('thinking', 'working')).toBe(true)
    expect(canTransition('working', 'needs-user')).toBe(true)
    expect(canTransition('needs-user', 'working')).toBe(true)
  })

  it('always permits a transition to the current state', () => {
    for (const state of PRESENCE_STATES) {
      expect(canTransition(state, state)).toBe(true)
    }
  })

  it('rejects untrusted values from a persisted file', () => {
    expect(isPresenceState('idle')).toBe(true)
    expect(isPresenceState('warp')).toBe(false)
    expect(isPresenceState(undefined)).toBe(false)
    expect(isPresenceState(7)).toBe(false)
  })
})
