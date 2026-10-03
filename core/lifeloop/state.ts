import {
  DECIDE_OUTCOMES,
  LIFE_LOOP_EVENT_TYPES,
  LIFE_LOOP_EVENT_TYPE_SET,
  LIFE_LOOP_PAYLOAD_KEYS,
  FORBIDDEN_PAYLOAD_KEYS,
  LIFE_LOOP_LIMITS,
  LATCHED_STOP_CODE,
  OWNER_ESCALATIONS,
  isClearableStopCode,
  isContinuationState,
  isReconciliationCode,
  isWakeKind,
  isWakeSource,
  type ContinuationSignal,
  type ContinuationState,
  type Deadline,
  type DeadlineType,
  type DecideOutcome,
  type LifeLoopEventType,
  type LifeLoopLimits,
  type OwnerEscalation,
  type RetryCeiling,
  type WakeEvent,
} from './types'
import { interrupt, transition } from './machine'

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
  /**
   * The code from the most recent wake the registry refused, or null.
   *
   * Folded rather than held, because "why did Freya not look at that?" is a
   * question a person asks after the fact and there is nowhere else for the answer
   * to live. A refused wake does not move the loop, so this is the only trace it
   * leaves — which is exactly why it has to be in the journal rather than in a log
   * line that a restart would lose.
   */
  readonly lastRefusalCode: string | null
  /** When that refusal was recorded, so a stale answer is visibly stale. */
  readonly lastRefusalAt: string | null
  /**
   * What the loop concluded last, and what it resolved that down to.
   *
   * Folded rather than held for the same reason the refusal is: the gap between a
   * conclusion and the escalation it was allowed to carry is the only visible
   * evidence that focus suppressed an interrupt rather than the loop never having
   * wanted one. Those are very different things to have happened.
   */
  readonly conclusion: LifeLoopConclusion | null
}

export interface LifeLoopConclusion {
  readonly outcome: DecideOutcome
  readonly escalation: OwnerEscalation
  /** True when Attention — which owns the owner's attention — suppressed or demoted it. */
  readonly attentionSuppressed: boolean
}

export interface FoldResult {
  readonly state: LifeLoopState
  readonly anomalies: readonly FoldAnomaly[]
}

/**
 * Facts the single-entry fold cannot see for itself.
 *
 * Present because one of them decides whether a stop may be lifted, and a fold that
 * could not see it would let a hand-edited journal line self-clear a panic button.
 * `reduceLifeLoopState` derives both of them from the entries it is folding;
 * `reduceLifeLoopEntry` takes them from the caller, which is the running Core and
 * knows the latch because it is the thing that sets it.
 *
 * Defaulting to `false` is the direction that fails closed: a caller who knows
 * nothing about the latch cannot lift one.
 */
export interface FoldContext {
  /**
   * Whether the owner has cleared STOP ALL, evidenced by a
   * `security.stop_all.cleared` in the durable record or by the Core latch being
   * open.
   *
   * Required, and not inferred from "the loop is stopped": the loop's own terminal
   * state is reached by ordinary completion as well as by a stop, so it cannot tell
   * the two apart, and mistaking one for the other is exactly the bug this closes.
   */
  readonly ownerClearedStop: boolean
}

export const FOLD_CONTEXT_CLOSED: FoldContext = Object.freeze({ ownerClearedStop: false })

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
    lastRefusalCode: null,
    lastRefusalAt: null,
    conclusion: null,
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

function readDecideOutcome(value: unknown): DecideOutcome | null {
  return typeof value === 'string' && (DECIDE_OUTCOMES as readonly string[]).includes(value)
    ? (value as DecideOutcome)
    : null
}

function readOwnerEscalation(value: unknown): OwnerEscalation | null {
  return typeof value === 'string' && (OWNER_ESCALATIONS as readonly string[]).includes(value)
    ? (value as OwnerEscalation)
    : null
}

