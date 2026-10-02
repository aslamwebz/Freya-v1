import { describe, expect, it } from 'vitest'
import {
  PRESENCE_PROTOCOL_STATES,
  PRESENCE_ANIMATIONS,
  PRESENCE_SCHEMA_VERSION,
  PRESENCE_STATE_ANIMATION,
  isPresenceProtocolState,
  isPresenceAnimation,
  canTransitionPresence,
  validatePresenceFrame,
  type PresenceFrame,
} from '../../core/presence/protocol'

describe('presence protocol', () => {
  it('declares exactly the eight presence states', () => {
    expect(PRESENCE_PROTOCOL_STATES).toEqual([
      'idle',
      'listening',
      'thinking',
      'speaking',
      'working',
      'attention',
      'error',
      'degraded',
    ])
  })

  it('has a bounded animation vocabulary', () => {
    expect(PRESENCE_ANIMATIONS).toEqual([
      'breathe',
      'pulse',
      'spin',
      'wave',
      'glow',
      'alert',
      'dim',
    ])
  })

  it('maps each state to exactly one animation', () => {
    for (const state of PRESENCE_PROTOCOL_STATES) {
      expect(PRESENCE_STATE_ANIMATION[state]).toBeDefined()
      expect(PRESENCE_ANIMATIONS).toContain(PRESENCE_STATE_ANIMATION[state])
    }
  })

  it('allows idle to be reached from every state', () => {
    for (const state of PRESENCE_PROTOCOL_STATES) {
      expect(canTransitionPresence(state, 'idle')).toBe(true)
    }
  })

  it('treats error and degraded as terminal until cleared', () => {
    expect(canTransitionPresence('error', 'working')).toBe(false)
    expect(canTransitionPresence('error', 'listening')).toBe(false)
    expect(canTransitionPresence('error', 'idle')).toBe(true)
    expect(canTransitionPresence('degraded', 'working')).toBe(false)
    expect(canTransitionPresence('degraded', 'idle')).toBe(true)
  })

  it('allows adjacent transitions', () => {
    expect(canTransitionPresence('idle', 'listening')).toBe(true)
    expect(canTransitionPresence('listening', 'thinking')).toBe(true)
    expect(canTransitionPresence('thinking', 'working')).toBe(true)
    expect(canTransitionPresence('working', 'attention')).toBe(true)
  })

  it('always permits a transition to the current state', () => {
    for (const state of PRESENCE_PROTOCOL_STATES) {
      expect(canTransitionPresence(state, state)).toBe(true)
    }
  })

  it('rejects untrusted values', () => {
    expect(isPresenceProtocolState('idle')).toBe(true)
    expect(isPresenceProtocolState('warp')).toBe(false)
    expect(isPresenceProtocolState(undefined)).toBe(false)
    expect(isPresenceProtocolState(7)).toBe(false)
    expect(isPresenceAnimation('breathe')).toBe(true)
    expect(isPresenceAnimation('dance')).toBe(false)
  })
})

describe('presence frame validation', () => {
  const validFrame: PresenceFrame = {
    schemaVersion: PRESENCE_SCHEMA_VERSION,
    state: 'idle',
    animation: 'breathe',
    stateSince: Date.now(),
    detail: 'Standing by.',
    voiceCapture: { active: false, available: false, sessionId: null },
    voiceSynthesis: { active: false, available: false, label: null },
    attention: null,
    personalityCue: null,
    work: null,
    sequence: 0,
  }

  it('accepts a valid frame', () => {
    const result = validatePresenceFrame(validFrame)
    expect(typeof result).not.toBe('string')
  })

  it('refuses a frame with an unknown state', () => {
    const result = validatePresenceFrame({ ...validFrame, state: 'warp' })
    expect(result).toBe('presence state is invalid')
  })

  it('refuses a frame with an unknown animation', () => {
    const result = validatePresenceFrame({ ...validFrame, animation: 'dance' })
    expect(result).toBe('presence animation is invalid')
  })

  it('refuses an animation that does not correspond to the state', () => {
    const result = validatePresenceFrame({ ...validFrame, state: 'working', animation: 'breathe' })
    expect(result).toBe('presence animation does not match state')
  })

  it('refuses unknown top-level and nested keys', () => {
    expect(validatePresenceFrame({ ...validFrame, authority: 'owner' })).toBe('presence frame has invalid keys')
    expect(validatePresenceFrame({ ...validFrame, voiceCapture: { ...validFrame.voiceCapture, secret: true } })).toBe('voiceCapture has invalid keys')
  })

  it('refuses a frame with a wrong schema version', () => {
    const result = validatePresenceFrame({ ...validFrame, schemaVersion: 999 })
    expect(result).toBe(`presence schema version must be ${PRESENCE_SCHEMA_VERSION}`)
  })

  it('refuses a frame with a negative sequence', () => {
    const result = validatePresenceFrame({ ...validFrame, sequence: -1 })
    expect(result).toBe('presence sequence is invalid')
  })

  it('refuses a frame with an over-long detail', () => {
    const result = validatePresenceFrame({ ...validFrame, detail: 'x'.repeat(201) })
    expect(result).toBe('presence detail is invalid')
  })

  it('refuses a frame with an invalid voice capture', () => {
    const result = validatePresenceFrame({
      ...validFrame,
      voiceCapture: { active: 'yes', available: false, sessionId: null },
    })
    expect(result).toBe('voiceCapture.active is invalid')
  })

  it('refuses a frame with an invalid voice synthesis', () => {
    const result = validatePresenceFrame({
      ...validFrame,
      voiceSynthesis: { active: false, available: false, label: 42 },
    })
    expect(result).toBe('voiceSynthesis.label is invalid')
  })

  it('validates attention, personality and work recursively', () => {
    expect(validatePresenceFrame({ ...validFrame, attention: { eventId: 'e1' } })).toBe('presence attention has invalid keys')
    expect(validatePresenceFrame({ ...validFrame, personalityCue: { cueId: 'c1', kind: 'greeting', mode: 'offer', extra: true } })).toBe('presence personalityCue has invalid keys')
    expect(validatePresenceFrame({ ...validFrame, work: { running: 1, waiting: 0, awaitingApproval: 0, label: 'secret work' } })).toBe('presence work.label is invalid')
  })

  it('refuses a frame that is not an object', () => {
    expect(validatePresenceFrame(null)).toBe('presence frame is not an object')
    expect(validatePresenceFrame('frame')).toBe('presence frame is not an object')
    expect(validatePresenceFrame(42)).toBe('presence frame is not an object')
  })
})
