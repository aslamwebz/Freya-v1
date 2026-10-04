/**
 * THE NATURAL PRESENCE DOMAIN — Phase 26's vocabulary.
 *
 * Natural Presence expands the richness of Freya's voice, embodiment and
 * transitions **without inventing internal state**. Every presence state, cue
 * and transition is derived from real Core state. This file is the vocabulary
 * only: closed tables, limits and shapes — no logic, no I/O, no clock.
 *
 * ## The core invariant
 *
 * > **Presence is a projection of real Core state, not an invention of internal
 * > state. Richer presence does not mean richer claims about what Freya is.**
 *
 * There is deliberately no `mood`, no `emotion`, no `mentalState` and no
 * `personalityTrait` anywhere in this vocabulary. A cue names something Core
 * observed; it never claims a feeling.
 */

/* ------------------------------------------------------- presence states */

/**
 * The closed set of presence states.
 *
 * The eight states are canonical. Phase 26 adds transitions and history; it
 * adds no new states.
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

/* ------------------------------------------------------------ animations */

/**
 * The bounded animation vocabulary.
 *
 * Every animation is a code-owned label. A renderer may not invent one, and
 * the mapping from state to animation is fixed here.
 */
export const PHASE26_ANIMATIONS = ['breathe', 'pulse', 'spin', 'wave', 'glow', 'alert', 'dim'] as const
export type Phase26Animation = (typeof PHASE26_ANIMATIONS)[number]

export function isPhase26Animation(value: unknown): value is Phase26Animation {
  return typeof value === 'string' && (PHASE26_ANIMATIONS as readonly string[]).includes(value)
}

/** The one animation each state maps to. Fixed by the protocol. */
export const PHASE26_STATE_ANIMATION: Readonly<Record<Phase26PresenceState, Phase26Animation>> =
  Object.freeze({
    idle: 'breathe',
    listening: 'pulse',
    thinking: 'spin',
    speaking: 'wave',
    working: 'glow',
    attention: 'alert',
    error: 'alert',
    degraded: 'dim',
  })

/* ---------------------------------------------------------- transitions */

/** A presence state transition. Derived, bounded and never invented. */
export interface PresenceTransition {
  readonly from: Phase26PresenceState
  readonly to: Phase26PresenceState
  readonly reason: string
  readonly occurredAt: string
  readonly durationMs: number
  readonly timedOut: boolean
}

/** The bounded transition history. The most recent transition is last. */
export interface TransitionHistory {
  readonly transitions: readonly PresenceTransition[]
  readonly maxEntries: number
}

/* -------------------------------------------------------- embodiment cues */

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

/** The code-owned label for each cue type. Never a mental-state claim. */
export const EMBODIMENT_CUE_LABELS: Readonly<Record<EmbodimentCueType, string>> = Object.freeze({
  'attention-urgent': 'Something urgent needs you',
  'attention-normal': 'Something needs you',
  'work-running': 'A run is executing',
  'work-waiting': 'A run is waiting',
  'work-approval': 'A run is waiting for your decision',
  'voice-listening': 'Listening',
  'voice-speaking': 'Speaking',
  'personality-cue': 'Expressing a cue',
})

/** An embodiment cue. Bounded and derived from real Core state. */
export interface EmbodimentCue {
  readonly cueType: EmbodimentCueType
  readonly label: string
  readonly derivedFrom: string
  readonly active: boolean
  readonly activatedAt: string | null
}

/** The bounded embodiment cue list. Only active cues are included. */
export interface EmbodimentCueList {
  readonly cues: readonly EmbodimentCue[]
  readonly maxEntries: number
}

/* --------------------------------------------------------- voice sessions */

/** A voice session. Bounded and derived from real Core state. */
export interface VoiceSession {
  readonly sessionId: string
  readonly startedAt: string
  readonly endedAt: string | null
  readonly captureCount: number
  readonly synthesisCount: number
  readonly status: 'active' | 'completed' | 'cancelled' | 'failed'
}

/** The bounded voice session history. The most recent session is last. */
export interface VoiceSessionHistory {
  readonly sessions: readonly VoiceSession[]
  readonly maxEntries: number
}

/** A voice interaction pattern. Bounded and derived from real Core state. */
export interface VoiceInteractionPattern {
  readonly patternId: string
  readonly kind: 'push-to-talk' | 'multi-turn' | 'voice-session'
  readonly captureCount: number
  readonly synthesisCount: number
  readonly startedAt: string
  readonly endedAt: string | null
  readonly status: 'active' | 'completed' | 'cancelled' | 'failed'
}

/* -------------------------------------------------------- presence frame */

/** Voice capture status, as the presence layer may know it. */
export interface Phase26VoiceCapture {
  readonly active: boolean
  readonly available: boolean
  readonly sessionId: string | null
}

/** Voice synthesis status. */
export interface Phase26VoiceSynthesis {
  readonly active: boolean
  readonly available: boolean
  readonly label: string | null
}

/** A bounded work summary for the presence card. */
export interface Phase26WorkSummary {
  readonly running: number
  readonly waiting: number
  readonly awaitingApproval: number
  readonly label: string | null
}

/**
 * The expanded presence frame.
 *
 * All fields are derived from real Core state. The three new bounded lists —
 * transition history, embodiment cues and voice session history — carry no
 * claim about what Freya is.
 */
export interface Phase26PresenceFrame {
  readonly schemaVersion: number
  readonly state: Phase26PresenceState
  readonly animation: Phase26Animation
  readonly stateSince: number
  readonly detail: string
  readonly voiceCapture: Phase26VoiceCapture
  readonly voiceSynthesis: Phase26VoiceSynthesis
  readonly attention: unknown | null
  readonly personalityCue: unknown | null
  readonly work: Phase26WorkSummary | null
  readonly sequence: number
  readonly transitionHistory: TransitionHistory
  readonly embodimentCues: EmbodimentCueList
  readonly voiceSessionHistory: VoiceSessionHistory
}

/** The Phase 26 presence schema version. */
export const PHASE26_PRESENCE_SCHEMA_VERSION = 2

/* --------------------------------------------------------------- limits */

/**
 * The code-owned ceilings of Phase 26.
 *
 * A caller may lower a ceiling and may never raise one.
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

/* --------------------------------------------------------------- utilities */

/** Whether a string parses as an instant. No clock read, no repair. */
export function instantMs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/** Whether a string is a bounded opaque id. */
export function isPresenceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  )
}
