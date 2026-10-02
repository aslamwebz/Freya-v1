import type { CoreStatus } from '../protocol/core-protocol'
import type { WorkProjection } from '../work/projection'
import type { WorkforceProjection } from '../workforce/types'
import { freyaPosition, gridPosition, historyPosition } from './layout'
import {
  OFFICE_LIMITS,
  OFFICE_REASONS,
  officeLimits,
  type OfficeHistoryEntry,
  type OfficePresenceState,
  type OfficeProjection,
  type OfficeProjectionInput,
  type OfficeReason,
  type OfficeStation,
} from './types'

export type { OfficeProjection, OfficeStation, OfficeProjectionInput }

/**
 * THE OFFICE PROJECTION.
 *
 * Everything a window may know about the Office, derived from Core's Work,
 * Workforce and status projections plus the bounded set of presence requests.
 *
 * ## The rule this function is built to enforce
 *
 * Every station corresponds to one real thing Core owns, and every field of a
 * station is the real state of that thing. There is no code path here that
 * invents a station, inflates a count, fabricates a percentage or animates a
 * state. If Core says nothing is running, the office says nothing is running —
 * in words, with Freya's station reading `idle`.
 *
 * ## Determinism
 *
 * The same input produces the same output. Stations are ordered the way Core
 * orders runs and workers (newest first, id breaking ties), positions come
 * from a fixed grid, and the history is sorted by the journal's own sequence.
 * No clock, no randomness, no globals.
 *
 * ## Capping is stated, never silent
 *
 * A zone that holds more stations than its ceiling shows the newest and reports
 * how many are hidden. A viewer that quietly stopped listing would read as
 * "these never existed", which is the false impression a bounded view is most
 * likely to create.
 */

/** What a Core without Work, Workforce or status reports. */
export const ABSENT_OFFICE_PROJECTION: OfficeProjection = Object.freeze({
  health: 'unavailable',
  reason: 'Core has not reported yet',
  freya: null,
  stations: Object.freeze([]),
  history: Object.freeze([]),
  presenceRequests: Object.freeze([]),
  counts: Object.freeze({
    runs: 0,
    runsLive: 0,
    workers: 0,
    workersByIdle: 0,
    workersWorking: 0,
    workersBlocked: 0,
    workersStopped: 0,
    workersRetired: 0,
    approvalsPending: 0,
    floorStationsShown: 0,
    floorStationsHidden: 0,
    workforceStationsShown: 0,
    workforceStationsHidden: 0,
    approvalStationsShown: 0,
    approvalStationsHidden: 0,
    historyShown: 0,
    historyHidden: 0,
  }),
  sequence: 0,
})

/**
 * Build the Office projection.
 *
 * A pure function over Core's projections, so the same call serves the live
 * view and any test that wants to assert against a known state. Every input is
 * supplied rather than reached for, which is what stops a projection from being
 * able to observe anything Core did not explicitly report.
 */
export function projectOffice(
  input: OfficeProjectionInput,
  limits: Readonly<Record<keyof typeof OFFICE_LIMITS, number>> = officeLimits(),
): OfficeProjection {
  const { work, workforce, core, presenceRequests } = input

  const sequence = Math.max(work?.sequence ?? 0, workforce?.sequence ?? 0, core?.eventSequence ?? 0)

  if (work === null && workforce === null && core === null) {
    return { ...ABSENT_OFFICE_PROJECTION, sequence }
  }

  const freya = freyaStation(core, work)
  const floor = floorStations(work, limits)
  const workforceList = workforceStations(workforce, limits)
  const approvals = approvalStations(work, limits)
  const history = historyEntries(work, limits)

  const stations = [...floor, ...workforceList, ...approvals]

  const counts = {
    runs: work?.counts.runs ?? 0,
    runsLive: work ? work.runs.filter((run) => !isTerminal(run.status)).length : 0,
    workers: workforce?.counts.workers ?? 0,
    workersByIdle: workforce?.counts.idle ?? 0,
    workersWorking: workforce?.counts.working ?? 0,
    workersBlocked: workforce?.counts.blocked ?? 0,
    workersStopped: workforce?.counts.stopped ?? 0,
    workersRetired: workforce?.counts.retired ?? 0,
    approvalsPending: work?.counts.pendingApprovals ?? 0,
    floorStationsShown: floor.length,
    floorStationsHidden: Math.max(0, countLiveRuns(work) - floor.length),
    workforceStationsShown: workforceList.length,
    workforceStationsHidden: Math.max(0, (workforce?.counts.workers ?? 0) - workforceList.length),
    approvalStationsShown: approvals.length,
    approvalStationsHidden: Math.max(0, (work?.counts.pendingApprovals ?? 0) - approvals.length),
    historyShown: history.length,
    historyHidden: Math.max(0, countSettledRuns(work) - history.length),
  }

  return Object.freeze({
    health: 'ready',
    reason: null,
    freya,
    stations: Object.freeze(stations),
    history: Object.freeze(history),
    presenceRequests: Object.freeze([...presenceRequests].slice(0, limits.maxPresenceRequests)),
    counts: Object.freeze(counts),
    sequence,
  })
}

