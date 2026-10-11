import type { AnyCoreEvent, CoreEventType } from '../events/envelope'
import {
  DEFAULT_MISSION_BUDGET,
  EMPTY_MISSION_SPEND,
  isMissionPriority,
  missionBudget,
  type MissionBudget,
  type MissionPriority,
} from './autonomy/types'
import { reduceAutonomyEvent } from './autonomy/fold'
import {
  canTransitionMission,
  readMissionStatus,
  MISSION_REASONS,
  missionLimits,
  type MissionLimitName,
  type MissionLimits,
  type MissionReason,
  type MissionRecord,
  type MissionState,
  type MissionStatus,
  type MissionVerificationRecord,
  type MissionVerificationState,
} from './types'

/**
 * MISSION STATE: a pure fold over the durable journal.
 *
 * ## What is here, and what deliberately is not
 *
 * The journal holds Mission *metadata*. It has no slot for a title, an intent or a
 * success criterion, and that is not an oversight to be fixed in a later phase — it
 * is the property that makes a Mission journal safe to keep in a backup, to copy to
 * another machine and to read while debugging. The private text lives in the
 * encrypted Mission store and nowhere else.
 *
 * ## Why a fold and not a store
 *
 * Same reasoning as Work: `mission.*` events are fsynced, ordered, validated
 * against a closed schema and replayed on every start. A second durable copy of the
 * same facts would be a second thing to recover and a second thing to get wrong.
 *
 * ## The reducer refuses illegal transitions
 *
 * This is the load-bearing part. The reducer is what runs on **replay**, so a
 * hand-edited or truncated journal claiming `draft → completed` must be refused
 * rather than folded into a state the live engine would never produce. A Mission
 * that reached `completed` in a replay, without a `mission.verification.completed`
 * having been written, would be a fabricated outcome — which is a zero-tolerance
 * invariant in the Red Team gauntlet.
 *
 * The reducer is pure and returns new objects, so replay and live operation share
 * one code path and cannot drift.
 */

export interface MissionStateShape {
  readonly missions: ReadonlyMap<string, MissionRecord>
  readonly sequence: number
}

export function initialMissionState(): MissionState {
  return { missions: new Map(), sequence: 0 }
}

const MISSION_EVENT_TYPES: ReadonlySet<CoreEventType> = new Set<CoreEventType>([
  'mission.created',
  'mission.content.updated',
  'mission.deleted',
  'mission.activated',
  'mission.paused',
  'mission.resumed',
  'mission.failed',
  'mission.cancelled',
  'mission.completed',
  'mission.run.attached',
  'mission.verification.requested',
  'mission.verification.completed',
  'mission.limit.exceeded',
  // Phase 47 autonomy. Read the new families in `reduceAutonomy`.
  // Phase 47. `mission.transitioned` is folded by `transition()` below rather than by the
  // autonomy fold: it is an ordinary lifecycle move and must pass through the same table
  // and the same refusals as `mission.activated`. The rest have their own handlers.
  'mission.transitioned',
  'mission.plan.committed',
  'mission.step.transitioned',
  'mission.evidence.recorded',
  'mission.blocker.changed',
  'mission.approval.requested',
  'mission.wake.scheduled',
  'mission.wake.fired',
  'mission.continuation.decided',
  'mission.budget.spent',
  'mission.budget.exceeded',
  'mission.intent.corrected',
  'mission.correction.ambiguous',
  'mission.step.interrupted',
])

export function isMissionEvent(type: CoreEventType): boolean {
  return MISSION_EVENT_TYPES.has(type)
}

