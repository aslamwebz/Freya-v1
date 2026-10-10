/**
 * FREYA METACOGNITION & PERFORMANCE AWARENESS — Types & Vocabulary
 *
 * Grounded self-assessment, telemetry observation, weakness classification,
 * and deterministic metacognitive reporting. Strictly 0 model tokens for
 * deterministic metrics and zero fabricated telemetry.
 */

export type FailureCategory =
  | 'environmental'       // Network drop, timeout, unreachable host, socket closed
  | 'external_denial'     // Owner denied approval, Governor limit, guard blocked
  | 'tool_outage'         // External HTTP 5xx, rate limits from 3rd party API
  | 'strategy_defect'     // Suboptimal source ranking, poor query decomposition, invalid tool arguments
  | 'model_misdirection'  // Hallucinated plan syntax, non-existent action invocation
  | 'unknown'

export interface FailureAttribution {
  readonly category: FailureCategory
  readonly isStrategyDefect: boolean
  readonly reason: string
  readonly details?: Record<string, unknown>
}

export interface PerformanceTelemetry {
  readonly missionId: string
  readonly runId?: string
  readonly taskType: string
  readonly outcome: 'success' | 'failure' | 'partial' | 'cancelled'
  readonly verified: boolean
  readonly verificationReason?: string | null
  readonly planRevisions: number
  readonly actionAttempts: number
  readonly toolErrors: number
  // Explicitly null when unmeasured/missing. Never fabricate.
  readonly durationMs: number | null
  readonly modelTokens: number | null
  readonly modelCalls: number | null
  readonly externalRequests: number | null
  readonly failedAuthorizations: number
  readonly budgetExhausted: boolean
  readonly duplicateWorkAvoided: number
  readonly restartRecoveryQuality?: 'perfect' | 'degraded' | 'failed' | null
  readonly userCorrections: number
  readonly ownerInterventions: number
  readonly failureAttribution?: FailureAttribution | null
  readonly recordedAt: string
}

export type WeaknessKind =
  | 'poor_source_selection'
  | 'unnecessary_replanning'
  | 'excessive_model_calls'
  | 'repeated_tool_errors'
  | 'repeated_context_retrieval_failure'
  | 'weak_task_decomposition'
  | 'unnecessary_owner_notifications'
  | 'repeated_action_failures'
  | 'inefficient_worker_allocation'
  | 'unclassified_weakness'

export type MetacognitiveConfidence = 'preliminary' | 'moderate' | 'strong'
export type CausalEvidenceStatus = 'insufficient_evidence' | 'correlated' | 'demonstrated'

export interface WeaknessRecord {
  readonly weaknessId: string
  readonly kind: WeaknessKind
  readonly description: string
  readonly occurrenceCount: number
  readonly supportingEvidenceIds: readonly string[]
  readonly confidence: MetacognitiveConfidence
  readonly causalEvidenceStatus: CausalEvidenceStatus
  readonly sampleSize: number
  readonly firstObservedAt: string
  readonly lastObservedAt: string
}

export interface MetacognitiveSummary {
  readonly totalMissions: number
  readonly successRate: number
  readonly verificationRate: number
  readonly totalPlanRevisions: number
  readonly totalToolErrors: number
  readonly knownWeaknesses: readonly WeaknessRecord[]
  readonly telemetryCoverage: {
    readonly hasTokenTelemetry: boolean
    readonly hasLatencyTelemetry: boolean
    readonly hasExternalRequestTelemetry: boolean
  }
  readonly improvementsActive: readonly string[]
  readonly improvementsRolledBack: readonly string[]
  readonly evaluatedAt: string
}

export interface ActiveStrategyRecord {
  readonly strategyId: string
  readonly name: string
  readonly kind: string
  readonly version: string
  readonly status: 'active' | 'evaluating' | 'rolled_back' | 'rejected'
  readonly activatedAt: string
  readonly rollbackTargetVersion?: string | null
  readonly parameters?: Record<string, unknown>
}

export interface FailedImprovementRecord {
  readonly strategyId: string
  readonly name: string
  readonly reason: string
  readonly failedAt: string
  readonly candidateVersion: string
}

export interface MetacognitiveReport {
  readonly strugglingWith: readonly WeaknessRecord[]
  readonly repeatedMistakes: readonly {
    readonly kind: string
    readonly count: number
    readonly evidence: readonly string[]
    readonly isStrategyRelated: boolean
    readonly reason: string
  }[]
  readonly activeImprovements: readonly ActiveStrategyRecord[]
  readonly failedImprovements: readonly FailedImprovementRecord[]
  readonly efficiencyTrend: {
    readonly status: 'improving' | 'stable' | 'regressing' | 'insufficient_data'
    readonly statement: string
    readonly sampleSize: number
  }
  readonly nextImprovementTarget: WeaknessRecord | null
}
