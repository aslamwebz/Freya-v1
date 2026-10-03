import type { AnyCoreEvent, CoreEventType } from '../events/envelope'
import {
  canTransitionGoal,
  GOAL_REASONS,
  goalLimits,
  type GoalLimits,
  type GoalReason,
  type GoalRecord,
  type GoalState,
  type GoalStatus,
  type GoalCheckpointRecord,
} from './types'

/**
 * GOAL STATE: a pure fold over the durable journal.
 *
 * ## What is here, and what deliberately is not
 *
 * The journal holds goal *metadata*. It has no slot for a title, a description or
 * a completion criterion, and that is not an oversight to be fixed in a later
 * phase — it is the property that makes a goal journal safe to keep in a backup,
 * to copy to another machine and to read while debugging. The private text lives
 * in the encrypted goal store and nowhere else.
 *
 * ## Why a fold and not a store
 *
 * Same reasoning as Mission: `longhorizon.*` events are fsynced, ordered,
 * validated against a closed schema and replayed on every start. A second durable
 * copy of the same facts would be a second thing to recover and a second thing to
 * get wrong.
 *
 * ## The reducer refuses illegal transitions
 *
 * This is the load-bearing part. The reducer is what runs on **replay**, so a
 * hand-edited or truncated journal claiming `draft → completed` must be refused
 * rather than folded into a state the live engine would never produce. A goal
 * that reached `completed` in a replay, without a
 * `longhorizon.checkpoint.verified` having been written for every checkpoint,
 * would be a fabricated outcome — which is a zero-tolerance invariant in the Red
 * Team gauntlet.
 *
 * The reducer is pure and returns new objects, so replay and live operation share
 * one code path and cannot drift.
 */

export interface GoalStateShape {
  readonly goals: ReadonlyMap<string, GoalRecord>
  readonly checkpoints: ReadonlyMap<string, GoalCheckpointRecord>
  readonly sequence: number
}

export function initialGoalState(): GoalState {
  return { goals: new Map(), checkpoints: new Map(), sequence: 0 }
}

const GOAL_EVENT_TYPES: ReadonlySet<CoreEventType> = new Set<CoreEventType>([
  'longhorizon.goal.created',
  'longhorizon.goal.state-changed',
  'longhorizon.goal.completed',
  'longhorizon.goal.failed',
  'longhorizon.goal.cancelled',
  'longhorizon.checkpoint.started',
  'longhorizon.checkpoint.verified',
  'longhorizon.checkpoint.failed',
  'longhorizon.continuation.decided',
  'longhorizon.schedule.fired',
  'longhorizon.schedule.expired',
  'longhorizon.wake.received',
  'longhorizon.wake.denied',
])

export function isGoalEvent(type: CoreEventType): boolean {
  return GOAL_EVENT_TYPES.has(type)
}

export function reduceGoalState(state: GoalState, event: AnyCoreEvent): GoalState {
  if (!GOAL_EVENT_TYPES.has(event.type)) return state

  const payload = event.payload as unknown as Record<string, unknown>
  const goalId = readId(payload, 'goalId')
  if (goalId === null) return state

  switch (event.type) {
    case 'longhorizon.goal.created': {
      const limits = readLimits(payload.limits)
      if (limits === null) return state
      const createdAt = readInstant(payload.createdAt) ?? event.occurredAt
      const goal: GoalRecord = {
        goalId,
        state: 'draft',
        createdAt,
        activatedAt: null,
        pausedAt: null,
        settledAt: null,
        deadlineAt: readInstant(payload.deadlineAt) ?? createdAt,
        dependencies: readIdArray(payload, 'dependencies'),
        checkpoints: [],
        verification: null,
        reason: null,
        verifiedCheckpoints: 0,
        retryCount: 0,
        limitsHit: [],
      }
      const goals = new Map(state.goals)
      // A repeated `longhorizon.goal.created` for the same id is ignored rather
      // than resetting it, so a duplicated delivery cannot reset a live goal to
      // draft.
      if (goals.has(goalId)) return { ...state, sequence: event.sequence }
      goals.set(goalId, goal)
      return { ...state, goals, sequence: event.sequence }
    }

    case 'longhorizon.checkpoint.started': {
      const goal = state.goals.get(goalId)
      if (goal === undefined) return state
      const checkpointId = readId(payload, 'checkpointId')
      if (checkpointId === null) return state
      // Idempotent: a replayed or redelivered start must not inflate the
      // checkpoint count, because the per-goal ceiling is enforced against it.
      if (goal.checkpoints.includes(checkpointId)) return { ...state, sequence: event.sequence }
      const checkpoint: GoalCheckpointRecord = {
        checkpointId,
        goalId,
        order: readOrder(payload.order),
        kind: readId(payload, 'kind') ?? 'unknown',
        status: 'in-progress',
        verifiedAt: null,
        failureReason: null,
        attempts: 1,
      }
      const checkpoints = new Map(state.checkpoints)
      checkpoints.set(checkpointId, checkpoint)
      const goals = new Map(state.goals)
      goals.set(goalId, { ...goal, checkpoints: [...goal.checkpoints, checkpointId] })
      return { goals, checkpoints, sequence: event.sequence }
    }

    case 'longhorizon.checkpoint.verified': {
      const checkpoint = state.checkpoints.get(readId(payload, 'checkpointId') ?? '')
      const goal = state.goals.get(goalId)
      if (checkpoint === undefined || goal === undefined) return state
      const checkpoints = new Map(state.checkpoints)
      checkpoints.set(checkpoint.checkpointId, {
        ...checkpoint,
        status: 'verified',
        verifiedAt: event.occurredAt,
      })
      const goals = new Map(state.goals)
      goals.set(goalId, {
        ...goal,
        verifiedCheckpoints: goal.verifiedCheckpoints + 1,
        retryCount: 0,
      })
      return { goals, checkpoints, sequence: event.sequence }
    }

    case 'longhorizon.checkpoint.failed': {
      const checkpoint = state.checkpoints.get(readId(payload, 'checkpointId') ?? '')
      const goal = state.goals.get(goalId)
      if (checkpoint === undefined || goal === undefined) return state
      const reason = readReason(payload.reason)
      if (reason === null) return state
      const attempts = readAttempts(payload.attempts) ?? checkpoint.attempts + 1
      const checkpoints = new Map(state.checkpoints)
      checkpoints.set(checkpoint.checkpointId, {
        ...checkpoint,
        status: 'failed',
        failureReason: reason,
        attempts,
      })
      const goals = new Map(state.goals)
      goals.set(goalId, { ...goal, retryCount: attempts })
      return { goals, checkpoints, sequence: event.sequence }
    }

    case 'longhorizon.continuation.decided': {
      const goal = state.goals.get(goalId)
      if (goal === undefined) return state
      const decision = readId(payload, 'decision')
      if (decision === null) return state
      // Continuation decisions are journaled facts; they do not change goal state.
      // The decision is recorded in the journal for audit, but the goal's state
      // machine is the only thing that changes a goal's state.
      return { ...state, sequence: event.sequence }
    }

    case 'longhorizon.schedule.fired':
    case 'longhorizon.schedule.expired':
    case 'longhorizon.wake.received':
    case 'longhorizon.wake.denied': {
      // These are audit events. They do not change goal state.
      return { ...state, sequence: event.sequence }
    }

    default:
      return transition(state, event, payload, goalId)
  }
}

