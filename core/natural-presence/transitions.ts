/**
 * THE PRESENCE TRANSITIONS — bounded, legal, derived.
 *
 * A transition moves presence from one state to another. It is bounded (a
 * maximum duration), legal (only edges in the table), and recorded in a
 * bounded history. A renderer may not invent a transition.
 */

import {
  PHASE26_PRESENCE_LIMITS,
  PHASE26_PRESENCE_STATES,
  type Phase26PresenceState,
  type PresenceTransition,
  type TransitionHistory,
} from './types'

/**
 * The legal presence transitions.
 *
 * `idle` is reachable from everything: it is the resting state. `error` and
 * `degraded` can only return to `idle` (and to each other), because a renderer
 * that could jump from `error` straight to `working` could also hide the error.
 */
const PRESENCE_TRANSITIONS: Readonly<Record<Phase26PresenceState, readonly Phase26PresenceState[]>> =
  Object.freeze({
    idle: ['listening', 'thinking', 'speaking', 'working', 'attention', 'error', 'degraded'],
    listening: ['idle', 'thinking', 'speaking', 'working', 'attention', 'error', 'degraded'],
    thinking: ['idle', 'listening', 'speaking', 'working', 'attention', 'error', 'degraded'],
    speaking: ['idle', 'listening', 'thinking', 'working', 'attention', 'error', 'degraded'],
    working: ['idle', 'listening', 'thinking', 'speaking', 'attention', 'error', 'degraded'],
    attention: ['idle', 'listening', 'thinking', 'speaking', 'working', 'error', 'degraded'],
    error: ['idle', 'degraded'],
    degraded: ['idle', 'error'],
  })

/** Whether a transition is legal. A state may always stay where it is. */
export function canTransitionPresence(
  from: Phase26PresenceState,
  to: Phase26PresenceState,
): boolean {
  if (from === to) return true
  return PRESENCE_TRANSITIONS[from].includes(to)
}

/** An empty, bounded transition history. */
export function emptyTransitionHistory(): TransitionHistory {
  return { transitions: [], maxEntries: PHASE26_PRESENCE_LIMITS.maxTransitionHistoryEntries }
}

/**
 * Whether a transition exceeded its bounded duration.
 *
 * A transition that takes longer than the ceiling is marked timed out and the
 * state is still set to the target: the bound is a fact, not a gate.
 */
export function transitionTimedOut(durationMs: number): boolean {
  return durationMs > PHASE26_PRESENCE_LIMITS.maxTransitionDurationMs
}

/** The result of applying a transition. */
export type TransitionResult =
  | { readonly ok: true; readonly history: TransitionHistory; readonly transition: PresenceTransition | null }
  | { readonly ok: false; readonly reason: string }

/**
 * Apply a transition to a history.
 *
 * An illegal edge is refused. A no-op (same state) leaves the history
 * unchanged. A legal change appends a bounded transition and trims the oldest
 * entries past the ceiling. Deterministic: the same arguments always produce
 * the same history.
 */
export function applyTransition(
  history: TransitionHistory,
  from: Phase26PresenceState,
  to: Phase26PresenceState,
  reason: string,
  occurredAt: string,
  durationMs: number,
): TransitionResult {
  if (!canTransitionPresence(from, to)) {
    return { ok: false, reason: `illegal presence transition ${from} -> ${to}` }
  }
  if (from === to) {
    return { ok: true, history, transition: null }
  }
  const boundedDuration = Math.max(0, Math.min(Math.floor(durationMs), Number.MAX_SAFE_INTEGER))
  const transition: PresenceTransition = {
    from,
    to,
    reason: reason.slice(0, PHASE26_PRESENCE_LIMITS.maxCueLabelChars),
    occurredAt,
    durationMs: boundedDuration,
    timedOut: transitionTimedOut(boundedDuration),
  }
  const maxEntries = PHASE26_PRESENCE_LIMITS.maxTransitionHistoryEntries
  const next = [...history.transitions, transition]
  const trimmed = next.length > maxEntries ? next.slice(next.length - maxEntries) : next
  return { ok: true, history: { transitions: trimmed, maxEntries }, transition }
}

/** Every state a renderer could derive, for completeness checks. */
export const ALL_PRESENCE_STATES: readonly Phase26PresenceState[] = PHASE26_PRESENCE_STATES
