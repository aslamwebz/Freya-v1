import {
  LIFE_LOOP_EVENT_TYPES,
  LIFE_LOOP_EVENT_TYPE_SET,
  LIFE_LOOP_PAYLOAD_KEYS,
  FORBIDDEN_PAYLOAD_KEYS,
  LIFE_LOOP_LIMITS,
  isContinuationState,
  isWakeKind,
  isWakeSource,
  type ContinuationSignal,
  type ContinuationState,
  type Deadline,
  type DeadlineType,
  type LifeLoopEventType,
  type LifeLoopLimits,
  type RetryCeiling,
  type WakeEvent,
} from './types'
import { transition } from './machine'

import {
  DEADLINE_DEFAULT_MS,
  retryCeilingReached,
} from './deadlines'

/**
 * The event-sourced fold.
 *
 * Everything the life loop knows about itself is derived from its journal, by
 * this file, and from nothing else. There is no field here that is not computed,
 * which is what "no hidden durable state" means in practice: kill the process,
 * replay the same events, get the same state.
 *
 * The fold is deliberately untrusting of its own input. It validates the payload
 * against the closed vocabulary, refuses forbidden keys, caps text length, checks
 * that every state change it applies is one the state machine permits, and
 * records everything suspicious in `anomalies` rather than repairing it. A
 * journal that has been tampered with produces a *visible* wrong answer, never a
 * quietly plausible one.
 */

/** The shape this module needs from a journal entry. Anything wider is ignored. */
export interface LifeLoopJournalEntry {
  readonly type: string
  readonly recordedAt?: string
  readonly payload?: unknown
}

export type FoldAnomalyCode =
  | 'unknown-event-type'
  | 'malformed-payload'
  | 'unknown-payload-key'
  | 'forbidden-payload-key'
  | 'oversized-payload-text'
  | 'illegal-transition'
  | 'terminal-state-re-entered'

export interface FoldAnomaly {
  readonly code: FoldAnomalyCode
  readonly eventType: string
  readonly detail: string
}

export interface LifeLoopState {
  readonly state: ContinuationState
  readonly wake: WakeEvent | null
  readonly wakeKey: string | null
  readonly iterationCount: number
  readonly actionCount: number
  readonly verificationCount: number
  readonly cognitionRequestCount: number
  /**
   * Failed attempts at the step in hand, this wake.
   *
   * Journaled rather than held in memory because a retry ceiling that resets on
   * restart is not a ceiling: a step that crashes the app on each attempt would
   * otherwise be tried an unbounded number of times across an unbounded number of
   * restarts. This is what makes `limit-attempts` survive a restart.
   *
   * It follows the *unit of work*, not the wake: a new wake about the same goal
   * continues the count, and a new goal starts a fresh budget.
   */
  readonly attemptCount: number
  /**
   * The goal the attempt count belongs to.
   *
   * Kept across the close-out, because the close-out is bookkeeping and not a
   * change of work: dropping it here would let a retry budget reset once per
   * attempt, which is the same as having no ceiling at all.
   */
  readonly unitRef: string | null
  readonly deadline: Deadline | null
  /** Dedupe keys consumed, in order. Bounded; the oldest are dropped. */
  readonly processedWakeKeys: readonly string[]
  readonly stopCode: string | null
  readonly lastReason: string | null
}

export interface FoldResult {
  readonly state: LifeLoopState
  readonly anomalies: readonly FoldAnomaly[]
}

/** How many dedupe keys are retained. A bound, like everything else here. */
const MAX_PROCESSED_WAKE_KEYS = 256

/** The longest text a life-loop payload may carry, from the frozen limits. */
const MAX_PAYLOAD_TEXT = 200

export function initialLifeLoopState(): LifeLoopState {
  return {
    state: 'IDLE',
    wake: null,
    wakeKey: null,
    iterationCount: 0,
    actionCount: 0,
    verificationCount: 0,
    cognitionRequestCount: 0,
    attemptCount: 0,
    unitRef: null,
    deadline: null,
    processedWakeKeys: [],
    stopCode: null,
    lastReason: null,
  }
}

function readString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readInteger(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const rounded = Math.floor(value)
  return rounded < 0 ? null : rounded
}

function readDeadlineType(payload: Record<string, unknown>): DeadlineType | null {
  const value = payload.deadlineType
  if (value === 'verification' || value === 'approval' || value === 'wait' || value === 'action') {
    return value
  }
  return null
}

function buildDeadline(type: DeadlineType | null, recordedAt: string | null): Deadline | null {
  if (type === null) return null
  const base = Date.parse(recordedAt ?? '')
  const start = Number.isFinite(base) ? base : 0
  return {
    type,
    expiresAt: new Date(start + DEADLINE_DEFAULT_MS[type]).toISOString(),
    reason: `${type} deadline`,
  }
}

