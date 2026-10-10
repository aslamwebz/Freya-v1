/**
 * FREYA METACOGNITION — Metacognitive Reporter
 *
 * Deterministic query responder for metacognitive self-assessment.
 * Strictly 0 model calls, evidence-grounded answers, and honest statistical restraint.
 */

import type {
  ActiveStrategyRecord,
  FailedImprovementRecord,
  MetacognitiveReport,
  MetacognitiveSummary,
  PerformanceTelemetry,
  WeaknessRecord,
} from './types'
import type { MetacognitionStore } from './store'

export class MetacognitiveReporter {
  constructor(private readonly store: MetacognitionStore) {}

  async generateSummary(): Promise<MetacognitiveSummary> {
    const telemetries = await this.store.readTelemetries()
    const weaknesses = await this.store.readWeaknesses()
    const activeStrategies = await this.store.readActiveStrategies()
    const failedImprovements = await this.store.readFailedImprovements()

    const total = telemetries.length
    if (total === 0) {
      return {
        totalMissions: 0,
        successRate: 0,
        verificationRate: 0,
        totalPlanRevisions: 0,
        totalToolErrors: 0,
        knownWeaknesses: [],
        telemetryCoverage: {
          hasTokenTelemetry: false,
          hasLatencyTelemetry: false,
          hasExternalRequestTelemetry: false,
        },
        improvementsActive: [],
        improvementsRolledBack: [],
        evaluatedAt: new Date().toISOString(),
      }
    }

    const successes = telemetries.filter((t) => t.outcome === 'success').length
    const verified = telemetries.filter((t) => t.verified).length
    const revisions = telemetries.reduce((acc, t) => acc + t.planRevisions, 0)
    const errors = telemetries.reduce((acc, t) => acc + t.toolErrors, 0)

    const hasTokens = telemetries.some((t) => t.modelTokens !== null)
    const hasLatency = telemetries.some((t) => t.durationMs !== null)
    const hasExternalRequests = telemetries.some((t) => t.externalRequests !== null)

    const activeList = activeStrategies.filter((s) => s.status === 'active').map((s) => s.name)
    const rolledBackList = activeStrategies.filter((s) => s.status === 'rolled_back').map((s) => s.name)

    return {
      totalMissions: total,
      successRate: successes / total,
      verificationRate: verified / total,
      totalPlanRevisions: revisions,
      totalToolErrors: errors,
      knownWeaknesses: weaknesses,
      telemetryCoverage: {
        hasTokenTelemetry: hasTokens,
        hasLatencyTelemetry: hasLatency,
        hasExternalRequestTelemetry: hasExternalRequests,
      },
      improvementsActive: activeList,
      improvementsRolledBack: [
        ...rolledBackList,
        ...failedImprovements.map((f) => f.name),
      ],
      evaluatedAt: new Date().toISOString(),
    }
  }

  async generateReport(): Promise<MetacognitiveReport> {
    const telemetries = await this.store.readTelemetries()
    const weaknesses = await this.store.readWeaknesses()
    const activeStrategies = await this.store.readActiveStrategies()
    const failedImprovements = await this.store.readFailedImprovements()

    // 1. Struggling with
    const strugglingWith = weaknesses

    // 2. Repeated mistakes
    const repeatedMistakes = weaknesses.map((w) => ({
      kind: w.kind,
      count: w.occurrenceCount,
      evidence: w.supportingEvidenceIds,
      isStrategyRelated: true,
      reason: w.description,
    }))

    // 3. Active improvements
    const activeImprovements = activeStrategies.filter((s) => s.status === 'active')

    // 4. Failed improvements
    const failed = failedImprovements

    // 5. Efficiency trend
    const efficiencyTrend = this.calculateEfficiencyTrend(telemetries)

    // 6. Next improvement target
    // Sort weaknesses by occurrenceCount descending
    const sortedWeaknesses = [...weaknesses].sort((a, b) => b.occurrenceCount - a.occurrenceCount)
    const nextTarget = sortedWeaknesses[0] ?? null

    return {
      strugglingWith,
      repeatedMistakes,
      activeImprovements,
      failedImprovements: failed,
      efficiencyTrend,
      nextImprovementTarget: nextTarget,
    }
  }

