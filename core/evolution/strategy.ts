/**
 * FREYA EVOLUTION — Strategy Candidates, Structured Hypotheses & Validation
 *
 * Defines versioned strategy candidates, structured hypotheses, policy boundaries,
 * and deterministic candidate validation.
 *
 * Invariant: Freya's desire to improve must never increase her own authority or modify production code.
 */

import type { WeaknessRecord } from '../metacognition/types'

export const STRATEGY_CATEGORIES = [
  'research_source_ranking',
  'task_decomposition',
  'context_retrieval',
  'planning_template',
  'tool_selection_heuristic',
  'retry_policy',
  'worker_specialization',
  'verification_ordering',
] as const

export type StrategyCategory = (typeof STRATEGY_CATEGORIES)[number]

export const CANDIDATE_STATUSES = [
  'pending',
  'approved_for_experiment',
  'under_evaluation',
  'eligible_for_promotion',
  'promoted',
  'rejected',
  'failed',
  'rolled_back',
] as const

export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number]

export const PROHIBITED_MODIFICATION_PATTERNS = [
  /guard/i,
  /governor/i,
  /stop[_-]?all/i,
  /permission/i,
  /authorization/i,
  /unlimited[_-]?budget/i,
  /self[_-]?modify/i,
  /modify[_-]?code/i,
  /code[_-]?mutation/i,
  /encryption/i,
  /bypass[_-]?approval/i,
  /write[_-]?production[_-]?code/i,
  /vault[_-]?key/i,
  /evaluator[_-]?override/i,
]

export const VAGUE_IMPROVEMENT_PATTERNS = [
  /be smarter/i,
  /reason harder/i,
  /think better/i,
  /do better/i,
  /more intelligent/i,
  /be faster/i,
]

export interface MeasurementCriterion {
  readonly metric: string
  readonly targetThreshold: number
  readonly unit: string
  readonly comparator: 'greater_than_or_equal' | 'less_than_or_equal'
}

export interface ExperimentCeilings {
  readonly maxRuns: number
  readonly maxTokens: number
  readonly maxActions: number
  readonly timeoutMs: number
}

export interface BudgetCeiling {
  readonly maxTokens: number
  readonly maxModelCalls: number
  readonly maxCostUsd: number
}

export interface RollbackSpecification {
  readonly targetStrategyId: string
  readonly targetParameters: Record<string, unknown>
  readonly verificationTest: string
}

export interface StructuredHypothesis {
  readonly observation: string
  readonly hypothesis: string
  readonly candidate: string
  readonly baseline: string
  readonly measurement: string
  readonly regressionRisks: readonly string[]
  readonly acceptanceCriteria: string
}

export interface StrategyCandidate {
  readonly candidateId: string
  readonly name: string
  readonly category: StrategyCategory
  readonly weaknessId: string
  readonly weaknessKind: string
  readonly supportingEvidenceIds: readonly string[]
  readonly proposedChange: string
  readonly parameters: Record<string, unknown>
  readonly expectedBenefit: string
  readonly applicableTaskScope: string
  readonly potentialRisks: readonly string[]
  readonly measurementCriteria: readonly MeasurementCriterion[]
  readonly baselineStrategyId: string
  readonly baselineParameters: Record<string, unknown>
  readonly experimentRequirements: ExperimentCeilings
  readonly budgetCeiling: BudgetCeiling
  readonly rollbackMechanism: RollbackSpecification
  readonly requiredAuthorization: 'owner' | 'governor' | 'automatic'
  readonly status: CandidateStatus
  readonly version: string
  readonly structuredHypothesis: StructuredHypothesis
  readonly createdAt: string
  readonly updatedAt: string
  readonly rejectionReason?: string | null
}

export type CandidateRejectionCode =
  | 'prohibited_security_modification'
  | 'insufficient_supporting_evidence'
  | 'retracted_supporting_evidence'
  | 'unmeasurable_proposal'
  | 'missing_rollback_path'
  | 'excessive_experiment_ceilings'
  | 'duplicate_candidate'
  | 'vague_proposal'

export type CandidateValidationResult =
  | { readonly valid: true; readonly candidate: StrategyCandidate }
  | { readonly valid: false; readonly code: CandidateRejectionCode; readonly reason: string }

export interface ValidationContext {
  readonly existingCandidates?: readonly StrategyCandidate[]
  readonly invalidEvidenceIds?: ReadonlySet<string>
}

