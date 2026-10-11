import type { AnyCoreEvent, CoreEventType } from '../events/envelope'
import { isCapability } from '../security/guard'
import type { Capability } from '../../shared/contracts/capabilities'
import {
  canTransitionAssignment,
  canTransitionWorker,
  DEFAULT_WORKER_BUDGET,
  isAssignableToWorker,
  isTerminalAssignmentStatus,
  isTerminalWorkerStatus,
  isWorkerSpecialisation,
  WORKER_STATUSES,
  WORKFORCE_CLAIM_KINDS,
  WORKFORCE_CLAIM_REFUSALS,
  WORKFORCE_CLAIM_DECISIONS,
  WORKFORCE_LIMITS,
  WORKFORCE_MESSAGE_KINDS,
  WORKFORCE_REASONS,
  WORKER_TERMINAL_STATUSES,
  workerBudget,
  type AssignmentRecord,
  type AssignmentStatus,
  type ClaimRecord,
  type TeamRecord,
  type TeamStatus,
  type WorkerBudget,
type WorkerRecord,
  type WorkerSpecialisation,
  type WorkerSpend,
  type WorkerStatus,
  type WorkforceLimitName,
  type WorkforceClaimDecision,
  type WorkforceClaimKind,
  type WorkforceClaimRefusal,
  type WorkforceMessageKind,
  type WorkforceMessageRecord,
  type WorkforceReason,
  type WorkforceState,
} from './types'

/**
 * WORKFORCE STATE: a pure fold over the durable journal.
 *
 * ## Why a fold and not a store
 *
 * Exactly the argument `core/work/state.ts` and `core/missions/state.ts` make.
 * `workforce.*` events are fsynced, sequence-ordered, validated against a closed
 * schema and replayed on every start. A second durable copy of the same facts would
 * be a second thing to recover and a second thing to get wrong.
 *
 * ## What a replayed journal is not allowed to do
 *
 * The fold is the door every journal line comes through, including a hand-edited one.
 * It refuses, rather than believes:
 *
 * - **a capability a worker may not hold.** Re-read against the *closed worker
 *   vocabulary*, so a forged `workforce.capability.assigned` naming `work.execute` or
 *   `mission.manage` is dropped rather than granting it. Without this the only place
 *   a worker's authority existed would be a line in a text file.
 * - **a transition edge that does not exist**, and a `from` that disagrees with the
 *   history. Same two refusals Mission's fold makes.
 * - **a claim that was honoured.** The decision vocabulary has exactly one member, so
 *   there is no value to read even if a line carries one.
 * - **a budget above the code-owned ceiling.** A worker whose `maxCognitionTokens` was
 *   edited upward would otherwise be governed by a limit that exists only on disk.
 *
 * ## Spend is folded, never accepted
 *
 * There is no event that adds spend on its own. `cognitionRequests` and
 * `cognitionTokens` move only in response to a recorded cognition outcome, and
 * `assignments`/`messages` move only in response to a recorded assignment or message.
 * So the counters cannot be inflated by anything except performing the work.
 */
export interface WorkforceStateShape {
  readonly workers: ReadonlyMap<string, WorkerRecord>
  readonly teams: ReadonlyMap<string, TeamRecord>
  readonly assignments: ReadonlyMap<string, AssignmentRecord>
  readonly claims: ReadonlyMap<string, ClaimRecord>
  readonly messages: readonly WorkforceMessageRecord[]
  readonly sequence: number
}

export function initialWorkforceState(): WorkforceState {
  return { workers: new Map(), teams: new Map(), assignments: new Map(), claims: new Map(), messages: [], sequence: 0 }
}

const WORKFORCE_EVENT_TYPES: ReadonlySet<CoreEventType> = new Set<CoreEventType>([
  'workforce.worker.created',
  'workforce.worker.transitioned',
  'workforce.worker.reconciled',
  'workforce.capability.assigned',
  'workforce.context.assigned',
  'workforce.team.created',
  'workforce.team.transitioned',
  'workforce.team.member.changed',
  'workforce.assignment.created',
  'workforce.assignment.settled',
  'workforce.cognition.recorded',
  'workforce.claim.recorded',
  'workforce.message.sent',
  'workforce.limit.exceeded',
])

export function isWorkforceEvent(type: CoreEventType): boolean {
  return WORKFORCE_EVENT_TYPES.has(type)
}

