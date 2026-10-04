import type { BoundedAction, ThresholdAssertionVerdict, ThresholdLimits, ThresholdState } from './types'
import type { ThresholdFoldedState } from './state'
import type { ThresholdSnapshot } from './runtime'

export const THRESHOLD_SCHEMA_VERSION = 1

export const NO_REAL_MONEY =
  'The Mature Freya Threshold performs no real-money actions, no real spending and no real financial transactions.'

export const PROJECTED_THRESHOLD_ACTION_KINDS = [
  'assess',
  'collect',
  'verify',
  'evaluate',
  'prove',
  'suspend',
  'rollback',
  'wait',
  'escalate',
  'stop',
] as const

export type ProjectedThresholdActionKind = (typeof PROJECTED_THRESHOLD_ACTION_KINDS)[number]

export const PROJECTED_THRESHOLD_KIND_ORDER: Readonly<Record<ProjectedThresholdActionKind, number>> =
  Object.freeze({
    assess: 0,
    collect: 1,
    verify: 2,
    evaluate: 3,
    prove: 4,
    suspend: 5,
    rollback: 6,
    wait: 7,
    escalate: 8,
    stop: 9,
  })

export interface ThresholdProjectionInput {
  readonly state: ThresholdFoldedState
  readonly snapshot: ThresholdSnapshot
  readonly now: string
  readonly sequence: number
}

export interface ThresholdCountersView {
  readonly assessmentsStarted: number
  readonly assessmentsCompleted: number
  readonly evidenceCollected: number
  readonly evidenceVerified: number
  readonly failClosedTriggered: number
  readonly decisionsProven: number
  readonly decisionsNotProven: number
  readonly rollbacksStarted: number
  readonly rollbacksCompleted: number
  readonly refusals: number
}

export interface ThresholdAssessmentView {
  readonly assessmentId: string
  readonly dimension: string
  readonly level: string | null
  readonly criteriaCount: number
  readonly evidenceCount: number
  readonly startedAt: string
  readonly completedAt: string | null
}

export interface ThresholdEvidenceView {
  readonly evidenceId: string
  readonly criterionId: string
  readonly source: string
  readonly quality: string | null
  readonly collectedAt: string
  readonly verifiedAt: string | null
  readonly expiresAt: string | null
}

export interface ThresholdFailClosedView {
  readonly recordId: string
  readonly kind: string
  readonly reason: string
  readonly triggeredAt: string
  readonly resolution: string | null
}

export interface ThresholdRollbackView {
  readonly rollbackId: string
  readonly reason: string
  readonly triggeredAt: string
  readonly approvedBy: string | null
  readonly completedAt: string | null
}

export interface ThresholdRedTeamView {
  readonly refusedAttempts: number
  readonly recentRefusals: readonly string[]
}

export interface ThresholdSummaryView {
  readonly currentState: ThresholdState
  readonly lastDecision: string | null
  readonly lastDecisionAt: string | null
  readonly recentAssessments: readonly ThresholdAssessmentView[]
  readonly recentEvidence: readonly ThresholdEvidenceView[]
  readonly recentFailClosed: readonly ThresholdFailClosedView[]
  readonly recentRollbacks: readonly ThresholdRollbackView[]
  readonly nextBoundedAction: BoundedAction | null
  readonly counters: ThresholdCountersView
  readonly redTeam: ThresholdRedTeamView
  readonly lastRefusal: { readonly code: string; readonly at: string } | null
  readonly requiresOwnerAction: boolean
  readonly assertions: ThresholdAssertionVerdict | null
  readonly limits: ThresholdLimits
  readonly narrowedLimits: readonly string[]
  readonly realMoney: string
}

export interface ThresholdProjection {
  readonly health: 'unproven' | 'assessing' | 'evidencing' | 'evaluating' | 'proven' | 'suspended' | 'rolled-back'
  readonly reason: string | null
  readonly schemaVersion: number
  readonly sequence: number
  readonly generatedAt: string
  readonly summary: ThresholdSummaryView
}

