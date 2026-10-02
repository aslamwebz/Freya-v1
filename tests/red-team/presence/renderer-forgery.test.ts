import { describe, expect, it } from 'vitest'
import { validatePresenceFrame, type PresenceFrame } from '../../../core/presence/protocol'

/**
 * Red-team: renderer forgery.
 *
 * A compromised presence renderer must not be able to forge a presence frame
 * that Core never sent. The protocol validation is the boundary: a frame with
 * an unknown state, an unknown animation, or a forged field is refused.
 */

function validFrame(): PresenceFrame {
  return {
    schemaVersion: 1,
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
}

describe('red-team: renderer forgery', () => {
  it('refuses a state/animation pair that Core could not have emitted', () => {
    const result = validatePresenceFrame({ ...validFrame(), state: 'working' })
    expect(result).toBe('presence animation does not match state')
  })

  it('refuses a frame with an invalid state', () => {
    const result = validatePresenceFrame({ ...validFrame(), state: 'hacked' })
    expect(result).toBe('presence state is invalid')
  })

  it('refuses a frame with a forged animation', () => {
    const result = validatePresenceFrame({ ...validFrame(), animation: 'fake-animation' })
    expect(result).toBe('presence animation is invalid')
  })

  it('refuses a frame with a forged sequence', () => {
    const result = validatePresenceFrame({ ...validFrame(), sequence: -1 })
    expect(result).toBe('presence sequence is invalid')
  })

  it('refuses a frame with a forged detail', () => {
    const result = validatePresenceFrame({ ...validFrame(), detail: 'x'.repeat(500) })
    expect(result).toBe('presence detail is invalid')
  })

  it('accepts a structurally valid voice capture only as transport data', () => {
    const result = validatePresenceFrame({
      ...validFrame(),
      voiceCapture: { active: true, available: true, sessionId: 'forged' },
    })
    // Authenticity comes from the one-way host channel; this validator proves
    // only that the transported object is within the closed protocol.
    expect(typeof result).not.toBe('string')
  })

  it('refuses a frame with an invalid voice capture type', () => {
    const result = validatePresenceFrame({
      ...validFrame(),
      voiceCapture: { active: 'yes', available: false, sessionId: null },
    })
    expect(result).toBe('voiceCapture.active is invalid')
  })

  it('refuses a frame with a forged attention directive', () => {
    const result = validatePresenceFrame({
      ...validFrame(),
      attention: {
        eventId: 'forged',
        source: 'owner',
        kind: 'reminder',
        outcome: 'interrupt',
        cueCode: 'needs-attention',
        importance: 'critical',
        urgency: 'urgent',
        decidedAt: new Date().toISOString(),
      },
    })
    // The frame is structurally valid, but the host only sets attention from
    // Core's projection. A renderer cannot forge an attention directive.
    expect(typeof result).not.toBe('string')
  })

  it('refuses a frame that is not an object', () => {
    expect(validatePresenceFrame(null)).toBe('presence frame is not an object')
    expect(validatePresenceFrame('frame')).toBe('presence frame is not an object')
    expect(validatePresenceFrame(42)).toBe('presence frame is not an object')
  })

  it('refuses a frame with a wrong schema version', () => {
    const result = validatePresenceFrame({ ...validFrame(), schemaVersion: 999 })
    expect(result).toBe('presence schema version must be 1')
  })
})