/**
 * How many message records the projection keeps.
 *
 * The journal keeps every one; this bounds the in-memory mirror only. It is exported
 * rather than hard-coded in `projection.ts` so the fold can trim the same list the
 * projection reads, and so the two cannot disagree about what "retained" means.
 */
export const RETAINED_MESSAGES = WORKFORCE_LIMITS.maxMailboxMessages * 8

export function reduceWorkforceState(state: WorkforceState, event: AnyCoreEvent): WorkforceState {
  if (!WORKFORCE_EVENT_TYPES.has(event.type)) return state

  const payload = event.payload as unknown as Record<string, unknown>

  switch (event.type) {
    case 'workforce.worker.created': {
      const workerId = readId(payload.workerId)
      if (workerId === null) return state
      const specialisation = readSpecialisation(payload.specialisation)
      if (specialisation === null) return state
      const budget = readBudget(payload.budget)
      if (budget === null) return state
      const name = readName(payload.name)
      if (name === null) return state

      const workers = new Map(state.workers)
      // A repeated creation for a live id is ignored rather than resetting it, so a
      // redelivered event cannot hand a retired worker a fresh budget.
      if (workers.has(workerId)) return { ...state, sequence: event.sequence }

      workers.set(workerId, {
        workerId,
        name,
        specialisation,
        status: 'idle',
        createdAt: readInstant(payload.createdAt) ?? event.occurredAt,
        activatedAt: null,
        settledAt: null,
        reason: null,
        budget,
        spend: { assignments: 0, openAssignments: 0, cognitionCalls: 0, cognitionTokens: 0, messages: 0 },
        capabilities: [],
        contextRefs: [],
        teams: [],
        assignments: [],
        limitsHit: [],
      })
      return { ...state, workers, sequence: event.sequence }
    }

    case 'workforce.worker.transitioned': {
      const workerId = readId(payload.workerId)
      if (workerId === null) return state
      const current = state.workers.get(workerId)
      if (current === undefined) return state

      const from = readWorkerStatus(payload.from)
      const to = readWorkerStatus(payload.to)
      if (from === null || to === null) return state
      // Two refusals, for the same reason Mission's fold has two: the history must
      // agree with itself, and the edge must be legal. Together they mean a journal
      // cannot manufacture a status the live engine would never reach.
      if (from !== current.status) return state
      if (!canTransitionWorker(from, to)) return state

      const reason = readReason(payload.reason)
      const workers = new Map(state.workers)
      const spend = countOpenAssignments(state, workerId)
      workers.set(workerId, {
        ...current,
        status: to,
        reason,
        // `working` is a *derived* status: a worker is working exactly while it holds
        // open assignments. Folding it from the assignment stream rather than trusting
        // the transition's `to` is what stops a hand-written `working` line from
        // putting an idle worker on a board as busy.
        spend: { ...current.spend, openAssignments: spend },
        ...(to === 'working' ? { activatedAt: current.activatedAt ?? event.occurredAt } : {}),
        ...(isTerminalWorkerStatus(to) ? { settledAt: event.occurredAt } : {}),
      })
      return { ...state, workers, sequence: event.sequence }
    }

    case 'workforce.worker.reconciled': {
      const workerId = readId(payload.workerId)
      if (workerId === null) return state
      const current = state.workers.get(workerId)
      if (current === undefined) return state
      const previousStatus = readWorkerStatus(payload.previousStatus)
      if (previousStatus === null || previousStatus !== current.status) return state
      // `working` is the only status a restart cannot honestly carry forward, because
      // what it was doing was in memory. Anything else the fold already knows.
      if (previousStatus !== 'working') return state

      const reason = readReason(payload.reason) ?? WORKFORCE_REASONS.recovery
      const workers = new Map(state.workers)
      workers.set(workerId, { ...current, status: 'idle', reason, spend: { ...current.spend, openAssignments: 0 } })
      return { ...state, workers, sequence: event.sequence }
    }

    case 'workforce.capability.assigned': {
      const workerId = readId(payload.workerId)
      if (workerId === null) return state
      const current = state.workers.get(workerId)
      if (current === undefined) return state
      const capability = readAssignableCapability(payload.capability)
      // The load-bearing refusal. A forged line cannot widen a worker.
      if (capability === null) return state
      if (current.capabilities.includes(capability)) return { ...state, sequence: event.sequence }

      const workers = new Map(state.workers)
      workers.set(workerId, { ...current, capabilities: [...current.capabilities, capability].sort() })
      return { ...state, workers, sequence: event.sequence }
    }

    case 'workforce.context.assigned': {
      const workerId = readId(payload.workerId)
      if (workerId === null) return state
      const current = state.workers.get(workerId)
      if (current === undefined) return state
      const contextRef = readId(payload.contextRef)
      if (contextRef === null) return state
      if (current.contextRefs.includes(contextRef)) return { ...state, sequence: event.sequence }

      const workers = new Map(state.workers)
      workers.set(workerId, { ...current, contextRefs: [...current.contextRefs, contextRef].sort() })
      return { ...state, workers, sequence: event.sequence }
    }

    case 'workforce.team.created': {
      const teamId = readId(payload.teamId)
      if (teamId === null) return state
      const name = readName(payload.name)
      if (name === null) return state
      const specialisation = payload.specialisation === null ? null : readSpecialisation(payload.specialisation)
      // A team may have no specialisation, but never a malformed one.
      if (specialisation === null && payload.specialisation !== null) return state

      const teams = new Map(state.teams)
      if (teams.has(teamId)) return { ...state, sequence: event.sequence }
      teams.set(teamId, {
        teamId,
        name,
        specialisation,
        status: 'active',
        createdAt: readInstant(payload.createdAt) ?? event.occurredAt,
        settledAt: null,
        members: [],
      })
      return { ...state, teams, sequence: event.sequence }
    }

    case 'workforce.team.transitioned': {
      const teamId = readId(payload.teamId)
      if (teamId === null) return state
      const current = state.teams.get(teamId)
      if (current === undefined) return state
      const from = readTeamStatus(payload.from)
      const to = readTeamStatus(payload.to)
      if (from === null || to === null || from !== current.status) return state
      if (from === 'active' && to !== 'disbanded') return state

      const teams = new Map(state.teams)
      teams.set(teamId, {
        ...current,
        status: to,
        settledAt: event.occurredAt,
        // Membership is cleared by the disband itself rather than by N member events, so
        // one line saying "this team no longer exists" cannot half-apply.
        members: to === 'disbanded' ? [] : current.members,
      })

      if (to !== 'disbanded') return { ...state, teams, sequence: event.sequence }

      // And each member's own roster entry is cleared in the same fold.
      //
      // Both sides have to move together. A roster where a team lists nobody while its
      // workers still claim membership is exactly the "two panels cannot disagree"
      // failure `docs/ARCHITECTURE.md` §3.5 is about — and it would read as a worker
      // belonging to a team that no longer exists, which is worse than either view alone.
      const workers = new Map(state.workers)
      for (const memberId of current.members) {
        const worker = workers.get(memberId)
        if (worker === undefined || !worker.teams.includes(teamId)) continue
        workers.set(memberId, { ...worker, teams: worker.teams.filter((id) => id !== teamId) })
      }
      return { ...state, teams, workers, sequence: event.sequence }
    }

    case 'workforce.team.member.changed': {
      const teamId = readId(payload.teamId)
      const workerId = readId(payload.workerId)
      if (teamId === null || workerId === null) return state
      const team = state.teams.get(teamId)
      if (team === undefined) return state
      // A disbanded team accepts no membership change, whatever the line claims.
      if (team.status !== 'active') return state
      const present = readBoolean(payload.present)
      if (present === null) return state

      const teams = new Map(state.teams)
      const workers = new Map(state.workers)
      const worker = workers.get(workerId)
      if (worker === undefined) return state

      const hasMember = team.members.includes(workerId)
      // Idempotent in both directions, so a redelivery cannot double a membership.
      if (present === hasMember) return { ...state, sequence: event.sequence }

      teams.set(teamId, {
        ...team,
        members: present ? [...team.members, workerId] : team.members.filter((id) => id !== workerId),
      })
      workers.set(workerId, {
        ...worker,
        teams: present ? [...worker.teams, teamId] : worker.teams.filter((id) => id !== teamId),
      })
      return { ...state, teams, workers, sequence: event.sequence }
    }

    case 'workforce.assignment.created': {
      const assignmentId = readId(payload.assignmentId)
      const workerId = readId(payload.workerId)
      if (assignmentId === null || workerId === null) return state
      const worker = state.workers.get(workerId)
      if (worker === undefined) return state
      const budget = readBudget(payload.budget)
      if (budget === null) return state

      const assignments = new Map(state.assignments)
      if (assignments.has(assignmentId)) return { ...state, sequence: event.sequence }

      const capabilities = readAssignableCapabilities(payload.capabilities)
      if (capabilities === null) return state
      const contextRefs = readContextRefs(payload.contextRefs)
      if (contextRefs === null) return state
      const missionId = payload.missionId === null ? null : readId(payload.missionId)
      if (missionId === null && payload.missionId !== null) return state

      assignments.set(assignmentId, {
        assignmentId,
        workerId,
        status: 'open',
        createdAt: readInstant(payload.createdAt) ?? event.occurredAt,
        deadlineAt: readInstant(payload.deadlineAt) ?? event.occurredAt,
        settledAt: null,
        reason: null,
        missionId,
        capabilities,
        contextRefs,
      })

      const workers = new Map(state.workers)
      const spend: WorkerSpend = {
        ...worker.spend,
        assignments: worker.spend.assignments + 1,
        openAssignments: worker.spend.openAssignments + 1,
      }
      workers.set(workerId, {
        ...worker,
        assignments: [...worker.assignments, assignmentId],
        spend,
        // `working` follows the assignment rather than a separate instruction, so a
        // worker cannot claim to be busy without holding something open.
        ...(worker.status === 'idle' ? { status: 'working' as const, activatedAt: worker.activatedAt ?? event.occurredAt } : {}),
      })

      return { ...state, assignments, workers, sequence: event.sequence }
    }

    case 'workforce.assignment.settled': {
      const assignmentId = readId(payload.assignmentId)
      if (assignmentId === null) return state
      const current = state.assignments.get(assignmentId)
      if (current === undefined) return state
      const to = readAssignmentStatus(payload.to)
      if (to === null || to === 'open') return state
      if (!canTransitionAssignment(current.status, to)) return state
      const from = readAssignmentStatus(payload.from)
      if (from === null || from !== current.status) return state

      const assignments = new Map(state.assignments)
      assignments.set(assignmentId, {
        ...current,
        status: to,
        settledAt: event.occurredAt,
        reason: readReason(payload.reason),
      })

      const worker = state.workers.get(current.workerId)
      const workers = new Map(state.workers)
      if (worker !== undefined) {
        const stillOpen = countOpenAssignments(state, current.workerId) - 1
        workers.set(current.workerId, {
          ...worker,
          spend: { ...worker.spend, openAssignments: Math.max(0, stillOpen) },
          // A worker with nothing open is idle, whatever its status was. Except a
          // stopped or retired worker, whose status is a decision Core made and which
          // this event has no business overwriting.
          ...(worker.status === 'working' && stillOpen === 0 ? { status: 'idle' as const } : {}),
        })
      }
      return { ...state, assignments, workers, sequence: event.sequence }
    }

    case 'workforce.claim.recorded': {
      const claimId = readId(payload.claimId)
      const workerId = readId(payload.workerId)
      if (claimId === null || workerId === null) return state
      if (!state.workers.has(workerId)) return state
      const kind = readClaimKind(payload.kind)
      const refusal = readClaimRefusal(payload.refusal)
      const decision = readClaimDecision(payload.decision)
      // The decision vocabulary has one member. A forged `granted` is unreadable, so
      // it cannot be applied even if a line carries one.
      if (kind === null || refusal === null || decision === null) return state
      const subject = readSubject(payload.subject)
      if (subject === null) return state

      const claim: ClaimRecord = {
        claimId,
        workerId,
        kind,
        subject,
        refusal,
        decidedAt: event.occurredAt,
      }
      const claims = new Map(state.claims)
      if (claims.has(claimId)) return { ...state, sequence: event.sequence }
      claims.set(claimId, claim)
      return { ...state, claims, sequence: event.sequence }
    }

    case 'workforce.message.sent': {
      const messageId = readId(payload.messageId)
      const fromWorkerId = readId(payload.fromWorkerId)
      const toWorkerId = readId(payload.toWorkerId)
      const kind = readMessageKind(payload.kind)
      const bodyLength = readNonNegativeInt(payload.bodyLength)
      if (
        messageId === null ||
        fromWorkerId === null ||
        toWorkerId === null ||
        kind === null ||
        bodyLength === null
      ) {
        return state
      }
      // Both ends must be workers this Core knows. A message to nobody is not
      // attributable, and attributability is the whole property.
      if (!state.workers.has(fromWorkerId) || !state.workers.has(toWorkerId)) return state
      if (fromWorkerId === toWorkerId) return state

      const record: WorkforceMessageRecord = {
        messageId,
        fromWorkerId,
        toWorkerId,
        kind,
        sentAt: event.occurredAt,
        bodyLength,
        sameTeam: readBoolean(payload.sameTeam) === true,
      }

      const workers = new Map(state.workers)
      const sender = workers.get(fromWorkerId)
      // The sender's spend moves because Core recorded a message; the recipient's does
      // not, because receiving is not something a worker chooses.
      if (sender !== undefined) {
        workers.set(fromWorkerId, { ...sender, spend: { ...sender.spend, messages: sender.spend.messages + 1 } })
      }

      const messages = [...state.messages, record]
      return {
        ...state,
        messages: messages.length > RETAINED_MESSAGES ? messages.slice(messages.length - RETAINED_MESSAGES) : messages,
        workers,
        sequence: event.sequence,
      }
    }

    case 'workforce.cognition.recorded': {
      const workerId = readId(payload.workerId)
      if (workerId === null) return state
      const current = state.workers.get(workerId)
      if (current === undefined) return state
      const calls = readNonNegativeInt(payload.calls)
      const tokens = payload.outputTokens === null ? null : readNonNegativeInt(payload.outputTokens)
      // Both readers must agree that the value was *present and well-formed*. A `null`
      // is "the cost was not known", which is different from "the value was missing",
      // and a line missing the field entirely is not a record of anything.
      if (calls === null) return state
      if (payload.outputTokens !== null && tokens === null) return state

      const workers = new Map(state.workers)
      workers.set(workerId, {
        ...current,
        // Additive only. There is no event that subtracts spend, so no replayed line
        // can hand a worker back the budget a crash consumed.
        spend: {
          ...current.spend,
          cognitionCalls: current.spend.cognitionCalls + calls,
          cognitionTokens: current.spend.cognitionTokens + (tokens ?? 0),
        },
      })
      return { ...state, workers, sequence: event.sequence }
    }

    case 'workforce.limit.exceeded': {
      const workerId = readId(payload.workerId)
      if (workerId === null) return state
      const current = state.workers.get(workerId)
      const limit = readLimitName(payload.limit)
      if (current === undefined || limit === null) return state
      // Durable, so a restart cannot hide that a ceiling was reached. Without it a
      // worker could quietly stop accepting work and nobody would know why.
      if (current.limitsHit.includes(limit)) return { ...state, sequence: event.sequence }
      const workers = new Map(state.workers)
      workers.set(workerId, { ...current, limitsHit: [...current.limitsHit, limit] })
      return { ...state, workers, sequence: event.sequence }
    }

    default:
      return state
  }
}

