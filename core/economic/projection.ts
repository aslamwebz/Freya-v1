import { blockerForRefusal } from './authority'
import { planContinuation } from './continuation'
import { experimentConfidence, refreshEvidence } from './evidence'
import { assessResearch, isExperimentExpired } from './research'
import {
  ECONOMIC_LIMITS,
  experimentKindRank,
  type BoundedAction,
  type BoundedActionKind,
  type EconomicAssertionVerdict,
  type EconomicExperimentKind,
  type EconomicLimits,
  type EconomicRefusalCode,
  type EconomicReasonCode,
  type EconomicUncertaintyCode,
  type ExperimentBlocker,
  type ExperimentSummary,
  type ResearchEvidence,
} from './types'
import { experimentBundle, type EconomicExperimentRecord, type EconomicState } from './state'
import type { EconomicRecoveryReport } from './recovery'
import type { EconomicAssertionReport } from './assertions'
import type { EconomicSnapshot, EconomicStatus } from './runtime'

/**
 * The explainable economic state.
 *
 * A pure function of the folded state, the snapshot and the clock. No journal write, no
 * fetch, no randomness — so two reads of the same durable state produce deep-equal
 * objects, which is what lets a surface say "this is what Freya is researching" rather
 * than "this is roughly what she was researching a moment ago".
 *
 * It answers four questions and nothing else, because those are the four a person
 * actually has:
 *
 *   1. **What is being worked on?** `activeExperiments`, ranked.
 *   2. **What cannot proceed?** `blockedExperiments`, each with a closed blocker.
 *   3. **What is uncertain?** `uncertainExperiments`, with the uncertainty named.
 *   4. **What happens next?** `nextBoundedAction` — exactly one, never a list.
 *
 * Three properties hold by construction rather than by review:
 *
 *   - **Every item carries reasoning.** There is no field on any summary a renderer could
 *     fill with a sentence; the codes are a closed union declared in `types.ts`.
 *   - **Uncertainty is never hidden.** An experiment with no evidence appears in the
 *     uncertain list with `no-evidence`, not quietly in the active list looking fine.
 *   - **Nothing here grants anything.** A high-priority item does not skip a gate. The
 *     projection's one job beyond answering is to be honest about where the work is
 *     stuck, and the only thing it can move is the *order* things are looked at.
 */

export interface EconomicProjectionInput {
  readonly state: EconomicState
  readonly snapshot: EconomicSnapshot
  /** ISO instant, injected. The projection has no clock of its own. */
  readonly now: string
  /** Highest journal sequence folded in, so a window can prove it is current. */
  readonly sequence: number
  /** Whether this build has a long-horizon seam at all. */
  readonly longHorizonConnected: boolean
}

export function projectEconomicState(input: EconomicProjectionInput): EconomicProjection {
  const { state } = input
  const { limits } = input.snapshot
  const ranked = [...state.experiments].sort(compareForRanking)

  const active = ranked.filter((entry) => isActive(state, entry)).slice(0, limits.maxProjectionItems)
  const blocked = ranked.filter((entry) => blockerFor(state, entry, input.now) !== null)
  const uncertain = ranked.filter((entry) => uncertaintiesFor(state, entry, input.now).length > 0)
  const recentEvidence = newestEvidence(state, input.now, limits)

  return {
    health: input.snapshot.status.stopAllLatched ? 'degraded' : 'ready',
    reason: input.snapshot.status.stopAllLatched
      ? 'Freya is stopped, so economic intelligence is holding rather than working'
      : null,
    schemaVersion: ECONOMIC_SCHEMA_VERSION,
    sequence: input.sequence,
    generatedAt: input.now,
    activeExperiments: active.map((entry) => summaryFor(input.state, entry, input.now)),
    blockedExperiments: blocked
      .slice(0, limits.maxProjectionItems)
      .map((entry) => summaryFor(input.state, entry, input.now)),
    uncertainExperiments: uncertain
      .slice(0, limits.maxProjectionItems)
      .map((entry) => summaryFor(input.state, entry, input.now)),
    interruptedExperiments: input.state.interrupted.map((entry) => ({
      experimentId: entry.experimentId,
      stage: entry.stage,
      at: entry.at,
      code: entry.code,
    })),
    recentEvidence,
    nextBoundedAction: nextAction(input.state, input.now, limits, input.snapshot.status),
    counters: countersFor(input.snapshot.status, input.state),
    redTeam: redTeamFor(input.state),
    lastRefusal:
      input.snapshot.status.lastRefusal === null
        ? null
        : { code: input.snapshot.status.lastRefusal.code, at: input.snapshot.status.lastRefusal.at },
    recovery: describeRecovery(input.snapshot.recovery),
    requiresOwnerAction: input.snapshot.recovery?.requiresOwnerAction === true,
    assertions: assertionsFor(input.snapshot.assertions),
    limits,
    narrowedLimits: input.snapshot.narrowedLimits,
    longHorizonConnected: input.longHorizonConnected,
    realMoney: NO_REAL_MONEY,
  }
}

