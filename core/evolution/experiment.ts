/**
 * FREYA EVOLUTION — Controlled Experimentation & Independent Evaluation
 *
 * Implements bounded, isolated A/B experiment runner comparing baseline vs candidate.
 * Enforces frozen acceptance metrics, holdout scenarios, independent verification,
 * hard resource ceilings, and statistical restraint.
 *
 * Invariant: The candidate strategy cannot judge itself, redefine criteria, or widen authority.
 */

import type {
  BudgetCeiling,
  ExperimentCeilings,
  MeasurementCriterion,
  StrategyCandidate,
} from './strategy'
import type { SearchResult } from '../research/types'
import { selectSourcesDetailed } from '../research/evidence'

export type ExperimentStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface ExperimentScenario {
  readonly scenarioId: string
  readonly name: string
  readonly isHoldout: boolean
  readonly taskType: string
  readonly input: {
    readonly query: string
    readonly candidateSources: readonly {
      readonly url: string
      readonly domain: string
      readonly previouslyVerified: boolean
      readonly contentAvailable: boolean
      readonly text: string
    }[]
  }
  readonly expectedRequiredSources: number
}

export interface ScenarioRunResult {
  readonly scenarioId: string
  readonly isHoldout: boolean
  readonly strategy: 'baseline' | 'candidate'
  readonly success: boolean
  readonly verified: boolean
  readonly selectedSourcesCount: number
  readonly toolErrors: number
  readonly actionsCount: number
  readonly tokensUsed: number
  readonly durationMs: number
  readonly securityViolations: number
  readonly verifierVerdict: 'passed' | 'failed'
  readonly verifierReason: string
}

export type ComparativeOutcome =
  | 'candidate_demonstrated_improvement'
  | 'candidate_failed'
  | 'inconclusive'
  | 'disqualified_security_regression'

export interface PerformanceAggregate {
  readonly runCount: number
  readonly verifiedPassRate: number
  readonly avgTokens: number
  readonly avgActions: number
  readonly securityViolations: number
  readonly toolErrors: number
}

export interface ExperimentEvaluationReport {
  readonly experimentId: string
  readonly candidateId: string
  readonly status: ExperimentStatus
  readonly baselinePerformance: PerformanceAggregate
  readonly candidatePerformance: PerformanceAggregate
  readonly holdoutPerformance: {
    readonly baselinePassRate: number
    readonly candidatePassRate: number
  }
  readonly dimensions: {
    readonly correctness: boolean
    readonly verificationSuccess: boolean
    readonly resourceCost: 'better' | 'equal' | 'worse'
    readonly securitySafe: boolean
  }
  readonly outcome: ComparativeOutcome
  readonly confidence: 'preliminary' | 'moderate' | 'strong'
  readonly isPromotionEligible: boolean
  readonly reason: string
  readonly completedAt: string
}

export interface ExperimentDefinition {
  readonly experimentId: string
  readonly candidateId: string
  readonly baselineStrategyId: string
  readonly frozenMetrics: readonly MeasurementCriterion[]
  readonly scenarios: readonly ExperimentScenario[]
  readonly ceilings: ExperimentCeilings
  readonly budget: BudgetCeiling
}

/**
 * Independent Verifier:
 * Pure objective checks. The candidate strategy has NO access to this function
 * and cannot modify its assertions or verdict logic.
 */
export function independentlyVerifyScenarioResult(
  scenario: ExperimentScenario,
  selectedSources: readonly { readonly url: string; readonly text: string; readonly contentAvailable: boolean }[],
): { readonly verdict: 'passed' | 'failed'; readonly reason: string } {
  if (selectedSources.length < scenario.expectedRequiredSources) {
    return {
      verdict: 'failed',
      reason: `Selected source count ${selectedSources.length} is below required threshold ${scenario.expectedRequiredSources}`,
    }
  }

  // Verify that all selected sources actually have content available
  for (const s of selectedSources) {
    if (!s.contentAvailable || !s.text || s.text.trim().length === 0) {
      return {
        verdict: 'failed',
        reason: `Selected source ${s.url} has empty or unavailable content`,
      }
    }
  }

  return {
    verdict: 'passed',
    reason: `All ${selectedSources.length} selected sources independently verified with content intact`,
  }
}

