/**
 * THE PRESENCE FRAME — everything a renderer needs to draw one frame.
 *
 * The frame is built only from real Core state and the bounded histories the
 * domain maintains. It is validated with exact keys and closed vocabularies:
 * a frame that carries an invented state, animation or cue is refused, not
 * drawn.
 */

import {
  EMBODIMENT_CUE_TYPES,
  PHASE26_ANIMATIONS,
  PHASE26_PRESENCE_LIMITS,
  PHASE26_PRESENCE_SCHEMA_VERSION,
  PHASE26_PRESENCE_STATES,
  PHASE26_STATE_ANIMATION,
  type EmbodimentCueList,
  type Phase26PresenceFrame,
  type Phase26PresenceState,
  type Phase26WorkSummary,
  type TransitionHistory,
  type VoiceSessionHistory,
} from './types'
import {
  derivePhase26PresenceState,
  phase26Animation,
  phase26Detail,
  type Phase26PresenceInput,
} from './stateMachine'
import { emptyTransitionHistory } from './transitions'
import { emptyEmbodimentCueList } from './cues'
import { emptyVoiceSessionHistory } from './voice'

/** A frame expires when it is older than this. */
export const PHASE26_FRAME_MAX_AGE_MS = 60_000

/** The voice facts a frame carries. */
export interface Phase26FrameVoice {
  readonly captureActive: boolean
  readonly captureAvailable: boolean
  readonly sessionId: string | null
  readonly synthesisActive: boolean
  readonly synthesisAvailable: boolean
  readonly synthesisLabel: string | null
}

/** Everything needed to build one presence frame. */
export interface Phase26FrameInput {
  readonly presence: Phase26PresenceInput
  readonly stateSince: number
  readonly voice: Phase26FrameVoice
  readonly work: Phase26WorkSummary | null
  readonly sequence: number
  readonly transitionHistory: TransitionHistory
  readonly embodimentCues: EmbodimentCueList
  readonly voiceSessionHistory: VoiceSessionHistory
}

/**
 * Build one presence frame from real Core state.
 *
 * The only constructor of a Phase 26 frame. A renderer never builds a frame
 * itself; it receives one and draws it.
 */
export function buildPhase26Frame(input: Phase26FrameInput): Phase26PresenceFrame {
  const state = derivePhase26PresenceState(input.presence)
  return {
    schemaVersion: PHASE26_PRESENCE_SCHEMA_VERSION,
    state,
    animation: phase26Animation(state),
    stateSince: input.stateSince,
    detail: phase26Detail(state, input.presence),
    voiceCapture: {
      active: input.voice.captureActive,
      available: input.voice.captureAvailable,
      sessionId: input.voice.sessionId,
    },
    voiceSynthesis: {
      active: input.voice.synthesisActive,
      available: input.voice.synthesisAvailable,
      label: input.voice.synthesisLabel,
    },
    attention: input.presence.attentionDirective,
    personalityCue: input.presence.personalityCue,
    work: input.work,
    sequence: input.sequence,
    transitionHistory: input.transitionHistory,
    embodimentCues: input.embodimentCues,
    voiceSessionHistory: input.voiceSessionHistory,
  }
}

/**
 * A minimal, honest frame.
 *
 * Used only when a full frame cannot be built. It claims nothing: idle, no
 * cues, no history.
 */
export function minimalPhase26Frame(stateSince: number): Phase26PresenceFrame {
  return {
    schemaVersion: PHASE26_PRESENCE_SCHEMA_VERSION,
    state: 'idle',
    animation: PHASE26_STATE_ANIMATION.idle,
    stateSince,
    detail: 'Standing by.',
    voiceCapture: { active: false, available: false, sessionId: null },
    voiceSynthesis: { active: false, available: false, label: null },
    attention: null,
    personalityCue: null,
    work: null,
    sequence: 0,
    transitionHistory: emptyTransitionHistory(),
    embodimentCues: emptyEmbodimentCueList(),
    voiceSessionHistory: emptyVoiceSessionHistory(),
  }
}