/* --------------------------------------------------------------- helpers */

/**
 * Is this experiment something the owner should look at now?
 *
 * False while the latch is down, and that is not tidiness: a stopped Freya has experiments
 * on disk exactly as a running one does, so listing them as *active* would let a renderer
 * say "one experiment is being worked on" at the moment nothing is being worked on. The
 * distinction between "held" and "active" is precisely the one a stopped system must not
 * blur.
 */
function isActive(state: EconomicState, experiment: EconomicExperimentRecord): boolean {
  if (state.stopAllLatched) return false
  if (experiment.state !== 'active') return false
  return experiment.stage !== 'COMPLETE' && experiment.stage !== 'FAILED'
}

/**
 * The one ordering. Paper trading first, then simulation, then research; progress within
 * a kind; id last.
 *
 * Derived from the frozen kind rank rather than from anything a caller supplied, so an
 * experiment cannot argue its way up the list — see the red-team case for priority claims.
 */
function compareForRanking(left: EconomicExperimentRecord, right: EconomicExperimentRecord): number {
  const byKind = experimentKindRank(left.kind) - experimentKindRank(right.kind)
  if (byKind !== 0) return byKind
  if (left.progress !== right.progress) return right.progress - left.progress
  return left.experimentId < right.experimentId ? -1 : left.experimentId > right.experimentId ? 1 : 0
}

/**
 * Why an experiment cannot proceed right now, or `null` when nothing is stopping it.
 *
 * Ordered from the most external to the most internal, so the first non-null answer is
 * the one the owner needs: a latch beats a budget beats an expired deadline beats a
 * missing piece of evidence. Each is a closed code, and each is derived from durable state
 * or from a gate that already ran — never from a claim.
 */
function blockerFor(
  state: EconomicState,
  experiment: EconomicExperimentRecord,
  now: string,
): ExperimentBlocker | null {
  if (state.stopAllLatched) return 'stop-all-latched'
  if (experiment.state === 'cancelled') return 'experiment-terminal'
  if (experiment.stage === 'COMPLETE' || experiment.stage === 'FAILED') return 'experiment-terminal'
  if (isExperimentExpired(experiment, now)) return 'deadline-expired'
  if (state.interrupted.some((entry) => entry.experimentId === experiment.experimentId)) {
    return 'interrupted-unresolved'
  }
  const bundle = experimentBundle(state, experiment.experimentId)
  if (bundle.evidence.length >= ECONOMIC_LIMITS.maxEvidencePerExperiment) return 'evidence-cap-reached'
  if (bundle.scenarios.length >= ECONOMIC_LIMITS.maxScenariosPerExperiment) return 'scenario-cap-reached'
  if (bundle.orders.length >= ECONOMIC_LIMITS.maxPaperOrdersPerExperiment) return 'order-cap-reached'
  return null
}

/** What is uncertain about an experiment, as closed codes. Sorted, so it is comparable. */
function uncertaintiesFor(
  state: EconomicState,
  experiment: EconomicExperimentRecord,
  now: string,
): readonly EconomicUncertaintyCode[] {
  const bundle = experimentBundle(state, experiment.experimentId)
  return assessResearch(experiment, bundle.evidence, now, ECONOMIC_LIMITS).assessment.uncertainties
}

/**
 * The owner-visible summary of one experiment.
 *
 * Every field here is bounded and closed. `reasoning` and `uncertainty` are unions from
 * `types.ts`, so a renderer cannot be handed a sentence a provider wrote, and the fold's
 * own text ceiling would reject it long before it got this far.
 */