export function reduceMissionState(state: MissionState, event: AnyCoreEvent): MissionState {
  if (!MISSION_EVENT_TYPES.has(event.type)) return state

  // Read as a plain record rather than as the event's declared payload union: the
  // switch below is over Mission event types only, and narrowing the union here
  // would mean repeating the whole table in a type position.
  const payload = event.payload as unknown as Record<string, unknown>
  const missionId = readId(payload, 'missionId')
  if (missionId === null) return state

  // The Phase 47 families are folded by their own module, which is where the plan,
  // step, evidence, blocker, approval, wake, budget and correction records are
  // defined. It returns null for any event it does not own so this switch stays the
  // single place that decides which family a type belongs to.
  const autonomy = reduceAutonomyEvent(state, event, missionId)
  if (autonomy !== null) return autonomy

  switch (event.type) {
    case 'mission.content.updated':
      return { ...state, sequence: event.sequence }
    case 'mission.deleted': {
      const record = state.missions.get(missionId)
      if (!record || (record.status !== 'draft' && !['completed', 'failed', 'cancelled'].includes(record.status))) return state
      const missions = new Map(state.missions)
      missions.delete(missionId)
      return { ...state, missions, sequence: event.sequence }
    }
    case 'mission.created': {
      const limits = readLimits(payload.limits)
      if (limits === null) return state
      const createdAt = readInstantField(payload.createdAt) ?? event.occurredAt
      const budget = readBudget(payload.budget)
      // A Mission written before Phase 47 carries no `budget` field at all. Reading
      // it as the code-owned default is the only honest option: the alternative is
      // refusing the creation, which would silently discard a Mission somebody set
      // up on an older build. The default is the *ceiling*, so an old journal cannot
      // grant itself more than a new one would be allowed.
      if (budget === null && payload.budget !== undefined) return state
      const mission: MissionRecord = {
        missionId,
        status: 'draft',
        createdAt,
        activatedAt: null,
        pausedAt: null,
        settledAt: null,
        deadlineAt: readInstantField(payload.deadlineAt) ?? createdAt,
        childRuns: [],
        limits,
        verification: null,
        reason: null,
        limitsHit: [],
        priority: readPriority(payload.priority),
        budget: budget ?? DEFAULT_MISSION_BUDGET,
        spend: EMPTY_MISSION_SPEND,
        activePlan: null,
        planRevisions: 0,
        evidence: [],
        blockers: [],
        // No approval registry, and the absence is the design: a Mission holds a pointer
        // to a Work gate or nothing at all.
        approval: null,
        wake: null,
        // Two numbers, and only two, are in the journal about the goal itself. See
        // `MissionRecord` for why, and for what would have to be invented without them.
        requestedQuantity: readPositiveInt(payload.requestedQuantity),
        resultCount: 0,
        corrections: [],
        awaitingOwner: false,
        lastDecision: null,
        lastUpdatedAt: createdAt,
      }
      const missions = new Map(state.missions)
      // A repeated `mission.created` for the same id is ignored rather than
      // resetting it, so a duplicated delivery cannot reset a live Mission to draft.
      if (missions.has(missionId)) return { ...state, sequence: event.sequence }
      missions.set(missionId, mission)
      return { missions, sequence: event.sequence }
    }

    case 'mission.run.attached': {
      const runId = readId(event.payload, 'runId')
      const current = state.missions.get(missionId)
      if (current === undefined || runId === null) return state
      // Idempotent: a replayed or redelivered attachment must not inflate the child
      // count, because the concurrency and total ceilings are enforced against it.
      if (current.childRuns.includes(runId)) return { ...state, sequence: event.sequence }
      const missions = new Map(state.missions)
      missions.set(missionId, { ...current, childRuns: [...current.childRuns, runId] })
      return { missions, sequence: event.sequence }
    }

    case 'mission.verification.requested': {
      const current = state.missions.get(missionId)
      if (current === undefined) return state
      const verifierId = readId(payload, 'verifierId')
      if (verifierId === null) return state
      const verification: MissionVerificationRecord = {
        verifierId,
        state: 'requested',
        requestedAt: event.occurredAt,
        settledAt: null,
        reason: null,
        requiredRunIds: readIdArray(payload, 'runIds'),
      }
      const missions = new Map(state.missions)
      missions.set(missionId, { ...current, verification })
      return { missions, sequence: event.sequence }
    }

    case 'mission.verification.completed': {
      const current = state.missions.get(missionId)
      if (current === undefined || current.verification === null) return state
      const state_ = readVerificationState(payload.outcome)
      if (state_ === null) return state
      const verification: MissionVerificationRecord = {
        ...current.verification,
        state: state_,
        settledAt: event.occurredAt,
        reason: readReason(payload.reason),
      }
      const missions = new Map(state.missions)
      missions.set(missionId, { ...current, verification })
      return { missions, sequence: event.sequence }
    }

    case 'mission.limit.exceeded': {
      const current = state.missions.get(missionId)
      const limit = readLimitName(payload.limit)
      if (current === undefined || limit === null) return state
      // Durable, so a restart cannot hide that a ceiling was hit. Without it a
      // Mission could quietly stop accepting Runs and nobody would know why.
      if (current.limitsHit.includes(limit)) return { ...state, sequence: event.sequence }
      const missions = new Map(state.missions)
      missions.set(missionId, { ...current, limitsHit: [...current.limitsHit, limit] })
      return { missions, sequence: event.sequence }
    }

    default:
      return transition(state, event, payload, missionId)
  }
}

