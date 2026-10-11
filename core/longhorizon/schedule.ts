import { randomUUID } from 'node:crypto'
import type { EventFabric } from '../events/fabric'
import type { PrincipalId } from '../../shared/contracts/identity'
import {
  SCHEDULE_LIMITS,
  type GoalScheduleRecord,
  type ScheduleCommandOutcome,
  type ScheduleInput,
  type ScheduleProjection,
  type ScheduleTickResult,
} from './types'

/**
 * THE BOUNDED SCHEDULER.
 *
 * A deterministic, host-driven wake evaluation mechanism. The host calls
 * `attentionTick()`; there is no self-scheduling timer in Core, no background
 * loop, no polling. A schedule is a pure function of registered state, the
 * clock, and the condition ports.
 *
 * ## What a schedule is not
 *
 * - **Not a continuous timer.** No `setInterval`, no equivalent. The host
 *   drives evaluation.
 * - **Not a model call.** A schedule never reaches a provider. It evaluates
 *   conditions against already-authorized state.
 * - **Not a new wake source.** It produces wakes through the existing wake
 *   vocabulary (`longhorizon.wake.received`).
 * **Not a self-scheduling mechanism.** Core never schedules its own ticks.
 *
 * ## Fail-closed
 *
 * If STOP ALL is active, or the journal is not trustworthy, `attentionTick`
 * does nothing and returns an empty result. A schedule that cannot be
 * evaluated honestly is not evaluated.
 *
 * ## Idempotent
 *
 * Firing a schedule transitions it `pending → fired` and advances its due
 * time, so a second tick at the same clock observes a non-pending schedule
 * and produces nothing. Repeated ticks never produce duplicate events.
 *
 * ## No authority
 *
 * The scheduler holds no Guard, no Governor, no budget. It decides *whether a
 * wake is due*, never *whether the wake may act*. Every consequential action
 * flows through the existing authority paths.
 */

/* ------------------------------------------------------------------ store */

/**
 * The durable schedule store.
 *
 * A schedule is metadata (id, goal, condition, due time) and is stored apart
 * from the journal, like goal content. The journal holds the audit events
 * (`schedule.fired`, `schedule.expired`); the store holds the schedules
 * themselves. Neither can reconstruct the other.
 */
export interface GoalScheduleStore {
  readonly mode: 'encrypted' | 'ephemeral'
  readonly durable: boolean
  readonly faultReason: string | null
  write(record: GoalScheduleRecord): Promise<GoalScheduleRecord>
  read(scheduleId: string): Promise<GoalScheduleRecord | null>
  remove(scheduleId: string): Promise<boolean>
  list(): Promise<readonly GoalScheduleRecord[]>
  close(): Promise<void>
}

/** The ephemeral schedule store, for tests and machines with no secure storage. */
export class MemoryGoalScheduleStore implements GoalScheduleStore {
  readonly mode = 'ephemeral' as const
  readonly durable = false
  readonly faultReason: string | null

  private readonly records = new Map<string, GoalScheduleRecord>()
  private closed = false

  constructor(faultReason: string | null = null) {
    this.faultReason = faultReason
  }

  async write(record: GoalScheduleRecord): Promise<GoalScheduleRecord> {
    if (this.closed) throw new Error('the schedule store is closed')
    this.records.set(record.scheduleId, record)
    return record
  }

  async read(scheduleId: string): Promise<GoalScheduleRecord | null> {
    return this.records.get(scheduleId) ?? null
  }

  async remove(scheduleId: string): Promise<boolean> {
    if (this.closed) throw new Error('the schedule store is closed')
    return this.records.delete(scheduleId)
  }

  async list(): Promise<readonly GoalScheduleRecord[]> {
    return [...this.records.values()]
  }

  async close(): Promise<void> {
    this.closed = true
    this.records.clear()
  }
}

/* ----------------------------------------------------------------- engine */

export interface GoalSchedulerOptions {
  fabric: EventFabric
  store: GoalScheduleStore
  principalId: PrincipalId
  now?: () => Date
  newId?: () => string
  onChange?: () => void
  /** Live facts read at the moment of each decision, never copied into state. */
  stopAll?: () => boolean
  /** False when the journal failed recovery and cannot be replayed safely. */
  journalTrustworthy?: () => boolean
  /** Whether the owner is currently focused. `focus-available` reads this. */
  isFocused?: () => boolean
  /** Whether a goal is still open (not completed, failed, or cancelled). */
  isGoalOpen?: (goalId: string) => boolean
}

export class GoalScheduler {
  private schedules = new Map<string, GoalScheduleRecord>()
  private closed = false

  constructor(private readonly options: GoalSchedulerOptions) {}

  /* -------------------------------------------------------------- lifecycle */

  async open(): Promise<void> {
    const records = await this.options.store.list()
    this.schedules = new Map(records.map((record) => [record.scheduleId, record]))
    await this.reconcileAfterRecovery()
  }