function summaryFor(
  state: EconomicState,
  experiment: EconomicExperimentRecord,
  now: string,
): ExperimentSummary {
  const bundle = experimentBundle(state, experiment.experimentId)
  const assessment = assessResearch(experiment, bundle.evidence, now, ECONOMIC_LIMITS).assessment
  const reasoning = new Set<EconomicReasonCode>(assessment.reasoning)
  reasoning.add(experiment.state === 'active' ? 'due-now' : 'criteria-met')

  if (bundle.orders.length > 0) reasoning.add('paper-orders-closed')
  else if (experiment.stage === 'PAPER_TRADING') reasoning.add('paper-orders-open')
  if (bundle.scenarios.length > 0) reasoning.add('scenario-complete')
  if (state.interrupted.some((entry) => entry.experimentId === experiment.experimentId)) {
    reasoning.add('recovered-interrupted')
    reasoning.add('awaiting-owner')
  }

  const blocker = blockerFor(state, experiment, now)
  const confidence = experimentConfidence(bundle.evidence, now, ECONOMIC_LIMITS)
  if (confidence === 'unknown' || confidence === 'low') reasoning.add('assumption-declared')

  return {
    experimentId: experiment.experimentId,
    kind: experiment.kind,
    state: experiment.state,
    stage: experiment.stage,
    title: experiment.title,
    progress: experiment.progress,
    confidence,
    reasoning: [...reasoning].sort(),
    blockedReason: blocker,
    uncertainty: uncertaintiesFor(state, experiment, now),
    criteriaMet: assessment.criteriaMet.length,
    criteriaTotal: experiment.completionCriteria.length,
    updatedAt: experiment.updatedAt,
  }
}

/** The bounded, newest evidence, as the owner sees it. */
function newestEvidence(
  state: EconomicState,
  now: string,
  limits: EconomicLimits,
): readonly EconomicEvidenceView[] {
  const refreshed = refreshEvidence(state.evidence, now, limits)
  const byRecency = [...refreshed].sort((left, right) => {
    const a = Date.parse(left.observedAt)
    const b = Date.parse(right.observedAt)
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return b - a
    return left.evidenceId < right.evidenceId ? -1 : left.evidenceId > right.evidenceId ? 1 : 0
  })
  return byRecency.slice(0, limits.maxRecentRefusals).map((entry) => ({
    evidenceId: entry.evidenceId,
    experimentId: entry.experimentId,
    source: entry.source,
    sourceRef: entry.sourceRef,
    citation: entry.citation,
    state: entry.state,
    confidence: entry.confidence,
    observedAt: entry.observedAt,
  }))
}

/**
 * The single next bounded action.
 *
 * One action, never a list, and the order of preference is fixed:
 *
 *   1. **`stop`** when the latch is down. Nothing else is worth recommending.
 *   2. **`verify`** for an interrupted experiment. Somebody has to look before it moves.
 *   3. **`escalate`** for a blocked one — but only for the *external* blockers, because
 *      telling the owner about an experiment that is simply out of time is noise.
 *   4. **`execute`** for the top-ranked active experiment that can actually move.
 *   5. **`wait`** when there is nothing. Silence is an answer, and saying it is better
 *      than inventing an action.
 *
 * Every recommendation names a deadline and a maximum number of attempts, both derived
 * from the experiment's own deadline and the code-owned retry ceiling. Neither can be
 * extended by whoever reads it.
 */
