import {
  LATCHED_STOP_CODE,
  isEscalating,
  type DecideOutcome,
  type FocusState,
  type LifeLoopCloseOutCode,
  type LifeLoopDecision,
  type LifeLoopEventType,
  type LifeLoopLimitRequest,
  type LifeLoopLimits,
  type LifeLoopStatus,
  type OwnerEscalation,
  type RecoveryReport,
  type WakeEvent,
  type WakeRefusalCode,
  type WakeValidationOutcome,
} from './types'
import { evaluatePreCognition, type LifeLoopProgress } from './prefilter'
import { resolveEscalation } from './decide'
import { describeRecovery, recoverLifeLoop } from './recovery'
import {
  enforceDeadline,
  isExpired,
  narrowLifeLoopLimits,
  nextRetry,
  remainingMs,
  resolveDeadline,
} from './deadlines'
import { interrupt } from './machine'
import { validateWake, wakeDedupeKey } from './wake'
import {
  initialLifeLoopState,
  projectLifeLoopStatus,
  reduceLifeLoopEntry,
  reduceLifeLoopState,
  retryCeilingFor,
  type FoldAnomaly,
  type LifeLoopJournalEntry,
  type LifeLoopState,
} from './state'
import {
  analyseZeroIdleInference,
  type ZeroIdleInferenceReport,
} from './assertions'
import {
  LIFE_LOOP_VERIFICATION_KINDS,
  type LifeLoopPorts,
  type LifeLoopVerificationKind,
  type LifeLoopWakeRequest,
} from './ports'

/**
 * The Continuous Life Loop, wired.
 *
 * This is the only file in Phase 23 that touches the outside world, and it is
 * written so that the sentence "an idle Freya spends nothing" can be read off the
 * control flow rather than believed. Four properties do the work:
 *
 * 1. **A wake cannot call a model.** `considerWake` validates, journals and
 *    transitions. The only call site of `ports.requestCognition` is inside
 *    `actOnce`, which is reachable only from `iterate`, which is reachable only
 *    after `evaluatePreCognition` returned `allow`. So a wake that the prefilter
 *    refuses costs a journal entry and nothing else.
 *
 * 2. **There is no timer here.** The runtime never schedules anything. It is
 *    driven by three things Core already had: an authoritative event, the host's
 *    existing bounded tick, and its own `open()`. A self-scheduling heartbeat
 *    would keep running on a stopped Freya and would be the shape of the very
 *    runaway this phase exists to forbid.
 *
 * 3. **One step at a time.** Every entry point serialises onto a single promise
 *    chain, so there is never a second continuation stacked on the first. The loop
 *    is single-threaded by construction rather than by a lock.
 *
 * 4. **Its state is the journal.** `this.state` is derived, entry by entry, by the
 *    same fold a cold replay uses. Nothing here holds a fact the journal does not,
 *    which is what makes "no hidden durable state" a property rather than a claim.
 */

export interface LifeLoopRuntimeOptions {
  readonly ports: LifeLoopPorts
  /** Only ever narrows the frozen ceilings. A raise is clamped, not applied. */
  readonly limits?: LifeLoopLimitRequest
}

/** What happened to one wake. Closed, because a caller branches on it. */
export type LifeLoopWakeOutcome =
  | { readonly outcome: 'accepted'; readonly wakeId: string }
  | {
      readonly outcome: 'deferred'
      readonly wakeId: string
      readonly code: string
      /** The instant the hold lifts, or null when nothing is being held. */
      readonly deadline: string | null
    }
  | { readonly outcome: 'refused'; readonly code: WakeRefusalCode | string; readonly reason: string }
  /** The loop was busy or latched, so nothing was attempted. */
  | { readonly outcome: 'busy'; readonly reason: string }
  | { readonly outcome: 'closed'; readonly reason: string }

export interface LifeLoopSnapshot {
  readonly status: LifeLoopStatus
  readonly recovery: RecoveryReport | null
  readonly anomalies: readonly FoldAnomaly[]
  readonly limits: LifeLoopLimits
  readonly enabled: boolean
  /**
   * Wakes the registry has refused since this process opened.
   *
   * Session state, and labelled as such — exactly like Core's `startedAt`. The
   * durable per-wake refusal is folded and journaled; this is the running count a
   * surface shows next to it, and it is documented as resetting on restart rather
   * than quietly implying it does not.
   */
  readonly refusedWakes: number
  /** The eight zero-idle-inference checks, and when they were last run. */
  readonly assertions: ZeroIdleInferenceReport | null
  readonly auditedAt: string | null
}

/**
 * The deterministic jitter sample.
 *
 * Derived from the wake id and the attempt number rather than drawn from a random
 * source, which keeps the whole runtime a function of the journal: two runs over
 * one journal produce the same backoff. It is still jitter, because the id differs
 * per attempt and two loops retrying the same work do not back off in lockstep.
 */
