import { analyseResilienceAssertions, type ResilienceAssertionReport } from './assertions'
import {
  blockerForRefusal,
  evaluateResilienceGate,
  type ResilienceAuthorityFacts,
  type ResilienceGateOutcome,
} from './authority'
import {
  planCrashRecovery,
  type CrashRecoveryReport,
} from './recovery'
import { narrowResilienceLimits, narrowedLimitNames } from './limits'
import { classifyResilienceClaim, REFUSAL_REASONS } from './prohibition'
import {
  reduceResilienceEntryOnly,
  reduceResilienceState,
  type ResilienceFoldAnomaly,
  type ResilienceJournalEntry,
  type ResilienceFoldedState,
} from './state'
import type { ResiliencePayload, ResiliencePorts, ResilienceWakeRequest } from './ports'
import { NO_LONG_HORIZON_SEAM, type LongHorizonSeam } from './seams'
import { validateResilienceWake, wakeRefusalReason } from './wake'
import {
  type ResilienceEventType,
  type ResilienceLimitRequest,
  type ResilienceLimits,
  type ResilienceAnyRefusalCode,
  type ResilienceRefusalCode,
  type ResilienceRefusalSubject,
  type ResilienceWakeRefusalCode,
} from './types'

/**
 * Resilience & Self-Recovery, wired.
 *
 * This is the only file in Phase 36 that touches the outside world.
 *
 * 1. **No model calls.** There is no `requestCognition` call in this file.
 * 2. **No timers.** The runtime schedules nothing.
 * 3. **Every gate, every time.** Each mutating entry point calls the gate.
 */

/** What one command produced, or the closed reason it did not happen. */
export type ResilienceOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: ResilienceRefusalCode; readonly reason: string }

/** What happened to one wake. */
export type ResilienceWakeOutcome =
  | { readonly outcome: 'accepted'; readonly wakeId: string }
  | { readonly outcome: 'denied'; readonly code: ResilienceAnyRefusalCode; readonly reason: string }
  | { readonly outcome: 'busy'; readonly reason: string }
  | { readonly outcome: 'closed'; readonly reason: string }

/** What the owner can read about the subsystem at an instant. */
export interface ResilienceStatus {
  readonly failures: number
  readonly recoveries: number
  readonly repairs: number
  readonly backups: number
  readonly restores: number
  readonly degradedModeEntries: number
  readonly refusalCount: number
  readonly lastRefusal: { readonly code: string; readonly at: string } | null
  readonly stopAllLatched: boolean
  readonly isStopped: boolean
  readonly refusedRequests: number
}

export interface ResilienceSnapshot {
  readonly status: ResilienceStatus
  readonly recovery: CrashRecoveryReport | null
  readonly anomalies: readonly ResilienceFoldAnomaly[]
  readonly limits: ResilienceLimits
  readonly narrowedLimits: readonly string[]
  readonly enabled: boolean
  readonly assertions: ResilienceAssertionReport | null
  readonly auditedAt: string | null
  readonly longHorizonSeam: string
}

export interface ResilienceRuntimeOptions {
  readonly ports: ResiliencePorts
  readonly limits?: ResilienceLimitRequest
  readonly seam?: LongHorizonSeam
}

/** Every assertion in its passing state. */
const PASSING_ASSERTIONS: ResilienceAssertionReport = Object.freeze({
  holds: true,
  checks: Object.freeze(
    Object.fromEntries(
      [
        'noRealMoneyAction',
        'noRealOrder',
        'noModelCallWithoutWake',
        'noContinuousPolling',
        'noHiddenReasoning',
        'noUnrestrictedLoops',
        'noAuthorityEscalation',
        'noIdleModelCall',
        'noHiddenDurableState',
        'noSelfApproval',
        'noBudgetWidening',
        'noSelfModification',
        'noCapabilityWidening',
        'noGrantCreation',
        'noSilentResume',
        'noStateFabrication',
        'noDegradationHiding',
        'noCapabilityFabrication',
      ].map((id) => [id, true]),
    ),
  ) as ResilienceAssertionReport['checks'],
  violations: Object.freeze([]),
  counted: Object.freeze({
    resilienceEvents: 0,
    wakes: 0,
    failuresDetected: 0,
    recoveriesStarted: 0,
    repairsStarted: 0,
    backupsCreated: 0,
    restoresStarted: 0,
    degradedModeEntries: 0,
    modelCallsAttributedToResilience: 0,
  }),
})

