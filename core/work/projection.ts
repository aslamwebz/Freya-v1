import type { PrincipalId } from '../../shared/contracts/identity'
import type { WorkState } from './state'
import {
  isTerminalRunStatus,
  WORK_LIMITS,
  type ApprovalStatus,
  type LimitName,
  type ObservationKind,
  type RunKind,
  type RunProgress,
  type RunStatus,
  type StepStatus,
  type TaskStatus,
  type WorkRisk,
} from './types'

/**
 * THE WORK PROJECTION — everything the renderer may know about Work.
 *
 * Its own type, its own slot, its own IPC channel, for the same reason the Brain
 * has one: this is a separate subsystem's state and folding it into `CoreStatus`
 * would mean long-running execution travels wherever a security projection is
 * cached, logged or forwarded.
 *
 * ## What crosses, and what deliberately does not
 *
 * Crosses: ids, statuses, kinds, counts, measured lengths, instants, and the
 * bounded labels and summaries this Core process is holding in memory.
 *
 * Does **not** cross:
 *
 * - **Step input.** Never journalled and never projected. A Step's input is
 *   whatever a capability is about to be handed, and putting it on a channel
 *   would make it durable audit surface by accident.
 * - **Observation contents.** A board needs to say "recorded 3 sources" and not
 *   to hold a copy of what a search returned.
 * - **Any capability instance, verifier instance or policy object.** A renderer
 *   that could reach one could describe an approval for itself.
 *
 * `labelsKnown` is a boolean rather than a per-field nullable because the honest
 * statement is a single fact: this process has never seen these labels, and after
 * a restart it never will. See `state.ts` for why that is true by construction.
 */

/** One Step as the board sees it. */
export interface WorkStepView {
  readonly stepId: string
  readonly key: string
  readonly index: number
  readonly status: StepStatus
  readonly attempts: number
  readonly capability: string
  readonly verifier: string
  readonly startedAt: string | null
  readonly settledAt: string | null
  /** Why this step stopped, or why it is waiting. A sentence, never content. */
  readonly reason: string | null
  /** Present only while this process still holds the plan's label. */
  readonly label: string | null
  readonly approvalId: string | null
}

/** One Action as the board sees it. Metadata only. */
export interface WorkActionView {
  readonly actionId: string
  readonly attempt: number
  readonly capability: string
  readonly principal: PrincipalId
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled'
  readonly durationMs: number | null
  readonly reason: string | null
}

/** One Observation as the board sees it. Counts, never contents. */
export interface WorkObservationView {
  readonly observationId: string
  readonly kind: ObservationKind
  readonly actionId: string | null
  /** Present only while this process still holds the observation. */
  readonly summary: string | null
  readonly summaryLength: number
  readonly detailLength: number
}

/** One Verification as the board sees it. */
export interface WorkVerificationView {
  readonly verificationId: string
  readonly verifier: string
  readonly status: 'requested' | 'passed' | 'failed'
  readonly reason: string | null
}

/** One Run as the board sees it. */
export interface WorkRunView {
  readonly runId: string
  readonly kind: RunKind
  readonly status: RunStatus
  readonly createdAt: string
  readonly startedAt: string | null
  readonly completedAt: string | null
  readonly cancelledAt: string | null
  readonly failure: string | null
  readonly waitingOn: string | null
  readonly taskId: string | null
  readonly parentKind: string | null
  readonly parentId: string | null
  readonly progress: RunProgress
  readonly limitHit: LimitName | null
  readonly steps: readonly WorkStepView[]
  readonly actions: readonly WorkActionView[]
  readonly observations: readonly WorkObservationView[]
  readonly verifications: readonly WorkVerificationView[]
  /** Whether this Run still occupies the engine. A process fact, not history. */
  readonly live: boolean
}

/** One Approval request as the board sees it. Enough to decide it. */
export interface WorkApprovalView {
  readonly approvalId: string
  readonly runId: string
  readonly stepId: string
  readonly status: ApprovalStatus
  /** The named capability that asked. */
  readonly capability: string
  /** The Guard capability it needs, which is what the guard actually judged. */
  readonly requiredCapability: string
  readonly risk: WorkRisk
  readonly requestedAt: string
  readonly decidedAt: string | null
  readonly decidedBy: PrincipalId | null
  readonly decisionSource: string | null
  readonly reason: string | null
  /** Why approval was required. */
  readonly justification: string
  /** What would happen if approved, in one bounded sentence. */
  readonly proposal: string
}

/** One Task as the board sees it. */
export interface WorkTaskView {
  readonly taskId: string
  readonly status: TaskStatus
  readonly createdAt: string
  readonly updatedAt: string
  readonly runIds: readonly string[]
  /** Present only while this process still holds the title. */
  readonly title: string | null
  readonly titleLength: number
}