function jitterFor(wakeId: string, attempt: number, ceiling: { readonly jitterMs: number }): number {
  let hash = 0x811c9dc5
  const material = `${wakeId}:${attempt}`
  for (let index = 0; index < material.length; index += 1) {
    hash ^= material.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % (ceiling.jitterMs + 1)
}

function plusMs(instant: string, ms: number): string {
  const base = Date.parse(instant)
  return new Date((Number.isFinite(base) ? base : 0) + ms).toISOString()
}

export class LifeLoopRuntime {
  private readonly ports: LifeLoopPorts
  private readonly limits: LifeLoopLimits

  private state: LifeLoopState = initialLifeLoopState()
  private anomalies: readonly FoldAnomaly[] = []
  private recovery: RecoveryReport | null = null

  /**
   * Serialisation chain.
   *
   * Every public method enqueues and returns. It never rejects: a step that throws
   * is journalled as a failure and the loop is closed out, because an exception
   * escaping into Core's event subscription would take the journal writer with it.
   */
  private tail: Promise<unknown> = Promise.resolve()

  /**
   * Set while a step is between an `await` and its journal write.
   *
   * The owner pre-empting lands here: the pre-emption itself is journalled
   * immediately, and the abandoned work discovers on its way back that its result
   * is no longer wanted, rather than writing it over the top of the owner's turn.
   */
  private preempted = false

private opened = false
  private closed = false
  private refusedWakes = 0
  private assertions: ZeroIdleInferenceReport | null = null
  private auditedAt: string | null = null

  constructor(options: LifeLoopRuntimeOptions) {
    this.ports = options.ports
    this.limits = narrowLifeLoopLimits(options.limits)
  }

  /* ------------------------------------------------------------- lifecycle */

  /**
   * Read the journal, recover, and be ready for wakes.
   *
   * Called from Core's `start()` and nowhere else. Recovery is journalled rather
   * than merely applied, and that is the whole point of the method: a loop that
   * reconciled itself in memory would look recovered until the next restart, when
   * it would do it again and tell a different story each time.
   */
  async open(): Promise<RecoveryReport> {
    if (this.opened) {
      return this.recovery ?? recoverLifeLoop({ state: this.state, now: this.ports.now(), stopAllActive: this.ports.stopAllActive() })
    }
    this.opened = true
    return await this.enqueue(async () => {
      const entries = await this.ports.replay()
      const fold = reduceLifeLoopState(entries)
      this.state = fold.state
      this.anomalies = fold.anomalies

const report = await this.reconcile()
      this.recovery = report
      // The boot audit, over everything the journal already holds. It is a
      // whole-journal scan, so it happens exactly once here rather than on a read a
      // renderer could call repeatedly.
      await this.audit(entries)
      this.ports.onChange()
      return report
    })
  }

  /**
   * Reconcile whatever the journal says with what can still be true.
   *
   * The decision is the domain's (`recoverLifeLoop`), and this method's only job is
   * to make it durable and to refuse to fake it. Three cases, and the third is the
   * one that matters:
   *
   *   - a wait whose absolute deadline has not passed is *preserved*, re-armed with
   *     the same instant rather than a fresh one, because a relative wait is
   *     extended by every restart;
   *   - anything else returns to `IDLE` and is re-evaluated on a genuinely new
   *     wake, because a process that died mid-action cannot prove the action
   *     finished;
   *   - and STOP ALL is refused before any of that, because a restart is not the
   *     owner clearing a latch.
   */
  private async reconcile(): Promise<RecoveryReport> {
    const now = this.ports.now()
    const stopAll = this.ports.stopAllActive()
    const report = recoverLifeLoop({ state: this.state, now, stopAllActive: stopAll })

    if (stopAll && this.state.state !== 'STOP') {
      await this.journal('lifeloop.stopped', {
        wakeId: this.state.wake?.wakeId ?? '',
        iteration: this.state.iterationCount,
        code: LATCHED_STOP_CODE,
      })
      return report
    }
    if (report.recoveredState === this.state.state) return report

    if (report.recoveredState === 'STOP') {
      // An interrupted action or verification. Journalled as itself so the reason
      // the loop is stopped is legible without the report in hand.
      const code = report.actions[0]?.code === 'interrupted-verification-stopped'
        ? 'interrupted-verification-stopped'
        : 'interrupted-action-stopped'
      await this.journal('lifeloop.stopped', {
        wakeId: this.state.wake?.wakeId ?? '',
        iteration: this.state.iterationCount,
        code,
      })
      return report
    }

    const preserved = report.recoveredState === 'WAIT' ? report.residualDeadline : null
    await this.journal('lifeloop.reconciled', {
      code: 'restart-recovery',
      from: this.state.state,
      wakeId: this.state.wake?.wakeId ?? '',
      iteration: this.state.iterationCount,
      deadlineType: preserved === null ? null : preserved.type,
      deadlineExpiresAt: preserved === null ? null : preserved.expiresAt,
    })
    return report
  }

  /**
   * Stop taking work. The in-flight step finishes its current `await` and then
   * writes nothing more.
   *
   * No journal entry: shutdown is not a fact about the loop's continuation, it is
   * a fact about the process, and the next `open()` reconciles from the journal
   * without needing to be told that this one existed.
   */
  async close(): Promise<void> {
    this.closed = true
    await this.enqueue(async () => {
      this.ports.onChange()
    })
  }

  /* --------------------------------------------------------------- reading */

  status(): LifeLoopStatus {
    return projectLifeLoopStatus(this.state)
  }

snapshot(): LifeLoopSnapshot {
    return {
      status: projectLifeLoopStatus(this.state),
      recovery: this.recovery,
      anomalies: this.anomalies,
      limits: this.limits,
      enabled: this.ports.enabled(),
      refusedWakes: this.refusedWakes,
      assertions: this.assertions,
      auditedAt: this.auditedAt,
    }
  }

  /**
   * Re-run the eight zero-idle-inference checks over the journal.
   *
   * Not part of a read: it is a whole-journal scan, and a read that did it would be
   * unbounded work on a path a renderer can call. It runs once when the loop opens
   * — the boot audit, which is where a promise about money belongs — and is exposed
   * here so the release gate and the red-team suite can ask for a fresh verdict
   * rather than trusting the one from boot.
   */
  async audit(entries?: readonly LifeLoopJournalEntry[]): Promise<ZeroIdleInferenceReport> {
    const journal = entries ?? (await this.ports.replay())
    const report = analyseZeroIdleInference({ entries: journal, limits: this.limits })
    this.assertions = report
    this.auditedAt = this.ports.now()
    return report
  }

  /** The folded state, for tests and for the projection. Never a mutable handle. */
  folded(): LifeLoopState {
    return this.state
  }

  /* ------------------------------------------------------------- interrupts */

  /**
   * STOP ALL. Reaches every state, including an idle one.
   *
   * Journalled rather than merely latched, because the latch in Core is the real
   * one and this has to be able to survive a restart without it: the gate is
   * closed synchronously in the same turn as the owner's decision, and this is the
   * record that the loop heard about it.
   */
  async stop(): Promise<void> {
    await this.enqueue(async () => {
      if (this.closed || this.state.state === 'STOP') return
      this.preempted = true
      const outcome = interrupt(this.state.state, 'stop-all')
      if (!outcome.applied) return
      await this.journal('lifeloop.stopped', {
        wakeId: this.state.wake?.wakeId ?? '',
        iteration: this.state.iterationCount,
        code: LATCHED_STOP_CODE,
      })
      this.ports.onChange()
    })
  }

  /**
   * The owner cleared the latch.
   *
   * The only lift that exists. There is no path here reachable from a wake, a
   * deadline, a retry or a failure, which is why the fold's `lifeloop.unstopped`
   * demands that there was a stop to lift: an entry that arrives while the loop is
   * running is recorded as tampering rather than quietly freeing it.
   */
  async lift(): Promise<void> {
    await this.enqueue(async () => {
      if (this.closed || this.state.state !== 'STOP') return
      await this.journal('lifeloop.unstopped', { code: 'stop-latch-cleared' })
      this.ports.onChange()
    })
  }

  /**
   * The owner spoke, and the owner comes first.
   *
   * Pre-emption rather than refusal: the work in hand is abandoned rather than
   * completed, and the loop is reconciled back to a state that will accept the
   * owner's own wake. Crucially the attempt count survives — being interrupted is
   * not a way to buy a fresh retry allowance for work that has already failed.
   */
  async preemptByOwner(): Promise<void> {
    await this.enqueue(async () => {
      if (this.closed) return
      const outcome = interrupt(this.state.state, 'owner-command')
      if (!outcome.applied) return
      this.preempted = true
      if (this.state.state === 'STOP' || this.state.state === 'DENY') return
      await this.journal('lifeloop.reconciled', {
        code: 'owner-preempted',
        from: this.state.state,
        wakeId: this.state.wake?.wakeId ?? '',
        iteration: this.state.iterationCount,
        deadlineType: null,
        deadlineExpiresAt: null,
      })
      this.ports.onChange()
    })
  }

  /* ------------------------------------------------------------------ wake */

  /**
   * Offer a wake. Core raises them; this decides whether one is honoured.
   *
   * The actor has already been attributed by Core and arrives as a parameter, so
   * this cannot be told which source a wake claims to be from — only to check the
   * attribution against the closed table. A renderer, a model, an agent, a
   * connector, an external webhook and a self-scheduling timer are unauthorized for
   * every source, so "no renderer may drive the loop" is a table.
   *
   * Nothing in this method reaches a model. The most it can do is journal a refusal.
   */
async considerWake(request: LifeLoopWakeRequest): Promise<LifeLoopWakeOutcome> {
    return await this.enqueue(() => this.considerWakeNow(request))
  }

  /**
   * The wake itself, on the queue.
   *
   * Split out from {@link considerWake} for one reason: `tick` calls this directly,
   * because it is *already* on the queue and an `enqueue` from inside an enqueued
   * task would wait behind itself for ever. That is not a theoretical hazard — it is
   * a deadlock, and it is the reason the split exists rather than being tidied away.
   *
   * Nothing here reaches a model. The most this can do is journal a refusal.
   */
  private async considerWakeNow(request: LifeLoopWakeRequest): Promise<LifeLoopWakeOutcome> {
    if (this.closed) return { outcome: 'closed', reason: 'the life loop has been shut down' }
    const now = this.ports.now()
    const wakeId = this.ports.newId()
    const candidate = {
      wakeId,
      source: request.source,
      kind: request.kind,
      goalRef: request.goalRef,
      sourceRef: request.sourceRef,
      occurredAt: request.occurredAt,
      observedAt: now,
    }

    const validation: WakeValidationOutcome = validateWake(candidate, {
      actor: request.actor,
      now,
      stopAllActive: this.ports.stopAllActive(),
      journalTrustworthy: this.ports.journalTrustworthy(),
      loopState: this.state.state,
      schedules: this.ports.schedules(),
      conditionHolds: (scheduleId) => this.ports.conditionHolds(scheduleId),
      processedWakeKeys: this.state.processedWakeKeys,
    })

    if (validation.outcome === 'denied') {
      this.refusedWakes += 1
      await this.journal('lifeloop.wake.denied', {
        wakeId,
        source: request.source,
        code: validation.code,
        iteration: this.state.iterationCount,
      })
      this.ports.onChange()
      return { outcome: 'refused', code: validation.code, reason: validation.reason }
    }

    // The two deferrals are not the same fact, and the difference is the deadline.
    //
    // A schedule that is **not due** has a real future instant to wait for, so the
    // loop parks on it and the next tick finds the deadline already passed. A
    // schedule that **is due but whose condition is unmet** has no such instant —
    // the registry hands back a `dueAt` that is behind us, and parking on it would
    // mean a wait that expires the instant it was created and then a fresh refusal
    // on every tick after that.
    //
    // So the unmet case is recorded and nothing is held: the refusal is journaled,
    // the loop stays exactly where it was, and the next tick offers the schedule
    // again. Bounded by the tick, which is the bound that already exists, and it
    // spends nothing — a schedule nobody has asked a question about is not a reason
    // to think.
    if (validation.outcome === 'deferred' && validation.code === 'heartbeat-condition-unmet') {
      this.refusedWakes += 1
      await this.journal('lifeloop.wake.denied', {
        wakeId,
        source: request.source,
        code: validation.code,
        iteration: this.state.iterationCount,
      })
      this.ports.onChange()
      return { outcome: 'deferred', wakeId, code: validation.code, deadline: null }
    }

    await this.acceptWake(validation.wake, validation.wakeKey, this.state.iterationCount)

    if (validation.outcome === 'deferred') {
      // Journaled under the loop's own name rather than the registry's, because the
      // journal is read by the loop's own recovery and by a person, and neither
      // should have to translate.
      await this.park('schedule-not-due', validation.deadline)
      this.ports.onChange()
      return {
        outcome: 'deferred',
        wakeId,
        code: validation.code,
        deadline: validation.deadline,
      }
    }

    await this.iterate()
    this.ports.onChange()
    return { outcome: 'accepted', wakeId }
  }

  /**
   * The bounded heartbeat.
   *
   * Two jobs and no others: expire a deadline that has passed, and offer at most
   * one due schedule to the registry. It performs no model call, contacts no
   * provider and appends nothing for a schedule that is not due — which is the same
   * contract `Core.attentionTick` already has, and the reason the host needed no
   * new timer to drive this.
   *
   * One wake per tick, not one per due schedule: the loop is single-threaded, so
   * offering the second would be refused `loop-busy` and would journal a refusal
   * for no reason. The rest wait for the next tick, which is the bound.
   */
  async tick(): Promise<number> {
    return await this.enqueue(async () => {
      if (this.closed || this.state.state === 'STOP') return 0
      const now = this.ports.now()
      let fired = 0

      // (1) A held deadline that has passed. Checked before anything new is
      //     offered, because a deadline is the loop's own promise about when it
      //     would stop waiting and it is not kept by asking a fresh question.
      const held = this.state.deadline
      if (held !== null && isExpired(held, now)) {
        const enforcement = enforceDeadline(held, now)
        await this.expireHeld(enforcement.code ?? 'deadline-expired')
        fired += 1
      }

      // (2) At most one due schedule.
      if (this.state.state === 'IDLE' || this.state.state === 'WAIT') {
        if (await this.offerOneDueSchedule(now)) fired += 1
      }
      if (fired > 0) this.ports.onChange()
      return fired
    })
  }

  /**
   * How long the held wait has left, in whole milliseconds. Zero when there is no
   * wait, and never negative — so a caller cannot reach a wait that has run out.
   */
  residualWait(now: string): number {
    if (this.state.deadline === null) return 0
    return remainingMs(this.state.deadline, now)
  }

  /** The one-line summary of the last recovery, safe to journal or to display. */
  describeRecovery(): string | null {
    return this.recovery === null ? null : describeRecovery(this.recovery)
  }

  /* ------------------------------------------------------------ the private */

  /**
   * Journal one event and fold it in.
   *
   * Durable first, and the fold second, from the same record. That ordering is why
   * the loop cannot hold a state the journal does not support: if the append
   * throws, nothing is folded and the next `open()` will reach the same conclusion
   * from the log.
   */
  private async journal(type: LifeLoopEventType, payload: Readonly<Record<string, string | number | boolean | null>>): Promise<void> {
    const recordedAt = this.ports.now()
    await this.ports.append(type, payload)
    const folded = reduceLifeLoopEntry(this.state, { type, recordedAt, payload: { ...payload } }, {
      // Read fresh, never cached: the only transition in this module that an outside
      // party would want to reach is the lift of a stop, and it is gated on the
      // owner's latch being clear at the moment the entry is folded rather than on
      // anything the loop holds.
      ownerClearedStop: !this.ports.stopAllActive(),
    })
    this.state = folded.state
    if (folded.anomalies.length > 0) {
      this.anomalies = [...this.anomalies, ...folded.anomalies]
    }
  }

  /** Serialise, and never let a throw escape into Core. */
  private async enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task)
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    try {
      return await run
    } catch (error) {
      // A step that failed is a step that is over. Recording the refusal keeps the
      // journal honest and leaves the loop reachable rather than wedged behind a
      // rejected chain.
      this.anomalies = [
        ...this.anomalies,
        {
          code: 'illegal-transition',
          eventType: 'lifeloop.step',
          detail: `a step of the loop threw and was abandoned: ${error instanceof Error ? error.message : 'unknown'}`,
        },
      ]
      await this.abandonAfterThrow()
      this.ports.onChange()
      return undefined as T
    }
  }

  /**
   * Put the loop somewhere a wake can be accepted after a thrown step.
   *
   * Only ever a reconciliation, and only from a state the fold will accept one
   * from. An exception in the middle of an iteration must not leave the loop
   * permanently `WAKING`, because a `WAKING` loop refuses every wake as busy and
   * would never wake again.
   */
  private async abandonAfterThrow(): Promise<void> {
    if (this.closed) return
    if (this.state.state === 'STOP') return
    if (this.state.state === 'IDLE' || this.state.state === 'WAIT') return
    try {
      await this.journal('lifeloop.reconciled', {
        code: 'restart-recovery',
        from: this.state.state,
        wakeId: this.state.wake?.wakeId ?? '',
        iteration: this.state.iterationCount,
        deadlineType: null,
        deadlineExpiresAt: null,
      })
    } catch {
      // The journal itself is failing. There is nowhere left to record this, and
      // pretending otherwise would be worse than the silence: the next `open()`
      // reconciles from whatever did reach disk, which is the honest answer.
    }
  }

  /**
   * Move into `WAKING` and record the wake flat, exactly as the fold expects.
   *
   * `iteration` is **zero-based**, and that is not cosmetic: the prefilter refuses a
   * new iteration once `iterationCount` has reached `maxLoopIterations`, so a
   * one-based counter would refuse the very last permitted iteration and make the
   * ceiling one smaller than the number it names — and narrowing it to `1` would
   * leave the loop unable to think at all. Zero-based, `maxLoopIterations` permits
   * exactly `maxLoopIterations` iterations, which is what the limits table says.
   */
  private async acceptWake(wake: WakeEvent, wakeKey: string, iteration: number): Promise<void> {
    this.preempted = false
    await this.journal('lifeloop.wake.received', {
      wakeId: wake.wakeId,
      source: wake.source,
      kind: wake.kind,
      wakeKey,
      iteration,
      goalRef: wake.goalRef,
      sourceRef: wake.sourceRef,
      occurredAt: wake.occurredAt,
      observedAt: wake.observedAt,
    })
  }

  /**
   * One pass of the loop: prefilter, then — only if it allowed — one bounded
   * thought, one bounded action and one verification.
   *
   * The recursion at the bottom is the *only* way this method calls itself, it
   * carries a decreasing budget, and it is guarded by a ceiling the prefilter
   * checks before anything is spent. There is no loop here and no timer, so the
   * structural scan has nothing to find.
   */
  private async iterate(): Promise<void> {
    const wake = this.state.wake
    if (wake === null) return
    const now = this.ports.now()
    const iterationStartedAt = now

    const verdict = evaluatePreCognition({
      wake,
      now,
      progress: this.progress(iterationStartedAt),
      authority: this.authority('do-nothing'),
      limits: this.limits,
    })

    if (verdict.outcome === 'deny') {
      await this.journal('lifeloop.filter.denied', {
        wakeId: wake.wakeId,
        wakeKey: this.state.wakeKey ?? '',
        outcome: 'deny',
        code: verdict.code,
        deadlineType: null,

        deadlineExpiresAt: null,

        iteration: this.state.iterationCount,
      })
      await this.closeOut('closed-out')
      return
    }
    if (verdict.outcome === 'wait') {
      await this.park('cooldown-active', verdict.deadline)
      return
    }

    await this.journal('lifeloop.filter.passed', {
      wakeId: wake.wakeId,
      wakeKey: this.state.wakeKey ?? '',
      code: verdict.code,
      iteration: this.state.iterationCount,
    })

    await this.actOnce(wake, iterationStartedAt)
  }

  /** The loop's own progress, read from the fold rather than from memory. */
  private progress(iterationStartedAt: string): LifeLoopProgress {
    return {
      state: this.state.state,
      iterationCount: this.state.iterationCount,
      actionCount: this.state.actionCount,
      verificationCount: this.state.verificationCount,
      cognitionRequestCount: this.state.cognitionRequestCount,
      iterationStartedAt,
      attemptCount: this.state.attemptCount,
      pendingScheduleCount: this.ports.schedules().length,
    }
  }

  /**
   * The already-authorized facts, every one of them a callback rather than a value.
   *
   * `cooldownUntil` is derived from the *journaled* deadline rather than held in
   * memory, which is the reason a restart cannot buy a fresh retry budget: the
   * hold the loop is in is a record, not a variable.
   */
  private authority(requestedOutcome: DecideOutcome): {
    readonly stopAllActive: boolean
    readonly journalTrustworthy: boolean
    readonly enabled: boolean
    readonly grantAvailable: boolean
    readonly budgetRemainingCalls: number
    readonly cooldownUntil: string | null
    readonly focus: FocusState
    readonly requestedOutcome: DecideOutcome
  } {
    const now = this.ports.now()
    return {
      stopAllActive: this.ports.stopAllActive(),
      journalTrustworthy: this.ports.journalTrustworthy(),
      enabled: this.ports.enabled(),
      grantAvailable: this.ports.grantAvailable(now),
      budgetRemainingCalls: this.ports.budgetRemainingCalls(now),
      cooldownUntil:
        this.state.state === 'WAIT' && this.state.deadline !== null
          ? this.state.deadline.expiresAt
          : null,
      focus: this.ports.focus(),
      requestedOutcome,
    }
  }

  /**
   * One bounded thought, one bounded action, one verification.
   *
   * Four gates stand between here and a provider, and all four have already been
   * passed to reach this line: the registry accepted the wake, the state machine
   * moved to `ALLOW`, the prefilter returned `allow`, and the Governor will still
   * decide. What is left is the loop's own work, which is exactly one thought.
   */
  private async actOnce(wake: WakeEvent, iterationStartedAt: string): Promise<void> {
    const cognitionRequestId = this.ports.newId()
    await this.journal('lifeloop.cognition.requested', {
      wakeId: wake.wakeId,
      wakeKey: this.state.wakeKey ?? '',
      iteration: this.state.iterationCount,
      cognitionRequest: cognitionRequestId,
    })

    const outcome = await this.ports.requestCognition({
      wakeId: wake.wakeId,
      wakeKey: this.state.wakeKey ?? '',
      iteration: this.state.iterationCount,
      prompt: this.promptFor(wake),
      maxOutputTokens: this.limits.maxPayloadTextLength,
      question: 'decide',
    })

    if (this.preempted) return
    if (this.ports.stopAllActive()) {
      await this.stop()
      return
    }

    if (outcome.status !== 'decided') {
      await this.journal('lifeloop.cognition.denied', {
        wakeId: wake.wakeId,
        wakeKey: this.state.wakeKey ?? '',
        code: outcome.status === 'refused' ? outcome.code : outcome.code,
        iteration: this.state.iterationCount,
      })
      await this.closeOut('closed-out')
      return
    }

    // From here the loop has a conclusion, and the only gate left is focus.
    //
    // The prefilter has already run, but it could not have seen this outcome: at
    // the time it ran, the loop had concluded nothing, so `requestedOutcome` was
    // `do-nothing` and there was no interrupt for focus to suppress. Now there is,
    // and a suppressed interrupt is *journaled* rather than left for a reader to
    // infer — which is the difference between "Freya decided not to interrupt" and
    // "Freya was told not to". They are different facts about a human being.
    const escalation = resolveEscalation(
      outcome.outcome,
      this.ports.focus(),
      this.ports.stopAllActive(),
    )
    if (escalation.suppressed && escalation.code === 'focus-suppressed-interrupt') {
      // Journalled as a *cognition* denial rather than a filter denial, and that is a
      // state-machine requirement rather than a naming preference: the loop is in
      // `ALLOW` here, and `ALLOW` leaves only by `cognition-allowed` or
      // `cognition-denied`. There is no `filter-denied` edge out of `ALLOW` —
      // correctly, because the filter already ran and allowed it. What is denied is
      // the *thought*, and by the time this is known the filter is not what stopped
      // it. Folding it as a filter denial would record the loop's own move as
      // tampering and leave it wedged in `ALLOW`.
      await this.journal('lifeloop.cognition.denied', {
        wakeId: wake.wakeId,
        wakeKey: this.state.wakeKey ?? '',
        code: 'focus-blocks-escalation',
        iteration: this.state.iterationCount,
      })
      await this.closeOut('closed-out')
      return
    }

    if (this.ports.escalationApprovalRequired(escalation.escalation)) {
      await this.parkForApproval(wake, escalation.escalation)
      return
    }

    const planned = this.plan(outcome.outcome, escalation.escalation)
    await this.journal('lifeloop.action.started', {
      wakeId: wake.wakeId,
      iteration: this.state.iterationCount,
      actionIndex: this.state.actionCount + 1,
      deadlineType: 'action',
      deadlineExpiresAt: resolveDeadline('action', iterationStartedAt, this.limits).expiresAt,
    })

    const delivered = planned.kind === 'escalation-delivered'
      ? await this.raise(wake, escalation.outcome, escalation.escalation)
      : 'delivered'
    if (this.preempted) return
    if (this.ports.stopAllActive()) {
      await this.stop()
      return
    }
    if (delivered === 'refused') {
      await this.journal('lifeloop.action.failed', {
        wakeId: wake.wakeId,
        iteration: this.state.iterationCount,
        actionIndex: this.state.actionCount,
        code: 'attention-unavailable',
      })
      await this.failWithRetry()
      return
    }

    await this.journal('lifeloop.action.completed', {
      wakeId: wake.wakeId,
      iteration: this.state.iterationCount,
      actionIndex: this.state.actionCount,
    })
    await this.journal('lifeloop.verification.started', {
      wakeId: wake.wakeId,
      iteration: this.state.iterationCount,
      verificationIndex: this.state.verificationCount + 1,
      deadlineType: 'verification',
      deadlineExpiresAt: resolveDeadline('verification', iterationStartedAt, this.limits).expiresAt,
    })

    const verification = await this.ports.verify({
      wakeId: wake.wakeId,
      wakeKey: this.state.wakeKey ?? '',
      kind: planned.kind,
      reference: wake.sourceRef ?? wake.goalRef ?? '',
      goalRef: wake.goalRef,
    })
    if (this.preempted) return
    if (this.ports.stopAllActive()) {
      await this.stop()
      return
    }
    if (!LIFE_LOOP_VERIFICATION_KINDS.includes(planned.kind)) {
      await this.journal('lifeloop.verification.failed', {
        wakeId: wake.wakeId,
        iteration: this.state.iterationCount,
        verificationIndex: this.state.verificationCount,
        code: 'unknown-verification-kind',
      })
      await this.failWithRetry()
      return
    }
    if (!verification.holds) {
      await this.journal('lifeloop.verification.failed', {
        wakeId: wake.wakeId,
        iteration: this.state.iterationCount,
        verificationIndex: this.state.verificationCount,
        code: verification.code,
      })
      await this.failWithRetry()
      return
    }

await this.journal('lifeloop.verification.passed', {
      wakeId: wake.wakeId,
      iteration: this.state.iterationCount,
      verificationIndex: this.state.verificationCount,
    })

await this.decide(wake, {
      outcome: escalation.outcome,
      escalation: escalation.escalation,
      attentionSuppressed: delivered === 'suppressed',
    })
  }

  /**
   * What the loop will do, given what it concluded.
   *
   * Two plans and no others, chosen by whether the conclusion is loud. A quiet
   * conclusion does not need Attention's permission to be quiet, so its bounded
   * action is a read: confirm that what the wake said is what actually happened.
   * A loud one has to go through Attention, and Attention — not this loop — decides
   * what the owner experiences.
   */
  private plan(outcome: DecideOutcome, escalation: OwnerEscalation): {
    readonly kind: LifeLoopVerificationKind
  } {
    if (isEscalating(outcome) && escalation !== 'none') {
      return { kind: 'escalation-delivered' }
    }
    return { kind: 'reference-terminal' }
  }

  /**
   * Ask Attention to consider something.
   *
   * Returns `refused` only when there was nothing to ask. Attention's own
   * suppression is *not* a refusal: it considered the escalation and decided the
   * owner should not have it, which is the system working, not the loop failing —
   * and treating it as a failure would make the loop retry into the same wall.
   */
  private async raise(
    wake: WakeEvent,
    outcome: DecideOutcome,
    escalation: OwnerEscalation,
  ): Promise<'delivered' | 'suppressed' | 'refused'> {
    if (this.ports.stopAllActive()) return 'refused'
    const raised = await this.ports.raiseEscalation({
      wakeId: wake.wakeId,
      wakeKey: this.state.wakeKey ?? '',
      kind: wake.kind,
      outcome,
      escalation,
      reference: wake.sourceRef,
      goalRef: wake.goalRef,
    })
    return raised === 'escalated' ? 'delivered' : 'suppressed'
  }

  /**
   * What the loop does after a verified action.
   *
   * Three exits and one loop. It goes round again only while the goal the wake
   * named is *still open* — which, after a verification, it normally is not, so the
   * common case is one iteration and a close-out. The continuation path exists and
   * is bounded, rather than existing as a claim: `maxLoopIterations` is checked by
   * the prefilter before the next thought is paid for, and `limit-reached` is
   * journalled when the ceiling is what stopped it.
   */
