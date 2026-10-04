import { experimentConfidence, refreshEvidence, uncertaintiesFor, type EvidenceObservation } from './evidence'
import { isCriterion } from './types'
import type {
  EconomicExperiment,
  EconomicExperimentKind,
  EconomicLimits,
  EconomicReasonCode,
  EconomicRefusalCode,
  EconomicUncertaintyCode,
  ResearchEvidence,
} from './types'

/**
 * The Research Engine.
 *
 * Bounded, cited, honest research. It defines what is being looked at, admits evidence
 * about it, assesses what that evidence does and does not support, and reports both
 * halves. What it does not do is gather anything: Phase 32 reaches no network, so
 * observations arrive through a port and every one of them has to name an authorized
 * source and a citation before it becomes evidence at all.
 *
 * The one idea in this module worth stating twice is that **a completion criterion is a
 * claim key**. An experiment declares what it would need to know — `"peer-reviewed
 * demand for the product category"` — and that criterion is met when there is fresh,
 * uncontested evidence *about that exact claim*. So progress is derived from the
 * evidence rather than reported by the thing doing the looking, and an experiment cannot
 * mark itself 80% done because it feels 80% done.
 *
 * Completion criteria are strings on purpose: keeping them opaque means a caller cannot
 * encode a condition, a threshold or a judgement into one. They are keys or they are
 * nothing.
 */

/** A new experiment, as the owner or Core asks for one. */
export interface ExperimentDraft {
  readonly experimentId: string
  readonly kind: EconomicExperimentKind
  readonly title: string
  readonly question: string
  readonly completionCriteria: readonly string[]
  readonly createdAt: string
  /** Absolute, or null to let the code-owned maximum apply. */
  readonly deadlineAt: string | null
}

export type ExperimentDefinition =
  | { readonly ok: true; readonly experiment: EconomicExperiment }
  | { readonly ok: false; readonly code: EconomicRefusalCode; readonly reason: string }

const RESEARCH_REFUSALS = Object.freeze({
  'title-over-long': 'That title was longer than a title is allowed to be.',
  'missing-title': 'An experiment needs a title the owner can recognise.',
  'question-over-long': 'That question was longer than a question is allowed to be.',
  'missing-question': 'An experiment needs a question, or there is nothing to research.',
  'criteria-empty': 'An experiment with no completion criteria cannot be finished.',
  'criteria-over-long': 'That experiment named more completion criteria than it may.',
  'criterion-over-long': 'That completion criterion was longer than a criterion is allowed to be.',
  'criterion-malformed':
    'A completion criterion is a key like "peer-reviewed-demand", not a sentence. Anything else could not be matched against evidence.',
  'criterion-duplicate': 'That completion criterion was named twice.',
  'invalid-created-at': 'That experiment had no readable starting moment.',
  'deadline-before-start': 'That deadline was already in the past when the experiment began.',
  'deadline-over-long': 'That deadline was further out than an experiment may run.',
  'experiment-cap-reached': 'There are already as many experiments as there may be.',
} as const)

type ResearchRefusalCode = keyof typeof RESEARCH_REFUSALS

export function researchRefusalReason(code: EconomicRefusalCode): string {
  const entry = (RESEARCH_REFUSALS as Readonly<Record<string, string>>)[code]
  return entry ?? 'That experiment could not be defined.'
}

/**
 * Define an experiment, or refuse it.
 *
 * The deadline arithmetic is the part worth reading twice. A caller may ask for a
 * deadline, and the ask is **clamped** to the code-owned maximum rather than honoured
 * or refused: a thirty-day ceiling on every experiment is a property of the subsystem,
 * and a request for a year is a request the subsystem cannot grant. The floor is
 * different — a deadline already in the past is *refused*, because an experiment that
 * begins expired is not a bounded experiment, it is a terminal one that has not admitted
 * it yet.
 */