/** One legal transition, or nothing at all. */
function transition(
  state: GoalState,
  event: AnyCoreEvent,
  payload: Record<string, unknown>,
  goalId: string,
): GoalState {
  const goal = state.goals.get(goalId)
  if (goal === undefined) return state

  const from = readState(payload.from)
  const to = readState(payload.to)
  if (from === null || to === null) return state
  // Two independent refusals: the history must agree with itself, and the move
  // must be legal. Either alone would be enough to be safe; both together mean a
  // journal cannot manufacture a state the engine would not reach.
  if (from !== goal.state) return state
  if (!canTransitionGoal(from, to)) return state

  // The third refusal, and the one that stops a fabricated outcome.
  //
  // A `longhorizon.goal.completed` line is a *claim* that something was
  // established. The live engine never emits one without every checkpoint being
  // verified first. Without this check a three-line hand-written journal —
  // created, activated, completed — folds into a goal that reports `completed`
  // with no verification behind it at all, which is precisely the fabricated
  // outcome the Red Team gauntlet calls zero-tolerance. The transition table
  // cannot catch it, because `active → completed` *is* a legal edge.
  if (to === 'completed') {
    if (goal.checkpoints.length === 0) return state
    if (goal.verifiedCheckpoints < goal.checkpoints.length) return state
  }

  const goals = new Map(state.goals)
  const at = event.occurredAt
  goals.set(goalId, {
    ...goal,
    goalId,
    state: to,
    ...(to === 'active' && from === 'draft' ? { activatedAt: at } : {}),
    ...(to === 'active' && from === 'paused' ? { pausedAt: null } : {}),
    ...(to === 'paused' ? { pausedAt: at } : {}),
    ...(isSettled(to) ? { settledAt: at, reason: readReason(payload.reason) ?? GOAL_REASONS.owner } : {}),
  })
  return { ...state, goals, sequence: event.sequence }
}

function isSettled(state: GoalStatus): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled'
}

/* ----------------------------------------------------------------- readers */

function readId(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key]
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null
}

function readIdArray(payload: Record<string, unknown>, key: string): readonly string[] {
  const value = payload[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 256)
}

function readState(value: unknown): GoalStatus | null {
  return typeof value === 'string' && (['draft', 'active', 'paused', 'completed', 'failed', 'cancelled'] as readonly string[]).includes(value)
    ? (value as GoalStatus)
    : null
}

function readInstant(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
}

function readReason(value: unknown): GoalReason | null {
  return typeof value === 'string' && Object.hasOwn(GOAL_REASONS, value) ? (value as GoalReason) : null
}

function readOrder(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

function readAttempts(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

/**
 * Limits arrive from the journal, so they are re-validated rather than trusted.
 *
 * A journal is only as trustworthy as the least validated byte in it. A hand-edited
 * line raising `maxCheckpointsPerGoal` to a million would otherwise become a real
 * ceiling the engine enforces, which is a limit that exists only on disk.
 */
function readLimits(value: unknown): GoalLimits | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  try {
    // `goalLimits` refuses anything above the code-owned ceiling, which is
    // exactly the check needed for a value read back from a log.
    return goalLimits(value as Partial<GoalLimits>)
  } catch {
    return null
  }
}
