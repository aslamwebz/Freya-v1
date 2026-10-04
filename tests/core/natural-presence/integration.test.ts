// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  buildPhase26Frame,
  validatePhase26Frame,
  deriveEmbodimentCues,
  derivePhase26PresenceState,
  applyTransition,
  emptyTransitionHistory,
  startVoiceSession,
  recordVoiceCapture,
  endVoiceSession,
  appendVoiceSession,
  emptyVoiceSessionHistory,
  emptyEmbodimentCueList,
  type Phase26PresenceInput,
  type Phase26FrameInput,
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
    sequence: 1,
    transitionHistory: emptyTransitionHistory(),
    embodimentCues: emptyEmbodimentCueList(),
    voiceSessionHistory: emptyVoiceSessionHistory(),
    ...over,
  }
}

describe('integration: core to frame', () => {
  it('integration.core-to-frame: real Core facts produce a frame', () => {
    const frame = buildPhase26Frame(
      frameInput({ presence: presence({ runExecuting: true, providerCallInFlight: false }) }),
    )
    expect(frame.state).toBe('working')
    expect(frame.sequence).toBe(1)
  })

  it('integration.core-to-renderer: the frame validates before a renderer draws it', () => {
    const frame = buildPhase26Frame(
      frameInput({ presence: presence({ attentionDirective: { eventId: 'e-1' } }) }),
    )
    const validated = validatePhase26Frame(frame)
    expect(typeof validated).not.toBe('string')
    if (typeof validated !== 'string') expect(validated.state).toBe('attention')
  })
})

describe('integration: transition flow', () => {
  it('integration.transition-flow: transition becomes history then frame', () => {
    let history = emptyTransitionHistory()
    const first = applyTransition(history, 'idle', 'listening', 'capture started', NOW, 30)
    if (first.ok) history = first.history
    const second = applyTransition(history, 'listening', 'working', 'provider call in flight', NOW, 40)
    if (second.ok) history = second.history

    const frame = buildPhase26Frame(
      frameInput({ transitionHistory: history, presence: presence({ providerCallInFlight: true }) }),
    )
    expect(frame.state).toBe('working')
    expect(frame.transitionHistory.transitions.length).toBe(2)
    expect(frame.transitionHistory.transitions[1]?.to).toBe('working')
  })
})

describe('integration: voice flow', () => {
  it('integration.voice-flow: capture becomes a session then history then frame', () => {
    let session = startVoiceSession('s-1', NOW)
    for (let i = 0; i < 2; i += 1) {
      const result = recordVoiceCapture(session)
      if (result.ok) session = result.session
    }
    session = endVoiceSession(session, 'completed', NOW)
    const history = appendVoiceSession(emptyVoiceSessionHistory(), session)

    const frame = buildPhase26Frame(
      frameInput({
        voiceSessionHistory: history,
        voice: {
          captureActive: false,
          captureAvailable: true,
          sessionId: null,
          synthesisActive: false,
          synthesisAvailable: true,
          synthesisLabel: null,
        },
      }),
    )
    expect(frame.voiceSessionHistory.sessions[0]?.captureCount).toBe(2)
    expect(frame.voiceSessionHistory.sessions[0]?.status).toBe('completed')
  })
})

describe('integration: cue flow', () => {
  it('integration.cue-flow: Core facts become a cue then a frame', () => {
    const cues = deriveEmbodimentCues({
      attention: { present: true, importance: 'urgent' },
      work: { running: 1, waiting: 0, awaitingApproval: 0 },
      voiceCaptureActive: false,
      voiceSynthesisActive: false,
      personalityCueActive: false,
      now: NOW,
    })
    const frame = buildPhase26Frame(
      frameInput({
        presence: presence({ attentionDirective: { eventId: 'e-1' }, runExecuting: true }),
        embodimentCues: cues,
      }),
    )
    expect(frame.embodimentCues.cues.map((c) => c.cueType)).toEqual(['attention-urgent', 'work-running'])
    expect(frame.state).toBe('working')
  })

  it('is deterministic end to end', () => {
    const build = (): string =>
      JSON.stringify(buildPhase26Frame(frameInput({ presence: presence({ captureActive: true }) })))
    expect(build()).toBe(build())
    expect(derivePhase26PresenceState(presence({ captureActive: true }))).toBe('listening')
  })
})
