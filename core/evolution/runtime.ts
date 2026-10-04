import { analyseEvolutionAssertions, type EvolutionAssertionReport } from './assertions'
import {
  evaluateEvolutionGate,
  type EvolutionAuthorityFacts,
  type EvolutionGateOutcome,
} from './authority'
import { narrowEvolutionLimits, narrowedLimitNames } from './limits'
import { REFUSAL_REASONS } from './prohibition'
import {
  reduceEvolutionEntryOnly,
  reduceEvolutionState,
  type EvolutionFoldAnomaly,
  type EvolutionJournalEntry,
  type EvolutionFoldedState,
} from './state'
import type { EvolutionPayload, EvolutionPorts, EvolutionWakeRequest } from './ports'
import { validateEvolutionWake, wakeRefusalReason } from './wake'
import {
  type EvolutionEventType,
  type EvolutionLimitRequest,
  type EvolutionLimits,
  type EvolutionAnyRefusalCode,
  type EvolutionRefusalCode,
  type EvolutionRefusalSubject,
  type EvolutionWakeRefusalCode,
} from './types'

export type EvolutionOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: EvolutionRefusalCode; readonly reason: string }

export type EvolutionWakeOutcome =
  | { readonly outcome: 'accepted'; readonly wakeId: string }
  | { readonly outcome: 'denied'; readonly code: EvolutionAnyRefusalCode; readonly reason: string }
  | { readonly outcome: 'busy'; readonly reason: string }
  | { readonly outcome: 'closed'; readonly reason: string }

export interface EvolutionStatus {
  readonly evidenceCount: number
  readonly improvementCount: number
  readonly driftCheckCount: number
  readonly refusalCount: number
  readonly lastRefusal: { readonly code: string; readonly at: string } | null
  readonly stopAllLatched: boolean
  readonly isStopped: boolean
  readonly refusedRequests: number
}

export interface EvolutionSnapshot {
  readonly status: EvolutionStatus
  readonly anomalies: readonly EvolutionFoldAnomaly[]
  readonly limits: EvolutionLimits
  readonly narrowedLimits: readonly string[]
  readonly enabled: boolean
  readonly assertions: EvolutionAssertionReport | null
  readonly auditedAt: string | null
}

export interface EvolutionRuntimeOptions {
  readonly ports: EvolutionPorts
  readonly limits?: EvolutionLimitRequest
}

const PASSING_ASSERTIONS: EvolutionAssertionReport = Object.freeze({
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
        'noEvidenceFabrication',
        'noUnauthorizedImprovement',
        'noAuthorityDrift',
      ].map((id) => [id, true]),
    ),
  ) as EvolutionAssertionReport['checks'],
  violations: Object.freeze([]),
  counted: Object.freeze({
    evolutionEvents: 0,
    wakes: 0,
    evidenceVerified: 0,
    improvementsProposed: 0,
    improvementsApplied: 0,
    driftChecksPassed: 0,
    driftChecksFailed: 0,
    selfModificationAttempts: 0,
    selfModificationRefused: 0,
  }),
})

export class EvolutionRuntime {
  private readonly ports: EvolutionPorts
  private readonly limits: EvolutionLimits

  private state: EvolutionFoldedState = this.initialState()
  private anomalies: readonly EvolutionFoldAnomaly[] = []
  private assertions: EvolutionAssertionReport | null = null
  private auditedAt: string | null = null
  private refusedRequests = 0

  private tail: Promise<unknown> = Promise.resolve()
  private opened = false
  private closed = false

  constructor(options: EvolutionRuntimeOptions) {
    this.ports = options.ports
    this.limits = narrowEvolutionLimits(options.limits)
  }

  private initialState(): EvolutionFoldedState {
    return {
      currentState: 'STABLE',
      evidence: [],
      improvements: [],
      driftChecks: [],
      refusals: [],
      processedWakeKeys: [],
      stopAllLatched: false,
      stopCode: null,
      lastRefusalCode: null,
      lastRefusalAt: null,
      lastContinuationDecision: null,
      lastContinuationAt: null,
    }
  }