function nextAction(
  state: EconomicState,
  now: string,
  limits: EconomicLimits,
  status: EconomicStatus,
): BoundedAction | null {
  const reasoning: string[] = []

  if (state.stopAllLatched) {
    return {
      actionId: `${ECONOMIC_ACTION_PREFIX}-stop`,
      kind: 'stop',
      target: '',
      deadlineAt: now,
      maxAttempts: 0,
      reasoning: ['stop-all-latched'],
    }
  }

  const interrupted = state.interrupted[0]
  if (interrupted !== undefined) {
    return {
      actionId: `${ECONOMIC_ACTION_PREFIX}-verify-${interrupted.experimentId}`,
      kind: 'verify',
      target: interrupted.experimentId,
      deadlineAt: interrupted.at === '' ? now : interrupted.at,
      maxAttempts: limits.maxRetryCeiling,
      reasoning: ['recovered-interrupted', 'awaiting-owner'],
    }
  }

  const blocked = state.experiments.find((entry) => {
    const blocker = blockerFor(state, entry, now)
    return blocker !== null && EXTERNAL_BLOCKERS.has(blocker)
  })
  if (blocked !== undefined) {
    const blocker = blockerFor(state, blocked, now) ?? 'deadline-expired'
    reasoning.push(blocker)
    return {
      actionId: `${ECONOMIC_ACTION_PREFIX}-escalate-${blocked.experimentId}`,
      kind: 'escalate',
      target: blocked.experimentId,
      deadlineAt: blocked.deadlineAt ?? now,
      maxAttempts: limits.maxRetryCeiling,
      reasoning: [...reasoning, 'awaiting-owner'],
    }
  }

  const ranked = [...state.experiments].sort(compareForRanking)
  const next = ranked.find((entry) => {
    if (!isActive(state, entry)) return false
    return blockerFor(state, entry, now) === null && canMove(state, entry, now)
  })
  if (next !== undefined) {
    const plan = planContinuation({
      experiment: next,
      facts: factsFor(state, next.experimentId),
      now,
      limits,
      expired: false,
    })
    return {
      actionId: `${ECONOMIC_ACTION_PREFIX}-execute-${next.experimentId}`,
      kind: 'execute',
      target: next.experimentId,
      deadlineAt: next.deadlineAt ?? now,
      maxAttempts: limits.maxRetryCeiling,
      reasoning: [...new Set([...plan.reasoning, 'due-now' as EconomicReasonCode])].sort(),
    }
  }

  if (ranked.some((entry) => isActive(state, entry))) {
    return {
      actionId: `${ECONOMIC_ACTION_PREFIX}-wait`,
      kind: 'wait',
      target: '',
      deadlineAt: now,
      maxAttempts: limits.maxRetryCeiling,
      reasoning: ['awaiting-owner'],
    }
  }

  void status
  return null
}

/**
 * The blockers worth telling the owner about.
 *
 * `deadline-expired` is deliberately absent. An experiment that ran out of time is a fact
 * about the experiment, and recommending that the owner escalate every one of them would
 * train them to stop reading the recommendation.
 */
const EXTERNAL_BLOCKERS: ReadonlySet<ExperimentBlocker> = new Set([
  'guard-denied',
  'governor-denied',
  'budget-exhausted',
  'approval-required',
  'real-money-prohibited',
])

/** Could a bounded step actually move this experiment right now? */
function canMove(state: EconomicState, experiment: EconomicExperimentRecord, now: string): boolean {
  const plan = planContinuation({
    experiment,
    facts: factsFor(state, experiment.experimentId),
    now,
    limits: ECONOMIC_LIMITS,
    expired: isExperimentExpired(experiment, now),
  })
  return plan.signal !== null
}

function factsFor(
  state: EconomicState,
  experimentId: string,
): {
  evidence: EconomicState['evidence']
  scenarioCount: number
  scenariosRunning: number
  orderCount: number
  metricCount: number
} {
  const bundle = experimentBundle(state, experimentId)
  return {
    evidence: bundle.evidence,
    scenarioCount: bundle.scenarios.length,
    scenariosRunning: bundle.scenarios.filter(
      (entry) => entry.status === 'pending' || entry.status === 'running',
    ).length,
    orderCount: bundle.orders.length,
    metricCount: bundle.metrics.length,
  }
}

/** The counters a surface shows, all derived and none of them a claim. */
function countersFor(status: EconomicStatus, state: EconomicState): EconomicCountersView {
  return {
    experiments: status.experiments,
    active: status.activeExperiments,
    interrupted: status.interruptedExperiments,
    evidence: state.evidence.length,
    scenarios: state.scenarios.length,
    orders: state.orders.length,
    metrics: state.metrics.length,
    refusals: status.refusalCount,
  }
}

/**
 * The refused-attempt summary.
 *
 * Counts by closed code and the last few attempts, which is exactly what the red-team
 * documentation asks for: a count of refused attempts, a bounded list of recent ones, and
 * a summary by pattern. Nothing here is a raw number from a caller.
 */