private async decide(
    wake: WakeEvent,
    conclusion: {
      readonly outcome: DecideOutcome
      readonly escalation: OwnerEscalation
      readonly attentionSuppressed: boolean
    },
  ): Promise<void> {
    const stillOpen = wake.goalRef !== null && this.ports.goalOpen(wake.goalRef)
    // The ceiling is read the same way the prefilter reads it, so the two cannot
    // disagree about when the last thought was: the filter refuses an iteration
    // once `iterationCount` has reached the maximum, and this asks whether going
    // round again would be refused for that reason. The alternative — testing
    // `iterationCount + 1` — stops the loop one iteration early, which is safe but
    // wrong, and a bound that is quietly one smaller than the number it names is
    // the kind of thing nobody notices for a year.
    const atCeiling = this.state.iterationCount >= this.limits.maxLoopIterations

    if (!stillOpen) {
      await this.recordDecision('closed-out', conclusion)
      await this.closeOut('closed-out')
      return
    }
    if (atCeiling) {
      await this.recordDecision('limit-reached', conclusion)
      await this.closeOut('limit-reached')
      return
    }

    await this.recordDecision('goal-still-open', conclusion)
    await this.acceptWake(wake, this.state.wakeKey ?? wakeDedupeKey(wake), this.state.iterationCount + 1)
    await this.iterate()
  }

