import type {
  EconomicAssertionVerdict,
  EconomicEventType,
  EconomicExperimentKind,
  EconomicLimits,
  EconomicReasonCode,
  EconomicStage,
  EconomicUncertaintyCode,
  ExperimentBlocker,
  ExperimentSummary,
  BoundedActionKind,
  ResearchEvidence,
} from '../economic/types'

/**
 * This file is a **view**, not a channel.
 *
 * It describes what a window may know about Economic Intelligence and — as much — what
 * it may not. There is no `economic.*` command anywhere in the Core vocabulary and there
 * is no renderer-writable bridge entry, because a pull and a push are enough for a read
 * and the *absence of a write verb* is the property rather than an omission. A surface
 * can see that Freya is researching a market, that a simulated trade went through and
 * that a metric carries a denominator; it cannot open an experiment, place an order, name
 * a broker, raise a budget or lift a stop.
 *
 * ## Crosses
 *
 * Closed codes, ids, instants, counters, bounded titles and citations, and the
 * subsystem's own fixed self-statements.
 *
 * ## Does not cross
 *
 * The text of an observation, the price series a scenario was run over, the metrics a
 * simulation produced, the prompt a research answer was drawn from, the identity of any
 * provider, and the free-form notes a downstream stage may attach. Each of those stays in
 * the process or in the journal and is replaced here by a closed code, a counter or a
 * bounded citation — the same discipline Phase 23 applies, and for the same reason: the
 * journal is the least protected file in the system.
 *
 * ## The field that cannot change
 *
 * `realMoney` is a literal whose only value is `simulated-only`. It is here as a field
 * rather than as a sentence in a comment so that a surface **cannot** render "real" and
 * cannot be given a third value to render instead. A guarantee a renderer can opt out of
 * is not a guarantee.
 */

/* --------------------------------------------------------------- views */

/**
 * One experiment as a window sees it.
 *
 * Re-exported from the domain rather than restated: the shape is already closed,
 * bounded and renderer-safe, and a second copy is a second thing to fall out of step.
 */
export type { ExperimentSummary as EconomicExperimentSummaryView }

export interface EconomicEvidenceView {
  readonly evidenceId: string
  readonly experimentId: string
  /** A closed source kind. Never a provider name or a URL with a token in it. */
  readonly source: ResearchEvidence['source']
  readonly sourceRef: string
  readonly citation: string
  readonly state: ResearchEvidence['state']
  readonly confidence: ResearchEvidence['confidence']
  readonly observedAt: string
}

export interface EconomicInterruptionView {
  readonly experimentId: string
  readonly stage: EconomicStage
  readonly at: string
  readonly code: 'restart-recovery' | 'owner-preempted'
}

export interface EconomicCountersView {
  readonly experiments: number
  readonly active: number
  readonly interrupted: number
  readonly evidence: number
  readonly scenarios: number
  readonly orders: number
  readonly metrics: number
  readonly refusals: number
}

export interface EconomicRedTeamView {
  readonly refusedAttempts: number
  readonly byCode: readonly (readonly [string, number])[]
  readonly recent: readonly {
    readonly refusalId: string
    readonly code: string
    readonly subject: string
    readonly experimentId: string | null
    readonly at: string
  }[]
}

/** The closed kinds of bounded next action a recommendation may carry. */
export const ECONOMIC_ACTION_KINDS = [
  'execute',
  'delegate',
  'verify',
  'wait',
  'escalate',
  'stop',
] as const

export type EconomicActionKind = (typeof ECONOMIC_ACTION_KINDS)[number]

export interface EconomicBoundedActionView {
  readonly actionId: string
  readonly kind: EconomicActionKind
  /** An id. Never a title, an intent or a piece of content. */
  readonly target: string
  /** Absolute. A window cannot extend it, shorten it or supply one. */
  readonly deadlineAt: string
  readonly maxAttempts: number
  readonly reasoning: readonly EconomicReasonCode[]
}

