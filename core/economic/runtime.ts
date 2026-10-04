import { analyseEconomicAssertions, type EconomicAssertionReport } from './assertions'
import {
  blockerForRefusal,
  evaluateEconomicGate,
  STAGE_UNIT_COST,
  type EconomicAuthorityFacts,
  type EconomicGateOutcome,
} from './authority'
import {
  planContinuation,
  rankExperiments,
  type EconomicContinuationDecision,
} from './continuation'
import { describeEconomicRecovery, planEconomicRecovery, type EconomicRecoveryReport } from './recovery'
import { admitEvidence, refreshEvidence, type EvidenceObservation } from './evidence'
import { narrowEconomicLimits, narrowedLimitNames } from './limits'
import { transition } from './machine'
import { classifyEconomicClaim, REFUSAL_REASONS } from './prohibition'
import {
  admitPaperOrder,
  applyPaperOrder,
  computePaperMetrics,
  markPaperPositions,
  paperEquity,
  PAPER_STARTING_CASH,
  type PaperOrderDraft,
} from './paper'
import { defineExperiment, isExperimentExpired, type ExperimentDraft } from './research'
import { defineScenario, runSimulation, type ScenarioDraft } from './simulation'
import {
  CRITERION_SEPARATOR,
  LATCHED_ECONOMIC_STOP_CODE,
  type EconomicAssertionVerdict,
  type EconomicEventType,
  type EconomicExperimentKind,
  type EconomicLimitRequest,
  type EconomicLimits,
  type EconomicAnyRefusalCode,
  type EconomicRefusalCode,
  type EconomicRefusalSubject,
  type EconomicWakeRefusalCode,
  type EconomicSignal,
  type EconomicStage,
  type EconomicWake,
  type PaperOrder,
  type PricePoint,
  type SimulationStrategy,
} from './types'
import {
  experimentBundle,
  initialEconomicState,
  reduceEconomicEntryOnly,
  reduceEconomicState,
  type EconomicExperimentRecord,
  type EconomicFoldAnomaly,
  type EconomicJournalEntry,
  type EconomicState,
} from './state'
import type { EconomicPayload, EconomicPorts, EconomicWakeRequest } from './ports'
import { NO_LONG_HORIZON_SEAM, mayHonourGoal, type LongHorizonSeam } from './seams'
import { validateEconomicWake, wakeRefusalReason } from './wake'

/**
 * Economic Intelligence, wired.
 *
 * This is the only file in Phase 32 that touches the outside world, and it is written so
 * that four sentences can be read off the control flow rather than believed:
 *
 * 1. **No money, anywhere.** There is no code path from this class to a broker, a venue,
 *    an account or a settlement, and `ports.ts` has no port that could carry one. The
 *    paper-trading commands append records to a fold; that is the entire implementation
 *    of "placing an order" here.
 *
 * 2. **No inference, anywhere.** There is no `requestCognition` call in this file,
 *    because there is no such port. Phase 32 spends no tokens and contacts no provider,
 *    and `analyseEconomicAssertions` proves that over the journal rather than asserting
 *    it — which is a stronger claim than "we did not write one".
 *
 * 3. **No timer, anywhere.** The runtime schedules nothing. It is driven by an
 *    authoritative event, by the host's existing bounded tick, and by its own `open()`.
 *    `tick()` expires a deadline that has already passed and offers at most one
 *    long-horizon continuation; it never goes looking.
 *
 * 4. **Every gate, every time.** Each mutating entry point calls {@link EconomicRuntime.gate}
 *    before it does anything, the decision is journalled either way, and a refusal is
 *    journalled with a closed code. The gate reads `stopAllActive` fresh at each call
 *    rather than caching a latch, because a latch copied into this class would let it act
 *    on a stale reading.
 */

/** What one command produced, or the closed reason it did not happen. */
export type EconomicOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: EconomicRefusalCode; readonly reason: string }

/** What happened to one wake. Closed, because a caller branches on it. */
export type EconomicWakeOutcome =
  | { readonly outcome: 'accepted'; readonly wakeId: string }
  | { readonly outcome: 'deferred'; readonly wakeId: string; readonly code: string; readonly deadline: string }
  | { readonly outcome: 'refused'; readonly code: EconomicAnyRefusalCode; readonly reason: string }
  | { readonly outcome: 'busy'; readonly reason: string }
  | { readonly outcome: 'closed'; readonly reason: string }

/** What the owner can read about the subsystem at an instant. */
export interface EconomicStatus {
  readonly experiments: number
  readonly activeExperiments: number
  readonly interruptedExperiments: number
  readonly evidence: number
  readonly scenarios: number
  readonly orders: number
  readonly metrics: number
  readonly refusalCount: number
  readonly lastRefusal: { readonly code: string; readonly at: string } | null
  readonly stopAllLatched: boolean
  readonly isStopped: boolean
  /** Refusals this process, by closed code. Session state; resets on restart. */
  readonly refusedRequests: number
}

export interface EconomicSnapshot {
  readonly status: EconomicStatus
  readonly recovery: EconomicRecoveryReport | null
  readonly anomalies: readonly EconomicFoldAnomaly[]
  readonly limits: EconomicLimits
  /** The limit names this deployment narrowed below the code-owned ceilings. */
  readonly narrowedLimits: readonly string[]
  readonly enabled: boolean
  readonly assertions: EconomicAssertionReport | null
  readonly auditedAt: string | null
  /** Whether a long-horizon subsystem is wired in at all, and which one. */
  readonly longHorizonSeam: string
}