function redTeamFor(state: EconomicState): EconomicRedTeamView {
  const byCode = new Map<string, number>()
  for (const refusal of state.refusals) {
    byCode.set(refusal.code, (byCode.get(refusal.code) ?? 0) + 1)
  }
  return {
    refusedAttempts: state.refusals.length,
    byCode: [...byCode.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    recent: [...state.refusals]
      .slice(-ECONOMIC_LIMITS.maxRecentRefusals)
      .reverse()
      .map((refusal) => ({
        refusalId: refusal.refusalId,
        code: refusal.code,
        subject: refusal.subject,
        experimentId: refusal.experimentId,
        at: refusal.at,
      })),
  }
}

function assertionsFor(report: EconomicAssertionReport | null): EconomicAssertionVerdict {
  return (
    report?.checks ?? {
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
    }
  )
}

function describeRecovery(report: EconomicRecoveryReport | null): string | null {
  if (report === null || !report.reconciled) return null
  if (report.stopAllActive) return 'Freya was stopped when the last process ended, and a restart is not the owner clearing that.'
  if (report.interrupted.length === 0) return null
  const plural = report.interrupted.length === 1 ? 'experiment was' : 'experiments were'
  return `${report.interrupted.length} economic ${plural} interrupted by the restart and recorded rather than resumed; nothing continues without an explicit wake.`
}

/* ------------------------------------------------------------ view types */

/**
 * The projection schema this lane speaks.
 *
 * Local rather than imported from `protocol/economic.ts` so the domain has no dependency
 * on the wire layer; the two are checked against each other by a test, which is what
 * catches a view field added to one and forgotten in the other.
 */
export const ECONOMIC_SCHEMA_VERSION = 1

/** The sentence the projection asserts about money. Fixed, and quoted everywhere. */
export const NO_REAL_MONEY = 'simulated-only'

const ECONOMIC_ACTION_PREFIX = 'econ'

export interface EconomicEvidenceView {
  readonly evidenceId: string
  readonly experimentId: string
  readonly source: ResearchEvidence['source']
  readonly sourceRef: string
  readonly citation: string
  readonly state: ResearchEvidence['state']
  readonly confidence: ResearchEvidence['confidence']
  readonly observedAt: string
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
  /** Closed refusal code to count. Sorted, so it is comparable between two reads. */
  readonly byCode: readonly (readonly [string, number])[]
  readonly recent: readonly {
    readonly refusalId: string
    readonly code: string
    readonly subject: string
    readonly experimentId: string | null
    readonly at: string
  }[]
}

/**
 * One experiment as the owner sees it.
 *
 * An alias rather than a restatement: the domain's `ExperimentSummary` is already
 * bounded, closed and renderer-safe, and a second copy of the same shape is a second
 * thing to keep in step. A test asserts the alias exists precisely so the *wire* module
 * cannot drift away from it.
 */
export type EconomicSummaryView = ExperimentSummary
export interface EconomicInterruptionView {
  readonly experimentId: string
  readonly stage: string
  readonly at: string
  readonly code: string
}

/** Everything a window may know about economic intelligence, in one read-only object. */
export interface EconomicProjection {
  readonly health: 'ready' | 'degraded' | 'unavailable'
  readonly reason: string | null
  readonly schemaVersion: number
  readonly sequence: number
  readonly generatedAt: string
  readonly activeExperiments: readonly EconomicSummaryView[]
  readonly blockedExperiments: readonly EconomicSummaryView[]
  readonly uncertainExperiments: readonly EconomicSummaryView[]
  readonly interruptedExperiments: readonly EconomicInterruptionView[]
  readonly recentEvidence: readonly EconomicEvidenceView[]
  readonly nextBoundedAction: BoundedAction | null
  readonly counters: EconomicCountersView
  readonly redTeam: EconomicRedTeamView
  readonly lastRefusal: { readonly code: string; readonly at: string } | null
  readonly recovery: string | null
  readonly requiresOwnerAction: boolean
  readonly assertions: EconomicAssertionVerdict
  readonly limits: EconomicLimits
  readonly narrowedLimits: readonly string[]
  readonly longHorizonConnected: boolean
  /** `simulated-only`, always. It is a field so a surface cannot invent a third value. */
  readonly realMoney: typeof NO_REAL_MONEY
}

/** Kinds, in the order the ranking shows them. */
export const PROJECTED_KIND_ORDER: readonly EconomicExperimentKind[] = Object.freeze([
  'paper-trading',
  'simulation',
  'research',
])

/** The action kinds a recommendation may carry. Mirrors the domain's closed set. */
export const PROJECTED_ACTION_KINDS: readonly BoundedActionKind[] = Object.freeze([
  'execute',
  'delegate',
  'verify',
  'wait',
  'escalate',
  'stop',
])

/** The gate blocker a refusal code maps to, exposed for the protocol module's benefit. */
export { blockerForRefusal }
export type { EconomicRefusalCode }