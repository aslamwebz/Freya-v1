/**
 * FREYA METACOGNITION — Weakness Classifier
 *
 * Discovers evidence-backed recurring failure patterns and classifies weaknesses.
 * Distinguishes external/environmental failures from strategy defects.
 * Strictly 0 model calls, statistical restraint, and evidence linking.
 */

import type {
  MetacognitiveConfidence,
  CausalEvidenceStatus,
  PerformanceTelemetry,
  WeaknessKind,
  WeaknessRecord,
} from './types'
import type { MetacognitionStore } from './store'

export interface ClassifyWeaknessOptions {
  readonly minOccurrences?: number
}

export class WeaknessClassifier {
  constructor(private readonly store: MetacognitionStore) {}

  async analyzeAndClassify(options?: ClassifyWeaknessOptions): Promise<readonly WeaknessRecord[]> {
    const telemetries = await this.store.readTelemetries()
    const minOccurrences = options?.minOccurrences ?? 2

    const weaknesses: WeaknessRecord[] = []

    // 1. Poor Source Selection
    const sourceSelectionDefects = telemetries.filter((t) => {
      if (t.outcome === 'success' && t.verified) return false
      const attr = t.failureAttribution
      if (!attr || !attr.isStrategyDefect) return false
      const reasonLower = (attr.reason + ' ' + (t.verificationReason ?? '')).toLowerCase()
      return (
        reasonLower.includes('source') ||
        reasonLower.includes('retrieval') ||
        reasonLower.includes('excerpt')
      )
    })

    if (sourceSelectionDefects.length >= minOccurrences) {
      weaknesses.push(
        this.buildWeaknessRecord(
          'weakness-poor-source-selection',
          'poor_source_selection',
          'Repeated retrieval or verification failure due to suboptimal research source ranking and selection',
          sourceSelectionDefects,
          telemetries.length,
        ),
      )
    }

    // 2. Unnecessary Replanning
    const excessiveReplanning = telemetries.filter((t) => t.planRevisions >= 2)
    if (excessiveReplanning.length >= minOccurrences) {
      weaknesses.push(
        this.buildWeaknessRecord(
          'weakness-unnecessary-replanning',
          'unnecessary_replanning',
          'Multiple plan revisions required during mission execution before settlement',
          excessiveReplanning,
          telemetries.length,
        ),
      )
    }

    // 3. Excessive Model Calls
    const excessiveModelCalls = telemetries.filter(
      (t) => t.modelCalls !== null && t.modelCalls > 5,
    )
    if (excessiveModelCalls.length >= minOccurrences) {
      weaknesses.push(
        this.buildWeaknessRecord(
          'weakness-excessive-model-calls',
          'excessive_model_calls',
          'Missions regularly consume more than 5 model calls due to iterative uncertainty',
          excessiveModelCalls,
          telemetries.length,
        ),
      )
    }

    // 4. Repeated Tool Errors (Strategy Defect)
    const strategyToolErrors = telemetries.filter((t) => {
      return (
        t.toolErrors >= 2 &&
        t.failureAttribution?.isStrategyDefect === true
      )
    })
    if (strategyToolErrors.length >= minOccurrences) {
      weaknesses.push(
        this.buildWeaknessRecord(
          'weakness-repeated-tool-errors',
          'repeated_tool_errors',
          'Missions encounter multiple strategy-related tool parameter or execution errors',
          strategyToolErrors,
          telemetries.length,
        ),
      )
    }

    // 5. Repeated Action Failures
    const repeatedActionFailures = telemetries.filter((t) => {
      return (
        t.actionAttempts >= 3 &&
        t.outcome !== 'success' &&
        t.failureAttribution?.isStrategyDefect === true
      )
    })
    if (repeatedActionFailures.length >= minOccurrences) {
      weaknesses.push(
        this.buildWeaknessRecord(
          'weakness-repeated-action-failures',
          'repeated_action_failures',
          'Multiple redundant action attempts made without achieving verified success',
          repeatedActionFailures,
          telemetries.length,
        ),
      )
    }

    await this.store.writeWeaknesses(weaknesses)
    return weaknesses
  }

  private buildWeaknessRecord(
    id: string,
    kind: WeaknessKind,
    description: string,
    evidenceItems: readonly PerformanceTelemetry[],
    totalSampleCount: number,
  ): WeaknessRecord {
    const count = evidenceItems.length

    let confidence: MetacognitiveConfidence
    let causalEvidenceStatus: CausalEvidenceStatus

    if (count >= 6) {
      confidence = 'strong'
      causalEvidenceStatus = 'correlated'
    } else if (count >= 3) {
      confidence = 'moderate'
      causalEvidenceStatus = 'correlated'
    } else {
      confidence = 'preliminary'
      causalEvidenceStatus = 'insufficient_evidence'
    }

    const timestamps = evidenceItems.map((e) => e.recordedAt).sort()
    const firstObservedAt = timestamps[0] ?? new Date().toISOString()
    const lastObservedAt = timestamps[timestamps.length - 1] ?? firstObservedAt

    return {
      weaknessId: id,
      kind,
      description,
      occurrenceCount: count,
      supportingEvidenceIds: evidenceItems.map((e) => e.missionId),
      confidence,
      causalEvidenceStatus,
      sampleSize: totalSampleCount,
      firstObservedAt,
      lastObservedAt,
    }
  }
}
