/**
 * THE HANDS STATE — deterministic state, projection and reducer primitives.
 *
 * This file provides the pure functions that govern the Hands domain state. It
 * is deterministic by construction: the same inputs always produce the same
 * outputs, with no clock, no I/O and no randomness.
 *
 * ## What is deliberately absent
 *
 * - **No store.** The Hands domain has no encrypted file, no journal and no
 *   durable record. It is a pure fold over events, like Work.
 * - **No execution.** Nothing here reaches for a browser, desktop, file or
 *   process.
 * - **No authority.** Nothing here is a permission or a grant.
 */

import type {
  HandsActionResult,
  HandsObservationRecord,
  HandsVerificationResult,
} from './contract'
import { HANDS_LIMITS, isTerminalHandsActionStatus, type HandsRefusalCode } from './types'

/**
 * The Hands domain state.
 *
 * A pure data structure that tracks all actions, observations, verifications
 * and refusals. It is derived from events and is the single source of truth
 * for "what has happened in the Hands domain".
 */
export interface HandsState {
  readonly actions: ReadonlyMap<string, HandsActionResult>
  readonly observations: ReadonlyMap<string, HandsObservationRecord>
  readonly verifications: ReadonlyMap<string, HandsVerificationResult>
  readonly refusals: ReadonlyMap<string, HandsActionRefusalEntry>
  /** Actions that have been verified (have a passing verification result). */
  readonly verifiedActions: ReadonlySet<string>
  /** The last durable sequence folded in. */
  readonly sequence: number
}

/**
 * A refusal entry, keyed by action id.
 */
export interface HandsActionRefusalEntry {
  readonly actionId: string
  readonly code: HandsRefusalCode
  readonly reason: string
  readonly capabilityId: string | null
  readonly refusedAt: string
}

/**
 * The initial Hands state.
 */
export function initialHandsState(): HandsState {
  return {
    actions: new Map(),
    observations: new Map(),
    verifications: new Map(),
    refusals: new Map(),
    verifiedActions: new Set(),
    sequence: 0,
  }
}

/**
 * Record an action result in the state.
 *
 * A pure function that returns a new state with the action result added. If the
 * action already exists, the existing record is preserved (idempotent).
 */
export function recordActionResult(state: HandsState, result: HandsActionResult): HandsState {
  if (state.actions.has(result.actionId)) {
    return state
  }
  const actions = new Map(state.actions)
  actions.set(result.actionId, result)
  return { ...state, actions }
}

/**
 * Record an observation in the state.
 *
 * A pure function that returns a new state with the observation added. The
 * observation is recorded only if the action exists and is not terminal.
 */
export function recordObservation(state: HandsState, observation: HandsObservationRecord): HandsState {
  const action = state.actions.get(observation.actionId)
  if (!action) {
    return state
  }
  if (isTerminalHandsActionStatus(action.status)) {
    return state
  }
  if (state.observations.has(observation.observationId)) {
    return state
  }
  const observations = new Map(state.observations)
  observations.set(observation.observationId, observation)
  return { ...state, observations }
}

/**
 * Record a verification result in the state.
 *
 * A pure function that returns a new state with the verification result added.
 * If the verification result has `status: 'passed'`, the action is added to the
 * verified set.
 *
 * **It is impossible for an action to be added to the verified set without a
 * verification result with `status: 'passed'`.** The verified set is updated
 * only when a passing verification result is recorded.
 */
export function recordVerificationResult(
  state: HandsState,
  result: HandsVerificationResult,
): HandsState {
  if (state.verifications.has(result.verificationId)) {
    return state
  }
  const verifications = new Map(state.verifications)
  verifications.set(result.verificationId, result)

  let verifiedActions = state.verifiedActions
  if (result.status === 'passed') {
    const next = new Set(state.verifiedActions)
    next.add(result.actionId)
    verifiedActions = next
  }

  return { ...state, verifications, verifiedActions }
}

/**
 * Record a refusal in the state.
 *
 * A pure function that returns a new state with the refusal added.
 */
export function recordRefusal(state: HandsState, entry: HandsActionRefusalEntry): HandsState {
  if (state.refusals.has(entry.actionId)) {
    return state
  }
  const refusals = new Map(state.refusals)
  refusals.set(entry.actionId, entry)
  return { ...state, refusals }
}

/**
 * Whether an action has been verified.
 *
 * A pure function that checks the verified set. An action is verified only when
 * a verification result with `status: 'passed'` exists.
 */
export function isActionVerified(state: HandsState, actionId: string): boolean {
  return state.verifiedActions.has(actionId)
}

/**
 * The observations for an action.
 *
 * A pure function that returns the observations recorded against an action, in
 * the order they were recorded.
 */
export function observationsForAction(
  state: HandsState,
  actionId: string,
): readonly HandsObservationRecord[] {
  return [...state.observations.values()].filter((obs) => obs.actionId === actionId)
}

/**
 * The verification results for an action.
 *
 * A pure function that returns the verification results recorded against an
 * action, in the order they were recorded.
 */
export function verificationsForAction(
  state: HandsState,
  actionId: string,
): readonly HandsVerificationResult[] {
  return [...state.verifications.values()].filter((ver) => ver.actionId === actionId)
}

/**
 * The Hands projection — everything the renderer may know about Hands.
 *
 * A read-only projection of durable state. Every field is either an id, a count,
 * a status, an instant, or a measured length. No label, no input, no
 * observation content.
 */
export interface HandsProjection {
  readonly health: 'unavailable' | 'ready'
  readonly reason: string | null
  readonly actionCount: number
  readonly verifiedCount: number
  readonly failedCount: number
  readonly cancelledCount: number
  readonly timedOutCount: number
  readonly observationCount: number
  readonly verificationCount: number
  readonly refusalCount: number
  readonly verifiedActionIds: readonly string[]
  readonly limits: typeof HANDS_LIMITS
}

/**
 * The absent Hands projection.
 *
 * Shown before Core has a Hands engine. Mirrors `ABSENT_WORK_PROJECTION`: a
 * board must be able to say "I don't know" distinctly from "there is no work".
 */
export const ABSENT_HANDS_PROJECTION: HandsProjection = Object.freeze({
  health: 'unavailable',
  reason: 'Core has not reported yet',
  actionCount: 0,
  verifiedCount: 0,
  failedCount: 0,
  cancelledCount: 0,
  timedOutCount: 0,
  observationCount: 0,
  verificationCount: 0,
  refusalCount: 0,
  verifiedActionIds: [],
  limits: HANDS_LIMITS,
})

/**
 * Build the renderer-safe projection.
 *
 * A pure function over durable state, so the same call serves the live board
 * and any projection a test wants to assert.
 */
export function projectHands(state: HandsState): HandsProjection {
  let verifiedCount = 0
  let failedCount = 0
  let cancelledCount = 0
  let timedOutCount = 0

  for (const action of state.actions.values()) {
    switch (action.status) {
      case 'completed':
        if (state.verifiedActions.has(action.actionId)) {
          verifiedCount += 1
        }
        break
      case 'failed':
        failedCount += 1
        break
      case 'cancelled':
        cancelledCount += 1
        break
      case 'timed_out':
        timedOutCount += 1
        break
    }
  }

  return {
    health: 'ready',
    reason: null,
    actionCount: state.actions.size,
    verifiedCount,
    failedCount,
    cancelledCount,
    timedOutCount,
    observationCount: state.observations.size,
    verificationCount: state.verifications.size,
    refusalCount: state.refusals.size,
    verifiedActionIds: [...state.verifiedActions],
    limits: HANDS_LIMITS,
  }
}
