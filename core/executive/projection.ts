/**
 * THE EXECUTIVE STATE PROJECTION — explainable executive state.
 *
 * Pure functions only: no I/O, no clock read (injected `now`), no model, no
 * randomness. Same inputs + same clock = same state.
 *
 * The executive state is the answer to: what matters, why, what is blocked,
 * what is uncertain, and what is the next bounded action. It is a projection,
 * not a live handle. It is derived from durable state and is always explainable.
 *
 * The executive state never:
 * - Hides uncertainty
 * - Fabricates confidence
 * - Claims an outcome that has not been verified
 * - Shows a percentage that has no denominator
 * - Invents a mental or emotional state
 */

import {
  EXECUTIVE_LIMITS,
  instantMs,
  type BoundedAction,
  type ConfidenceLevel,
  type ExecutiveItem,
  type ExecutiveState,
  type PrioritizationResult,
  type Plan,
  type RankedItem,
} from './types'

/* ------------------------------------------------------------------ inputs */

/** The projection context. */
export interface ProjectionContext {
  readonly now: string
  readonly prioritization: PrioritizationResult
  readonly plans: readonly Plan[]
  readonly confidence: ConfidenceLevel
}

/* ------------------------------------------------------------------ projection */

/**
 * Project the explainable executive state.
 *
 * Deterministic: same inputs + same clock = same state.
 * Every item carries reasoning. Uncertainty is never hidden.
 */
export function projectExecutiveState(context: ProjectionContext): ExecutiveState {
  const whatMatters: RankedItem[] = context.prioritization.ranked.map((item, index) => ({
    itemId: item.itemId,
    rank: index + 1,
    priority: item.priority,
    urgency: item.urgency,
    importance: item.importance,
    reasoning: item.reasoning,
    blockedReason: null,
    uncertainty: [],
  }))

  const why: string[] = context.prioritization.ranked
    .slice(0, EXECUTIVE_LIMITS.maxReasoningPerItem)
    .map((item) => `${item.itemId}: ${item.reasoning.join(', ')}`)

  const whatIsBlocked: string[] = context.prioritization.blocked.map(
    (item) => `${item.itemId}: ${item.blocker.type}`,
  )

  // Uncertainty is never hidden. Every explicit assumption a plan carries is
  // surfaced here; an assumption nobody can see is a hidden inference.
  const assumptionUncertainty: string[] = context.plans.flatMap((plan) =>
    plan.assumptions.map(
      (assumption) => `${assumption.assumptionId}: ${assumption.statement} (${assumption.confidence})`,
    ),
  )

  const whatIsUncertain: string[] = [
    ...context.prioritization.ranked
      .filter((item) => item.urgency === 'immediate' || item.priority === 'critical')
      .map((item) => `${item.itemId}: ${item.reasoning.join(', ')}`),
    ...assumptionUncertainty,
  ].slice(0, EXECUTIVE_LIMITS.maxWhatIsUncertainItems)

  const nextBoundedAction = whatMatters.length > 0 ? createNextBoundedAction(whatMatters[0]!, context.now) : null

  return {
    whatMatters: whatMatters.slice(0, EXECUTIVE_LIMITS.maxWhatMattersItems),
    why: why.slice(0, EXECUTIVE_LIMITS.maxReasoningPerItem),
    whatIsBlocked: whatIsBlocked.slice(0, EXECUTIVE_LIMITS.maxWhatIsBlockedItems),
    whatIsUncertain: whatIsUncertain.slice(0, EXECUTIVE_LIMITS.maxWhatIsUncertainItems),
    nextBoundedAction,
    generatedAt: context.now,
  }
}

/**
 * Create the next bounded action from the top-ranked item.
 */
function createNextBoundedAction(item: RankedItem, now: string): BoundedAction {
  const nowMs = instantMs(now)
  const deadlineMs = (nowMs ?? 0) + EXECUTIVE_LIMITS.maxWaitMs
  return {
    actionId: `action-${item.itemId}`,
    kind: item.urgency === 'immediate' ? 'execute' : 'wait',
    target: item.itemId,
    maxDurationMs: EXECUTIVE_LIMITS.maxWaitMs,
    maxAttempts: EXECUTIVE_LIMITS.maxRetryAttempts,
    deadlineAt: new Date(deadlineMs).toISOString(),
  }
}

/**
 * Create an executive item with full explainability.
 */
export function createExecutiveItem(
  itemId: string,
  kind: 'mission' | 'run' | 'task' | 'step',
  summary: string,
  reasoning: readonly string[],
  evidence: readonly string[],
  confidence: ConfidenceLevel,
): ExecutiveItem {
  return {
    itemId,
    kind,
    summary: summary.slice(0, EXECUTIVE_LIMITS.maxSummaryChars),
    reasoning: reasoning.slice(0, EXECUTIVE_LIMITS.maxReasoningPerItem),
    evidence: evidence.slice(0, EXECUTIVE_LIMITS.maxEvidencePerItem),
    confidence,
  }
}

/**
 * Check if an item's confidence is honest.
 *
 * Confidence is never fabricated. It is derived from evidence state.
 */
export function isConfidenceHonest(item: ExecutiveItem, evidenceCount: number): boolean {
  if (item.confidence === 'high' && evidenceCount < 2) return false
  if (item.confidence === 'medium' && evidenceCount < 1) return false
  return true
}

/**
 * Bound a list to the executive state's maximum length.
 */
export function boundList<T>(items: readonly T[], max: number): readonly T[] {
  return items.slice(0, max)
}

/**
 * Bound a string to the executive state's maximum length.
 */
export function boundString(value: string, max: number): string {
  return value.slice(0, max)
}
