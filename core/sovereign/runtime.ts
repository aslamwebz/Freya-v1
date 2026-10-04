import { analyseSovereigntyAssertions, type SovereigntyAssertionReport } from './assertions'
import {
  evaluateSovereigntyGate,
  type SovereigntyAuthorityFacts,
  type SovereigntyGateOutcome,
} from './authority'
import { narrowSovereigntyLimits, narrowedLimitNames } from './limits'
import { REFUSAL_REASONS } from './prohibition'
import {
  reduceSovereigntyEntryOnly,
  reduceSovereigntyState,
  type SovereigntyFoldAnomaly,
  type SovereigntyJournalEntry,
  type SovereigntyFoldedState,
} from './state'
import type { SovereigntyPayload, SovereigntyPorts, SovereigntyWakeRequest } from './ports'
import { validateSovereigntyWake, wakeRefusalReason } from './wake'
import {
  type SovereigntyEventType,
  type SovereigntyLimitRequest,
  type SovereigntyLimits,
  type SovereigntyAnyRefusalCode,
  type SovereigntyRefusalCode,
  type SovereigntyRefusalSubject,
  type SovereigntyWakeRefusalCode,
} from './types'

export type SovereigntyOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: SovereigntyRefusalCode; readonly reason: string }

export type SovereigntyWakeOutcome =
  | { readonly outcome: 'accepted'; readonly wakeId: string }
  | { readonly outcome: 'denied'; readonly code: SovereigntyAnyRefusalCode; readonly reason: string }
  | { readonly outcome: 'busy'; readonly reason: string }
  | { readonly outcome: 'closed'; readonly reason: string }

export interface SovereigntyStatus {
  readonly providers: number
  readonly routingDecisions: number
  readonly offlineSessions: number
  readonly portableDataRecords: number
  readonly refusalCount: number
  readonly lastRefusal: { readonly code: string; readonly at: string } | null
  readonly stopAllLatched: boolean
  readonly isStopped: boolean
  readonly refusedRequests: number
}

export interface SovereigntySnapshot {
  readonly status: SovereigntyStatus
  readonly anomalies: readonly SovereigntyFoldAnomaly[]
  readonly limits: SovereigntyLimits
  readonly narrowedLimits: readonly string[]
  readonly enabled: boolean
  readonly assertions: SovereigntyAssertionReport | null
  readonly auditedAt: string | null
}

export interface SovereigntyRuntimeOptions {
  readonly ports: SovereigntyPorts
  readonly limits?: SovereigntyLimitRequest
}

const PASSING_ASSERTIONS: SovereigntyAssertionReport = Object.freeze({
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
        'noPlaintextStorage',
        'noIntegrityFabrication',
      ].map((id) => [id, true]),
    ),
  ) as SovereigntyAssertionReport['checks'],
  violations: Object.freeze([]),
  counted: Object.freeze({
    sovereigntyEvents: 0,
    wakes: 0,
    providerRouted: 0,
    providerFallback: 0,
    providerFailed: 0,
    offlineStarted: 0,
    offlineEnded: 0,
    portableDataExported: 0,
    portableDataImported: 0,
    portableDataVerified: 0,
    modelCallsAttributedToSovereignty: 0,
  }),
})

export class SovereigntyRuntime {
  private readonly ports: SovereigntyPorts
  private readonly limits: SovereigntyLimits

  private state: SovereigntyFoldedState = this.initialState()
  private anomalies: readonly SovereigntyFoldAnomaly[] = []
  private assertions: SovereigntyAssertionReport | null = null
  private auditedAt: string | null = null
  private refusedRequests = 0

  private tail: Promise<unknown> = Promise.resolve()
  private opened = false
  private closed = false

  constructor(options: SovereigntyRuntimeOptions) {
    this.ports = options.ports
    this.limits = narrowSovereigntyLimits(options.limits)
  }

