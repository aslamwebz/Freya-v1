/**
 * THE VOICE INTERACTION DOMAIN — local-only, bounded, explicit.
 *
 * A voice session is a bounded sequence of captures and syntheses. It is
 * local-only: there is no cloud service, no network call, no model call in
 * this module. Capture is explicit (press-and-release), and both capture and
 * synthesis counts are bounded.
 */

import {
  PHASE26_PRESENCE_LIMITS,
  type VoiceSession,
  type VoiceSessionHistory,
} from './types'

/**
 * Voice is local-only. This is a structural fact of the build, not a setting:
 * there is no remote voice path for a caller to select.
 */
export const VOICE_IS_LOCAL_ONLY = true

/** The closed set of reasons a voice step may be refused. */
export const VOICE_REFUSAL_CODES = [
  'session_ended',
  'capture_bound',
  'synthesis_bound',
  'session_bound',
] as const
export type VoiceRefusalCode = (typeof VOICE_REFUSAL_CODES)[number]

/** Why a code is a refusal, in words a person can act on. */
export const VOICE_REFUSAL_REASONS: Readonly<Record<VoiceRefusalCode, string>> = Object.freeze({
  session_ended: 'the voice session is no longer active',
  capture_bound: 'the capture bound for this session is reached',
  synthesis_bound: 'the synthesis bound for this session is reached',
  session_bound: 'the voice session bound for this interaction is reached',
})

export type VoiceResult =
  | { readonly ok: true; readonly session: VoiceSession }
  | { readonly ok: false; readonly code: VoiceRefusalCode; readonly reason: string }

/** An empty, bounded voice session history. */
export function emptyVoiceSessionHistory(): VoiceSessionHistory {
  return { sessions: [], maxEntries: PHASE26_PRESENCE_LIMITS.maxVoiceSessionHistoryEntries }
}

/** Start a voice session. A session begins idle and active with no captures. */
export function startVoiceSession(sessionId: string, startedAt: string): VoiceSession {
  return {
    sessionId,
    startedAt,
    endedAt: null,
    captureCount: 0,
    synthesisCount: 0,
    status: 'active',
  }
}

/** Whether another voice session may start within one interaction. */
export function canStartVoiceSession(sessionsStarted: number): boolean {
  return sessionsStarted < PHASE26_PRESENCE_LIMITS.maxVoiceSessionsPerInteraction
}

/** Record one explicit capture in a session, within the bound. */
export function recordVoiceCapture(session: VoiceSession): VoiceResult {
  if (session.status !== 'active') {
    return { ok: false, code: 'session_ended', reason: VOICE_REFUSAL_REASONS.session_ended }
  }
  if (session.captureCount >= PHASE26_PRESENCE_LIMITS.maxCapturesPerSession) {
    return { ok: false, code: 'capture_bound', reason: VOICE_REFUSAL_REASONS.capture_bound }
  }
  return { ok: true, session: { ...session, captureCount: session.captureCount + 1 } }
}

/** Record one synthesis in a session, within the bound. */
export function recordVoiceSynthesis(session: VoiceSession): VoiceResult {
  if (session.status !== 'active') {
    return { ok: false, code: 'session_ended', reason: VOICE_REFUSAL_REASONS.session_ended }
  }
  if (session.synthesisCount >= PHASE26_PRESENCE_LIMITS.maxSynthesesPerSession) {
    return { ok: false, code: 'synthesis_bound', reason: VOICE_REFUSAL_REASONS.synthesis_bound }
  }
  return { ok: true, session: { ...session, synthesisCount: session.synthesisCount + 1 } }
}

/** End a voice session with a terminal status. */
export function endVoiceSession(
  session: VoiceSession,
  status: Exclude<VoiceSession['status'], 'active'>,
  endedAt: string,
): VoiceSession {
  if (session.status !== 'active') return session
  return { ...session, status, endedAt }
}

/**
 * Append a session to the bounded history.
 *
 * The most recent session is last; the oldest entries past the ceiling are
 * removed, never silently retained.
 */
export function appendVoiceSession(
  history: VoiceSessionHistory,
  session: VoiceSession,
): VoiceSessionHistory {
  const maxEntries = PHASE26_PRESENCE_LIMITS.maxVoiceSessionHistoryEntries
  const next = [...history.sessions, session]
  const trimmed = next.length > maxEntries ? next.slice(next.length - maxEntries) : next
  return { sessions: trimmed, maxEntries }
}
