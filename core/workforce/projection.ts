import { initialWorkforceState, reduceWorkforceState, RETAINED_MESSAGES } from './state'
import {
  isTerminalAssignmentStatus,
  isTerminalWorkerStatus,
  WORKFORCE_LIMITS,
  type AssignmentRecord,
  type AssignmentView,
  type ClaimRecord,
  type DeliveredMessage,
  type TeamView,
  type WorkerRecord,
  type WorkerView,
  type WorkforceAction,
  type WorkforceProjection,
  type WorkforceState,
  type WorkforceWorkerDetail,
} from './types'

/**
 * THE WORKFORCE PROJECTION.
 *
 * Everything a window may know about the workforce, derived from the durable journal
 * fold plus the **live** facts only this process knows.
 *
 * ## Two things are deliberately not here
 *
 * - **No message body.** The standing projection carries counts and a message's
 *   metadata; bodies come from `detail(workerId)`, for one worker, on request. A
 *   standing feed of every agent message would accumulate a copy of the whole
 *   workforce's conversation on any window that happens to be open, which is exactly
 *   what Phase 3 refused for a transcript.
 * - **No spend as a percentage.** Counts and remaining ceilings, like Work's structural
 *   progress and Mission's child counts. A number next to a budget that will be
 *   exceeded later is a number somebody remembers.
 *
 * ## `working` is derived twice over
 *
 * A worker reads as `working` only when it holds at least one open assignment, which
 * the fold already enforces; `reconcile` below additionally cross-checks the worker's
 * own `openAssignments` count against the assignment map and reports `needsAttention`
 * if they disagree. A projection that silently preferred one of two disagreeing truths
 * would be the kind of quiet divergence Phase 7 spent a whole defect on.
 *
 * ## Live facts are supplied, not reached for
 *
 * Mailboxes and their bodies are passed in. A projection function that could reach
 * into the engine could not be tested against a fold alone, and the volatile half of
 * this subsystem is exactly the half a test most needs to control.
 */

/** What a Core without Workforce reports. Distinct from "there are no agents". */
export const ABSENT_WORKFORCE_PROJECTION: WorkforceProjection = Object.freeze({
  health: 'unavailable' as const,
  reason: 'Core has not reported yet',
  detailAvailable: false,
  workers: Object.freeze([]),
  teams: Object.freeze([]),
  counts: Object.freeze({
    workers: 0,
    idle: 0,
    working: 0,
    blocked: 0,
    stopped: 0,
    retired: 0,
    teams: 0,
    openAssignments: 0,
    messagesSent: 0,
    refusedClaims: 0,
  }),
  limits: WORKFORCE_LIMITS,
  assignmentsRetained: 0,
  assignmentsTotal: 0,
  assignmentsHidden: 0,
  messagesRetained: 0,
  messagesTotal: 0,
  messagesHidden: 0,
  sequence: 0,
})

/** The volatile half: bodies and mailboxes, per worker. Never durable. */
export interface WorkforceMailboxDetail {
  /** workerId → its bounded deliveries, oldest first. */
  readonly mailboxes: ReadonlyMap<string, readonly DeliveredMessage[]>
}

export const EMPTY_MAILBOXES: WorkforceMailboxDetail = Object.freeze({ mailboxes: new Map() })

/**
 * Build the renderer-safe projection.
 *
 * A pure function over durable state plus one volatile input, so the same call serves
 * the live board and any projection a test wants to assert. `now` is passed in rather
 * than read, for the reason `docs/ARCHITECTURE.md` §3.5 states: no globals, no clock,
 * the same input gives the same output on every machine.
 */