/** Whether a frame is older than the bounded frame age. */
export function isPhase26FrameExpired(frame: Phase26PresenceFrame, nowMs: number): boolean {
  return nowMs - frame.stateSince > PHASE26_FRAME_MAX_AGE_MS
}

/* ------------------------------------------------------------ validation */

const FRAME_KEYS = [
  'schemaVersion',
  'state',
  'animation',
  'stateSince',
  'detail',
  'voiceCapture',
  'voiceSynthesis',
  'attention',
  'personalityCue',
  'work',
  'sequence',
  'transitionHistory',
  'embodimentCues',
  'voiceSessionHistory',
] as const
const VOICE_CAPTURE_KEYS = ['active', 'available', 'sessionId'] as const
const VOICE_SYNTHESIS_KEYS = ['active', 'available', 'label'] as const
const WORK_KEYS = ['running', 'waiting', 'awaitingApproval', 'label'] as const
const TRANSITION_HISTORY_KEYS = ['transitions', 'maxEntries'] as const
const TRANSITION_KEYS = ['from', 'to', 'reason', 'occurredAt', 'durationMs', 'timedOut'] as const
const CUE_LIST_KEYS = ['cues', 'maxEntries'] as const
const CUE_KEYS = ['cueType', 'label', 'derivedFrom', 'active', 'activatedAt'] as const
const VOICE_HISTORY_KEYS = ['sessions', 'maxEntries'] as const
const SESSION_KEYS = [
  'sessionId',
  'startedAt',
  'endedAt',
  'captureCount',
  'synthesisCount',
  'status',
] as const
const WORK_LABELS: readonly string[] = [
  'a run is executing',
  'a run is waiting',
  'a run is waiting for your decision',
]
const ID = /^[A-Za-z0-9._:-]{1,128}$/

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => actual.includes(key))
}

function boundedLabel(value: unknown, max: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return false
  return ![...value].some((char) => {
    const code = char.charCodeAt(0)
    return code <= 31 || code === 127
  })
}

function instant(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value))
}

function nonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * Strict exact-key validation of a presence frame.
 *
 * A frame with an unknown key, an unknown state, a mismatched animation or an
 * invented cue type is refused, not ignored. Returns the frame when valid, or
 * a reason string when not.
 */
export function validatePhase26Frame(value: unknown): Phase26PresenceFrame | string {
  if (!exactRecord(value, FRAME_KEYS)) return 'presence frame has invalid keys'
  const record = value

  if (record.schemaVersion !== PHASE26_PRESENCE_SCHEMA_VERSION) {
    return `presence schema version must be ${PHASE26_PRESENCE_SCHEMA_VERSION}`
  }
  if (
    typeof record.state !== 'string' ||
    !(PHASE26_PRESENCE_STATES as readonly string[]).includes(record.state)
  ) {
    return 'presence state is invalid'
  }
  if (
    typeof record.animation !== 'string' ||
    !(PHASE26_ANIMATIONS as readonly string[]).includes(record.animation)
  ) {
    return 'presence animation is invalid'
  }
  if (record.animation !== PHASE26_STATE_ANIMATION[record.state as Phase26PresenceState]) {
    return 'presence animation does not match state'
  }
  if (typeof record.stateSince !== 'number' || !Number.isFinite(record.stateSince) || record.stateSince < 0) {
    return 'presence stateSince is invalid'
  }
  if (typeof record.detail !== 'string' || record.detail.length > PHASE26_PRESENCE_LIMITS.maxDetailChars) {
    return 'presence detail is invalid'
  }

  const voiceCapture = validateVoiceCapture(record.voiceCapture)
  if (typeof voiceCapture === 'string') return voiceCapture
  const voiceSynthesis = validateVoiceSynthesis(record.voiceSynthesis)
  if (typeof voiceSynthesis === 'string') return voiceSynthesis
  const work = validateWork(record.work)
  if (typeof work === 'string') return work
  if (typeof record.sequence !== 'number' || !Number.isInteger(record.sequence) || record.sequence < 0) {
    return 'presence sequence is invalid'
  }
  const transitionHistory = validateTransitionHistory(record.transitionHistory)
  if (typeof transitionHistory === 'string') return transitionHistory
  const embodimentCues = validateCueList(record.embodimentCues)
  if (typeof embodimentCues === 'string') return embodimentCues
  const voiceSessionHistory = validateVoiceSessionHistory(record.voiceSessionHistory)
  if (typeof voiceSessionHistory === 'string') return voiceSessionHistory

  return {
    schemaVersion: PHASE26_PRESENCE_SCHEMA_VERSION,
    state: record.state as Phase26PresenceState,
    animation: record.animation as Phase26PresenceFrame['animation'],
    stateSince: record.stateSince,
    detail: record.detail,
    voiceCapture,
    voiceSynthesis,
    attention: record.attention,
    personalityCue: record.personalityCue,
    work,
    sequence: record.sequence,
    transitionHistory,
    embodimentCues,
    voiceSessionHistory,
  }
}

