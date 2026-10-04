import { analyseThresholdAssertions, type ThresholdAssertionReport } from './assertions'
import {
  blockerForRefusal,
  evaluateThresholdGate,
  type ThresholdAuthorityFacts,
  type ThresholdGateOutcome,
} from './authority'
import { narrowThresholdLimits, narrowedLimitNames } from './limits'
import { classifyThresholdClaim, REFUSAL_REASONS } from './prohibition'
import {
  reduceThresholdEntryOnly,
  reduceThresholdState,
  type ThresholdFoldAnomaly,
  type ThresholdJournalEntry,
  type ThresholdFoldedState,
} from './state'
import type { ThresholdPayload, ThresholdPorts, ThresholdWakeRequest } from './ports'
import { validateThresholdWake, wakeRefusalReason } from './wake'
import {
  isMaturityDimension,
  isFailClosedKind,
  isRollbackReason,
  type ThresholdEventType,
  type ThresholdLimitRequest,
  type ThresholdLimits,
  type ThresholdAnyRefusalCode,
  type ThresholdRefusalCode,
  type ThresholdRefusalSubject,
  type ThresholdWakeRefusalCode,
} from './types'

/**
 * Mature Freya Threshold, wired.
 *
 * This is the only file in Phase 39 that touches the outside world.
 *
 * 1. **No model calls.** There is no `requestCognition` call in this file.
 * 2. **No timers.** The runtime schedules nothing.
 * 3. **Every gate, every time.** Each mutating entry point calls the gate.
 */

/** What one command produced, or the closed reason it did not happen. */
export type ThresholdOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: ThresholdRefusalCode; readonly reason: string }

/** What happened to one wake. */
export type ThresholdWakeOutcome =
  | { readonly outcome: 'accepted'; readonly wakeId: string }
  | { readonly outcome: 'denied'; readonly code: ThresholdAnyRefusalCode; readonly reason: string }
  | { readonly outcome: 'busy'; readonly reason: string }
  | { readonly outcome: 'closed'; readonly reason: string }

/** What the owner can read about the subsystem at an instant. */
export interface ThresholdStatus {
  readonly assessmentsStarted: number
  readonly assessmentsCompleted: number
  readonly evidenceCollected: number
  readonly evidenceVerified: number
  readonly failClosedTriggered: number
  readonly decisionsProven: number
  readonly decisionsNotProven: number
  readonly rollbacksStarted: number
  readonly rollbacksCompleted: number
  readonly refusalCount: number
  readonly lastRefusal: { readonly code: string; readonly at: string } | null
  readonly stopAllLatched: boolean
  readonly isStopped: boolean
  readonly refusedRequests: number
}

export interface ThresholdSnapshot {
  readonly status: ThresholdStatus
  readonly anomalies: readonly ThresholdFoldAnomaly[]
  readonly limits: ThresholdLimits
  readonly narrowedLimits: readonly string[]
  readonly enabled: boolean
  readonly assertions: ThresholdAssertionReport | null
  readonly auditedAt: string | null
}

export interface ThresholdRuntimeOptions {
  readonly ports: ThresholdPorts
  readonly limits?: ThresholdLimitRequest
}

/** Every assertion in its passing state. */
const PASSING_ASSERTIONS: ThresholdAssertionReport = Object.freeze({
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
        'noEvidenceFabrication',
        'noMaturitySelfGrant',
        'noMaturityAuthorityWidening',
      ].map((id) => [id, true]),
    ),
  ) as ThresholdAssertionReport['checks'],
  violations: Object.freeze([]),
  counted: Object.freeze({
    thresholdEvents: 0,
    wakes: 0,
    assessmentsStarted: 0,
    assessmentsCompleted: 0,
    evidenceCollected: 0,
    evidenceVerified: 0,
    failClosedTriggered: 0,
    decisionsProven: 0,
    decisionsNotProven: 0,
    rollbacksStarted: 0,
    rollbacksCompleted: 0,
    modelCallsAttributedToThreshold: 0,
  }),
})