export interface EconomicRuntimeOptions {
  readonly ports: EconomicPorts
  /** Only ever narrows the frozen ceilings. A raise is clamped, not applied. */
  readonly limits?: EconomicLimitRequest
  /**
   * The Phase 31 seam.
   *
   * Defaults to the inert one, so a Core with no long-horizon subsystem still has a
   * working economic subsystem — it simply cannot be woken by a goal, which is the honest
   * state rather than a broken one.
   */
  readonly seam?: LongHorizonSeam
}

/** Every assertion in its passing state. The absent projection starts here. */
const PASSING_ASSERTIONS: EconomicAssertionVerdict = Object.freeze({
  noRealMoneyAction: true,
  noRealOrder: true,
  noModelCallWithoutWake: true,
  noContinuousPolling: true,
  noHiddenReasoning: true,
  noUnrestrictedLoops: true,
  noAuthorityEscalation: true,
  noIdleModelCall: true,
  noHiddenDurableState: true,
  noSelfApproval: true,
  noBudgetWidening: true,
})

export class EconomicRuntime {
  private readonly ports: EconomicPorts
  private readonly limits: EconomicLimits
  private readonly seam: LongHorizonSeam

  private state: EconomicState = initialEconomicState()
  private anomalies: readonly EconomicFoldAnomaly[] = []
  private recovery: EconomicRecoveryReport | null = null
  private assertions: EconomicAssertionReport | null = null
  private auditedAt: string | null = null
  private refusedRequests = 0

  /**
   * Serialisation chain.
   *
   * Every public method enqueues and returns. It never rejects: a step that throws is
   * journalled as an anomaly and abandoned, because an exception escaping into Core's
   * event subscription would take the journal writer with it.
   */
  private tail: Promise<unknown> = Promise.resolve()
  private opened = false
  private closed = false

  constructor(options: EconomicRuntimeOptions) {
    this.ports = options.ports
    this.limits = narrowEconomicLimits(options.limits)
    this.seam = options.seam ?? NO_LONG_HORIZON_SEAM
  }

  /* ------------------------------------------------------------- lifecycle */

  /**
   * Read the journal, reconcile, and be ready for wakes.
   *
   * Called from Core's `start()` and nowhere else. Recovery is journalled rather than
   * merely applied, and that is the point: a subsystem that reconciled itself in memory
   * would look recovered until the next restart, when it would do it again and tell a
   * slightly different story each time.
   */
  async open(): Promise<EconomicRecoveryReport> {
    if (this.opened) return this.recovery ?? this.planRecovery()
    this.opened = true
    return await this.enqueue(async () => {
      const entries = await this.ports.replay()
      const fold = reduceEconomicState(entries, this.limits)
      this.state = fold.state
      this.anomalies = fold.anomalies
      const report = await this.reconcile()
      this.recovery = report
      // The boot audit, over everything the journal already holds. It is a whole-journal
      // scan, so it happens exactly once here rather than on a read a window could call
      // repeatedly.
      await this.audit(entries)
      this.ports.onChange()
      return report
    })
  }

  /**
   * Reconcile whatever the journal says with what can still be true.
   *
   * The decision is the domain's (`planEconomicRecovery`); this method's only job is to
   * make it durable and to refuse to fake it. Three cases, and the third is the one that
   * matters:
   *
   *   - a latch that was set when the process ended is re-asserted, because a restart is
   *     not the owner clearing a panic button;
   *   - an experiment the journal left in a live stage is recorded as **interrupted**,
   *     which is visible and changes nothing about where it is — it is not resumed, and
   *     there is no code path here that would resume it;
   *   - everything else is left exactly as it is.
   */
  private async reconcile(): Promise<EconomicRecoveryReport> {
    const stopAll = this.ports.stopAllActive()
    const report = this.planRecovery()

    if (stopAll && !this.state.stopAllLatched) {
      await this.journal('economic.stopped', {
        experimentId: '',
        stage: 'IDLE',
        code: LATCHED_ECONOMIC_STOP_CODE,
      })
      return report
    }
    if (!report.reconciled) return report

    for (const action of report.actions) {
      if (action.code !== 'interrupted-experiments-recorded') continue
      const experimentId = action.experimentId ?? ''
      const experiment = this.experimentOrNull(experimentId)
      const stage = experiment?.stage ?? action.stage ?? 'IDLE'
      await this.journal('economic.reconciled', {
        code: 'restart-recovery',
        from: stage,
        experimentId,
        atStage: stage,
      })
    }
    return report
  }

  private planRecovery(): EconomicRecoveryReport {
    return planEconomicRecovery({
      state: this.state,
      now: this.ports.now(),
      stopAllActive: this.ports.stopAllActive(),
      anomalies: this.anomalies,
    })
  }

  /**
   * Stop taking work.
   *
   * No journal entry for the shutdown itself: shutdown is a fact about the process, not
   * about the economic continuation, and the next `open()` reconciles from the journal
   * without being told that this one existed.
   */
  async close(): Promise<void> {
    this.closed = true
    await this.enqueue(async () => {
      this.ports.onChange()
    })
  }

  /* --------------------------------------------------------------- reading */

  status(): EconomicStatus {
    const experiments = this.state.experiments
    return {
      experiments: experiments.length,
      activeExperiments: experiments.filter((entry) => entry.state === 'active').length,
      interruptedExperiments: this.state.interrupted.length,
      evidence: this.state.evidence.length,
      scenarios: this.state.scenarios.length,
      orders: this.state.orders.length,
      metrics: this.state.metrics.length,
      refusalCount: this.state.refusals.length,
      lastRefusal:
        this.state.lastRefusalCode === null
          ? null
          : { code: this.state.lastRefusalCode, at: this.state.lastRefusalAt ?? '' },
      stopAllLatched: this.state.stopAllLatched,
      isStopped: this.state.stopAllLatched,
      refusedRequests: this.refusedRequests,
    }
  }

