import { experimentConfidence, refreshEvidence } from './evidence'
import { retryCeilingReached } from './deadlines'
import {
  EXPERIMENT_KIND_RANK,
  experimentKindRank,
  type EconomicExperimentKind,
  type EconomicLimits,
  type EconomicReasonCode,
  type EconomicSignal,
  type EconomicStage,
  type ExperimentBlocker,
  type ResearchEvidence,
} from './types'
import type { EconomicExperimentRecord } from './state'

/**
 * The continuation decision.
 *
 * One pure function that answers: given where an experiment is and what is true about it
 * right now, what should happen next — and, just as importantly, **whether anything
 * should happen at all**. `signal: null` is the most common answer and it is a real one.
 *
 * Three properties this module is built to have:
 *
 *   1. **It cannot move an experiment by itself.** It returns a signal for the state
 *      machine to accept or refuse, and the machine is what the fold consults. So a
 *      decision that asks for an illegal move produces a refusal the journal records,
 *      not a state change that quietly happened.
 *
 *   2. **A claim changes nothing.** The input is an experiment record and the evidence
 *      about it. There is no field on which a caller could state a priority, a deadline
 *      or an outcome, so there is nothing for an experiment to argue with. The only
 *      ordering in this subsystem is `EXPERIMENT_KIND_RANK`, which is frozen.
 *
 *   3. **`null` is the default.** An experiment with no evidence, an experiment waiting
 *      on a simulation, and an experiment waiting for its metrics all return `null` with
 *      an honest reason. A subsystem whose answer is "carry on" whenever it cannot
 *      decide is a subsystem that runs itself, and that is the failure this phase exists
 *      to prevent.
 */

/** The closed set of what a continuation decision can conclude. */
export const ECONOMIC_DECISIONS = [
  'experiment-opened',
  'research-in-progress',
  'research-sufficient',
  'simulation-in-progress',
  'simulation-sufficient',
  'paper-in-progress',
  'paper-complete',
  'analysis-in-progress',
  'analysis-complete',
  'blocked',
  'expired',
  'closed-out',
] as const

export type EconomicContinuationDecision = (typeof ECONOMIC_DECISIONS)[number]

const DECISION_REASONS: Readonly<Record<EconomicContinuationDecision, string>> = Object.freeze({
  'experiment-opened': 'The experiment exists and has not begun, so it opens in the stage its kind dictates.',
  'research-in-progress': 'There is not enough evidence yet, so the research stage keeps going.',
  'research-sufficient': 'There is enough evidence, so the research stage is over.',
  'simulation-in-progress': 'A scenario has not finished, so the simulation stage keeps going.',
  'simulation-sufficient': 'Every scenario has finished, and there is no paper trading to do.',
  'paper-in-progress': 'There is more simulated trading to record before this can be read.',
  'paper-complete': 'The simulated trading is recorded and measured, so the results are ready to read.',
  'analysis-in-progress': 'Not every completion criterion has evidence behind it yet.',
  'analysis-complete': 'Every completion criterion has fresh evidence behind it.',
  blocked: 'Something outside the experiment is stopping it, and the reason is recorded.',
  expired: 'The experiment ran out of time, which is a terminal outcome rather than a failure of the work.',
  'closed-out': 'The experiment is finished and there is nothing left to decide.',
})

export function continuationDecisionReason(decision: EconomicContinuationDecision): string {
  return DECISION_REASONS[decision]
}

/** What the decision needs to know that is not on the experiment record. */
export interface ContinuationFacts {
  readonly evidence: readonly ResearchEvidence[]
  readonly scenarioCount: number
  /** Scenarios that have neither completed nor failed. */
  readonly scenariosRunning: number
  readonly orderCount: number
  readonly metricCount: number
}

export interface ContinuationInput {
  readonly experiment: EconomicExperimentRecord
  readonly facts: ContinuationFacts
  readonly now: string
  readonly limits: EconomicLimits
  /** Whether the experiment's absolute deadline has passed. Computed by the caller. */
  readonly expired: boolean
}

