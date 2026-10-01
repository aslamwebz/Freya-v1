import type { RunRecord, RunStatus, StepRecord, StepStatus } from '../work/types'
import {
  DEFAULT_MISSION_LIMITS,
  isTerminalMissionStatus,
  type MissionAction,
  type MissionChildRunCounts,
  type MissionProjection,
  type MissionRecord,
  type MissionState,
  type MissionSummaryView,
} from './types'

/**
 * THE MISSION PROJECTION.
 *
 * Everything a window may know about a Mission, derived from the durable journal
 * fold and the **current** Work state.
 *
 * ## There is no percentage, and that is the design
 *
 * A Mission has no denominator. A Run decomposes into Steps, and those decompose
 * into Actions that may retry, and a Mission may attach further Runs later — so
 * "3 of 7" is a fact about *this week's plan* and not about an outcome. A number
 * next to the word "complete" would therefore be an invention, and an invented
 * number is worse than no number: it reads as measured.
 *
 * What this exposes instead is counts a person can act on:
 *
 * ```
 *   3 child Runs · 2 verified · 1 failed
 * ```
 *
 * ## Current Work truth, not journalled Work history
 *
 * A child's status is read from the Work projection rather than from a Mission
 * event. A Mission event cannot say "this Run is running" — the journal records
 * that a Run was *attached*, and live execution is a process fact. Reading the
 * current truth is what stops a Mission from displaying a stale child list after a
 * restart, which is the same reasoning that keeps `activeProviderCalls` out of the
 * journal.
 */

/** What the engine needs to know about Work to derive a Mission's truth. */
export interface WorkTruthPort {
  run(runId: string): RunRecord | undefined
  /** Step records for one Run, in planned order. */
  stepsOf(runId: string): readonly StepRecord[]
  /** The default set of Run statuses counted as "live" for the concurrency ceiling. */
  isSettled(status: RunStatus): boolean
}

export function missionProjection(
  state: MissionState,
  work: WorkTruthPort,
  persistence: { mode: 'encrypted' | 'ephemeral' | 'unavailable'; reason: string | null },
  now: Date,
): MissionProjection {
  const missions = [...state.missions.values()]
    .sort(byRecencyThenId)
    .slice(0, DEFAULT_MISSION_LIMITS.maxRetainedMissions)
    .map((mission) => summarise(mission, work, now))

  const counts = { total: 0, draft: 0, active: 0, paused: 0, completed: 0, failed: 0, cancelled: 0, needsAttention: 0 }
  for (const mission of missions) {
    counts.total += 1
    counts[mission.status] += 1
    if (mission.needsAttention) counts.needsAttention += 1
  }

  return {
    persistence: {
      mode: persistence.mode,
      reason: persistence.reason,
      // Never claimed unless the content store is actually encrypted. A Mission
      // somebody was told is durable and which is not is worse than no Mission.
      durable: persistence.mode === 'encrypted',
    },
    missions,
    counts,
    limits: DEFAULT_MISSION_LIMITS,
    sequence: state.sequence,
  }
}

export function summarise(mission: MissionRecord, work: WorkTruthPort, now: Date): MissionSummaryView {
  const counts = countChildren(mission, work)
  const expired = !isTerminalMissionStatus(mission.status) && Date.parse(now.toISOString()) >= Date.parse(mission.deadlineAt)
  const needsAttention = expired || counts.failed > 0 || counts.cancelled > 0

  return {
    missionId: mission.missionId,
    status: mission.status,
    createdAt: mission.createdAt,
    deadlineAt: mission.deadlineAt,
    settledAt: mission.settledAt,
    reason: mission.reason,
    counts,
    needsAttention,
    // Derived from the status, so the UI cannot offer a control Core would refuse
    // by design. A window that shows "Pause" on a completed Mission teaches the
    // user that buttons lie.
    availableActions: actionsFor(mission),
    verification:
      mission.verification === null
        ? null
        : { state: mission.verification.state, verifierId: mission.verification.verifierId },
  }
}

/**
 * Factual counts of child Runs.
 *
 * `verified` counts Runs whose every Step reached `verified` — not Runs that merely
 * completed. The distinction is the whole point of the Phase 6 layering, and
 * collapsing it here would make a Mission look further along than it is.
 */
export function countChildren(mission: MissionRecord, work: WorkTruthPort): MissionChildRunCounts {
  let queued = 0
  let running = 0
  let waiting = 0
  let awaitingApproval = 0
  let paused = 0
  let completed = 0
  let failed = 0
  let cancelled = 0
  let verified = 0

  for (const runId of mission.childRuns) {
    const run = work.run(runId)
    if (run === undefined) {
      // Attached but unknown to Work. Counted as cancelled rather than dropped, so
      // the totals still add up and a reader is not quietly shown fewer Runs than
      // exist.
      cancelled += 1
      continue
    }
    switch (run.status) {
      case 'queued':
        queued += 1
        break
      case 'running':
        running += 1
        break
      case 'waiting':
        waiting += 1
        break
      case 'awaiting_approval':
        awaitingApproval += 1
        break
      case 'paused':
        paused += 1
        break
      case 'completed':
        completed += 1
        break
      case 'failed':
        failed += 1
        break
      case 'cancelled':
        cancelled += 1
        break
    }
    if (run.status === 'completed' && stepsVerified(work.stepsOf(runId))) verified += 1
  }

  return {
    total: mission.childRuns.length,
    queued,
    running,
    waiting,
    awaitingApproval,
    paused,
    completed,
    failed,
    cancelled,
    verified,
  }
}

function stepsVerified(steps: readonly StepRecord[]): boolean {
  // An empty Step list proves nothing, so it is not "verified". A Run with no
  // steps could not have been created, but a fold that produced one must not read
  // as a completed Mission.
  if (steps.length === 0) return false
  return steps.every((step) => step.status === 'verified')
}

/**
 * What can honestly be done now.
 *
 * Exactly the transitions `MISSION_TRANSITIONS` permits, minus the ones the owner
 * would not want offered. `fail` is included for active and paused Missions because
 * concluding a Mission as unable to continue is a real decision a person makes — it
 * is just not something a failed child Run decides for them.
 */
export function actionsFor(mission: MissionRecord): readonly MissionAction[] {
  if (isTerminalMissionStatus(mission.status)) return []
  switch (mission.status) {
    case 'draft':
      return ['activate', 'cancel']
    case 'active':
      return ['pause', 'requestCompletion', 'cancel', 'fail']
    case 'paused':
      return ['resume', 'cancel', 'fail']
    default:
      return []
  }
}

function byRecencyThenId(a: MissionRecord, b: MissionRecord): number {
  const left = a.settledAt ?? a.createdAt
  const right = b.settledAt ?? b.createdAt
  if (left !== right) return right.localeCompare(left)
  return a.missionId.localeCompare(b.missionId)
}

/** How many children are non-terminal, for the concurrency ceiling. */
export function liveChildCount(mission: MissionRecord, work: WorkTruthPort): number {
  let live = 0
  for (const runId of mission.childRuns) {
    const run = work.run(runId)
    if (run !== undefined && !work.isSettled(run.status)) live += 1
  }
  return live
}

export type { StepStatus }