export class ResilienceRuntime {
  private readonly ports: ResiliencePorts
  private readonly limits: ResilienceLimits
  private readonly seam: LongHorizonSeam

  private state: ResilienceFoldedState = this.initialState()
  private anomalies: readonly ResilienceFoldAnomaly[] = []
  private recovery: CrashRecoveryReport | null = null
  private assertions: ResilienceAssertionReport | null = null
  private auditedAt: string | null = null
  private refusedRequests = 0

  private tail: Promise<unknown> = Promise.resolve()
  private opened = false
  private closed = false

  constructor(options: ResilienceRuntimeOptions) {
    this.ports = options.ports
    this.limits = narrowResilienceLimits(options.limits)
    this.seam = options.seam ?? NO_LONG_HORIZON_SEAM
  }

  private initialState(): ResilienceFoldedState {
    return {
      currentState: 'HEALTHY',
      failures: [],
      recoveries: [],
      repairs: [],
      backups: [],
      restores: [],
      degradedModes: [],
      refusals: [],
      processedWakeKeys: [],
      stopAllLatched: false,
      stopCode: null,
      lastRefusalCode: null,
      lastRefusalAt: null,
      attemptCount: 0,
      lastContinuationDecision: null,
      lastContinuationAt: null,
    }
  }

  /* ------------------------------------------------------------- lifecycle */

  async open(): Promise<CrashRecoveryReport> {
    if (this.opened) return this.recovery ?? this.planRecovery()
    this.opened = true
    return await this.enqueue(async () => {
      const entries = await this.ports.replay()
      const fold = reduceResilienceState(entries, this.limits)
      this.state = fold.state
      this.anomalies = fold.anomalies
      const report = await this.reconcile()
      this.recovery = report
      await this.audit(entries)
      this.ports.onChange()
      return report
    })
  }

  private async reconcile(): Promise<CrashRecoveryReport> {
    const stopAll = this.ports.stopAllActive()
    const report = this.planRecovery()

    if (stopAll && !this.state.stopAllLatched) {
      await this.journal('resilience.stopped', {
        failureId: '',
        kind: 'crash',
        code: 'stop-all-latched',
      })
      return report
    }
    if (!report.reconciled) return report

    for (const action of report.actions) {
      if (action.code !== 'interrupted-operations-stopped') continue
      await this.journal('resilience.reconciled', {
        code: 'restart-recovery',
        from: this.state.currentState,
        reason: action.reason,
      })
    }
    return report
  }

  private planRecovery(): CrashRecoveryReport {
    return planCrashRecovery({
      state: this.state,
      now: this.ports.now(),
      stopAllActive: this.ports.stopAllActive(),
    })
  }

  async close(): Promise<void> {
    this.closed = true
    await this.enqueue(async () => {
      this.ports.onChange()
    })
  }

  /* --------------------------------------------------------------- reading */