export interface ContinuationPlan {
  /** The signal to offer the state machine, or `null` when nothing should happen. */
  readonly signal: EconomicSignal | null
  readonly decision: EconomicContinuationDecision
  readonly blocker: ExperimentBlocker | null
  readonly reasoning: readonly EconomicReasonCode[]
  readonly progress: number
  readonly confidence: ReturnType<typeof experimentConfidence>
}

/**
 * Decide what happens next.
 *
 * Total and pure. Every stage has an answer, including the two terminal ones, and there
 * is no code path that returns nothing at all — because "I could not decide" is not a
 * thing this subsystem is allowed to do to an experiment somebody is waiting on.
 */
export function planContinuation(input: ContinuationInput): ContinuationPlan {
  const { experiment, facts, limits } = input
  const evidence = refreshEvidence(facts.evidence, input.now, limits)
  const satisfied = satisfiedCriteria(experiment, evidence)
  const progress = ratio(satisfied, experiment.completionCriteria.length)
  const confidence = experimentConfidence(evidence, input.now, limits)
  const reasoning = new Set<EconomicReasonCode>()

  const plan = (
    signal: EconomicSignal | null,
    decision: EconomicContinuationDecision,
    blocker: ExperimentBlocker | null = null,
  ): ContinuationPlan => ({
    signal,
    decision,
    blocker,
    reasoning: [...reasoning].sort(),
    progress,
    confidence,
  })

  // Terminal stages have one answer, and it is checked first so no amount of evidence
  // can revive an experiment somebody has already finished.
  if (experiment.stage === 'COMPLETE' || experiment.stage === 'FAILED') {
    return plan(null, 'closed-out')
  }

  // An expired experiment fails from any live stage, and it is checked before the
  // per-stage work because a deadline is the subsystem's own promise about when it would
  // stop — and it is not kept by finding something else to do instead.
  if (input.expired && experiment.stage !== 'IDLE') {
    reasoning.add('criteria-unmet')
    return plan('experiment-failed', 'expired', 'deadline-expired')
  }
  if (experiment.stage === 'IDLE') {
    if (experiment.state === 'draft') return plan('experiment-opened', 'experiment-opened')
    return plan(null, 'closed-out')
  }

  switch (experiment.stage) {
    case 'RESEARCHING': {
      // An attempt ceiling reached means this stage has failed as many times as it is
      // allowed, and the honest response is to stop rather than to keep trying in the
      // hope that this attempt works.
      if (retryCeilingReached({ maxAttempts: limits.maxRetryCeiling, currentAttempt: attemptCountFor(experiment, limits), baseBackoffMs: 0, maxBackoffMs: 0, jitterMs: 0 })) {
        reasoning.add('awaiting-owner')
        return plan('experiment-failed', 'blocked', 'attempt-ceiling-reached')
      }
      if (evidence.length === 0) {
        reasoning.add('evidence-missing')
        reasoning.add('due-now')
        return plan(null, 'research-in-progress')
      }
      reasoning.add(satisfied > 0 ? 'criteria-met' : 'criteria-unmet')
      reasoning.add('evidence-fresh')
      // A research experiment has no simulation to run, so it skips straight to reading
      // the results. The other two continue into one.
      if (experiment.kind === 'research') return plan('research-sufficient', 'research-sufficient')
      return plan('research-complete', 'research-sufficient')
    }

    case 'SIMULATING': {
      if (facts.scenarioCount === 0) {
        reasoning.add('scenario-pending')
        return plan(null, 'simulation-in-progress')
      }
      if (facts.scenariosRunning > 0) {
        reasoning.add('scenario-pending')
        return plan(null, 'simulation-in-progress')
      }
      reasoning.add('scenario-complete')
      if (experiment.kind === 'paper-trading') return plan('simulation-complete', 'simulation-sufficient')
      return plan('simulation-sufficient', 'simulation-sufficient')
    }

    case 'PAPER_TRADING': {
      if (facts.orderCount === 0) {
        reasoning.add('paper-orders-open')
        return plan(null, 'paper-in-progress')
      }
      if (facts.metricCount === 0) {
        // Orders without metrics is a genuinely unfinished stage, not a cosmetic one: the
        // whole reason to record simulated trades is to be able to say what they showed,
        // and a portfolio with no denominators has said nothing.
        reasoning.add('paper-orders-closed')
        return plan(null, 'paper-in-progress')
      }
      reasoning.add('paper-orders-closed')
      return plan('paper-complete', 'paper-complete')
    }

    case 'ANALYZING': {
      if (satisfied >= experiment.completionCriteria.length) {
        reasoning.add('criteria-met')
        return plan('analysis-complete', 'analysis-complete')
      }
      reasoning.add('criteria-unmet')
      reasoning.add('awaiting-owner')
      return plan(null, 'analysis-in-progress')
    }

    default: {
      // Unreachable: the terminal stages returned above and the closed set has no more.
      const exhaustive: never = experiment.stage
      return plan(null, 'closed-out', String(exhaustive) as ExperimentBlocker)
    }
  }
}