export function validateCandidateProposal(
  candidate: StrategyCandidate,
  context?: ValidationContext,
): CandidateValidationResult {
  // 1. Prohibited security modifications check
  const textPayload = [
    candidate.name,
    candidate.proposedChange,
    candidate.expectedBenefit,
    JSON.stringify(candidate.parameters),
  ].join(' ')

  for (const pattern of PROHIBITED_MODIFICATION_PATTERNS) {
    if (pattern.test(textPayload)) {
      return {
        valid: false,
        code: 'prohibited_security_modification',
        reason: `Proposal attempts prohibited security modification matching ${String(pattern)}. Self-improvement must not modify Guard, Governor, STOP ALL, encryption, or code.`,
      }
    }
  }

  // 2. Vague proposal check
  for (const pattern of VAGUE_IMPROVEMENT_PATTERNS) {
    if (pattern.test(candidate.proposedChange) || pattern.test(candidate.expectedBenefit)) {
      return {
        valid: false,
        code: 'vague_proposal',
        reason: `Proposal contains ungrounded/vague improvement statements: ${String(pattern)}. Proposals must specify concrete operational parameters.`,
      }
    }
  }

  if (candidate.proposedChange.trim().length < 10) {
    return {
      valid: false,
      code: 'vague_proposal',
      reason: 'Proposed change is too brief to be an actionable strategy specification.',
    }
  }

  // 3. Supporting evidence check
  if (!candidate.supportingEvidenceIds || candidate.supportingEvidenceIds.length < 2) {
    return {
      valid: false,
      code: 'insufficient_supporting_evidence',
      reason: 'Proposal requires at least 2 verified supporting observation records.',
    }
  }

  if (context?.invalidEvidenceIds && context.invalidEvidenceIds.size > 0) {
    const hasRetracted = candidate.supportingEvidenceIds.some((id) =>
      context.invalidEvidenceIds!.has(id),
    )
    if (hasRetracted) {
      return {
        valid: false,
        code: 'retracted_supporting_evidence',
        reason: 'Proposal relies on invalid or retracted supporting evidence records.',
      }
    }
  }

  // 4. Measurability check
  if (!candidate.measurementCriteria || candidate.measurementCriteria.length === 0) {
    return {
      valid: false,
      code: 'unmeasurable_proposal',
      reason: 'Proposal must define at least one measurable acceptance criterion.',
    }
  }

  // 5. Rollback path check
  if (
    !candidate.rollbackMechanism ||
    !candidate.rollbackMechanism.targetStrategyId ||
    !candidate.rollbackMechanism.targetParameters
  ) {
    return {
      valid: false,
      code: 'missing_rollback_path',
      reason: 'Proposal must specify an explicit durable rollback target and baseline parameters.',
    }
  }

  // 6. Experiment ceilings check
  if (
    candidate.experimentRequirements.maxRuns > 10 ||
    candidate.experimentRequirements.maxTokens > 100000 ||
    candidate.experimentRequirements.maxActions > 30
  ) {
    return {
      valid: false,
      code: 'excessive_experiment_ceilings',
      reason: 'Experiment ceilings exceed maximum permissible bounds (max 10 runs, 100k tokens, 30 actions).',
    }
  }

  // 7. Duplicate check
  if (context?.existingCandidates) {
    const duplicate = context.existingCandidates.find(
      (c) =>
        c.candidateId !== candidate.candidateId &&
        c.weaknessId === candidate.weaknessId &&
        c.version === candidate.version &&
        (c.status === 'pending' ||
          c.status === 'approved_for_experiment' ||
          c.status === 'under_evaluation'),
    )
    if (duplicate) {
      return {
        valid: false,
        code: 'duplicate_candidate',
        reason: `An active candidate ${duplicate.candidateId} already exists for weakness ${candidate.weaknessId} at version ${candidate.version}.`,
      }
    }
  }

  return { valid: true, candidate }
}