/* -------------------------------------------------------------- freya */

/**
 * Freya's station.
 *
 * Her state is derived from Core's own status, never invented:
 *
 * - `error` when the journal is corrupt or Core is degraded — she cannot vouch
 *   for her own history, and the office says so.
 * - `locked` when STOP ALL is latched or the Governor is refusing everything —
 *   she cannot act, and the office says why.
 * - `working` when a model request is in flight or a Run is live — the two facts
 *   Core already holds that mean she is spending on the owner's behalf.
 * - `idle` otherwise. Idle is the honest default: it means nothing is executing,
 *   not that she is broken.
 */
function freyaStation(core: CoreStatus | null, work: WorkProjection | null): OfficeStation | null {
  if (core === null) {
    return {
      stationId: 'freya',
      kind: 'freya',
      zone: 'freya',
      entityId: 'freya',
      label: 'Freya',
      state: 'idle',
      reason: OFFICE_REASONS.unavailable,
      position: freyaPosition(),
      detail: 'Core has not reported yet.',
      status: 'unavailable',
      counts: emptyCounts(),
      live: false,
      activeStepKey: null,
      openAssignments: 0,
      approval: null,
    }
  }

  const liveRuns = work ? work.runs.filter((run) => !isTerminal(run.status)).length : 0

  let state: OfficePresenceState = 'idle'
  let reason: OfficeReason = OFFICE_REASONS.idle
  let detail = 'Nothing is executing.'

  if (core.integrity.integrity === 'corrupt' || core.lifecycle === 'degraded') {
    state = 'error'
    reason = core.integrity.integrity === 'corrupt' ? OFFICE_REASONS.errorJournal : OFFICE_REASONS.errorDegraded
    detail = core.integrity.integrity === 'corrupt' ? 'The event journal is corrupt.' : 'Core is degraded.'
  } else if (core.stopAll.active) {
    state = 'locked'
    reason = OFFICE_REASONS.lockedStopAll
    detail = 'STOP ALL is latched. Every model request is refused.'
  } else if (core.governor.status === 'deny_all') {
    state = 'locked'
    reason = OFFICE_REASONS.lockedGovernor
    detail = 'The Governor is refusing every request.'
  } else if (core.activeProviderCalls > 0) {
    state = 'working'
    reason = OFFICE_REASONS.workingModel
    detail = `${core.activeProviderCalls} model request${core.activeProviderCalls === 1 ? '' : 's'} in flight.`
  } else if (liveRuns > 0) {
    state = 'working'
    reason = OFFICE_REASONS.workingRun
    detail = `${liveRuns} run${liveRuns === 1 ? '' : 's'} executing.`
  }

  return {
    stationId: 'freya',
    kind: 'freya',
    zone: 'freya',
    entityId: 'freya',
    label: 'Freya',
    state,
    reason,
    position: freyaPosition(),
    detail: clamp(detail, OFFICE_LIMITS.maxDetailChars),
    status: core.lifecycle,
    counts: emptyCounts(),
    live: core.activeProviderCalls > 0,
    activeStepKey: null,
    openAssignments: 0,
    approval: null,
  }
}

/* --------------------------------------------------------------- floor */

/**
 * Live run stations, newest first, capped.
 *
 * A run gets a station exactly while it is not terminal. A completed, failed or
 * cancelled run leaves the floor and enters the history — the same honesty the
 * Work board applies, in space.
 */
