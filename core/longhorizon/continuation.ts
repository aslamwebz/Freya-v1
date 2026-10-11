import { randomUUID } from 'node:crypto'
import type { EventFabric } from '../events/fabric'
import type { PrincipalId } from '../../shared/contracts/identity'
import {
  CONTINUATION_STATES,
  DEFAULT_GOAL_LIMITS,
  type ContinuationDecision,
  type ContinuationState,
  type GoalStatus,
} from './types'

/**
 * THE LONG-HORIZON CONTINUATION STATE MACHINE.
 *
 * This is what the subsystem is *doing*, distinct from what a goal *is*. A goal
 * is `active` (durable state owned by the goal engine); the subsystem is
 * `CHECKPOINT` (what it is doing right now toward that goal). The two are
 * deliberately separate so the act of pursuing a goal cannot move the goal's
 * state, and a goal's state cannot move the subsystem.
 *
 * ## States
 *
 * - `IDLE` — no active long-horizon goal.
 * - `GOAL_ACTIVE` — a goal is being pursued.
 * - `CHECKPOINT` — a checkpoint is being verified.
 * - `GOAL_PAUSED` — a goal is paused.
 * - `GOAL_COMPLETE` — a goal is complete (terminal).
 * - `GOAL_FAILED` — a goal has failed (terminal).
 *
 * ## Decisions
 *
 * Every decision is journaled (`longhorizon.continuation.decided`) and carries
 * a reason. A decision is data: it cannot move a goal, grant authority, or
 * bypass Guard. The goal engine executes the decision through its own state
 * machine.
 *
 * ## Every wait is bounded
 *
 * A `wait` decision names the instant at which it stops being valid, and the
 * subsystem must decide again from that point on. `ContinuationDecision` makes
 * `deadline` required on `wait`, so a decision that waits without saying how
 * long cannot be written at all — and "wait until something happens" is exactly
 * the open-ended wait this subsystem must not be able to record, because nothing
 * here has a timer that could ever end it. The deadline is derived from a bound
 * that already exists in the domain:
 *
 * - **Waiting behind an in-flight verification** takes `verificationDeadlineMs`
 *   from `DEFAULT_GOAL_LIMITS` — the same bound the verifier is raced against. A
 *   wait cannot usefully outlast the thing it waits for: at that instant the
 *   checkpoint is `timeout` and the wait must be re-decided.
 * - **Every other wait** (the engine is closing, STOP ALL is latched, the wake
 *   names no goal, the goal is not open) is bounded at `now`. None of those can
 *   change on a clock — they change on a shutdown, an owner clearing the latch,
 *   or another wake — so a future instant would promise a re-examination this
 *   subsystem has no mechanism to perform. A wait that defers nothing expires
 *   immediately, and is re-decided by the next wake.
 *
 * ## No model call
 *
 * Nothing here contacts a provider. A continuation decision is a pure function
 * of durable goal state, the clock, and the wake that triggered it.
 *
 * ## No authority
 *
 * The continuation engine holds no Guard, no Governor, no budget. It decides
 * *what to do next*, never *whether it may*.
 */

/** What the continuation engine needs from the goal engine, and nothing more. */
export interface GoalTruthPort {
  /** Whether a goal is still open (not completed, failed, or cancelled). */
  isGoalOpen(goalId: string): boolean
  /** The goal's current state. */
  goalState(goalId: string): GoalStatus | null
  /** The goal's verified checkpoint count. */
  verifiedCheckpoints(goalId: string): number
  /** The goal's total checkpoint count. */
  totalCheckpoints(goalId: string): number
  /** The goal's retry count for the current checkpoint. */
  retryCount(goalId: string): number
  /** Whether the goal's budget is exhausted. */
  isBudgetExhausted?(goalId: string): boolean
  /** Whether the goal has eligible milestones or checkpoints ready to pursue. */
  hasEligibleMilestone?(goalId: string): boolean
}

export const CONTINUATION_WAKE_CAUSES = [
  'scheduled_review',
  'external_event',
  'approval_granted',
  'prerequisite_finished',
  'restart_recovery',
] as const