/** The closed reasons a payload key may be rejected for. */
function inspectPayload(type: LifeLoopEventType, payload: Record<string, unknown>): FoldAnomaly[] {
  const anomalies: FoldAnomaly[] = []
  const allowed = LIFE_LOOP_PAYLOAD_KEYS[type]
  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_PAYLOAD_KEYS.has(key)) {
      // Authority arriving in a payload is an escalation attempt, not a new
      // field. Named loudly and dropped.
      anomalies.push({
        code: 'forbidden-payload-key',
        eventType: type,
        detail: `${type} carried "${key}", which may never appear in a life-loop payload`,
      })
      continue
    }
    if (!allowed.includes(key)) {
      anomalies.push({
        code: 'unknown-payload-key',
        eventType: type,
        detail: `${type} carried "${key}", which is not in its closed payload vocabulary`,
      })
    }
  }
  for (const value of Object.values(payload)) {
    if (typeof value === 'string' && value.length > MAX_PAYLOAD_TEXT) {
      anomalies.push({
        code: 'oversized-payload-text',
        eventType: type,
        detail: `${type} carried a ${value.length}-character string, over the ${MAX_PAYLOAD_TEXT}-character ceiling`,
      })
    }
  }
  return anomalies
}

function withState(state: LifeLoopState, patch: Partial<LifeLoopState>): LifeLoopState {
  return { ...state, ...patch }
}

/**
 * Apply one journal entry.
 *
 * Every state change goes through `transition()`, so the fold cannot invent a
 * move the state machine does not permit. Where an entry would move the loop
 * illegally the state is left alone and an anomaly is recorded — a journal that
 * claims Freya went `IDLE -> ACTING` is evidence of tampering, and folding it
 * anyway would be believing the attacker.
 */