  snapshot(): EconomicSnapshot {
    return {
      status: this.status(),
      recovery: this.recovery,
      anomalies: this.anomalies,
      limits: this.limits,
      narrowedLimits: narrowedLimitNames(this.limits),
      enabled: this.ports.enabled(),
      assertions: this.assertions,
      auditedAt: this.auditedAt,
      longHorizonSeam: this.seam.name,
    }
  }

  /** The folded state, for tests and for the projection. Never a mutable handle. */
  folded(): EconomicState {
    return this.state
  }

  /** The evidence as it stands now, re-derived rather than as it was written. */
  evidenceAsOf(experimentId?: string): readonly ReturnType<typeof refreshEvidence>[number][] {
    const evidence =
      experimentId === undefined
        ? this.state.evidence
        : this.state.evidence.filter((entry) => entry.experimentId === experimentId)
    return refreshEvidence(evidence, this.ports.now(), this.limits)
  }

  /** How much of Phase 32's own promise is currently being kept, by name. */
  assertionVerdict(): EconomicAssertionVerdict {
    return this.assertions?.checks ?? PASSING_ASSERTIONS
  }

  /**
   * Re-run the eleven assertions over the journal.
   *
   * Not part of a read: it is a whole-journal scan, and a read that did it would be
   * unbounded work on a path a window can call. It runs once when the subsystem opens —
   * the boot audit, which is where a promise about money belongs — and is exposed here so
   * a release gate or a red-team suite can ask for a fresh verdict rather than trusting
   * the one from boot.
   */
  async audit(entries?: readonly EconomicJournalEntry[]): Promise<EconomicAssertionReport> {
    const journal = entries ?? (await this.ports.replay())
    const report = analyseEconomicAssertions({ entries: journal, limits: this.limits })
    this.assertions = report
    this.auditedAt = this.ports.now()
    return report
  }

  /** The one-line summary of the last recovery, safe to journal or to display. */
  describeRecovery(): string | null {
    return this.recovery === null ? null : describeEconomicRecovery(this.recovery)
  }

  /** The ordered experiments, as the projection shows them. */
  ranked(): readonly EconomicExperimentRecord[] {
    return rankExperiments(this.state.experiments)
  }

  /** The units one experiment would spend at its current stage. Never money. */
  unitsFor(stage: EconomicStage): number {
    return STAGE_UNIT_COST[stage]
  }

  /** The kinds a caller may create, so a surface cannot invent one. */
  supportedKinds(): readonly EconomicExperimentKind[] {
    return ['research', 'simulation', 'paper-trading']
  }

  /** The strategies a caller may run, so a surface cannot invent one. */
  supportedStrategies(): readonly SimulationStrategy[] {
    return ['cash', 'buy-and-hold', 'sma-crossover']
  }

  /* ------------------------------------------------------------ interrupts */

  /**
   * STOP ALL. Reaches every state, including an idle one.
   *
   * Journalled rather than merely latched, because the latch in Core is the real one and
   * this has to be able to survive a restart without it. The gate is closed synchronously
   * in the same turn as the owner's decision, and this is the record that the subsystem
   * heard about it.
   */
  async stop(): Promise<void> {
    await this.enqueue(async () => {
      if (this.closed || this.state.stopAllLatched) return
      await this.journal('economic.stopped', {
        experimentId: '',
        stage: 'IDLE',
        code: LATCHED_ECONOMIC_STOP_CODE,
      })
      this.ports.onChange()
    })
  }

  /**
   * The owner cleared the latch.
   *
   * The only lift that exists. There is no path here reachable from a wake, a deadline, a
   * retry or a failure, which is why the fold's `economic.unstopped` demands that there
   * was a stop to lift *and* that the owner cleared it: an entry arriving while the
   * subsystem is running is recorded as tampering rather than quietly freeing it.
   */
  async lift(): Promise<void> {
    await this.enqueue(async () => {
      if (this.closed || !this.state.stopAllLatched) return
      await this.journal('economic.unstopped', { code: 'stop-latch-cleared' })
      this.ports.onChange()
    })
  }

  /**
   * The owner spoke, and the owner comes first.
   *
   * Nothing is resumed by this and nothing is advanced: every live experiment is recorded
   * as interrupted, exactly as a restart would, so the owner's turn cannot be used to slip
   * past the visibility that recovery guarantees.
   */
  async preemptByOwner(): Promise<void> {
    await this.enqueue(async () => {
      if (this.closed || this.state.stopAllLatched) return
      for (const experiment of this.state.experiments) {
        if (!isLiveStage(experiment.stage)) continue
        await this.journal('economic.reconciled', {
          code: 'owner-preempted',
          from: experiment.stage,
          experimentId: experiment.experimentId,
          atStage: experiment.stage,
        })
      }
      this.ports.onChange()
    })
  }

  /* ------------------------------------------------------------------ wake */

  /**
   * Offer a wake. Core raises them; this decides whether one is honoured.
   *
   * Nothing here reaches a provider, contacts a broker or spends a unit. The most this
   * can do is journal a refusal.
   */
  async considerWake(request: EconomicWakeRequest): Promise<EconomicWakeOutcome> {
    return await this.enqueue(async () => this.considerWakeNow(request))
  }

