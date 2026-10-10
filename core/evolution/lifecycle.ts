/**
 * FREYA EVOLUTION — Strategy Lifecycle, Governed Promotion & Safe Rollback
 *
 * Implements versioned strategy lifecycle:
 * proposed -> evaluated -> promotion_pending -> active -> rolled_back
 *
 * Invariants:
 * 1. Owner authorization is strictly required for production strategy promotion.
 * 2. Self-promotion is structurally impossible.
 * 3. Automatic or governed rollback restores known-good baseline upon regression.
 * 4. Rollback never destroys audit trails, ongoing missions, or historical telemetries.
 * 5. Lifecycle history (promotions, rollbacks, approvals) is durably stored in encrypted storage.
 */

import type { ExperimentEvaluationReport } from './experiment'
import type { CandidateStatus } from './strategy'
import type { EvolutionStore } from './store'
import type {
  ActiveStrategyRecord,
  PerformanceTelemetry,
} from '../metacognition/types'
import type { MetacognitionStore } from '../metacognition/store'
import type { PrincipalId } from '../protocol/core-protocol'
import {
  type PromotionRecord,
  type RollbackRecord,
  type StrategyPromotionApproval,
  computeCandidateDigest,
  validatePromotionApproval,
} from './approval'

export type { PromotionRecord, RollbackRecord, StrategyPromotionApproval }

export interface PromotionAuthorization {
  readonly authorizedBy?: PrincipalId
  readonly approvalId: string
  readonly callerPrincipal?: PrincipalId
  readonly timestamp?: string
}

export type PromotionResult =
  | { readonly ok: true; readonly record: PromotionRecord }
  | { readonly ok: false; readonly code: PromotionRefusalCode; readonly reason: string }

export type PromotionRefusalCode =
  | 'unauthorized'
  | 'ineligible_experiment_outcome'
  | 'security_violation_disqualification'
  | 'missing_candidate'
  | 'missing_rollback_specification'
  | 'candidate_not_evaluated'

export class StrategyLifecycleManager {
  private activeStrategy: ActiveStrategyRecord | null = null
  private readonly promotionHistory: PromotionRecord[] = []
  private readonly rollbackHistory: RollbackRecord[] = []

  constructor(
    private readonly evolutionStore: EvolutionStore,
    private readonly metacognitionStore: MetacognitionStore,
  ) {}

  async initialize(): Promise<void> {
    // Restore promotion and rollback histories from durable store (Finding 6)
    const promotions = await this.evolutionStore.readPromotionHistory()
    this.promotionHistory.length = 0
    this.promotionHistory.push(...promotions)

    const rollbacks = await this.evolutionStore.readRollbackHistory()
    this.rollbackHistory.length = 0
    this.rollbackHistory.push(...rollbacks)

    // Restore active strategy
    const activeList = await this.metacognitionStore.readActiveStrategies()
    const current = activeList.find((s: ActiveStrategyRecord) => s.status === 'active')

    if (current) {
      // Safety check: ensure the candidate was not rolled back
      const isRolledBack = this.rollbackHistory.some((r) => r.candidateId === current.strategyId)
      const cand = await this.evolutionStore.getCandidate(current.strategyId)
      if (isRolledBack || cand?.status === 'rolled_back') {
        // Do NOT restore a rolled-back strategy as active
        this.activeStrategy = null
      } else {
        this.activeStrategy = current
      }
    }
  }

  getActiveStrategy(scope?: string): ActiveStrategyRecord | null {
    if (!this.activeStrategy) return null
    if (scope && this.activeStrategy.kind !== scope && this.activeStrategy.kind !== 'general') {
      return null
    }
    return this.activeStrategy
  }

  getPromotionHistory(): readonly PromotionRecord[] {
    return [...this.promotionHistory]
  }

  getRollbackHistory(): readonly RollbackRecord[] {
    return [...this.rollbackHistory]
  }