export function defineExperiment(
  draft: ExperimentDraft,
  existing: readonly EconomicExperiment[],
  limits: EconomicLimits,
): ExperimentDefinition {
  const refuse = (code: ResearchRefusalCode): ExperimentDefinition => ({
    ok: false,
    code,
    reason: RESEARCH_REFUSALS[code],
  })

  if (existing.length >= limits.maxExperiments) return refuse('experiment-cap-reached')
  if (typeof draft.title !== 'string' || draft.title.trim().length === 0) return refuse('missing-title')
  if (draft.title.length > limits.maxTitleLength) return refuse('title-over-long')
  if (typeof draft.question !== 'string' || draft.question.trim().length === 0) {
    return refuse('missing-question')
  }
  if (draft.question.length > limits.maxQuestionLength) return refuse('question-over-long')
  if (draft.completionCriteria.length === 0) return refuse('criteria-empty')
  if (draft.completionCriteria.length > limits.maxCompletionCriteria) return refuse('criteria-over-long')
  for (const criterion of draft.completionCriteria) {
    if (typeof criterion !== 'string' || criterion.trim().length === 0) return refuse('criteria-empty')
    // The grammar is checked **before** the length. A criterion that is a sentence rather
    // than a key is a malformed criterion, and reporting it as "too long" would hide the
    // actual mistake behind a bound the caller could fix by shortening the wrong thing.
    if (!isCriterion(criterion)) return refuse('criterion-malformed')
    if (criterion.length > limits.maxCriterionLength) return refuse('criterion-over-long')
  }
  if (new Set(draft.completionCriteria).size !== draft.completionCriteria.length) {
    return refuse('criterion-duplicate')
  }
  const created = Date.parse(draft.createdAt)
  if (!Number.isFinite(created)) return refuse('invalid-created-at')

  // Compared as instants, not as strings. An ISO-8601 instant *does* sort correctly
  // lexicographically in UTC, but relying on that would make the deadline ceiling a
  // property of a date format rather than of arithmetic — and this is exactly the sort of
  // thing that breaks the day somebody adds an offset.
  const ceilingMs = created + limits.maxExperimentDurationMs
  let deadlineAt = new Date(ceilingMs).toISOString()
  if (draft.deadlineAt !== null) {
    const asked = Date.parse(draft.deadlineAt)
    if (!Number.isFinite(asked)) return refuse('invalid-created-at')
    if (asked < created) return refuse('deadline-before-start')
    deadlineAt = new Date(asked < ceilingMs ? asked : ceilingMs).toISOString()
  }

  return {
    ok: true,
    experiment: {
      experimentId: draft.experimentId,
      kind: draft.kind,
      state: 'draft',
      title: draft.title,
      question: draft.question,
      completionCriteria: Object.freeze([...draft.completionCriteria]),
      progress: 0,
      deadlineAt,
      createdAt: new Date(created).toISOString(),
      updatedAt: new Date(created).toISOString(),
      completedAt: null,
    },
  }
}

/** What the research engine concludes about one experiment right now. */
export interface ResearchAssessment {
  readonly experimentId: string
  /** Fraction of completion criteria met, 0–1. Derived, never supplied. */
  readonly progress: number
  readonly confidence: ReturnType<typeof experimentConfidence>
  readonly criteriaMet: readonly string[]
  readonly criteriaUnmet: readonly string[]
  /** Closed codes. Never free text, so a window can render this without a filter. */
  readonly uncertainties: readonly EconomicUncertaintyCode[]
  /**
   * Notes contributed by the simulation or paper stage.
   *
   * Deliberately separate from uncertainties rather than merged into it: those are
   * closed codes this module decides, these are strings somebody downstream wrote, and
   * merging them would put untrusted text on a list whose type promises it is closed.
   */
  readonly notes: readonly string[]
  readonly reasoning: readonly EconomicReasonCode[]
  /** Whether there is enough evidence for this experiment to leave the research stage. */
  readonly sufficient: boolean
}

/**
 * Assess one experiment against its evidence.
 *
 * Deterministic and total: the same evidence, criteria and clock always produce the same
 * assessment. Four steps, and each is a rule rather than a judgement:
 *
 *   1. **Refresh.** Freshness and conflict are re-derived from `now` rather than read
 *      off what was written when the evidence arrived, so a filing that has aged out is
 *      stale in the projection without anything having had to go and mark it.
 *   2. **Score each criterion.** Met when there is at least one fresh, uncontested
 *      piece of evidence about that exact claim. A criterion nothing has ever been said
 *      about is *not* met — it is unknown, and unknown is not met.
 *   3. **Confidence.** The worst claim's confidence, for the reason in `evidence.ts`.
 *   4. **Reasoning.** Closed codes, so a window can render why an experiment is where
 *      it is without any of this module's wording crossing the boundary.
 */