export type ContinuationWakeCause = (typeof CONTINUATION_WAKE_CAUSES)[number]

export function isContinuationWakeCause(value: unknown): value is ContinuationWakeCause {
  return typeof value === 'string' && (CONTINUATION_WAKE_CAUSES as readonly string[]).includes(value as ContinuationWakeCause)
}

/** A wake as the continuation engine receives it. */
export interface ContinuationWake {
  readonly wakeId: string
  readonly source: string
  readonly goalId: string | null
  readonly cause?: ContinuationWakeCause | string
  readonly authorized?: boolean
}

export interface ContinuationEngineOptions {
  fabric: EventFabric
  goals: GoalTruthPort
  principalId: PrincipalId
  now?: () => Date
  newId?: () => string
  onChange?: () => void
  stopAll?: () => boolean
}

export interface ContinuationDecisionOutcome {
  readonly decision: ContinuationDecision
  readonly goalId: string | null
}

export class ContinuationEngine {
  private state: ContinuationState = 'IDLE'
  private activeGoalId: string | null = null
  private closed = false

  constructor(private readonly options: ContinuationEngineOptions) {}

  /* -------------------------------------------------------------- lifecycle */

  async open(): Promise<void> {
    // The continuation state is in-memory by design: it is what the subsystem
    // is doing *right now*, and a restart begins from IDLE. The durable facts
    // are the journal events and the goal state, both owned elsewhere.
    this.state = 'IDLE'
    this.activeGoalId = null
  }

  async close(): Promise<void> {
    this.closed = true
  }

  /* ----------------------------------------------------------------- wakes */

  /**
   * Handle a wake.
   *
   * A wake is the only thing that moves the continuation state machine. There
   * is no timer, no polling, no background evaluation: the subsystem acts when
   * a wake arrives, and idles between wakes.
   *
   * The decision is journaled before it is returned, so a decision is auditable
   * rather than invisible.
   */
  async handleWake(wake: ContinuationWake): Promise<ContinuationDecisionOutcome> {
    if (this.closed) return this.idleDecision('the continuation engine is shutting down')
    if (this.stopped()) return this.idleDecision('STOP ALL is active')

    // Refuse unauthorized or spurious wake sources (model hallucinations)
    if (wake.authorized === false) {
      return this.decide(this.expiresNow('wait', 'unauthorized wake source rejected'), wake.goalId)
    }

    if (wake.cause !== undefined && !isContinuationWakeCause(wake.cause)) {
      return this.decide(
        this.expiresNow('wait', `unregistered wake cause rejected: ${String(wake.cause)}`),
        wake.goalId,
      )
    }

    // A wake with no goal reference is an idle wake: it asks whether anything
    // needs doing, and the honest answer from IDLE is "wait".
    if (wake.goalId === null) {
      return this.decide(this.expiresNow('wait', 'no goal is referenced by this wake'), null)
    }

    const goalId = wake.goalId
    if (!this.options.goals.isGoalOpen(goalId)) {
      return this.decide(this.expiresNow('wait', 'the goal is not open'), goalId)
    }

    // Budget hierarchy check
    if (this.options.goals.isBudgetExhausted?.(goalId)) {
      return this.decide({ decision: 'pause', reason: 'budget_exhausted' }, goalId)
    }

    const status = this.options.goals.goalState(goalId)
    if (status === 'paused') {
      return this.decide({ decision: 'pause', reason: 'the goal is paused' }, goalId)
    }

    const hasEligible = this.options.goals.hasEligibleMilestone?.(goalId) ?? false
    const verified = this.options.goals.verifiedCheckpoints(goalId)
    const total = this.options.goals.totalCheckpoints(goalId)

    if (!hasEligible && total > 0 && verified >= total) {
      return this.decide({ decision: 'complete', reason: 'every checkpoint has been verified' }, goalId)
    }

    if (this.state === 'CHECKPOINT') {
      // The one wait that is bounded by something other than the current instant:
      // see the module note on wait deadlines.
      return this.decide(
        {
          decision: 'wait',
          reason: 'a checkpoint is already being verified',
          deadline: this.clockAfter(DEFAULT_GOAL_LIMITS.verificationDeadlineMs),
        },
        goalId,
      )
    }

    // If milestone checks are active, verify prerequisite readiness
    if (this.options.goals.hasEligibleMilestone && !hasEligible) {
      return this.decide(
        this.expiresNow('wait', 'waiting on milestone dependencies or external conditions'),
        goalId,
      )
    }

    const reason = wake.cause
      ? `the goal is open and eligible on cause: ${wake.cause}`
      : 'the goal is open and has unverified checkpoints'

    return this.decide({ decision: 'continue', reason }, goalId)
  }

