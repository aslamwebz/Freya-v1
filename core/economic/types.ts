/**
 * Phase 32 — Economic Intelligence's domain vocabulary.
 *
 * Everything in this file is a closed set. That is not tidiness. An economic
 * subsystem is only trustworthy if the set of things it can research, the set of
 * states an experiment can be in, the set of reasons it can refuse, the set of
 * numbers that bound it and — above all — the set of *things it is allowed to do to
 * money* are all finite and all owned by code. An open vocabulary here would mean an
 * unbounded economic agent by construction, and "no real money" would be a policy
 * rather than a type.
 *
 * The module is deliberately dependency-free. It imports nothing from Core, reads no
 * clock, reaches no provider, contacts no broker and mints no authority. It is types,
 * frozen tables and closed code lists — which is what makes the state machine, the
 * precedence gate, the deadline arithmetic and the three engines testable without a
 * running system, and safe to build before the long-horizon subsystem it will
 * eventually consume.
 */

/* ---------------------------------------------------------- experiments */

/**
 * The closed set of economic experiment states.
 *
 * Note that this is the *experiment's* lifecycle (`draft` → `active` → …), and is
 * deliberately **not** the same vocabulary as the continuation machine's stages in
 * `machine.ts`. An experiment's state answers "is this still a live piece of work";
 * a machine stage answers "which bounded step is in hand right now". Folding the two
 * together would mean an experiment could be both `paused` and `PAPER_TRADING`, which
 * is exactly the pair of facts a reader needs to be told separately.
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

/** States an experiment can never leave without the owner or a terminal outcome. */
export const TERMINAL_EXPERIMENT_STATES: readonly EconomicExperimentState[] = Object.freeze([
  'completed',
  'failed',
  'cancelled',
])

export function isTerminalExperimentState(state: EconomicExperimentState): boolean {
  return TERMINAL_EXPERIMENT_STATES.includes(state)
}

/**
 * The closed set of economic experiment kinds.
 *
 * Three, and the third is the only one that can ever move simulated money. That
 * asymmetry is the point: a research experiment and a simulation experiment have no
 * code path that could place anything at all, and a paper-trading experiment's orders
 * are placed against a portfolio that exists only in this process's fold.
 */
export const ECONOMIC_EXPERIMENT_KINDS = ['research', 'simulation', 'paper-trading'] as const

export type EconomicExperimentKind = (typeof ECONOMIC_EXPERIMENT_KINDS)[number]

/**
 * The order kinds are ranked in when the economic state has to break a tie.
 *
 * Fixed and code-owned rather than derived from priority numbers supplied by a
 * caller, because "which experiment is looked at next" is a decision this system
 * makes and nobody else. An experiment that claimed a higher priority is refused
 * rather than obeyed; see `docs/phase32/red-team-cases.md` §2.4.
 */
export const EXPERIMENT_KIND_RANK: Readonly<Record<EconomicExperimentKind, number>> = Object.freeze({
  research: 0,
  simulation: 1,
  'paper-trading': 2,
})

/** An economic experiment, as the domain holds it. */
export interface EconomicExperiment {
  readonly experimentId: string
  readonly kind: EconomicExperimentKind
  readonly state: EconomicExperimentState
  /** Bounded, human-readable. Never a paragraph, never a provider's prose. */
  readonly title: string
  /** The bounded question or claim under test. Bounded text, never an instruction. */
  readonly question: string
  /** Explicit, closed-form completion criteria. Never empty. */
  readonly completionCriteria: readonly string[]
  /** 0–1, derived from satisfied criteria. Never supplied by a caller. */
  readonly progress: number
  /** Absolute. A restart cannot move it. */
  readonly deadlineAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly completedAt: string | null
}

export function isEconomicExperimentKind(value: unknown): value is EconomicExperimentKind {
  return typeof value === 'string' && (ECONOMIC_EXPERIMENT_KINDS as readonly string[]).includes(value)
}

export function isEconomicExperimentState(value: unknown): value is EconomicExperimentState {
  return typeof value === 'string' && (ECONOMIC_EXPERIMENT_STATES as readonly string[]).includes(value)
}

/* ------------------------------------------------------------- evidence */

/** The closed set of authorized evidence source kinds. Never free text. */
export const EVIDENCE_SOURCE_KINDS = ['licensed-feed', 'published-filing', 'published-study', 'owner-supplied'] as const

export type EvidenceSourceKind = (typeof EVIDENCE_SOURCE_KINDS)[number]

export function isEvidenceSourceKind(value: unknown): value is EvidenceSourceKind {
  return typeof value === 'string' && (EVIDENCE_SOURCE_KINDS as readonly string[]).includes(value)
}

/**
 * Evidence freshness and agreement.
 *
 * `conflicted` is a state rather than an error: two authorized sources disagreeing is
 * a *fact about the world*, and the honest response is to keep both readings, mark
 * the experiment uncertain and use the more conservative of the two. Collapsing a
 * conflict into a single number would be the one thing this subsystem must never do.
 */
export const EVIDENCE_STATES = ['fresh', 'stale', 'conflicted', 'missing'] as const

export type EvidenceState = (typeof EVIDENCE_STATES)[number]

/**
 * Confidence levels, and the rule that makes them honest.
 *
 * `unknown` is a first-class value and is the *default*: an experiment with no
 * evidence is `unknown`, never `low`. `low` means a single unreliable source said so,
 * which is a different and stronger claim. A fold that reached for `low` when it meant
 * "nothing" would be fabricating confidence, and the whole projection is worthless if
 * it can do that.
 */
