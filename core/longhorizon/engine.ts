import { randomUUID } from 'node:crypto'
import type { EventFabric } from '../events/fabric'
import type { PrincipalId } from '../protocol/core-protocol'
import { reduceGoalState, initialGoalState } from './state'
import type { GoalStore } from './store'
import {
  DEFAULT_GOAL_LIMITS,
  GOAL_REASONS,
  canTransitionGoal,
  isTerminalGoalStatus,
  normaliseGoalContent,
  type GoalAction,
  type GoalCommandOutcome,
  type GoalContent,
  type GoalContentInput,
  type GoalDetail,
  type GoalLimits,
  type GoalProjection,
  type GoalReason,
  type GoalRecord,
  type GoalState,
  type GoalStatus,
  type GoalVerificationContext,
  type GoalVerifier,
} from './types'

/**
 * THE GOAL ENGINE.
 *
 * Holds a goal aggregate: an outcome, the checkpoints attempted toward it, and
 * the rules for when it may start another checkpoint and when it may be declared
 * achieved.
 *
 * It does **not** own execution. A checkpoint, a verification and a wake belong
 * to the long-horizon continuation subsystem, and this engine reaches them only
 * through the narrow ports below. That is what stops the two aggregates collapsing
 * into each other.
 *
 * ## Serialisation, not luck
 *
 * Every state-changing operation on a given goal runs inside a per-goal queue,
 * and the terminal-transition check happens **inside** that queue rather than
 * before it. So a cancel racing a completion verifier cannot interleave: one of
 * them observes a terminal state and refuses. Nothing here depends on which call
 * happens to start first.
 *
 * ## Zero idle inference
 *
 * Nothing in this file contacts a provider. Completion asks a verifier, and the
 * verifier is deterministic. A goal that is created, activated, paused, resumed,
 * cancelled or merely listed costs nothing, and an idle Freya spends nothing.
 *
 * ## No authority
 *
 * The goal engine holds no Guard, no Governor, no budget and no approval
 * workflow. It cannot grant cognition, widen a capability, clear STOP ALL or
 * approve its own requests. Every consequential action flows through the existing
 * authority paths — the goal engine only decides *what to do next*, never *whether
 * it may*.
 */

/** What the engine needs from the continuation subsystem, and nothing more. */
export interface ContinuationPort {
  /** Verify a checkpoint. Resolves to the verification outcome. */
  verifyCheckpoint(
    goalId: string,
    checkpointId: string,
    signal: AbortSignal,
  ): Promise<{ established: boolean; reason: GoalReason }>
}

export interface GoalEngineOptions {
  fabric: EventFabric
  store: GoalStore
  continuation: ContinuationPort
  /**
   * The principal that owns goals.
   *
   * Baked in by Core and never taken from a command payload, for the same reason
   * `cognition.grant.created` records the owner regardless of what the payload
   * claims: a caller must not be able to say who they are.
   */
  principalId: PrincipalId
  now?: () => Date
  newId?: () => string
  onChange?: () => void
  /** Live facts read at the moment of each decision, never copied into state. */
  stopAll?: () => boolean
}

/** How long shutdown waits for an in-flight verification to settle. */
const CLOSE_DRAIN_MS = 1_000

export class GoalEngine {
  private goalState: GoalState = initialGoalState()
  private readonly locks = new Map<string, Promise<unknown>>()
  /** Goals with a verification in flight. Guards duplicate requests. */
  private readonly verifying = new Set<string>()
  private readonly inflight = new Set<Promise<unknown>>()
  private closed = false

  constructor(private readonly options: GoalEngineOptions) {}

  /* -------------------------------------------------------------- lifecycle */

  async open(): Promise<void> {
    this.goalState = await this.options.fabric.replay(initialGoalState(), (draft, event) =>
      reduceGoalState(draft, event),
    )
    // Live appends fold through the *same* reducer as replay, so the state a
    // window sees cannot drift from the state a restart would rebuild.
    this.dispose = this.options.fabric.subscribe((event) => {
      this.goalState = reduceGoalState(this.goalState, event)
    })
    await this.reconcileAfterRecovery()
  }

  private dispose: () => void = () => {}

