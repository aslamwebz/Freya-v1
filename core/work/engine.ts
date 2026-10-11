import { randomUUID } from 'node:crypto'
import type { EventFabric } from '../events/fabric'
import type { CoreEventType } from '../events/envelope'
import type { Capability, PrincipalId } from '../../shared/contracts/security'
import {
  sanitiseCapabilityInput,
  type WorkCapability,
  type WorkCapabilityContext,
  type WorkCapabilityRequest,
  type WorkCapabilityResult,
  type WorkObservationContent,
  type WorkRegistry,
  type WorkVerificationOutcome,
} from './capability'
import { initialWorkState, reduceWorkState, type WorkState } from './state'
import {
  projectWork,
  selectRetainedRuns,
  type WorkDetail,
  type WorkProjection,
} from './projection'
import { validateWorkPlan, resolveWorkLimits } from './plan-validation'
import { ApprovalDeadlineScheduler } from './approval-deadlines'
import {
  canTransitionRun,
  canTransitionStep,
  isTerminalRunStatus,
  TASK_TRANSITIONS,
  WORK_LIMITS,
  WORK_REASONS,
  type ApprovalDecision,
  type LimitName,
  type RunLimits,
  type RunStatus,
  type TaskStatus,
  type WorkRunPlan,
} from './types'

/**
 * THE WORK ENGINE.
 *
 * Privileged Core, outside the renderer and outside React, for the same reason the
 * Conversation service is: a Run that lived in a window would die when the window
 * reloaded, and `docs/ARCHITECTURE.md` §2 is explicit that the renderer is the
 * disposable half of this application. Reloading a window re-reads the
 * projection; the work keeps going.
 *
 * ## The rule this file is written around
 *
 * > Models decide. Code controls. Events remember. Verification establishes truth.
 *
 * Concretely:
 *
 * - **Nothing mutates state directly.** Every change is an append to the journal,
 *   and the fold of the journal is the only state there is. A Run has no field
 *   anyone can assign.
 * - **Transitions are validated centrally.** `moveRun`/`moveStep` refuse any edge
 *   not in `RUN_TRANSITIONS`/`STEP_TRANSITIONS`, and each one re-reads the status
 *   inside a per-Run queue. This is also the cancellation race answer: a
 *   completion that arrives after a cancellation is not a timing problem, it is an
 *   edge that does not exist.
 * - **A plan is a request.** `createRun` accepts one only after every step's
 *   capability and verifier have been found in the registry and every input has
 *   been sanitised. A capability cannot be smuggled through as data.
 * - **Approval happens before, never after.** `requestApproval` returns *before*
 *   `capability.execute` is on the call path. No ordering in this file can produce
 *   an action that is approved afterwards.
 * - **A Step closes only on a verifier.** The capability returns an Observation; a
 *   separately registered verifier decides. `test.unverifiable` exists to make the
 *   alternative reachable, and it cannot complete.
 * - **Idle Work spends nothing.** No timer, no wake source, no poll. `advance`
 *   runs only because somebody called `start`, `resume` or `decide`, and it
 *   returns the moment the Run reaches a resting point.
 */

/** How a Work command turned out. Explicit rather than a boolean. */
export type WorkOutcome =
  | 'status'
  | 'task-created'
  | 'task-updated'
  | 'task-refused'
  | 'run-created'
  | 'run-started'
  | 'run-paused'
  | 'run-resumed'
  | 'run-cancelled'
  | 'run-already-settled'
  | 'run-already-cancelling'
  | 'approval-approved'
  | 'approval-denied'
  | 'approval-unknown'

export interface WorkCommandOutcome {
  readonly operation: WorkOutcome
  readonly ok: boolean
  /** Present on a deliberate refusal, in words a person can act on. */
  readonly reason?: string
  readonly runId?: string
  readonly stepId?: string
  readonly approvalId?: string
  readonly taskId?: string
  readonly status?: RunStatus
}

/**
 * How the engine asks Guard whether a capability may run.
 *
 * A port rather than a `Principal`, deliberately. The engine holds no principal
 * and cannot build one — `core/security/guard.ts` exports the policy and nothing
 * that mints authority, and Core is the only place a trusted principal exists.
 * Wiring this in `core/index.ts` leaves that boundary exactly where it was.
 */
export interface WorkAuthorizer {
  evaluate(capability: Capability): WorkAuthorization
}

export type WorkAuthorization =
  | { allowed: true }
  | { allowed: false; outcome: 'deny' | 'approval_required'; reason: string }

export interface WorkEngineOptions {
  fabric: EventFabric
  authorizer: WorkAuthorizer
  registry: WorkRegistry
  /**
   * The principal whose capabilities are being evaluated.
   *
   * Recorded in `work.action.started` as a claim about who executed. Assigned by
   * Core and never taken from a command payload, for the same reason
   * `cognition.grant.created` records the owner regardless of what the payload
   * claims.
   */
  principalId: PrincipalId
  now?: () => Date
  newId?: () => string
  /** Fired after every journal change, so Core can re-publish the mirror. */
  onChange?: () => void
  /** Live facts the engine must respect. Read at the moment of the decision. */
  stopAll?: () => boolean
  stopAllReason?: () => string
}

/** One planned Step as this process holds it: the request plus what was allowed. */
interface LivePlan {
  readonly stepId: string
  readonly key: string
  readonly index: number
  readonly capabilityName: string
  readonly verifierName: string
  readonly requiresApproval: boolean
  /** Sanitised at `createRun`. Never journalled, never projected. */
  readonly input: Record<string, unknown>
}

interface LiveCapabilityCall {
  readonly controller: AbortController
  /**
   * Resolves when this Run's deadline expires.
   *
   * Raced against the capability *and* the verifier rather than merely aborting
   * them, because aborting only *asks*. A capability or a verifier that ignores its
   * signal would otherwise hold this Run open indefinitely, and a ceiling that code
   * can overrule by ignoring an argument is not a ceiling.
   */
  readonly expired: Promise<'duration'>
  /**
   * Resolves when the owner cancels.
   *
   * Kept separate from `expired` for two reasons. Cancellation must stay
   * distinguishable from a deadline, which is the whole point of writing two
   * different records; and, more practically, a cancel that had to wait out the
   * remaining budget would feel broken — a hanging verifier would keep a Run alive
   * for up to fifteen minutes after somebody pressed stop.
   */
  readonly cancelled: Promise<'cancelled'>
  /** Called by `cancelRun` in the same synchronous turn as the abort. */
  signalCancel(): void
  /** True once the deadline has fired, even if nothing has noticed yet. */
  fired(): boolean
  /** Clears the timer. Called exactly once, from a `finally`. */
  clear(): void
}

/**
 * How one capability call ended, as the engine sees it.
 *
 * A discriminated union rather than a value-or-throw, because the four outcomes
 * have four genuinely different settlements: `resolved` continues into observation
 * and verification, `rejected` is a failure the Step may retry, `expired` is the
 * duration ceiling, and `cancelled` is a person. Collapsing `resolved` and `expired`
 * — which is what a bare `await` does — is precisely how a slow capability used to
 * be able to finish a Run after its budget was gone.
 */
type CapabilityOutcome =
  | { kind: 'resolved'; value: WorkCapabilityResult }
  | { kind: 'rejected'; error: unknown }
  | { kind: 'expired' }
  | { kind: 'cancelled' }

/**
 * How one verification ended.
 *
 * The same four-way shape, for the same reason: a verifier is code, and `answered`
 * and `expired` must not be collapsed, or a late `passed` completes a Run whose
 * budget was already gone.
 */
type VerificationOutcome =
  | { kind: 'answered'; verdict: WorkVerificationOutcome }
  | { kind: 'rejected'; error: unknown }
  | { kind: 'expired' }
  | { kind: 'cancelled' }

/**
 * Which half of a Step's active path a deadline landed in.
 *
 * It changes only one thing — whether the Action is recorded as failed — and that
 * difference is the whole point. A capability that overran never completed, so its
 * action fails. A verifier that overran comes *after* an action that completed
 * cleanly, and rewriting that action as failed would be a false record: the
 * capability did return.
 */
type DeadlinePhase = 'capability' | 'verification'

/**
 * How long shutdown waits for running Run loops to settle.
 *
 * Bounded because the same thing `SHUTDOWN_DRAIN_MS` is for the gateway: a
 * capability that ignores its signal must not be able to hang the application.
 * Past the bound the journal is left with a start and no finish, which is exactly
 * what a crash would have written.
 */
const CLOSE_DRAIN_MS = 1_000

export class WorkEngine {
  private work: WorkState = initialWorkState()
  private dispose: () => void = () => {}