export function workforceProjection(
  state: WorkforceState,
  detail: WorkforceMailboxDetail = EMPTY_MAILBOXES,
  now: Date = new Date(),
  health: WorkforceProjection['health'] = 'ready',
  reason: string | null = null,
): WorkforceProjection {
  const nowMs = Date.parse(now.toISOString())

  const claimsByWorker = countClaimsByWorker(state.claims)

  // Newest first, id breaking ties in the same direction, so the order is total and
  // reproducible — the same determinism device Work's run listing uses.
  const orderedWorkerIds = [...state.workers.keys()].sort((a, b) => {
    const left = state.workers.get(a)
    const right = state.workers.get(b)
    if (!left || !right) return 0
    const delta = Date.parse(right.createdAt) - Date.parse(left.createdAt)
    return delta !== 0 ? delta : b.localeCompare(a)
  })

  const counts = {
    workers: 0,
    idle: 0,
    working: 0,
    blocked: 0,
    stopped: 0,
    retired: 0,
    teams: state.teams.size,
    openAssignments: 0,
    messagesSent: state.messages.length,
    refusedClaims: state.claims.size,
  }

  const workerViews: WorkerView[] = []
  for (const workerId of orderedWorkerIds) {
    const worker = state.workers.get(workerId)
    if (!worker) continue
    counts.workers += 1
    switch (worker.status) {
      case 'idle':
        counts.idle += 1
        break
      case 'working':
        counts.working += 1
        break
      case 'blocked':
        counts.blocked += 1
        break
      case 'stopped':
        counts.stopped += 1
        break
      case 'retired':
        counts.retired += 1
        break
    }
    workerViews.push(workerView(state, worker, claimsByWorker.get(workerId) ?? 0, nowMs))
  }

  const teams: TeamView[] = [...state.teams.values()]
    .sort((a, b) => {
      const delta = Date.parse(b.createdAt) - Date.parse(a.createdAt)
      return delta !== 0 ? delta : b.teamId.localeCompare(a.teamId)
    })
    .map((team) => ({
      teamId: team.teamId,
      name: team.name,
      specialisation: team.specialisation,
      status: team.status,
      createdAt: team.createdAt,
      settledAt: team.settledAt,
      members: [...team.members],
    }))

  for (const assignment of state.assignments.values()) {
    if (!isTerminalAssignmentStatus(assignment.status)) counts.openAssignments += 1
  }

  // Retention triples rather than a silent slice, for the reason Work and Missions
  // both report one: a viewer that quietly stopped listing would read as "these never
  // existed", and that is false. The journal still holds all of them.
  const orderedAssignments = [...state.assignments.values()]
    .sort((a, b) => {
      const delta = Date.parse(b.createdAt) - Date.parse(a.createdAt)
      return delta !== 0 ? delta : b.assignmentId.localeCompare(a.assignmentId)
    })
    .slice(0, WORKFORCE_LIMITS.maxRetainedClaims)

  return {
    health,
    reason,
    // True only while this process actually holds bodies. Derived from the mailboxes
    // rather than declared, so a Core with zero messages and one with lost mailboxes
    // are distinguishable from the outside.
    detailAvailable: [...detail.mailboxes.values()].some((box) => box.length > 0),
    workers: workerViews,
    teams,
    counts,
    limits: WORKFORCE_LIMITS,
    assignmentsRetained: orderedAssignments.length,
    assignmentsTotal: state.assignments.size,
    assignmentsHidden: Math.max(0, state.assignments.size - orderedAssignments.length),
    messagesRetained: Math.min(state.messages.length, RETAINED_MESSAGES),
    messagesTotal: state.messages.length,
    messagesHidden: Math.max(0, state.messages.length - RETAINED_MESSAGES),
    sequence: state.sequence,
  }
}

function workerView(
  state: WorkforceState,
  worker: WorkerRecord,
  refusedClaims: number,
  nowMs: number,
): WorkerView {
  const assignments = worker.assignments
    .map((assignmentId) => state.assignments.get(assignmentId))
    .filter((assignment): assignment is AssignmentRecord => assignment !== undefined)
    .map((assignment) => assignmentView(assignment, nowMs))

  return {
    workerId: worker.workerId,
    name: worker.name,
    specialisation: worker.specialisation,
    status: worker.status,
    createdAt: worker.createdAt,
    settledAt: worker.settledAt,
    reason: worker.reason,
    teams: [...worker.teams],
    capabilities: [...worker.capabilities],
    contextRefs: [...worker.contextRefs],
    budget: worker.budget,
    spend: worker.spend,
    remaining: remainingOf(worker),
    availableActions: actionsFor(worker),
    limitsHit: [...worker.limitsHit],
    assignments,
    refusedClaims,
  }
}