function applyEntry(
  state: LifeLoopState,
  entry: LifeLoopJournalEntry,
): { readonly state: LifeLoopState; readonly anomalies: readonly FoldAnomaly[] } {
  if (!entry.type.startsWith('lifeloop.')) return { state, anomalies: [] }
  if (!LIFE_LOOP_EVENT_TYPE_SET.has(entry.type)) {
    return {
      state,
      anomalies: [
        {
          code: 'unknown-event-type',
          eventType: entry.type,
          detail: `${entry.type} is not a life-loop event type`,
        },
      ],
    }
  }
  const type = entry.type as LifeLoopEventType
  const rawPayload = entry.payload
  if (typeof rawPayload !== 'object' || rawPayload === null || Array.isArray(rawPayload)) {
    return {
      state,
      anomalies: [
        { code: 'malformed-payload', eventType: type, detail: `${type} carried no object payload` },
      ],
    }
  }
  const payload = rawPayload as Record<string, unknown>

  const anomalies: FoldAnomaly[] = inspectPayload(type, payload)

  const recordedAt = typeof entry.recordedAt === 'string' ? entry.recordedAt : null

  // Consult the state machine before every move. An entry that would move the
  // loop somewhere the machine forbids is recorded as an anomaly and dropped.
  const move = (signal: ContinuationSignal): readonly FoldAnomaly[] => {
    const result = transition(state.state, signal)
    if (result.ok) return []
    return [
      {
        code: 'illegal-transition',
        eventType: type,
        detail: `${type} tried to move ${state.state} on "${signal}" (${result.code})`,
      },
    ]
  }

  switch (type) {
    case 'lifeloop.wake.received': {
      const wake = readFlatWake(payload)
      const wakeKey = readString(payload, 'wakeKey')
      const iteration = readInteger(payload, 'iteration') ?? 0
      // A wake is journaled flat rather than nested, and this is the one place
      // the whole wake is reconstructed. It is still metadata only: two
      // timestamps, a closed kind, and two references.
      //
      // A fresh wake restarts every per-wake counter. This is what makes
      // "bounded per wake" mean what it says rather than "bounded per process".
      const illegal = move(wakeSignalFor(state.state))
      if (illegal.length > 0) return { state, anomalies: [...anomalies, ...illegal] }
      const keys = wakeKey === null ? state.processedWakeKeys : dedupeAppend(state.processedWakeKeys, wakeKey)
      // Per-wake counters start again on a fresh wake. The attempt counter is the
      // exception: a retry budget belongs to the unit of work, not to the wake
      // that happened to notice it. Waking about the same goal continues the
      // count — otherwise a step that crashed the app on each try would be
      // retried three times per restart, for ever.
      const sameUnitOfWork = wake !== null && wake.goalRef !== null && wake.goalRef === state.unitRef
      return {
        state: withState(state, {
          state: 'WAKING',
          wake,
          wakeKey,
          iterationCount: iteration,
          actionCount: 0,
          verificationCount: 0,
          cognitionRequestCount: 0,
          attemptCount: sameUnitOfWork ? state.attemptCount : 0,
          unitRef: wake?.goalRef ?? null,
          deadline: null,
          processedWakeKeys: keys,
          stopCode: null,
          lastReason: type,
        }),
        anomalies,
      }
    }

    case 'lifeloop.wake.denied': {
      const illegal = move('filter-denied')
      if (illegal.length > 0) return { state, anomalies: [...anomalies, ...illegal] }
      return {
        state: withState(state, {
          state: 'DENY',
          wake: readFlatWake(payload) ?? state.wake,
          deadline: null,
          stopCode: readString(payload, 'code'),
          lastReason: type,
        }),
        anomalies,
      }
    }

    case 'lifeloop.filter.passed': {
      const illegal = move('filter-allowed')
      if (illegal.length > 0) return { state, anomalies: [...anomalies, ...illegal] }
      return {
        state: withState(state, { state: 'ALLOW', deadline: null, stopCode: null, lastReason: type }),
        anomalies,
      }
    }

    case 'lifeloop.filter.denied': {
      // One event, two outcomes: the WAIT entry action and the DENY entry action
      // are the same record with different payloads, so a reader can never be
      // left wondering whether a wait was a refusal.
      const outcome = payload.outcome === 'wait' ? 'wait' : 'deny'
      const deadline = buildDeadline(readDeadlineType(payload), recordedAt)
      const illegal = move(outcome === 'wait' ? 'condition-not-met' : 'filter-denied')
      if (illegal.length > 0) return { state, anomalies: [...anomalies, ...illegal] }
      return {
        state: withState(state, {
          state: outcome === 'wait' ? 'WAIT' : 'DENY',
          deadline: outcome === 'wait' ? deadline : null,
          stopCode: readString(payload, 'code'),
          lastReason: type,
        }),
        anomalies,
      }
    }

    case 'lifeloop.cognition.requested': {
      // Bookkeeping, not a move. The state stays ALLOW because thinking about
      // something is not acting on it.
      return {
        state: withState(state, {
          cognitionRequestCount: state.cognitionRequestCount + 1,
          lastReason: type,
        }),
        anomalies,
      }
    }

    case 'lifeloop.cognition.denied': {
      const illegal = move('cognition-denied')
      if (illegal.length > 0) return { state, anomalies: [...anomalies, ...illegal] }
      return {
        state: withState(state, {
          state: 'DENY',
          deadline: null,
          stopCode: readString(payload, 'code'),
          lastReason: type,
        }),
        anomalies,
      }
    }

    case 'lifeloop.action.started': {
      const illegal = move('cognition-allowed')
      if (illegal.length > 0) return { state, anomalies: [...anomalies, ...illegal] }
      return {
        state: withState(state, {
          state: 'ACTING',
          deadline: buildDeadline(readDeadlineType(payload), recordedAt),
          actionCount: state.actionCount + 1,
          lastReason: type,
        }),
        anomalies,
      }
    }

    case 'lifeloop.action.completed': {
      const illegal = move('action-completed')
      if (illegal.length > 0) return { state, anomalies: [...anomalies, ...illegal] }
      return {
        state: withState(state, {
          state: 'VERIFYING',
          deadline: buildDeadline('verification', recordedAt),
          lastReason: type,
        }),
        anomalies,
      }
    }

    case 'lifeloop.action.failed': {
      const illegal = move('action-failed')
      if (illegal.length > 0) return { state, anomalies: [...anomalies, ...illegal] }
      return {
        state: withState(state, {
          state: 'DENY',
          // The attempt is counted even though the step failed, because that is
          // what a retry ceiling counts. `retryCeilingFor` turns this into the
          // refusal the next attempt gets.
          attemptCount: state.attemptCount + 1,
          deadline: null,
          stopCode: readString(payload, 'code'),
          lastReason: type,
        }),
        anomalies,
      }
    }

    case 'lifeloop.verification.started': {
      // Bookkeeping, not a move — the move into VERIFYING was `action-completed`.
      // But it still has to *hold*, and only a loop that is actually verifying can
      // hold anything: arming a deadline from IDLE would put a life-loop timer
      // on a loop with no work, which is the shape a self-running timer takes.
      if (state.state !== 'VERIFYING') {
        return {
          state,
          anomalies: [
            ...anomalies,
            {
              code: 'illegal-transition' as const,
              eventType: type,
              detail: `a verification was started while the loop was ${state.state}, not VERIFYING`,
            },
          ],
        }
      }
      return {
        state: withState(state, {
          // A payload that names no deadline type does not *remove* the deadline
          // the loop is already holding. Clearing it would leave a verifying loop
          // unbounded just because one entry was terse.
          deadline: buildDeadline(readDeadlineType(payload), recordedAt) ?? state.deadline,
          verificationCount: state.verificationCount + 1,
          lastReason: type,
        }),
        anomalies,
      }
    }

    case 'lifeloop.verification.passed': {
      const illegal = move('verification-passed')
      if (illegal.length > 0) return { state, anomalies: [...anomalies, ...illegal] }
      return {
        state: withState(state, {
          state: 'CONTINUE',
          deadline: null,
          lastReason: type,
        }),
        anomalies,
      }
    }

    case 'lifeloop.verification.failed': {
      const illegal = move('verification-failed')
      if (illegal.length > 0) return { state, anomalies: [...anomalies, ...illegal] }
      return {
        state: withState(state, {
          state: 'DENY',
          attemptCount: state.attemptCount + 1,
          deadline: null,
          stopCode: readString(payload, 'code'),
          lastReason: type,
        }),
        anomalies,
      }
    }

    case 'lifeloop.continuation.decided': {
      // Also bookkeeping: the decision is *about* the next move, which is
      // journaled by the event for that move. Counting here keeps the
      // continuation decision auditable without making it a state change.
      return {
        state: withState(state, {
          actionCount: readInteger(payload, 'actionCount') ?? state.actionCount,
          verificationCount: readInteger(payload, 'verificationCount') ?? state.verificationCount,
          lastReason: type,
        }),
        anomalies,
      }
    }

    case 'lifeloop.reset': {
      // The close-out, and the only way a refused loop becomes available again.
      // Per-wake counters go; the dedupe keys, the attempt count and the unit of
      // work it belongs to do not, because the retry budget belongs to the work
      // and not to the wake that noticed it.
      const illegal = move('reset')
      if (illegal.length > 0) return { state, anomalies: [...anomalies, ...illegal] }
      // The ordinary table does permit STOP -> IDLE on reset, because clearing the
      // latch is the owner's act and the owner clears it explicitly. That act is
      // journaled by whoever performs it; a life-loop lifecycle entry must never be
      // the thing that unfreightens a stop, or the latch would be one event away
      // from self-clearing.
      if (state.state === 'STOP') {
        return {
          state,
          anomalies: [
            ...anomalies,
            {
              code: 'illegal-transition',
              eventType: type,
              detail: 'lifeloop.reset arrived while STOP was latched; only the owner clears that',
            },
          ],
        }
      }
      return {
        state: withState(state, {
          state: 'IDLE',
          wake: null,
          wakeKey: null,
          iterationCount: 0,
          actionCount: 0,
          verificationCount: 0,
          cognitionRequestCount: 0,
          deadline: null,
          stopCode: null,
          lastReason: type,
        }),
        anomalies,
      }
    }

    case 'lifeloop.stopped': {
      // STOP ALL reaches every state, including a terminal one, so this entry
      // does not consult the ordinary table. It is the one event that can
      // override terminality, and it can only ever move *to* STOP.
      const reachedFromTerminal = state.state === 'STOP' || state.state === 'DENY'
      if (state.state === 'STOP') {
        return {
          state,
          anomalies: [
            {
              code: 'terminal-state-re-entered',
              eventType: type,
              detail: 'lifeloop.stopped arrived while already STOP',
            },
          ],
        }
      }
      return {
        state: withState(state, {
          state: 'STOP',
          deadline: null,
          stopCode: readString(payload, 'code') ?? (reachedFromTerminal ? 'stop-all-latched' : null),
          lastReason: type,
        }),
        anomalies,
      }
    }

    default: {
      // Unreachable: `type` is narrowed to the closed set above.
      const exhaustive: never = type
      return {
        state,
        anomalies: [
          {
            code: 'unknown-event-type',
            eventType: String(exhaustive),
            detail: 'a life-loop event type this fold does not handle',
          },
        ],
      }
    }
  }
}