function floorStations(
  work: WorkProjection | null,
  limits: Readonly<Record<keyof typeof OFFICE_LIMITS, number>>,
): OfficeStation[] {
  if (work === null) return []
  const live = work.runs.filter((run) => !isTerminal(run.status))
  const shown = live.slice(0, limits.maxFloorStations)
  return shown.map((run, index) => runStation(run, index))
}

function runStation(
  run: WorkProjection['runs'][number],
  index: number,
): OfficeStation {
  const activeStep = run.steps.find((step) => step.status === 'running')
  const state: OfficePresenceState = runStationState(run.status)
  return {
    stationId: `run:${run.runId}`,
    kind: 'run',
    zone: 'floor',
    entityId: run.runId,
    label: clamp(run.kind, OFFICE_LIMITS.maxLabelChars),
    state,
    reason: runStationReason(run.status),
    position: gridPosition('floor', index),
    detail: clamp(run.progress.summary, OFFICE_LIMITS.maxDetailChars),
    status: run.status,
    counts: {
      stepsTotal: run.progress.stepsTotal,
      stepsSettled: run.progress.stepsTotal - run.progress.remaining,
      stepsVerified: run.progress.verified,
      stepsFailed: run.progress.failed,
      actions: run.actions.length,
      attempts: run.progress.attempts,
    },
    live: run.live,
    activeStepKey: activeStep?.key ?? null,
    openAssignments: 0,
    approval: null,
  }
}

function runStationState(status: string): OfficePresenceState {
  switch (status) {
    case 'running':
      return 'working'
    case 'waiting':
      return 'waiting'
    case 'awaiting_approval':
      return 'waiting'
    case 'queued':
      return 'waiting'
    case 'paused':
      return 'blocked'
    default:
      return 'idle'
  }
}

function runStationReason(status: string): OfficeReason {
  switch (status) {
    case 'running':
      return OFFICE_REASONS.workingRun
    case 'waiting':
      return OFFICE_REASONS.waitingExternal
    case 'awaiting_approval':
      return OFFICE_REASONS.waitingApproval
    case 'queued':
      return OFFICE_REASONS.waitingQueued
    case 'paused':
      return OFFICE_REASONS.blocked
    default:
      return OFFICE_REASONS.idle
  }
}

/* ----------------------------------------------------------- workforce */

/**
 * Worker stations, newest first, capped.
 *
 * A worker gets a station exactly when Core's Workforce says they exist. Their
 * state is the workforce's own status — `working` only while they hold an open
 * assignment, which the fold already enforces. There is no code path here that
 * can put a worker on the floor without Core having created them.
 */
function workforceStations(
  workforce: WorkforceProjection | null,
  limits: Readonly<Record<keyof typeof OFFICE_LIMITS, number>>,
): OfficeStation[] {
  if (workforce === null) return []
  const shown = workforce.workers.slice(0, limits.maxWorkforceStations)
  return shown.map((worker, index) => workerStation(worker, index))
}

function workerStation(
  worker: WorkforceProjection['workers'][number],
  index: number,
): OfficeStation {
  const state: OfficePresenceState = workerStationState(worker.status)
  const openAssignments = worker.assignments.filter((assignment) => assignment.status === 'open').length
  return {
    stationId: `worker:${worker.workerId}`,
    kind: 'worker',
    zone: 'workforce',
    entityId: worker.workerId,
    label: workerLabel(worker.specialisation),
    state,
    reason: workerStationReason(worker.status),
    position: gridPosition('workforce', index),
    detail: clamp(workerDetail(worker, openAssignments), OFFICE_LIMITS.maxDetailChars),
    status: worker.status,
    counts: {
      stepsTotal: 0,
      stepsSettled: 0,
      stepsVerified: 0,
      stepsFailed: 0,
      actions: 0,
      attempts: 0,
    },
    live: worker.status === 'working',
    activeStepKey: null,
    openAssignments,
    approval: null,
  }
}

function workerLabel(specialisation: string): string {
  switch (specialisation) {
    case 'research': return 'Research worker'
    case 'analysis': return 'Analysis worker'
    case 'code': return 'Code worker'
    case 'writing': return 'Writing worker'
    default: return 'General worker'
  }
}

function workerStationState(status: string): OfficePresenceState {
  switch (status) {
    case 'working':
      return 'working'
    case 'blocked':
      return 'blocked'
    case 'stopped':
      return 'locked'
    case 'retired':
      return 'idle'
    default:
      return 'idle'
  }
}