  /**
   * Reconcile what a restart should have changed and what it must not.
   *
   * - **Expired goals are settled.** The lifetime is a wall, not a check between
   *   operations, so an expired goal is discovered here rather than watched.
   * - **Nothing is resumed.** A goal that was `active` when the process died is
   *   moved to `paused`, because "it was running" is not proof that it finished.
   * - **In-progress checkpoints are failed.** A checkpoint that was being
   *   verified when the process died is marked `failed` with
   *   `restart_interrupted`. It was interrupted; claiming otherwise would be a
   *   fabricated outcome.
   * - **A `verification.requested` record is left as `requested`.** Resolving it
   *   as `timeout` on the next start would be honest; resolving it as `passed`
   *   would be a fabricated outcome, and that is the one thing this file will not
   *   do.
   *
   * This is asynchronous because it writes events, but it is awaited from `open`,
   * so a goal's expiry is visible before any projection is served.
   */
  private async reconcileAfterRecovery(): Promise<void> {
    const now = this.options.now?.() ?? new Date()
    const expired = [...this.goalState.goals.values()].filter(
      (goal) =>
        !isTerminalGoalStatus(goal.state) &&
        Date.parse(now.toISOString()) >= Date.parse(goal.deadlineAt),
    )
    // Serialised like any other transition, so a reconcile cannot race a command
    // that arrived between `open` and this loop.
    await Promise.all(
      expired.map((goal) => this.settle(goal.goalId, 'failed', GOAL_REASONS.deadline_expired)),
    )

    // A checkpoint that was in flight when the process died is failed, not
    // verified. "It was running" is not proof that it finished, and a checkpoint
    // that reports verified without a verifier having said so is exactly the
    // fabricated outcome the restart-continuity spec forbids.
    const interruptedCheckpoints = [...this.goalState.checkpoints.values()].filter(
      (checkpoint) => checkpoint.status === 'in-progress',
    )
    await Promise.all(
      interruptedCheckpoints.map((checkpoint) =>
        this.emit('longhorizon.checkpoint.failed', {
          goalId: checkpoint.goalId,
          checkpointId: checkpoint.checkpointId,
          reason: GOAL_REASONS.restart_interrupted,
          attempts: checkpoint.attempts,
        }),
      ),
    )

    // A goal that was active when the process died is paused, not resumed.
    // "It was running" is not proof that it finished, and silently resuming a
    // goal that was interrupted is exactly the fabricated-continuation failure
    // mode the restart-continuity spec forbids.
    const interrupted = [...this.goalState.goals.values()].filter((goal) => goal.state === 'active')
    await Promise.all(
      interrupted.map((goal) => this.pause(goal.goalId, GOAL_REASONS.recovery)),
    )
  }

  async close(): Promise<void> {
    this.closed = true
    this.dispose()
    // Wait for in-flight verifications to settle, bounded by CLOSE_DRAIN_MS.
    if (this.inflight.size > 0) {
      await Promise.race([
        Promise.allSettled(this.inflight),
        new Promise((resolve) => setTimeout(resolve, CLOSE_DRAIN_MS)),
      ])
    }
    await this.options.store.close()
  }

  /* -------------------------------------------------------------- commands */

  async createGoal(input: GoalContentInput): Promise<GoalCommandOutcome> {
    if (this.stopped()) return this.refused('create', 'STOP ALL is active')
    const normalised = normaliseGoalContent(input)
    if (!normalised.ok) return this.refused('create', normalised.reason)

    const goalId = this.newId()
    const now = this.nowIso()
    const content: GoalContent = {
      goalId,
      ...normalised.value,
      createdAt: now,
    }

    try {
      await this.options.store.write(content)
    } catch (error) {
      return this.refused('create', this.describe(error))
    }

    const deadlineAt = new Date(this.now().getTime() + DEFAULT_GOAL_LIMITS.lifetimeMs).toISOString()
    await this.emit('longhorizon.goal.created', {
      goalId,
      state: 'draft',
      createdAt: now,
      deadlineAt,
      dependencies: [],
      limits: DEFAULT_GOAL_LIMITS,
    })

    this.onChange()
    return { operation: 'created', ok: true, goalId, state: 'draft' }
  }

  async activateGoal(goalId: string): Promise<GoalCommandOutcome> {
    return this.transition(goalId, 'draft', 'active', GOAL_REASONS.owner, 'activated')
  }