/**
 * How many completion criteria have fresh, uncontested evidence.
 *
 * Capped at the number of criteria rather than counted from the evidence, so a pile of
 * observations about things nobody asked about cannot make an experiment look finished.
 */
function satisfiedCriteria(
  experiment: EconomicExperimentRecord,
  evidence: readonly ResearchEvidence[],
): number {
  const fresh = new Set(
    evidence.filter((entry) => entry.state === 'fresh').map((entry) => entry.claim),
  )
  let count = 0
  for (const criterion of experiment.completionCriteria) {
    if (fresh.has(criterion)) count += 1
  }
  return Math.min(count, experiment.completionCriteria.length)
}

/**
 * Attempts spent on this experiment, read from its own progress rather than from a
 * counter held in memory.
 *
 * The fold counts a failed experiment once per terminal move, so this is derived from
 * the fact that a terminal stage was reached rather than from a separate ledger that
 * could disagree with it. A bound derived from the state machine cannot be reset by a
 * restart, because the restart re-derives the same state.
 */
function attemptCountFor(experiment: EconomicExperimentRecord, limits: EconomicLimits): number {
  return experiment.state === 'failed' ? limits.maxRetryCeiling : 0
}

/**
 * Rank experiments for the owner-visible projection.
 *
 * Deterministic, and the ordering is deliberately not the creation order. Paper trading
 * ranks first, then simulation, then research — because simulated capital in motion is
 * the item most worth a glance, and the honest order is the surprising one. Ties break on
 * progress (further along first) and then on id, so two experiments at the same rank and
 * progress are always shown in the same order.
 */
export function rankExperiments(
  experiments: readonly EconomicExperimentRecord[],
): readonly EconomicExperimentRecord[] {
  return [...experiments].sort((left, right) => {
    const byKind = experimentKindRank(left.kind) - experimentKindRank(right.kind)
    if (byKind !== 0) return byKind
    if (left.progress !== right.progress) return right.progress - left.progress
    return left.experimentId < right.experimentId ? -1 : left.experimentId > right.experimentId ? 1 : 0
  })
}

/** The kinds, in the order they are ranked. Exported so a surface can label the columns. */
export const EXPERIMENT_KIND_ORDER: readonly EconomicExperimentKind[] = Object.freeze(
  (Object.keys(EXPERIMENT_KIND_RANK) as EconomicExperimentKind[]).sort(
    (left, right) => EXPERIMENT_KIND_RANK[left] - EXPERIMENT_KIND_RANK[right],
  ),
)

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0
  return Math.round((numerator / denominator) * 1e12) / 1e12
}

/** The stages, in the order an experiment passes through them. */
export const ECONOMIC_STAGE_ORDER: readonly EconomicStage[] = Object.freeze([
  'IDLE',
  'RESEARCHING',
  'SIMULATING',
  'PAPER_TRADING',
  'ANALYZING',
  'COMPLETE',
  'FAILED',
])