/**
 * Controlled Strategy Executions
 */
export function executeSourceSelection(
  strategyType: 'baseline' | 'candidate',
  scenario: ExperimentScenario,
  candidateParams: Record<string, unknown>,
): {
  readonly selectedSources: readonly (typeof scenario.input.candidateSources)[number][]
  readonly actionsCount: number
  readonly tokensUsed: number
  readonly toolErrors: number
  readonly securityViolations: number
  readonly durationMs: number
} {
  const t0 = performance.now()
  let securityViolations = 0

  // Security check: reject unauthorized or dangerous parameter injection
  if (
    candidateParams['unlimited_budget'] ||
    candidateParams['bypass_guard'] ||
    candidateParams['eval_code']
  ) {
    securityViolations++
  }

  const rawSources = scenario.input.candidateSources
  // Use the SAME source-ranking implementation as production research.
  // Fixture-provided verification evidence is represented as metadata, never
  // as an injected trusted-domain override to the production selector.
  const searchResults: SearchResult[] = rawSources.map((s, idx) => ({
    title: s.domain,
    url: s.url,
    snippet: s.text,
    sourceDomain: s.domain,
    rank: idx + 1,
    publishedAt: null,
    retrievedAt: new Date().toISOString(),
    metadata: s.previouslyVerified ? { verified: 'true' } : undefined,
  }))

  const strategy =
    strategyType === 'candidate'
      ? {
          strategyId: 'candidate-strategy',
          kind: 'research_source_ranking',
          version: '2.0.0',
          parameters: candidateParams,
        }
      : null

  const { sources: chosen } = selectSourcesDetailed(
    searchResults,
    scenario.expectedRequiredSources,
    { strategy },
  )

  const sourceMap = new Map(rawSources.map((s) => [s.url, s]))
  const selected: (typeof scenario.input.candidateSources)[number][] = []
  let toolErrors = 0
  let actionsCount = 0

  for (const item of chosen) {
    actionsCount++
    const original = sourceMap.get(item.url)
    if (original) {
      if (original.contentAvailable && original.text.trim().length > 0) {
        selected.push(original)
      } else {
        toolErrors++
      }
    }
  }

  // Deterministic source selection uses 0 model tokens
  const tokensUsed = 0
  const durationMs = Math.max(0.01, performance.now() - t0)

  return {
    selectedSources: selected,
    actionsCount,
    tokensUsed,
    toolErrors,
    securityViolations,
    durationMs,
  }
}

