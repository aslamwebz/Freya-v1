/**
 * Presence states.
 *
 * This is the vocabulary of the central intelligence as the user perceives it.
 * Phase 0 defines the full set and implements the transition rules; the visual
 * renderer reads the state, and a demo control drives it. Nothing here calls a
 * model — presence is presentation of state, not cognition.
 */

export const PRESENCE_STATES = [
  'idle',
  'listening',
  'thinking',
  'working',
  'needs-user',
  'locked',
  'error',
] as const

export type PresenceState = (typeof PRESENCE_STATES)[number]

export interface Presence {
  state: PresenceState
  /** Epoch ms at which the current state was entered. */
  since: number
  /** 0..1, smoothed. Purely presentational; driven by the presence renderer. */
  activity: number
  /** Short human line shown under the command bar. Not persisted. */
  detail: string | null
}

export const PRESENCE_DETAIL: Record<PresenceState, string> = {
  idle: 'Standing by.',
  listening: 'Listening.',
  thinking: 'Considering the request.',
  working: 'Working.',
  'needs-user': 'Waiting on you.',
  locked: 'Locked by policy. Unlock from Security.',
  error: 'Something failed. Review the work board.',
}

/**
 * Legal transitions. `idle` is reachable from everything; `working` and
 * `needs-user` are the two states a surface can be blocked in.
 *
 * `error` and `locked` are terminal until something explicitly clears them,
 * which is why they appear on the right of every row.
 */
const TRANSITIONS: Record<PresenceState, readonly PresenceState[]> = {
  idle: ['listening', 'thinking', 'working', 'needs-user', 'locked', 'error'],
  listening: ['idle', 'thinking', 'working', 'needs-user', 'error'],
  thinking: ['idle', 'working', 'needs-user', 'error'],
  working: ['idle', 'needs-user', 'thinking', 'error'],
  'needs-user': ['idle', 'working', 'thinking', 'error'],
  locked: ['idle'],
  error: ['idle'],
}

export function canTransition(from: PresenceState, to: PresenceState): boolean {
  if (from === to) return true
  return TRANSITIONS[from].includes(to)
}

export function isPresenceState(value: unknown): value is PresenceState {
  return typeof value === 'string' && (PRESENCE_STATES as readonly string[]).includes(value)
}

export const PRESENCE_TONE: Record<PresenceState, { accent: string; label: string; urgent: boolean }> = {
  idle: { accent: 'var(--ink-2)', label: 'Idle', urgent: false },
  listening: { accent: 'var(--blue)', label: 'Listening', urgent: false },
  thinking: { accent: 'var(--blue-hi)', label: 'Thinking', urgent: false },
  working: { accent: 'var(--gold)', label: 'Working', urgent: false },
  'needs-user': { accent: 'var(--amber)', label: 'Needs you', urgent: true },
  locked: { accent: 'var(--ink-3)', label: 'Locked', urgent: true },
  error: { accent: 'var(--red)', label: 'Error', urgent: true },
}