export interface WorkProjection {
  /**
   * `unavailable` before Core has a Work engine, and `ready` once it does.
   *
   * Stated rather than implied, because "no work" and "no engine" render the same
   * otherwise and they are very different things.
   */
  readonly health: 'unavailable' | 'ready'
  readonly reason: string | null
  /**
   * Whether this process holds step plans, labels and observation contents.
   *
   * False after a restart, and durably true forever after one: the journal keeps
   * history, not content. A board says so rather than rendering empty fields as
   * though the work had nothing in it.
   */
  readonly detailAvailable: boolean
  readonly runs: readonly WorkRunView[]
  readonly tasks: readonly WorkTaskView[]
  readonly approvals: readonly WorkApprovalView[]
  readonly counts: {
    readonly runs: number
    readonly queued: number
    readonly running: number
    readonly waiting: number
    readonly awaitingApproval: number
    readonly paused: number
    readonly completed: number
    readonly failed: number
    readonly cancelled: number
    readonly pendingApprovals: number
    readonly tasks: number
    readonly liveCapabilities: number
  }
  /** The capabilities this Core can actually run. Names only, no instances. */
  /**
   * Runs this process holds volatile material for, and how many exist in total.
   *
   * Stated rather than implied, because a board that silently stopped listing runs
   * would read as "they finished and went away" — which is exactly the false
   * impression a bounded viewer is most likely to create. The journal still has all
   * of them; this is what the window was shown, not what happened.
   */
  readonly runsRetained: number
  readonly runsTotal: number
  /** How many finished runs are beyond the retention ceiling. */
  readonly runsHidden: number
  readonly capabilities: readonly string[]
  readonly verifiers: readonly string[]
  readonly limits: {
    readonly maxSteps: number
    readonly maxActions: number
    readonly maxDurationMs: number
    readonly maxAttemptsPerStep: number
  }
  readonly sequence: number
}

/**
 * Shown before Core has a Work engine.
 *
 * Mirrors `brainClient`'s `ABSENT_PROJECTION`: a board must be able to say "I
 * don't know" distinctly from "there is no work".
 */
export const ABSENT_WORK_PROJECTION: WorkProjection = Object.freeze({
  health: 'unavailable',
  reason: 'Core has not reported yet',
  detailAvailable: false,
  runs: [],
  tasks: [],
  approvals: [],
  counts: {
    runs: 0,
    queued: 0,
    running: 0,
    waiting: 0,
    awaitingApproval: 0,
    paused: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    pendingApprovals: 0,
    tasks: 0,
    liveCapabilities: 0,
  },
  runsRetained: 0,
  runsTotal: 0,
  runsHidden: 0,
  capabilities: [],
  verifiers: [],
  limits: {
    maxSteps: WORK_LIMITS.maxRunSteps,
    maxActions: WORK_LIMITS.maxRunActions,
    maxDurationMs: WORK_LIMITS.maxRunDurationMs,
    maxAttemptsPerStep: WORK_LIMITS.maxAttemptsPerStep,
  },
  sequence: 0,
})

/** The volatile half of the picture: labels, summaries and titles, per run. */
export interface WorkDetail {
  /** stepId → the plan's label. */
  readonly stepLabels: ReadonlyMap<string, string>
  /** observationId → its summary. */
  readonly observationSummaries: ReadonlyMap<string, string>
  /** taskId → its title. */
  readonly taskTitles: ReadonlyMap<string, string>
}

/** Which Runs are executing in *this* process right now. */
export type LiveRunIds = ReadonlySet<string>

/**
 * Choose which Runs the board lists.
 *
 * ## The rule, and why it is not simply "the newest N"
 *
 * **Live work is never evicted.** A Run that is queued, running, waiting or paused,
 * or one sitting in `awaiting_approval`, is always listed — whatever the ceiling is
 * and however many old runs are competing for the space. Dropping a running Run off
 * a board because 200 other Runs are newer would make the one thing a person most
 * needs to see the one thing they cannot see.
 *
 * So the ceiling applies to *settled* Runs, and the remaining budget goes to the
 * newest of those. A Run's work is finished and its history is in the journal
 * either way; what the ceiling spends is the volatile material — the plan, the step
 * labels, the observation summaries — which is the only part that grows in memory.
 *
 * Deterministic by construction: the input order is newest-first with the id as a
 * tie-breaker, so the same journal produces the same selection on every machine.
 */