export const CONFIDENCE_LEVELS = ['high', 'medium', 'low', 'unknown'] as const

export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number]

/** The confidence rank, used only for ordering and never to synthesise a value. */
export const CONFIDENCE_RANK: Readonly<Record<ConfidenceLevel, number>> = Object.freeze({
  high: 0,
  medium: 1,
  low: 2,
  unknown: 3,
})

/** A piece of research evidence. Provenance-carrying, bounded, cited. */
export interface ResearchEvidence {
  readonly evidenceId: string
  readonly experimentId: string
  /** A closed source kind, never a free-text provider name. */
  readonly source: EvidenceSourceKind
  /** A stable identity for the source instance, so two readings can be compared. */
  readonly sourceRef: string
  /** Bounded, human-readable. Never a URL that could carry a session token. */
  readonly citation: string
  readonly observedAt: string
  readonly state: EvidenceState
  readonly confidence: ConfidenceLevel
  /** What the evidence is about, so a conflict can be detected deterministically. */
  readonly claim: string
}

export function isEvidenceState(value: unknown): value is EvidenceState {
  return typeof value === 'string' && (EVIDENCE_STATES as readonly string[]).includes(value)
}

export function isConfidenceLevel(value: unknown): value is ConfidenceLevel {
  return typeof value === 'string' && (CONFIDENCE_LEVELS as readonly string[]).includes(value)
}

/* ----------------------------------------------------------- simulation */

/**
 * The closed set of simulation strategies.
 *
 * Three, all deterministic, all implemented in this repository. There is no
 * "call a model to pick a strategy" and no "fetch a strategy from somewhere" — a
 * backtest whose rule set could change between two runs of the same inputs would not
 * be a backtest, and the whole value of a simulation here is that the same series
 * always produces the same numbers.
 */
export const SIMULATION_STRATEGIES = ['cash', 'buy-and-hold', 'sma-crossover'] as const

export type SimulationStrategy = (typeof SIMULATION_STRATEGIES)[number]

export function isSimulationStrategy(value: unknown): value is SimulationStrategy {
  return typeof value === 'string' && (SIMULATION_STRATEGIES as readonly string[]).includes(value)
}

/** A simulation scenario. Explicit parameters, explicit assumptions. */
export interface SimulationScenario {
  readonly scenarioId: string
  readonly experimentId: string
  readonly name: string
  readonly strategy: SimulationStrategy
  /** Bounded key/value pairs. Finite, non-negative, no nesting. */
  readonly parameters: Readonly<Record<string, number>>
  /** Explicit statements for every gap the parameters do not close. */
  readonly assumptions: readonly string[]
  readonly status: 'pending' | 'running' | 'completed' | 'failed'
  readonly result: SimulationResult | null
}

/** One point of a price series. Supplied by the caller; never fetched. */
export interface PricePoint {
  readonly at: string
  readonly close: number
}

/** The outcome of one completed scenario. Every metric carries its own unit. */
export interface SimulationResult {
  readonly resultId: string
  readonly scenarioId: string
  readonly experimentId: string
  readonly strategy: SimulationStrategy
  readonly metrics: readonly SimulationMetric[]
  readonly observations: number
  readonly startedAt: string
  readonly completedAt: string
}

/** A named numeric outcome of a simulation. Bounded, unit-bearing, never a bare float. */
export interface SimulationMetric {
  readonly name: string
  readonly value: number
  readonly unit: string
  /** What the value is out of. Always present, even when it is `1`. */
  readonly denominator: number
}

/* --------------------------------------------------------- paper trading */

/**
 * The closed set of order sides.
 *
 * Two, and both are *simulated*. There is no third field anywhere in this file that
 * could name a venue, a broker, an account or a currency pair to be traded for real:
 * the absence is the guarantee, and `prohibition.ts` checks untrusted input for the
 * shapes that would otherwise have carried one.
 */
export const PAPER_ORDER_SIDES = ['buy', 'sell'] as const

export type PaperOrderSide = (typeof PAPER_ORDER_SIDES)[number]

export const PAPER_ORDER_STATUSES = ['filled', 'pending', 'cancelled'] as const

export type PaperOrderStatus = (typeof PAPER_ORDER_STATUSES)[number]

/** A simulated order. This is not an order; there is nowhere for it to go. */
export interface PaperOrder {
  readonly orderId: string
  readonly experimentId: string
  readonly symbol: string
  readonly side: PaperOrderSide
  readonly quantity: number
  readonly price: number
  readonly placedAt: string
  readonly status: PaperOrderStatus
  /** Why this order was placed, as closed codes. Never prose. */
  readonly reasoning: readonly string[]
}

export function isPaperOrderSide(value: unknown): value is PaperOrderSide {
  return typeof value === 'string' && (PAPER_ORDER_SIDES as readonly string[]).includes(value)
}

export function isPaperOrderStatus(value: unknown): value is PaperOrderStatus {
  return typeof value === 'string' && (PAPER_ORDER_STATUSES as readonly string[]).includes(value)
}

/** One position in the simulated portfolio. */
export interface PaperPosition {
  readonly positionId: string
  readonly experimentId: string
  readonly symbol: string
  /** Signed. Negative means a short position in the simulation. */
  readonly quantity: number
  readonly averagePrice: number
  readonly currentPrice: number
  readonly unrealizedPnl: number
}

/** A performance metric with an explicit denominator. Never reported without one. */
export interface EconomicMetric {
  readonly metricId: string
  readonly experimentId: string
  readonly name: string
  readonly value: number
  readonly denominator: number
  readonly unit: string
  readonly computedAt: string
}