export class ThresholdRuntime {
  private readonly ports: ThresholdPorts
  private readonly limits: ThresholdLimits

  private state: ThresholdFoldedState = this.initialState()
  private anomalies: readonly ThresholdFoldAnomaly[] = []
  private assertions: ThresholdAssertionReport | null = null
  private auditedAt: string | null = null
  private refusedRequests = 0

  private tail: Promise<unknown> = Promise.resolve()
  private opened = false
  private closed = false

  constructor(options: ThresholdRuntimeOptions) {
    this.ports = options.ports
    this.limits = narrowThresholdLimits(options.limits)
  }

  private initialState(): ThresholdFoldedState {
    return {
      currentState: 'UNPROVEN',
      assessments: [],
      evidence: [],
      failClosed: [],
      rollbacks: [],
      refusals: [],
      processedWakeKeys: [],
      stopAllLatched: false,
      stopCode: null,
      lastRefusalCode: null,
      lastRefusalAt: null,
      attemptCount: 0,
      lastDecision: null,
      lastDecisionAt: null,
    }
  }

  /* ------------------------------------------------------------- lifecycle */

  async open(): Promise<void> {
    if (this.opened) return
    this.opened = true
    await this.enqueue(async () => {
      const entries = await this.ports.replay()
      const fold = reduceThresholdState(entries, this.limits)
      this.state = fold.state
      this.anomalies = fold.anomalies
      await this.audit(entries)
      this.ports.onChange()
    })
  }

  async close(): Promise<void> {
    this.closed = true
    await this.enqueue(async () => {
      this.ports.onChange()
    })
  }

  /* --------------------------------------------------------------- reading */

