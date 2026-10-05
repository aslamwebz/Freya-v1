import type { RunRecord, RunStatus, StepRecord, StepStatus } from '../work/types'
import { countPlanSteps, evidenceCounts } from './engine'
import { isTerminalMissionStepStatus } from './autonomy/types'
import type {
  MissionBudgetRemaining,
  MissionEvidenceCounts,
  MissionProgressView,
  MissionStepCounts,
  MissionStepView,
} from './autonomy/types'
import {
  DEFAULT_MISSION_LIMITS,
  isLiveMissionStatus,
  isTerminalMissionStatus,
  MISSION_STATUSES,
  type MissionAction,
  type MissionChildRunCounts,
  type MissionProjection,
  type MissionRecord,
  type MissionState,
  type MissionStatus,
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

/**
 * What a Core without Missions reports.
 *
 * Separate from an empty-but-real projection because the two mean different things
 * to a surface: "there are no Missions" is a fact, and "Missions are not available"
 * is a fault. Collapsing them would let a window render a healthy-looking empty list
 * over a subsystem that never started.
 */
export const ABSENT_MISSION_PROJECTION: MissionProjection = Object.freeze({
  persistence: Object.freeze({ mode: 'unavailable' as const, reason: null, durable: false }),
  missions: Object.freeze([]),
  /**
   * Every status gets a counter, derived from `MISSION_STATUSES` rather than written
   * out.
   *
   * Two reasons. The mechanical one: twelve hand-written counters is a place for a
   * status to be missed, and a board that under-counted would be lying by omission.
   * The real one: a status added to the domain appears here automatically, so the
   * projection cannot silently stop counting a state that exists.
   */
  // Spread from a typed zero-tally rather than an `Object.fromEntries`, so the compiler
  // checks that every status is present. `fromEntries` would produce
  // `Record<string, number>` and the assertion below would paper over a missing key.
  counts: Object.freeze<MissionProjection['counts']>({ total: 0, ...statusTally(), needsAttention: 0 }),
  limits: DEFAULT_MISSION_LIMITS,
  missionsRetained: 0,
  missionsTotal: 0,
  missionsHidden: 0,
  sequence: 0,
})

/** Every status at zero. Derived from the vocabulary, so no status can be uncounted. */
function statusTally(): Record<MissionStatus, number> {
  return Object.fromEntries(MISSION_STATUSES.map((status) => [status, 0])) as Record<MissionStatus, number>
}

/**
 * The mutable tally.
 *
 * The projection's public `counts` is `readonly`, which is right for a caller and
 * wrong for the loop that fills it in. This is that loop's type: every field writable,
 * frozen on the way out. Written out rather than derived with `-readonly` so a
 * compiler option cannot quietly make the mutation a type error later.
 */
type MutableCounts = {
  -readonly [K in keyof MissionProjection['counts']]: MissionProjection['counts'][K]
}

export function missionProjection(
  state: MissionState,
  work: WorkTruthPort,
  persistence: { mode: 'encrypted' | 'ephemeral' | 'unavailable'; reason: string | null },
  now: Date,
): MissionProjection {
  const all = [...state.missions.values()].sort(byRecencyThenId)
  const retained = all.slice(0, DEFAULT_MISSION_LIMITS.maxRetainedMissions)
  const missions = retained.map((mission) => summarise(mission, work, now))

  // Per-status counts describe the *listed* Missions, because that is what a person is
  // looking at. The retention triple below says how much of the truth is not on screen,
  // which is the part a viewer cannot otherwise detect.
  //
  // One counter per status, built from `MISSION_STATUSES` rather than written out, so
  // a status added to the domain is counted automatically. A board that silently
  // stopped counting a state that exists would be lying by omission, which is harder to
  // notice than a missing key.
  const counts: MutableCounts = { total: 0, ...statusTally(), needsAttention: 0 }
  for (const mission of missions) {
    counts.total += 1
    counts[mission.status] += 1
    if (mission.needsAttention) counts.needsAttention += 1
  }

  return {
    persistence: {
      mode: persistence.mode,
      reason: persistence.reason,
      // Never claimed unless the content store is actually encrypted *and* readable
      // now. A Mission somebody was told is durable and which is not is worse than no
      // Mission — and a store whose records are failing authentication is not durable
      // in any sense a person means by the word, however it is encrypted.
      durable: persistence.mode === 'encrypted' && persistence.reason === null,
    },
    missions,
    // Frozen on the way out, so the mutable tally above never escapes.
    counts: Object.freeze({ ...counts }),
    limits: DEFAULT_MISSION_LIMITS,
    // The honest retention triple, the same shape Work reports for its runs.
    //
    // `maxRetainedMissions` bounds what a board *lists* and nothing else — not the
    // journal, not the in-memory fold. So a viewer that silently stopped listing
    // Missions would read as "they were never created", which is false, and the
    // difference between `missionsTotal` and `missionsRetained` is exactly how much of
    // the truth is off screen.
    missionsRetained: missions.length,
    missionsTotal: all.length,
    missionsHidden: Math.max(0, all.length - missions.length),
    sequence: state.sequence,
  }
}

export function summarise(mission: MissionRecord, work: WorkTruthPort, now: Date): MissionSummaryView {
  const counts = countChildren(mission, work)
  const expired = !isTerminalMissionStatus(mission.status) && Date.parse(now.toISOString()) >= Date.parse(mission.deadlineAt)
  // A child that stopped without the Mission stopping is the case that goes missing if
  // only `failed` and `cancelled` are counted. A Mission can end up live with every
  // one of its Runs `paused` or `waiting` — stop propagates to the children outside the
  // Mission's lock, so a resume arriving mid-propagation can land before the stop
  // finishes and leave the Run stopped with nobody resuming it. Nothing is failing, so
  // this reads as "1 run" on the board with no warning at all.
  const childStalled = isLiveMissionStatus(mission.status) && (counts.paused > 0 || counts.waiting > 0)

  const evidence = evidenceCounts(mission.evidence, now)
  const steps = countPlanSteps(mission.activePlan?.steps ?? [])
  // A **pointer**, not a gate. The capability and risk come from the step the pointer names,
  // because a person deciding needs to know what they are deciding about — and they are
  // looked up rather than stored, so this projection cannot become a second place a gate's
  // facts live. `outcome === null` is what makes it *pending*; once Work reports how the
  // gate went, the Mission is no longer waiting on it and the board stops saying so.
  const approvalReference =
    mission.approval !== null && mission.approval.outcome === null ? mission.approval : null
  const approvalStep =
    approvalReference === null
      ? undefined
      : mission.activePlan?.steps.find((step) => step.stepId === approvalReference.stepId)
  const pendingApproval =
    approvalReference === null || approvalStep === undefined
      ? null
      : {
          approvalId: approvalReference.approvalId,
          stepId: approvalStep.stepId,
          capability: approvalStep.capability,
          risk: approvalStep.risk,
          requestedAt: approvalReference.requestedAt,
          source: approvalReference.source,
        }

  // `needsAttention` means *a person is needed*, and each term below is a case where
  // proceeding without one would be wrong rather than merely inconvenient.
  const needsAttention =
    expired ||
    counts.failed > 0 ||
    counts.cancelled > 0 ||
    childStalled ||
    // Anything blocked, or waiting on a decision only a person can make.
    mission.blockers.length > 0 ||
    pendingApproval !== null ||
    mission.awaitingOwner

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
    priority: mission.priority,
    planRevision: mission.activePlan?.revision ?? null,
    progress: progressView(mission, steps, evidence, now),
    currentStep: currentStepOf(mission),
    nextAction:
      mission.lastDecision === null
        ? null
        : { decision: mission.lastDecision.decision, reason: mission.lastDecision.reason },
    blockers: mission.blockers.map((blocker) => blocker.code),
    pendingApproval,
    evidence,
    nextWake:
      mission.wake === null || mission.wake.firedAt !== null
        ? null
        : {
            wakeId: mission.wake.wakeId,
            kind: mission.wake.kind,
            dueAt: mission.wake.dueAt,
            eventType: mission.wake.eventType,
          },
    lastUpdatedAt: mission.lastUpdatedAt,
    awaitingOwner: mission.awaitingOwner,
    budgetRemaining: budgetRemaining(mission),
  }
}