private async recordDecision(
    decision: LifeLoopDecision,
    conclusion?: { readonly outcome: DecideOutcome; readonly escalation: OwnerEscalation; readonly attentionSuppressed: boolean },
  ): Promise<void> {
    await this.journal('lifeloop.continuation.decided', {
      wakeId: this.state.wake?.wakeId ?? '',
      iteration: this.state.iterationCount,
      decision,
      outcome: conclusion?.outcome ?? null,
      escalation: conclusion?.escalation ?? null,
      attentionSuppressed: conclusion?.attentionSuppressed ?? false,
      actionCount: this.state.actionCount,
      verificationCount: this.state.verificationCount,
    })
  }

  /**
   * Park on a deadline. A wait, never a refusal.
   *
   * The instant is absolute and written into the journal rather than derived from
   * the default for its kind, because two of these holds — a cooldown and a retry
   * backoff — are minutes long and re-deriving them from a thirty-day default would
   * turn a two-second backoff into a month of not trying, across a single restart.
   */
  private async park(code: string, expiresAt: string): Promise<void> {
    if (this.state.state !== 'WAKING') return
    await this.journal('lifeloop.filter.denied', {
      wakeId: this.state.wake?.wakeId ?? '',
      wakeKey: this.state.wakeKey ?? '',
      outcome: 'wait',
      code,
      deadlineType: 'wait',
      deadlineExpiresAt: expiresAt,
      iteration: this.state.iterationCount,
    })
  }

  /**
   * Park on the owner.
   *
   * The action stops immediately — that is what requiring consent means — but the
   * loop lands in `WAIT` holding an `approval` deadline rather than in `DENY`,
   * because the owner has not refused; they have not answered yet, and on a restart
   * those two are completely different facts.
   */
