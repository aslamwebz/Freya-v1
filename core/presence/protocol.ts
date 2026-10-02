/**
 * THE PRESENCE PROTOCOL — the platform-neutral contract between Core and a
 * presence renderer.
 *
 * This file is the **only** definition of what a presence renderer may know and
 * what it may ask for. It is deliberately Electron-free, Three.js-free and
 * renderer-free: a future Godot or native renderer replaces the presentation
 * layer by implementing this protocol, not by moving Core authority.
 *
 * ## The eight presence states
 *
 * ```
 * idle · listening · thinking · speaking · working · attention · error · degraded
 * ```
 *
 * Every state is derived from real Core state. The renderer never invents a
 * state, never decides urgency, and never claims an emotional or mental state
 * it cannot observe. `speaking` means a synthesis engine is producing audio;
 * `listening` means a capture is open; `working` means a provider call is in
 * flight or a Run is executing. Nothing here is a mood.
 *
 * ## What crosses, and what pointedly does not
 *
 * Crosses: the presence state, a bounded animation name, a bounded cue label,
 * one attention directive (code-owned), one personality cue (code-owned),
 * voice capture/synthesis status, and a bounded work summary.
 *
 * Does not cross: event text, memory content, conversation content, any
 * capability or grant, any model parameter, and any field a renderer could use
 * to assert an urgency, an importance or an outcome.
 *
 * ## The two absences, kept apart
 *
 * `'unavailable'` means *this build has no presence renderer*. `null` means
 * *no Core has reported yet*. Rendering the first as "Freya is idle" would be
 * telling a person nothing is wrong when nothing is watching at all.
 */

import type { AttentionDirectiveView } from '../protocol/attention'
import type { PersonalityCueView } from '../protocol/personality'

/* ----------------------------------------------------------------- states */

/**
 * The closed set of presence states.
 *
 * Ordered by how much the state demands of a person, not by how likely it is.
 * `error` and `degraded` are last because they are the two states that mean
 * Freya cannot currently do what she was asked.
 */
export const PRESENCE_PROTOCOL_STATES = [
  'idle',
  'listening',
  'thinking',
  'speaking',
  'working',
  'attention',
  'error',
  'degraded',
] as const

export type PresenceProtocolState = (typeof PRESENCE_PROTOCOL_STATES)[number]

export function isPresenceProtocolState(value: unknown): value is PresenceProtocolState {
  return typeof value === 'string' && (PRESENCE_PROTOCOL_STATES as readonly string[]).includes(value)
}

/* ------------------------------------------------------------- transitions */

/**
 * Legal presence transitions.
 *
 * Bounded on purpose. A renderer may only move between adjacent states in the
 * ladder, or return to `idle`. There is no direct path from `error` to
 * `working`, for example, because a renderer that could jump there could also
 * hide the error.
 *
 * `idle` is reachable from everything: it is the resting state, and any state
 * that has nothing to show returns to it.
 */
const PRESENCE_TRANSITIONS: Record<PresenceProtocolState, readonly PresenceProtocolState[]> = {
  idle: ['listening', 'thinking', 'speaking', 'working', 'attention', 'error', 'degraded'],
  listening: ['idle', 'thinking', 'speaking', 'working', 'attention', 'error', 'degraded'],
  thinking: ['idle', 'listening', 'speaking', 'working', 'attention', 'error', 'degraded'],
  speaking: ['idle', 'listening', 'thinking', 'working', 'attention', 'error', 'degraded'],
  working: ['idle', 'listening', 'thinking', 'speaking', 'attention', 'error', 'degraded'],
  attention: ['idle', 'listening', 'thinking', 'speaking', 'working', 'error', 'degraded'],
  error: ['idle', 'degraded'],
  degraded: ['idle', 'error'],
}

export function canTransitionPresence(
  from: PresenceProtocolState,
  to: PresenceProtocolState,
): boolean {
  if (from === to) return true
  return PRESENCE_TRANSITIONS[from].includes(to)
}