  async submitEvaluation(
    candidateId: string,
    report: ExperimentEvaluationReport,
  ): Promise<{ readonly ok: boolean; readonly status: CandidateStatus; readonly reason: string }> {
    const candidate = await this.evolutionStore.getCandidate(candidateId)
    if (!candidate) {
      return { ok: false, status: 'rejected', reason: `Candidate ${candidateId} not found.` }
    }

    if (report.outcome === 'disqualified_security_regression') {
      await this.evolutionStore.updateCandidateStatus(
        candidateId,
        'rejected',
        'Disqualified due to security regression during experiment execution',
      )
      return {
        ok: false,
        status: 'rejected',
        reason: 'Candidate disqualified due to security regression.',
      }
    }

    if (!report.isPromotionEligible || report.outcome !== 'candidate_demonstrated_improvement') {
      await this.evolutionStore.updateCandidateStatus(
        candidateId,
        'failed',
        `Candidate failed experiment acceptance criteria: ${report.reason}`,
      )
      await this.metacognitionStore.writeFailedImprovement({
        strategyId: candidateId,
        name: candidate.name,
        reason: report.reason,
        failedAt: new Date().toISOString(),
        candidateVersion: candidate.version,
      })
      return {
        ok: false,
        status: 'failed',
        reason: `Candidate failed acceptance criteria: ${report.reason}`,
      }
    }

    // Candidate passed experiment with demonstrable improvement
    await this.evolutionStore.updateCandidateStatus(candidateId, 'eligible_for_promotion')
    return {
      ok: true,
      status: 'eligible_for_promotion',
      reason: 'Candidate demonstrably improved performance and is eligible for owner promotion.',
    }
  }

  /**
   * Request formal owner approval for strategy promotion.
   */
  async requestPromotionApproval(
    candidateId: string,
    options?: {
      readonly requestedBy?: PrincipalId
      readonly ttlMs?: number
      readonly justification?: string
    },
  ): Promise<
    | { readonly ok: true; readonly approval: StrategyPromotionApproval }
    | { readonly ok: false; readonly reason: string }
  > {
    const candidate = await this.evolutionStore.getCandidate(candidateId)
    if (!candidate) {
      return { ok: false, reason: `Candidate ${candidateId} does not exist.` }
    }
    if (candidate.status !== 'eligible_for_promotion') {
      return {
        ok: false,
        reason: `Candidate ${candidateId} is not in eligible_for_promotion status (current: ${candidate.status}).`,
      }
    }

    const approvalId = `appr-evo-${candidateId}-${Date.now()}`
    const requestedAt = new Date().toISOString()
    const ttl = options?.ttlMs ?? 24 * 60 * 60_000
    const expiresAt = new Date(Date.now() + ttl).toISOString()

    const approval: StrategyPromotionApproval = {
      approvalId,
      candidateId,
      candidateDigest: computeCandidateDigest(candidate),
      strategyVersion: candidate.version,
      category: candidate.category,
      authorityScope: 'evolution.strategy.promote',
      requestedPurpose: 'production_promotion',
      status: 'pending',
      requestedBy: options?.requestedBy ?? 'system',
      requestedAt,
      expiresAt,
      decidedBy: null,
      decidedAt: null,
      decisionReason: options?.justification ?? null,
      consumed: false,
    }

    await this.evolutionStore.writeApproval(approval)
    return { ok: true, approval }
  }