  /**
   * Reconcile what a restart should have changed and what it must not.
   *
   * - **Expired schedules are settled.** A schedule past its lifetime is
   *   expired, not fired: the wall-clock bound is a wall, not a check between
   *   operations.
   * - **Nothing fires on restart.** A schedule that was due while the process
   *   was down does not fire during recovery; it fires on the next host-driven
   *   tick, if it is still due and its condition holds. Firing during recovery
   *   would be a silent continuation.
   */
  private async reconcileAfterRecovery(): Promise<void> {
    const now = this.now()
    for (const schedule of [...this.schedules.values()]) {
      if (schedule.state !== 'pending') continue
      const expiresAt = Date.parse(schedule.createdAt) + SCHEDULE_LIMITS.maxLifetimeMs
      if (now.getTime() >= expiresAt) {
        await this.expire(schedule.scheduleId, 'schedule-lifetime-reached')
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true
    await this.options.store.close()
  }

  /* -------------------------------------------------------------- commands */

  /**
   * Register a schedule.
   *
   * Bounded by the code-owned ceilings: at most `maxSchedules` at once, a
   * repeat count of at most `maxRepeats`, an interval of at least
   * `minIntervalMs`, and a due time no further ahead than `maxHorizonMs`. A
   * caller may narrow these and may never widen them.
   */
  async registerSchedule(input: ScheduleInput): Promise<ScheduleCommandOutcome> {
    if (this.closed) return this.refused('registered', 'the scheduler is shutting down')
    if (this.stopped()) return this.refused('registered', 'STOP ALL is active')

    const condition = input.condition ?? 'always'
    const maxRepeats = input.maxRepeats ?? 1
    const intervalMs = input.intervalMs ?? SCHEDULE_LIMITS.minIntervalMs

    if (!Number.isInteger(maxRepeats) || maxRepeats < 1 || maxRepeats > SCHEDULE_LIMITS.maxRepeats) {
      return this.refused('registered', `a schedule may repeat at most ${SCHEDULE_LIMITS.maxRepeats} times`)
    }
    if (!Number.isInteger(intervalMs) || intervalMs < SCHEDULE_LIMITS.minIntervalMs) {
      return this.refused('registered', `a schedule interval is at least ${SCHEDULE_LIMITS.minIntervalMs}ms`)
    }
    if (!Number.isInteger(input.delayMs) || input.delayMs < 0) {
      return this.refused('registered', 'a schedule delay must be a non-negative integer')
    }

    const now = this.now()
    const dueAt = new Date(now.getTime() + input.delayMs)
    if (input.delayMs > SCHEDULE_LIMITS.maxHorizonMs) {
      return this.refused('registered', 'the schedule is further ahead than the scheduler will hold')
    }

    const pending = [...this.schedules.values()].filter((s) => s.state === 'pending')
    if (pending.length >= SCHEDULE_LIMITS.maxSchedules) {
      return this.refused('registered', `the scheduler holds at most ${SCHEDULE_LIMITS.maxSchedules} schedules`)
    }

    const record: GoalScheduleRecord = {
      scheduleId: this.newId(),
      goalId: input.goalId ?? null,
      condition,
      dueAt: dueAt.toISOString(),
      state: 'pending',
      repeatCount: 0,
      maxRepeats,
      intervalMs,
      createdAt: now.toISOString(),
      lastFiredAt: null,
    }

    await this.options.store.write(record)
    this.schedules.set(record.scheduleId, record)
    this.onChange()
    return { operation: 'registered', ok: true, scheduleId: record.scheduleId }
  }

  async cancelSchedule(scheduleId: string): Promise<ScheduleCommandOutcome> {
    if (this.closed) return this.refused('cancelled', 'the scheduler is shutting down')
    const schedule = this.schedules.get(scheduleId)
    if (schedule === undefined) return this.refused('cancelled', 'no such schedule')
    if (schedule.state === 'cancelled') {
      return { operation: 'cancelled', ok: true, scheduleId }
    }
    if (schedule.state === 'expired') {
      return this.refused('cancelled', 'an expired schedule cannot be cancelled')
    }
    const cancelled: GoalScheduleRecord = { ...schedule, state: 'cancelled' }
    await this.options.store.write(cancelled)
    this.schedules.set(scheduleId, cancelled)
    this.onChange()
    return { operation: 'cancelled', ok: true, scheduleId }
  }

  /* ------------------------------------------------------------------ tick */

  /**
   * Evaluate due schedules. Host-driven: the host calls this, Core does not
   * schedule its own ticks.
   *
   * Fail-closed: STOP ALL or an untrustworthy journal produces an empty
   * result and appends nothing. Idempotent: firing advances the schedule's
   * state and due time, so a repeated tick at the same clock produces nothing.
   */
  async attentionTick(): Promise<ScheduleTickResult> {
    if (this.closed) return { fired: [], expired: [], denied: [], wakeIds: [] }
    if (this.stopped()) return { fired: [], expired: [], denied: [], wakeIds: [] }
    if (this.options.journalTrustworthy?.() === false) {
      return { fired: [], expired: [], denied: [], wakeIds: [] }
    }

    const now = this.now()
    const fired: string[] = []
    const expired: string[] = []
    const denied: string[] = []
    const wakeIds: string[] = []

    // Bounded: O(n) over pending schedules, never over all possible tasks.
    const due = [...this.schedules.values()]
      .filter((schedule) => schedule.state === 'pending')
      .filter((schedule) => Date.parse(schedule.dueAt) <= now.getTime())
      .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))

    for (const schedule of due) {
      const conditionHolds = this.evaluateCondition(schedule)
      if (!conditionHolds) {
        denied.push(schedule.scheduleId)
        continue
      }
      const wakeId = this.newId()
      await this.emit('longhorizon.schedule.fired', {
        scheduleId: schedule.scheduleId,
        goalId: schedule.goalId,
        wakeId,
      })
      await this.emit('longhorizon.wake.received', {
        wakeId,
        source: 'schedule',
        goalId: schedule.goalId,
      })
      wakeIds.push(wakeId)
      fired.push(schedule.scheduleId)
      await this.advance(schedule, now)
    }

    // Expire schedules whose lifetime has elapsed, even if they never fired.
    for (const schedule of [...this.schedules.values()]) {
      if (schedule.state !== 'pending') continue
      const expiresAt = Date.parse(schedule.createdAt) + SCHEDULE_LIMITS.maxLifetimeMs
      if (now.getTime() >= expiresAt) {
        await this.expire(schedule.scheduleId, 'schedule-lifetime-reached')
        expired.push(schedule.scheduleId)
      }
    }

    if (fired.length > 0 || expired.length > 0) this.onChange()
    return { fired, expired, denied, wakeIds }
  }

