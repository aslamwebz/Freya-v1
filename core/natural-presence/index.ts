/**
 * THE NATURAL PRESENCE DOMAIN — Phase 26.
 *
 * The only file outside `core/natural-presence/` should import. Everything here
 * is pure: a deterministic state machine, bounded transitions and history,
 * embodiment cues derived from real Core state, a local-only bounded voice
 * domain, and the expanded presence frame. No I/O, no clock reads except
 * through an injected instant, no randomness, no model, no invented state.
 *
 * The core invariant:
 *
 * > **Presence is a projection of real Core state, not an invention of internal
 * > state. Richer presence does not mean richer claims about what Freya is.**
 */

export {
  PHASE26_PRESENCE_STATES,
  PHASE26_ANIMATIONS,
  PHASE26_STATE_ANIMATION,
  PHASE26_PRESENCE_SCHEMA_VERSION,
  PHASE26_PRESENCE_LIMITS,
  EMBODIMENT_CUE_TYPES,
  EMBODIMENT_CUE_LABELS,
  isPhase26PresenceState,
  isPhase26Animation,
  isEmbodimentCueType,
  instantMs,
  isPresenceId,
  type Phase26PresenceState,
  type Phase26Animation,
  type PresenceTransition,
  type TransitionHistory,
  type EmbodimentCueType,
  type EmbodimentCue,
  type EmbodimentCueList,
  type VoiceSession,
  type VoiceSessionHistory,
  type VoiceInteractionPattern,
  type Phase26VoiceCapture,
  type Phase26VoiceSynthesis,
  type Phase26WorkSummary,
  type Phase26PresenceFrame,
} from './types'

export {
  derivePhase26PresenceState,
  phase26Animation,
  phase26Detail,
  type Phase26PresenceInput,
} from './stateMachine'

export {
  canTransitionPresence,
  emptyTransitionHistory,
  transitionTimedOut,
  applyTransition,
  ALL_PRESENCE_STATES,
  type TransitionResult,
} from './transitions'

export {
  deriveEmbodimentCues,
  emptyEmbodimentCueList,
  type CueInputs,
  type CueAttention,
  type CueWork,
} from './cues'

export {
  VOICE_IS_LOCAL_ONLY,
  VOICE_REFUSAL_CODES,
  VOICE_REFUSAL_REASONS,
  emptyVoiceSessionHistory,
  startVoiceSession,
  canStartVoiceSession,
  recordVoiceCapture,
  recordVoiceSynthesis,
  endVoiceSession,
  appendVoiceSession,
  type VoiceRefusalCode,
  type VoiceResult,
} from './voice'

export {
  PHASE26_FRAME_MAX_AGE_MS,
  buildPhase26Frame,
  minimalPhase26Frame,
  isPhase26FrameExpired,
  validatePhase26Frame,
  type Phase26FrameInput,
  type Phase26FrameVoice,
} from './frame'