export function generateCandidateFromWeakness(
  weakness: WeaknessRecord,
  baselineVersion = '1.0.0',
): StrategyCandidate | null {
  if (weakness.occurrenceCount < 2 || weakness.supportingEvidenceIds.length < 2) {
    return null
  }

  const candidateVersion = '1.1.0'
  const now = new Date().toISOString()

  switch (weakness.kind) {
    case 'poor_source_selection': {
      const candidateId = `cand-strat-source-ranking-${Date.now()}`
      return {
        candidateId,
        name: 'verified-domain-priority-source-selection',
        category: 'research_source_ranking',
        weaknessId: weakness.weaknessId,
        weaknessKind: weakness.kind,
        supportingEvidenceIds: weakness.supportingEvidenceIds,
        proposedChange:
          'Prioritize previously verified domain sources and enforce host diversity before evaluating untested candidate URLs',
        parameters: {
          prioritizeVerifiedDomains: true,
          minHostDiversity: 3,
          maxSourcesPerDomain: 1,
          recheckTimeoutMs: 5000,
        },
        expectedBenefit:
          'Reduces source rereading failures and empty excerpt retrieval by selecting higher-trust domains first',
        applicableTaskScope: 'research_inspection',
        potentialRisks: ['Reduced novel source discovery', 'Potential domain echo-chamber bias'],
        measurementCriteria: [
          {
            metric: 'verification_rate',
            targetThreshold: 0.85,
            unit: 'ratio',
            comparator: 'greater_than_or_equal',
          },
          {
            metric: 'failed_retrieval_count',
            targetThreshold: 1,
            unit: 'count',
            comparator: 'less_than_or_equal',
          },
        ],
        baselineStrategyId: 'strat-source-ranking-default',
        baselineParameters: {
          prioritizeVerifiedDomains: false,
          minHostDiversity: 1,
          maxSourcesPerDomain: 5,
          recheckTimeoutMs: 3000,
        },
        experimentRequirements: {
          maxRuns: 3,
          maxTokens: 15000,
          maxActions: 9,
          timeoutMs: 30000,
        },
        budgetCeiling: {
          maxTokens: 25000,
          maxModelCalls: 3,
          maxCostUsd: 0.05,
        },
        rollbackMechanism: {
          targetStrategyId: 'strat-source-ranking-default',
          targetParameters: {
            prioritizeVerifiedDomains: false,
            minHostDiversity: 1,
            maxSourcesPerDomain: 5,
            recheckTimeoutMs: 3000,
          },
          verificationTest: 'verify_default_source_ranking_restored',
        },
        requiredAuthorization: 'owner',
        status: 'pending',
        version: candidateVersion,
        structuredHypothesis: {
          observation:
            'Repeated research Missions experience verification failure or insufficient sources when selecting raw search result order.',
          hypothesis:
            'Prioritizing verified domain sources and enforcing domain diversity will increase successful independent verification rates.',
          candidate: 'verified-domain-priority-source-selection v1.1.0',
          baseline: `strat-source-ranking-default v${baselineVersion}`,
          measurement:
            'Independent verification pass rate and retrieval error count across standardized test research queries.',
          regressionRisks: ['Reduced novel source diversity'],
          acceptanceCriteria:
            'Verification pass rate >= 85% and retrieval errors <= 1 with zero security boundary violations.',
        },
        createdAt: now,
        updatedAt: now,
      }
    }

    case 'unnecessary_replanning': {
      const candidateId = `cand-strat-plan-template-${Date.now()}`
      return {
        candidateId,
        name: 'two-stage-validation-plan-template',
        category: 'planning_template',
        weaknessId: weakness.weaknessId,
        weaknessKind: weakness.kind,
        supportingEvidenceIds: weakness.supportingEvidenceIds,
        proposedChange:
          'Incorporate explicit capability pre-check steps in plan templates to avoid runtime rejection and subsequent replanning loops',
        parameters: {
          enforceCapabilityPrecheck: true,
          maxInitialSteps: 4,
          atomicActionGrouping: true,
        },
        expectedBenefit:
          'Eliminates mid-flight plan revisions caused by unverified capability assumptions',
        applicableTaskScope: 'mission_planning',
        potentialRisks: ['Slightly higher initial plan validation latency'],
        measurementCriteria: [
          {
            metric: 'plan_revisions',
            targetThreshold: 0,
            unit: 'count',
            comparator: 'less_than_or_equal',
          },
        ],
        baselineStrategyId: 'strat-planning-default',
        baselineParameters: {
          enforceCapabilityPrecheck: false,
          maxInitialSteps: 8,
          atomicActionGrouping: false,
        },
        experimentRequirements: {
          maxRuns: 3,
          maxTokens: 12000,
          maxActions: 6,
          timeoutMs: 25000,
        },
        budgetCeiling: {
          maxTokens: 20000,
          maxModelCalls: 3,
          maxCostUsd: 0.04,
        },
        rollbackMechanism: {
          targetStrategyId: 'strat-planning-default',
          targetParameters: {
            enforceCapabilityPrecheck: false,
            maxInitialSteps: 8,
            atomicActionGrouping: false,
          },
          verificationTest: 'verify_default_planning_restored',
        },
        requiredAuthorization: 'owner',
        status: 'pending',
        version: candidateVersion,
        structuredHypothesis: {
          observation:
            'Multiple missions require 2 or more plan revisions during execution before settlement.',
          hypothesis:
            'Pre-checking capabilities before step construction will reduce required plan revisions.',
          candidate: 'two-stage-validation-plan-template v1.1.0',
          baseline: `strat-planning-default v${baselineVersion}`,
          measurement: 'Plan revision count across representative planning scenarios.',
          regressionRisks: ['Longer initial planning time'],
          acceptanceCriteria: 'Zero plan revisions needed on authorized mission test set.',
        },
        createdAt: now,
        updatedAt: now,
      }
    }

    default:
      return null
  }
}