  /**
   * Decide an existing strategy promotion approval request.
   */
  async decidePromotionApproval(input: {
    readonly approvalId: string
    readonly decision: 'approved' | 'denied' | 'revoked'
    readonly decidedBy: PrincipalId
    readonly reason?: string
  }): Promise<
    | { readonly ok: true; readonly approval: StrategyPromotionApproval }
    | { readonly ok: false; readonly reason: string }
  > {
    const approval = await this.evolutionStore.getApproval(input.approvalId)
    if (!approval) {
      return { ok: false, reason: `Approval ${input.approvalId} does not exist.` }
    }
    if (approval.status !== 'pending' && input.decision !== 'revoked') {
      return {
        ok: false,
        reason: `Approval ${input.approvalId} is already in terminal status ${approval.status}.`,
      }
    }
    if (input.decision === 'approved' && input.decidedBy !== 'owner') {
      return { ok: false, reason: 'Only the authenticated owner may approve strategy promotion.' }
    }

    const now = new Date().toISOString()
    const updated: StrategyPromotionApproval = {
      ...approval,
      status: input.decision,
      decidedBy: input.decidedBy,
      decidedAt: now,
      decisionReason: input.reason ?? approval.decisionReason,
    }

    await this.evolutionStore.writeApproval(updated)
    return { ok: true, approval: updated }
  }

  /**
   * Promote an evaluated candidate strategy to active production status.
   * Strictly enforces all 10 owner authorization checks via validatePromotionApproval.
   */
  async promoteCandidate(
    candidateId: string,
    auth: PromotionAuthorization,
  ): Promise<PromotionResult> {
    // 1. Retrieve approval record from durable store (check authorization first)
    const approval = await this.evolutionStore.getApproval(auth.approvalId)
    if (!approval) {
      return {
        ok: false,
        code: 'unauthorized',
        reason: 'Approval request does not exist.',
      }
    }
    if (approval.consumed) {
      return {
        ok: false,
        code: 'unauthorized',
        reason: 'Approval request has already been consumed and cannot be reused.',
      }
    }

    // 2. Candidate existence check
    const candidate = await this.evolutionStore.getCandidate(candidateId)
    if (!candidate) {
      return {
        ok: false,
        code: 'missing_candidate',
        reason: `Candidate ${candidateId} does not exist in evolution store.`,
      }
    }

    // 3. Authenticate approval against candidate specifications
    const callerPrincipal = auth.callerPrincipal ?? (auth.authorizedBy === 'owner' ? 'owner' : undefined)
    const verdict = validatePromotionApproval(approval, candidate, {
      callerPrincipal,
      now: auth.timestamp,
    })

    if (!verdict.valid) {
      return {
        ok: false,
        code: verdict.code,
        reason: verdict.reason,
      }
    }

    // 4. Candidate evaluation status check
    if (candidate.status !== 'eligible_for_promotion') {
      return {
        ok: false,
        code: 'candidate_not_evaluated',
        reason: `Candidate status is ${candidate.status}; only candidates marked eligible_for_promotion can be promoted.`,
      }
    }

    // 5. Rollback specification check
    if (!candidate.rollbackMechanism?.targetStrategyId) {
      return {
        ok: false,
        code: 'missing_rollback_specification',
        reason: 'Candidate cannot be promoted without a verified, durable rollback mechanism.',
      }
    }

    const previousStrategyId = this.activeStrategy?.strategyId ?? candidate.baselineStrategyId
    const now = auth.timestamp ?? new Date().toISOString()

    // 6. Atomically consume the approval so it cannot be reused
    const consumedApproval: StrategyPromotionApproval = {
      ...verdict.approval,
      consumed: true,
      consumedAt: now,
    }
    await this.evolutionStore.writeApproval(consumedApproval)

    const promoRecord: PromotionRecord = {
      candidateId,
      version: candidate.version,
      previousStrategyId,
      approvalId: auth.approvalId,
      activatedAt: now,
      rollbackTargetId: candidate.rollbackMechanism.targetStrategyId,
    }

    this.promotionHistory.push(promoRecord)
    await this.evolutionStore.writePromotionRecord(promoRecord)

    // Archive previous active strategy if exists
    if (this.activeStrategy) {
      await this.metacognitionStore.writeActiveStrategy({
        ...this.activeStrategy,
        status: 'rolled_back',
      })
    }

    // Set new active strategy
    const newActive: ActiveStrategyRecord = {
      strategyId: candidate.candidateId,
      name: candidate.name,
      kind: candidate.category,
      version: candidate.version,
      status: 'active',
      activatedAt: now,
      rollbackTargetVersion: candidate.baselineStrategyId,
    }

    this.activeStrategy = newActive
    await this.metacognitionStore.writeActiveStrategy(newActive)
    await this.evolutionStore.updateCandidateStatus(candidateId, 'promoted')

    return { ok: true, record: promoRecord }
  }