/**
 * The signal that takes the loop *to* WAKING, given where it is now.
 *
 * One journal event, three doors: an idle loop receiving a wake, a waiting loop
 * being woken by a new event, and a continuation going round again. The fold has
 * to know which, because the state machine refuses a move the table does not
 * contain, and folding "CONTINUE received a wake" as `wake-received` would report
 * a perfectly ordinary loop iteration as tampering.
 */
function wakeSignalFor(state: ContinuationState): ContinuationSignal {
  if (state === 'WAIT') return 'next-wake'
  if (state === 'CONTINUE') return 'next-iteration'
  return 'wake-received'
}

/** Rebuild the wake from a flat `lifeloop.wake.received` payload. */
function readFlatWake(payload: Record<string, unknown>): WakeEvent | null {
  const source = payload.source
  const kind = payload.kind
  const wakeId = payload.wakeId
  const occurredAt = payload.occurredAt
  const observedAt = payload.observedAt
  if (!isWakeSource(source) || !isWakeKind(kind)) return null
  if (typeof wakeId !== 'string' || wakeId.length === 0) return null
  if (typeof occurredAt !== 'string' || typeof observedAt !== 'string') return null
  return {
    wakeId,
    source,
    kind,
    goalRef: typeof payload.goalRef === 'string' ? payload.goalRef : null,
    sourceRef: typeof payload.sourceRef === 'string' ? payload.sourceRef : null,
    occurredAt,
    observedAt,
  }
}