/**
 * Count a worker's open assignments.
 *
 * Counted from the assignment map rather than trusted from `spend`, so `working` can
 * never disagree with the assignments that justify it. Called during a fold where the
 * assignment for the event in hand has not necessarily been applied yet — hence the
 * arithmetic at each call site is written against `state`, not against the new map.
 */
function countOpenAssignments(state: WorkforceState, workerId: string): number {
  let open = 0
  for (const assignment of state.assignments.values()) {
    if (assignment.workerId === workerId && !isTerminalAssignmentStatus(assignment.status)) open += 1
  }
  return open
}

/* ----------------------------------------------------------------- readers */

function readId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null
}

function readName(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= WORKFORCE_LIMITS.maxNameChars
    ? value
    : null
}

function readInstant(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
}

function readNonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readWorkerStatus(value: unknown): WorkerStatus | null {
  return typeof value === 'string' && (WORKER_STATUSES as readonly string[]).includes(value)
    ? (value as WorkerStatus)
    : null
}

function readTeamStatus(value: unknown): TeamStatus | null {
  return typeof value === 'string' && (['active', 'disbanded'] as readonly string[]).includes(value)
    ? (value as TeamStatus)
    : null
}

function readAssignmentStatus(value: unknown): AssignmentStatus | null {
  return typeof value === 'string' && (['open', 'completed', 'failed', 'cancelled'] as readonly string[]).includes(value)
    ? (value as AssignmentStatus)
    : null
}

