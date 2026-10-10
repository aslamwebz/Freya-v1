/**
 * FREYA METACOGNITION — Performance Observer & Failure Attribution
 *
 * Observes production outcomes from Missions and Work runs.
 * Distinguishes external/environmental outages from Freya's own strategy defects.
 * Strictly 0 model calls and zero fabricated telemetry.
 */

import type { FailureAttribution, PerformanceTelemetry } from './types'
import type { MetacognitionStore } from './store'

const ENVIRONMENTAL_ERROR_PATTERN =
  /network|timeout|timed out|connection refused|socket hang up|econnrefused|dns|enotfound|fetch failed|econnreset/i
const EXTERNAL_DENIAL_PATTERN =
  /guard denied|permission denied|unauthorized|forbidden|governor rejected|approval rejected|stop all active/i
const TOOL_OUTAGE_PATTERN =
  /500 internal server error|502 bad gateway|503 service unavailable|504 gateway timeout|rate limit exceeded|http 429|http 5\d\d/i
const STRATEGY_DEFECT_PATTERN =
  /insufficient_sources|source changed|retrieval_not_established|source_verification_failed|wrong argument|invalid parameter|repeated query/i
const MODEL_MISDIRECTION_PATTERN =
  /invalid_plan|hallucinated tool|unknown tool|schema mismatch|malformed output/i

export function attributeFailure(
  rawError?: string | null,
  context?: Record<string, unknown>,
): FailureAttribution | null {
  if (!rawError || !rawError.trim()) return null

  const err = rawError.trim()

  if (ENVIRONMENTAL_ERROR_PATTERN.test(err)) {
    return {
      category: 'environmental',
      isStrategyDefect: false,
      reason: `Environmental or network disruption: ${err}`,
      details: context,
    }
  }

  if (EXTERNAL_DENIAL_PATTERN.test(err)) {
    return {
      category: 'external_denial',
      isStrategyDefect: false,
      reason: `Authorized external boundary refusal: ${err}`,
      details: context,
    }
  }

  if (TOOL_OUTAGE_PATTERN.test(err)) {
    return {
      category: 'tool_outage',
      isStrategyDefect: false,
      reason: `External service or tool server outage: ${err}`,
      details: context,
    }
  }

  if (STRATEGY_DEFECT_PATTERN.test(err)) {
    return {
      category: 'strategy_defect',
      isStrategyDefect: true,
      reason: `Strategy defect in source selection or execution parameters: ${err}`,
      details: context,
    }
  }

  if (MODEL_MISDIRECTION_PATTERN.test(err)) {
    return {
      category: 'model_misdirection',
      isStrategyDefect: true,
      reason: `Model planning or tool generation defect: ${err}`,
      details: context,
    }
  }

  return {
    category: 'unknown',
    isStrategyDefect: false,
    reason: `Unclassified failure: ${err}`,
    details: context,
  }
}

export interface ObserveMissionOptions {
  readonly missionId: string
  readonly runId?: string
  readonly taskType?: string
  readonly outcome: 'success' | 'failure' | 'partial' | 'cancelled'
  readonly verified: boolean
  readonly verificationReason?: string | null
  readonly planRevisions?: number
  readonly actionAttempts?: number
  readonly toolErrors?: number
  readonly durationMs?: number | null
  readonly modelTokens?: number | null
  readonly modelCalls?: number | null
  readonly externalRequests?: number | null
  readonly failedAuthorizations?: number
  readonly budgetExhausted?: boolean
  readonly duplicateWorkAvoided?: number
  readonly restartRecoveryQuality?: 'perfect' | 'degraded' | 'failed' | null
  readonly userCorrections?: number
  readonly ownerInterventions?: number
  readonly rawErrorMessage?: string | null
  readonly recordedAt?: string
}

export class PerformanceObserver {
  constructor(private readonly store: MetacognitionStore) {}

  async observeMission(options: ObserveMissionOptions): Promise<PerformanceTelemetry> {
    const failureAttribution =
      options.outcome !== 'success'
        ? attributeFailure(options.rawErrorMessage, {
            verificationReason: options.verificationReason,
          })
        : null

    const telemetry: PerformanceTelemetry = {
      missionId: options.missionId,
      runId: options.runId,
      taskType: options.taskType ?? 'general',
      outcome: options.outcome,
      verified: options.verified,
      verificationReason: options.verificationReason ?? null,
      planRevisions: options.planRevisions ?? 0,
      actionAttempts: options.actionAttempts ?? 0,
      toolErrors: options.toolErrors ?? 0,
      // Strictly maintain null/undefined when unmeasured; never synthesize numbers
      durationMs: options.durationMs !== undefined ? options.durationMs : null,
      modelTokens: options.modelTokens !== undefined ? options.modelTokens : null,
      modelCalls: options.modelCalls !== undefined ? options.modelCalls : null,
      externalRequests: options.externalRequests !== undefined ? options.externalRequests : null,
      failedAuthorizations: options.failedAuthorizations ?? 0,
      budgetExhausted: options.budgetExhausted ?? false,
      duplicateWorkAvoided: options.duplicateWorkAvoided ?? 0,
      restartRecoveryQuality: options.restartRecoveryQuality ?? null,
      userCorrections: options.userCorrections ?? 0,
      ownerInterventions: options.ownerInterventions ?? 0,
      failureAttribution,
      recordedAt: options.recordedAt ?? new Date().toISOString(),
    }

    await this.store.writeTelemetry(telemetry)
    return telemetry
  }

  async getRecentTelemetries(): Promise<readonly PerformanceTelemetry[]> {
    return await this.store.readTelemetries()
  }
}