private async parkForApproval(
    wake: WakeEvent,
    escalation: OwnerEscalation,
  ): Promise<void> {
    if (this.state.state !== 'ALLOW') return
    const outcome = interrupt(this.state.state, 'approval-required')
    if (!outcome.applied || !outcome.awaitingApproval) return
    const now = this.ports.now()
    const deadline = resolveDeadline('approval', now, this.limits)
    await this.recordDecision('awaiting-approval', {
      outcome: 'interrupt',
      escalation,
      attentionSuppressed: false,
    })
    await this.journal('lifeloop.filter.denied', {
      wakeId: wake.wakeId,
      wakeKey: this.state.wakeKey ?? '',
      outcome: 'wait',
      code: 'awaiting-approval',
      deadlineType: 'approval',
      deadlineExpiresAt: deadline.expiresAt,
      iteration: this.state.iterationCount,
    })
  }

  /**
   * A failed action or verification: count the attempt, then decide by counter.
   *
   * "Should we try again" is answered by `nextRetry` — a counter against a
   * code-owned ceiling — and by nothing else. A failing unit of work cannot talk
   * the loop into another attempt, and because `attemptCount` is journaled the
   * counter survives a restart, so a step that crashes the app on every try is
   * tried three times in total rather than three times per launch.
   */
  private async failWithRetry(): Promise<void> {
    const ceiling = retryCeilingFor(this.state, this.limits)
    const held = this.state.wake
    const decision = nextRetry(
      ceiling,
      jitterFor(held?.wakeId ?? 'none', ceiling.currentAttempt, ceiling),
    )
    if (!decision.retry) {
      // The counter, not a judgement, is what stopped it — and that is worth
      // recording separately from the refusal, because "it failed" and "it has been
      // tried as many times as it is allowed" are different diagnoses and a reader
      // acting on one does not act on the other.
      await this.recordDecision('limit-reached')
      await this.closeOut('limit-reached')
      return
    }
    const expiresAt = plusMs(this.ports.now(), decision.delayMs)
    // And when a retry *is* scheduled, the backoff is a decision somebody could have
    // made wrongly, so it is journalled: the attempt, the delay, and the deadline it
    // produced are all derivable afterwards.
    await this.recordDecision('retry-scheduled')
    await this.closeOut('retry')
    // Back under as a wait rather than as a denial, so the deadline is what the
    // journal holds and a restart preserves it instead of restarting the count.
    // The wake is captured *before* the close-out, because the close-out is what
    // clears it.
    if (held !== null) {
      await this.acceptWake(held, this.state.wakeKey ?? wakeDedupeKey(held), this.state.iterationCount)
      await this.park('retry-backoff', expiresAt)
    }
  }

  /**
   * Close the loop out and return it to being idle.
   *
   * Refused while STOP ALL is latched, because a close-out must never be the thing
   * that unfreightens a stop. The fold enforces the same rule from the other side;
   * this one exists so the loop never *writes* the entry that the fold would reject.
   */
  private async closeOut(code: LifeLoopCloseOutCode): Promise<void> {
    if (this.state.state === 'IDLE') return
    if (this.ports.stopAllActive()) {
      if (this.state.state !== 'STOP') {
        await this.journal('lifeloop.stopped', {
          wakeId: this.state.wake?.wakeId ?? '',
          iteration: this.state.iterationCount,
          code: LATCHED_STOP_CODE,
        })
      }
      return
    }
    // A verified loop sits in `CONTINUE`, which the ordinary table only leaves by
    // declaring itself complete. That lands in the terminal state, and the close-out
    // that follows is what makes it idle again — which is exactly why the fold
    // distinguishes a completion stop from a latched one by the code it carries.
    if (this.state.state === 'CONTINUE') {
      await this.journal('lifeloop.stopped', {
        wakeId: this.state.wake?.wakeId ?? '',
        iteration: this.state.iterationCount,
        code: 'loop-complete',
      })
    }
    if (this.state.state !== 'DENY' && this.state.state !== 'STOP') return
    await this.journal('lifeloop.reset', {
      wakeId: this.state.wake?.wakeId ?? '',
      iteration: this.state.iterationCount,
      code,
    })
  }

  /** A held deadline that has passed. Ends in `DENY`, then a close-out. */
  private async expireHeld(code: string): Promise<void> {
    if (this.state.state !== 'WAIT') return
    const outcome = interrupt(this.state.state, 'deadline-expiry')
    if (!outcome.applied) return
    await this.journal('lifeloop.filter.denied', {
      wakeId: this.state.wake?.wakeId ?? '',
      wakeKey: this.state.wakeKey ?? '',
      outcome: 'deny',
      code,
      deadlineType: null,

      deadlineExpiresAt: null,

      iteration: this.state.iterationCount,
    })
    await this.closeOut('closed-out')
  }

  /**
   * Offer at most one due schedule.
   *
   * The registry does the deciding: a schedule that is not registered, not due, or
   * whose condition does not hold is refused with a stated reason and the tick moves
   * on. That is why the loop can trust a heartbeat without re-implementing
   * Attention's schedule bookkeeping — and why nothing here can fire a schedule
   * that Attention would not fire itself.
   */
  private async offerOneDueSchedule(now: string): Promise<boolean> {
    const pending = this.ports.schedules()
    for (const schedule of pending) {
      const dueAt = Date.parse(schedule.dueAt)
      if (!Number.isFinite(dueAt) || dueAt > Date.parse(now)) continue
      // Only the first eligible schedule is offered. The loop is single-threaded,
      // so offering the second would be refused as busy and journal a refusal that
      // means nothing; the rest wait for the next tick, which is the bound.
      await this.considerWakeNow({
        source: 'scheduled-heartbeat',
        kind: 'schedule-due',
        actor: 'host-heartbeat',
        goalRef: null,
        sourceRef: schedule.scheduleId,
        occurredAt: schedule.dueAt,
      })
      return true
    }
    return false
  }

  /**
   * The prompt for one bounded thought.
   *
   * Metadata only, and that is a deliberate limit rather than a simplification: the
   * journal is the least protected file in the system, and a prompt that quoted the
   * event that woke the loop would quietly turn it into a transcript of what Freya
   * was thinking. The question is closed and the reference is an id, so the text
   * here could not carry a sentence even if someone tried to make it.
   */
  private promptFor(wake: WakeEvent): string {
    return [
      'You are deciding whether an event Freya already recorded is worth anything.',
      'Answer with one word: do-nothing, remember, subtle-cue, speak, or interrupt.',
      `event kind: ${wake.kind}`,
      `reference: ${wake.sourceRef ?? wake.goalRef ?? 'none'}`,
    ].join('\n')
  }
}