function dedupeAppend(keys: readonly string[], key: string): readonly string[] {
  const next = [...keys, key]
  return next.length > MAX_PROCESSED_WAKE_KEYS ? next.slice(next.length - MAX_PROCESSED_WAKE_KEYS) : next
}

/**
 * Fold a journal into the loop's state.
 *
 * Total and deterministic: the same entries in the same order always produce the
 * same state and the same anomalies. Entries belonging to other subsystems are
 * passed over untouched, so this can be handed a whole Core journal.
 */
export function reduceLifeLoopState(entries: readonly LifeLoopJournalEntry[]): FoldResult {
  let state = initialLifeLoopState()
  const anomalies: FoldAnomaly[] = []
  for (const entry of entries) {
    const result = applyEntry(state, entry)
    state = result.state
    anomalies.push(...result.anomalies)
  }
  return { state, anomalies }
}

/**
 * Fold only entries belonging to one wake.
 *
 * Recovery and assertion code both need "what had happened by the end of *this*
 * wake", and slicing by `wakeId` is the only way to answer that without inventing
 * a notion of session.
 */
export function reduceLifeLoopWake(
  entries: readonly LifeLoopJournalEntry[],
  wakeId: string,
): FoldResult {
  const scoped = entries.filter((entry) => {
    const payload = entry.payload
    if (typeof payload !== 'object' || payload === null) return false
    return (payload as Record<string, unknown>).wakeId === wakeId
  })
  return reduceLifeLoopState(scoped)
}

/** The renderer-safe projection. Metadata only, and every field closed. */
export function projectLifeLoopStatus(state: LifeLoopState): {
  readonly state: ContinuationState
  readonly iterationCount: number
  readonly actionCount: number
  readonly verificationCount: number
  readonly cognitionRequestCount: number
  readonly attemptCount: number
  readonly retriesExhausted: boolean
  readonly currentWake: WakeEvent | null
  readonly currentDeadline: Deadline | null
  readonly isIdle: boolean
  readonly isStopped: boolean
} {
  return {
    state: state.state,
    iterationCount: state.iterationCount,
    actionCount: state.actionCount,
    verificationCount: state.verificationCount,
    cognitionRequestCount: state.cognitionRequestCount,
    attemptCount: state.attemptCount,
    retriesExhausted: retryCeilingReached(retryCeilingFor(state)),
    currentWake: state.wake,
    currentDeadline: state.deadline,
    isIdle: state.state === 'IDLE',
    isStopped: state.state === 'STOP',
  }
}

/**
 * The retry ceiling for the step in hand, derived from the journaled attempt count.
 *
 * The ceiling is code-owned and only ever narrows; `currentAttempt` is the count
 * the journal already holds, so this survives a restart without any in-memory
 * carry-over. `pendingScheduleCount` is deliberately absent — pending schedules
 * belong to Attention, and copying them into the loop would make a second source
 * of truth for something Core already owns.
 */
export function retryCeilingFor(
  state: LifeLoopState,
  limits: LifeLoopLimits = LIFE_LOOP_LIMITS,
): RetryCeiling {
  return {
    maxAttempts: limits.maxAttemptsPerUnit,
    currentAttempt: Math.min(state.attemptCount, limits.maxAttemptsPerUnit),
    baseBackoffMs: limits.baseBackoffMs,
    maxBackoffMs: limits.maxBackoffMs,
    jitterMs: limits.jitterMs,
  }
}

/** The event types this fold understands, for a caller that wants to filter. */
export { LIFE_LOOP_EVENT_TYPES, isContinuationState }
