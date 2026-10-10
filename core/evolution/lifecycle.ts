/**
 * FREYA EVOLUTION — Strategy Lifecycle, Governed Promotion & Safe Rollback
 *
 * Implements versioned strategy lifecycle:
 * proposed -> evaluated -> promotion_pending -> active -> rolled_back
 *
 * Invariants:
 * 1. Owner authorization is strictly required for production strategy promotion.
 * 2. Automatic or governed rollback restores known-good baseline upon regression.
 * 3. Rollback never destroys audit trails, ongoing missions, or historical telemetries.
 */

import type { ExperimentEvaluationReport } from './experiment'
import type { CandidateStatus } from './strategy'
import type { EvolutionStore } from './store'
import type {
  ActiveStrategyRecord,
  PerformanceTelemetry,
} from '../metacognition/types'
import type { MetacognitionStore } from '../metacognition/store'

export interface PromotionAuthorization {
  readonly authorizedBy: 'owner'
  readonly approvalId: string
  readonly timestamp?: string
}

export interface PromotionRecord {
  readonly candidateId: string
  readonly version: string
  readonly previousStrategyId: string
  readonly approvalId: string
  readonly activatedAt: string
  readonly rollbackTargetId: string
}

export interface RollbackRecord {
  readonly candidateId: string
  readonly restoredStrategyId: string
  readonly reason: string
  readonly rolledBackAt: string
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
    const activeList = await this.metacognitionStore.readActiveStrategies()
    const current = activeList.find((s: ActiveStrategyRecord) => s.status === 'active')
    if (current) {
      this.activeStrategy = current
    }
  }

  getActiveStrategy(): ActiveStrategyRecord | null {
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

  async promoteCandidate(
    candidateId: string,
    auth: PromotionAuthorization,
  ): Promise<PromotionResult> {
    // 1. Authorization check: must be owner
    if (auth.authorizedBy !== 'owner' || !auth.approvalId) {
      return {
        ok: false,
        code: 'unauthorized',
        reason: 'Promotion to active production strategy strictly requires explicit owner approval.',
      }
    }

    // 2. Candidate check
    const candidate = await this.evolutionStore.getCandidate(candidateId)
    if (!candidate) {
      return {
        ok: false,
        code: 'missing_candidate',
        reason: `Candidate ${candidateId} does not exist in evolution store.`,
      }
    }

    if (candidate.status !== 'eligible_for_promotion') {
      return {
        ok: false,
        code: 'candidate_not_evaluated',
        reason: `Candidate status is ${candidate.status}; only candidates marked eligible_for_promotion can be promoted.`,
      }
    }

    // 3. Rollback specification check
    if (!candidate.rollbackMechanism?.targetStrategyId) {
      return {
        ok: false,
        code: 'missing_rollback_specification',
        reason: 'Candidate cannot be promoted without a verified, durable rollback mechanism.',
      }
    }

    const previousStrategyId = this.activeStrategy?.strategyId ?? candidate.baselineStrategyId
    const now = auth.timestamp ?? new Date().toISOString()

    const promoRecord: PromotionRecord = {
      candidateId,
      version: candidate.version,
      previousStrategyId,
      approvalId: auth.approvalId,
      activatedAt: now,
      rollbackTargetId: candidate.rollbackMechanism.targetStrategyId,
    }

    this.promotionHistory.push(promoRecord)

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
    const securityFailures = relevant.filter((t) => t.failureAttribution?.category === 'external_denial')
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
    const fallbackTargetId = candidate?.rollbackMechanism.targetStrategyId ?? 'strat-baseline-default'

    const now = new Date().toISOString()
    const rbRecord: RollbackRecord = {
      candidateId: strategyId,
      restoredStrategyId: fallbackTargetId,
      reason,
      rolledBackAt: now,
    }
    this.rollbackHistory.push(rbRecord)

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