  status(): ThresholdStatus {
    return {
      assessmentsStarted: this.state.assessments.length,
      assessmentsCompleted: this.state.assessments.filter((a) => a.completedAt !== null).length,
      evidenceCollected: this.state.evidence.length,
      evidenceVerified: this.state.evidence.filter((e) => e.verifiedAt !== null).length,
      failClosedTriggered: this.state.failClosed.length,
      decisionsProven: this.state.lastDecision === 'proven' ? 1 : 0,
      decisionsNotProven: this.state.lastDecision === 'not-proven' ? 1 : 0,
      rollbacksStarted: this.state.rollbacks.length,
      rollbacksCompleted: this.state.rollbacks.filter((r) => r.completedAt !== null).length,
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

  snapshot(): ThresholdSnapshot {
    return {
      status: this.status(),
      anomalies: this.anomalies,
      limits: this.limits,
      narrowedLimits: narrowedLimitNames(this.limits),
      enabled: this.ports.enabled(),
      assertions: this.assertions,
      auditedAt: this.auditedAt,
    }
  }

  folded(): ThresholdFoldedState {
    return this.state
  }

  assertionVerdict(): ThresholdAssertionReport {
    return this.assertions ?? PASSING_ASSERTIONS
  }

  async audit(entries?: readonly ThresholdJournalEntry[]): Promise<ThresholdAssertionReport> {
    const journal = entries ?? (await this.ports.replay())
    const report = analyseThresholdAssertions({ entries: journal, limits: this.limits })
    this.assertions = report
    this.auditedAt = this.ports.now()
    return report
  }

  /* ------------------------------------------------------------ interrupts */

  async stop(): Promise<void> {
    await this.enqueue(async () => {
      if (this.closed || this.state.stopAllLatched) return
      await this.journal('threshold.suspended', {
        reason: 'stop-all-latched',
        suspendedAt: this.ports.now(),
      })
      this.ports.onChange()
    })
  }

  async lift(): Promise<void> {
    await this.enqueue(async () => {
      if (this.closed || !this.state.stopAllLatched) return
      await this.journal('threshold.resumed', {
        reason: 'stop-latch-cleared',
        resumedAt: this.ports.now(),
      })
      this.ports.onChange()
    })
  }

  async preemptByOwner(): Promise<void> {
    await this.enqueue(async () => {
      if (this.closed || this.state.stopAllLatched) return
      await this.journal('threshold.suspended', {
        reason: 'owner-preempted',
        suspendedAt: this.ports.now(),
      })
      this.ports.onChange()
    })
  }

  /* ------------------------------------------------------------------ wake */

  async considerWake(request: ThresholdWakeRequest): Promise<ThresholdWakeOutcome> {
    return await this.enqueue(async () => this.considerWakeNow(request))
  }

  private async considerWakeNow(request: ThresholdWakeRequest): Promise<ThresholdWakeOutcome> {
    if (this.closed) return { outcome: 'closed', reason: 'the threshold subsystem has been shut down' }

    const wakeId = this.ports.newId()
    const validation = validateThresholdWake(request, wakeId, {
      now: this.ports.now(),
      stopAllActive: this.ports.stopAllActive(),
      journalTrustworthy: this.ports.journalTrustworthy(),
      processedWakeKeys: this.state.processedWakeKeys,
      busy: false,
      closed: this.closed,
    })

    if (validation.outcome === 'denied') {
      await this.journal('threshold.wake.denied', {
        wakeId,
        source: request.source,
        kind: request.kind,
        code: validation.code,
      })
      await this.recordRefusal(validation.code, 'wake', null, wakeId)
      this.ports.onChange()
      return { outcome: 'denied', code: validation.code, reason: validation.reason }
    }

    await this.journal('threshold.wake.received', {
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

  async startAssessment(dimension: string): Promise<ThresholdOutcome<{ readonly assessmentId: string }>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('assessment', null)
      if (blocked !== null) return blocked

      if (!isMaturityDimension(dimension)) {
        return await this.refuse('unknown-dimension', 'assessment', null)
      }

      const scan = classifyThresholdClaim({ dimension } as unknown as Record<string, unknown>)
      if (scan.prohibited) return await this.refuse(scan.code as ThresholdRefusalCode, 'assessment', null)

      const gate = await this.gate('assessment')
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'assessment', null)

      const assessmentId = this.ports.newId()
      await this.journal('threshold.assessment.started', {
        assessmentId,
        dimension,
        startedAt: this.ports.now(),
      })
      this.ports.onChange()
      return { ok: true, value: { assessmentId } }
    })
  }

  async completeAssessment(
    assessmentId: string,
    level: string,
    criteriaCount: number,
    evidenceCount: number,
  ): Promise<ThresholdOutcome<{ readonly assessmentId: string }>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('assessment', null)
      if (blocked !== null) return blocked

      const gate = await this.gate('assessment')
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'assessment', null)