/**
 * Progress as counts, and the one boolean a board may render.
 *
 * `quantitySatisfied` is null whenever the owner named no quantity. It is never a
 * guess and never derived from the plan: a Mission with six of six steps verified and
 * no requested quantity reports `null`, because "done" is a question about the goal and
 * only the goal can answer it.
 *
 * `observed` excludes expired evidence. That is what makes the number mean "holds
 * right now" rather than "held once".
 */
function progressView(
  mission: MissionRecord,
  steps: MissionStepCounts,
  evidence: MissionEvidenceCounts,
  now: Date,
): MissionProgressView {
  void now
  const quantity = mission.requestedQuantity
  return {
    steps,
    planSteps: steps.total,
    observed: evidence.observed,
    reported: evidence.reported,
    requestedQuantity: quantity,
    quantitySatisfied: quantity === null ? null : evidence.observed >= quantity,
  }
}

/**
 * The step a board should show as "current".
 *
 * Plan order rather than recency, because a Mission's steps have dependencies and "the
 * latest one" is frequently not the one being waited on.
 */
function currentStepOf(mission: MissionRecord): MissionStepView | null {
  const steps = mission.activePlan?.steps ?? []
  if (steps.length === 0) return null
  // First non-terminal step, or — when every step is terminal — the **last** one.
  //
  // The fallback matters for the row a person actually reads. A Mission whose only step
  // has just verified has no "current" step, and rendering an empty cell there would make
  // a finished Mission look like it never had a plan. So the last step is shown, carrying
  // its real terminal status: `verified` is the fact, and inventing an in-progress step
  // to fill the cell would be the opposite of honest.
  const step = steps.find((candidate) => !isTerminalMissionStepStatus(candidate.status)) ?? steps[steps.length - 1]
  if (step === undefined) return null
  return {
    stepId: step.stepId,
    index: step.index,
    status: step.status,
    capability: step.capability,
    attempts: step.attempts,
    workerId: step.workerId,
    runId: step.runId,
    reason: step.reason,
    dependsOn: [...step.dependsOn],
  }
}