function readSpecialisation(value: unknown): WorkerSpecialisation | null {
  return isWorkerSpecialisation(value) ? value : null
}

function readReason(value: unknown): WorkforceReason | null {
  return typeof value === 'string' && Object.hasOwn(WORKFORCE_REASONS, value) ? (value as WorkforceReason) : null
}

function readClaimKind(value: unknown): WorkforceClaimKind | null {
  return typeof value === 'string' && (WORKFORCE_CLAIM_KINDS as readonly string[]).includes(value)
    ? (value as WorkforceClaimKind)
    : null
}

function readClaimDecision(value: unknown): WorkforceClaimDecision | null {
  return typeof value === 'string' && (WORKFORCE_CLAIM_DECISIONS as readonly string[]).includes(value)
    ? (value as WorkforceClaimDecision)
    : null
}

function readClaimRefusal(value: unknown): WorkforceClaimRefusal | null {
  return typeof value === 'string' && Object.hasOwn(WORKFORCE_CLAIM_REFUSALS, value)
    ? (value as WorkforceClaimRefusal)
    : null
}

function readMessageKind(value: unknown): WorkforceMessageKind | null {
  return typeof value === 'string' && (WORKFORCE_MESSAGE_KINDS as readonly string[]).includes(value)
    ? (value as WorkforceMessageKind)
    : null
}

