/**
 * Phase 32 — Compile-Time Types and Interfaces
 *
 * **Status:** PREPARATION ONLY — NOT PRODUCTION
 *
 * These types and interfaces are compile-time only. They cannot activate
 * runtime behavior. They define the shape of Phase 32's components.
 *
 * These types are safe to cherry-pick later. They do not import any runtime
 * module. They do not create any side effects. They are pure type definitions.
 */

/* --------------------------------------------------------- experiments */

/**
 * The closed set of economic experiment states.
 */
export const ECONOMIC_EXPERIMENT_STATES = [
  'draft',
  'active',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const
export type EconomicExperimentState = (typeof ECONOMIC_EXPERIMENT_STATES)[number]

export function isEconomicExperimentState(value: unknown): value is EconomicExperimentState {
  return typeof value === 'string' && (ECONOMIC_EXPERIMENT_STATES as readonly string[]).includes(value)
}

/**
 * The closed set of economic experiment kinds.
 */
export const ECONOMIC_EXPERIMENT_KINDS = ['research', 'simulation', 'paper-trading'] as const
export type EconomicExperimentKind = (typeof ECONOMIC_EXPERIMENT_KINDS)[number]

export function isEconomicExperimentKind(value: unknown): value is EconomicExperimentKind {
  return typeof value === 'string' && (ECONOMIC_EXPERIMENT_KINDS as readonly string[]).includes(value)
}

/**
 * An economic experiment.
 */
export interface EconomicExperiment {
  readonly experimentId: string
  readonly kind: EconomicExperimentKind
  readonly state: EconomicExperimentState
  readonly title: string
  readonly description: string
  readonly completionCriteria: readonly string[]
  readonly progress: number
  readonly deadlineAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly completedAt: string | null
}

/* --------------------------------------------------------- research */

/**
 * A piece of research evidence.
 */
export interface ResearchEvidence {
  readonly evidenceId: string
  readonly experimentId: string
  readonly source: string
  readonly citation: string
  readonly observedAt: string
  readonly state: 'fresh' | 'stale' | 'conflicted' | 'missing'
  readonly confidence: 'high' | 'medium' | 'low' | 'unknown'
}

/* --------------------------------------------------------- simulation */

/**
 * A simulation scenario.
 */
export interface SimulationScenario {
  readonly scenarioId: string
  readonly experimentId: string
  readonly name: string
  readonly parameters: Readonly<Record<string, number>>
  readonly assumptions: readonly string[]
  readonly status: 'pending' | 'running' | 'completed' | 'failed'
  readonly result: SimulationResult | null
}

/**
 * A simulation result.
 */
export interface SimulationResult {
  readonly resultId: string
  readonly scenarioId: string
  readonly metrics: Readonly<Record<string, number>>
  readonly startedAt: string
  readonly completedAt: string
}

/* --------------------------------------------------------- paper trading */

/**
 * A paper trading order (simulated, no real order).
 */
export interface PaperOrder {
  readonly orderId: string
  readonly experimentId: string
  readonly symbol: string
  readonly side: 'buy' | 'sell'
  readonly quantity: number
  readonly price: number
  readonly placedAt: string
  readonly status: 'filled' | 'pending' | 'cancelled'
}

/**
 * A paper portfolio entry.
 */
export interface PaperPortfolioEntry {
  readonly entryId: string
  readonly experimentId: string
  readonly symbol: string
  readonly quantity: number
  readonly averagePrice: number
  readonly currentPrice: number
  readonly unrealizedPnl: number
}

/* --------------------------------------------------------- metrics */

/**
 * A performance metric with explicit denominator.
 */
export interface EconomicMetric {
  readonly metricId: string
  readonly experimentId: string
  readonly name: string
  readonly value: number
  readonly denominator: number
  readonly unit: string
  readonly computedAt: string
}

/* --------------------------------------------------------- explainability */

/**
 * The explainable economic state.
 */
export interface EconomicStateProjection {
  readonly activeExperiments: readonly ExperimentSummary[]
  readonly blockedExperiments: readonly ExperimentSummary[]
  readonly uncertainExperiments: readonly ExperimentSummary[]
  readonly recentEvidence: readonly ResearchEvidence[]
  readonly nextBoundedAction: BoundedAction | null
  readonly generatedAt: string
}

/**
 * An experiment summary in the economic state.
 */
export interface ExperimentSummary {
  readonly experimentId: string
  readonly kind: EconomicExperimentKind
  readonly state: EconomicExperimentState
  readonly title: string
  readonly progress: number
  readonly reasoning: readonly string[]
  readonly blockedReason: string | null
  readonly uncertainty: readonly string[]
}

/**
 * A bounded next action.
 */
export interface BoundedAction {
  readonly actionId: string
  readonly kind: 'execute' | 'delegate' | 'verify' | 'wait' | 'escalate' | 'stop'
  readonly target: string
  readonly deadlineAt: string
  readonly maxAttempts: number
  readonly reasoning: readonly string[]
}

/* --------------------------------------------------------- limits */

/**
 * The economic limits.
 *
 * These are code-owned ceilings. They cannot be widened.
 */
export const ECONOMIC_LIMITS = Object.freeze({
  maxExperiments: 16,
  maxScenariosPerExperiment: 32,
  maxPaperOrdersPerExperiment: 256,
  maxEvidencePerExperiment: 128,
  maxExperimentDurationMs: 30 * 24 * 60 * 60 * 1_000,
  maxSimulationDurationMs: 24 * 60 * 60 * 1_000,
  maxPaperTradingDurationMs: 30 * 24 * 60 * 60 * 1_000,
  maxRetryCeiling: 3,
  maxBackoffMs: 5 * 60_000,
  baseBackoffMs: 1_000,
  jitterMs: 1_000,
})

/* --------------------------------------------------------- events */

/**
 * The economic event types.
 *
 * These are the event types the economic subsystem appends.
 */
export const ECONOMIC_EVENT_TYPES = [
  'economic.experiment.created',
  'economic.experiment.updated',
  'economic.experiment.state-changed',
  'economic.experiment.completed',
  'economic.experiment.failed',
  'economic.experiment.cancelled',
  'economic.evidence.gathered',
  'economic.simulation.started',
  'economic.simulation.completed',
  'economic.paper-order.placed',
  'economic.paper-order.filled',
  'economic.metric.computed',
  'economic.continuation.decided',
  'economic.wake.received',
  'economic.wake.denied',
] as const

export type EconomicEventType = (typeof ECONOMIC_EVENT_TYPES)[number]