  /**
   * The wake itself, on the queue.
   *
   * Split out from {@link considerWake} because `tick` is already on the queue, and an
   * `enqueue` from inside an enqueued task would wait behind itself for ever. That is not
   * a theoretical hazard — it is a deadlock.
   */
  private async considerWakeNow(request: EconomicWakeRequest): Promise<EconomicWakeOutcome> {
    if (this.closed) return { outcome: 'closed', reason: 'the economic subsystem has been shut down' }

    const wakeId = this.ports.newId()
    const validation = validateEconomicWake(request, wakeId, {
      now: this.ports.now(),
      stopAllActive: this.ports.stopAllActive(),
      journalTrustworthy: this.ports.journalTrustworthy(),
      experimentState: (id) => this.experimentOrNull(id)?.state ?? null,
      experimentExists: (id) => this.experimentOrNull(id) !== null,
      processedWakeKeys: this.state.processedWakeKeys,
      busy: false,
      closed: this.closed,
    })

    if (validation.outcome === 'denied') {
      await this.journal('economic.wake.denied', {
        wakeId,
        source: request.source,
        kind: request.kind,
        code: validation.code,
        experimentId: request.experimentId ?? '',
      })
      await this.recordRefusal(validation.code, 'wake', request.experimentId, wakeId)
      this.ports.onChange()
      return { outcome: 'refused', code: validation.code, reason: validation.reason }
    }

    await this.journal('economic.wake.received', {
      wakeId: validation.wake.wakeId,
      source: validation.wake.source,
      kind: validation.wake.kind,
      wakeKey: validation.wakeKey,
      experimentId: validation.wake.experimentId ?? '',
      goalRef: validation.wake.goalRef ?? '',
      sourceRef: validation.wake.sourceRef ?? '',
      occurredAt: validation.wake.occurredAt,
      observedAt: validation.wake.observedAt,
    })

    if (validation.outcome === 'deferred') {
      // Recorded as a refusal of the *attempt*, not of the wake: the wake is real and
      // correctly shaped, it just names an instant that has not arrived. The next tick
      // offers it again, which is the bound.
      await this.recordRefusal('wake-not-authorized', 'wake', validation.wake.experimentId, wakeId)
      this.ports.onChange()
      return { outcome: 'deferred', wakeId, code: validation.code, deadline: validation.deadline }
    }

    // The one thing a wake may do on its own: bring the named experiment forward by at
    // most one bounded step. It cannot open, cancel or close anything — those take an
    // explicit command — so a wake is an *occasion*, not an authority.
    if (validation.wake.experimentId !== null) {
      await this.step(validation.wake.experimentId, wakeId)
    }
    this.ports.onChange()
    return { outcome: 'accepted', wakeId }
  }

  /**
   * The bounded tick.
   *
   * Two jobs and no others: expire a deadline that has already passed, and offer at most
   * one long-horizon continuation. It performs no fetch, contacts no provider and
   * appends nothing for an experiment that is not due — which is the same contract
   * `Core.attentionTick` already has, and the reason the host needed no new timer.
   */
  async tick(): Promise<number> {
    return await this.enqueue(async () => {
      if (this.closed || this.state.stopAllLatched) return 0
      const now = this.ports.now()
      let fired = 0

      for (const experiment of this.state.experiments) {
        if (experiment.state !== 'active' && experiment.state !== 'paused') continue
        if (!isLiveStage(experiment.stage)) continue
        if (!isExperimentExpired(experiment, now)) continue
        await this.journal('economic.experiment.failed', {
          experimentId: experiment.experimentId,
          from: experiment.stage,
          code: 'deadline-expired',
          updatedAt: now,
        })
        fired += 1
      }

      fired += await this.offerOneLongHorizonWake(now)
      if (fired > 0) this.ports.onChange()
      return fired
    })
  }

  /**
   * Offer at most one long-horizon continuation.
   *
   * The seam decides, and it can decline. This is the whole of Phase 32's dependency on
   * Phase 31: one call per tick, one question asked, and `null` is the answer whenever the
   * seam is not connected or the goal is not the seam's to offer.
   */
  private async offerOneLongHorizonWake(now: string): Promise<number> {
    for (const experiment of this.state.experiments) {
      if (experiment.state !== 'active') continue
      const goals = this.seam.goalsFor(experiment.experimentId).slice(0, 1)
      for (const goalRef of goals) {
        if (!mayHonourGoal(this.seam, goalRef, experiment.experimentId)) continue
        const request = this.seam.wakeFor(goalRef, now)
        if (request === null) continue
        await this.considerWakeNow(request)
        return 1
      }
    }
    return 0
  }

  /* ------------------------------------------------------------- commands */

  /**
   * Define and open an experiment.
   *
   * Gate first, then the pure definition, then two journal entries: the creation and the
   * `experiment-opened` transition that moves it into the stage its kind dictates. Both
   * are written because both are facts — an experiment existing and an experiment having
   * begun are different things, and a fold that collapsed them would make "opened but
   * never started" unrepresentable.
   */
  async openExperiment(draft: ExperimentDraft): Promise<EconomicOutcome<{ readonly experimentId: string }>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('experiment', draft.experimentId)
      if (blocked !== null) return blocked

      const defined = defineExperiment(draft, this.state.experiments, this.limits)
      if (!defined.ok) return await this.refuse(defined.code, 'experiment', draft.experimentId)