  async pauseGoal(goalId: string, reason: GoalReason = GOAL_REASONS.owner): Promise<GoalCommandOutcome> {
    return this.transition(goalId, 'active', 'paused', reason, 'paused')
  }

  async resumeGoal(goalId: string): Promise<GoalCommandOutcome> {
    return this.transition(goalId, 'paused', 'active', GOAL_REASONS.owner, 'resumed')
  }

  async cancelGoal(goalId: string): Promise<GoalCommandOutcome> {
    return this.transition(goalId, null, 'cancelled', GOAL_REASONS.owner, 'cancelled')
  }

  async failGoal(goalId: string, reason: GoalReason): Promise<GoalCommandOutcome> {
    return this.transition(goalId, null, 'failed', reason, 'settled-failed')
  }

  /**
   * Complete a goal.
   *
   * This is not a status setter. A goal completes only when every checkpoint has
   * been verified — the same invariant the reducer enforces on replay, enforced
   * here so a live command cannot manufacture an outcome the journal would refuse to
   * fold. A goal with no checkpoints at all cannot complete: there is nothing
   * that could have been verified.
   */
  async completeGoal(goalId: string): Promise<GoalCommandOutcome> {
    return this.lock(goalId, async () => {
      const goal = this.goalState.goals.get(goalId)
      if (goal === undefined) return this.refused('verification-passed', 'no such goal')
      if (isTerminalGoalStatus(goal.state)) {
        return this.refused('verification-passed', `a ${goal.state} goal cannot transition`)
      }
      if (goal.state !== 'active') {
        return this.refused('verification-passed', `a ${goal.state} goal cannot complete`)
      }
      if (goal.checkpoints.length === 0) {
        return this.refused('verification-passed', 'a goal with no checkpoints cannot complete')
      }
      if (goal.verifiedCheckpoints < goal.checkpoints.length) {
        return this.refused('verification-passed', 'not every checkpoint has been verified')
      }
      await this.emit('longhorizon.goal.state-changed', {
        goalId,
        from: goal.state,
        to: 'completed',
        reason: GOAL_REASONS.verification_passed,
      })
      this.onChange()
      return { operation: 'verification-passed', ok: true, goalId, state: 'completed' }
    })
  }

  /* -------------------------------------------------------------- internal */

  private async transition(
    goalId: string,
    from: GoalStatus | null,
    to: GoalStatus,
    reason: GoalReason,
    operation: GoalCommandOutcome['operation'],
  ): Promise<GoalCommandOutcome> {
    if (this.stopped()) return this.refused(operation, 'STOP ALL is active')

    return this.lock(goalId, async () => {
      const goal = this.goalState.goals.get(goalId)
      if (goal === undefined) return this.refused(operation, 'no such goal')
      if (isTerminalGoalStatus(goal.state)) {
        return this.refused(operation, `a ${goal.state} goal cannot transition`)
      }
      // `from` is pinned, exactly as the transition table is: `activate` is the
      // draft→active edge and `resume` is the paused→active edge, and a caller
      // reaching for `activate` on a paused goal is asking for a resume under a
      // different name. Pinning here is what keeps the two commands from being
      // the same command with two names.
      if (from !== null && goal.state !== from) {
        return this.refused(operation, `a ${goal.state} goal is not ${from}`)
      }
      if (!canTransitionGoal(goal.state, to)) {
        return this.refused(operation, `cannot transition from ${goal.state} to ${to}`)
      }

      await this.emit('longhorizon.goal.state-changed', {
        goalId,
        from: goal.state,
        to,
        reason,
      })

      this.onChange()
      return { operation, ok: true, goalId, state: to }
    })
  }

  private async settle(goalId: string, to: 'failed' | 'cancelled', reason: GoalReason): Promise<void> {
    await this.lock(goalId, async () => {
      const goal = this.goalState.goals.get(goalId)
      if (goal === undefined || isTerminalGoalStatus(goal.state)) return
      if (!canTransitionGoal(goal.state, to)) return
      await this.emit('longhorizon.goal.state-changed', {
        goalId,
        from: goal.state,
        to,
        reason,
      })
      this.onChange()
    })
  }

