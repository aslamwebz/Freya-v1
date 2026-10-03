// @vitest-environment node
import { describe, expect, it } from 'vitest'
import * as presence from '../../core/natural-presence'
import {
  buildPhase26Frame,
  validatePhase26Frame,
  derivePhase26PresenceState,
  emptyTransitionHistory,
  emptyEmbodimentCueList,
  emptyVoiceSessionHistory,
  PHASE26_PRESENCE_LIMITS,
  EMBODIMENT_CUE_TYPES,
  type Phase26PresenceInput,
  type Phase26FrameInput,
} from '../../core/natural-presence'

/**
 * Attack family: presence is a projection, not an invention.
 *
 * Phase 26 makes Freya's presence richer. These attacks try to make a renderer
 * (or an input) invent a mood, an emotion, a mental state, a personality
 * trait, a presence state, an animation or a cue — or to mint authority
 * through the presence layer.
 *
 * The invariant under attack:
 *
 * > Presence is a projection of real Core state, not an invention of internal
 * > state.
 */

const NOW = '2026-10-01T12:00:00.000Z'
const NOW_MS = Date.parse(NOW)

function presenceInput(over: Partial<Phase26PresenceInput> = {}): Phase26PresenceInput {
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
    presence: presenceInput(),
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

describe('redteam: no invented internal state', () => {
  it('invent-mood: the vocabulary has no mood', () => {
    expect(Object.keys(presence).filter((key) => /mood|feeling|affect/i.test(key))).toEqual([])
  })

  it('invent-emotion: the vocabulary has no emotion', () => {
    expect(Object.keys(presence).filter((key) => /emotion|sentiment/i.test(key))).toEqual([])
  })

  it('invent-mental-state: the vocabulary has no mental state', () => {
    expect(Object.keys(presence).filter((key) => /mental|conscious|inner|subjective/i.test(key))).toEqual([])
  })

  it('invent-personality: the vocabulary has no personality trait', () => {
    expect(Object.keys(presence).filter((key) => /personalityTrait|trait/i.test(key))).toEqual([])
  })

  it('invent-presence-state: a frame with an unknown state is refused', () => {
    const frame = buildPhase26Frame(frameInput())
    expect(validatePhase26Frame({ ...frame, state: 'elated' })).toBeTypeOf('string')
  })

  it('invent-thinking: the reserved thinking state cannot be reached from any fact', () => {
    // Phase 13 parity. A provider call in flight is `working`; there is no live
    // "cognition requested" Core fact. Inventing one would let a submitted
    // command make Freya look busy, so no input may produce `thinking`.
    expect(derivePhase26PresenceState(presenceInput({ providerCallInFlight: true }))).toBe('working')
    const frame = buildPhase26Frame(
      frameInput({ presence: presenceInput({ providerCallInFlight: true }) }),
    )
    expect(frame.state).toBe('working')
    expect(frame.animation).toBe('glow')
  })

  it('invent-animation: a frame with an unknown animation is refused', () => {
    const frame = buildPhase26Frame(frameInput())
    expect(validatePhase26Frame({ ...frame, animation: 'sparkle' })).toBeTypeOf('string')
  })

  it('invent-cue: a frame with an unknown cue type is refused', () => {
    const frame = buildPhase26Frame(frameInput())
    const invented = {
      ...frame,
      embodimentCues: {
        maxEntries: PHASE26_PRESENCE_LIMITS.maxEmbodimentCues,
        cues: [
          { cueType: 'joyful', label: 'Happy', derivedFrom: 'mood', active: true, activatedAt: NOW },
        ],
      },
    }
    expect(validatePhase26Frame(invented)).toBeTypeOf('string')
  })

  it('the cue vocabulary is closed and code-owned', () => {
    expect(EMBODIMENT_CUE_TYPES).toContain('attention-urgent')
    expect(EMBODIMENT_CUE_TYPES).not.toContain('joyful')
  })
})

describe('redteam: presence mints no authority', () => {
  it('worker-claims-capability and worker-claims-authority: no capability vocabulary', () => {
    expect(Object.keys(presence).filter((key) => /capabilit|authoriz|principal|owner/i.test(key))).toEqual([])
  })

  it('worker-claims-budget: no budget vocabulary', () => {
    expect(Object.keys(presence).filter((key) => /budget|spend|cost/i.test(key))).toEqual([])
  })

  it('worker-claims-approval and self-approve: no approval vocabulary', () => {
    expect(Object.keys(presence).filter((key) => /approv/i.test(key))).toEqual([])
  })

  it('create-grant: no grant mint', () => {
    expect(Object.keys(presence).filter((key) => /createGrant|grant|mint/i.test(key))).toEqual([])
  })

  it('bypass-guard and bypass-governor: no guard or governor', () => {
    expect(Object.keys(presence).filter((key) => /guard|governor|bypass/i.test(key))).toEqual([])
  })

  it('hidden-inference and continuous-polling: no model or timer', () => {
    expect(Object.keys(presence).filter((key) => /provider|model|poll|interval|setTimeout|timer/i.test(key))).toEqual([])
  })

  it('widen-capability: the limits are frozen and unraisable', () => {
    expect(Object.isFrozen(PHASE26_PRESENCE_LIMITS)).toBe(true)
    // A frame claiming a cue list larger than the ceiling fails validation.
    const frame = buildPhase26Frame(frameInput())
    const oversized = {
      ...frame,
      embodimentCues: {
        maxEntries: PHASE26_PRESENCE_LIMITS.maxEmbodimentCues + 1,
        cues: [],
      },
    }
    expect(validatePhase26Frame(oversized)).toBeTypeOf('string')
  })
})

describe('redteam: STOP ALL outranks everything', () => {
  it('bypass-stop-all: STOP ALL forces error whatever else is true', () => {
    const state = derivePhase26PresenceState(
      presenceInput({
        stopAllActive: true,
        synthesisActive: true,
        runExecuting: true,
        attentionDirective: { eventId: 'e' },
        personalityCue: { cueId: 'c' },
      }),
    )
    expect(state).toBe('error')
  })

  it('exceed-budget and skip-approval: there is no budget or approval to skip', () => {
    expect(Object.keys(presence).filter((key) => /budget|approv/i.test(key))).toEqual([])
  })
})

describe('redteam: a claim cannot become a state', () => {
  it('model-claims-urgency: an opaque attention value cannot invent a state beyond attention', () => {
    const state = derivePhase26PresenceState(
      presenceInput({ attentionDirective: { claim: 'critical', urgency: 'now' } }),
    )
    expect(state).toBe('attention')
  })

  it('context-claims-authority: an unknown frame key is refused', () => {
    const frame = buildPhase26Frame(frameInput())
    expect(validatePhase26Frame({ ...frame, authority: 'owner' })).toBeTypeOf('string')
  })
})