/**
 * Rebuild a deadline from a journal entry.
 *
 * The absolute instant the writer recorded wins, and only falls back to
 * `recordedAt + the code-owned default` when the entry did not carry one.
 *
 * That ordering is load-bearing. A wait the loop armed itself — a cooldown or a
 * retry backoff — is minutes long, and deriving its deadline from the default
 * would silently widen it to the thirty-day `wait` ceiling, so a two-second
 * backoff would survive a restart as a month of not trying. The absolute instant
 * is journaled precisely so a restart cannot move it.
 */
function buildDeadline(
  type: DeadlineType | null,
  recordedAt: string | null,
  absolute?: unknown,
): Deadline | null {
  if (type === null) return null
  if (typeof absolute === 'string' && Number.isFinite(Date.parse(absolute))) {
    return { type, expiresAt: new Date(Date.parse(absolute)).toISOString(), reason: `${type} deadline` }
  }
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
  context: FoldContext = FOLD_CONTEXT_CLOSED,
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
      // Bookkeeping, and deliberately *not* a move.
      //
      // A wake the registry refused never entered the continuation, so the loop is
      // exactly where it was: still `IDLE`, or still `WAIT` on whatever it was
      // waiting for. Consulting the table here would be wrong twice over — there
      // is no `IDLE -> DENY` edge, so a refused wake arriving at an idle loop
      // would be folded as tampering and silently dropped, and the refusal would
      // leave no trace in the journal at all.
      //
      // That trace is the whole point. A refusal is the one life-loop outcome the
      // owner cannot otherwise learn about, so it is recorded here; the dedupe key
      // is deliberately *not* consumed, because a wake that was never processed
      // may legitimately arrive again with the same reference.
      return {
        state: withState(state, {
          lastRefusalCode: readString(payload, 'code'),
          lastRefusalAt: recordedAt,
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
      const held = readDeadlineType(payload)
      const deadline = buildDeadline(held, recordedAt, payload.deadlineExpiresAt)

      // Approval parking is the one wait that is not the ordinary table's business.
      // `ALLOW -> WAIT` does not exist in that table and must not: it is not a
      // continuation step, it is an interruption, and the interruption table is
      // exactly the table that is allowed to override the ordinary one. So a wait
      // holding an `approval` deadline is settled by `interrupt` and by nothing
      // else, and an approval-parked entry arriving anywhere the interruption
      // table refuses it is recorded as tampering rather than quietly accepted.
      if (outcome === 'wait' && held === 'approval') {
        const pre = interrupt(state.state, 'approval-required')
        if (!pre.applied || !pre.awaitingApproval) {
          return {
            state,
            anomalies: [
              ...anomalies,
              {
                code: 'illegal-transition' as const,
                eventType: type,
                detail: `an approval was parked while the loop was ${state.state}`,
              },
            ],
          }
        }
        return {
          state: withState(state, {
            state: 'WAIT',
            deadline: deadline ?? state.deadline,
            stopCode: 'awaiting-approval',
            lastReason: type,
          }),
          anomalies,
        }
      }

      // Which signal carries a denial depends on where the loop is, and the table
      // says so: `WAKING` is denied by the filter, while `WAIT` has exactly one way
      // out and it is `deadline-expired` — a wait does not get refused, it runs out.
      // Choosing `filter-denied` unconditionally would be the same bug as before:
      // the fold would refuse its own runtime's legitimate entry and record it as
      // tampering, and the loop would sit in a wait whose deadline has already
      // passed for ever.
      const signal: ContinuationSignal =
        outcome === 'wait'
          ? 'condition-not-met'
          : state.state === 'WAIT'
            ? 'deadline-expired'
            : 'filter-denied'
      const illegal = move(signal)
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
          deadline: buildDeadline(readDeadlineType(payload), recordedAt, payload.deadlineExpiresAt),
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
          deadline:
            buildDeadline(readDeadlineType(payload), recordedAt, payload.deadlineExpiresAt) ??
            state.deadline,
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
      // continuation decision auditable without making it a state change — and the
      // conclusion it carries is what lets a reader see afterwards how loud the
      // loop wanted to be and how quiet it was allowed to be.
      const outcome = readDecideOutcome(payload.outcome)
      const escalation = readOwnerEscalation(payload.escalation)
      return {
        state: withState(state, {
          actionCount: readInteger(payload, 'actionCount') ?? state.actionCount,
          verificationCount: readInteger(payload, 'verificationCount') ?? state.verificationCount,
          conclusion:
            outcome === null || escalation === null
              ? state.conclusion
              : {
                  outcome,
                  escalation,
                  attentionSuppressed: payload.attentionSuppressed === true,
                },
          lastReason: type,
        }),
        anomalies,
      }
    }

    case 'lifeloop.reconciled': {
      // Not a continuation, and not in the ordinary table on purpose.
      //
      // Three producers — a restart, the owner pre-empting, the owner clearing
      // STOP ALL — and every one of them lands somewhere no signal in
      // `CONTINUATION_SIGNALS` points. A process that died in `ACTING` cannot be
      // resumed because the plan was in memory, so it has to be reconciled to
      // `IDLE`; adding a fake signal for that would put a step in the table that
      // is not a step, and the table's whole value is that every entry is one.
      //
      // The one thing it will not do is lift a stop. A stopped loop stays stopped
      // until `lifeloop.unstopped`, which the owner alone can cause.
      const code = readString(payload, 'code')
      if (code === null || !isReconciliationCode(code)) {
        return {
          state,
          anomalies: [
            ...anomalies,
            {
              code: 'malformed-payload' as const,
              eventType: type,
              detail: `${type} carried no reconciliation code from the closed list`,
            },
          ],
        }
      }
      if (state.state === 'STOP') {
        return {
          state,
          anomalies: [
            ...anomalies,
            {
              code: 'illegal-transition' as const,
              eventType: type,
              detail: 'lifeloop.reconciled arrived while STOP was latched; only the owner clears that',
            },
          ],
        }
      }
      const preserved = buildDeadline(readDeadlineType(payload), recordedAt, payload.deadlineExpiresAt)
      // Per-wake counters go. The dedupe keys, the attempt count and the unit of
      // work it belongs to do not, because a retry budget belongs to the work and
      // not to the wake that noticed it — and pre-emption must not be a way to
      // buy a fresh retry allowance.
      return {
        state: withState(state, {
          state: preserved === null ? 'IDLE' : 'WAIT',
          // A preserved wait keeps what it was waiting for; a reconciliation to
          // idle has nothing outstanding, so the wake goes with it.
          wake: preserved === null ? null : state.wake,
          wakeKey: preserved === null ? null : state.wakeKey,
          iterationCount: 0,
          actionCount: 0,
          verificationCount: 0,
          cognitionRequestCount: 0,
          deadline: preserved,
          stopCode: null,
          lastReason: type,
        }),
        anomalies,
      }
    }

    case 'lifeloop.unstopped': {
      // The only lift of STOP ALL that exists, and it needs two independent facts.
      //
      // The obvious one is that the loop was stopped. The one that matters is that
      // the *owner* cleared it — evidenced by a `security.stop_all.cleared` in the
      // record. Without the second, a single line written into the journal lifts the
      // panic button, which turns "Freya can be stopped" into "Freya can be un-stopped
      // by whoever has write access to a text file". And the loop's own terminal state
      // cannot stand in for it: `CONTINUE --loop-complete--> STOP` reaches the same
      // state, so "the loop is in STOP" does not mean "the owner pressed stop".
      if (state.state !== 'STOP') {
        return {
          state,
          anomalies: [
            ...anomalies,
            {
              code: 'illegal-transition' as const,
              eventType: type,
              detail: `lifeloop.unstopped arrived while the loop was ${state.state}, not STOP`,
            },
          ],
        }
      }
      if (!context.ownerClearedStop) {
        return {
          state,
          anomalies: [
            ...anomalies,
            {
              code: 'illegal-transition' as const,
              eventType: type,
              detail:
                'lifeloop.unstopped arrived with no cleared stop behind it; only the owner lifts that',
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
      //
      // Which stop it is matters, and the journal says. `loop-complete` is an
      // ordinary close-out that happens to end in the terminal state the table
      // reaches on `loop-complete`, and `interrupted-*` is a restart's honest
      // verdict; both are clearable by the close-out that follows them. A stop the
      // owner asked for is not, and the one word that distinguishes them is the
      // `stopCode` the entry carried.
      if (state.state === 'STOP' && !isClearableStopCode(state.stopCode)) {
        return {
          state,
          anomalies: [
            ...anomalies,
            {
              code: 'illegal-transition',
              eventType: type,
              detail:
                'lifeloop.reset arrived while a stop only the owner may lift was in force (' +
                String(state.stopCode) +
                ')',
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
      //
      // Re-asserting an existing stop is normally an anomaly — a second
      // `lifeloop.stopped` says somebody reached for the panic button twice. But
      // one re-assertion is not an anomaly and refusing it would be a real hole:
      // a loop that had *completed* (and so sits in STOP with a clearable
      // `stopCode`) must become latched when the owner presses STOP ALL during the
      // same tick, or the next close-out would quietly unfreighten the latch. The
      // upgrade is strictly one-directional — it can only turn a clearable stop
      // into an uncleared one — so accepting it cannot be used to release anything.
      const code = readString(payload, 'code')
      // Whether a close-out may lift this stop is decided by whether its code is one
      // of the clearable ones, never by whether it happens to be STOP. So an absent
      // code, a misspelt code and a code invented by a future lane are all latched,
      // and the recorded code itself is kept verbatim so a reader can see what was
      // written.
      //
      // One arrival while already stopped is legitimate and is *not* an anomaly: a
      // loop that had completed sits in STOP with a clearable code, and the owner
      // pressing the panic button during the same tick has to leave a latch behind.
      // Refusing it would be a real hole — the next close-out would then quietly
      // unfreighten a stop the owner had just asked for. The upgrade is strictly
      // one-directional, turning a clearable stop into an uncleared one, so
      // accepting it cannot be used to release anything. A second arrival while
      // *already latched* is still reported, because that is somebody reaching for
      // the button twice.
      if (state.state === 'STOP') {
        if (isClearableStopCode(state.stopCode)) {
          return {
            state: withState(state, { stopCode: LATCHED_STOP_CODE, lastReason: type }),
            anomalies,
          }
        }
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
          stopCode: code,
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
  // Whether the owner has cleared a stop, tracked from the *security* events rather
  // than from the loop's own. It has to be: the loop's terminal state is reached by
  // ordinary completion too, so it cannot tell a completion from a panic button, and
  // treating them alike is what would let one line in the log lift a stop.
  let ownerClearedStop = false
  for (const entry of entries) {
    if (entry.type === 'security.stop_all.cleared') ownerClearedStop = true
    if (entry.type === 'security.stop_all.activated') ownerClearedStop = false
    const result = reduceLifeLoopEntry(state, entry, { ownerClearedStop })
    state = result.state
    anomalies.push(...result.anomalies)
  }
  return { state, anomalies }
}

/**
 * Fold exactly one entry onto a state already derived from the journal.
 *
 * The single-entry form of {@link reduceLifeLoopState}, and it exists so the
 * runtime does not have to re-read the whole log after every append. It is the
 * same code path — `reduceLifeLoopState` calls it — so the live loop and a later
 * replay cannot disagree about what an event means, which is the property that
 * makes the loop's own state "no hidden durable state": whatever a reader gets by
 * replaying, the running process got by folding incrementally.
 *
 * `context` is required to be *stated*. A caller that omits it gets
 * `FOLD_CONTEXT_CLOSED`, which cannot lift a stop — so forgetting to pass the latch
 * fails closed rather than quietly granting the only transition in this module that
 * an outside party would want.
 */
export function reduceLifeLoopEntry(
  state: LifeLoopState,
  entry: LifeLoopJournalEntry,
  context: FoldContext = FOLD_CONTEXT_CLOSED,
): FoldResult {
  return applyEntry(state, entry, context)
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
  readonly lastRefusal: { readonly code: string; readonly at: string } | null
  readonly conclusion: LifeLoopConclusion | null
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
    // Absent rather than empty-stringed, so "nothing was refused" and "something
    // was refused with no code" cannot be rendered the same way.
    lastRefusal:
      state.lastRefusalCode === null
        ? null
        : { code: state.lastRefusalCode, at: state.lastRefusalAt ?? '' },
    conclusion: state.conclusion,
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