  private async pause(goalId: string, reason: GoalReason): Promise<void> {
    await this.lock(goalId, async () => {
      const goal = this.goalState.goals.get(goalId)
      if (goal === undefined || goal.state !== 'active') return
      await this.emit('longhorizon.goal.state-changed', {
        goalId,
        from: goal.state,
        to: 'paused',
        reason,
      })
      this.onChange()
    })
  }

  private async emit(type: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await this.options.fabric.append(type as never, payload as never, {
        actor: this.options.principalId,
      })
    } catch (error) {
      console.error('[freya.core] a goal event could not be recorded', this.describe(error))
    }
  }

  private lock<T>(goalId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(goalId) ?? Promise.resolve()
    const result = previous.then(task, task)
    this.locks.set(goalId, result.then(() => undefined, () => undefined))
    this.inflight.add(result)
    result.then(
      () => this.inflight.delete(result),
      () => this.inflight.delete(result),
    )
    return result
  }

  private stopped(): boolean {
    return this.options.stopAll?.() ?? false
  }

  private refused(operation: GoalCommandOutcome['operation'], reason: string): GoalCommandOutcome {
    return { operation, ok: false, reason }
  }

  private onChange(): void {
    this.options.onChange?.()
  }

  private nowIso(): string {
    return this.now().toISOString()
  }

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }

  private newId(): string {
    return this.options.newId?.() ?? randomUUID()
  }

  private describe(error: unknown): string {
    if (error instanceof Error) return error.message
    return String(error)
  }

  /* ----------------------------------------------------------------- reads */

  projection(): GoalProjection {
    const goals = [...this.goalState.goals.values()]
    const retained = goals.slice(-DEFAULT_GOAL_LIMITS.maxRetainedGoals)
    return {
      persistence: {
        mode: this.options.store.mode,
        reason: this.options.store.faultReason,
        durable: this.options.store.durable,
      },
      goals: retained.map((goal) => this.summarise(goal)),
      counts: {
        total: goals.length,
        draft: goals.filter((g) => g.state === 'draft').length,
        active: goals.filter((g) => g.state === 'active').length,
        paused: goals.filter((g) => g.state === 'paused').length,
        completed: goals.filter((g) => g.state === 'completed').length,
        failed: goals.filter((g) => g.state === 'failed').length,
        cancelled: goals.filter((g) => g.state === 'cancelled').length,
        needsAttention: goals.filter((g) => this.summarise(g).needsAttention).length,
      },
      limits: DEFAULT_GOAL_LIMITS,
      goalsRetained: retained.length,
      goalsTotal: goals.length,
      goalsHidden: goals.length - retained.length,
      sequence: this.goalState.sequence,
    }
  }

  private summarise(goal: GoalRecord): GoalProjection['goals'][number] {
    const checkpoints = goal.checkpoints
      .map((id) => this.goalState.checkpoints.get(id))
      .filter((c): c is NonNullable<typeof c> => c !== undefined)
    const counts = {
      total: checkpoints.length,
      pending: checkpoints.filter((c) => c.status === 'pending').length,
      inProgress: checkpoints.filter((c) => c.status === 'in-progress').length,
      verified: checkpoints.filter((c) => c.status === 'verified').length,
      failed: checkpoints.filter((c) => c.status === 'failed').length,
    }
    return {
      goalId: goal.goalId,
      state: goal.state,
      createdAt: goal.createdAt,
      deadlineAt: goal.deadlineAt,
      settledAt: goal.settledAt,
      reason: goal.reason,
      counts,
      needsAttention: counts.failed > 0 || goal.state === 'failed',
      availableActions: this.availableActions(goal.state),
      verification: goal.verification
        ? { state: goal.verification.state, verifierId: goal.verification.verifierId }
        : null,
    }
  }

  private availableActions(state: GoalStatus): GoalAction[] {
    switch (state) {
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

  async detail(goalId: string): Promise<GoalDetail | null> {
    const goal = this.goalState.goals.get(goalId)
    if (goal === undefined) return null
    const content = await this.options.store.read(goalId)
    return {
      ...this.summarise(goal),
      content: content.ok ? content.value : null,
      contentReason: content.ok ? null : content.reason,
    }
  }

  state(): GoalState {
    return this.goalState
  }
}