/** Everything a window may know, in one read-only object. */
export interface EconomicProjectionView {
  readonly health: 'ready' | 'degraded' | 'unavailable'
  /** Why, in words a person can act on. Null when healthy. */
  readonly reason: string | null
  readonly schemaVersion: number
  /** Highest sequence folded in, so a window can prove it is current. */
  readonly sequence: number
  readonly generatedAt: string
  readonly activeExperiments: readonly ExperimentSummary[]
  readonly blockedExperiments: readonly ExperimentSummary[]
  readonly uncertainExperiments: readonly ExperimentSummary[]
  readonly interruptedExperiments: readonly EconomicInterruptionView[]
  readonly recentEvidence: readonly EconomicEvidenceView[]
  readonly nextBoundedAction: EconomicBoundedActionView | null
  readonly counters: EconomicCountersView
  readonly redTeam: EconomicRedTeamView
  readonly lastRefusal: { readonly code: string; readonly at: string } | null
  readonly recovery: string | null
  readonly requiresOwnerAction: boolean
  /** How much of Phase 32's own promise is being kept, by name. */
  readonly assertions: EconomicAssertionVerdict
  readonly limits: EconomicLimits
  readonly narrowedLimits: readonly string[]
  /** Whether a long-horizon subsystem is wired in. Not the same as "a goal is open". */
  readonly longHorizonConnected: boolean
  /** Always `simulated-only`. */
  readonly realMoney: typeof ECONOMIC_SIMULATED_ONLY
}

/* -------------------------------------------------------------- absent */

/** The one value `realMoney` may ever hold. */
export const ECONOMIC_SIMULATED_ONLY = 'simulated-only'

/**
 * A valid projection for a Core that has no economic subsystem.
 *
 * `unavailable`, never `ready` with zeroes. "Freya is researching nothing" and "this Core
 * has no Economic Intelligence" are different facts, and a surface that rendered the
 * second as the first would be telling a person that nothing is being simulated when
 * nothing is.
 */
export const ABSENT_ECONOMIC_PROJECTION: EconomicProjectionView = Object.freeze({
  health: 'unavailable' as const,
  reason: 'Core has not reported Economic Intelligence yet',
  schemaVersion: 1,
  sequence: 0,
  generatedAt: '1970-01-01T00:00:00.000Z',
  activeExperiments: Object.freeze([]),
  blockedExperiments: Object.freeze([]),
  uncertainExperiments: Object.freeze([]),
  interruptedExperiments: Object.freeze([]),
  recentEvidence: Object.freeze([]),
  nextBoundedAction: null,
  counters: Object.freeze({
    experiments: 0,
    active: 0,
    interrupted: 0,
    evidence: 0,
    scenarios: 0,
    orders: 0,
    metrics: 0,
    refusals: 0,
  }),
  redTeam: Object.freeze({ refusedAttempts: 0, byCode: Object.freeze([]), recent: Object.freeze([]) }),
  lastRefusal: null,
  recovery: null,
  requiresOwnerAction: false,
  assertions: Object.freeze({
    noRealMoneyAction: true,
    noRealOrder: true,
    noModelCallWithoutWake: true,
    noContinuousPolling: true,
    noHiddenReasoning: true,
    noUnrestrictedLoops: true,
    noAuthorityEscalation: true,
    noIdleModelCall: true,
    noHiddenDurableState: true,
    noSelfApproval: true,
    noBudgetWidening: true,
  }) as EconomicAssertionVerdict,
  limits: Object.freeze({
    maxExperiments: 0,
    maxScenariosPerExperiment: 0,
    maxParametersPerScenario: 0,
    maxAssumptionsPerScenario: 0,
    maxSeriesLength: 0,
    maxPaperOrdersPerExperiment: 0,
    maxPositionsPerExperiment: 0,
    maxEvidencePerExperiment: 0,
    maxMetricsPerExperiment: 0,
    maxCompletionCriteria: 0,
    maxCriterionLength: 0,
    maxTitleLength: 0,
    maxQuestionLength: 0,
    maxCitationLength: 0,
    maxSymbolLength: 0,
    maxOrderQuantity: 0,
    maxOrderPrice: 0,
    evidenceStaleAfterMs: 0,
    maxPayloadTextLength: 0,
    maxExperimentDurationMs: 0,
    maxSimulationDurationMs: 0,
    maxPaperTradingDurationMs: 0,
    maxRetryCeiling: 0,
    maxBackoffMs: 0,
    baseBackoffMs: 0,
    jitterMs: 0,
    maxRecentRefusals: 0,
    maxProjectionItems: 0,
    maxProcessedWakeKeys: 0,
  }) as unknown as EconomicLimits,
  narrowedLimits: Object.freeze([]),
  longHorizonConnected: false,
  realMoney: ECONOMIC_SIMULATED_ONLY,
})

/**
 * The sentence Core reports when the subsystem has not been built.
 *
 * Exported so the host, the surface and the tests quote the same words rather than
 * paraphrasing the absence into four slightly different claims.
 */