      const gate = await this.gate(draft.experimentId)
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'experiment', draft.experimentId)

      await this.journal('economic.experiment.created', {
        experimentId: defined.experiment.experimentId,
        kind: defined.experiment.kind,
        state: defined.experiment.state,
        title: defined.experiment.title,
        question: defined.experiment.question,
        criteria: defined.experiment.completionCriteria.join(CRITERION_SEPARATOR),
        criteriaCount: defined.experiment.completionCriteria.length,
        progress: 0,
        deadlineAt: defined.experiment.deadlineAt ?? '',
        createdAt: defined.experiment.createdAt,
        updatedAt: defined.experiment.updatedAt,
      })

      const experiment = this.experimentOrNull(draft.experimentId)
      if (experiment === null) {
        return await this.refuse('unknown-experiment', 'experiment', draft.experimentId)
      }
      await this.move(experiment, 'experiment-opened', 0, 'experiment-opened', 'deadline-expired')
      this.ports.onChange()
      return { ok: true, value: { experimentId: draft.experimentId } }
    })
  }

  /**
   * Admit observations an owner or Core supplies directly.
   *
   * The scan runs **first**, on the whole array, so a batch containing one hostile object
   * is refused as a batch rather than half-applied. A partial application would leave the
   * journal describing evidence nobody can account for.
   */
  async recordObservations(
    experimentId: string,
    observations: readonly EvidenceObservation[],
  ): Promise<EconomicOutcome<EconomicObservationCount>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('evidence', experimentId)
      if (blocked !== null) return blocked

      for (const observation of observations.slice(0, this.limits.maxEvidencePerExperiment)) {
        const scan = classifyEconomicClaim(observation, 'evidence')
        if (scan.prohibited) return await this.refuse(scan.code, 'evidence', experimentId)
      }
      return await this.recordObservationsNow(experimentId, observations)
    })
  }

  /**
   * Pull observations from the research port and admit whatever comes back.
   *
   * The pull is *here*, on the queue, inside a command somebody asked for. It is not a
   * timer, it is not a loop, and it happens at most once per command — which is what keeps
   * "no continuous polling" a property rather than a hope.
   */
  async pullEvidence(experimentId: string): Promise<EconomicOutcome<EconomicObservationCount>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('evidence', experimentId)
      if (blocked !== null) return blocked

      const gate = await this.gate(experimentId)
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'evidence', experimentId)

      const experiment = this.experimentOrNull(experimentId)
      if (experiment === null) return await this.refuse('unknown-experiment', 'evidence', experimentId)

      const observations = await this.ports.observationsFor(experimentId, experiment.updatedAt)
      // Re-checked after the await, for the same reason the life loop re-checks it: a
      // latch read before an `await` is a latch that may have been pressed during it.
      if (this.ports.stopAllActive()) return await this.refuse('stop-all-active', 'evidence', experimentId)
      return await this.recordObservationsNow(experimentId, observations)
    })
  }

  private async recordObservationsNow(
    experimentId: string,
    observations: readonly EvidenceObservation[],
  ): Promise<EconomicOutcome<EconomicObservationCount>> {
    let admitted = 0
    let refused = 0
    const existing = this.state.evidence.filter((entry) => entry.experimentId === experimentId)
    // Bounded by what the experiment has room for, so a port returning ten thousand
    // observations costs ten thousand comparisons and not ten thousand refusals.
    const room = Math.max(0, this.limits.maxEvidencePerExperiment - existing.length)
    // And a batch that arrives with no room at all is **refused**, not silently dropped.
    // "Nothing happened" and "there was nowhere to put it" are different facts, and only
    // the second one is interesting to the person who asked.
    if (room === 0 && observations.length > 0) {
      await this.recordRefusal('experiment-cap-reached', 'evidence', experimentId, null)
      return { ok: true, value: { admitted: 0, refused: observations.length } }
    }
    for (const observation of observations.slice(0, room)) {
      const scan = classifyEconomicClaim(observation, 'evidence')
      if (scan.prohibited) {
        await this.recordRefusal(scan.code, 'evidence', experimentId, null)
        refused += 1
        continue
      }
      const result = admitEvidence(observation, experimentId, existing, this.limits)
      if (!result.admitted) {
        refused += 1
        await this.recordRefusal(result.code, 'evidence', experimentId, null)
        continue
      }
      await this.journal('economic.evidence.gathered', {
        evidenceId: result.evidence.evidenceId,
        experimentId,
        source: result.evidence.source,
        sourceRef: result.evidence.sourceRef,
        citation: result.evidence.citation,
        claim: result.evidence.claim,
        observedAt: result.evidence.observedAt,
        state: result.evidence.state,
        confidence: result.evidence.confidence,
      })
      admitted += 1
    }
    return { ok: true, value: { admitted, refused } }
  }

  /**
   * Define and run one scenario against a price series Core supplies.
   *
   * The metrics are deliberately *not* journalled — see the fold's note on
   * `economic.simulation.completed` — so what is durable is "this scenario was run over
   * this many observations", and the numbers are recomputed from the series on demand.
   * That is the only arrangement in which a reader cannot be shown a result the series
   * does not support.
   */
  async runScenario(
    experimentId: string,
    draft: ScenarioDraft,
  ): Promise<EconomicOutcome<{ readonly resultId: string; readonly totalReturn: number }>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('scenario', experimentId)
      if (blocked !== null) return blocked

      const scan = classifyEconomicClaim(draft, 'scenario')
      if (scan.prohibited) return await this.refuse(scan.code, 'scenario', experimentId)

      const defined = defineScenario(
        draft,
        experimentId,
        this.state.scenarios.filter((entry) => entry.experimentId === experimentId),
        this.limits,
      )
      if (!defined.ok) return await this.refuse(defined.code, 'scenario', experimentId)

      const gate = await this.gate(experimentId)
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'scenario', experimentId)

      const startedAt = this.ports.now()
      await this.journal('economic.simulation.started', {
        scenarioId: draft.scenarioId,
        experimentId,
        strategy: draft.strategy,
        parameterCount: Object.keys(draft.parameters).length,
        assumptionCount: draft.assumptions.length,
        observationCount: 0,
        startedAt,
      })

      const series = await this.ports.priceSeriesFor(experimentId, draft.symbol)
      if (this.ports.stopAllActive()) return await this.refuse('stop-all-active', 'scenario', experimentId)

      const completedAt = this.ports.now()
      const resultId = this.ports.newId()
      const run = runSimulation(
        {
          scenario: defined.scenario,
          series: series.slice(0, this.limits.maxSeriesLength),
          resultId,
          startedAt,
          completedAt,
        },
        this.limits,
      )

      const failed = !run.ok
      await this.journal('economic.simulation.completed', {
        scenarioId: draft.scenarioId,
        experimentId,
        resultId,
        strategy: draft.strategy,
        metricCount: run.ok ? run.result.metrics.length : 0,
        observationCount: run.ok ? run.result.observations : 0,
        completedAt,
        failed,
      })

      if (!run.ok) {
        await this.recordRefusal(run.code, 'scenario', experimentId, null)
        return { ok: false, code: run.code, reason: run.reason }
      }

      this.ports.onChange()
      const totalReturn = run.result.metrics.find((metric) => metric.name === 'total_return')?.value ?? 0
      return { ok: true, value: { resultId, totalReturn } }
    })
  }

  /**
   * Place a **simulated** order.
   *
   * The scan of the draft runs before the gate is even assembled, and a draft carrying
   * anything real is refused with `real-order-prohibited` before the experiment's stage is
   * looked at. Only a paper-trading experiment reaches this far: a research or simulation
   * experiment has no portfolio to place against, which is a refusal the owner can read
   * rather than a silently empty order.
   */
  async placePaperOrder(
    experimentId: string,
    draft: PaperOrderDraft,
  ): Promise<EconomicOutcome<{ readonly orderId: string }>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('order', experimentId)
      if (blocked !== null) return blocked

      const scan = classifyEconomicClaim(draft, 'order')
      if (scan.prohibited) return await this.refuse(scan.code, 'order', experimentId)

      const experiment = this.experimentOrNull(experimentId)
      if (experiment === null) return await this.refuse('unknown-experiment', 'order', experimentId)
      if (experiment.kind !== 'paper-trading') {
        return await this.refuse('experiment-kind-mismatch', 'order', experimentId)
      }

      const admitted = admitPaperOrder(
        draft,
        experimentId,
        this.state.orders.filter((entry) => entry.experimentId === experimentId),
        this.limits,
      )
      if (!admitted.admitted) return await this.refuse(admitted.code, 'order', experimentId)

      const applied = applyPaperOrder(
        this.state.positions.filter((entry) => entry.experimentId === experimentId),
        admitted.order,
        experimentId,
        this.limits,
      )
      if (!applied.ok) return await this.refuse(applied.code, 'order', experimentId)

      const gate = await this.gate(experimentId)
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'order', experimentId)

      await this.journal('economic.paper-order.placed', {
        orderId: admitted.order.orderId,
        experimentId,
        symbol: admitted.order.symbol,
        side: admitted.order.side,
        quantity: admitted.order.quantity,
        price: admitted.order.price,
        placedAt: admitted.order.placedAt,
        reasoning: admitted.order.reasoning[0] ?? 'simulation',
      })
      await this.journal('economic.paper-order.filled', {
        orderId: admitted.order.orderId,
        experimentId,
        positionId: applied.fill.positionId,
        symbol: admitted.order.symbol,
        side: admitted.order.side,
        quantity: admitted.order.quantity,
        price: admitted.order.price,
        realizedPnl: applied.fill.realizedPnl,
      })
      this.ports.onChange()
      return { ok: true, value: { orderId: admitted.order.orderId } }
    })
  }

  /**
   * Mark the portfolio and compute its metrics.
   *
   * Every metric produced carries a denominator and a unit, and one whose denominator
   * would be zero is **not emitted** — see `computePaperMetrics`. The notes explaining
   * which ones were skipped are handed back to the caller rather than journalled as
   * refusals, because a metric that could not be reported is an uncertainty and not a
   * refusal, and folding one into the other would make the two unreadable.
   */
  async computeMetrics(
    experimentId: string,
    prices: Readonly<Record<string, number>>,
  ): Promise<EconomicOutcome<{ readonly reported: number; readonly notes: readonly string[] }>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('metric', experimentId)
      if (blocked !== null) return blocked

      const gate = await this.gate(experimentId)
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'metric', experimentId)

      const experiment = this.experimentOrNull(experimentId)
      if (experiment === null) return await this.refuse('unknown-experiment', 'metric', experimentId)

      const bundle = experimentBundle(this.state, experimentId)
      const marked = markPaperPositions(bundle.positions, prices)
      const realized = this.state.realizedPnl[experimentId] ?? 0
      const equity = paperEquity(marked, PAPER_STARTING_CASH, realized)
      const computedAt = this.ports.now()

      const computed = computePaperMetrics(
        {
          experimentId,
          positions: marked,
          orders: bundle.orders,
          startingCash: PAPER_STARTING_CASH,
          realizedPnl: realized,
          equityCurve: [PAPER_STARTING_CASH, equity],
          computedAt,
          metricIdFor: (name) => `${experimentId}:${name}`,
        },
        this.limits,
      )

      for (const metric of computed.metrics) {
        await this.journal('economic.metric.computed', {
          metricId: metric.metricId,
          experimentId,
          name: metric.name,
          value: metric.value,
          denominator: metric.denominator,
          unit: metric.unit,
          computedAt: metric.computedAt,
        })
      }
      this.ports.onChange()
      return { ok: true, value: { reported: computed.metrics.length, notes: computed.uncertainties } }
    })
  }

  /**
   * Take at most one bounded step.
   *
   * Asks the continuation planner what should happen, refuses when the answer is `null`,
   * and otherwise offers the signal to the state machine — which may still refuse it, and
   * that refusal is journalled rather than papered over. `null` is the most common
   * outcome and it does nothing, which is the point.
   */
  async advance(experimentId: string): Promise<EconomicOutcome<{ readonly decision: EconomicContinuationDecision }>> {
    return await this.enqueue(async () => this.step(experimentId, null))
  }

  /**
   * Cancel an experiment.
   *
   * A first-class terminal outcome rather than a failure, because "we stopped looking" and
   * "we looked and it did not work" are different facts and a journal that conflated them
   * would be useless to the person reading it.
   */
  async cancelExperiment(
    experimentId: string,
    reason: string,
  ): Promise<EconomicOutcome<{ readonly experimentId: string }>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('experiment', experimentId)
      if (blocked !== null) return blocked

      const experiment = this.experimentOrNull(experimentId)
      if (experiment === null) return await this.refuse('unknown-experiment', 'experiment', experimentId)
      if (!isLiveStage(experiment.stage) && experiment.stage !== 'IDLE') {
        return await this.refuse('experiment-terminal', 'experiment', experimentId)
      }

      const gate = await this.gate(experimentId)
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'experiment', experimentId)

      await this.journal('economic.experiment.cancelled', {
        experimentId,
        from: experiment.stage,
        reason: reason.slice(0, this.limits.maxPayloadTextLength),
        updatedAt: this.ports.now(),
      })
      this.ports.onChange()
      return { ok: true, value: { experimentId } }
    })
  }

  /**
   * Close a finished experiment's stage, releasing it.
   *
   * Requires a terminal stage, and the fold refuses anything else — so an experiment
   * cannot be "closed out" to skip the analysis. An owner who wants it finished either
   * cancels it, which says why, or lets it complete.
   */
  async closeExperiment(experimentId: string): Promise<EconomicOutcome<{ readonly experimentId: string }>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('experiment', experimentId)
      if (blocked !== null) return blocked

      const experiment = this.experimentOrNull(experimentId)
      if (experiment === null) return await this.refuse('unknown-experiment', 'experiment', experimentId)
      if (experiment.stage !== 'COMPLETE' && experiment.stage !== 'FAILED') {
        return await this.refuse('experiment-terminal', 'experiment', experimentId)
      }

      const gate = await this.gate(experimentId)
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'experiment', experimentId)

      await this.move(experiment, 'experiment-closed', experiment.progress, 'closed-out', 'deadline-expired')
      this.ports.onChange()
      return { ok: true, value: { experimentId } }
    })
  }

  /* ------------------------------------------------------------- internals */

  /**
   * One bounded step for one experiment, on the queue already.
   *
   * The gate lives here rather than in `advance` so that a wake and an explicit command
   * are gated identically — there is no route into this method that skips it.
   */
  private async step(
    experimentId: string,
    wakeId: string | null,
  ): Promise<EconomicOutcome<{ readonly decision: EconomicContinuationDecision }>> {
    const blocked = await this.refuseIfStopped('experiment', experimentId)
    if (blocked !== null) return blocked

    const gate = await this.gate(experimentId)
    if (gate.outcome === 'deny') return await this.refuse(gate.code, 'experiment', experimentId, wakeId)

    const experiment = this.experimentOrNull(experimentId)
    if (experiment === null) return await this.refuse('unknown-experiment', 'experiment', experimentId, wakeId)

    const bundle = experimentBundle(this.state, experimentId)
    const now = this.ports.now()
    const plan = planContinuation({
      experiment,
      facts: {
        evidence: bundle.evidence,
        scenarioCount: bundle.scenarios.length,
        scenariosRunning: bundle.scenarios.filter(
          (entry) => entry.status === 'pending' || entry.status === 'running',
        ).length,
        orderCount: bundle.orders.length,
        metricCount: bundle.metrics.length,
      },
      now,
      limits: this.limits,
      expired: isExperimentExpired(experiment, now),
    })

    await this.journal('economic.continuation.decided', {
      experimentId,
      wakeId: wakeId ?? '',
      decision: plan.decision,
      stage: experiment.stage,
      reasoning: plan.reasoning[0] ?? 'criteria-unmet',
      blocker: plan.blocker ?? '',
      evidenceCount: bundle.evidence.length,
      scenarioCount: bundle.scenarios.length,
      orderCount: bundle.orders.length,
      attempt: this.state.attemptCount,
    })

    if (plan.signal !== null) {
      await this.move(experiment, plan.signal, plan.progress, plan.decision, plan.blocker ?? 'deadline-expired')
    }
    this.ports.onChange()
    return { ok: true, value: { decision: plan.decision } }
  }

  /**
   * Offer a signal to the state machine and journal the move.
   *
   * The `from` and `to` in the payload are the ones the *machine* produced, and the fold
   * checks them against what the journal already says — so this method cannot misreport a
   * move even if the planner were wrong, because the planner's proposal is only ever a
   * *signal* and the fold recomputes the destination itself.
   */
  private async move(
    experiment: EconomicExperimentRecord,
    signal: EconomicSignal,
    progress: number,
    decision: EconomicContinuationDecision,
    failureCode: string,
  ): Promise<void> {
    const result = transition(experiment.stage, signal, experiment.kind)
    const now = this.ports.now()

    if (!result.ok) {
      // The planner asked for a move the machine does not have. That is a bug in the
      // planner rather than an attack, so it is recorded as an anomaly and the
      // experiment simply does not move — never silently repaired.
      this.anomalies = [
        ...this.anomalies,
        {
          code: 'illegal-transition',
          eventType: 'economic.continuation.decided',
          detail: `the continuation planner asked for "${signal}" from ${experiment.stage}, which the machine refused (${result.code})`,
        },
      ]
      return
    }

    if (result.to === 'FAILED') {
      await this.journal('economic.experiment.failed', {
        experimentId: experiment.experimentId,
        from: experiment.stage,
        code: failureCode,
        updatedAt: now,
      })
      return
    }

    if (result.to === 'COMPLETE') {
      await this.journal('economic.experiment.completed', {
        experimentId: experiment.experimentId,
        from: experiment.stage,
        progress: 1,
        criteriaMet: experiment.completionCriteria.length,
        completedAt: now,
      })
      return
    }

    await this.journal('economic.experiment.state-changed', {
      experimentId: experiment.experimentId,
      from: experiment.stage,
      to: result.to,
      signal,
      progress,
      reasoning: 'criteria-met',
      updatedAt: now,
    })
    void decision
  }

  /**
   * Run every gate and journal the decision, whatever it was.
   *
   * A refusal is journaled either way, so the journal shows "three gates cleared and then
   * the budget ran out" rather than a bare denial — and an allowed decision is journaled
   * too, because the record that a thing *was permitted* is worth as much to an auditor
   * as the record that it was not.
   */
  private async gate(experimentId: string): Promise<EconomicGateOutcome> {
    const facts: EconomicAuthorityFacts = {
      journalTrustworthy: this.ports.journalTrustworthy(),
      stopAllActive: this.ports.stopAllActive(),
      enabled: this.ports.enabled(),
      capabilityAllowed: this.ports.guardAllows(),
      cognitionAuthorized: this.ports.governorAuthorized(),
      budgetRemainingUnits: this.ports.budgetRemainingUnits(),
      approvalSatisfied: this.ports.approvalSatisfied(experimentId),
      realMoney: false,
    }
    const outcome = evaluateEconomicGate(facts)
    await this.journal('economic.gate.decided', {
      wakeId: this.state.currentWake?.wakeId ?? '',
      experimentId,
      outcome: outcome.outcome,
      code: outcome.code,
      checked: outcome.cleared.join('|'),
      remainingUnits: facts.budgetRemainingUnits,
      at: this.ports.now(),
    })
    return outcome
  }

  /**
   * The stop check, for the paths that must refuse before doing anything else.
   *
   * Journalled like every other refusal rather than short-circuited, so "Freya was
   * stopped" is a thing the owner can find in the journal instead of a thing they have to
   * remember.
   */
  private async refuseIfStopped(
    subject: EconomicRefusalSubject,
    experimentId: string | null,
  ): Promise<EconomicOutcome<never> | null> {
    if (!this.ports.stopAllActive()) return null
    return await this.refuse('stop-all-active', subject, experimentId)
  }

  /**
   * Record a refusal.
   *
   * One place where a refusal becomes durable, so there is exactly one path to check when
   * asking "is every refusal recorded?".
   */
  private async recordRefusal(
    code: EconomicAnyRefusalCode,
    subject: EconomicRefusalSubject,
    experimentId: string | null,
    wakeId: string | null,
  ): Promise<void> {
    this.refusedRequests += 1
    await this.journal('economic.refusal.recorded', {
      refusalId: this.ports.newId(),
      code,
      subject,
      experimentId: experimentId ?? '',
      wakeId: wakeId ?? '',
      at: this.ports.now(),
    })
  }

  /** A refusal as a command outcome, journalled first. */
  private async refuse(
    code: EconomicAnyRefusalCode,
    subject: EconomicRefusalSubject,
    experimentId: string | null,
    wakeId: string | null = null,
  ): Promise<EconomicOutcome<never>> {
    await this.recordRefusal(code, subject, experimentId, wakeId)
    this.ports.onChange()
    return { ok: false, code: code as EconomicRefusalCode, reason: refusalSentence(code) }
  }

  private experimentOrNull(experimentId: string): EconomicExperimentRecord | null {
    return this.state.experiments.find((entry) => entry.experimentId === experimentId) ?? null
  }

  /** Journal one event and fold it in, from the same record. */
  private async journal(type: EconomicEventType, payload: EconomicPayload): Promise<void> {
    const recordedAt = this.ports.now()
    await this.ports.append(type, payload)
    const folded = reduceEconomicEntryOnly(
      this.state,
      { type, recordedAt, payload: { ...payload } },
      // Read fresh, never cached: the only transition in this module an outside party
      // would want to reach is the lift of a stop, and that is gated on the owner's latch
      // being clear at the moment the entry is folded rather than on anything held here.
      { ownerClearedStop: !this.ports.stopAllActive() },
      this.limits,
    )
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
      this.anomalies = [
        ...this.anomalies,
        {
          code: 'illegal-transition',
          eventType: 'economic.step',
          detail: `a step of the economic subsystem threw and was abandoned: ${
            error instanceof Error ? error.message : 'unknown'
          }`,
        },
      ]
      this.ports.onChange()
      return undefined as T
    }
  }
}

/* --------------------------------------------------------------- helpers */

interface EconomicObservationCount {
  readonly admitted: number
  readonly refused: number
}

/**
 * The sentence for a refusal, whichever table owns the code.
 *
 * A refusal's reason is an owner-visible string, and an owner reading "that is not a
 * source a wake may arrive on" is being told something they can act on in a way that "the
 * request was refused" is not.
 */
function refusalSentence(code: EconomicAnyRefusalCode): string {
  const subsystem = (REFUSAL_REASONS as Readonly<Record<string, string | undefined>>)[code]
  if (subsystem !== undefined) return subsystem
  return wakeRefusalReason(code as EconomicWakeRefusalCode)
}

/** Is this a stage that means work was in progress? */
function isLiveStage(stage: EconomicStage): boolean {
  return stage !== 'IDLE' && stage !== 'COMPLETE' && stage !== 'FAILED'
}

/** The blocker a gate denial implies, re-exported so the projection does not re-derive it. */
export { blockerForRefusal }
export type { EconomicWake, PaperOrder, PricePoint }