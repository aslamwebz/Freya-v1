import type { EconomicAuthorityFacts } from '../../../core/economic/authority'
import {
  ECONOMIC_EXPERIMENT_KINDS,
  ECONOMIC_REFUSAL_CODES,
  ECONOMIC_SIGNALS,
  ECONOMIC_STAGES,
  type EconomicExperimentKind,
  type EconomicStage,
  type ResearchEvidence,
} from '../../../core/economic/types'
import {
  initialEconomicState,
  type EconomicExperimentRecord,
  type EconomicState,
} from '../../../core/economic/state'

/**
 * Fixtures for the economic domain.
 *
 * Every time in here is a literal. Nothing calls `Date.now()`, so a test that says "after
 * the deadline" means exactly that and not "roughly a minute ago" on a slow machine.
 *
 * The factories keep the stages and kinds in agreement with their type unions, because a
 * fixture that could produce an impossible stage would turn a state-machine test into a
 * test of the fixture.
 */

/**
 * Authority that permits exactly as much as a mutating command needs and no more.
 *
 * Built field by field rather than spread from a `satisfied()` helper, because a test that
 * wants the Governor to refuse should have to *say* so — a helper that returned
 * "everything but the thing under test" is a helper that quietly stops testing.
 */
export function authority(overrides: Partial<EconomicAuthorityFacts> = {}): EconomicAuthorityFacts {
  return {
    journalTrustworthy: true,
    stopAllActive: false,
    enabled: true,
    capabilityAllowed: true,
    cognitionAuthorized: true,
    budgetRemainingUnits: 1_000,
    approvalSatisfied: true,
    realMoney: false,
    ...overrides,
  }
}

/** An experiment record, in a stage of the caller's choosing. */
export function record(overrides: Partial<EconomicExperimentRecord> = {}): EconomicExperimentRecord {
  return {
    experimentId: overrides.experimentId ?? 'exp-1',
    kind: overrides.kind ?? 'research',
    state: overrides.state ?? 'active',
    stage: overrides.stage ?? 'RESEARCHING',
    title: overrides.title ?? 'A bounded question',
    question: overrides.question ?? 'Would anyone pay for this?',
    completionCriteria: overrides.completionCriteria ?? ['peer-reviewed-demand'],
    progress: overrides.progress ?? 0,
    deadlineAt: overrides.deadlineAt === undefined ? '2026-03-31T09:00:00.000Z' : overrides.deadlineAt,
    createdAt: overrides.createdAt ?? '2026-03-01T09:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-03-01T09:00:00.000Z',
    completedAt: overrides.completedAt === undefined ? null : overrides.completedAt,
  }
}

/** Evidence about one claim, in a state of the caller's choosing. */
export function evidence(overrides: Partial<ResearchEvidence> = {}): ResearchEvidence {
  return {
    evidenceId: overrides.evidenceId ?? 'ev-1',
    experimentId: overrides.experimentId ?? 'exp-1',
    source: overrides.source ?? 'published-study',
    sourceRef: overrides.sourceRef ?? 'filing-2026-01',
    citation: overrides.citation ?? 'A published study, 2026',
    observedAt: overrides.observedAt ?? '2026-03-01T09:00:00.000Z',
    state: overrides.state ?? 'fresh',
    confidence: overrides.confidence ?? 'medium',
    claim: overrides.claim ?? 'peer-reviewed-demand',
  }
}

/** A state with nothing in it, so a fold test starts from a known place. */
export function emptyState(): EconomicState {
  return initialEconomicState()
}

/** Every stage, for exhaustion tests. */
export const ALL_STAGES: readonly EconomicStage[] = ECONOMIC_STAGES

/** Every signal, for exhaustion tests. */
export const ALL_SIGNALS = ECONOMIC_SIGNALS

/** Every kind, for "each kind can fail from the stage it opens in". */
export const ALL_KINDS: readonly EconomicExperimentKind[] = ECONOMIC_EXPERIMENT_KINDS

/** Every refusal code, so a table that loses one fails a test rather than a review. */
export const ALL_REFUSAL_CODES = ECONOMIC_REFUSAL_CODES