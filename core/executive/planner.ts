/**
 * THE PLANNER — planning under uncertainty.
 *
 * Pure functions only: no I/O, no clock read (injected `now`), no model, no
 * randomness. Same inputs + same clock = same plan.
 *
 * The planner maintains assumptions with confidence levels, detects stale and
 * conflicted evidence, marks decisions as reversible/irreversible, and produces
 * bounded next actions. It never calls a model, never creates authority, and
 * never widens a budget.
 *
 * A plan is a request, not an authority. It names a capability that must exist,
 * a verifier that must exist, and ceilings that may only be lowered.
 */

import {
  EXECUTIVE_LIMITS,
  instantMs,
  type ConfidenceLevel,
  type Evidence,
  type EvidenceState,
  type Plan,
  type PlannedStep,
  type PlanningAssumption,
} from './types'

/* ------------------------------------------------------------------ inputs */

/** A goal to plan for. */
export interface PlanGoal {
  readonly goalId: string
  readonly description: string
  readonly requiredCapabilities: readonly string[]
  readonly deadlineAt: string | null
  readonly dependencies: readonly string[]
  readonly reversible: boolean
}

/** The planning context. */
export interface PlannerContext {
  readonly now: string
  readonly goals: readonly PlanGoal[]
  readonly evidence: readonly Evidence[]
  readonly knownCapabilities: ReadonlySet<string>
  readonly pendingApprovals: ReadonlySet<string>
}

/* ------------------------------------------------------------------ evidence */

/**
 * Detect the state of evidence for a goal.
 *
 * Evidence is never silently overwritten. Stale and conflicted evidence
 * remains represented alongside fresh evidence.
 */
export function detectEvidenceState(evidence: readonly Evidence[], now: string): EvidenceState {
  if (evidence.length === 0) return 'missing'
  // A conflict is a property of the evidence itself and outranks freshness:
  // two sources disagreeing is never reported as merely fresh or stale.
  if (evidence.some((e) => e.state === 'conflicted')) return 'conflicted'
  // An explicit invalidation is a property of the evidence too: evidence the
  // owner or a source has marked stale is stale even if its timestamp is recent.
  if (evidence.some((e) => e.state === 'stale')) return 'stale'

  const nowMs = instantMs(now)
  if (nowMs === null) return 'missing'

  const states: EvidenceState[] = evidence.map((e) => {
    const observedMs = instantMs(e.observedAt)
    if (observedMs === null) return 'missing'
    const age = nowMs - observedMs
    if (age > EXECUTIVE_LIMITS.staleEvidenceMs) return 'stale'
    return 'fresh'
  })

  if (states.includes('stale')) return 'stale'
  if (states.includes('fresh')) return 'fresh'
  return 'missing'
}

/**
 * Detect conflicted evidence.
 *
 * Multiple sources disagree; both are preserved.
 */
export function detectConflictedEvidence(evidence: readonly Evidence[]): Evidence[] {
  return evidence.filter((e) => e.state === 'conflicted')
}

/**
 * Use conservative interpretation for conflicts.
 *
 * When evidence is conflicted, the more conservative interpretation is used.
 * This means: lower confidence, more assumptions, more verification steps.
 */
export function conservativeInterpretation(evidence: readonly Evidence[]): ConfidenceLevel {
  const conflicted = detectConflictedEvidence(evidence)
  if (conflicted.length > 0) return 'low'
  const states = evidence.map((e) => e.state)
  if (states.includes('stale')) return 'medium'
  if (states.includes('fresh')) return 'high'
  return 'unknown'
}

/* ------------------------------------------------------------------ assumptions */

/**
 * Create an explicit assumption for a gap in knowledge.
 *
 * Assumptions are explicit, bounded and reversible. An assumption that
 * proves wrong is recorded as such; it is never silently discarded.
 */
export function createAssumption(
  statement: string,
  basis: string,
  confidence: ConfidenceLevel,
  now: string,
  reversible: boolean = true,
): PlanningAssumption {
  const nowMs = instantMs(now)
  const expiresMs = (nowMs ?? 0) + EXECUTIVE_LIMITS.staleEvidenceMs
  return {
    assumptionId: `assumption-${statement.slice(0, 32)}`,
    statement: statement.slice(0, EXECUTIVE_LIMITS.maxReasoningChars),
    confidence,
    source: basis,
    evidence: [],
    expiresAt: new Date(expiresMs).toISOString(),
    reversible,
  }
}

