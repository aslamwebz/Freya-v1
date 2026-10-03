import { randomUUID } from 'node:crypto'
import type { EventFabric } from '../events/fabric'
import type { PrincipalId } from '../protocol/core-protocol'
import {
  CONTINUATION_STATES,
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
}

/** A wake as the continuation engine receives it. */
export interface ContinuationWake {
  readonly wakeId: string
  readonly source: string
  readonly goalId: string | null
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

    // A wake with no goal reference is an idle wake: it asks whether anything
    // needs doing, and the honest answer from IDLE is "wait".
    if (wake.goalId === null) {
      return this.decide('wait', null, 'no goal is referenced by this wake')
    }

    const goalId = wake.goalId
    if (!this.options.goals.isGoalOpen(goalId)) {
      return this.decide('wait', goalId, 'the goal is not open')
    }

    const status = this.options.goals.goalState(goalId)
    if (status === 'paused') {
      return this.decide('pause', goalId, 'the goal is paused')
    }

    const verified = this.options.goals.verifiedCheckpoints(goalId)
    const total = this.options.goals.totalCheckpoints(goalId)

    if (total > 0 && verified >= total) {
      return this.decide('complete', goalId, 'every checkpoint has been verified')
    }

    if (this.state === 'CHECKPOINT') {
      return this.decide('wait', goalId, 'a checkpoint is already being verified')
    }

    return this.decide('continue', goalId, 'the goal is open and has unverified checkpoints')
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
    decision: ContinuationDecision['decision'],
    goalId: string | null,
    reason: string,
    deadline?: string,
  ): Promise<ContinuationDecisionOutcome> {
    const resolved: ContinuationDecision =
      decision === 'wait' && deadline !== undefined
        ? { decision, reason, deadline }
        : { decision, reason }

    if (decision === 'continue' && goalId !== null) {
      this.state = 'GOAL_ACTIVE'
      this.activeGoalId = goalId
    } else if (decision === 'pause') {
      this.state = 'GOAL_PAUSED'
    } else if (decision === 'complete') {
      this.state = 'GOAL_COMPLETE'
    } else if (decision === 'fail') {
      this.state = 'GOAL_FAILED'
    }

    await this.emit('longhorizon.continuation.decided', {
      goalId,
      decision: resolved.decision,
      reason: resolved.reason,
    })
    this.onChange()
    return { decision: resolved, goalId }
  }

  private idleDecision(reason: string): ContinuationDecisionOutcome {
    return { decision: { decision: 'wait', reason }, goalId: null }
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