  /**
   * Record that a checkpoint is being verified.
   *
   * Moves the subsystem to `CHECKPOINT`. This is the only transition the
   * continuation engine makes on its own; every other transition is a
   * consequence of a decision.
   */
  beginCheckpoint(goalId: string): void {
    if (this.closed || this.stopped()) return
    this.state = 'CHECKPOINT'
    this.activeGoalId = goalId
    this.onChange()
  }

  /**
   * Settle the current checkpoint and move the subsystem.
   *
   * - `passed` → `GOAL_ACTIVE` (continue toward the next checkpoint).
   * - `failed` → `GOAL_PAUSED` (the goal engine decides retry or fail).
   */
  settleCheckpoint(goalId: string, passed: boolean): void {
    if (this.closed) return
    this.state = passed ? 'GOAL_ACTIVE' : 'GOAL_PAUSED'
    this.activeGoalId = goalId
    this.onChange()
  }

  /* -------------------------------------------------------------- internal */

  private async decide(
    decision: ContinuationDecision,
    goalId: string | null,
  ): Promise<ContinuationDecisionOutcome> {
    if (decision.decision === 'continue' && goalId !== null) {
      this.state = 'GOAL_ACTIVE'
      this.activeGoalId = goalId
    } else if (decision.decision === 'pause') {
      this.state = 'GOAL_PAUSED'
    } else if (decision.decision === 'complete') {
      this.state = 'GOAL_COMPLETE'
    } else if (decision.decision === 'fail') {
      this.state = 'GOAL_FAILED'
    }

    await this.emit('longhorizon.continuation.decided', {
      goalId,
      decision: decision.decision,
      reason: decision.reason,
    })
    this.onChange()
    return { decision, goalId }
  }

  /**
   * A wait that defers nothing, and so expires at the current instant.
   *
   * Used for the waits whose condition no clock can change — see the module note
   * on wait deadlines.
   */
  private expiresNow(decision: 'wait', reason: string): ContinuationDecision {
    return { decision, reason, deadline: this.clockNow() }
  }

  private idleDecision(reason: string): ContinuationDecisionOutcome {
    return { decision: this.expiresNow('wait', reason), goalId: null }
  }

  private clockNow(): string {
    return this.options.now?.().toISOString() ?? new Date().toISOString()
  }

  private clockAfter(ms: number): string {
    return new Date(Date.parse(this.clockNow()) + ms).toISOString()
  }

  private async emit(type: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await this.options.fabric.append(type as never, payload as never, {
        actor: this.options.principalId,
      })
    } catch (error) {
      console.error('[freya.core] a continuation event could not be recorded', this.describe(error))
    }
  }

  private stopped(): boolean {
    return this.options.stopAll?.() ?? false
  }

  private onChange(): void {
    this.options.onChange?.()
  }

  private describe(error: unknown): string {
    if (error instanceof Error) return error.message
    return String(error)
  }

  /* ----------------------------------------------------------------- reads */

  currentState(): ContinuationState {
    return this.state
  }

  stateName(): ContinuationState {
    return this.state
  }

  activeGoal(): string | null {
    return this.activeGoalId
  }

  static states(): readonly ContinuationState[] {
    return CONTINUATION_STATES
  }

  newId(): string {
    return this.options.newId?.() ?? randomUUID()
  }
}