  async monitorAndEvaluateRegression(
    recentTelemetries: readonly PerformanceTelemetry[],
  ): Promise<{ readonly regressionDetected: boolean; readonly reason: string | null }> {
    if (!this.activeStrategy) {
      return { regressionDetected: false, reason: null }
    }

    // Inspect telemetries for the active strategy
    const relevant = recentTelemetries.filter((t) => t.outcome !== 'cancelled')
    if (relevant.length < 2) {
      return { regressionDetected: false, reason: null }
    }

    // 1. Security violation check: instant rollback trigger
    const securityFailures = relevant.filter(
      (t) => t.failureAttribution?.category === 'external_denial',
    )
    if (securityFailures.length > 0) {
      const reason = `Security violation detected under active strategy ${this.activeStrategy.version}: ${securityFailures[0]?.failureAttribution?.reason}`
      await this.rollbackStrategy(this.activeStrategy.strategyId, reason)
      return { regressionDetected: true, reason }
    }

    // 2. Consecutive strategy failures check
    const last2 = relevant.slice(-2)
    const consecutiveFailures = last2.every(
      (t) => t.outcome === 'failure' && t.failureAttribution?.isStrategyDefect === true,
    )

    if (consecutiveFailures) {
      const reason = `Consecutive strategy defects detected (2 consecutive failed missions) under active strategy ${this.activeStrategy.version}.`
      await this.rollbackStrategy(this.activeStrategy.strategyId, reason)
      return { regressionDetected: true, reason }
    }

    return { regressionDetected: false, reason: null }
  }

  async rollbackStrategy(
    strategyId: string,
    reason: string,
  ): Promise<{ readonly ok: boolean; readonly restoredStrategyId: string }> {
    const candidate = await this.evolutionStore.getCandidate(strategyId)
    const fallbackTargetId =
      candidate?.rollbackMechanism.targetStrategyId ?? 'strat-baseline-default'

    // Idempotency: if already rolled back and restored, do not create duplicate records
    if (
      this.rollbackHistory.some((r) => r.candidateId === strategyId) &&
      this.activeStrategy?.strategyId === fallbackTargetId
    ) {
      return { ok: true, restoredStrategyId: fallbackTargetId }
    }

    const now = new Date().toISOString()
    const rbRecord: RollbackRecord = {
      candidateId: strategyId,
      restoredStrategyId: fallbackTargetId,
      reason,
      rolledBackAt: now,
    }
    this.rollbackHistory.push(rbRecord)
    await this.evolutionStore.writeRollbackRecord(rbRecord)

    // Mark current candidate as rolled_back
    await this.evolutionStore.updateCandidateStatus(strategyId, 'rolled_back', reason)

    // Mark previous active strategy as rolled_back in metacognition store
    if (this.activeStrategy && this.activeStrategy.strategyId === strategyId) {
      await this.metacognitionStore.writeActiveStrategy({
        ...this.activeStrategy,
        status: 'rolled_back',
      })
    }

    // Restore baseline as active
    const restoredActive: ActiveStrategyRecord = {
      strategyId: fallbackTargetId,
      name: 'baseline-default-restored',
      kind: candidate?.category ?? 'general',
      version: '1.0.0',
      status: 'active',
      activatedAt: now,
      rollbackTargetVersion: null,
    }

    this.activeStrategy = restoredActive
    await this.metacognitionStore.writeActiveStrategy(restoredActive)

    return { ok: true, restoredStrategyId: fallbackTargetId }
  }
}