  /** stepId → the plan's label. In memory only; never journalled. */
  private readonly stepLabels = new Map<string, string>()
  /** observationId → its summary. In memory only; never journalled. */
  private readonly observationSummaries = new Map<string, string>()
  /** taskId → its title. In memory only; never journalled. */
  private readonly taskTitles = new Map<string, string>()
  /** runId → its plan. In memory only; this is exactly what a restart loses. */
  private readonly plans = new Map<string, readonly LivePlan[]>()
  /** The capability call executing right now. A process fact, like the gateway's. */
  private readonly calling = new Map<string, LiveCapabilityCall>()
  /** The Run loop currently driving steps. Also a process fact. */
  private readonly advancing = new Map<string, Promise<void>>()
  /** Cancellation intent, set synchronously before any await. The race answer. */
  private readonly cancelRequested = new Map<string, string>()
  /**
   * runId → when this Run's duration ceiling expired.
   *
   * Deliberately a different map from `cancelRequested`, because "the budget ran
   * out" and "a person stopped this" are different facts and the journal has to be
   * able to tell them apart. A Run that hit its ceiling fails with the ceiling as
   * the reason; it does not report a cancellation nobody asked for.
   */
  private readonly deadlineHit = new Map<string, number>()
  /** Pending approval expiry timers. At most maxPendingApprovals exist. */
  private readonly approvalDeadlines: ApprovalDeadlineScheduler
  /** Per-Run/Step/Approval write queue, so two writers cannot read the same source status. */
  private readonly queues = new Map<string, Promise<void>>()

  private readonly now: () => Date
  private readonly newId: () => string
  private closed = false

  constructor(private readonly options: WorkEngineOptions) {
    this.now = options.now ?? (() => new Date())
    this.newId = options.newId ?? (() => randomUUID())
    this.approvalDeadlines = new ApprovalDeadlineScheduler({
      now: this.now,
      isClosed: () => this.closed,
      isPending: (approvalId) => this.work.approvals.get(approvalId)?.status === 'pending',
      expire: (approvalId, reason) => this.expireApproval(approvalId, reason),
    })
  }

  /* ------------------------------------------------------------ lifecycle */

  /**
   * Subscribe to the journal and rebuild Work state from it.
   *
   * Installed before anything appends, for the reason `FreyaCore` installs its own
   * subscription there: an event that reached the journal without reaching the
   * state would leave a window attaching after a restart disagreeing with one
   * that never left.
   */
  async open(): Promise<void> {
    this.work = await this.options.fabric.replay(initialWorkState(), (draft, event) =>
      reduceWorkState(draft, event),
    )
    this.dispose = this.options.fabric.subscribe((event) => {
      this.work = reduceWorkState(this.work, event)
      this.options.onChange?.()
    })
  }