export function projectThresholdState(input: ThresholdProjectionInput): ThresholdProjection {
  const { state, snapshot, now } = input
  const { limits } = snapshot

  const recentAssessments = state.assessments.slice(-16).map((a) => ({
    assessmentId: a.assessmentId,
    dimension: a.dimension,
    level: a.level,
    criteriaCount: a.criteriaCount,
    evidenceCount: a.evidenceCount,
    startedAt: a.startedAt,
    completedAt: a.completedAt,
  }))

  const recentEvidence = state.evidence.slice(-16).map((e) => ({
    evidenceId: e.evidenceId,
    criterionId: e.criterionId,
    source: e.source,
    quality: e.quality,
    collectedAt: e.collectedAt,
    verifiedAt: e.verifiedAt,
    expiresAt: e.expiresAt,
  }))

  const recentFailClosed = state.failClosed.slice(-16).map((f) => ({
    recordId: f.recordId,
    kind: f.kind,
    reason: f.reason,
    triggeredAt: f.triggeredAt,
    resolution: f.resolution,
  }))

  const recentRollbacks = state.rollbacks.slice(-16).map((r) => ({
    rollbackId: r.rollbackId,
    reason: r.reason,
    triggeredAt: r.triggeredAt,
    approvedBy: r.approvedBy,
    completedAt: r.completedAt,
  }))

  const nextAction = nextBoundedAction(state, snapshot, now, limits)

  const health = snapshot.status.stopAllLatched
    ? 'suspended'
    : state.currentState === 'UNPROVEN'
      ? 'unproven'
      : state.currentState === 'ASSESSING'
        ? 'assessing'
        : state.currentState === 'EVIDENCING'
          ? 'evidencing'
          : state.currentState === 'EVALUATING'
            ? 'evaluating'
            : state.currentState === 'PROVEN'
              ? 'proven'
              : state.currentState === 'SUSPENDED'
                ? 'suspended'
                : 'rolled-back'

  const reason = snapshot.status.stopAllLatched
    ? 'Freya is stopped, so the threshold is holding rather than working'
    : state.currentState === 'UNPROVEN'
      ? 'Maturity has not been proven'
      : state.currentState === 'ASSESSING'
        ? 'A maturity assessment is in progress'
        : state.currentState === 'EVIDENCING'
          ? 'Evidence is being collected'
          : state.currentState === 'EVALUATING'
            ? 'Evidence is being evaluated'
            : state.currentState === 'PROVEN'
              ? null
              : state.currentState === 'SUSPENDED'
                ? 'The threshold is suspended'
                : 'The threshold has been rolled back'

  return {
    health,
    reason,
    schemaVersion: THRESHOLD_SCHEMA_VERSION,
    sequence: input.sequence,
    generatedAt: now,
    summary: {
      currentState: state.currentState,
      lastDecision: state.lastDecision,
      lastDecisionAt: state.lastDecisionAt,
      recentAssessments,
      recentEvidence,
      recentFailClosed,
      recentRollbacks,
      nextBoundedAction: nextAction,
      counters: {
        assessmentsStarted: state.assessments.length,
        assessmentsCompleted: state.assessments.filter((a) => a.completedAt !== null).length,
        evidenceCollected: state.evidence.length,
        evidenceVerified: state.evidence.filter((e) => e.verifiedAt !== null).length,
        failClosedTriggered: state.failClosed.length,
        decisionsProven: state.lastDecision === 'proven' ? 1 : 0,
        decisionsNotProven: state.lastDecision === 'not-proven' ? 1 : 0,
        rollbacksStarted: state.rollbacks.length,
        rollbacksCompleted: state.rollbacks.filter((r) => r.completedAt !== null).length,
        refusals: state.refusals.length,
      },
      redTeam: {
        refusedAttempts: state.refusals.length,
        recentRefusals: state.refusals.slice(-32).map((r) => r.code),
      },
      lastRefusal:
        state.lastRefusalCode === null
          ? null
          : { code: state.lastRefusalCode, at: state.lastRefusalAt ?? '' },
      requiresOwnerAction: snapshot.status.stopAllLatched,
      assertions: snapshot.assertions?.checks ?? null,
      limits,
      narrowedLimits: snapshot.narrowedLimits,
      realMoney: NO_REAL_MONEY,
    },
  }
}

function nextBoundedAction(
  state: ThresholdFoldedState,
  snapshot: ThresholdSnapshot,
  now: string,
  limits: ThresholdLimits,
): BoundedAction | null {
  if (snapshot.status.stopAllLatched) {
    return {
      actionId: 'action-stop',
      kind: 'stop',
      target: 'all',
      deadlineAt: now,
      maxAttempts: 0,
      reasoning: ['Freya is stopped. No action is possible until the owner clears the latch.'],
    }
  }

  if (state.currentState === 'UNPROVEN') {
    return {
      actionId: 'action-assess',
      kind: 'assess',
      target: 'maturity',
      deadlineAt: now,
      maxAttempts: limits.maxRetryCeiling,
      reasoning: ['Maturity has not been proven. The next bounded action is to assess.'],
    }
  }

  if (state.currentState === 'ASSESSING') {
    return {
      actionId: 'action-collect',
      kind: 'collect',
      target: 'evidence',
      deadlineAt: now,
      maxAttempts: limits.maxRetryCeiling,
      reasoning: ['A maturity assessment is in progress. The next bounded action is to collect evidence.'],
    }
  }

  if (state.currentState === 'EVIDENCING') {
    return {
      actionId: 'action-verify',
      kind: 'verify',
      target: 'evidence',
      deadlineAt: now,
      maxAttempts: limits.maxRetryCeiling,
      reasoning: ['Evidence is being collected. The next bounded action is to verify.'],
    }
  }

  if (state.currentState === 'EVALUATING') {
    return {
      actionId: 'action-evaluate',
      kind: 'evaluate',
      target: 'maturity',
      deadlineAt: now,
      maxAttempts: limits.maxRetryCeiling,
      reasoning: ['Evidence is being evaluated. The next bounded action is to evaluate.'],
    }
  }

  if (state.currentState === 'PROVEN') {
    return {
      actionId: 'action-wait',
      kind: 'wait',
      target: 'evidence',
      deadlineAt: now,
      maxAttempts: limits.maxRetryCeiling,
      reasoning: ['Maturity is proven. The next bounded action is to wait for new evidence.'],
    }
  }

  if (state.currentState === 'SUSPENDED') {
    return {
      actionId: 'action-escalate',
      kind: 'escalate',
      target: 'owner',
      deadlineAt: now,
      maxAttempts: 1,
      reasoning: ['The threshold is suspended. The next bounded action is to escalate to the owner.'],
    }
  }

  return null
}