export function selectRetainedRuns(
  newestFirst: readonly string[],
  state: WorkState,
  limit: number,
): ReadonlySet<string> {
  const pending = new Set<string>()
  for (const [, approval] of state.approvals) {
    if (approval.status === 'pending') pending.add(approval.runId)
  }

  const kept = new Set<string>()
  for (const runId of newestFirst) {
    const run = state.runs.get(runId)
    // Never evicted: unfinished, or blocked on a person.
    if (run && (!isTerminalRunStatus(run.status) || pending.has(runId))) {
      kept.add(runId)
      continue
    }
    if (kept.size >= limit) continue
    kept.add(runId)
  }
  return kept
}

/**
 * Build the renderer-safe projection.
 *
 * A pure function over durable state plus two volatile inputs, so the same call
 * serves the live board and any projection a test wants to assert. The volatile
 * parts are supplied rather than reached for, which is what stops a projection
 * from being able to observe whether a Run is live except through the explicit
 * `live` set.
 */
export function projectWork(
  state: WorkState,
  detail: WorkDetail,
  live: LiveRunIds,
  capabilities: readonly string[],
  verifiers: readonly string[],
  health: WorkProjection['health'] = 'ready',
  reason: string | null = null,
  limit: number = WORK_LIMITS.maxRetainedRuns,
): WorkProjection {
  const runViews: WorkRunView[] = []
  const counts = {
    runs: 0,
    queued: 0,
    running: 0,
    waiting: 0,
    awaitingApproval: 0,
    paused: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    pendingApprovals: 0,
    tasks: state.tasks.size,
    liveCapabilities: live.size,
  }

  // Newest first, so the board's head is what just happened. The id breaks ties in
  // the *same* direction, so the order is total: two runs created in the same
  // millisecond still have one deterministic order, and it is the same one on
  // every machine and every launch of the same journal. An id carries no time, so
  // this is purely a determinism device and the direction is arbitrary — matching
  // the primary sort is only so the two rules do not appear to disagree.
  const orderedRunIds = [...state.runs.keys()].sort((a, b) => {
    const left = state.runs.get(a)
    const right = state.runs.get(b)
    if (!left || !right) return 0
    const delta = Date.parse(right.createdAt) - Date.parse(left.createdAt)
    return delta !== 0 ? delta : b.localeCompare(a)
  })

  const shown = selectRetainedRuns(orderedRunIds, state, limit)

  for (const runId of orderedRunIds) {
    const run = state.runs.get(runId)
    if (!run) continue
    // Counts describe every Run, retained or not: a person asking "how many failed"
    // wants the answer to the question they asked, and only the *listing* is bounded
    // by the ceiling. Counted before the retention check below for that reason.
    counts.runs += 1
    switch (run.status) {
      case 'queued':
        counts.queued += 1
        break
      case 'running':
        counts.running += 1
        break
      case 'waiting':
        counts.waiting += 1
        break
      case 'awaiting_approval':
        counts.awaitingApproval += 1
        break
      case 'paused':
        counts.paused += 1
        break
      case 'completed':
        counts.completed += 1
        break
      case 'failed':
        counts.failed += 1
        break
      case 'cancelled':
        counts.cancelled += 1
        break
    }
    if (!shown.has(runId)) continue

    const stepIds = state.runSteps.get(runId) ?? []
    const steps: WorkStepView[] = []
    let actions = 0
    let attempts = 0
    for (const stepId of stepIds) {
      const step = state.steps.get(stepId)
      if (!step) continue
      attempts += step.attempts
      const stepActions = [...state.actions.values()].filter((action) => action.stepId === stepId)
      actions += stepActions.length
      steps.push({
        stepId,
        key: step.key,
        index: step.index,
        status: step.status,
        attempts: step.attempts,
        capability: step.capability,
        verifier: step.verifier,
        startedAt: step.startedAt,
        settledAt: step.settledAt,
        reason: step.reason,
        label: detail.stepLabels.get(stepId) ?? null,
        approvalId: step.approvalId,
      })
    }

    const observations = [...state.observations.values()]
      .filter((observation) => observation.runId === runId)
      .map((observation) => ({
        observationId: observation.observationId,
        kind: observation.kind,
        actionId: observation.actionId,
        summary: detail.observationSummaries.get(observation.observationId) ?? null,
        summaryLength: observation.summaryLength,
        detailLength: observation.detailLength,
      }))

    const runStepIds = new Set(stepIds)
    const verifications = [...state.verifications.values()]
      .filter((verification) => runStepIds.has(verification.stepId))
      .map((verification) => ({
        verificationId: verification.verificationId,
        verifier: verification.verifier,
        status: verification.status,
        reason: verification.reason,
      }))

    runViews.push({
      runId,
      kind: run.kind,
      status: run.status,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      cancelledAt: run.cancelledAt,
      failure: run.failure,
      waitingOn: run.waitingOn,
      taskId: run.taskId,
      parentKind: run.parentKind,
      parentId: run.parentId,
      progress: progressFor(state, runId, actions, attempts),
      limitHit: state.limitsHit.get(runId) ?? null,
      steps,
      actions: [...state.actions.values()]
        .filter((action) => action.runId === runId)
        .map((action) => ({
          actionId: action.actionId,
          attempt: action.attempt,
          capability: action.capability,
          principal: action.principal,
          status: action.status,
          durationMs: action.durationMs,
          reason: action.reason,
        })),
      observations,
      verifications,
      live: live.has(runId),
    })
  }

  const approvals: WorkApprovalView[] = [...state.approvals.values()]
    .sort((a, b) => Date.parse(b.requestedAt) - Date.parse(a.requestedAt))
    .map((approval) => {
      if (approval.status === 'pending') counts.pendingApprovals += 1
      return {
        approvalId: approval.approvalId,
        runId: approval.runId,
        stepId: approval.stepId,
        status: approval.status,
        capability: approval.capability,
        requiredCapability: approval.requiredCapability,
        risk: approval.risk,
        requestedAt: approval.requestedAt,
        decidedAt: approval.decidedAt,
        decidedBy: approval.decidedBy,
        decisionSource: approval.decisionSource,
        reason: approval.reason,
        justification: approval.justification,
        proposal: approval.proposal,
      }
    })

  const tasks: WorkTaskView[] = [...state.tasks.values()]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((task) => ({
      taskId: task.taskId,
      status: task.status,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      runIds: task.runIds,
      title: detail.taskTitles.get(task.taskId) ?? null,
      titleLength: task.titleLength,
    }))

  return {
    health,
    reason,
    detailAvailable: detail.stepLabels.size > 0 || detail.taskTitles.size > 0,
    runsRetained: runViews.length,
    runsTotal: state.runs.size,
    runsHidden: Math.max(0, state.runs.size - runViews.length),
    runs: runViews,
    tasks,
    approvals,
    counts,
    capabilities: [...capabilities],
    verifiers: [...verifiers],
    limits: {
      maxSteps: WORK_LIMITS.maxRunSteps,
      maxActions: WORK_LIMITS.maxRunActions,
      maxDurationMs: WORK_LIMITS.maxRunDurationMs,
      maxAttemptsPerStep: WORK_LIMITS.maxAttemptsPerStep,
    },
    sequence: state.sequence,
  }
}