/* ------------------------------------------------------- explainability */

/** Why an experiment cannot proceed. Closed, and every value is a hard fact. */
export const EXPERIMENT_BLOCKERS = [
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

export type ExperimentBlocker = (typeof EXPERIMENT_BLOCKERS)[number]

export function isExperimentBlocker(value: unknown): value is ExperimentBlocker {
  return typeof value === 'string' && (EXPERIMENT_BLOCKERS as readonly string[]).includes(value)
}

/** The closed kinds of bounded next action. */
export const BOUNDED_ACTION_KINDS = ['execute', 'delegate', 'verify', 'wait', 'escalate', 'stop'] as const

export type BoundedActionKind = (typeof BOUNDED_ACTION_KINDS)[number]

export function isBoundedActionKind(value: unknown): value is BoundedActionKind {
  return typeof value === 'string' && (BOUNDED_ACTION_KINDS as readonly string[]).includes(value)
}

/** One experiment as the owner sees it. Everything here is explainable. */
export interface ExperimentSummary {
  readonly experimentId: string
  readonly kind: EconomicExperimentKind
  readonly state: EconomicExperimentState
  /** Which bounded stage the experiment is in. Distinct from its lifecycle state. */
  readonly stage: EconomicStage
  readonly title: string
  readonly progress: number
  readonly confidence: ConfidenceLevel
  /** Closed codes only. Never a sentence a provider wrote. */
  readonly reasoning: readonly EconomicReasonCode[]
  readonly blockedReason: ExperimentBlocker | null
  /** What is uncertain about this item, as closed codes. */
  readonly uncertainty: readonly EconomicUncertaintyCode[]
  /** How many completion criteria have evidence behind them, and how many there are. */
  readonly criteriaMet: number
  readonly criteriaTotal: number
  readonly updatedAt: string
}

/** The single next action the economic subsystem recommends. */
export interface BoundedAction {
  readonly actionId: string
  readonly kind: BoundedActionKind
  /** An id. Never a title, an intent or a piece of content. */
  readonly target: string
  /** Absolute. A window cannot extend it, shorten it or supply one. */
  readonly deadlineAt: string
  readonly maxAttempts: number
  readonly reasoning: readonly string[]
}

/** The closed codes that may appear in `ExperimentSummary.reasoning`. */
export const ECONOMIC_REASON_CODES = [
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

export type EconomicReasonCode = (typeof ECONOMIC_REASON_CODES)[number]

/** The closed codes that may appear in `ExperimentSummary.uncertainty`. */
export const ECONOMIC_UNCERTAINTY_CODES = [
  'no-evidence',
  'stale-evidence',
  'conflicting-evidence',
  'declared-assumptions',
  'insufficient-series',
  'truncated-series',
  'no-closed-trades',
  'single-source',
] as const

export type EconomicUncertaintyCode = (typeof ECONOMIC_UNCERTAINTY_CODES)[number]

/* ----------------------------------------------------------------- wake */

/**
 * The closed set of things that may wake the economic subsystem.
 *
 * Five kinds, and the notable absence is `periodic-poll`. A scheduled check may wake
 * this subsystem, but only about a *named experiment with a deadline*, never to go
 * looking for something new — which is why `experiment-due` carries an `experimentId`
 * and cannot be raised without one.
 *
 * Sources and kinds are paired, exactly as in Phase 23, so that a heartbeat cannot be
 * relabelled as owner interaction to buy a louder wake than the event deserves.
 */
export const ECONOMIC_WAKE_SOURCES = [
  'owner-interaction',
  'authorized-event',
  'scheduled-heartbeat',
  'experiment-transition',
  'long-horizon-goal',
] as const

export type EconomicWakeSource = (typeof ECONOMIC_WAKE_SOURCES)[number]

export const ECONOMIC_WAKE_KINDS = [
  'owner-command',
  'owner-approval',
  'owner-dismissal',
  'deadline-reached',
  'evidence-arrived',
  'experiment-transitioned',
  'long-horizon-continuation',
] as const

export type EconomicWakeKind = (typeof ECONOMIC_WAKE_KINDS)[number]

/** Which source each kind may arrive on. A mismatch is refused. */
export const ECONOMIC_WAKE_KIND_SOURCE: Readonly<Record<EconomicWakeKind, EconomicWakeSource>> =
  Object.freeze({
    'owner-command': 'owner-interaction',
    'owner-approval': 'owner-interaction',
    'owner-dismissal': 'owner-interaction',
    'deadline-reached': 'scheduled-heartbeat',
    'evidence-arrived': 'authorized-event',
    'experiment-transitioned': 'experiment-transition',
    'long-horizon-continuation': 'long-horizon-goal',
  })

/**
 * Who is claiming to have produced a wake.
 *
 * The table below is the authority: `model`, `renderer`, `agent`, `connector`,
 * `external-webhook` and `timer` appear nowhere on its right-hand side, so
 * "no renderer may drive the economic subsystem" is a table rather than anybody's
 * vigilance. `long-horizon-subsystem` is there for exactly one wake — Phase 31's
 * continuation — and it is wired through a single seam in `seams.ts`, so a Phase 31
 * branch cannot reach this subsystem by any other route.
 */
export const ECONOMIC_WAKE_ACTORS = [
  'owner',
  'core-subsystem',
  'host-heartbeat',
  'long-horizon-subsystem',
  'model',
  'renderer',
  'agent',
  'connector',
  'external-webhook',
  'timer',
] as const

export type EconomicWakeActor = (typeof ECONOMIC_WAKE_ACTORS)[number]

/** The only actor permitted to raise each source. */
export const ECONOMIC_WAKE_SOURCE_ACTOR: Readonly<Record<EconomicWakeSource, EconomicWakeActor>> =
  Object.freeze({
    'owner-interaction': 'owner',
    'authorized-event': 'core-subsystem',
    'scheduled-heartbeat': 'host-heartbeat',
    'experiment-transition': 'core-subsystem',
    'long-horizon-goal': 'long-horizon-subsystem',
  })

/** Wake priority, lowest number first. An owner's word is answered before a deadline. */
export const ECONOMIC_WAKE_SOURCE_PRIORITY: Readonly<Record<EconomicWakeSource, number>> = Object.freeze({
  'owner-interaction': 0,
  'experiment-transition': 1,
  'authorized-event': 2,
  'long-horizon-goal': 3,
  'scheduled-heartbeat': 4,
})

/** A wake. Metadata only: an id, a closed kind, a reference and two instants. */
export interface EconomicWake {
  readonly wakeId: string
  readonly source: EconomicWakeSource
  readonly kind: EconomicWakeKind
  readonly experimentId: string | null
  readonly goalRef: string | null
  readonly sourceRef: string | null
  readonly occurredAt: string
  readonly observedAt: string
}

/** The closed reasons a wake was refused. */
export const ECONOMIC_WAKE_REFUSAL_CODES = [
  'unknown-source',
  'unknown-kind',
  'kind-source-mismatch',
  'unauthorized-actor',
  'missing-wake-id',
  'unknown-experiment',
  'experiment-terminal',
  'malformed-timestamp',
  'observed-before-occurred',
  'stop-all-active',
  'journal-not-trustworthy',
  'duplicate-wake',
  'runtime-busy',
  'runtime-closed',
  'polling-prohibited',
  'real-money-prohibited',
] as const

export type EconomicWakeRefusalCode = (typeof ECONOMIC_WAKE_REFUSAL_CODES)[number]

/** The wake refusal vocabulary as a set, so a validator can ask one question of it. */
export const ECONOMIC_WAKE_REFUSAL_CODE_SET: ReadonlySet<string> = new Set<string>(
  ECONOMIC_WAKE_REFUSAL_CODES,
)

export function isEconomicWakeRefusalCode(value: unknown): value is EconomicWakeRefusalCode {
  return typeof value === 'string' && ECONOMIC_WAKE_REFUSAL_CODE_SET.has(value)
}

/**
 * Every code a refusal may carry.
 *
 * The wake registry's codes are included rather than translated into subsystem codes:
 * mapping "that is not a source a wake may arrive on" onto a single "wake-not-authorized" would
 * throw away the only thing a reader has to go on when they want to know *why* a wake
 * was turned away.
 */
export type EconomicAnyRefusalCode = EconomicRefusalCode | EconomicWakeRefusalCode

export type EconomicWakeOutcome = 'accepted' | 'deferred' | 'denied'

export type EconomicWakeValidationOutcome =
  | { readonly outcome: 'accepted'; readonly wake: EconomicWake; readonly wakeKey: string }
  | {
      readonly outcome: 'deferred'
      readonly wake: EconomicWake
      readonly wakeKey: string
      readonly code: 'deadline-not-reached'
      readonly reason: string
      readonly deadline: string
    }
  | { readonly outcome: 'denied'; readonly code: EconomicWakeRefusalCode; readonly reason: string }

export function isEconomicWakeSource(value: unknown): value is EconomicWakeSource {
  return typeof value === 'string' && (ECONOMIC_WAKE_SOURCES as readonly string[]).includes(value)
}

export function isEconomicWakeKind(value: unknown): value is EconomicWakeKind {
  return typeof value === 'string' && (ECONOMIC_WAKE_KINDS as readonly string[]).includes(value)
}

export function isEconomicWakeActor(value: unknown): value is EconomicWakeActor {
  return typeof value === 'string' && (ECONOMIC_WAKE_ACTORS as readonly string[]).includes(value)
}

/* -------------------------------------------------------- state machine */

/**
 * The bounded stages an experiment moves through.
 *
 * Seven, closed. The names are about *what is happening*, not about what Freya wants:
 * `PAPER_TRADING` means a simulated order is being recorded against a simulated
 * portfolio, and there is no state in this table that could mean a real one.
 */
export const ECONOMIC_STAGES = [
  'IDLE',
  'RESEARCHING',
  'SIMULATING',
  'PAPER_TRADING',
  'ANALYZING',
  'COMPLETE',
  'FAILED',
] as const

export type EconomicStage = (typeof ECONOMIC_STAGES)[number]

export const TERMINAL_STAGES: readonly EconomicStage[] = Object.freeze(['COMPLETE', 'FAILED'])

export function isTerminalStage(stage: EconomicStage): boolean {
  return TERMINAL_STAGES.includes(stage)
}

/**
 * The stage each kind of experiment *opens* in.
 *
 * Keyed by kind rather than assumed, because a simulation experiment that has not
 * gathered any evidence is already simulating — pretending otherwise would put a
 * research stage in front of every experiment and make the table describe a pipeline
 * rather than this system's actual work.
 */
export const OPENED_STAGE: Readonly<Record<EconomicExperimentKind, EconomicStage>> = Object.freeze({
  research: 'RESEARCHING',
  simulation: 'SIMULATING',
  'paper-trading': 'PAPER_TRADING',
})

/**
 * The signals the ordinary table moves on. Closed, and one event per move.
 *
 * Note the two `*-sufficient` signals: they are how a kind *skips* a stage it has no
 * work for. A research experiment has no simulation to run, so it goes from
 * `RESEARCHING` to `ANALYZING` on `research-sufficient` rather than being forced
 * through a `SIMULATING` stage it would pass through empty. A table that cannot
 * express a skip is a table that forces fake work.
 */
export const ECONOMIC_SIGNALS = [
  'experiment-opened',
  'research-complete',
  'research-sufficient',
  'simulation-complete',
  'simulation-sufficient',
  'paper-complete',
  'analysis-complete',
  'experiment-failed',
  'experiment-closed',
] as const

export type EconomicSignal = (typeof ECONOMIC_SIGNALS)[number]

/**
 * Why an ordinary transition was refused.
 *
 * `missing-experiment-kind` is separate because opening an experiment genuinely needs
 * to know which kind it is — the stage it opens in is derived from the kind — and
 * "you did not tell me what kind this is" is a different diagnosis from "that move is
 * not in the table". A reader debugging a stuck experiment needs to tell them apart.
 */
export type EconomicTransitionRefusalCode =
  | 'illegal-transition'
  | 'already-terminal'
  | 'self-transition'
  | 'unknown-stage'
  | 'missing-experiment-kind'

export type EconomicTransitionOutcome =
  | {
      readonly ok: true
      readonly from: EconomicStage
      readonly to: EconomicStage
      readonly signal: EconomicSignal
      readonly event: EconomicEventType | null
      readonly reason: string
    }
  | {
      readonly ok: false
      readonly from: EconomicStage
      readonly signal: EconomicSignal
      readonly code: EconomicTransitionRefusalCode
      readonly reason: string
    }

/* -------------------------------------------------------------- refusal */

/**
 * The closed reasons a request was refused.
 *
 * Every one of these is a refusal *of something that was asked for*, and each is
 * journaled. A subsystem that quietly ignored a request it did not like is a
 * subsystem whose owner cannot tell the difference between "Freya decided not to" and
 * "Freya was told not to", which are very different facts about a human being.
 */
export const ECONOMIC_REFUSAL_CODES = [
  'journal-not-trustworthy',
  'stop-all-active',
  'economic-disabled',
  'guard-denied',
  'governor-denied',
  'budget-exhausted',
  'approval-required',
  'attempt-ceiling-reached',
  'unknown-experiment',
  'experiment-terminal',
  'experiment-kind-mismatch',
  'experiment-cap-reached',
  'order-cap-reached',
  'position-cap-reached',
  'missing-title',
  'missing-question',
  'invalid-created-at',
  'deadline-before-start',
  'deadline-over-long',
  'unauthorized-evidence-source',
  'missing-citation',
  'invalid-citation',
  'citation-over-long',
  'missing-source-ref',
  'missing-claim',
  'invalid-observed-at',
  'title-over-long',
  'question-over-long',
  'criteria-empty',
  'criteria-over-long',
  'criterion-over-long',
  'criterion-malformed',
  'criterion-duplicate',
  'duplicate-evidence',
  'invalid-symbol',
  'invalid-quantity',
  'invalid-price',
  'invalid-side',
  'invalid-strategy',
  'invalid-parameters',
  'invalid-series',
  'insufficient-series',
  'real-money-prohibited',
  'real-order-prohibited',
  'spending-authority-prohibited',
  'capability-widening-prohibited',
  'grant-creation-prohibited',
  'self-approval-prohibited',
  'priority-escalation-prohibited',
  'budget-widening-prohibited',
  'authority-claim-prohibited',
  'polling-prohibited',
  'inference-without-wake-prohibited',
  'state-fabrication-prohibited',
  'silent-resume-prohibited',
  'wake-not-authorized',
] as const

export type EconomicRefusalCode = (typeof ECONOMIC_REFUSAL_CODES)[number]

export function isEconomicRefusalCode(value: unknown): value is EconomicAnyRefusalCode {
  return typeof value === 'string' && ECONOMIC_ANY_REFUSAL_CODE_SET.has(value)
}

/** Every refusal code, wake codes included. One set, so a check cannot miss half of them. */
export const ECONOMIC_ANY_REFUSAL_CODE_SET: ReadonlySet<string> = new Set<string>([
  ...ECONOMIC_REFUSAL_CODES,
  ...ECONOMIC_WAKE_REFUSAL_CODES,
])

/**
 * The refusals that are *authority* refusals, as opposed to validation refusals.
 *
 * Separated because they are read differently by an owner. "The symbol was too long"
 * is Freya being careful about its own input; "Freya was not permitted to do that" is
 * the Guard or the Governor having said no, and the person reading the journal needs
 * to be able to tell those apart at a glance.
 */
export const AUTHORITY_REFUSAL_CODES: ReadonlySet<string> = new Set<string>([
  'journal-not-trustworthy',
  'stop-all-active',
  'economic-disabled',
  'guard-denied',
  'governor-denied',
  'budget-exhausted',
  'approval-required',
  'real-money-prohibited',
  'real-order-prohibited',
  'spending-authority-prohibited',
  'capability-widening-prohibited',
  'grant-creation-prohibited',
  'self-approval-prohibited',
  'priority-escalation-prohibited',
  'budget-widening-prohibited',
  'authority-claim-prohibited',
  'polling-prohibited',
  'inference-without-wake-prohibited',
  'state-fabrication-prohibited',
  'silent-resume-prohibited',
  'wake-not-authorized',
])

/** One recorded refusal. Closed code, closed target kind, two instants. */
export interface EconomicRefusal {
  readonly refusalId: string
  /** Either a subsystem refusal or a wake refusal; both are refusals, both are closed. */
  readonly code: EconomicAnyRefusalCode
  /** What was refused, as a closed kind. Never the refused value itself. */
  readonly subject: EconomicRefusalSubject
  readonly experimentId: string | null
  readonly wakeId: string | null
  readonly at: string
}

export const ECONOMIC_REFUSAL_SUBJECTS = [
  'wake',
  'experiment',
  'evidence',
  'scenario',
  'series',
  'order',
  'metric',
  'claim',
  'boundary',
  'recovery',
] as const

export type EconomicRefusalSubject = (typeof ECONOMIC_REFUSAL_SUBJECTS)[number]

export function isEconomicRefusalSubject(value: unknown): value is EconomicRefusalSubject {
  return typeof value === 'string' && (ECONOMIC_REFUSAL_SUBJECTS as readonly string[]).includes(value)
}

/* --------------------------------------------------------------- limits */

/**
 * The code-owned ceilings. Frozen, and the source of every bound in Phase 32.
 *
 * These are not defaults. There is no code path that raises them: the only way to
 * configure the economic subsystem is `narrowEconomicLimits`, which clamps every value
 * *down* to the numbers below and refuses to represent anything wider.
 */
export const ECONOMIC_LIMITS = Object.freeze({
  /** Experiments tracked at once. */
  maxExperiments: 16,
  /** Scenarios per experiment. */
  maxScenariosPerExperiment: 32,
  /** Parameters per scenario. */
  maxParametersPerScenario: 64,
  /** Assumptions per scenario. */
  maxAssumptionsPerScenario: 32,
  /** Observations in one price series. */
  maxSeriesLength: 1024,
  /** Simulated orders per experiment. */
  maxPaperOrdersPerExperiment: 256,
  /** Open positions per experiment. */
  maxPositionsPerExperiment: 64,
  /** Evidence per experiment. */
  maxEvidencePerExperiment: 128,
  /**
   * How old an observation may be before it stops being evidence.
   *
   * A fortnight, and it is a *threshold* rather than a schedule: no timer refreshes
   * anything, an observation simply becomes stale when enough time has passed and the
   * fold says so. That is why it is measured against `now` at read time rather than
   * being written down when the evidence arrives.
   */
  evidenceStaleAfterMs: 14 * 24 * 60 * 60 * 1_000,
  /** Metrics reported per experiment. */
  maxMetricsPerExperiment: 64,
  /** Completion criteria per experiment. */
  maxCompletionCriteria: 8,
  /**
   * One completion criterion, in characters.
   *
   * Criteria are **slugs**, not sentences — `peer-reviewed-demand`, `unit-economics` —
   * and that is not a style choice. A criterion is a *claim key*: it is matched against
   * the claim an observation is about, so it has to be a key. Making it a key also means
   * the whole list fits in one bounded journal field, which is what lets an experiment's
   * criteria survive a restart without the journal ever being able to hold a sentence.
   */
  maxCriterionLength: 32,
  /** Title and question text, in characters. */
  maxTitleLength: 120,
  maxQuestionLength: 200,
  /** A citation, in characters. Long enough for a filing reference, no longer. */
  maxCitationLength: 160,
  /** A symbol, in characters. Matches the specification's table. */
  maxSymbolLength: 16,
  /** Quantity on one simulated order. */
  maxOrderQuantity: 1_000_000,
  /** Price on one simulated order. */
  maxOrderPrice: 1_000_000,
  /**
   * The longest any economic journal payload string may be.
   *
   * Wider than every other phase's ceiling, and for exactly one field: the joined list of
   * completion criteria. Eight slugs of 32 characters plus seven separators is 277, so
   * 300 is the smallest round number that fits it — and it is still a list of keys. Every
   * other string in an economic event is far below it, and the oversized check applies to
   * all of them equally.
   */
  maxPayloadTextLength: 300,
  /** Thirty days. The longest an experiment may run. */
  maxExperimentDurationMs: 30 * 24 * 60 * 60 * 1_000,
  /** One day. The longest one simulation may run. */
  maxSimulationDurationMs: 24 * 60 * 60 * 1_000,
  /** Thirty days. The longest paper trading may run. */
  maxPaperTradingDurationMs: 30 * 24 * 60 * 60 * 1_000,
  /** Attempts for one unit of work. */
  maxRetryCeiling: 3,
  /** Backoff ceiling. */
  maxBackoffMs: 5 * 60_000,
  /** Backoff base. */
  baseBackoffMs: 1_000,
  /** Jitter window, added to the exponential term and then clamped. */
  jitterMs: 1_000,
  /** Refusals retained in the projection's summary. */
  maxRecentRefusals: 32,
  /** Entries retained per experiment in the owner-visible projection. */
  maxProjectionItems: 16,
  /** Processed wake keys retained for deduplication. */
  maxProcessedWakeKeys: 256,
})

export type EconomicLimits = typeof ECONOMIC_LIMITS

/**
 * The same keys, with plain 
umber values.
 *
 * ECONOMIC_LIMITS is a frozen literal, so its value type carries the ceiling as a
 * compile-time constant — which is exactly what a *configuration* object must not be, since a
 * caller narrowing a limit cannot possibly be holding that literal. Every pure function that
 * reads the ceilings takes this, so none of them is accidentally restricted to the defaults.
 */
export type EconomicLimitsLike = { readonly [K in keyof EconomicLimits]: number }

/**
 * A request to narrow the ceilings.
 *
 * Deliberately untyped as to value, exactly as in Phase 23. A request is untrusted
 * input: it may be wider than the ceiling it names, non-numeric, negative, or absent,
 * and `narrowEconomicLimits` has to survive all of it without the caller being able to
 * widen anything. Typing the values as the frozen literals would mean the type system
 * rejected the hostile requests before the clamp ever saw them, which is exactly the
 * case worth testing.
 */
export type EconomicLimitRequest = { readonly [K in keyof EconomicLimits]?: unknown }

/* --------------------------------------------------------------- events */

/**
 * The event types this subsystem appends.
 *
 * Nineteen, all prefixed `economic.`, all metadata. None of them carries a provider
 * identity, a prompt, a price series, a research answer or the text of the event that
 * woke the subsystem — the journal is the least protected file in the system, and an
 * economic entry that could carry a paragraph would quietly turn it into a transcript
 * of what Freya was thinking about money.
 */
export const ECONOMIC_EVENT_TYPES = [
  'economic.experiment.created',
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
  'economic.gate.decided',
  'economic.refusal.recorded',
  'economic.wake.received',
  'economic.wake.denied',
  'economic.reconciled',
  'economic.stopped',
  'economic.unstopped',
] as const

export type EconomicEventType = (typeof ECONOMIC_EVENT_TYPES)[number]

export const ECONOMIC_EVENT_TYPE_SET: ReadonlySet<string> = new Set<string>(ECONOMIC_EVENT_TYPES)

/**
 * Narrowing predicate for an event type.
 *
 * `ECONOMIC_EVENT_TYPE_SET.has(type)` returns a `boolean` and does **not** narrow, which
 * is a trap worth closing explicitly: without this, a caller that has just checked the
 * set still has to cast to reach a typed API, and the cast is exactly where an
 * unvalidated string from a journal quietly becomes an event type.
 */
export function isEconomicEventType(value: unknown): value is EconomicEventType {
  return typeof value === 'string' && ECONOMIC_EVENT_TYPE_SET.has(value)
}

/** The one stop code only the owner may lift. */
export const LATCHED_ECONOMIC_STOP_CODE = 'stop-all-latched'

/** Stop codes a close-out may clear. Everything else is the owner's. */
export const CLEARABLE_ECONOMIC_STOP_CODES = ['experiment-closed', 'interrupted-reconciled'] as const

export type ClearableEconomicStopCode = (typeof CLEARABLE_ECONOMIC_STOP_CODES)[number]

export function isClearableEconomicStopCode(value: unknown): value is ClearableEconomicStopCode {
  return typeof value === 'string' && (CLEARABLE_ECONOMIC_STOP_CODES as readonly string[]).includes(value)
}

/**
 * Why the subsystem's position was reconciled to what the journal actually proves.
 *
 * Three producers, closed, for the same reason Phase 23's list is closed: so a reader
 * can tell a restart from the owner taking precedence from the owner's own act of
 * clearing a stop.
 */
export const ECONOMIC_RECONCILIATION_CODES = [
  /** A previous process ended mid-stage and the journal was re-read. */
  'restart-recovery',
  /** The owner spoke, and the owner comes first. */
  'owner-preempted',
  /** The owner explicitly cleared STOP ALL. The only lift that exists. */
  'stop-latch-cleared',
] as const

export type EconomicReconciliationCode = (typeof ECONOMIC_RECONCILIATION_CODES)[number]

export function isEconomicReconciliationCode(value: unknown): value is EconomicReconciliationCode {
  return typeof value === 'string' && (ECONOMIC_RECONCILIATION_CODES as readonly string[]).includes(value)
}

/**
 * The closed payload vocabulary, per event type.
 *
 * Two jobs. It makes "the economic journal holds metadata and not content" checkable
 * by reading one table, and it makes the fold's unknown-key handling an audit signal
 * rather than a shrug. A payload key that is not on this list is an anomaly, not a new
 * field.
 */
/** The separator completion criteria are joined with in the journal. */
export const CRITERION_SEPARATOR = ' | '

/**
 * The grammar a completion criterion must satisfy.
 *
 * A lowercase slug. This is the form that makes a criterion a *key* rather than a
 * sentence, which is what lets progress be derived from evidence instead of reported, and
 * what lets the whole list fit in one bounded journal field.
 */
export const CRITERION_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/

export function isCriterion(value: unknown): value is string {
  return typeof value === 'string' && CRITERION_PATTERN.test(value)
}

export const ECONOMIC_PAYLOAD_KEYS: Readonly<Record<EconomicEventType, readonly string[]>> =
  Object.freeze({
    'economic.experiment.created': [
      'experimentId',
      'kind',
      'state',
      'title',
      'question',
      'criteria',
      'criteriaCount',
      'progress',
      'deadlineAt',
      'createdAt',
      'updatedAt',
    ],
    'economic.experiment.state-changed': ['experimentId', 'from', 'to', 'signal', 'progress', 'reasoning', 'updatedAt'],
    'economic.experiment.completed': ['experimentId', 'from', 'progress', 'criteriaMet', 'completedAt'],
    'economic.experiment.failed': ['experimentId', 'from', 'code', 'updatedAt'],
    'economic.experiment.cancelled': ['experimentId', 'from', 'reason', 'updatedAt'],
    'economic.evidence.gathered': ['evidenceId', 'experimentId', 'source', 'sourceRef', 'citation', 'claim', 'observedAt', 'state', 'confidence'],
    'economic.simulation.started': ['scenarioId', 'experimentId', 'strategy', 'parameterCount', 'assumptionCount', 'observationCount', 'startedAt'],
    'economic.simulation.completed': ['scenarioId', 'experimentId', 'resultId', 'strategy', 'metricCount', 'observationCount', 'completedAt', 'failed'],
    'economic.paper-order.placed': ['orderId', 'experimentId', 'symbol', 'side', 'quantity', 'price', 'placedAt', 'reasoning'],
    'economic.paper-order.filled': ['orderId', 'experimentId', 'positionId', 'symbol', 'side', 'quantity', 'price', 'realizedPnl'],
    'economic.metric.computed': ['metricId', 'experimentId', 'name', 'value', 'denominator', 'unit', 'computedAt'],
    'economic.continuation.decided': [
      'experimentId',
      'wakeId',
      'decision',
      'stage',
      'reasoning',
      'blocker',
      'evidenceCount',
      'scenarioCount',
      'orderCount',
      'attempt',
    ],
    'economic.gate.decided': ['wakeId', 'experimentId', 'outcome', 'code', 'checked', 'remainingUnits', 'at'],
    'economic.refusal.recorded': ['refusalId', 'code', 'subject', 'experimentId', 'wakeId', 'at'],
    'economic.wake.received': ['wakeId', 'source', 'kind', 'wakeKey', 'experimentId', 'goalRef', 'sourceRef', 'occurredAt', 'observedAt'],
    'economic.wake.denied': ['wakeId', 'source', 'kind', 'code', 'experimentId'],
    // `from` is the stage the journal had recorded and `code` is from
    // `ECONOMIC_RECONCILIATION_CODES`, so a reader can tell a restart from the owner
    // taking precedence.
    'economic.reconciled': ['code', 'from', 'experimentId', 'atStage'],
    // One key, deliberately. A lift of STOP ALL is the owner's act and nothing in this
    // module may write this event; see the fold.
    'economic.unstopped': ['code'],
    'economic.stopped': ['experimentId', 'stage', 'code'],
  })

/**
 * Keys that must never appear in an economic payload.
 *
 * Authority is minted by the Guard and the Governor, and by Core — never by an event.
 * A payload carrying one of these is not a new field, it is an escalation attempt, and
 * it is refused before it can reach the journal.
 *
 * The second half of the set is the real-money half, and it is the important one. There
 * is no field anywhere in Phase 32 that could name a venue, a broker, an account, a
 * wallet or a currency to be traded for real, so these keys are refused *and* the fold
 * reports them under `noRealMoneyAction` rather than under `noAuthorityEscalation`.
 * Naming them is not an oversight in the vocabulary — it is the vocabulary.
 */
export const FORBIDDEN_ECONOMIC_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  // authority shapes
  'capability',
  'capabilities',
  'grant',
  'grantId',
  'authority',
  'verdict',
  'allowed',
  'approved',
  'approvalId',
  'token',
  'secret',
  'credential',
  'budget',
  'priority',
  'principal',
  'actor',
  'spend',
  'spendingAuthority',
  // real-money shapes
  'venue',
  'broker',
  'brokerage',
  'account',
  'accountId',
  'wallet',
  'exchange',
  'live',
  'realMoney',
  'realOrder',
  'capital',
  'notional',
  'currencyPair',
  'custodian',
  'withdrawal',
  'deposit',
])

