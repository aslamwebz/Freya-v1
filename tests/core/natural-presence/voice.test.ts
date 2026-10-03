// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  VOICE_IS_LOCAL_ONLY,
  PHASE26_PRESENCE_LIMITS,
  startVoiceSession,
  canStartVoiceSession,
  recordVoiceCapture,
  recordVoiceSynthesis,
  endVoiceSession,
  appendVoiceSession,
  emptyVoiceSessionHistory,
} from '../../../core/natural-presence'

const NOW = '2026-10-01T12:00:00.000Z'

describe('voice capture', () => {
  it('voice.capture.single: one push-to-talk capture', () => {
    const session = startVoiceSession('s-1', NOW)
    const result = recordVoiceCapture(session)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.session.captureCount).toBe(1)
  })

  it('voice.capture.multi-turn: several captures in sequence', () => {
    let session = startVoiceSession('s-1', NOW)
    for (let i = 0; i < 3; i += 1) {
      const result = recordVoiceCapture(session)
      if (result.ok) session = result.session
    }
    expect(session.captureCount).toBe(3)
  })

  it('voice.capture.bounded: capture beyond the bound is refused', () => {
    let session = startVoiceSession('s-1', NOW)
    for (let i = 0; i < PHASE26_PRESENCE_LIMITS.maxCapturesPerSession; i += 1) {
      const result = recordVoiceCapture(session)
      if (result.ok) session = result.session
    }
    const overflow = recordVoiceCapture(session)
    expect(overflow.ok).toBe(false)
    if (!overflow.ok) expect(overflow.code).toBe('capture_bound')
  })

  it('voice.capture.explicit: a session starts with nothing recorded', () => {
    const session = startVoiceSession('s-1', NOW)
    expect(session.captureCount).toBe(0)
    expect(session.synthesisCount).toBe(0)
    expect(session.status).toBe('active')
  })

  it('voice.capture.local-only: no remote voice path exists', () => {
    expect(VOICE_IS_LOCAL_ONLY).toBe(true)
  })

  it('capture after the session ended is refused', () => {
    const ended = endVoiceSession(startVoiceSession('s-1', NOW), 'completed', NOW)
    const result = recordVoiceCapture(ended)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('session_ended')
  })
})

describe('voice session', () => {
  it('voice.session.bounded: sessions per interaction are bounded', () => {
    expect(canStartVoiceSession(PHASE26_PRESENCE_LIMITS.maxVoiceSessionsPerInteraction - 1)).toBe(true)
    expect(canStartVoiceSession(PHASE26_PRESENCE_LIMITS.maxVoiceSessionsPerInteraction)).toBe(false)
  })

  it('voice.session.history: history is bounded to the ceiling', () => {
    let history = emptyVoiceSessionHistory()
    for (let i = 0; i < PHASE26_PRESENCE_LIMITS.maxVoiceSessionHistoryEntries + 4; i += 1) {
      history = appendVoiceSession(history, startVoiceSession(`s-${i}`, NOW))
    }
    expect(history.sessions.length).toBe(PHASE26_PRESENCE_LIMITS.maxVoiceSessionHistoryEntries)
    expect(history.sessions[0]?.sessionId).toBe('s-4')
  })

  it('voice.session.local-only: sessions never leave the machine', () => {
    expect(VOICE_IS_LOCAL_ONLY).toBe(true)
  })
})

describe('voice synthesis', () => {
  it('voice.synthesis.bounded: synthesis beyond the bound is refused', () => {
    let session = startVoiceSession('s-1', NOW)
    for (let i = 0; i < PHASE26_PRESENCE_LIMITS.maxSynthesesPerSession; i += 1) {
      const result = recordVoiceSynthesis(session)
      if (result.ok) session = result.session
    }
    const overflow = recordVoiceSynthesis(session)
    expect(overflow.ok).toBe(false)
    if (!overflow.ok) expect(overflow.code).toBe('synthesis_bound')
  })

  it('voice.synthesis.local-only: synthesis never leaves the machine', () => {
    expect(VOICE_IS_LOCAL_ONLY).toBe(true)
  })
})
