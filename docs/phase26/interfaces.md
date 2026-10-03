/**
 * Phase 26 — Compile-Time Types and Interfaces
 *
 * **Status:** PREPARATION ONLY — NOT PRODUCTION
 *
 * These types and interfaces are compile-time only. They cannot activate
 * runtime behavior. They define the shape of Phase 26's components.
 *
 * These types are safe to cherry-pick later. They do not import any runtime
 * module. They do not create any side effects. They are pure type definitions.
 */

/* --------------------------------------------------------- presence states */

/**
 * The closed set of presence states.
 *
 * The 8 states are canonical. Phase 26 does not add new states.
 */
export const PHASE26_PRESENCE_STATES = [
  'idle',
  'listening',
  'thinking',
  'speaking',
  'working',
  'attention',
  'error',
  'degraded',
] as const
export type Phase26PresenceState = (typeof PHASE26_PRESENCE_STATES)[number]

export function isPhase26PresenceState(value: unknown): value is Phase26PresenceState {
  return typeof value === 'string' && (PHASE26_PRESENCE_STATES as readonly string[]).includes(value)
}

/* --------------------------------------------------------- transitions */

/**
 * A presence state transition.
 *
 * Bounded and derived from real Core state. A renderer may not invent a
 * transition.
 */
export interface PresenceTransition {
  readonly from: Phase26PresenceState
  readonly to: Phase26PresenceState
  readonly reason: string
  readonly occurredAt: string
  readonly durationMs: number
}

/**
 * The bounded transition history.
 *
 * A maximum of 16 entries. The most recent transition is last.
 */
export interface TransitionHistory {
  readonly transitions: readonly PresenceTransition[]
  readonly maxEntries: number
}

/* --------------------------------------------------------- embodiment cues */

/**
 * The closed set of embodiment cue types.
 *
 * Every cue is derived from real Core state. No cue is invented.
 */
export const EMBODIMENT_CUE_TYPES = [
  'attention-urgent',
  'attention-normal',
  'work-running',
  'work-waiting',
  'work-approval',
  'voice-listening',
  'voice-speaking',
  'personality-cue',
] as const
export type EmbodimentCueType = (typeof EMBODIMENT_CUE_TYPES)[number]

export function isEmbodimentCueType(value: unknown): value is EmbodimentCueType {
  return typeof value === 'string' && (EMBODIMENT_CUE_TYPES as readonly string[]).includes(value)
}

/**
 * An embodiment cue.
 *
 * Bounded and derived from real Core state.
 */
export interface EmbodimentCue {
  readonly cueType: EmbodimentCueType
  readonly label: string
  readonly derivedFrom: string
  readonly active: boolean
  readonly activatedAt: string | null
}

/**
 * The bounded embodiment cue list.
 *
 * A maximum of 8 cues. Only active cues are included.
 */
export interface EmbodimentCueList {
  readonly cues: readonly EmbodimentCue[]
  readonly maxEntries: number
}

/* --------------------------------------------------------- voice sessions */

/**
 * A voice session.
 *
 * Bounded and derived from real Core state.
 */
export interface VoiceSession {
  readonly sessionId: string
  readonly startedAt: string
  readonly endedAt: string | null
  readonly captureCount: number
  readonly synthesisCount: number
  readonly status: 'active' | 'completed' | 'cancelled' | 'failed'
}

/**
 * The bounded voice session history.
 *
 * A maximum of 8 entries. The most recent session is last.
 */
export interface VoiceSessionHistory {
  readonly sessions: readonly VoiceSession[]
  readonly maxEntries: number
}

/* --------------------------------------------------------- presence frame */

/**
 * The expanded presence frame.
 *
 * All new fields are derived from real Core state.
 */
export interface Phase26PresenceFrame {
  readonly schemaVersion: number
  readonly state: Phase26PresenceState
  readonly animation: string
  readonly stateSince: number
  readonly detail: string
  readonly voiceCapture: {
    readonly active: boolean
    readonly available: boolean
    readonly sessionId: string | null
  }
  readonly voiceSynthesis: {
    readonly active: boolean
    readonly available: boolean
    readonly label: string | null
  }
  readonly attention: unknown | null
  readonly personalityCue: unknown | null
  readonly work: {
    readonly running: number
    readonly waiting: number
    readonly awaitingApproval: number
    readonly label: string | null
  } | null
  readonly sequence: number
  readonly transitionHistory: TransitionHistory
  readonly embodimentCues: EmbodimentCueList
  readonly voiceSessionHistory: VoiceSessionHistory
}

/* --------------------------------------------------------- voice interaction */

/**
 * A voice interaction pattern.
 *
 * Bounded and derived from real Core state.
 */
export interface VoiceInteractionPattern {
  readonly patternId: string
  readonly kind: 'push-to-talk' | 'multi-turn' | 'voice-session'
  readonly captureCount: number
  readonly synthesisCount: number
  readonly startedAt: string
  readonly endedAt: string | null
  readonly status: 'active' | 'completed' | 'cancelled' | 'failed'
}

/* --------------------------------------------------------- limits */

/**
 * The ceilings of Phase 26 presence.
 *
 * Code-owned and unraisable. A caller may lower a ceiling and may never
 * raise one.
 */
export const PHASE26_PRESENCE_LIMITS = Object.freeze({
  /** Maximum transition history entries. */
  maxTransitionHistoryEntries: 16,
  /** Maximum embodiment cues. */
  maxEmbodimentCues: 8,
  /** Maximum voice session history entries. */
  maxVoiceSessionHistoryEntries: 8,
  /** Maximum voice sessions in a single interaction. */
  maxVoiceSessionsPerInteraction: 4,
  /** Maximum captures in a single voice session. */
  maxCapturesPerSession: 8,
  /** Maximum syntheses in a single voice session. */
  maxSynthesesPerSession: 8,
  /** Maximum characters in a presence detail string. */
  maxDetailChars: 200,
  /** Maximum characters in an embodiment cue label. */
  maxCueLabelChars: 128,
  /** Maximum transition duration in milliseconds. */
  maxTransitionDurationMs: 5_000,
})