  private initialState(): SovereigntyFoldedState {
    return {
      currentState: 'ONLINE',
      providers: [],
      routingDecisions: [],
      offlineSessions: [],
      portableDataRecords: [],
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
      const fold = reduceSovereigntyState(entries, this.limits)
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

  status(): SovereigntyStatus {
    return {
      providers: this.state.providers.length,
      routingDecisions: this.state.routingDecisions.length,
      offlineSessions: this.state.offlineSessions.length,
      portableDataRecords: this.state.portableDataRecords.length,
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

  snapshot(): SovereigntySnapshot {
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

  folded(): SovereigntyFoldedState {
    return this.state
  }

  assertionVerdict(): SovereigntyAssertionReport {
    return this.assertions ?? PASSING_ASSERTIONS
  }

  async audit(entries?: readonly SovereigntyJournalEntry[]): Promise<SovereigntyAssertionReport> {
    const journal = entries ?? (await this.ports.replay())
    const report = analyseSovereigntyAssertions({ entries: journal, limits: this.limits })
    this.assertions = report
    this.auditedAt = this.ports.now()
    return report
  }

  async stop(): Promise<void> {
    await this.enqueue(async () => {
      if (this.closed || this.state.stopAllLatched) return
      await this.journal('sovereignty.state-changed', {
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
      await this.journal('sovereignty.state-changed', {
        from: 'FAILED',
        to: 'ONLINE',
        signal: 'reset',
        reason: 'The owner cleared STOP ALL.',
      })
      this.state = {
        ...this.state,
        stopAllLatched: false,
        stopCode: null,
        currentState: 'ONLINE',
      }
      this.ports.onChange()
    })
  }

  async considerWake(request: SovereigntyWakeRequest): Promise<SovereigntyWakeOutcome> {
    return await this.enqueue(async () => this.considerWakeNow(request))
  }

  private async considerWakeNow(request: SovereigntyWakeRequest): Promise<SovereigntyWakeOutcome> {
    if (this.closed) return { outcome: 'closed', reason: 'the sovereignty subsystem has been shut down' }

    const wakeId = this.ports.newId()
    const validation = validateSovereigntyWake(request, wakeId, {
      now: this.ports.now(),
      stopAllActive: this.ports.stopAllActive(),
      journalTrustworthy: this.ports.journalTrustworthy(),
      processedWakeKeys: this.state.processedWakeKeys,
      busy: false,
      closed: this.closed,
    })

    if (validation.outcome === 'denied') {
      await this.journal('sovereignty.wake.denied', {
        wakeId,
        source: request.source,
        kind: request.kind,
        code: validation.code,
      })
      await this.recordRefusal(validation.code, 'wake', null, wakeId)
      this.ports.onChange()
      return { outcome: 'denied', code: validation.code, reason: validation.reason }
    }

    await this.journal('sovereignty.wake.received', {
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

  async routeProvider(providerId: string, reason: string): Promise<SovereigntyOutcome<{ readonly decisionId: string }>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('provider', null)
      if (blocked !== null) return blocked

      const gate = await this.gate('provider')
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'provider', null)

      const decisionId = this.ports.newId()
      await this.journal('sovereignty.provider.routed', {
        decisionId,
        providerId,
        reason,
        routedAt: this.ports.now(),
      })
      this.ports.onChange()
      return { ok: true, value: { decisionId } }
    })
  }

  async fallbackProvider(fromProviderId: string, toProviderId: string): Promise<SovereigntyOutcome<{ readonly decisionId: string }>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('provider', null)
      if (blocked !== null) return blocked

      const gate = await this.gate('provider')
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'provider', null)

      const decisionId = this.ports.newId()
      await this.journal('sovereignty.provider.fallback', {
        decisionId,
        fromProviderId,
        toProviderId,
        reason: 'Fallback to alternative provider.',
      })
      this.ports.onChange()
      return { ok: true, value: { decisionId } }
    })
  }

  async startOffline(mode: string): Promise<SovereigntyOutcome<{ readonly sessionId: string }>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('offline', null)
      if (blocked !== null) return blocked

      const gate = await this.gate('offline')
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'offline', null)

      const sessionId = this.ports.newId()
      await this.journal('sovereignty.offline.started', {
        sessionId,
        mode,
        startedAt: this.ports.now(),
      })
      this.ports.onChange()
      return { ok: true, value: { sessionId } }
    })
  }

  async endOffline(sessionId: string, reasoningCount: number): Promise<SovereigntyOutcome<{ readonly sessionId: string }>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('offline', null)
      if (blocked !== null) return blocked

      const gate = await this.gate('offline')
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'offline', null)

      await this.journal('sovereignty.offline.ended', {
        sessionId,
        endedAt: this.ports.now(),
        reasoningCount,
      })
      this.ports.onChange()
      return { ok: true, value: { sessionId } }
    })
  }

  async exportData(dataHash: string, encryptionVersion: string): Promise<SovereigntyOutcome<{ readonly recordId: string }>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('portable-data', null)
      if (blocked !== null) return blocked

      const gate = await this.gate('portable-data')
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'portable-data', null)

      const recordId = this.ports.newId()
      await this.journal('sovereignty.portable-data.exported', {
        recordId,
        dataHash,
        encryptionVersion,
        createdAt: this.ports.now(),
      })
      this.ports.onChange()
      return { ok: true, value: { recordId } }
    })
  }

  async importData(dataHash: string, encryptionVersion: string): Promise<SovereigntyOutcome<{ readonly recordId: string }>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('portable-data', null)
      if (blocked !== null) return blocked

      const gate = await this.gate('portable-data')
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'portable-data', null)

      const recordId = this.ports.newId()
      await this.journal('sovereignty.portable-data.imported', {
        recordId,
        dataHash,
        encryptionVersion,
        createdAt: this.ports.now(),
      })
      this.ports.onChange()
      return { ok: true, value: { recordId } }
    })
  }

  async verifyData(recordId: string, dataHash: string): Promise<SovereigntyOutcome<{ readonly recordId: string }>> {
    return await this.enqueue(async () => {
      const blocked = await this.refuseIfStopped('portable-data', null)
      if (blocked !== null) return blocked

      const gate = await this.gate('portable-data')
      if (gate.outcome === 'deny') return await this.refuse(gate.code, 'portable-data', null)

      await this.journal('sovereignty.portable-data.verified', {
        recordId,
        dataHash,
        verifiedAt: this.ports.now(),
      })
      this.ports.onChange()
      return { ok: true, value: { recordId } }
    })
  }

  async refuseSelfModification(target: string, _reason: string): Promise<void> {
    await this.enqueue(async () => {
      await this.journal('sovereignty.state-changed', {
        from: this.state.currentState,
        to: this.state.currentState,
        signal: 'stop-all',
        reason: `Self-modification refused: ${target}`,
      })
      this.ports.onChange()
    })
  }

  private async gate(subject: SovereigntyRefusalSubject): Promise<SovereigntyGateOutcome> {
    const facts: SovereigntyAuthorityFacts = {
      journalTrustworthy: this.ports.journalTrustworthy(),
      stopAllActive: this.ports.stopAllActive(),
      enabled: this.ports.enabled(),
      capabilityAllowed: this.ports.guardAllows(),
      cognitionAuthorized: this.ports.governorAuthorized(),
      budgetRemainingUnits: this.ports.budgetRemainingUnits(),
      approvalSatisfied: this.ports.approvalSatisfied(subject),
      realMoney: false,
    }
    const outcome = evaluateSovereigntyGate(facts)
    await this.journal('sovereignty.continuation.decided', {
      decision: outcome.outcome,
      reasoning: outcome.reason,
    })
    return outcome
  }

  private async refuseIfStopped(
    subject: SovereigntyRefusalSubject,
    target: string | null,
  ): Promise<SovereigntyOutcome<never> | null> {
    if (!this.ports.stopAllActive()) return null
    return await this.refuse('stop-all-active', subject, target)
  }

  private async recordRefusal(
    code: SovereigntyAnyRefusalCode,
    _subject: SovereigntyRefusalSubject,
    _target: string | null,
    wakeId: string | null,
  ): Promise<void> {
    this.refusedRequests += 1
    await this.journal('sovereignty.wake.denied', {
      wakeId: wakeId ?? '',
      source: '',
      kind: '',
      code,
    })
  }

  private async refuse(
    code: SovereigntyAnyRefusalCode,
    subject: SovereigntyRefusalSubject,
    target: string | null,
    wakeId: string | null = null,
  ): Promise<SovereigntyOutcome<never>> {
    await this.recordRefusal(code, subject, target, wakeId)
    this.ports.onChange()
    return { ok: false, code: code as SovereigntyRefusalCode, reason: refusalSentence(code) }
  }

  private async journal(type: SovereigntyEventType, payload: SovereigntyPayload): Promise<void> {
    const recordedAt = this.ports.now()
    await this.ports.append(type, payload)
    const result = reduceSovereigntyEntryOnly(
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
          eventType: 'sovereignty.step',
          detail: `a step of the sovereignty subsystem threw and was abandoned: ${
            error instanceof Error ? error.message : 'unknown'
          }`,
        },
      ]
      this.ports.onChange()
      return undefined as T
    }
  }
}

function refusalSentence(code: SovereigntyAnyRefusalCode): string {
  const reason = (REFUSAL_REASONS as Readonly<Record<string, string | undefined>>)[code]
  if (reason !== undefined) return reason
  return wakeRefusalReason(code as SovereigntyWakeRefusalCode)
}
