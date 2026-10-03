// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  buildPhase26Frame,
  minimalPhase26Frame,
  isPhase26FrameExpired,
  validatePhase26Frame,
  emptyTransitionHistory,
  emptyEmbodimentCueList,
  emptyVoiceSessionHistory,
  applyTransition,
  PHASE26_FRAME_MAX_AGE_MS,
  PHASE26_PRESENCE_LIMITS,
  type Phase26FrameInput,
  type Phase26PresenceInput,
} from '../../../core/natural-presence'

const NOW = '2026-10-01T12:00:00.000Z'
const NOW_MS = Date.parse(NOW)

function presence(over: Partial<Phase26PresenceInput> = {}): Phase26PresenceInput {
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

function frameInput(over: Partial<Phase26FrameInput> = {}): Phase26FrameInput {
  return {
    presence: presence(),
    stateSince: NOW_MS,
    voice: {
      captureActive: false,
      captureAvailable: true,
      sessionId: null,
      synthesisActive: false,
      synthesisAvailable: true,
      synthesisLabel: null,
    },
    work: null,
    sequence: 7,
    transitionHistory: emptyTransitionHistory(),
    embodimentCues: emptyEmbodimentCueList(),
    voiceSessionHistory: emptyVoiceSessionHistory(),
    ...over,
  }
}

describe('frame construction', () => {
  it('frame.creation: a frame is created from real Core state', () => {
    const frame = buildPhase26Frame(frameInput())
    expect(frame.schemaVersion).toBe(2)
    expect(frame.state).toBe('idle')
    expect(frame.animation).toBe('breathe')
    expect(validatePhase26Frame(frame)).not.toBeTypeOf('string')
  })

  it('frame.update: a changed Core fact changes the frame', () => {
    const idle = buildPhase26Frame(frameInput())
    const working = buildPhase26Frame(frameInput({ presence: presence({ runExecuting: true }) }))
    expect(idle.state).toBe('idle')
    expect(working.state).toBe('working')
    expect(working.animation).toBe('glow')
  })

  it('frame.stop-all: STOP ALL produces error', () => {
    const frame = buildPhase26Frame(frameInput({ presence: presence({ stopAllActive: true }) }))
    expect(frame.state).toBe('error')
  })

  it('frame.degraded: a faulted subsystem produces degraded', () => {
    const frame = buildPhase26Frame(frameInput({ presence: presence({ degraded: true }) }))
    expect(frame.state).toBe('degraded')
  })

  it('frame.expiry: a frame older than the bound has expired', () => {
    const frame = buildPhase26Frame(frameInput())
    expect(isPhase26FrameExpired(frame, NOW_MS + PHASE26_FRAME_MAX_AGE_MS)).toBe(false)
    expect(isPhase26FrameExpired(frame, NOW_MS + PHASE26_FRAME_MAX_AGE_MS + 1)).toBe(true)
  })

  it('minimalPhase26Frame claims nothing', () => {
    const frame = minimalPhase26Frame(NOW_MS)
    expect(frame.state).toBe('idle')
    expect(frame.embodimentCues.cues).toEqual([])
    expect(frame.transitionHistory.transitions).toEqual([])
    expect(frame.voiceSessionHistory.sessions).toEqual([])
  })
})

describe('frame bounds', () => {
  it('frame.transition-history: history is bounded to 16', () => {
    let history = emptyTransitionHistory()
    for (let i = 0; i < 20; i += 1) {
      const result = applyTransition(history, i % 2 === 0 ? 'idle' : 'listening', i % 2 === 0 ? 'listening' : 'idle', `t${i}`, NOW, 5)
      if (result.ok) history = result.history
    }
    const frame = buildPhase26Frame(frameInput({ transitionHistory: history }))
    expect(frame.transitionHistory.transitions.length).toBe(
      PHASE26_PRESENCE_LIMITS.maxTransitionHistoryEntries,
    )
    expect(validatePhase26Frame(frame)).not.toBeTypeOf('string')
  })

  it('frame.embodiment-cues: the cue list is bounded', () => {
    const frame = buildPhase26Frame(frameInput())
    expect(frame.embodimentCues.cues.length).toBeLessThanOrEqual(
      PHASE26_PRESENCE_LIMITS.maxEmbodimentCues,
    )
  })

  it('frame.voice-session-history: session history is bounded', () => {
    const frame = buildPhase26Frame(frameInput())
    expect(frame.voiceSessionHistory.sessions.length).toBeLessThanOrEqual(
      PHASE26_PRESENCE_LIMITS.maxVoiceSessionHistoryEntries,
    )
  })
})

describe('frame.no-invented-state', () => {
  it('refuses an invented presence state', () => {
    const frame = buildPhase26Frame(frameInput())
    const invented = { ...frame, state: 'elated' }
    expect(validatePhase26Frame(invented)).toBeTypeOf('string')
  })

  it('refuses an animation that does not match the state', () => {
    const frame = buildPhase26Frame(frameInput())
    const invented = { ...frame, animation: 'sparkle' }
    expect(validatePhase26Frame(invented)).toBeTypeOf('string')
  })

  it('refuses an invented cue type', () => {
    const frame = buildPhase26Frame(frameInput())
    const invented = {
      ...frame,
      embodimentCues: {
        maxEntries: 8,
        cues: [{ cueType: 'joyful', label: 'Happy', derivedFrom: 'mood', active: true, activatedAt: NOW }],
      },
    }
    expect(validatePhase26Frame(invented)).toBeTypeOf('string')
  })

  it('refuses an unknown key on the frame', () => {
    const frame = buildPhase26Frame(frameInput())
    expect(validatePhase26Frame({ ...frame, mood: 'happy' })).toBeTypeOf('string')
  })
})