/**
 * Read a limit name.
 *
 * Both families are accepted — the global `WORKFORCE_LIMITS` keys and the per-worker
 * budget keys — because a single `workforce.limit.exceeded` event is how both are
 * reported, and a ceiling that could only be recorded for one of them would make the
 * other unreportable.
 */
function readLimitName(value: unknown): WorkforceLimitName | null {
  const global: readonly string[] = Object.keys(WORKFORCE_LIMITS)
  const budgets: readonly string[] = [
    'maxAssignments',
    'maxOpenAssignments',
    'maxAssignmentMs',
    'maxCognitionCalls',
    'maxCognitionTokens',
    'maxMessages',
  ]
  if (typeof value !== 'string') return null
  if (!global.includes(value) && !budgets.includes(value)) return null
  return value as WorkforceLimitName
}

/** A claim's subject: a capability name or a context id, both bounded tokens. */
function readSubject(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null
}

/**
 * Read one capability, refusing anything outside the closed worker vocabulary.
 *
 * This is the fold's half of C8. `isAssignableToWorker` is the engine's gate; this is
 * the one that decides whether a *durable line* may be believed, which is the stricter
 * of the two questions — the engine could be refactored, and this cannot be moved
 * without moving the vocabulary.
 */
function readAssignableCapability(value: unknown): Capability | null {
  if (!isCapability(value)) return null
  const capability = value
  // The same gate the engine uses. Consulting one function rather than two copies of
  // the rule is what makes "the engine refuses it" and "the fold refuses to believe it"
  // the same statement.
  return isAssignableToWorker(capability) ? capability : null
}

function readAssignableCapabilities(value: unknown): readonly Capability[] | null {
  if (!Array.isArray(value)) return null
  const out: Capability[] = []
  for (const item of value) {
    const capability = readAssignableCapability(item)
    if (capability === null) return null
    if (!out.includes(capability)) out.push(capability)
  }
  return out.sort()
}

function readContextRefs(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > WORKFORCE_LIMITS.maxContextRefsPerWorker) return null
  const out: string[] = []
  for (const item of value) {
    const ref = readId(item)
    if (ref === null) return null
    if (!out.includes(ref)) out.push(ref)
  }
  return out.sort()
}

/**
 * Read a worker's durable budget, re-validated against the code-owned ceilings.
 *
 * A journal is only as trustworthy as its least validated byte. A hand-edited
 * `maxCognitionTokens: 1000000` would otherwise become a real ceiling the engine
 * enforces — a limit that exists only on disk.
 */
function readBudget(value: unknown): WorkerBudget | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  try {
    return workerBudget(value as Partial<WorkerBudget>)
  } catch {
    return null
  }
}

/** Re-exported so the engine and the fold cannot drift on the ceiling. */
export { DEFAULT_WORKER_BUDGET, WORKER_TERMINAL_STATUSES }