function workerStationReason(status: string): OfficeReason {
  switch (status) {
    case 'working':
      return OFFICE_REASONS.workingAssignment
    case 'blocked':
      return OFFICE_REASONS.blocked
    case 'stopped':
      return OFFICE_REASONS.stopped
    case 'retired':
      return OFFICE_REASONS.retired
    default:
      return OFFICE_REASONS.idle
  }
}

function workerDetail(
  worker: WorkforceProjection['workers'][number],
  openAssignments: number,
): string {
  const parts: string[] = []
  if (openAssignments > 0) parts.push(`${openAssignments} open assignment${openAssignments === 1 ? '' : 's'}`)
  if (worker.teams.length > 0) parts.push(`${worker.teams.length} team${worker.teams.length === 1 ? '' : 's'}`)
  if (worker.capabilities.length > 0) parts.push(`${worker.capabilities.length} capabilit${worker.capabilities.length === 1 ? 'y' : 'ies'}`)
  if (parts.length === 0) return 'No open work.'
  return parts.join(' · ') + '.'
}

/* ----------------------------------------------------------- approvals */

/**
 * Pending approval stations, newest first, capped.
 *
 * An approval gets a station exactly while it is pending. A decided approval
 * leaves the approvals area — it is no longer a thing the owner can act on.
 */
function approvalStations(
  work: WorkProjection | null,
  limits: Readonly<Record<keyof typeof OFFICE_LIMITS, number>>,
): OfficeStation[] {
  if (work === null) return []
  const pending = work.approvals.filter((approval) => approval.status === 'pending')
  const shown = pending.slice(0, limits.maxApprovalStations)
  return shown.map((approval, index) => approvalStation(approval, index))
}

function approvalStation(
  approval: WorkProjection['approvals'][number],
  index: number,
): OfficeStation {
  return {
    stationId: `approval:${approval.approvalId}`,
    kind: 'approval',
    zone: 'approvals',
    entityId: approval.approvalId,
    label: clamp(approval.capability, OFFICE_LIMITS.maxLabelChars),
    state: 'waiting',
    reason: OFFICE_REASONS.waitingApproval,
    position: gridPosition('approvals', index),
    detail: OFFICE_REASONS.waitingApproval,
    status: approval.status,
    counts: emptyCounts(),
    live: true,
    activeStepKey: null,
    openAssignments: 0,
    approval: {
      capability: approval.capability,
      risk: approval.risk,
      requiredCapability: approval.requiredCapability,
    },
  }
}

/* ------------------------------------------------------------- history */

/**
 * Settled run history, newest first, capped.
 *
 * Journaled metadata only: what ran, when, how it ended, whether it verified.
 * The label is the run's kind and status — Core's own words. There is no
 * substance: no step input, no observation content, no task title.
 */
function historyEntries(
  work: WorkProjection | null,
  limits: Readonly<Record<keyof typeof OFFICE_LIMITS, number>>,
): OfficeHistoryEntry[] {
  if (work === null) return []
  const settled = work.runs.filter((run) => isTerminal(run.status))
  const shown = settled.slice(0, limits.maxHistoryEntries)
  return shown.map((run) => ({
    entryId: `history:${run.runId}`,
    runId: run.runId,
    kind: run.kind,
    status: run.status,
    createdAt: run.createdAt,
    settledAt: run.completedAt ?? run.cancelledAt,
    stepsTotal: run.progress.stepsTotal,
    stepsVerified: run.progress.verified,
    stepsFailed: run.progress.failed,
    sequence: 0,
  }))
}

/* ---------------------------------------------------------------- helpers */

function isTerminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function countLiveRuns(work: WorkProjection | null): number {
  if (work === null) return 0
  return work.runs.filter((run) => !isTerminal(run.status)).length
}

function countSettledRuns(work: WorkProjection | null): number {
  if (work === null) return 0
  return work.runs.filter((run) => isTerminal(run.status)).length
}

function emptyCounts(): OfficeStation['counts'] {
  return { stepsTotal: 0, stepsSettled: 0, stepsVerified: 0, stepsFailed: 0, actions: 0, attempts: 0 }
}

function clamp(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

export { historyPosition }