  // Question: "What are you struggling with?"
  async whatAreYouStrugglingWith(): Promise<string> {
    const weaknesses = await this.store.readWeaknesses()
    if (weaknesses.length === 0) {
      return 'I have not observed sufficient recurring failure patterns to confirm a specific operational weakness.'
    }

    const items = weaknesses.map(
      (w) =>
        `- ${w.description} (observed ${w.occurrenceCount} times across ${w.sampleSize} missions; confidence: ${w.confidence}, evidence status: ${w.causalEvidenceStatus})`,
    )
    return `I am currently observing the following weaknesses:\n${items.join('\n')}`
  }

  // Question: "What mistakes do you keep making?"
  async whatMistakesDoYouKeepMaking(): Promise<string> {
    const weaknesses = await this.store.readWeaknesses()
    const strategyMistakes = weaknesses.filter((w) => w.causalEvidenceStatus !== 'insufficient_evidence')
    if (strategyMistakes.length === 0) {
      return 'No recurring strategy mistakes have been verified beyond isolated or environmental failures.'
    }

    const lines = strategyMistakes.map(
      (m) =>
        `- Pattern "${m.kind}": ${m.description} [Supported by ${m.supportingEvidenceIds.length} verified records]`,
    )
    return `Recurring operational mistakes:\n${lines.join('\n')}`
  }

  // Question: "What have you improved?"
  async whatHaveYouImproved(): Promise<readonly ActiveStrategyRecord[]> {
    const active = await this.store.readActiveStrategies()
    return active.filter((s) => s.status === 'active')
  }

  // Question: "What evidence supports that?"
  async whatEvidenceSupportsThat(id: string): Promise<readonly PerformanceTelemetry[]> {
    const telemetries = await this.store.readTelemetries()
    const weaknesses = await this.store.readWeaknesses()

    const targetWeakness = weaknesses.find((w) => w.weaknessId === id || w.kind === id)
    if (targetWeakness) {
      const evidenceSet = new Set(targetWeakness.supportingEvidenceIds)
      return telemetries.filter((t) => evidenceSet.has(t.missionId))
    }

    return telemetries.filter((t) => t.missionId === id || t.runId === id)
  }

  // Question: "Which improvements failed?"
  async whichImprovementsFailed(): Promise<readonly FailedImprovementRecord[]> {
    return await this.store.readFailedImprovements()
  }

  // Question: "Are you becoming more efficient?"
  async areYouBecomingMoreEfficient(): Promise<{
    status: 'improving' | 'stable' | 'regressing' | 'insufficient_data'
    statement: string
    sampleSize: number
  }> {
    const telemetries = await this.store.readTelemetries()
    return this.calculateEfficiencyTrend(telemetries)
  }

  // Question: "What should we improve next?"
  async whatShouldWeImproveNext(): Promise<WeaknessRecord | null> {
    const weaknesses = await this.store.readWeaknesses()
    const sorted = [...weaknesses].sort((a, b) => b.occurrenceCount - a.occurrenceCount)
    return sorted[0] ?? null
  }

  private calculateEfficiencyTrend(telemetries: readonly PerformanceTelemetry[]): {
    status: 'improving' | 'stable' | 'regressing' | 'insufficient_data'
    statement: string
    sampleSize: number
  } {
    const total = telemetries.length
    if (total < 4) {
      return {
        status: 'insufficient_data',
        statement: 'I do not have enough evidence to determine whether efficiency is improving (sample size < 4).',
        sampleSize: total,
      }
    }

    const midpoint = Math.floor(total / 2)
    const early = telemetries.slice(0, midpoint)
    const recent = telemetries.slice(midpoint)

    const earlyVerifiedRate = early.filter((t) => t.verified).length / early.length
    const recentVerifiedRate = recent.filter((t) => t.verified).length / recent.length

    if (recentVerifiedRate > earlyVerifiedRate + 0.1) {
      return {
        status: 'improving',
        statement: `Verification rate improved from ${(earlyVerifiedRate * 100).toFixed(1)}% to ${(recentVerifiedRate * 100).toFixed(1)}% over ${total} observed missions.`,
        sampleSize: total,
      }
    } else if (recentVerifiedRate < earlyVerifiedRate - 0.1) {
      return {
        status: 'regressing',
        statement: `Verification rate declined from ${(earlyVerifiedRate * 100).toFixed(1)}% to ${(recentVerifiedRate * 100).toFixed(1)}% over ${total} observed missions.`,
        sampleSize: total,
      }
    } else {
      return {
        status: 'stable',
        statement: `Performance is stable at ${(recentVerifiedRate * 100).toFixed(1)}% verification rate across ${total} observed missions.`,
        sampleSize: total,
      }
    }
  }
}
