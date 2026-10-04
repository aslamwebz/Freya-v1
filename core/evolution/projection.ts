import { EVOLUTION_LIMITS, type EvolutionState, type ImprovementState } from './types'
import type { EvolutionFoldedState } from './state'

/**
 * The evolution state projection.
 *
 * What is being improved, why, what is blocked, what is uncertain, and the
 * next bounded action. The projection is computed from the folded state, so
 * it is deterministic: same state + same clock = same projection.
 *
 * ## The projection carries no evidence or improvement text
 *
 * The broad projection carries ids, states and counts. The one read that
 * carries text is the explicit single-record read, because a person reviewing
 * an improvement has to see what it is.
 */

export interface EvolutionProjectionInput {
  readonly state: EvolutionFoldedState
  readonly now: string
}

export interface EvolutionImprovementView {
  readonly improvementId: string
  readonly kind: string
  readonly state: ImprovementState
  readonly description: string
  readonly progress: number
}

export interface EvolutionEvidenceView {
  readonly evidenceId: string
  readonly source: string
  readonly quality: string
  readonly verifiedAt: string
  readonly expiresAt: string
}

export interface EvolutionDriftCheckView {
  readonly checkId: string
  readonly improvementId: string
  readonly outcome: string
  readonly reason: string
  readonly checkedAt: string
}

export interface EvolutionNextActionView {
  readonly actionId: string
  readonly kind: string
  readonly target: string
  readonly deadlineAt: string
  readonly maxAttempts: number
  readonly reasoning: readonly string[]
}

export interface EvolutionProjection {
  readonly currentState: EvolutionState
  readonly activeImprovements: readonly EvolutionImprovementView[]
  readonly pendingEvidence: readonly EvolutionEvidenceView[]
  readonly recentDriftChecks: readonly EvolutionDriftCheckView[]
  readonly nextBoundedAction: EvolutionNextActionView | null
  readonly generatedAt: string
}

/**
 * The broad projection.
 */
export function projectEvolution(input: EvolutionProjectionInput): EvolutionProjection {
  const { state, now } = input

  const activeImprovements = state.improvements
    .filter((i) => i.state !== 'applied' && i.state !== 'failed')
    .slice(0, EVOLUTION_LIMITS.maxProjectionRecords)
    .map((i) => ({
      improvementId: i.improvementId,
      kind: i.kind,
      state: i.state,
      description: i.description,
      progress: improvementProgress(i.state),
    }))

  const pendingEvidence = state.evidence
    .slice(0, EVOLUTION_LIMITS.maxProjectionRecords)
    .map((e) => ({
      evidenceId: e.evidenceId,
      source: e.source,
      quality: e.quality,
      verifiedAt: e.verifiedAt,
      expiresAt: e.expiresAt,
    }))

  const recentDriftChecks = state.driftChecks
    .slice(0, EVOLUTION_LIMITS.maxProjectionRecords)
    .map((d) => ({
      checkId: d.checkId,
      improvementId: d.improvementId,
      outcome: d.outcome,
      reason: d.reason,
      checkedAt: d.checkedAt,
    }))

  const nextBoundedAction = computeNextBoundedAction(state, now)

  return Object.freeze({
    currentState: state.currentState,
    activeImprovements: Object.freeze(activeImprovements),
    pendingEvidence: Object.freeze(pendingEvidence),
    recentDriftChecks: Object.freeze(recentDriftChecks),
    nextBoundedAction,
    generatedAt: now,
  })
}

/**
 * The next bounded action, computed from the state.
 *
 * The action is always bounded: it has a deadline, a maximum attempt count,
 * and a reasoning. There is no unbounded action, no unrestricted loop, no
 * background reasoning.
 */
function computeNextBoundedAction(
  state: EvolutionFoldedState,
  now: string,
): EvolutionNextActionView | null {
  if (state.stopAllLatched) {
    return {
      actionId: 'act-stop',
      kind: 'stop',
      target: 'all',
      deadlineAt: now,
      maxAttempts: 0,
      reasoning: Object.freeze(['STOP ALL is latched; no action is permitted.']),
    }
  }

  const activeImprovement = state.improvements.find(
    (i) => i.state === 'proposed' || i.state === 'evaluating',
  )
  if (activeImprovement !== undefined) {
    return {
      actionId: `act-evaluate-${activeImprovement.improvementId}`,
      kind: 'evaluate',
      target: activeImprovement.improvementId,
      deadlineAt: now,
      maxAttempts: EVOLUTION_LIMITS.maxRetryCeiling,
      reasoning: Object.freeze([
        `improvement ${activeImprovement.improvementId} is ${activeImprovement.state} and needs evaluation`,
      ]),
    }
  }

  const pendingEvidence = state.evidence.length
  if (pendingEvidence > 0) {
    return {
      actionId: 'act-verify-evidence',
      kind: 'verify',
      target: 'evidence',
      deadlineAt: now,
      maxAttempts: EVOLUTION_LIMITS.maxRetryCeiling,
      reasoning: Object.freeze([`${pendingEvidence} piece(s) of evidence are pending verification`]),
    }
  }

  return {
    actionId: 'act-wait',
    kind: 'wait',
    target: 'wake',
    deadlineAt: now,
    maxAttempts: 0,
    reasoning: Object.freeze(['no action is owed; the next bounded action is a wake']),
  }
}

function improvementProgress(state: ImprovementState): number {
  const order: Readonly<Record<ImprovementState, number>> = Object.freeze({
    proposed: 0,
    evaluating: 0.25,
    approved: 0.5,
    staged: 0.75,
    applied: 1,
    failed: 0,
  })
  return order[state]
}