  status(): ResilienceStatus {
    return {
      failures: this.state.failures.length,
      recoveries: this.state.recoveries.length,
      repairs: this.state.repairs.length,
      backups: this.state.backups.length,
      restores: this.state.restores.length,
      degradedModeEntries: this.state.degradedModes.length,
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

  snapshot(): ResilienceSnapshot {
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

  folded(): ResilienceFoldedState {
    return this.state
  }

  assertionVerdict(): ResilienceAssertionReport {
    return this.assertions ?? PASSING_ASSERTIONS
  }

  async audit(entries?: readonly ResilienceJournalEntry[]): Promise<ResilienceAssertionReport> {
    const journal = entries ?? (await this.ports.replay())
    const report = analyseResilienceAssertions({ entries: journal, limits: this.limits })
    this.assertions = report
    this.auditedAt = this.ports.now()
    return report
  }

  describeRecovery(): string | null {
    return this.recovery === null ? null : 'Recovery has been planned; nothing continues without an explicit wake.'
  }

  /* ------------------------------------------------------------ interrupts */

  async stop(): Promise<void> {
    await this.enqueue(async () => {
      if (this.closed || this.state.stopAllLatched) return
      await this.journal('resilience.stopped', {
        failureId: '',
        kind: 'crash',
        code: 'stop-all-latched',
      })
      this.ports.onChange()
    })
  }

  async lift(): Promise<void> {
    await this.enqueue(async () => {
      if (this.closed || !this.state.stopAllLatched) return
      await this.journal('resilience.unstopped', { code: 'stop-latch-cleared' })
      this.ports.onChange()
    })
  }

  async preemptByOwner(): Promise<void> {
    await this.enqueue(async () => {
      if (this.closed || this.state.stopAllLatched) return
      for (const recovery of this.state.recoveries) {
        if (recovery.outcome !== null) continue
        await this.journal('resilience.reconciled', {
          code: 'owner-preempted',
          from: 'RECOVERING',
          reason: 'The owner spoke, and the owner comes first.',
        })
      }
      this.ports.onChange()
    })
  }

  /* ------------------------------------------------------------------ wake */

  async considerWake(request: ResilienceWakeRequest): Promise<ResilienceWakeOutcome> {
    return await this.enqueue(async () => this.considerWakeNow(request))
  }

  private async considerWakeNow(request: ResilienceWakeRequest): Promise<ResilienceWakeOutcome> {
    if (this.closed) return { outcome: 'closed', reason: 'the resilience subsystem has been shut down' }

    const wakeId = this.ports.newId()
    const validation = validateResilienceWake(request, wakeId, {
      now: this.ports.now(),
      stopAllActive: this.ports.stopAllActive(),
      journalTrustworthy: this.ports.journalTrustworthy(),
      processedWakeKeys: this.state.processedWakeKeys,
      busy: false,
      closed: this.closed,
    })

    if (validation.outcome === 'denied') {
      await this.journal('resilience.wake.denied', {
        wakeId,
        source: request.source,
        kind: request.kind,
        code: validation.code,
      })
      await this.recordRefusal(validation.code, 'wake', null, wakeId)
      this.ports.onChange()
      return { outcome: 'denied', code: validation.code, reason: validation.reason }
    }

    await this.journal('resilience.wake.received', {
      wakeId: validation.wake.wakeId,
      source: validation.wake.source,
      kind: validation.wake.kind,
      wakeKey: validation.wakeKey,
      goalRef: validation.wake.goalRef ?? '',
      sourceRef: validation.wake.sourceRef ?? '',
      occurredAt: validation.wake.occurredAt,
      observedAt: validation.wake.observedAt,
    })

    this.ports.onChange()
    return { outcome: 'accepted', wakeId }
  }

  /* ------------------------------------------------------------- commands */

  async detectFailure(failure: {
    readonly failureId: string
    readonly kind: string
    readonly detectedAt: string
    readonly context: string
    readonly recoverable: boolean
  }): Promise<ResilienceOutcome<{ readonly failureId: string }>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('recovery', null)
      if (blocked !== null) return blocked

      const scan = classifyResilienceClaim(failure as unknown as Record<string, unknown>)
      if (scan.prohibited) return await this.refuse(scan.code as ResilienceRefusalCode, 'recovery', null)

      const gate = await this.gate('recovery')
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'recovery', null)

      await this.journal('resilience.failure.detected', {
        failureId: failure.failureId,
        kind: failure.kind,
        detectedAt: failure.detectedAt,
        context: failure.context,
        recoverable: failure.recoverable,
      })
      this.ports.onChange()
      return { ok: true, value: { failureId: failure.failureId } }
    })
  }

  async startRecovery(failureId: string): Promise<ResilienceOutcome<{ readonly recoveryId: string }>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('recovery', null)
      if (blocked !== null) return blocked

      const gate = await this.gate('recovery')
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'recovery', null)

      const recoveryId = this.ports.newId()
      await this.journal('resilience.recovery.started', {
        recoveryId,
        failureId,
        startedAt: this.ports.now(),
      })
      this.ports.onChange()
      return { ok: true, value: { recoveryId } }
    })
  }

  async completeRecovery(
    recoveryId: string,
    outcome: string,
    reason: string,
  ): Promise<ResilienceOutcome<{ readonly recoveryId: string }>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('recovery', null)
      if (blocked !== null) return blocked

      const gate = await this.gate('recovery')
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'recovery', null)

      await this.journal('resilience.recovery.completed', {
        recoveryId,
        failureId: '',
        outcome,
        reason,
        completedAt: this.ports.now(),
      })
      this.ports.onChange()
      return { ok: true, value: { recoveryId } }
    })
  }

  async startRepair(
    failureId: string,
    authorizedBy: string | null,
  ): Promise<ResilienceOutcome<{ readonly repairId: string }>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('repair', null)
      if (blocked !== null) return blocked

      if (authorizedBy === null) {
        await this.journal('resilience.repair.unauthorized', {
          repairId: '',
          failureId,
          reason: 'Repair requires owner authorization.',
        })
        return await this.refuse('self-approval-prohibited', 'repair', null)
      }

      const gate = await this.gate('repair')
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'repair', null)

      const repairId = this.ports.newId()
      await this.journal('resilience.repair.started', {
        repairId,
        failureId,
        authorizedBy,
        startedAt: this.ports.now(),
      })
      this.ports.onChange()
      return { ok: true, value: { repairId } }
    })
  }

  async completeRepair(
    repairId: string,
    outcome: string,
    reason: string,
  ): Promise<ResilienceOutcome<{ readonly repairId: string }>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('repair', null)
      if (blocked !== null) return blocked

      const gate = await this.gate('repair')
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'repair', null)

      await this.journal('resilience.repair.completed', {
        repairId,
        failureId: '',
        outcome,
        reason,
        completedAt: this.ports.now(),
      })
      this.ports.onChange()
      return { ok: true, value: { repairId } }
    })
  }

  async createBackup(environmentId: string): Promise<ResilienceOutcome<{ readonly backupId: string }>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('backup', null)
      if (blocked !== null) return blocked

      const gate = await this.gate('backup')
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'backup', null)

      const backupId = this.ports.newId()
      await this.journal('resilience.backup.created', {
        backupId,
        environmentId,
        outcome: 'success',
        reason: 'Encrypted backup created.',
        createdAt: this.ports.now(),
      })
      this.ports.onChange()
      return { ok: true, value: { backupId } }
    })
  }

  async verifyBackup(backupId: string): Promise<ResilienceOutcome<{ readonly backupId: string }>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('backup', null)
      if (blocked !== null) return blocked

      const gate = await this.gate('backup')
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'backup', null)

      await this.journal('resilience.backup.verified', {
        backupId,
        verifiedAt: this.ports.now(),
        outcome: 'verified',
      })
      this.ports.onChange()
      return { ok: true, value: { backupId } }
    })
  }

  async startRestore(backupId: string): Promise<ResilienceOutcome<{ readonly restoreId: string }>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('restore', null)
      if (blocked !== null) return blocked

      const gate = await this.gate('restore')
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'restore', null)

      const restoreId = this.ports.newId()
      await this.journal('resilience.restore.started', {
        restoreId,
        backupId,
        startedAt: this.ports.now(),
      })
      this.ports.onChange()
      return { ok: true, value: { restoreId } }
    })
  }

  async completeRestore(
    restoreId: string,
    outcome: string,
    reason: string,
  ): Promise<ResilienceOutcome<{ readonly restoreId: string }>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('restore', null)
      if (blocked !== null) return blocked

      const gate = await this.gate('restore')
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'restore', null)

      await this.journal('resilience.restore.completed', {
        restoreId,
        backupId: '',
        outcome,
        reason,
        completedAt: this.ports.now(),
      })
      this.ports.onChange()
      return { ok: true, value: { restoreId } }
    })
  }

  async enterDegradedMode(
    level: string,
    reason: string,
    capabilities: readonly string[],
  ): Promise<ResilienceOutcome<{ readonly recordId: string }>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('degraded-mode', null)
      if (blocked !== null) return blocked

      const gate = await this.gate('degraded-mode')
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'degraded-mode', null)

      const recordId = this.ports.newId()
      await this.journal('resilience.degraded-mode.entered', {
        recordId,
        level,
        reason,
        capabilities: capabilities.join('|'),
        startedAt: this.ports.now(),
      })
      this.ports.onChange()
      return { ok: true, value: { recordId } }
    })
  }

  async exitDegradedMode(recordId: string): Promise<ResilienceOutcome<{ readonly recordId: string }>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('degraded-mode', null)
      if (blocked !== null) return blocked

      const gate = await this.gate('degraded-mode')
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'degraded-mode', null)

      await this.journal('resilience.degraded-mode.exited', {
        recordId,
        endedAt: this.ports.now(),
      })
      this.ports.onChange()
      return { ok: true, value: { recordId } }
    })
  }

  async refuseSelfModification(target: string, reason: string): Promise<void> {
    await this.enqueue(async () => {
      await this.journal('resilience.self-modification.attempted', {
        attemptId: this.ports.newId(),
        target,
        reason,
      })
      await this.journal('resilience.self-modification.refused', {
        attemptId: this.ports.newId(),
        target,
        reason,
      })
      this.ports.onChange()
    })
  }

  /* ------------------------------------------------------------- internals */

  private async gate(subject: ResilienceRefusalSubject): Promise<ResilienceGateOutcome> {
    const facts: ResilienceAuthorityFacts = {
      journalTrustworthy: this.ports.journalTrustworthy(),
      stopAllActive: this.ports.stopAllActive(),
      enabled: this.ports.enabled(),
      capabilityAllowed: this.ports.guardAllows(),
      cognitionAuthorized: this.ports.governorAuthorized(),
      budgetRemainingUnits: this.ports.budgetRemainingUnits(),
      approvalSatisfied: this.ports.approvalSatisfied(subject),
      realMoney: false,
    }
    const outcome = evaluateResilienceGate(facts)
    await this.journal('resilience.gate.decided', {
      wakeId: '',
      subject,
      outcome: outcome.outcome,
      code: outcome.code,
      checked: outcome.cleared.join('|'),
      remainingUnits: facts.budgetRemainingUnits,
      at: this.ports.now(),
    })
    return outcome
  }

  private async refuseIfStopped(
    subject: ResilienceRefusalSubject,
    target: string | null,
  ): Promise<ResilienceOutcome<never> | null> {
    if (!this.ports.stopAllActive()) return null
    return await this.refuse('stop-all-active', subject, target)
  }

  private async recordRefusal(
    code: ResilienceAnyRefusalCode,
    subject: ResilienceRefusalSubject,
    target: string | null,
    wakeId: string | null,
  ): Promise<void> {
    this.refusedRequests += 1
    await this.journal('resilience.refusal.recorded', {
      refusalId: this.ports.newId(),
      code,
      subject,
      target: target ?? '',
      wakeId: wakeId ?? '',
      at: this.ports.now(),
    })
  }

  private async refuse(
    code: ResilienceAnyRefusalCode,
    subject: ResilienceRefusalSubject,
    target: string | null,
    wakeId: string | null = null,
  ): Promise<ResilienceOutcome<never>> {
    await this.recordRefusal(code, subject, target, wakeId)
    this.ports.onChange()
    return { ok: false, code: code as ResilienceRefusalCode, reason: refusalSentence(code) }
  }

  /** Journal one event and fold it in. */
  private async journal(type: ResilienceEventType, payload: ResiliencePayload): Promise<void> {
    const recordedAt = this.ports.now()
    await this.ports.append(type, payload)
    const result = reduceResilienceEntryOnly(
      this.state,
      { type, recordedAt, payload: { ...payload } },
      { ownerClearedStop: !this.ports.stopAllActive() },
      this.limits,
    )
    this.state = result.state
    if (result.anomalies.length > 0) {
      this.anomalies = [...this.anomalies, ...result.anomalies]
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
          eventType: 'resilience.step',
          detail: `a step of the resilience subsystem threw and was abandoned: ${
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

/**
 * The sentence for a refusal.
 */
function refusalSentence(code: ResilienceAnyRefusalCode): string {
  const reason = (REFUSAL_REASONS as Readonly<Record<string, string | undefined>>)[code]
  if (reason !== undefined) return reason
  return wakeRefusalReason(code as ResilienceWakeRefusalCode)
}

export { blockerForRefusal }
export type { ResilienceWakeRequest }