  async close(): Promise<void> {
    this.closed = true
    this.dispose()
    this.approvalDeadlines.clearAll()
    // Every capability is aborted before the fabric closes, for the reason
    // `Core.stop()` drains the gateway: a capability still running when the
    // journal closes would record its own outcome into a closed store.
    for (const [, call] of this.calling) call.controller.abort()
    // And every deadline timer is cleared, so nothing can fire into a closing
    // engine and append after `stop()` has promised it was finished. A timer that
    // outlived its capability would be the leak this whole mechanism risks.
    for (const [, call] of this.calling) call.clear()
    // The wait is bounded, for the same reason the gateway's drain is: a capability
    // that ignores its signal must not hang the application. Past the bound the
    // journal is left with a start and no finish, which is what a crash writes.
    const inFlight = Promise.allSettled([...this.advancing.values()])
    await Promise.race([
      inFlight,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CLOSE_DRAIN_MS)
        ;(timer as { unref?: () => void }).unref?.()
      }),
    ])
    this.calling.clear()
  }

  /**
   * Reconcile what the journal says was running with what this process can
   * honestly claim.
   *
   * The asymmetry is the point. A Run that was `running` when the process died
   * **cannot** continue — its plan was in memory — so it is failed, with the
   * reason written to the journal and shown on the board. Nothing is retried,
   * nothing resumes, and nothing is marked successful. An action that was
   * `running` is settled as cancelled rather than left to imply that a capability
   * is still executing, because history is not a live registry.
   *
   * A pending approval is expired rather than left hanging, because the decision
   * it was waiting for can no longer change anything and a request that appears
   * live forever is worse than one that says why it ended.
   *
   * Called once, after replay and before `core.ready`.
   */
  async recoverInterruptedRuns(): Promise<{ reconciled: number; approvalsExpired: number }> {
    let reconciled = 0
    let approvalsExpired = 0

    for (const run of [...this.work.runs.values()]) {
      if (isTerminalRunStatus(run.status)) continue
      reconciled += 1

      const approvalIds = (this.work.runSteps.get(run.runId) ?? [])
        .map((stepId) => this.work.steps.get(stepId)?.approvalId)
        .filter((id): id is string => typeof id === 'string')
      const blockedOnApproval = approvalIds.some((id) => this.work.approvals.get(id)?.status === 'pending')
      const reason = blockedOnApproval ? WORK_REASONS.approvalExpired : WORK_REASONS.restartInterrupted

      for (const approvalId of approvalIds) {
        const approval = this.work.approvals.get(approvalId)
        if (!approval || approval.status !== 'pending') continue
        approvalsExpired += 1
        await this.emit('work.approval.expired', {
          approvalId,
          runId: run.runId,
          stepId: approval.stepId,
          reason,
        })
      }

      for (const stepId of this.work.runSteps.get(run.runId) ?? []) {
        const step = this.work.steps.get(stepId)
        if (!step) continue
        if (step.status === 'verified' || step.status === 'cancelled' || step.status === 'skipped') continue
        await this.writeStep(stepId, 'cancelled', { runId: run.runId, reason })
      }

      await this.emit('work.run.recovered', {
        runId: run.runId,
        previousStatus: run.status,
        reason,
      })
    }

    return { reconciled, approvalsExpired }
  }

  /* ------------------------------------------------------------ projection */

  projection(): WorkProjection {
    this.pruneVolatile()
    const detail: WorkDetail = {
      stepLabels: this.stepLabels,
      observationSummaries: this.observationSummaries,
      taskTitles: this.taskTitles,
    }
    return projectWork(
      this.work,
      detail,
      new Set(this.advancing.keys()),
      this.options.registry.names(),
      this.options.registry.verifierNames(),
      'ready',
      null,
    )
  }

  /**
   * Drop the volatile material for Runs the board no longer lists.
   *
   * This is what `WORK_LIMITS.maxRetainedRuns` actually bounds, and the distinction
   * matters:
   *
   * - **The journal is never touched.** Every run that ever happened is still on
   *   disk, still replayable, and still answerable by id. Retention here is not
   *   deletion and must never become it — a Work store that quietly discarded
   *   history would be a different and much worse system.
   * - **The in-memory fold is not pruned either.** `WorkState` is the journal's
   *   image, exactly as `BrainState` and the conversation store are, and answering
   *   "what happened to run X" is worth the memory.
   * - **What is pruned is the volatile half**: a settled run's plan, its step labels
   *   and its observation summaries. That is the part that only exists while this
   *   process does, and the part that grows without a ceiling.
   *
   * Runs with live work or a pending approval are never pruned, whatever their age —
   * see `selectRetainedRuns`, which is the single definition of "listed" so the board
   * and the memory cannot disagree about what was dropped.
   */
  private pruneVolatile(): void {
    const retained = this.retainedRunIds()
    for (const runId of [...this.plans.keys()]) {
      if (retained.has(runId)) continue
      this.plans.delete(runId)
      // Step and observation ids are unique across runs, so this cannot reach into
      // another run's detail.
      for (const stepId of this.work.runSteps.get(runId) ?? []) {
        this.stepLabels.delete(stepId)
      }
      for (const observation of this.work.observations.values()) {
        if (observation.runId === runId) this.observationSummaries.delete(observation.observationId)
      }
    }
    // Task titles are not per-Run, so they are bounded on their own terms: a title
    // for a finished task is worth keeping for a while and not worth keeping
    // forever, and an unbounded map of text a person typed is exactly the sort of
    // thing this limit exists to stop.
    const tasks = [...this.work.tasks.values()]
    if (tasks.length <= WORK_LIMITS.maxRetainedRuns) return
    const ordered = [...tasks].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    for (const task of ordered.slice(WORK_LIMITS.maxRetainedRuns)) this.taskTitles.delete(task.taskId)
  }

  /** Which Runs this process keeps volatile material for. See `pruneVolatile`. */
  private retainedRunIds(): ReadonlySet<string> {
    const newestFirst = [...this.work.runs.keys()].sort((a, b) => {
      const left = this.work.runs.get(a)
      const right = this.work.runs.get(b)
      if (!left || !right) return 0
      const delta = Date.parse(right.createdAt) - Date.parse(left.createdAt)
      return delta !== 0 ? delta : b.localeCompare(a)
    })
    return selectRetainedRuns(newestFirst, this.work, WORK_LIMITS.maxRetainedRuns)
  }

  /** The folded durable state. Read-only; for assertions and diagnostics. */
  snapshot(): WorkState {
    return this.work
  }

  /**
   * How many duration deadlines are armed right now.
   *
   * A diagnostic with a job: "clear the timer" is a claim, and this is the way to
   * check it without waiting for a leak to become a failure somewhere else. It must
   * be zero whenever nothing is executing.
   */
  armedDeadlines(): number {
    return this.calling.size
  }

  /**
   * How much volatile per-Run material this process is holding.
   *
   * The retention ceiling is a memory bound, so the number it bounds has to be
   * observable — otherwise "bounded" is a claim about a projection while the maps
   * behind it grow without limit, which is the failure this ceiling exists to stop.
   */
  volatileCounts(): {
    plans: number
    stepLabels: number
    observationSummaries: number
    taskTitles: number
    cancellationIntents: number
    approvalTimers: number
    total: number
  } {
    const plans = this.plans.size
    const stepLabels = this.stepLabels.size
    const observationSummaries = this.observationSummaries.size
    const taskTitles = this.taskTitles.size
    const cancellationIntents = this.cancelRequested.size
    const approvalTimers = this.approvalDeadlines.size
    return {
      plans,
      stepLabels,
      observationSummaries,
      taskTitles,
      cancellationIntents,
      approvalTimers,
      total:
        plans +
        stepLabels +
        observationSummaries +
        taskTitles +
        cancellationIntents +
        approvalTimers,
    }
  }

  /* ----------------------------------------------------------------- tasks */

  async createTask(title: string): Promise<WorkCommandOutcome> {
    const text = title.trim()
    if (text.length === 0) {
      return { operation: 'task-refused', ok: false, reason: 'a task needs a title' }
    }
    const bounded = text.slice(0, WORK_LIMITS.maxLabelChars)
    const taskId = this.newId()
    await this.emit('work.task.created', { taskId, titleLength: bounded.length })
    this.taskTitles.set(taskId, bounded)
    this.options.onChange?.()
    return { operation: 'task-created', ok: true, taskId }
  }

  async updateTask(taskId: string, status: TaskStatus): Promise<WorkCommandOutcome> {
    const task = this.work.tasks.get(taskId)
    if (!task) return { operation: 'task-refused', ok: false, reason: 'no such task' }
    if (task.status === status) {
      // Idempotent rather than an error: a board that sends back the status it
      // just read must not manufacture a failure out of it.
      return { operation: 'task-updated', ok: true, taskId, reason: `the task is already ${status}` }
    }
    if (!TASK_TRANSITIONS[task.status].includes(status)) {
      return {
        operation: 'task-refused',
        ok: false,
        taskId,
        reason: `a task cannot go from ${task.status} to ${status}`,
      }
    }
    await this.writeTask(taskId, status)
    this.options.onChange?.()
    return { operation: 'task-updated', ok: true, taskId }
  }

  /* ------------------------------------------------------------------ runs */

  /**
   * Create a Run from a plan.
   *
   * Everything about the plan is checked here and nothing is trusted downstream:
   * the kind is in the closed vocabulary, the parent reference is a reference
   * rather than free text, the ceilings are clamped downward, every step's
   * capability *and* verifier exist in the registry, and every input is
   * sanitised. A plan naming something this Core cannot run is refused whole —
   * not partially executed, and not quietly trimmed.
   */
  async createRun(plan: WorkRunPlan): Promise<WorkCommandOutcome> {
    if (this.closed) return { operation: 'run-created', ok: false, reason: 'work is shutting down' }
    const problem = this.validatePlan(plan)
    if (problem !== null) return { operation: 'run-created', ok: false, reason: problem }

    const limits = this.resolveLimits(plan.limits)
    const live: LivePlan[] = []
    const seeds: { stepId: string; key: string; capability: string; verifier: string }[] = []
    for (const [index, step] of plan.steps.entries()) {
      const stepId = this.newId()
      const input = sanitiseCapabilityInput(step.input)
      if (!input.ok) {
        return { operation: 'run-created', ok: false, reason: `step "${step.key}": ${input.reason}` }
      }
      this.stepLabels.set(stepId, step.label.slice(0, WORK_LIMITS.maxLabelChars))
      seeds.push({ stepId, key: step.key, capability: step.capability, verifier: step.verifier })
      live.push({
        stepId,
        key: step.key,
        index,
        capabilityName: step.capability,
        verifierName: step.verifier,
        requiresApproval: step.requiresApproval === true,
        input: input.value,
      })
    }

    const runId = this.newId()
    await this.emit('work.run.created', {
      runId,
      kind: plan.kind ?? 'deterministic',
      taskId: plan.taskId ?? null,
      parentKind: plan.parent?.kind ?? null,
      parentId: plan.parent?.id ?? null,
      limits,
      steps: seeds,
    })
    if (plan.taskId) {
      await this.emit('work.task.attached', { taskId: plan.taskId, runId })
      await this.bumpTask(plan.taskId, 'in_progress')
    }

    this.plans.set(runId, live)
    this.options.onChange?.()
    return { operation: 'run-created', ok: true, runId, status: 'queued' }
  }

  /**
   * Start a queued Run and drive it until it reaches a resting point.
   *
   * Resolves when the Run *stops moving*: completed, failed, cancelled, paused, or
   * waiting for an approval. Nothing here waits for work that is not running, and
   * no timer makes a finished Run look busy.
   */
  async startRun(runId: string): Promise<WorkCommandOutcome> {
    const run = this.work.runs.get(runId)
    if (!run) return { operation: 'run-started', ok: false, reason: 'no such run' }
    if (run.status !== 'queued') {
      return {
        operation: 'run-started',
        ok: false,
        runId,
        status: run.status,
        reason: `a run can only start while it is queued; this one is ${run.status}`,
      }
    }
    if (this.cancelRequested.has(runId)) {
      return { operation: 'run-started', ok: false, runId, reason: 'this run is being cancelled' }
    }
    if (this.options.stopAll?.() === true) {
      return {
        operation: 'run-started',
        ok: false,
        runId,
        reason: `Freya is stopped: ${this.options.stopAllReason?.() ?? 'she will not act'}`,
      }
    }

    await this.moveRun(runId, 'running', 'work.run.started', { runId })
    await this.advance(runId)
    return { operation: 'run-started', ok: true, runId, status: this.statusOf(runId) }
  }

  async pauseRun(runId: string, reason: string = 'paused by the owner'): Promise<WorkCommandOutcome> {
    const run = this.work.runs.get(runId)
    if (!run) return { operation: 'run-paused', ok: false, reason: 'no such run' }
    if (run.status !== 'running' && run.status !== 'waiting') {
      return {
        operation: 'run-paused',
        ok: false,
        runId,
        status: run.status,
        reason: `a run cannot be paused while it is ${run.status}`,
      }
    }
    await this.moveRun(runId, 'paused', 'work.run.paused', { runId, reason: this.bounded(reason) })
    return { operation: 'run-paused', ok: true, runId, status: this.statusOf(runId) }
  }

  async resumeRun(runId: string): Promise<WorkCommandOutcome> {
    const run = this.work.runs.get(runId)
    if (!run) return { operation: 'run-resumed', ok: false, reason: 'no such run' }
    if (run.status !== 'paused') {
      return {
        operation: 'run-resumed',
        ok: false,
        runId,
        status: run.status,
        reason: `a run can only resume from paused; this one is ${run.status}`,
      }
    }
    if (this.cancelRequested.has(runId)) {
      return { operation: 'run-resumed', ok: false, runId, reason: 'this run is being cancelled' }
    }
    await this.moveRun(runId, 'running', 'work.run.resumed', { runId, reason: null })
    await this.advance(runId)
    return { operation: 'run-resumed', ok: true, runId, status: this.statusOf(runId) }
  }

  /**
   * Cancel a Run.
   *
   * Three properties, in this order, because the order is what makes them true:
   *
   * 1. **A terminal Run is not touched.** The check is first and writes nothing, so
   *    a cancellation signal arriving after a completion cannot rewrite a
   *    completed Run as cancelled. That is the completion/cancellation race, and it
   *    is closed by inspection rather than by timing.
   * 2. **Intent is recorded before any await.** The flag is set and the capability
   *    aborted in the same synchronous turn, so a capability already executing
   *    stops now rather than after a microtask.
   * 3. **Idempotent.** A second cancel finds the flag and writes no second event.
   *
   * The terminal events are written by whoever is actually executing — the step
   * loop if one is in flight, otherwise this call — so there is exactly one writer
   * per Run and no race *between* them.
   */
  async cancelRun(runId: string, reason: string = WORK_REASONS.cancelled): Promise<WorkCommandOutcome> {
    const run = this.work.runs.get(runId)
    if (!run) return { operation: 'run-cancelled', ok: false, reason: 'no such run' }
    if (isTerminalRunStatus(run.status)) {
      // No append, no flag, no effect. A completed Run stays completed.
      return { operation: 'run-already-settled', ok: true, runId, status: run.status }
    }
    if (this.cancelRequested.has(runId)) {
      return { operation: 'run-already-cancelling', ok: true, runId, status: run.status }
    }

    // Synchronous: there is deliberately no await between deciding and aborting.
    // Cancellation also clears any armed deadline, because a Run being stopped by
    // a person must not be able to be marked as having run out of budget a moment
    // later by a timer that outlived the decision.
    this.cancelRequested.set(runId, this.bounded(reason))
    this.deadlineHit.delete(runId)
    this.calling.get(runId)?.clear()
    this.calling.get(runId)?.controller.abort()
    // Signalled last, and still synchronously. The abort above only *asks* the
    // capability or verifier to stop; this releases the race so the engine stops
    // waiting for code that never intends to answer. Without it, one hanging
    // verifier would keep a cancelled Run alive for the rest of its budget.
    this.calling.get(runId)?.signalCancel()

    const inFlight = this.advancing.get(runId)
    if (inFlight) {
      // The loop owns this Run's terminal events, so it writes them.
      await inFlight
    } else {
      await this.finishCancelled(runId, this.cancelRequested.get(runId) ?? reason)
    }

    return { operation: 'run-cancelled', ok: true, runId, status: this.statusOf(runId) }
  }

  /**
   * The terminal writes for a Run with nothing executing.
   *
   * Every unsettled step settles, and any approval still pending on one is
   * cancelled, because a decision nobody can act on any more should not keep
   * appearing on the board as though it could.
   */
  private async finishCancelled(runId: string, reason: string): Promise<void> {
    for (const stepId of this.work.runSteps.get(runId) ?? []) {
      const step = this.work.steps.get(stepId)
      if (!step) continue
      if (step.status === 'verified' || step.status === 'cancelled' || step.status === 'skipped') continue
      if (step.status === 'awaiting_approval' && step.approvalId) {
        const approvalId = step.approvalId
        await this.serialise(`approval:${approvalId}`, async () => {
          this.clearApprovalTimer(approvalId)
          const approval = this.work.approvals.get(approvalId)
          if (approval?.status === 'pending') {
            await this.emit('work.approval.cancelled', {
              approvalId,
              runId,
              stepId,
              reason,
            })
          }
        })
      }
      await this.writeStep(stepId, 'cancelled', { runId, reason })
    }
    await this.moveRun(runId, 'cancelled', 'work.run.cancelled', { runId, reason })
    this.settleDeadline(runId)
    const settled = this.work.runs.get(runId)
    if (settled && isTerminalRunStatus(settled.status)) this.cancelRequested.delete(runId)
  }

  /* ------------------------------------------------------------- approvals */

  /**
   * Decide an approval request.
   *
   * The only path that can restart a stopped Run, and the only one a renderer can
   * reach. Three properties:
   *
   * - **Only the owner may reach it.** The capability is checked by Core before
   *   this is called, and `decidedBy` is a parameter Core supplies — a command
   *   payload naming a different principal changes nothing, because there is no
   *   field here to read one from.
   * - **A decision is terminal and single.** A request that has already been
   *   decided, expired or cancelled is refused, so a stale board cannot approve an
   *   action that has since failed.
   * - **Nothing has run yet.** This is only reachable for a Run parked in
   *   `awaiting_approval`, which means no capability was called for that step. The
   *   gate is upstream of execution, not a note taken afterwards.
   */
  async decideApproval(
    approvalId: string,
    decision: ApprovalDecision,
    reason: string,
    decidedBy: PrincipalId,
    decisionSource: string = 'owner',
  ): Promise<WorkCommandOutcome> {
    return this.serialise(`approval:${approvalId}`, () =>
      this.decideApprovalUnlocked(approvalId, decision, reason, decidedBy, decisionSource),
    )
  }

  private async decideApprovalUnlocked(
    approvalId: string,
    decision: ApprovalDecision,
    reason: string,
    decidedBy: PrincipalId,
    decisionSource: string,
  ): Promise<WorkCommandOutcome> {
    const approval = this.work.approvals.get(approvalId)
    if (!approval) {
      return { operation: 'approval-unknown', ok: false, approvalId, reason: 'no such approval request' }
    }
    if (approval.status !== 'pending') {
      return {
        operation: 'approval-unknown',
        ok: false,
        approvalId,
        runId: approval.runId,
        reason: `this request was already ${approval.status}`,
      }
    }
    if (this.expired(approval.requestedAt)) {
      await this.expireApprovalUnlocked(approvalId, WORK_REASONS.approvalTimedOut)
      return {
        operation: 'approval-unknown',
        ok: false,
        approvalId,
        runId: approval.runId,
        status: this.statusOf(approval.runId),
        reason: 'this request expired before it was decided',
      }
    }

    this.clearApprovalTimer(approvalId)
    const bounded = this.bounded(reason) ||
      (decision === 'denied' ? 'denied by the owner' : 'approved by the owner')

    if (decision === 'approved') {
      await this.emit('work.approval.approved', {
        approvalId,
        runId: approval.runId,
        stepId: approval.stepId,
        decidedBy,
        decisionSource,
      })
      const parked = this.work.steps.get(approval.stepId)
      await this.writeStep(approval.stepId, 'ready', {
        runId: approval.runId,
        stepKey: parked?.key ?? approval.stepId,
      })
      await this.moveRun(approval.runId, 'running', 'work.run.resumed', {
        runId: approval.runId,
        reason: 'the request was approved',
      })
      this.options.onChange?.()
      await this.advance(approval.runId)
      return {
        operation: 'approval-approved',
        ok: true,
        approvalId,
        runId: approval.runId,
        stepId: approval.stepId,
        status: this.statusOf(approval.runId),
      }
    }

    await this.emit('work.approval.denied', {
      approvalId,
      runId: approval.runId,
      stepId: approval.stepId,
      decidedBy,
      decisionSource,
      reason: bounded,
    })
    await this.writeStep(approval.stepId, 'failed', {
      runId: approval.runId,
      reason: WORK_REASONS.approvalDenied,
    })
    await this.skipRemaining(approval.runId, WORK_REASONS.approvalDenied)
    const moved = await this.moveRun(approval.runId, 'failed', 'work.run.failed', {
      runId: approval.runId,
      reason: WORK_REASONS.approvalDenied,
      stepCount: this.stepCount(approval.runId),
      verifiedCount: this.verifiedCount(approval.runId),
    })
    if (moved) {
      const run = this.work.runs.get(approval.runId)
      if (run?.taskId) await this.bumpTask(run.taskId, 'blocked')
    }
    this.settleDeadline(approval.runId)
    this.options.onChange?.()
    return {
      operation: 'approval-denied',
      ok: true,
      approvalId,
      runId: approval.runId,
      stepId: approval.stepId,
      status: this.statusOf(approval.runId),
      reason: bounded,
    }
  }

  /* ------------------------------------------------------------- the loop */

  /**
   * Drive a Run forward until it rests.
   *
   * Re-entrant calls join the in-flight promise rather than starting a second
   * loop, so an approval decision arriving while a loop is finishing cannot drive
   * two passes over the same plan.
   */
  private async advance(runId: string): Promise<void> {
    const existing = this.advancing.get(runId)
    if (existing) {
      await existing
      return
    }
    const run = this.drive(runId)
    this.advancing.set(runId, run)
    try {
      await run
    } finally {
      if (this.advancing.get(runId) === run) this.advancing.delete(runId)
    }
  }

  private async drive(runId: string): Promise<void> {
    for (;;) {
      const run = this.work.runs.get(runId)
      if (!run || isTerminalRunStatus(run.status)) return
      if (run.status === 'paused' || run.status === 'awaiting_approval' || run.status === 'waiting') return

      if (this.cancelRequested.has(runId)) {
        await this.finishCancelled(runId, this.cancelRequested.get(runId) ?? WORK_REASONS.cancelled)
        return
      }
      if (this.options.stopAll?.() === true) {
        await this.finishCancelled(
          runId,
          this.options.stopAllReason?.() ?? 'Freya is stopped, so this run was stopped with it',
        )
        return
      }
      if (run.status === 'queued') {
        await this.moveRun(runId, 'running', 'work.run.started', { runId })
        continue
      }

      const selection = await this.selectStep(runId)
      if (selection === null) return
      if (selection === 'finish') {
        await this.finishRun(runId)
        return
      }
      if (!(await this.runStep(runId, selection))) return
    }
  }

  /**
   * Choose the next Step, or decide the Run is over.
   *
   * Strictly in planned order, which is what `deterministic` means and the whole
   * reason a dependency graph is not needed yet. Two behaviours are folded in
   * because they are bookkeeping rather than scheduling:
   *
   * - a `pending` step whose predecessors have all settled becomes `ready`;
   * - a `failed` step with attempts left returns to `ready`, and one without them
   *   means the Run cannot continue — so every later step is `skipped` and the Run
   *   is finished, which records it as failed with the reason already written.
   *
   * Returns `null` when another loop owns this Run.
   */
  private async selectStep(runId: string): Promise<string | 'finish' | null> {
    for (const stepId of this.work.runSteps.get(runId) ?? []) {
      const step = this.work.steps.get(stepId)
      if (!step) continue

      if (step.status === 'verified' || step.status === 'cancelled' || step.status === 'skipped') continue

      if (step.status === 'pending') {
        await this.writeStep(stepId, 'ready', { runId, stepKey: step.key })
        return stepId
      }

      if (step.status === 'failed') {
        const ceiling = this.work.runs.get(runId)?.limits.maxAttemptsPerStep ?? WORK_LIMITS.maxAttemptsPerStep
        if (step.attempts < ceiling && !this.cancelRequested.has(runId)) {
          await this.writeStep(stepId, 'ready', { runId, stepKey: step.key })
          return stepId
        }
        await this.skipRemaining(runId, `step "${step.key}" failed and will not be retried`)
        return 'finish'
      }

      if (step.status === 'ready') return stepId
      // running / waiting / awaiting_approval with nobody driving: another loop
      // owns it. Standing aside is the honest answer.
      return null
    }
    return 'finish'
  }

  /**
   * Execute one Step: gate, guard, capability, observation, verification.
   *
   * The order is the design and is not rearranged for convenience:
   *
   * ```
   *   resolve capability + verifier   (a Step with no verifier can never close)
   *   Guard                           (a refusal ends it; nothing has run)
   *   approval gate                   (recorded, and returned from BEFORE execute)
   *   ceilings                        (checked before the thing they bound)
   *   step → running, action → started
   *   capability.execute  ─┐
   *                       ├─ both raced against ONE run deadline
   *   verifier.verify     ─┘
   *   action settled → observation recorded → step verified or failed
   * ```
   *
   * ## The deadline covers the whole of that, not the first line of it
   *
   * `maxDurationMs` bounds a Step's entire active path — capability, observation,
   * verification — and the two phases share one deadline computed once, before the
   * capability is called. There is no fresh budget for verification: it gets the
   * remainder of the original window, because a per-phase budget would let one Step
   * take the ceiling twice and a three-step Run take it three times.
   *
   * Both phases are *raced* against that deadline rather than awaited, so neither a
   * capability nor a verifier can hold the Run open by ignoring its signal. The
   * consequence worth stating plainly: on the final Step, a verifier returning
   * `passed` after the budget was gone would complete the Run — so a late verdict is
   * discarded, and no `work.verification.completed` is written at all.
   */
  private async runStep(runId: string, stepId: string): Promise<boolean> {
    const run = this.work.runs.get(runId)
    const step = this.work.steps.get(stepId)
    const live = this.plans.get(runId)?.find((candidate) => candidate.stepId === stepId)
    if (!run || !step || !live) return false

    const capability = this.options.registry.capability(live.capabilityName)
    if (!capability) return this.failStep(runId, stepId, WORK_REASONS.capabilityMissing)
    const verifier = this.options.registry.verifier(live.verifierName)
    if (!verifier) return this.failStep(runId, stepId, WORK_REASONS.verifierMissing)

    // A step parked in `awaiting_approval` has already cleared its gate, and so has
    // one whose recorded approval was granted — otherwise approving a consequential
    // request would simply park the step in front of the same gate again.
    const granted = this.grantedApproval(step)
    if (step.status !== 'awaiting_approval' && !granted) {
      const guard = this.options.authorizer.evaluate(capability.capability)
      if (!guard.allowed) {
        if (guard.outcome === 'approval_required') {
          return this.requestApproval(runId, stepId, live, capability, guard.reason)
        }
        await this.recordGuardDenial(guard.reason, capability.capability)
        return this.failStep(runId, stepId, guard.reason)
      }

      if (capability.risk === 'consequential' || live.requiresApproval) {
        return this.requestApproval(
          runId,
          stepId,
          live,
          capability,
          capability.risk === 'consequential'
            ? 'this capability is consequential and will not run without your approval'
            : 'this step asked to be approved before it runs',
        )
      }
    }

    if (this.cancelRequested.has(runId)) {
      await this.finishCancelled(runId, this.cancelRequested.get(runId) ?? WORK_REASONS.cancelled)
      return false
    }

    const ceiling = this.exhaustedLimit(runId)
    if (ceiling !== null) {
      await this.recordLimit(runId, ceiling)
      return this.failStep(runId, stepId, limitReason(ceiling))
    }

    const attempt = step.attempts + 1
    const actionId = this.newId()
    const request: WorkCapabilityRequest = {
      runId,
      stepId,
      stepKey: step.key,
      actionId,
      attempt,
      input: live.input,
      correlationId: runId,
    }

    const controller = new AbortController()
    /**
     * The remaining wall clock for this Run, computed *before* the capability is
     * called rather than before the next one. Checking it between Actions was not a
     * ceiling at all: a capability could start a second before the deadline and run
     * for an hour afterwards, and the Run would still be allowed to continue.
     */
    const deadlineAt = Date.parse(run.startedAt ?? this.now().toISOString()) + run.limits.maxDurationMs
    const remainingMs = deadlineAt - this.now().getTime()
    if (remainingMs <= 0) {
      await this.recordLimit(runId, 'duration')
      return this.failStep(runId, stepId, limitReason('duration'))
    }

    const armed = this.armDeadline(runId, controller, remainingMs)
    this.calling.set(runId, armed)
    const began = this.now().getTime()

    try {
      await this.emit('work.step.started', {
        runId,
        stepId,
        stepKey: step.key,
        index: step.index,
        capability: capability.name,
        attempt,
      })
      await this.emit('work.action.started', {
        runId,
        stepId,
        actionId,
        attempt,
        capability: capability.name,
        principal: this.options.principalId,
      })

      /**
       * Raced, not awaited.
       *
       * Aborting asks a capability to stop; it does not make it stop. A capability
       * that ignores its signal would hold this Run open indefinitely, so the
       * engine stops *waiting* at the deadline and settles the Run itself. The
       * capability's promise is still given both handlers, so if it eventually
       * settles — or rejects — nothing escapes as an unhandled rejection and its
       * result is simply ignored. That is the honest boundary: JavaScript cannot
       * forcibly terminate arbitrary code, so the engine stops *believing* it
       * instead of pretending it stopped.
       */
      const context: WorkCapabilityContext = { signal: controller.signal, now: this.now }
      const outcome = await Promise.race([
        capability.execute(request, context).then(
          (value): CapabilityOutcome => ({ kind: 'resolved', value }),
          (error: unknown): CapabilityOutcome => ({ kind: 'rejected', error }),
        ),
        armed.expired.then((): CapabilityOutcome => ({ kind: 'expired' })),
        armed.cancelled.then((): CapabilityOutcome => ({ kind: 'cancelled' })),
      ])

      const elapsed = Math.max(0, this.now().getTime() - began)

      // Cancellation is checked first, and always. It wins a race with the
      // deadline because a person pressing stop is a more specific fact than a
      // budget running out, and because `cancelRun` set its flag in the same
      // synchronous turn as the abort.
      if (this.cancelRequested.has(runId)) {
        const reason = this.cancelRequested.get(runId) ?? WORK_REASONS.cancelled
        await this.emit('work.action.cancelled', { runId, stepId, actionId, attempt, reason })
        await this.writeStep(stepId, 'cancelled', { runId, reason })
        await this.finishCancelled(runId, reason)
        return false
      }

      /**
       * A capability that resolved *after* the deadline is not a success.
       *
       * `armed.fired()` rather than only the race outcome, because a capability can
       * win the race microseconds before the timer fires. Without this check a slow
       * capability could complete an Action after its budget expired and the Run
       * would go on to `completed` — which is the exact failure this ceiling exists
       * to prevent.
       */
      if (outcome.kind === 'cancelled') {
        // The race was released by the owner rather than by the clock. `cancelRun`
        // sets its flag and releases the race in the same synchronous turn, so the
        // branch above normally gets there first; this covers the ordering where the
        // release lands first. The reason comes from the same place either way, so a
        // cancellation can never be recorded with the ceiling's wording.
        const reason = this.cancelRequested.get(runId) ?? WORK_REASONS.cancelled
        await this.emit('work.action.cancelled', { runId, stepId, actionId, attempt, reason })
        await this.writeStep(stepId, 'cancelled', { runId, reason })
        await this.finishCancelled(runId, reason)
        return false
      }

      if (outcome.kind === 'expired' || armed.fired() || this.now().getTime() >= deadlineAt) {
        return this.finishDeadline(runId, stepId, 'capability', { actionId, attempt, elapsedMs: elapsed })
      }

      if (outcome.kind === 'rejected') {
        // Aborted without a cancel or a deadline: Core is shutting down. That is a
        // cancellation, and it says so rather than calling it a failure.
        if (controller.signal.aborted) {
          const reason = 'the capability was aborted'
          await this.emit('work.action.cancelled', { runId, stepId, actionId, attempt, reason })
          await this.writeStep(stepId, 'cancelled', { runId, reason })
          await this.finishCancelled(runId, reason)
          return false
        }
        const reason = WORK_REASONS.capabilityFailed
        await this.emit('work.action.failed', { runId, stepId, actionId, attempt, reason, durationMs: elapsed })
        // Thrown diagnostics are deliberately not journalled: a capability may
        // wrap a provider, filesystem or process error whose message contains
        // secrets or local paths. The fixed reason is the durable fact.
        await this.writeStep(stepId, 'failed', { runId, reason })
        return true
      }

      const observation = normaliseObservation(outcome.value.observation, step.key)

      await this.emit('work.action.completed', { runId, stepId, actionId, attempt, durationMs: elapsed })

      const observationId = this.newId()
      this.observationSummaries.set(observationId, observation.summary)
      await this.emit('work.observation.recorded', {
        runId,
        stepId,
        actionId,
        observationId,
        kind: observation.kind,
        summaryLength: observation.summary.length,
        detailLength: measure(observation.data),
      })

      /**
       * The deadline still holds, and it is the *same* one.
       *
       * `maxDurationMs` bounds the whole active path of a Step — capability, then
       * observation, then verification — not the capability and then whatever is
       * left over. There is no fresh budget here: `deadlineAt` was computed once,
       * before the capability was called, and verification gets the remainder of
       * *that* window. Re-arming per phase would let a Step take the ceiling three
       * times over and turn a bounded Run into an unbounded one.
       *
       * Checked before requesting a verification that cannot now finish, so a
       * verification is not even asked for when the budget to ask is already gone.
       */
      if (armed.fired() || this.now().getTime() >= deadlineAt) {
        return this.finishDeadline(runId, stepId, 'verification')
      }

      const verificationId = this.newId()
      await this.emit('work.verification.requested', {
        runId,
        stepId,
        verificationId,
        verifier: verifier.name,
      })

      /**
       * Raced against the same deadline, for the same reason as the capability.
       *
       * A verifier is code, so it can be as slow or as stubborn as a capability,
       * and `await`-ing it unbounded would leave the ceiling bounding the first
       * half of a Step and not the second half — which is the hole this closes.
       * On the final Step that hole is the whole Run: a verifier returning `passed`
       * after the budget was gone would complete it.
       *
       * Both handlers are attached, so a verifier that eventually settles after the
       * deadline has its result discarded rather than becoming an unhandled
       * rejection or a resurrected Run.
       */
      const verification = await Promise.race([
        /**
         * The call is wrapped rather than merely promise-chained, because
         * `WorkVerifier.verify` is allowed to return an outcome *or* a promise of
         * one — so it may also throw synchronously, before any promise exists to
         * attach a rejection handler to. Chaining the result would let that throw
         * escape the `race` entirely and tear down the Run driver, which is a
         * verifier's own failure being escalated into an engine failure.
         */
        (async (): Promise<VerificationOutcome> => {
          try {
            return { kind: 'answered', verdict: await verifier.verify({
              runId,
              stepId,
              stepKey: step.key,
              attempt,
              input: live.input,
              observation,
            }) }
          } catch (error: unknown) {
            return { kind: 'rejected', error }
          }
        })(),
        armed.expired.then((): VerificationOutcome => ({ kind: 'expired' })),
        armed.cancelled.then((): VerificationOutcome => ({ kind: 'cancelled' })),
      ])

      // Cancellation first, on this path too, for the same reason as everywhere.
      if (this.cancelRequested.has(runId)) {
        const reason = this.cancelRequested.get(runId) ?? WORK_REASONS.cancelled
        await this.writeStep(stepId, 'cancelled', { runId, reason })
        await this.finishCancelled(runId, reason)
        return false
      }

      /**
       * A verdict that arrived after the deadline is not a verdict.
       *
       * The clock is re-checked as well as the race, because a verifier can win the
       * race microseconds before the timer fires — and because `now` is injected, so
       * it can be past the deadline while the timer has not been scheduled yet.
       *
       * Note what is *not* written: no `work.verification.completed` at all, and
       * certainly not a `passed` one. The verification is recorded as requested and
       * unanswered, which is what actually happened. Writing `failed` would be just
       * as much a fabrication — it would put a verdict in the audit trail that the
       * verifier never gave.
       */
      if (verification.kind === 'expired' || armed.fired() || this.now().getTime() >= deadlineAt) {
        return this.finishDeadline(runId, stepId, 'verification')
      }

      if (verification.kind === 'cancelled') {
        // Released by the owner rather than by the clock. The `cancelRequested`
        // branch above normally gets here first; this covers the reverse ordering.
        // No verdict is written, because none was ever given.
        const reason = this.cancelRequested.get(runId) ?? WORK_REASONS.cancelled
        await this.writeStep(stepId, 'cancelled', { runId, reason })
        await this.finishCancelled(runId, reason)
        return false
      }

      if (verification.kind === 'rejected') {
        // A verifier is trusted code, but its thrown diagnostic may still contain
        // provider text, local paths or secrets. Keep that diagnostic out of the
        // durable Work stream and record only the code-owned failure.
        await this.emit('work.verification.completed', {
          runId,
          stepId,
          verificationId,
          verdict: 'failed',
          reason: WORK_REASONS.verifierFailed,
        })
        await this.writeStep(stepId, 'failed', {
          runId,
          reason: WORK_REASONS.verifierFailed,
        })
        return true
      }

      const verdict = verification.verdict
      const durableReason =
        verdict.verdict === 'passed'
          ? WORK_REASONS.verificationPassed
          : WORK_REASONS.verificationFailed
      await this.emit('work.verification.completed', {
        runId,
        stepId,
        verificationId,
        verdict: verdict.verdict,
        reason: durableReason,
      })

      if (verdict.verdict === 'passed') {
        await this.writeStep(stepId, 'verified', { runId, attempt })
        return true
      }
      // Verifier reasons may be derived from the Step input or Observation. Those
      // values are intentionally non-durable, so the journal keeps only a fixed
      // conclusion instead of echoing the underlying content.
      await this.writeStep(stepId, 'failed', { runId, reason: durableReason })
      return true
    } finally {
      // Exactly once, on every path: success, failure, cancellation, the deadline,
      // or a throw from the verifier. A deadline timer that outlived its capability
      // would fire into a Run that had already settled.
      armed.clear()
      if (this.calling.get(runId) === armed) this.calling.delete(runId)
    }
  }

  /**
   * Arm this Run's duration ceiling for one capability call.
   *
   * Two things happen when it expires, in this order and both synchronously: the
   * reason is recorded, *then* the signal is aborted. Recording first means
   * anything that reacts to the abort — including the capability's own handler —
   * already finds why it was stopped, rather than having to infer it.
   */
  private armDeadline(
    runId: string,
    controller: AbortController,
    remainingMs: number,
  ): LiveCapabilityCall {
    let timer: ReturnType<typeof setTimeout> | undefined
    let fired = false
    let signalCancel!: () => void

    const expired = new Promise<'duration'>((resolve) => {
      timer = setTimeout(() => {
        fired = true
        this.deadlineHit.set(runId, this.now().getTime())
        controller.abort()
        resolve('duration')
      }, remainingMs)
      // A deadline is not a reason to keep a process alive. Without this an
      // application quitting inside a Run's window would be held open by a timer
      // whose only job is to stop work that is about to be abandoned anyway.
      ;(timer as { unref?: () => void }).unref?.()
    })

    /**
     * Resolved by `cancelRun`, so a capability or verifier that ignores its abort
     * cannot also swallow a cancellation. Never rejects, and never needs clearing:
     * an unresolved promise holds nothing.
     */
    const cancelled = new Promise<'cancelled'>((resolve) => {
      signalCancel = () => {
        resolve('cancelled')
      }
    })

    return {
      controller,
      expired,
      cancelled,
      signalCancel: () => {
        signalCancel()
      },
      fired: () => fired,
      clear: () => {
        if (timer === undefined) return
        clearTimeout(timer)
        timer = undefined
      },
    }
  }

  /**
   * Settle a Run whose duration ceiling expired mid-action.
   *
   * The Action settles as **failed**, not cancelled: the budget ran out, which is
   * not something anybody asked for, and writing `work.action.cancelled` here
   * would put a cancellation in the audit trail that never happened. The step
   * fails, every later step is skipped, and the Run fails with the ceiling as its
   * reason.
   *
   * `work.limits.exceeded` is written first so the ceiling is recorded even if a
   * later write is refused, and so a reader meets the cause before the effect.
   */
  private async finishDeadline(
    runId: string,
    stepId: string,
    phase: DeadlinePhase,
    action?: { actionId: string; attempt: number; elapsedMs: number },
  ): Promise<boolean> {
    const reason = limitReason('duration')
    await this.recordLimit(runId, 'duration')
    // Only a capability that overran has an action to settle. A verification that
    // overran comes after an action that completed, and that fact stays true.
    if (phase === 'capability' && action !== undefined) {
      await this.emit('work.action.failed', {
        runId,
        stepId,
        actionId: action.actionId,
        attempt: action.attempt,
        reason,
        durationMs: action.elapsedMs,
      })
    }
    return this.failStep(runId, stepId, reason)
  }

  /**
   * Park a Run behind an approval and stop.
   *
   * The gate is upstream of execution: this returns before `capability.execute`
   * is anywhere on the call path, so no ordering in this file can produce an
   * action that is approved afterwards. `test.consequential` performs no effect at
   * all, which is how a test can assert that no Action was recorded for it.
   *
   * `work.approval.requested` is itself the transition: it is the moment a Run and
   * its Step stop and begin waiting on a named decision, so one event carries one
   * fact rather than two events that could disagree.
   */
  private async requestApproval(
    runId: string,
    stepId: string,
    live: LivePlan,
    capability: WorkCapability,
    justification: string,
  ): Promise<boolean> {
    return this.serialise('approval:admission', async () => {
      // Admission is global because the ceiling is global. Without this queue,
      // two Runs can both observe 31 pending approvals and both create number 32.
      if (this.pendingApprovalCount() >= WORK_LIMITS.maxPendingApprovals) {
        return this.failStep(runId, stepId, 'too many approval requests are already open')
      }
      const approvalId = this.newId()
      let proposal: string
      try {
        proposal = capability.describe(this.capabilityRequest(runId, live, stepId))
      } catch {
        proposal = 'this capability would run'
        console.error('[freya.work] a capability could not describe itself')
      }

      const parked = await this.moveRun(runId, 'awaiting_approval', 'work.approval.requested', {
        approvalId,
        runId,
        stepId,
        capability: capability.name,
        requiredCapability: capability.capability,
        risk: capability.risk,
        principal: this.options.principalId,
        justification: this.bounded(justification),
        proposal: this.bounded(proposal),
      })
      if (parked) this.armApprovalExpiry(approvalId)
      return false
    })
  }

  private armApprovalExpiry(approvalId: string): void {
    const approval = this.work.approvals.get(approvalId)
    if (!approval || approval.status !== 'pending') {
      this.clearApprovalTimer(approvalId)
      return
    }
    this.approvalDeadlines.arm(
      approvalId,
      approval.requestedAt,
      WORK_LIMITS.approvalTtlMs,
      WORK_REASONS.approvalTimedOut,
    )
  }

  private clearApprovalTimer(approvalId: string): void {
    this.approvalDeadlines.clear(approvalId)
  }

  private expireApproval(approvalId: string, reason: string): Promise<boolean> {
    return this.serialise(`approval:${approvalId}`, () =>
      this.expireApprovalUnlocked(approvalId, reason),
    )
  }

  private async expireApprovalUnlocked(approvalId: string, reason: string): Promise<boolean> {
    this.clearApprovalTimer(approvalId)
    const approval = this.work.approvals.get(approvalId)
    if (!approval || approval.status !== 'pending') return false

    const bounded = this.bounded(reason) || WORK_REASONS.approvalTimedOut
    await this.emit('work.approval.expired', {
      approvalId,
      runId: approval.runId,
      stepId: approval.stepId,
      reason: bounded,
    })
    await this.writeStep(approval.stepId, 'failed', {
      runId: approval.runId,
      reason: WORK_REASONS.approvalTimedOut,
    })
    await this.skipRemaining(approval.runId, WORK_REASONS.approvalTimedOut)
    const moved = await this.moveRun(approval.runId, 'failed', 'work.run.failed', {
      runId: approval.runId,
      reason: WORK_REASONS.approvalTimedOut,
      stepCount: this.stepCount(approval.runId),
      verifiedCount: this.verifiedCount(approval.runId),
    })
    if (moved) {
      const run = this.work.runs.get(approval.runId)
      if (run?.taskId) await this.bumpTask(run.taskId, 'blocked')
    }
    this.options.onChange?.()
    return moved
  }

  /**
   * Whether this Step already holds a granted approval.
   *
   * Read from the durable record rather than remembered in a field: the grant is
   * the fact, and a decision nobody recorded is not a decision. Only `approved`
   * counts — a `denied`, `cancelled` or `expired` request leaves the gate shut,
   * which is what stops a stale board from re-running something it once said no to.
   *
   * `attempts === 0` is deliberate and is the "retries cannot bypass approval"
   * requirement rather than a detail: a grant authorises **one** attempt, so a
   * step that fails and retries must ask again rather than riding a decision made
   * about a different execution. The first grant stays in the journal either way.
   */
  private grantedApproval(step: { approvalId: string | null; attempts: number }): boolean {
    if (step.approvalId === null || step.attempts > 0) return false
    return this.work.approvals.get(step.approvalId)?.status === 'approved'
  }

  private capabilityRequest(runId: string, live: LivePlan, stepId: string): WorkCapabilityRequest {
    const step = this.work.steps.get(stepId)
    return {
      runId,
      stepId,
      stepKey: live.key,
      actionId: `${runId}:${stepId}:${(step?.attempts ?? 0) + 1}`,
      attempt: (step?.attempts ?? 0) + 1,
      input: live.input,
      correlationId: runId,
    }
  }

  /* -------------------------------------------------------------- outcomes */

  /**
   * Settle a Run's deadline record when it is no longer relevant.
   *
   * Called from the terminal paths so a finished Run cannot be reported as having
   * hit a ceiling it hit before it finished, and so the map cannot grow one entry
   * per Run for the life of the process.
   */
  private settleDeadline(runId: string): void {
    this.deadlineHit.delete(runId)
  }

  /**
   * Fail one step, and settle everything behind it.
   *
   * The skip is not tidiness: a terminal Run must have no unsettled Step, because a
   * step left `pending` on a failed run makes the board show work that is never
   * going to happen and a progress count that will never reach zero. The invariant
   * is what lets a renderer treat `status` as the only thing it has to read.
   */
  private async failStep(runId: string, stepId: string, reason: string): Promise<boolean> {
    const bounded = this.bounded(reason)
    await this.writeStep(stepId, 'failed', { runId, reason: bounded })
    const run = this.work.runs.get(runId)
    if (run && canTransitionRun(run.status, 'failed')) {
      await this.skipRemaining(runId, bounded)
      const moved = await this.moveRun(runId, 'failed', 'work.run.failed', {
        runId,
        reason: bounded,
        stepCount: this.stepCount(runId),
        verifiedCount: this.verifiedCount(runId),
      })
      if (moved && run.taskId) await this.bumpTask(run.taskId, 'blocked')
      this.settleDeadline(runId)
      return false
    }
    return true
  }

  /** Mark every unsettled later Step `skipped`, so nothing is left looking live. */
  private async skipRemaining(runId: string, reason: string): Promise<void> {
    for (const stepId of this.work.runSteps.get(runId) ?? []) {
      const step = this.work.steps.get(stepId)
      if (!step) continue
      if (step.status === 'verified' || step.status === 'cancelled' || step.status === 'skipped') continue
      if (step.status === 'pending' || step.status === 'ready') {
        await this.writeStep(stepId, 'skipped', { runId, reason: this.bounded(reason) })
      }
    }
  }

  /**
   * Settle a Run whose steps are all decided.
   *
   * `completed` requires every step to be `verified`. A Run with a failed step is
   * `failed` even when later steps were skipped around it, because "completed" is
   * a claim that the intended work was done and nothing here can support it.
   */
  private async finishRun(runId: string): Promise<void> {
    const run = this.work.runs.get(runId)
    if (!run || isTerminalRunStatus(run.status)) return

    const steps = (this.work.runSteps.get(runId) ?? [])
      .map((stepId) => this.work.steps.get(stepId))
      .filter((step): step is NonNullable<typeof step> => step !== undefined)

    const verifiedCount = steps.filter((step) => step.status === 'verified').length

    if (steps.length > 0 && verifiedCount === steps.length) {
      await this.moveRun(runId, 'completed', 'work.run.completed', {
        runId,
        stepCount: steps.length,
        verifiedCount,
      })
      if (run.taskId) await this.bumpTask(run.taskId, 'done')
      this.settleDeadline(runId)
      return
    }

    const failed = steps.find((step) => step.status === 'failed')
    if (failed) {
      await this.skipRemaining(runId, `step "${failed.key}" did not verify`)
      await this.moveRun(runId, 'failed', 'work.run.failed', {
        runId,
        reason: this.bounded(
          run.failure ?? failed.reason ?? `step "${failed.key}" ended as ${failed.status}`),
        stepCount: steps.length,
        verifiedCount,
      })
      if (run.taskId) await this.bumpTask(run.taskId, 'blocked')
      this.settleDeadline(runId)
      return
    }

    await this.moveRun(runId, 'failed', 'work.run.failed', {
      runId,
      reason: WORK_REASONS.noSteps,
      stepCount: steps.length,
      verifiedCount,
    })
  }

  private async bumpTask(taskId: string, status: TaskStatus): Promise<void> {
    const task = this.work.tasks.get(taskId)
    if (!task || task.status === status) return
    if (!TASK_TRANSITIONS[task.status].includes(status)) return
    await this.writeTask(taskId, status)
  }

  private async writeTask(taskId: string, status: TaskStatus): Promise<void> {
    const terminal = status === 'done' || status === 'cancelled'
    await this.emit(terminal ? 'work.task.completed' : 'work.task.updated', { taskId, status })
  }

  /* -------------------------------------------------------------- ceilings */

  /**
   * Which ceiling, if any, this Run has reached — checked *before* the action it
   * bounds.
   *
   * This is the mechanism behind "a Run cannot grow forever because a model keeps
   * requesting more work": a planner may propose as many steps as it likes, and a
   * Run stops at a number it did not choose.
   *
   * `deadlineHit` is checked as well as the clock, because the two can disagree:
   * the armed timer fires on real wall-clock time while `now` is injected, so a
   * frozen clock would otherwise let a Run walk straight past a ceiling that had
   * already expired. The record is the authority; the clock is the cheap check.
   */
  private exhaustedLimit(runId: string): LimitName | null {
    const run = this.work.runs.get(runId)
    if (!run) return null
    if (this.actionCount(runId) >= run.limits.maxActions) return 'actions'
    if (this.deadlineHit.has(runId)) return 'duration'
    if (run.startedAt && this.now().getTime() - Date.parse(run.startedAt) >= run.limits.maxDurationMs) {
      return 'duration'
    }
    return null
  }

  private async recordLimit(runId: string, limit: LimitName): Promise<void> {
    await this.emit('work.limits.exceeded', {
      runId,
      limit,
      reason: limitReason(limit),
      observed: this.actionCount(runId),
    })
  }

  /* ------------------------------------------------------------ validation */

  /** Everything wrong with a plan, or `null` when there is nothing wrong. */
  private validatePlan(plan: WorkRunPlan): string | null {
    return validateWorkPlan(plan, this.work.tasks, this.options.registry)
  }

  /** Clamp requested ceilings down to the absolute ones. Never up. */
  private resolveLimits(requested?: Partial<RunLimits>): RunLimits {
    return resolveWorkLimits(requested)
  }

  /* ------------------------------------------------------------ transitions */

  /**
   * Move a Run, or refuse.
   *
   * Every Run write in this file goes through here, which is what makes "code owns
   * state transitions" a property rather than a convention: there is no other
   * door. The per-Run queue around the read means two callers cannot both observe
   * `running` and both decide they may complete.
   *
   * `event` is the event that means this transition, not a generic "changed". An
   * audit reader is owed the difference between a run that was approved and
   * resumed and one that was merely resumed.
   */
  private async moveRun(
    runId: string,
    to: RunStatus,
    event: CoreEventType,
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    return this.serialise(runId, async () => {
      const run = this.work.runs.get(runId)
      if (!run) return false
      if (!canTransitionRun(run.status, to)) return false
      await this.emit(event, payload)
      return true
    })
  }

  /**
   * Write a Step's status, refusing an edge the table does not have.
   *
   * Serialised for the same reason `moveRun` is, and for the reason
   * `writeStep(stepId, 'cancelled', …)` must not race the `verified` a finishing
   * capability is about to write.
   */
  private async writeStep(
    stepId: string,
    to: 'ready' | 'running' | 'verified' | 'failed' | 'cancelled' | 'skipped' | 'awaiting_approval',
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    return this.serialise(stepId, async () => {
      const step = this.work.steps.get(stepId)
      if (!step) return false
      if (to === 'awaiting_approval') return true
      if (!canTransitionStep(step.status, to)) return false
      await this.emit(stepEventFor(to), { stepId, ...payload })
      return true
    })
  }

  /* ----------------------------------------------------------------- events */

  /**
   * Append one Work event.
   *
   * Journal failures are reported and swallowed, for the reason Brain does the
   * same: losing an event must not become a crash, and the state it described is
   * only visible through it. What must never happen is a write that looks like it
   * happened and did not, so this logs rather than pretending.
   */
  private async emit(type: CoreEventType, payload: Record<string, unknown>): Promise<void> {
    try {
      await this.options.fabric.append(type, payload as never, {
        actor: 'system',
        correlationId: typeof payload.runId === 'string' ? payload.runId : undefined,
      })
    } catch (error) {
      console.error('[freya.work] a Work event could not be recorded', error)
    }
  }

  private async recordGuardDenial(reason: string, capability: Capability): Promise<void> {
    await this.emit('guard.decision', {
      outcome: 'deny',
      reason: this.bounded(reason),
      capability,
      principal: this.options.principalId,
    })
  }

  /**
   * Serialise every mutating operation on one Run or Step.
   *
   * The queue never rejects, so one failed operation does not poison the ones
   * behind it — the same rule `EventFabric.enqueue` follows, and for the same
   * reason. This is what makes "two writers cannot both read `running`" true
   * without leaning on the fabric to do it for us: the fabric guarantees unique
   * sequences, not a correct decision.
   *
   * Deliberately *not* held across a capability call. Cancellation has to reach a
   * running capability, so the lock covers state writes only.
   */
  private serialise<T>(key: string, task: () => Promise<T>): Promise<T> {
    const tail = this.queues.get(key) ?? Promise.resolve()
    const result = tail.then(task, task)
    const settled = result.then(
      () => {},
      () => {},
    )
    this.queues.set(key, settled)
    void settled.then(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key)
    })
    return result
  }

  /* ----------------------------------------------------------------- detail */

  /** Bounded. Every sentence the engine shows a person goes through here. */
  private bounded(text: string): string {
    const trimmed = typeof text === 'string' ? text.trim() : ''
    return trimmed.length > WORK_LIMITS.maxReasonChars
      ? `${trimmed.slice(0, WORK_LIMITS.maxReasonChars)}…`
      : trimmed
  }

  private expired(requestedAt: string): boolean {
    return this.now().getTime() - Date.parse(requestedAt) >= WORK_LIMITS.approvalTtlMs
  }

  private statusOf(runId: string): RunStatus | undefined {
    return this.work.runs.get(runId)?.status
  }

  private stepCount(runId: string): number {
    return (this.work.runSteps.get(runId) ?? []).length
  }

  private verifiedCount(runId: string): number {
    return (this.work.runSteps.get(runId) ?? []).filter(
      (stepId) => this.work.steps.get(stepId)?.status === 'verified',
    ).length
  }

  private actionCount(runId: string): number {
    let count = 0
    for (const action of this.work.actions.values()) if (action.runId === runId) count += 1
    return count
  }

  private pendingApprovalCount(): number {
    let count = 0
    for (const approval of this.work.approvals.values()) if (approval.status === 'pending') count += 1
    return count
  }
}