/* ---------------------------------------------------- animation vocabulary */

/**
 * The bounded animation vocabulary.
 *
 * Every animation name is a code-owned label, not a description of an inner
 * state. `breathe` is a slow pulse; `pulse` is a faster one; `spin` is a
 * rotation; `wave` is a waveform. None of them claims Freya is happy, sad,
 * curious or bored — those are states Core cannot know.
 *
 * The renderer maps each presence state to at most one animation. A renderer
 * that wanted to invent a new animation would have to add it here, which means
 * the change is visible in the protocol rather than hidden in a shader.
 */
export const PRESENCE_ANIMATIONS = [
  'breathe',
  'pulse',
  'spin',
  'wave',
  'glow',
  'alert',
  'dim',
] as const

export type PresenceAnimation = (typeof PRESENCE_ANIMATIONS)[number]

export function isPresenceAnimation(value: unknown): value is PresenceAnimation {
  return typeof value === 'string' && (PRESENCE_ANIMATIONS as readonly string[]).includes(value)
}

/**
 * The animation each presence state maps to.
 *
 * One animation per state, fixed here. A renderer may not choose a different
 * animation for a state, because the mapping is part of the protocol: two
 * renderers that showed different animations for the same state would be two
 * different presences.
 */
export const PRESENCE_STATE_ANIMATION: Record<PresenceProtocolState, PresenceAnimation> = {
  idle: 'breathe',
  listening: 'pulse',
  thinking: 'spin',
  speaking: 'wave',
  working: 'glow',
  attention: 'alert',
  error: 'alert',
  degraded: 'dim',
}

/* ------------------------------------------------------------- voice seam */

/**
 * Voice capture status, as the presence renderer may know it.
 *
 * `active` means a capture is open right now. `available` means a local
 * transcription engine exists. Neither is a claim about what is being
 * recorded: the capture is bounded, the audio is never stored, and the
 * renderer holds no audio bytes.
 */
export interface PresenceVoiceCapture {
  readonly active: boolean
  readonly available: boolean
  /** Bounded session id, for display. Never a recording identifier. */
  readonly sessionId: string | null
}

/**
 * Voice synthesis status.
 *
 * `active` means a synthesis engine is producing audio right now. The
 * renderer shows a speaking animation; it does not hold the audio.
 */
export interface PresenceVoiceSynthesis {
  readonly active: boolean
  readonly available: boolean
  /** What is being spoken, as a bounded label. Never the full text. */
  readonly label: string | null
}

/* --------------------------------------------------------- work summary */

/**
 * A bounded work summary for the presence card.
 *
 * Counts and closed labels only. No step input, no observation contents, no
 * capability names beyond what the Work projection already carries.
 */
export interface PresenceWorkSummary {
  readonly running: number
  readonly waiting: number
  readonly awaitingApproval: number
  /** A code-owned label: "a run is executing", "a run is waiting", or null. */
  readonly label: string | null
}

/* ------------------------------------------------------- presence frame */

/**
 * One presence frame: everything a renderer needs to draw one frame.
 *
 * This is the unit of the presence protocol. The host pushes a frame whenever
 * Core state changes; the renderer draws it and nothing else. A renderer that
 * wanted to animate between frames would interpolate locally, but it could
 * never invent a state, a cue or a card that is not in the frame.
 */
export interface PresenceFrame {
  readonly schemaVersion: number
  readonly state: PresenceProtocolState
  readonly animation: PresenceAnimation
  /** Epoch ms at which the current state was entered. */
  readonly stateSince: number
  /** A short human line. Never a mental-state claim. */
  readonly detail: string
  readonly voiceCapture: PresenceVoiceCapture
  readonly voiceSynthesis: PresenceVoiceSynthesis
  /** The one attention directive Core chose, or null. */
  readonly attention: AttentionDirectiveView | null
  /** The one personality cue Core chose, or null. */
  readonly personalityCue: PersonalityCueView | null
  /** A bounded work summary, or null when no work is running. */
  readonly work: PresenceWorkSummary | null
  /** Highest Core sequence folded in, so a renderer can prove it is current. */
  readonly sequence: number
}