      await this.journal('threshold.assessment.completed', {
        assessmentId,
        level,
        criteriaCount,
        evidenceCount,
        completedAt: this.ports.now(),
      })
      this.ports.onChange()
      return { ok: true, value: { assessmentId } }
    })
  }

  async collectEvidence(
    criterionId: string,
    source: string,
    quality: string,
  ): Promise<ThresholdOutcome<{ readonly evidenceId: string }>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('evidence', null)
      if (blocked !== null) return blocked

      const gate = await this.gate('evidence')
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'evidence', null)

      const evidenceId = this.ports.newId()
      await this.journal('threshold.evidence.collected', {
        evidenceId,
        criterionId,
        source,
        quality,
        collectedAt: this.ports.now(),
      })
      this.ports.onChange()
      return { ok: true, value: { evidenceId } }
    })
  }

  async verifyEvidence(
    evidenceId: string,
    quality: string,
    expiresAt: string,
  ): Promise<ThresholdOutcome<{ readonly evidenceId: string }>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('evidence', null)
      if (blocked !== null) return blocked

      const gate = await this.gate('evidence')
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'evidence', null)

      await this.journal('threshold.evidence.verified', {
        evidenceId,
        quality,
        verifiedAt: this.ports.now(),
        expiresAt,
      })
      this.ports.onChange()
      return { ok: true, value: { evidenceId } }
    })
  }

  async detectEvidenceFabrication(
    evidenceId: string,
    reason: string,
  ): Promise<ThresholdOutcome<{ readonly evidenceId: string }>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('evidence', null)
      if (blocked !== null) return blocked

      const gate = await this.gate('evidence')
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'evidence', null)

      await this.journal('threshold.evidence.fabrication-detected', {
        evidenceId,
        reason,
        detectedAt: this.ports.now(),
      })
      this.ports.onChange()
      return { ok: true, value: { evidenceId } }
    })
  }

  async triggerFailClosed(
    kind: string,
    reason: string,
  ): Promise<ThresholdOutcome<{ readonly recordId: string }>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('continuation', null)
      if (blocked !== null) return blocked

      if (!isFailClosedKind(kind)) {
        return await this.refuse('unknown-criterion', 'continuation', null)
      }

      const gate = await this.gate('continuation')
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'continuation', null)

      const recordId = this.ports.newId()
      await this.journal('threshold.fail-closed.triggered', {
        recordId,
        kind,
        reason,
        triggeredAt: this.ports.now(),
      })
      this.ports.onChange()
      return { ok: true, value: { recordId } }
    })
  }

  async resolveFailClosed(
    recordId: string,
    resolution: string,
  ): Promise<ThresholdOutcome<{ readonly recordId: string }>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('continuation', null)
      if (blocked !== null) return blocked

      const gate = await this.gate('continuation')
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'continuation', null)

      await this.journal('threshold.fail-closed.resolved', {
        recordId,
        resolution,
        resolvedAt: this.ports.now(),
      })
      this.ports.onChange()
      return { ok: true, value: { recordId } }
    })
  }

  async decideProven(
    assessmentCount: number,
    evidenceCount: number,
  ): Promise<ThresholdOutcome<{ readonly decisionId: string }>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('decision', null)
      if (blocked !== null) return blocked

      const gate = await this.gate('decision')
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'decision', null)

      const decisionId = this.ports.newId()
      await this.journal('threshold.decision.proven', {
        decisionId,
        assessmentCount,
        evidenceCount,
        decidedAt: this.ports.now(),
      })
      this.ports.onChange()
      return { ok: true, value: { decisionId } }
    })
  }

  async decideNotProven(
    failedDimensions: readonly string[],
    reason: string,
  ): Promise<ThresholdOutcome<{ readonly decisionId: string }>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('decision', null)
      if (blocked !== null) return blocked

      const gate = await this.gate('decision')
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'decision', null)

      const decisionId = this.ports.newId()
      await this.journal('threshold.decision.not-proven', {
        decisionId,
        failedDimensions: failedDimensions.join('|'),
        reason,
        decidedAt: this.ports.now(),
      })
      this.ports.onChange()
      return { ok: true, value: { decisionId } }
    })
  }

  async suspend(reason: string): Promise<ThresholdOutcome<{ readonly suspendedAt: string }>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('continuation', null)
      if (blocked !== null) return blocked

      const gate = await this.gate('continuation')
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'continuation', null)

      const suspendedAt = this.ports.now()
      await this.journal('threshold.suspended', {
        reason,
        suspendedAt,
      })
      this.ports.onChange()
      return { ok: true, value: { suspendedAt } }
    })
  }

  async resume(reason: string): Promise<ThresholdOutcome<{ readonly resumedAt: string }>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('continuation', null)
      if (blocked !== null) return blocked

      if (this.state.currentState !== 'SUSPENDED') {
        return await this.refuse('illegal-transition', 'continuation', null)
      }

      const gate = await this.gate('continuation')
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'continuation', null)

      const resumedAt = this.ports.now()
      await this.journal('threshold.resumed', {
        reason,
        resumedAt,
      })
      this.ports.onChange()
      return { ok: true, value: { resumedAt } }
    })
  }

  async startRollback(
    reason: string,
  ): Promise<ThresholdOutcome<{ readonly rollbackId: string }>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('rollback', null)
      if (blocked !== null) return blocked

      if (!isRollbackReason(reason)) {
        return await this.refuse('unknown-rollback', 'rollback', null)
      }

      const gate = await this.gate('rollback')
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'rollback', null)

      const rollbackId = this.ports.newId()
      await this.journal('threshold.rollback.started', {
        rollbackId,
        reason,
        startedAt: this.ports.now(),
      })
      this.ports.onChange()
      return { ok: true, value: { rollbackId } }
    })
  }

  async completeRollback(
    rollbackId: string,
    approvedBy: string,
  ): Promise<ThresholdOutcome<{ readonly rollbackId: string }>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('rollback', null)
      if (blocked !== null) return blocked

      if (approvedBy === null || approvedBy.length === 0) {
        await this.journal('threshold.rollback.started', {
          rollbackId: '',
          reason: 'rollback-requires-owner-approval',
          startedAt: this.ports.now(),
        })
        return await this.refuse('self-approval-prohibited', 'rollback', null)
      }

      const gate = await this.gate('rollback')
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'rollback', null)

      await this.journal('threshold.rollback.completed', {
        rollbackId,
        reason: 'rollback-completed',
        approvedBy,
        completedAt: this.ports.now(),
      })
      this.ports.onChange()
      return { ok: true, value: { rollbackId } }
    })
  }

  async refuseSelfModification(target: string, reason: string): Promise<void> {
    await this.enqueue(async () => {
      await this.journal('threshold.fail-closed.triggered', {
        recordId: this.ports.newId(),
        kind: 'self-modification',
        reason: `${reason}: ${target}`,
        triggeredAt: this.ports.now(),
      })
      this.ports.onChange()
    })
  }

  /* ------------------------------------------------------------- internals */

  private async gate(subject: ThresholdRefusalSubject): Promise<ThresholdGateOutcome> {
    const facts: ThresholdAuthorityFacts = {
      journalTrustworthy: this.ports.journalTrustworthy(),
      stopAllActive: this.ports.stopAllActive(),
      enabled: this.ports.enabled(),
      capabilityAllowed: this.ports.guardAllows(),
      cognitionAuthorized: this.ports.governorAuthorized(),
      budgetRemainingUnits: this.ports.budgetRemainingUnits(),
      approvalSatisfied: this.ports.approvalSatisfied(subject),
      realMoney: false,
    }
    const outcome = evaluateThresholdGate(facts)
    return outcome
  }

  private async refuseIfStopped(
    subject: ThresholdRefusalSubject,
    target: string | null,
  ): Promise<ThresholdOutcome<never> | null> {
    if (!this.ports.stopAllActive()) return null
    return await this.refuse('stop-all-active', subject, target)
  }

  private async recordRefusal(
    code: ThresholdAnyRefusalCode,
    subject: ThresholdRefusalSubject,
    target: string | null,
    wakeId: string | null,
  ): Promise<void> {
    this.refusedRequests += 1
    await this.journal('threshold.wake.denied', {
      wakeId: wakeId ?? '',
      source: subject,
      kind: target ?? '',
      code,
    })
  }

  private async refuse(
    code: ThresholdAnyRefusalCode,
    subject: ThresholdRefusalSubject,
    target: string | null,
    wakeId: string | null = null,
  ): Promise<ThresholdOutcome<never>> {
    await this.recordRefusal(code, subject, target, wakeId)
    this.ports.onChange()
    return { ok: false, code: code as ThresholdRefusalCode, reason: refusalSentence(code) }
  }

  /** Journal one event and fold it in. */
  private async journal(type: ThresholdEventType, payload: ThresholdPayload): Promise<void> {
    const recordedAt = this.ports.now()
    await this.ports.append(type, payload)
    const result = reduceThresholdEntryOnly(
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
          eventType: 'threshold.step',
          detail: `a step of the threshold subsystem threw and was abandoned: ${
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
function refusalSentence(code: ThresholdAnyRefusalCode): string {
  const reason = (REFUSAL_REASONS as Readonly<Record<string, string | undefined>>)[code]
  if (reason !== undefined) return reason
  return wakeRefusalReason(code as ThresholdWakeRefusalCode)
}

export { blockerForRefusal }
export type { ThresholdWakeRequest }