/** One legal transition, or nothing at all. */
function transition(
  state: MissionState,
  event: AnyCoreEvent,
  payload: Record<string, unknown>,
  missionId: string,
): MissionState {
  const mission = state.missions.get(missionId)
  if (mission === undefined) return state

  const from = readMissionStatus(payload.from)
  const to = readMissionStatus(payload.to)
  if (from === null || to === null) return state
  // Two independent refusals: the history must agree with itself, and the move
  // must be legal. Either alone would be enough to be safe; both together mean a
  // journal cannot manufacture a state the engine would not reach.
  if (from !== mission.status) return state
  if (!canTransitionMission(from, to)) return state

  // The third refusal, and the one that stops a fabricated outcome.
  //
  // A `mission.completed` line is a *claim* that something was established. The live
  // engine never emits one without a `mission.verification.completed` saying `passed`
  // first, and the verifier that said so has to be the one named on the transition.
  // Without this check a three-line hand-written journal — created, activated,
  // completed — folds into a Mission that reports `completed` with no verification
  // behind it at all, which is precisely the fabricated outcome the Red Team gauntlet
  // calls zero-tolerance. The transition table cannot catch it, because
  // `active → completed` *is* a legal edge.
  if (to === 'completed') {
    const verification = mission.verification
    if (verification === null || verification.state !== 'passed') return state
    if (readId(payload, 'verifierId') !== verification.verifierId) return state
  }

  const missions = new Map(state.missions)
  const at = event.occurredAt
  missions.set(missionId, {
    ...mission,
    missionId,
    status: to,
    lastUpdatedAt: at,
    ...(to === 'active' && from === 'draft' ? { activatedAt: at } : {}),
    ...(to === 'active' && from === 'stopped' ? { pausedAt: null } : {}),
    ...(to === 'stopped' ? { pausedAt: at } : {}),
    ...(isSettled(to) ? { settledAt: at, reason: readReason(payload.reason) ?? MISSION_REASONS.owner } : {}),
  })
  return { missions, sequence: event.sequence }
}

function isSettled(status: MissionStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

/* ----------------------------------------------------------------- readers */

/** Budgets arrive from the journal, so they are re-validated rather than trusted. */
function readBudget(value: unknown): MissionBudget | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  try {
    return missionBudget(value as Partial<MissionBudget>)
  } catch {
    return null
  }
}

function readPriority(value: unknown): MissionPriority {
  // An absent or unrecognised priority reads as `routine`. This is the *lowest*
  // level deliberately: a hand-edited journal must not be able to promote a Mission
  // by writing a priority the domain does not have.
  return isMissionPriority(value) ? value : 'routine'
}

/** A positive whole number, or null. Used for the two goal numbers in the journal. */
export function readPositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

/** A non-negative whole number. Used for counts the fold derives itself. */
export function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : -1
}

/**
 * An instant, or null.
 *
 * A deadline that cannot be parsed is not a deadline, so a malformed instant reads as
 * absent and the caller applies its own fallback rather than trusting a string.
 */
export function readInstantField(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
}

function readId(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key]
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null
}

function readIdArray(payload: Record<string, unknown>, key: string): readonly string[] {
  const value = payload[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 256)
}

function readReason(value: unknown): MissionReason | null {
  return typeof value === 'string' && Object.hasOwn(MISSION_REASONS, value) ? (value as MissionReason) : null
}

function readLimitName(value: unknown): MissionLimitName | null {
  return typeof value === 'string' &&
    (['maxChildRuns', 'maxConcurrentChildRuns', 'lifetimeMs'] as readonly string[]).includes(value)
    ? (value as MissionLimitName)
    : null
}

function readVerificationState(value: unknown): MissionVerificationState | null {
  return typeof value === 'string' &&
    (['requested', 'passed', 'not_established', 'timeout', 'cancelled'] as readonly string[]).includes(value)
    ? (value as MissionVerificationState)
    : null
}

/**
 * Limits arrive from the journal, so they are re-validated rather than trusted.
 *
 * A journal is only as trustworthy as the least validated byte in it. A hand-edited
 * line raising `maxChildRuns` to a million would otherwise become a real ceiling
 * the engine enforces, which is a limit that exists only on disk.
 */
function readLimits(value: unknown): MissionLimits | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  try {
    // `missionLimits` refuses anything above the code-owned ceiling, which is
    // exactly the check needed for a value read back from a log.
    return missionLimits(value as Partial<MissionLimits>)
  } catch {
    return null
  }
}