  /**
   * Evaluate a schedule's condition against already-authorized state.
   *
   * A condition never creates authority and never calls a model. It reads
   * live facts (focus) or durable state (goal-open) and returns a boolean.
   */
  private evaluateCondition(schedule: GoalScheduleRecord): boolean {
    switch (schedule.condition) {
      case 'always':
        return true
      case 'focus-available':
        // Fires when the owner is *not* focused. A missing focus port is
        // treated as "not focused" — the conservative reading, because a
        // schedule that cannot prove the owner is busy should not claim they
        // are free.
        return this.options.isFocused?.() !== true
      case 'goal-open': {
        if (schedule.goalId === null) return false
        return this.options.isGoalOpen?.(schedule.goalId) ?? false
      }
    }
  }

  /**
   * Advance a fired schedule: record the fire, then either repeat or expire.
   *
   * A repeating schedule with repeats remaining returns to `pending` with an
   * advanced due time. A schedule at its repeat ceiling expires. A one-shot
   * schedule expires.
   */
  private async advance(schedule: GoalScheduleRecord, now: Date): Promise<void> {
    const repeatCount = schedule.repeatCount + 1
    const lastFiredAt = now.toISOString()
    if (repeatCount >= schedule.maxRepeats) {
      const expired: GoalScheduleRecord = { ...schedule, state: 'expired', repeatCount, lastFiredAt }
      await this.options.store.write(expired)
      this.schedules.set(schedule.scheduleId, expired)
      return
    }
    const dueAt = new Date(now.getTime() + schedule.intervalMs).toISOString()
    const pending: GoalScheduleRecord = { ...schedule, state: 'pending', repeatCount, lastFiredAt, dueAt }
    await this.options.store.write(pending)
    this.schedules.set(schedule.scheduleId, pending)
  }

  private async expire(scheduleId: string, reason: string): Promise<void> {
    const schedule = this.schedules.get(scheduleId)
    if (schedule === undefined || schedule.state !== 'pending') return
    const expired: GoalScheduleRecord = { ...schedule, state: 'expired' }
    await this.options.store.write(expired)
    this.schedules.set(scheduleId, expired)
    await this.emit('longhorizon.schedule.expired', {
      scheduleId: schedule.scheduleId,
      goalId: schedule.goalId,
      reason,
    })
  }

  /* ----------------------------------------------------------------- reads */

  projection(): ScheduleProjection {
    const schedules = [...this.schedules.values()]
    return {
      schedules,
      counts: {
        total: schedules.length,
        pending: schedules.filter((s) => s.state === 'pending').length,
        fired: schedules.filter((s) => s.state === 'fired').length,
        expired: schedules.filter((s) => s.state === 'expired').length,
        cancelled: schedules.filter((s) => s.state === 'cancelled').length,
      },
      limits: SCHEDULE_LIMITS,
    }
  }

  state(): ReadonlyMap<string, GoalScheduleRecord> {
    return this.schedules
  }

  /* -------------------------------------------------------------- internal */

  private async emit(type: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await this.options.fabric.append(type as never, payload as never, {
        actor: this.options.principalId,
      })
    } catch (error) {
      console.error('[freya.core] a schedule event could not be recorded', this.describe(error))
    }
  }

  private stopped(): boolean {
    return this.options.stopAll?.() ?? false
  }

  private refused(operation: ScheduleCommandOutcome['operation'], reason: string): ScheduleCommandOutcome {
    return { operation, ok: false, reason }
  }

  private onChange(): void {
    this.options.onChange?.()
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
}