export function assessResearch(
  experiment: EconomicExperiment,
  observations: readonly ResearchEvidence[],
  now: string,
  limits: EconomicLimits,
  extraUncertainties: readonly string[] = [],
  /** Assumptions the simulation or paper stage declared, which research does not own. */
  extraAssumptions = 0,
): { readonly evidence: readonly ResearchEvidence[]; readonly assessment: ResearchAssessment } {
  const evidence = refreshEvidence(observations, now, limits)
  const reasoning = new Set<EconomicReasonCode>()
  const unsatisfied: string[] = []

  // A criterion is *met* when there is at least one fresh, uncontested reading about
  // that exact claim. Anything else — stale, contested, or never said — is unmet, and
  // an unmet criterion is not a failure: it is the honest state of a question that has
  // not been answered yet.
  const satisfied: string[] = []
  for (const criterion of experiment.completionCriteria) {
    const forClaim = evidence.filter((entry) => entry.claim === criterion)
    const fresh = forClaim.filter((entry) => entry.state === 'fresh')
    if (fresh.length > 0) {
      reasoning.add('evidence-fresh')
      satisfied.push(criterion)
      continue
    }
    unsatisfied.push(criterion)
    if (forClaim.length === 0) reasoning.add('evidence-missing')
    else if (forClaim.some((entry) => entry.state === 'conflicted')) reasoning.add('evidence-conflicted')
    else reasoning.add('evidence-stale')
  }

  const criteriaMet = [...satisfied].sort()
  const criteriaUnmet = [...unsatisfied].sort()

  if (criteriaMet.length === experiment.completionCriteria.length) reasoning.add('criteria-met')
  else reasoning.add('criteria-unmet')
  if (criteriaMet.length === 0) reasoning.add('due-now')
  if (criteriaUnmet.length > 0) reasoning.add('awaiting-owner')

  const uncertainties = uncertaintiesFor(evidence, extraAssumptions, 0, 0)

  return {
    evidence,
    assessment: {
      experimentId: experiment.experimentId,
      progress: ratio(criteriaMet.length, experiment.completionCriteria.length),
      confidence: experimentConfidence(evidence, now, limits),
      criteriaMet,
      criteriaUnmet,
      uncertainties,
      notes: [...extraUncertainties],
      reasoning: [...reasoning].sort(),
      sufficient: criteriaMet.length > 0,
    },
  }
}

/** A division that cannot divide by zero, and rounds to a fixed precision. */
function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0
  return Math.round((numerator / denominator) * 1e12) / 1e12
}

/**
 * Has this experiment run out of time?
 *
 * A comparison, not a job. Nothing schedules this check: it is evaluated whenever the
 * subsystem is next asked, which is why it takes `now` as a parameter and why there is
 * no refresh timer anywhere in this lane.
 */
export function isExperimentExpired(experiment: EconomicExperiment, now: string): boolean {
  if (experiment.deadlineAt === null) return false
  const deadline = Date.parse(experiment.deadlineAt)
  const current = Date.parse(now)
  if (!Number.isFinite(deadline) || !Number.isFinite(current)) return true
  return current >= deadline
}

/**
 * The one-liner about what research is doing, for a log line.
 *
 * Composed entirely from closed codes and the experiment's own bounded title, and it is
 * exported rather than inlined so the host, the projection and the tests quote the same
 * words.
 */
export function describeResearch(experiment: EconomicExperiment, assessment: ResearchAssessment): string {
  return [
    `"${experiment.title}" is ${experiment.kind} research at ${assessment.criteriaMet.length} of`,
    `${experiment.completionCriteria.length} criteria met,`,
    `confidence ${assessment.confidence},`,
    `uncertainty ${assessment.uncertainties.length === 0 ? 'none' : assessment.uncertainties.join(', ')}.`,
  ].join(' ')
}

/** Re-exported so a caller does not have to reach into `evidence.ts` for the type. */
export type { EvidenceObservation }