/* ---------------------------------------------------------------- helpers */

/** Characters, not bytes: the only measurement of a body that leaves memory. */
function measure(data: Record<string, unknown>): number {
  try {
    return JSON.stringify(data)?.length ?? 0
  } catch {
    return 0
  }
}

function stepEventFor(
  to: 'ready' | 'running' | 'verified' | 'failed' | 'cancelled' | 'skipped',
): CoreEventType {
  switch (to) {
    case 'ready':
      return 'work.step.ready'
    case 'running':
      return 'work.step.started'
    case 'verified':
      return 'work.step.verified'
    case 'failed':
      return 'work.step.failed'
    case 'cancelled':
      return 'work.step.cancelled'
    case 'skipped':
      return 'work.step.skipped'
  }
}

/**
 * Coerce whatever a capability returned into a well-formed observation.
 *
 * A capability is code inside Core, so it is trusted to be *code* and not trusted
 * to be *well behaved*. This is the boundary that stops a missing summary or a
 * fabricated kind from becoming a journal event claiming something no capability
 * did.
 */
export function normaliseObservation(
  raw: WorkObservationContent | undefined,
  stepKey: string,
): WorkObservationContent {
  const kinds = ['result', 'exit', 'change', 'failure', 'input']
  const kind =
    raw && typeof raw.kind === 'string' && kinds.includes(raw.kind)
      ? (raw.kind as WorkObservationContent['kind'])
      : 'result'
  const summary =
    typeof raw?.summary === 'string' && raw.summary.trim().length > 0
      ? raw.summary.trim().slice(0, WORK_LIMITS.maxSummaryChars)
      : `the capability returned no summary for step "${stepKey}"`
  const data =
    raw && typeof raw.data === 'object' && raw.data !== null && !Array.isArray(raw.data) ? raw.data : {}
  return { kind, summary, data }
}

function limitReason(limit: LimitName): string {
  switch (limit) {
    case 'steps':
      return WORK_REASONS.limitSteps
    case 'actions':
      return WORK_REASONS.limitActions
    case 'duration':
      return WORK_REASONS.limitDuration
    case 'attempts':
      return WORK_REASONS.limitAttempts
  }
}