/* ------------------------------------------------------------ assertions */

/**
 * The Phase 32 assertions, by id. Each is checkable and none is decorative.
 *
 * The first two are the ones that make this phase what it is: `noRealMoneyAction` and
 * `noRealOrder`. They are not claims about a policy; they are read off a journal that
 * has no vocabulary capable of expressing the thing being forbidden.
 */
export const ECONOMIC_ASSERTIONS = [
  'noRealMoneyAction',
  'noRealOrder',
  'noModelCallWithoutWake',
  'noContinuousPolling',
  'noHiddenReasoning',
  'noUnrestrictedLoops',
  'noAuthorityEscalation',
  'noIdleModelCall',
  'noHiddenDurableState',
  'noSelfApproval',
  'noBudgetWidening',
] as const

export type EconomicAssertionId = (typeof ECONOMIC_ASSERTIONS)[number]

/** A closed pair of assertion and verdict, for a surface to display. */
export type EconomicAssertionVerdict = Readonly<Record<EconomicAssertionId, boolean>>

/* ----------------------------------------------------------- predicates */

export function isEconomicSignal(value: unknown): value is EconomicSignal {
  return typeof value === 'string' && (ECONOMIC_SIGNALS as readonly string[]).includes(value)
}

export function isEconomicStage(value: unknown): value is EconomicStage {
  return typeof value === 'string' && (ECONOMIC_STAGES as readonly string[]).includes(value)
}

/** Relative wake priority; lower is sooner. */
export function economicWakePriority(source: EconomicWakeSource): number {
  return ECONOMIC_WAKE_SOURCE_PRIORITY[source]
}

/**
 * The kind rank, exposed rather than inlined.
 *
 * Ranking exists so the owner sees the paper-trading experiment before the research
 * one — the surprising order is the honest one, because simulated capital in motion is
 * the item most worth a glance — and it is derived from a frozen table rather than
 * from a number a caller supplied.
 */
export function experimentKindRank(kind: EconomicExperimentKind): number {
  return EXPERIMENT_KIND_RANK[kind]
}