/** The presence protocol schema version. */
export const PRESENCE_SCHEMA_VERSION = 1

/* ------------------------------------------------------ protocol validation */

/**
 * Strict exact-key checking for a presence frame.
 *
 * A frame with an unknown key is refused, not ignored. A renderer that could
 * ignore an unknown key would be a renderer that could be talked into
 * rendering a field Core never sent.
 *
 * Returns the frame when valid, or a reason string when not.
 */
export function validatePresenceFrame(value: unknown): PresenceFrame | string {
  if (typeof value !== 'object' || value === null) return 'presence frame is not an object'
  const record = value as Record<string, unknown>

  const schemaVersion = record.schemaVersion
  if (schemaVersion !== PRESENCE_SCHEMA_VERSION) {
    return `presence schema version must be ${PRESENCE_SCHEMA_VERSION}`
  }

  if (!isPresenceProtocolState(record.state)) return 'presence state is invalid'
  if (!isPresenceAnimation(record.animation)) return 'presence animation is invalid'

  const stateSince = record.stateSince
  if (typeof stateSince !== 'number' || !Number.isFinite(stateSince) || stateSince < 0) {
    return 'presence stateSince is invalid'
  }

  const detail = record.detail
  if (typeof detail !== 'string' || detail.length > 200) {
    return 'presence detail is invalid'
  }

  const voiceCapture = validateVoiceCapture(record.voiceCapture)
  if (typeof voiceCapture === 'string') return voiceCapture

  const voiceSynthesis = validateVoiceSynthesis(record.voiceSynthesis)
  if (typeof voiceSynthesis === 'string') return voiceSynthesis

  const attention = record.attention
  if (attention !== null && typeof attention !== 'object') {
    return 'presence attention is invalid'
  }

  const personalityCue = record.personalityCue
  if (personalityCue !== null && typeof personalityCue !== 'object') {
    return 'presence personalityCue is invalid'
  }

  const work = record.work
  if (work !== null && typeof work !== 'object') {
    return 'presence work is invalid'
  }

  const sequence = record.sequence
  if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 0) {
    return 'presence sequence is invalid'
  }

  return {
    schemaVersion,
    state: record.state,
    animation: record.animation,
    stateSince,
    detail,
    voiceCapture,
    voiceSynthesis,
    attention: attention as PresenceFrame['attention'],
    personalityCue: personalityCue as PresenceFrame['personalityCue'],
    work: work as PresenceFrame['work'],
    sequence,
  }
}

function validateVoiceCapture(value: unknown): PresenceVoiceCapture | string {
  if (typeof value !== 'object' || value === null) return 'voiceCapture is not an object'
  const record = value as Record<string, unknown>
  if (typeof record.active !== 'boolean') return 'voiceCapture.active is invalid'
  if (typeof record.available !== 'boolean') return 'voiceCapture.available is invalid'
  if (record.sessionId !== null && typeof record.sessionId !== 'string') {
    return 'voiceCapture.sessionId is invalid'
  }
  return {
    active: record.active,
    available: record.available,
    sessionId: record.sessionId as string | null,
  }
}

function validateVoiceSynthesis(value: unknown): PresenceVoiceSynthesis | string {
  if (typeof value !== 'object' || value === null) return 'voiceSynthesis is not an object'
  const record = value as Record<string, unknown>
  if (typeof record.active !== 'boolean') return 'voiceSynthesis.active is invalid'
  if (typeof record.available !== 'boolean') return 'voiceSynthesis.available is invalid'
  if (record.label !== null && typeof record.label !== 'string') {
    return 'voiceSynthesis.label is invalid'
  }
  return {
    active: record.active,
    available: record.available,
    label: record.label as string | null,
  }
}