/**
 * Create assumptions for missing information.
 *
 * When the planner lacks information to make a decision, it creates
 * explicit assumptions rather than guessing silently.
 */
export function createAssumptionsForGaps(goal: PlanGoal, context: PlannerContext): PlanningAssumption[] {
  const assumptions: PlanningAssumption[] = []

  for (const cap of goal.requiredCapabilities) {
    if (!context.knownCapabilities.has(cap)) {
      assumptions.push(
        createAssumption(
          `Capability ${cap} is available`,
          'capability-gap',
          'low',
          context.now,
          true,
        ),
      )
    }
  }

  if (goal.deadlineAt === null) {
    assumptions.push(
      createAssumption(
        'No deadline is set; using default planning horizon',
        'deadline-gap',
        'medium',
        context.now,
        true,
      ),
    )
  }

  return assumptions.slice(0, EXECUTIVE_LIMITS.maxPlanAssumptions)
}

/* ------------------------------------------------------------------ planning */

/**
 * Create a planned step.
 *
 * A plan is a request, not an authority. It names a capability that must
 * exist, a verifier that must exist, and ceilings that may only be lowered.
 */
export function createPlannedStep(
  capability: string,
  verifier: string,
  order: number,
  reversible: boolean,
  requiresApproval: boolean = false,
): PlannedStep {
  return {
    stepId: `step-${capability}-${order}`,
    label: `Execute ${capability}`,
    capability,
    verifier,
    reversible,
    requiresApproval,
    maxAttempts: EXECUTIVE_LIMITS.maxRetryAttempts,
    maxDurationMs: EXECUTIVE_LIMITS.maxWaitMs,
  }
}

/**
 * Mark a decision as reversible or irreversible.
 *
 * Irreversible decisions require owner approval.
 */
export function markReversibility(step: PlannedStep, goalReversible: boolean): PlannedStep {
  return {
    ...step,
    reversible: step.reversible && goalReversible,
    requiresApproval: step.requiresApproval || !goalReversible,
  }
}

/**
 * Produce a plan for a goal.
 *
 * The plan is bounded: it has a maximum number of steps, a deadline, and
 * an explicit reversibility marker. A plan that cannot be executed honestly
 * is reported as such, not padded.
 */
export function planForGoal(goal: PlanGoal, context: PlannerContext): Plan {
  const confidence = conservativeInterpretation(context.evidence)
  const assumptions = createAssumptionsForGaps(goal, context)

  const steps: PlannedStep[] = goal.requiredCapabilities
    .slice(0, EXECUTIVE_LIMITS.maxPlanSteps)
    .map((cap, i) => {
      const step = createPlannedStep(cap, `verify-${cap}`, i, goal.reversible)
      return markReversibility(step, goal.reversible)
    })

  const nowMs = instantMs(context.now)
  const deadlineMs = goal.deadlineAt !== null
    ? instantMs(goal.deadlineAt) ?? (nowMs ?? 0) + EXECUTIVE_LIMITS.maxWaitMs
    : (nowMs ?? 0) + EXECUTIVE_LIMITS.maxWaitMs

  return {
    planId: `plan-${goal.goalId}`,
    goalRef: goal.goalId,
    steps,
    assumptions,
    confidence,
    reversible: goal.reversible,
    createdAt: context.now,
    deadlineAt: new Date(deadlineMs).toISOString(),
  }
}

/**
 * Produce bounded next actions from a plan.
 *
 * Every action is bounded: it has a maximum duration, a maximum number of
 * attempts, and a deadline.
 */
export function produceBoundedActions(plan: Plan): PlannedStep[] {
  return plan.steps.map((step) => ({
    ...step,
    maxAttempts: Math.min(step.maxAttempts, EXECUTIVE_LIMITS.maxRetryAttempts),
    maxDurationMs: Math.min(step.maxDurationMs, EXECUTIVE_LIMITS.maxWaitMs),
  }))
}

/**
 * Plan for multiple goals.
 *
 * Deterministic: same inputs + same clock = same plans.
 */
export function plan(context: PlannerContext): readonly Plan[] {
  return context.goals.map((goal) => planForGoal(goal, context))
}