export class ControlledExperimentRunner {
  async runExperiment(
    candidate: StrategyCandidate,
    scenarios: readonly ExperimentScenario[],
  ): Promise<ExperimentEvaluationReport> {
    const experimentId = `exp-${candidate.candidateId}-${Date.now()}`

    // 1. Freeze metrics at run initialization (cannot be rewritten by candidate)
    const frozenMetrics = Object.freeze([...candidate.measurementCriteria])
    const ceilings = candidate.experimentRequirements
    const budget = candidate.budgetCeiling

    let totalTokensConsumed = 0
    let totalActionsExecuted = 0

    const baselineResults: ScenarioRunResult[] = []
    const candidateResults: ScenarioRunResult[] = []

    // 2. Execute scenarios against both baseline and candidate
    for (const scenario of scenarios) {
      // Conservative pre-reservation check: ensure ceilings not exceeded
      const estimatedActions = scenario.expectedRequiredSources * 2
      const estimatedTokens = 0
      if (
        totalTokensConsumed + estimatedTokens > budget.maxTokens ||
        totalActionsExecuted + estimatedActions > ceilings.maxActions
      ) {
        return this.buildCeilingExceededReport(
          experimentId,
          candidate.candidateId,
          'Experiment halted: budget ceiling exhausted during execution.',
        )
      }

      // Run baseline
      const baseExec = executeSourceSelection('baseline', scenario, candidate.baselineParameters)
      totalTokensConsumed += baseExec.tokensUsed
      totalActionsExecuted += baseExec.actionsCount

      const baseVerify = independentlyVerifyScenarioResult(scenario, baseExec.selectedSources)
      baselineResults.push({
        scenarioId: scenario.scenarioId,
        isHoldout: scenario.isHoldout,
        strategy: 'baseline',
        success: baseVerify.verdict === 'passed',
        verified: baseVerify.verdict === 'passed',
        selectedSourcesCount: baseExec.selectedSources.length,
        toolErrors: baseExec.toolErrors,
        actionsCount: baseExec.actionsCount,
        tokensUsed: baseExec.tokensUsed,
        durationMs: baseExec.durationMs,
        securityViolations: baseExec.securityViolations,
        verifierVerdict: baseVerify.verdict,
        verifierReason: baseVerify.reason,
      })

      // Run candidate
      const candExec = executeSourceSelection('candidate', scenario, candidate.parameters)
      totalTokensConsumed += candExec.tokensUsed
      totalActionsExecuted += candExec.actionsCount

      const candVerify = independentlyVerifyScenarioResult(scenario, candExec.selectedSources)
      candidateResults.push({
        scenarioId: scenario.scenarioId,
        isHoldout: scenario.isHoldout,
        strategy: 'candidate',
        success: candVerify.verdict === 'passed',
        verified: candVerify.verdict === 'passed',
        selectedSourcesCount: candExec.selectedSources.length,
        toolErrors: candExec.toolErrors,
        actionsCount: candExec.actionsCount,
        tokensUsed: candExec.tokensUsed,
        durationMs: candExec.durationMs,
        securityViolations: candExec.securityViolations,
        verifierVerdict: candVerify.verdict,
        verifierReason: candVerify.reason,
      })

      // Immediate security violation disqualification
      if (candExec.securityViolations > 0) {
        return {
          experimentId,
          candidateId: candidate.candidateId,
          status: 'failed',
          baselinePerformance: this.aggregate(baselineResults),
          candidatePerformance: this.aggregate(candidateResults),
          holdoutPerformance: {
            baselinePassRate: 0,
            candidatePassRate: 0,
          },
          dimensions: {
            correctness: false,
            verificationSuccess: false,
            resourceCost: 'worse',
            securitySafe: false,
          },
          outcome: 'disqualified_security_regression',
          confidence: 'strong',
          isPromotionEligible: false,
          reason:
            'Candidate disqualified: security or policy violations detected during experiment execution.',
          completedAt: new Date().toISOString(),
        }
      }

      // Post-operation budget check
      if (
        totalTokensConsumed > budget.maxTokens ||
        totalActionsExecuted > ceilings.maxActions
      ) {
        return this.buildCeilingExceededReport(
          experimentId,
          candidate.candidateId,
          'Experiment halted: budget ceiling exhausted during execution.',
        )
      }
    }

    // 3. Aggregate Performance
    const baseAgg = this.aggregate(baselineResults)
    const candAgg = this.aggregate(candidateResults)

    // 4. Holdout performance
    const baseHoldout = baselineResults.filter((r) => r.isHoldout)
    const candHoldout = candidateResults.filter((r) => r.isHoldout)

    const baseHoldoutPassRate =
      baseHoldout.length > 0
        ? baseHoldout.filter((r) => r.verified).length / baseHoldout.length
        : 1
    const candHoldoutPassRate =
      candHoldout.length > 0
        ? candHoldout.filter((r) => r.verified).length / candHoldout.length
        : 0

    // 5. Evaluate Against Frozen Acceptance Metrics
    return this.evaluateComparativeReport(
      experimentId,
      candidate.candidateId,
      frozenMetrics,
      baseAgg,
      candAgg,
      baseHoldoutPassRate,
      candHoldoutPassRate,
    )
  }