function validateVoiceCapture(value: unknown): Phase26PresenceFrame['voiceCapture'] | string {
  if (!exactRecord(value, VOICE_CAPTURE_KEYS)) return 'voiceCapture has invalid keys'
  if (typeof value.active !== 'boolean') return 'voiceCapture.active is invalid'
  if (typeof value.available !== 'boolean') return 'voiceCapture.available is invalid'
  if (value.sessionId !== null && !(typeof value.sessionId === 'string' && ID.test(value.sessionId))) {
    return 'voiceCapture.sessionId is invalid'
  }
  return { active: value.active, available: value.available, sessionId: value.sessionId as string | null }
}

function validateVoiceSynthesis(value: unknown): Phase26PresenceFrame['voiceSynthesis'] | string {
  if (!exactRecord(value, VOICE_SYNTHESIS_KEYS)) return 'voiceSynthesis has invalid keys'
  if (typeof value.active !== 'boolean') return 'voiceSynthesis.active is invalid'
  if (typeof value.available !== 'boolean') return 'voiceSynthesis.available is invalid'
  if (value.label !== null && !boundedLabel(value.label, PHASE26_PRESENCE_LIMITS.maxCueLabelChars)) {
    return 'voiceSynthesis.label is invalid'
  }
  return { active: value.active, available: value.available, label: value.label as string | null }
}

function validateWork(value: unknown): Phase26WorkSummary | null | string {
  if (value === null) return null
  if (!exactRecord(value, WORK_KEYS)) return 'presence work has invalid keys'
  if (!nonNegativeInt(value.running)) return 'presence work.running is invalid'
  if (!nonNegativeInt(value.waiting)) return 'presence work.waiting is invalid'
  if (!nonNegativeInt(value.awaitingApproval)) return 'presence work.awaitingApproval is invalid'
  if (value.label !== null && !WORK_LABELS.includes(String(value.label))) return 'presence work.label is invalid'
  return {
    running: value.running,
    waiting: value.waiting,
    awaitingApproval: value.awaitingApproval,
    label: value.label as string | null,
  }
}

function validateTransitionHistory(value: unknown): TransitionHistory | string {
  if (!exactRecord(value, TRANSITION_HISTORY_KEYS)) return 'transitionHistory has invalid keys'
  if (!Array.isArray(value.transitions)) return 'transitionHistory.transitions is invalid'
  if (
    !Number.isInteger(value.maxEntries) ||
    (value.maxEntries as number) < 1 ||
    (value.maxEntries as number) > PHASE26_PRESENCE_LIMITS.maxTransitionHistoryEntries
  ) {
    return 'transitionHistory.maxEntries is invalid'
  }
  if (value.transitions.length > (value.maxEntries as number)) {
    return 'transitionHistory exceeds its bound'
  }
  for (const entry of value.transitions) {
    if (!exactRecord(entry, TRANSITION_KEYS)) return 'transition entry has invalid keys'
    if (!(PHASE26_PRESENCE_STATES as readonly string[]).includes(entry.from as string)) {
      return 'transition.from is invalid'
    }
    if (!(PHASE26_PRESENCE_STATES as readonly string[]).includes(entry.to as string)) {
      return 'transition.to is invalid'
    }
    if (typeof entry.reason !== 'string') return 'transition.reason is invalid'
    if (!instant(entry.occurredAt)) return 'transition.occurredAt is invalid'
    if (!nonNegativeInt(entry.durationMs)) return 'transition.durationMs is invalid'
    if (typeof entry.timedOut !== 'boolean') return 'transition.timedOut is invalid'
  }
  return {
    transitions: value.transitions as TransitionHistory['transitions'],
    maxEntries: value.maxEntries as number,
  }
}