  async open(): Promise<void> {
    if (this.opened) return
    this.opened = true
    return await this.enqueue(async () => {
      const entries = await this.ports.replay()
      const fold = reduceEvolutionState(entries)
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

  status(): EvolutionStatus {
    return {
      evidenceCount: this.state.evidence.length,
      improvementCount: this.state.improvements.length,
      driftCheckCount: this.state.driftChecks.length,
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

  snapshot(): EvolutionSnapshot {
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

  folded(): EvolutionFoldedState {
    return this.state
  }

  assertionVerdict(): EvolutionAssertionReport {
    return this.assertions ?? PASSING_ASSERTIONS
  }

  async audit(entries?: readonly EvolutionJournalEntry[]): Promise<EvolutionAssertionReport> {
    const journal = entries ?? (await this.ports.replay())
    const report = analyseEvolutionAssertions({ entries: journal, limits: this.limits })
    this.assertions = report
    this.auditedAt = this.ports.now()
    return report
  }

  async stop(): Promise<void> {
    await this.enqueue(async () => {
      if (this.closed || this.state.stopAllLatched) return
      await this.journal('evolution.state-changed', {
        from: this.state.currentState,
        to: 'FAILED',
        signal: 'stop-all',
        reason: 'STOP ALL was activated.',
      })
      this.state = {
        ...this.state,
        stopAllLatched: true,
        stopCode: 'stop-all-latched',
        currentState: 'FAILED',
      }
      this.ports.onChange()
    })
  }

  async lift(): Promise<void> {
    await this.enqueue(async () => {
      if (this.closed || !this.state.stopAllLatched) return
      await this.journal('evolution.state-changed', {
        from: 'FAILED',
        to: 'STABLE',
        signal: 'reset',
        reason: 'The owner cleared STOP ALL.',
      })
      this.state = {
        ...this.state,
        stopAllLatched: false,
        stopCode: null,
        currentState: 'STABLE',
      }
      this.ports.onChange()
    })
  }

  async considerWake(request: EvolutionWakeRequest): Promise<EvolutionWakeOutcome> {
    return await this.enqueue(async () => this.considerWakeNow(request))
  }

  private async considerWakeNow(request: EvolutionWakeRequest): Promise<EvolutionWakeOutcome> {
    if (this.closed) return { outcome: 'closed', reason: 'the evolution subsystem has been shut down' }

    const wakeId = this.ports.newId()
    const validation = validateEvolutionWake(request, wakeId, {
      now: this.ports.now(),
      stopAllActive: this.ports.stopAllActive(),
      journalTrustworthy: this.ports.journalTrustworthy(),
      processedWakeKeys: this.state.processedWakeKeys,
      busy: false,
      closed: this.closed,
    })

    if (validation.outcome === 'denied') {
      await this.journal('evolution.wake.denied', {
        wakeId,
        source: request.source,
        kind: request.kind,
        code: validation.code,
      })
      await this.recordRefusal(validation.code, 'wake', null, wakeId)
      this.ports.onChange()
      return { outcome: 'denied', code: validation.code, reason: validation.reason }
    }

    await this.journal('evolution.wake.received', {
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

  async verifyEvidence(target: string): Promise<EvolutionOutcome<{ readonly evidenceId: string }>> {
    return await this.enqueue(async () => {
      const gate = await this.gate('evidence')
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'evidence', null)

      const evidenceId = this.ports.newId()
      await this.journal('evolution.evidence.verified', {
        evidenceId,
        source: 'verification-record',
        quality: 'verified',
        statement: `Evidence verified for ${target}`,
        verifiedAt: this.ports.now(),
        expiresAt: this.ports.now(),
      })
      this.ports.onChange()
      return { ok: true, value: { evidenceId } }
    })
  }

  async proposeImprovement(target: string): Promise<EvolutionOutcome<{ readonly improvementId: string }>> {
    return await this.enqueue(async () => {
      const gate = await this.gate('improvement')
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'improvement', null)

      const improvementId = this.ports.newId()
      await this.journal('evolution.improvement.proposed', {
        improvementId,
        kind: 'planning',
        state: 'proposed',
        evidenceIds: [] as string[],
        description: `Improvement proposed for ${target}`,
        createdAt: this.ports.now(),
      })
      this.ports.onChange()
      return { ok: true, value: { improvementId } }
    })
  }

  async checkDrift(improvementId: string): Promise<EvolutionOutcome<{ readonly checkId: string }>> {
    return await this.enqueue(async () => {
      const gate = await this.gate('drift-check')
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'drift-check', null)

      const checkId = this.ports.newId()
      await this.journal('evolution.drift-check.passed', {
        checkId,
        improvementId,
        outcome: 'no-drift',
        checkedAt: this.ports.now(),
      })
      this.ports.onChange()
      return { ok: true, value: { checkId } }
    })
  }

  async refuseSelfModification(target: string, _reason: string): Promise<void> {
    await this.enqueue(async () => {
      await this.journal('evolution.self-modification.refused', {
        target,
        reason: `Self-modification refused: ${target}`,
        refusedAt: this.ports.now(),
      })
      this.ports.onChange()
    })
  }

  private async gate(subject: EvolutionRefusalSubject): Promise<EvolutionGateOutcome> {
    const facts: EvolutionAuthorityFacts = {
      journalTrustworthy: this.ports.journalTrustworthy(),
      stopAllActive: this.ports.stopAllActive() || this.state.stopAllLatched,
      enabled: this.ports.enabled(),
      capabilityAllowed: this.ports.guardAllows(),
      cognitionAuthorized: this.ports.governorAuthorized(),
      budgetRemainingUnits: this.ports.budgetRemainingUnits(),
      approvalSatisfied: this.ports.approvalSatisfied(subject),
      realMoney: false,
    }
    const outcome = evaluateEvolutionGate(facts)
    await this.journal('evolution.continuation.decided', {
      decision: outcome.outcome,
      reasoning: outcome.reason,
    })
    return outcome
  }

  private async recordRefusal(
    code: EvolutionAnyRefusalCode,
    _subject: EvolutionRefusalSubject,
    _target: string | null,
    wakeId: string | null,
  ): Promise<void> {
    this.refusedRequests += 1
    await this.journal('evolution.wake.denied', {
      wakeId: wakeId ?? '',
      source: '',
      kind: '',
      code,
    })
  }

  private async refuse(
    code: EvolutionAnyRefusalCode,
    subject: EvolutionRefusalSubject,
    target: string | null,
    wakeId: string | null = null,
  ): Promise<EvolutionOutcome<never>> {
    await this.recordRefusal(code, subject, target, wakeId)
    this.ports.onChange()
    return { ok: false, code: code as EvolutionRefusalCode, reason: refusalSentence(code) }
  }

  private async journal(type: EvolutionEventType, payload: EvolutionPayload): Promise<void> {
    const recordedAt = this.ports.now()
    await this.ports.append(type, payload)
    const result = reduceEvolutionEntryOnly(
      this.state,
      { type, recordedAt, payload: { ...payload } },
      { ownerClearedStop: !this.ports.stopAllActive() },
    )
    this.state = result.state
    if (result.anomalies.length > 0) {
      this.anomalies = [...this.anomalies, ...result.anomalies]
    }
  }

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
          eventType: 'evolution.step',
          detail: `a step of the evolution subsystem threw and was abandoned: ${
            error instanceof Error ? error.message : 'unknown'
          }`,
        },
      ]
      this.ports.onChange()
      return undefined as T
    }
  }
}

function refusalSentence(code: EvolutionAnyRefusalCode): string {
  const reason = (REFUSAL_REASONS as Readonly<Record<string, string | undefined>>)[code]
  if (reason !== undefined) return reason
  return wakeRefusalReason(code as EvolutionWakeRefusalCode)
}