  private aggregate(results: readonly ScenarioRunResult[]): PerformanceAggregate {
    const count = results.length
    if (count === 0) {
      return {
        runCount: 0,
        verifiedPassRate: 0,
        avgTokens: 0,
        avgActions: 0,
        securityViolations: 0,
        toolErrors: 0,
      }
    }

    const verified = results.filter((r) => r.verified).length
    const tokens = results.reduce((a, b) => a + b.tokensUsed, 0)
    const actions = results.reduce((a, b) => a + b.actionsCount, 0)
    const secViolations = results.reduce((a, b) => a + b.securityViolations, 0)
    const errors = results.reduce((a, b) => a + b.toolErrors, 0)

    return {
      runCount: count,
      verifiedPassRate: verified / count,
      avgTokens: tokens / count,
      avgActions: actions / count,
      securityViolations: secViolations,
      toolErrors: errors,
    }
  }

  private evaluateComparativeReport(
    experimentId: string,
    candidateId: string,
    frozenMetrics: readonly MeasurementCriterion[],
    base: PerformanceAggregate,
    cand: PerformanceAggregate,
    baseHoldoutPassRate: number,
    candHoldoutPassRate: number,
  ): ExperimentEvaluationReport {
    // Check security regressions first
    if (cand.securityViolations > 0) {
      return {
        experimentId,
        candidateId,
        status: 'failed',
        baselinePerformance: base,
        candidatePerformance: cand,
        holdoutPerformance: {
          baselinePassRate: baseHoldoutPassRate,
          candidatePassRate: candHoldoutPassRate,
        },
        dimensions: {
          correctness: false,
          verificationSuccess: false,
          resourceCost: 'worse',
          securitySafe: false,
        },
        outcome: 'disqualified_security_regression',
        confidence: 'strong',
        isPromotionEligible: false,
        reason: 'Candidate disqualified: security or policy violations detected during experiment execution.',
        completedAt: new Date().toISOString(),
      }
    }

    // Check sample size restraint (min 3 runs)
    if (cand.runCount < 3) {
      return {
        experimentId,
        candidateId,
        status: 'completed',
        baselinePerformance: base,
        candidatePerformance: cand,
        holdoutPerformance: {
          baselinePassRate: baseHoldoutPassRate,
          candidatePassRate: candHoldoutPassRate,
        },
        dimensions: {
          correctness: cand.verifiedPassRate >= base.verifiedPassRate,
          verificationSuccess: cand.verifiedPassRate > base.verifiedPassRate,
          resourceCost: cand.avgTokens <= base.avgTokens ? 'better' : 'worse',
          securitySafe: true,
        },
        outcome: 'inconclusive',
        confidence: 'preliminary',
        isPromotionEligible: false,
        reason: 'Inconclusive: insufficient sample size (< 3 scenario runs) to establish statistical improvement.',
        completedAt: new Date().toISOString(),
      }
    }

    // Check holdout performance (prevents overfitting to dev scenarios)
    if (candHoldoutPassRate < baseHoldoutPassRate) {
      return {
        experimentId,
        candidateId,
        status: 'completed',
        baselinePerformance: base,
        candidatePerformance: cand,
        holdoutPerformance: {
          baselinePassRate: baseHoldoutPassRate,
          candidatePassRate: candHoldoutPassRate,
        },
        dimensions: {
          correctness: false,
          verificationSuccess: false,
          resourceCost: 'equal',
          securitySafe: true,
        },
        outcome: 'candidate_failed',
        confidence: 'moderate',
        isPromotionEligible: false,
        reason: `Candidate regressed on holdout evaluation scenarios (${(candHoldoutPassRate * 100).toFixed(0)}% vs baseline ${(baseHoldoutPassRate * 100).toFixed(0)}%). Overfitting detected.`,
        completedAt: new Date().toISOString(),
      }
    }

    // Check all frozen metrics
    let metricsSatisfied = true
    const metricFailures: string[] = []

    for (const criterion of frozenMetrics) {
      if (criterion.metric === 'verification_rate') {
        if (criterion.comparator === 'greater_than_or_equal' && cand.verifiedPassRate < criterion.targetThreshold) {
          metricsSatisfied = false
          metricFailures.push(`verification_rate ${(cand.verifiedPassRate * 100).toFixed(0)}% < target ${(criterion.targetThreshold * 100).toFixed(0)}%`)
        }
      } else if (criterion.metric === 'failed_retrieval_count' || criterion.metric === 'tool_errors') {
        if (criterion.comparator === 'less_than_or_equal' && cand.toolErrors > criterion.targetThreshold) {
          metricsSatisfied = false
          metricFailures.push(`toolErrors ${cand.toolErrors} > target ${criterion.targetThreshold}`)
        }
      }
    }

    if (!metricsSatisfied) {
      return {
        experimentId,
        candidateId,
        status: 'completed',
        baselinePerformance: base,
        candidatePerformance: cand,
        holdoutPerformance: {
          baselinePassRate: baseHoldoutPassRate,
          candidatePassRate: candHoldoutPassRate,
        },
        dimensions: {
          correctness: false,
          verificationSuccess: false,
          resourceCost: cand.avgTokens <= base.avgTokens ? 'better' : 'worse',
          securitySafe: true,
        },
        outcome: 'candidate_failed',
        confidence: 'moderate',
        isPromotionEligible: false,
        reason: `Candidate failed to meet frozen acceptance thresholds: ${metricFailures.join('; ')}`,
        completedAt: new Date().toISOString(),
      }
    }

    // Check comparative advantage: must outperform baseline
    const verifiedImproved = cand.verifiedPassRate > base.verifiedPassRate
    const errorsReduced = cand.toolErrors < base.toolErrors

    if (!verifiedImproved && !errorsReduced) {
      return {
        experimentId,
        candidateId,
        status: 'completed',
        baselinePerformance: base,
        candidatePerformance: cand,
        holdoutPerformance: {
          baselinePassRate: baseHoldoutPassRate,
          candidatePassRate: candHoldoutPassRate,
        },
        dimensions: {
          correctness: true,
          verificationSuccess: false,
          resourceCost: 'equal',
          securitySafe: true,
        },
        outcome: 'inconclusive',
        confidence: 'moderate',
        isPromotionEligible: false,
        reason: 'Candidate did not demonstrate measurable superiority over baseline under tested conditions.',
        completedAt: new Date().toISOString(),
      }
    }

    return {
      experimentId,
      candidateId,
      status: 'completed',
      baselinePerformance: base,
      candidatePerformance: cand,
      holdoutPerformance: {
        baselinePassRate: baseHoldoutPassRate,
        candidatePassRate: candHoldoutPassRate,
      },
      dimensions: {
        correctness: true,
        verificationSuccess: true,
        resourceCost: cand.avgTokens <= base.avgTokens ? 'better' : 'equal',
        securitySafe: true,
      },
      outcome: 'candidate_demonstrated_improvement',
      confidence: 'strong',
      isPromotionEligible: true,
      reason: `Candidate demonstrably improved verification rate from ${(base.verifiedPassRate * 100).toFixed(0)}% to ${(cand.verifiedPassRate * 100).toFixed(0)}% while reducing errors from ${base.toolErrors} to ${cand.toolErrors}.`,
      completedAt: new Date().toISOString(),
    }
  }

  private buildCeilingExceededReport(
    experimentId: string,
    candidateId: string,
    reason: string,
  ): ExperimentEvaluationReport {
    const empty: PerformanceAggregate = {
      runCount: 0,
      verifiedPassRate: 0,
      avgTokens: 0,
      avgActions: 0,
      securityViolations: 0,
      toolErrors: 0,
    }
    return {
      experimentId,
      candidateId,
      status: 'failed',
      baselinePerformance: empty,
      candidatePerformance: empty,
      holdoutPerformance: {
        baselinePassRate: 0,
        candidatePassRate: 0,
      },
      dimensions: {
        correctness: false,
        verificationSuccess: false,
        resourceCost: 'worse',
        securitySafe: false,
      },
      outcome: 'candidate_failed',
      confidence: 'strong',
      isPromotionEligible: false,
      reason,
      completedAt: new Date().toISOString(),
    }
  }
}