/**
 * Structural progress, never a fabricated percentage.
 *
 * `percent` stays `null` until every step has settled, because a number computed
 * from steps that have not been decided is a number that will change and one a
 * person who saw it would remember. The summary line is what a board should
 * render; the counts are what a test should assert.
 */
export function progressFor(
  state: WorkState,
  runId: string,
  actions = 0,
  attempts = 0,
): RunProgress {
  const stepIds = state.runSteps.get(runId) ?? []
  let verified = 0
  let failed = 0
  let cancelled = 0
  let skipped = 0
  let settled = 0

  for (const stepId of stepIds) {
    const step = state.steps.get(stepId)
    if (!step) continue
    if (step.status === 'verified') {
      verified += 1
      settled += 1
    } else if (step.status === 'failed') {
      failed += 1
      settled += 1
    } else if (step.status === 'cancelled') {
      cancelled += 1
      settled += 1
    } else if (step.status === 'skipped') {
      skipped += 1
      settled += 1
    }
  }

  const total = stepIds.length
  const remaining = Math.max(0, total - settled)
  // Only for a run that finished cleanly, and never while anything is unsettled.
  //
  // A percentage over a run with a failed or cancelled step would be a number
  // describing something that will never progress, printed next to a word like
  // "progress" — which is the shape of a lie. The counts and the summary carry
  // those cases instead, and they are more informative than a percentage would be.
  const percent =
    total > 0 && settled === total && failed === 0 && cancelled === 0
      ? Math.round((verified / total) * 100)
      : null

  return {
    stepsTotal: total,
    verified,
    failed,
    cancelled,
    skipped,
    remaining,
    actions,
    attempts,
    percent,
    summary: summarise(total, verified, failed, cancelled, skipped, remaining),
  }
}

function summarise(
  total: number,
  verified: number,
  failed: number,
  cancelled: number,
  skipped: number,
  remaining: number,
): string {
  if (total === 0) return 'no steps were planned'
  const settled = verified + failed + cancelled + skipped
  if (remaining === 0) {
    const parts = [`${verified} of ${total} steps verified`]
    if (failed > 0) parts.push(`${failed} failed`)
    if (cancelled > 0) parts.push(`${cancelled} cancelled`)
    if (skipped > 0) parts.push(`${skipped} skipped`)
    return parts.join(', ')
  }
  if (settled === 0) return `${remaining} of ${total} steps remaining`
  return `${verified} of ${total} steps verified, ${remaining} remaining`
}