function validateCueList(value: unknown): EmbodimentCueList | string {
  if (!exactRecord(value, CUE_LIST_KEYS)) return 'embodimentCues has invalid keys'
  if (!Array.isArray(value.cues)) return 'embodimentCues.cues is invalid'
  if (
    !Number.isInteger(value.maxEntries) ||
    (value.maxEntries as number) < 1 ||
    (value.maxEntries as number) > PHASE26_PRESENCE_LIMITS.maxEmbodimentCues
  ) {
    return 'embodimentCues.maxEntries is invalid'
  }
  if (value.cues.length > (value.maxEntries as number)) return 'embodimentCues exceeds its bound'
  for (const entry of value.cues) {
    if (!exactRecord(entry, CUE_KEYS)) return 'embodiment cue has invalid keys'
    if (!(EMBODIMENT_CUE_TYPES as readonly string[]).includes(entry.cueType as string)) {
      return 'embodiment cue type is invalid'
    }
    if (!boundedLabel(entry.label, PHASE26_PRESENCE_LIMITS.maxCueLabelChars)) {
      return 'embodiment cue label is invalid'
    }
    if (typeof entry.derivedFrom !== 'string') return 'embodiment cue derivedFrom is invalid'
    if (typeof entry.active !== 'boolean') return 'embodiment cue active is invalid'
    if (entry.activatedAt !== null && !instant(entry.activatedAt)) {
      return 'embodiment cue activatedAt is invalid'
    }
  }
  return {
    cues: value.cues as EmbodimentCueList['cues'],
    maxEntries: value.maxEntries as number,
  }
}

function validateVoiceSessionHistory(value: unknown): VoiceSessionHistory | string {
  if (!exactRecord(value, VOICE_HISTORY_KEYS)) return 'voiceSessionHistory has invalid keys'
  if (!Array.isArray(value.sessions)) return 'voiceSessionHistory.sessions is invalid'
  if (
    !Number.isInteger(value.maxEntries) ||
    (value.maxEntries as number) < 1 ||
    (value.maxEntries as number) > PHASE26_PRESENCE_LIMITS.maxVoiceSessionHistoryEntries
  ) {
    return 'voiceSessionHistory.maxEntries is invalid'
  }
  if (value.sessions.length > (value.maxEntries as number)) {
    return 'voiceSessionHistory exceeds its bound'
  }
  for (const entry of value.sessions) {
    if (!exactRecord(entry, SESSION_KEYS)) return 'voice session has invalid keys'
    if (typeof entry.sessionId !== 'string' || !ID.test(entry.sessionId)) {
      return 'voice session id is invalid'
    }
    if (!instant(entry.startedAt)) return 'voice session startedAt is invalid'
    if (entry.endedAt !== null && !instant(entry.endedAt)) return 'voice session endedAt is invalid'
    if (!nonNegativeInt(entry.captureCount)) return 'voice session captureCount is invalid'
    if (!nonNegativeInt(entry.synthesisCount)) return 'voice session synthesisCount is invalid'
    if (!['active', 'completed', 'cancelled', 'failed'].includes(String(entry.status))) {
      return 'voice session status is invalid'
    }
  }
  return {
    sessions: value.sessions as VoiceSessionHistory['sessions'],
    maxEntries: value.maxEntries as number,
  }
}