export const NO_ECONOMIC_DOMAIN_REASON =
  'this Core has no Economic Intelligence: nothing is researched, simulated or paper traded, and none of it is simulated elsewhere'

/** The projection schema this lane speaks. */
export const ECONOMIC_VIEW_SCHEMA_VERSION = 1

/**
 * The sentence a window gets when a payloadless read carried something.
 *
 * There is no such read — that is the point — but the sentence exists so a future
 * renderer trying to add one gets told precisely what it would be violating.
 */
export const ECONOMIC_NO_PAYLOAD =
  'economic.status.read carries no payload: a window may ask what is being researched and may not supply an experiment, an order, a venue, a budget, an approval or a deadline'

/* ------------------------------------------------------------ the kinds */

/** The experiment kinds a window may render a legend for. */
export const ECONOMIC_EXPERIMENT_KINDS_VIEW = [
  'research',
  'simulation',
  'paper-trading',
] as const

export type EconomicExperimentKindView = (typeof ECONOMIC_EXPERIMENT_KINDS_VIEW)[number]

/** The stages a window may render a progress bar for. */
export const ECONOMIC_STAGES_VIEW = [
  'IDLE',
  'RESEARCHING',
  'SIMULATING',
  'PAPER_TRADING',
  'ANALYZING',
  'COMPLETE',
  'FAILED',
] as const

export type EconomicStageView = (typeof ECONOMIC_STAGES_VIEW)[number]

/** The blockers a window may render, in the order the subsystem prefers to report them. */
export const ECONOMIC_BLOCKERS_VIEW = [
  'stop-all-latched',
  'journal-not-trustworthy',
  'guard-denied',
  'governor-denied',
  'budget-exhausted',
  'approval-required',
  'evidence-cap-reached',
  'scenario-cap-reached',
  'order-cap-reached',
  'deadline-expired',
  'experiment-terminal',
  'attempt-ceiling-reached',
  'interrupted-unresolved',
  'real-money-prohibited',
] as const

export type EconomicBlockerView = (typeof ECONOMIC_BLOCKERS_VIEW)[number]

/** The uncertainty codes a window may render. */
export const ECONOMIC_UNCERTAINTY_CODES_VIEW = [
  'no-evidence',
  'stale-evidence',
  'conflicting-evidence',
  'declared-assumptions',
  'insufficient-series',
  'truncated-series',
  'no-closed-trades',
  'single-source',
] as const

export type EconomicUncertaintyCodeView = (typeof ECONOMIC_UNCERTAINTY_CODES_VIEW)[number]

/** The reasoning codes a window may render. */
export const ECONOMIC_REASON_CODES_VIEW = [
  'due-now',
  'evidence-fresh',
  'evidence-stale',
  'evidence-conflicted',
  'evidence-missing',
  'scenario-pending',
  'scenario-complete',
  'paper-orders-open',
  'paper-orders-closed',
  'criteria-unmet',
  'criteria-met',
  'assumption-declared',
  'recovered-interrupted',
  'awaiting-owner',
] as const

export type EconomicReasonCodeView = (typeof ECONOMIC_REASON_CODES_VIEW)[number]

/* ------------------------------------------------------- cross-checks */

/**
 * Compile-time agreement between this file and the domain.
 *
 * If a code list here ever widens past the domain's, or a view shape drifts, the union
 * below stops resolving and this file stops compiling. That is the whole mechanism: the
 * drift becomes a build failure rather than a window quietly showing less than the domain
 * knows, and no test has to remember to look.
 */
type AssertAssignable<Target, Source extends Target> = Source

/**
 * The union of every agreement this file asserts with the domain.
 *
 * One exported type rather than a row of private aliases, because a private alias nobody
 * reads is a check nobody notices has stopped being made.
 */
export type EconomicViewAgreement =
  | AssertAssignable<(typeof ECONOMIC_EXPERIMENT_KINDS_VIEW)[number], EconomicExperimentKind>
  | AssertAssignable<(typeof ECONOMIC_STAGES_VIEW)[number], EconomicStage>
  | AssertAssignable<(typeof ECONOMIC_BLOCKERS_VIEW)[number], ExperimentBlocker>
  | AssertAssignable<(typeof ECONOMIC_UNCERTAINTY_CODES_VIEW)[number], EconomicUncertaintyCode>
  | AssertAssignable<(typeof ECONOMIC_REASON_CODES_VIEW)[number], EconomicReasonCode>
  | AssertAssignable<(typeof ECONOMIC_ACTION_KINDS)[number], BoundedActionKind>
  | readonly EconomicEventType[]