function assignmentView(assignment: AssignmentRecord, nowMs: number): AssignmentView {
  return {
    assignmentId: assignment.assignmentId,
    workerId: assignment.workerId,
    status: assignment.status,
    createdAt: assignment.createdAt,
    deadlineAt: assignment.deadlineAt,
    settledAt: assignment.settledAt,
    reason: assignment.reason,
    missionId: assignment.missionId,
    capabilities: [...assignment.capabilities],
    contextRefs: [...assignment.contextRefs],
    // A bound that is a *fact about the assignment*, not a check performed by a timer.
    // It is computed here so a board can show "past its deadline" without the engine
    // having to be awake to notice — the same discovery-not-watching rule Missions use.
    expired: !isTerminalAssignmentStatus(assignment.status) && nowMs >= Date.parse(assignment.deadlineAt),
  }
}

/**
 * What is left of a worker's budget.
 *
 * Never negative and never estimated. A worker that has spent past a ceiling reports
 * zero rather than a negative number, because "−3 calls left" is a phrase that means
 * the ceiling is advisory.
 */
export function remainingOf(worker: WorkerRecord): WorkerView['remaining'] {
  return {
    assignments: Math.max(0, worker.budget.maxAssignments - worker.spend.assignments),
    openAssignments: Math.max(0, worker.budget.maxOpenAssignments - worker.spend.openAssignments),
    cognitionCalls: Math.max(0, worker.budget.maxCognitionCalls - worker.spend.cognitionCalls),
    cognitionTokens: Math.max(0, worker.budget.maxCognitionTokens - worker.spend.cognitionTokens),
    messages: Math.max(0, worker.budget.maxMessages - worker.spend.messages),
  }
}

/**
 * What can honestly be done to this worker now.
 *
 * Derived from the status and the budget, so the UI offers exactly what Core would
 * accept. A control Core would refuse teaches its user that buttons lie.
 *
 * Note the absences. A `stopped` or `retired` worker offers only `resume` or nothing,
 * and **no worker ever offers `assignCapability` or `assignContext` to itself** —
 * those exist on the owner scope, not here, so a worker has no control that widens it.
 */
export function actionsFor(worker: WorkerRecord): readonly WorkforceAction[] {
  if (isTerminalWorkerStatus(worker.status)) return ['readMessages']
  switch (worker.status) {
    case 'idle':
      return ['assign', 'suspend', 'stop', 'retire', 'createTeam', 'joinTeam', 'readMessages']
    case 'working':
      return ['suspend', 'stop', 'retire', 'readMessages']
    case 'blocked':
      return ['resume', 'stop', 'retire', 'readMessages']
    case 'stopped':
      return ['resume', 'retire', 'readMessages']
    default:
      return []
  }
}

function countClaimsByWorker(claims: ReadonlyMap<string, ClaimRecord>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const claim of claims.values()) {
    counts.set(claim.workerId, (counts.get(claim.workerId) ?? 0) + 1)
  }
  return counts
}

/**
 * One worker with its mailbox.
 *
 * The only path to a message body, and it is per worker on purpose. `bodiesAvailable`
 * is stated separately from an empty list so a restart reads as "the words are gone"
 * rather than as "nobody said anything".
 */
export function workerDetail(
  state: WorkforceState,
  mailbox: WorkforceMailboxDetail,
  workerId: string,
  now: Date = new Date(),
): WorkforceWorkerDetail | null {
  const worker = state.workers.get(workerId)
  if (worker === undefined) return null
  const claimsByWorker = countClaimsByWorker(state.claims)
  const view = workerView(state, worker, claimsByWorker.get(workerId) ?? 0, Date.parse(now.toISOString()))
  const deliveries = mailbox.mailboxes.get(workerId) ?? []
  return {
    ...view,
    deliveries: deliveries.map((delivery) => ({
      ...delivery,
      // A retained message whose body this process does not hold reports the absence
      // rather than rendering an empty string as though the message were blank.
      body: delivery.body ?? null,
    })),
    bodiesAvailable: deliveries.some((delivery) => delivery.body !== null),
  }
}

/**
 * What a Core without a Workforce engine reports, and the state it reports it for.
 *
 * `initialWorkforceState()` is re-exported because a caller holding only this module
 * still needs one definition of "no workforce" for a test fixture, and two
 * hand-written empty states are how a projection ends up disagreeing with a fold.
 */
export { initialWorkforceState, reduceWorkforceState }