/**
 * How much of each ceiling is left.
 *
 * Clamped at zero. A Mission that has already exceeded a ceiling reads `0` rather than
 * a negative number, because "3 remaining" when 5 have been spent is a subtraction bug
 * wearing a number's clothes.
 *
 * `concurrentDelegations` is *headroom*, not spend: it is the ceiling minus the number
 * currently open, which is the only one of these that is not monotonic. A board showing
 * it as "0 remaining" correctly reads as "at its concurrency ceiling right now".
 */
function budgetRemaining(mission: MissionRecord): MissionBudgetRemaining {
  const clamp = (left: number): number => Math.max(0, left)
  return {
    modelCalls: clamp(mission.budget.maxModelCalls - mission.spend.modelCalls),
    actions: clamp(mission.budget.maxActions - mission.spend.actions),
    externalRequests: clamp(mission.budget.maxExternalRequests - mission.spend.externalRequests),
    retries: clamp(mission.budget.maxRetries - mission.spend.retries),
    delegations: clamp(mission.budget.maxDelegations - mission.spend.delegations),
    planRevisions: clamp(mission.budget.maxPlanRevisions - mission.planRevisions),
    concurrentDelegations: clamp(
      mission.budget.maxConcurrentDelegations - openDelegationCount(mission),
    ),
  }
}

/**
 * How many delegations are open right now.
 *
 * `delegated` and `running` both count: a delegation is open from the moment a worker
 * holds it until the step reaches a terminal status. Counting only `running` would let
 * a Mission fill its whole roster with workers that were assigned but had not started,
 * which is the swarm explosion this number exists to prevent.
 */
export function openDelegationCount(mission: MissionRecord): number {
  let open = 0
  for (const step of mission.activePlan?.steps ?? []) {
    if (step.status === 'delegated' || step.status === 'running') open += 1
  }
  return open
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

  // Universal to every non-terminal status. Offered here rather than appended at each
  // branch so that a new status cannot be added without automatically getting the three
  // things a person may always do to a Mission that has not settled.
  const universal: MissionAction[] = ['stop', 'correct', 'cancel']

  switch (mission.status) {
    case 'draft':
      return ['activate', ...universal]
    case 'ready':
      // No `activate`: a ready Mission is already started, and offering it would teach
      // that a button can do something twice.
      return ['stop', 'correct', 'cancel', 'fail']
    case 'planning':
      return ['stop', 'correct', 'cancel', 'fail']
    case 'active':
      return ['requestCompletion', ...universal, 'fail']
    case 'verifying':
      // No `requestCompletion`: a verification is already in flight, and offering the
      // control that starts one would offer a second.
      return ['stop', 'cancel', 'fail']
    case 'waiting':
      // `resumeAutonomy` rather than `resume`, and the distinction is load-bearing: `resume`
      // is Phase 7's "reopen a stopped gate and run it", while this is "carry on from this
      // wait". Offering the familiar word for both would make a button mean two things
      // depending on which state the Mission happened to be in.
      return ['resumeAutonomy', ...universal, 'fail']
    case 'blocked':
      // A blocked Mission cannot be resumed into running — whatever is in the way has to be
      // cleared first. What it can be is released to try again, which is what this is.
      return ['resumeAutonomy', ...universal, 'fail']
    case 'approval-required':
      // **No `decideApproval`**, and its absence is the design.
      //
      // A person answers an approval in one place: Work's approval surface, through
      // `work.approval.decide`, which evaluates `work.approval.decide` on the owner before
      // it does anything. Offering a second button here would be a second door into a
      // decision that already has one — and this door would be the one with no Guard
      // evaluation behind it.
      //
      // So a Mission parked on a gate offers only what is true of it: it can be cancelled,
      // stopped, or failed. The gate itself is not a Mission's to decide.
      return [...universal, 'fail']
    case 'stopped':
      // Phase 7's `resume`, because that is the door it has always been: only the owner can
      // reopen a stopped gate, and resuming runs the Mission.
      return ['resume', ...universal, 'fail']
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