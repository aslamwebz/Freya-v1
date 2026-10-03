/**
 * THE PRIORITIZER — deterministic ranking of competing work items.
 *
 * Pure functions only: no I/O, no clock read (injected `now`), no model, no
 * randomness. Same inputs + same clock = same ranking.
 *
 * Priority is derived from explicit signals: urgency (deadline proximity),
 * importance (owner-declared), dependency (graph position), and owner intent.
 * It is never taken from a payload field or model output.
 *
 * Priority does not grant authority. A high-priority item does not bypass
 * Guard, Governor, STOP ALL, budgets or approvals. It only influences ordering.
 */

import {
  EXECUTIVE_LIMITS,
  PRIORITY_REASONS,
  instantMs,
  type Blocker,
  type BlockedWorkItem,
  type BoundedAction,
  type ConfidenceLevel,
  type DeferredWorkItem,
  type Evidence,
  type EvidenceState,
  type ImportanceLevel,
  type PlanningAssumption,
  type PrioritizationResult,
  type PriorityAssessment,
  type PriorityReason,
  type PrioritySignal,
  type PriorityTier,
  type RankedWorkItem,
  type UrgencyLevel,
} from './types'

/* ------------------------------------------------------------------ inputs */

/** The kind of work item being prioritized. */
export type WorkItemKind = 'mission' | 'run' | 'task' | 'step'

/** Owner intent signals. Closed set. */
export const OWNER_INTENTS = ['none', 'priority', 'defer', 'block'] as const
export type OwnerIntent = (typeof OWNER_INTENTS)[number]

export function isOwnerIntent(value: unknown): value is OwnerIntent {
  return typeof value === 'string' && (OWNER_INTENTS as readonly string[]).includes(value)
}

/** A work item's metadata for prioritization. */
export interface WorkItemMetadata {
  readonly itemId: string
  readonly kind: WorkItemKind
  readonly createdAt: string
  readonly deadlineAt: string | null
  readonly ownerImportance: ImportanceLevel
  readonly ownerIntent: OwnerIntent
  readonly dependencies: readonly string[]
  readonly dependentCount: number
  readonly evidenceState: EvidenceState
  readonly confidence: ConfidenceLevel
  readonly verificationPending: boolean
  readonly approvalPending: boolean
  readonly budgetExhausted: boolean
  readonly stopAllActive: boolean
}

/** The prioritization context. */
export interface PrioritizerContext {
  readonly now: string
  readonly items: readonly WorkItemMetadata[]
  readonly evidence: readonly Evidence[]
  readonly activeItemIds: ReadonlySet<string>
}

/* ------------------------------------------------------------------ scoring */

/** Code-owned scoring weights. */
const WEIGHTS = Object.freeze({
  urgency: 0.35,
  importance: 0.3,
  dependency: 0.2,
  intent: 0.15,
})

/** Urgency level to rank mapping. */
const URGENCY_RANK: Readonly<Record<UrgencyLevel, number>> = Object.freeze({
  immediate: 1.0,
  soon: 0.75,
  normal: 0.5,
  later: 0.25,
  whenever: 0.0,
})

/** Importance level to rank mapping. */
const IMPORTANCE_RANK: Readonly<Record<ImportanceLevel, number>> = Object.freeze({
  critical: 1.0,
  high: 0.75,
  normal: 0.5,
  low: 0.25,
  trivial: 0.0,
})

/** Owner intent to rank mapping. */
const INTENT_RANK: Readonly<Record<OwnerIntent, number>> = Object.freeze({
  priority: 1.0,
  none: 0.5,
  defer: 0.0,
  block: 0.0,
})

/**
 * Compute urgency from deadline proximity.
 *
 * Deterministic: uses injected `now`, never `Date.now()`.
 * Returns `whenever` when no deadline is set.
 */
export function computeUrgency(deadlineAt: string | null, now: string): UrgencyLevel {
  if (deadlineAt === null) return 'whenever'
  const deadlineMs = instantMs(deadlineAt)
  const nowMs = instantMs(now)
  if (deadlineMs === null || nowMs === null) return 'normal'
  const remaining = deadlineMs - nowMs
  if (remaining <= 0) return 'immediate'
  if (remaining <= EXECUTIVE_LIMITS.urgentWindowMs) return 'immediate'
  if (remaining <= EXECUTIVE_LIMITS.elevatedWindowMs) return 'soon'
  if (remaining <= EXECUTIVE_LIMITS.normalWindowMs) return 'normal'
  return 'later'
}

/**
 * Compute dependency rank.
 *
 * Items with unmet dependencies are deprioritized (rank 0).
 * Items that unblock many downstream items are prioritized.
 */
export function computeDependencyRank(
  item: WorkItemMetadata,
  activeItemIds: ReadonlySet<string>,
): number {
  const unmet = item.dependencies.filter((dep) => activeItemIds.has(dep))
  if (unmet.length > 0) return 0.0
  if (item.dependentCount === 0) return 0.5
  return Math.min(1.0, 0.5 + item.dependentCount * 0.1)
}

/**
 * Compute the priority score for a work item.
 *
 * Score is bounded [0, 1]. Deterministic.
 */
export function computeScore(item: WorkItemMetadata, now: string, activeItemIds: ReadonlySet<string>): number {
  const urgency = computeUrgency(item.deadlineAt, now)
  const urgencyRank = URGENCY_RANK[urgency]
  const importanceRank = IMPORTANCE_RANK[item.ownerImportance]
  const dependencyRank = computeDependencyRank(item, activeItemIds)
  const intentRank = INTENT_RANK[item.ownerIntent]

  const raw =
    WEIGHTS.urgency * urgencyRank +
    WEIGHTS.importance * importanceRank +
    WEIGHTS.dependency * dependencyRank +
    WEIGHTS.intent * intentRank

  return Math.max(0, Math.min(1, raw))
}

/**
 * Map a score to a priority tier.
 */
export function scoreToTier(score: number): PriorityTier {
  if (score >= 0.9) return 'critical'
  if (score >= 0.7) return 'high'
  if (score >= 0.4) return 'normal'
  if (score >= 0.1) return 'low'
  return 'deferred'
}

/**
 * The dependencies of an item that are still unmet.
 *
 * A dependency is unmet only while the item it names is still active. A
 * dependency that has completed is met, and must not keep blocking its
 * dependents forever. `activeItemIds` is the set of ids still in flight.
 */
export function unmetDependencies(
  item: WorkItemMetadata,
  activeItemIds: ReadonlySet<string>,
): string[] {
  return item.dependencies.filter((dep) => activeItemIds.has(dep))
}

/**
 * Collect the signals that contributed to a priority assessment.
 */
export function collectSignals(
  item: WorkItemMetadata,
  now: string,
  activeItemIds: ReadonlySet<string>,
): PrioritySignal[] {
  const signals: PrioritySignal[] = []
  if (item.ownerIntent === 'priority') signals.push('owner-explicit')
  const urgency = computeUrgency(item.deadlineAt, now)
  if (urgency === 'immediate') signals.push('deadline-imminent')
  if (unmetDependencies(item, activeItemIds).length > 0) {
    signals.push('dependency-blocked')
  } else if (item.dependentCount > 0) {
    signals.push('dependency-ready')
  }
  if (item.verificationPending) signals.push('verification-pending')
  if (item.approvalPending) signals.push('approval-pending')
  if (item.budgetExhausted) signals.push('budget-exhausted')
  if (item.evidenceState === 'stale') signals.push('stale-evidence')
  if (item.evidenceState === 'conflicted') signals.push('conflicted-evidence')
  return signals
}

/**
 * Determine the priority reason code.
 */
export function determineReason(
  item: WorkItemMetadata,
  now: string,
  activeItemIds: ReadonlySet<string>,
): PriorityReason {
  if (item.ownerIntent === 'priority') return PRIORITY_REASONS.owner_override
  const urgency = computeUrgency(item.deadlineAt, now)
  if (urgency === 'immediate') return PRIORITY_REASONS.deadline_within_urgent_window
  if (urgency === 'soon') return PRIORITY_REASONS.deadline_within_elevated_window
  if (unmetDependencies(item, activeItemIds).length > 0) return PRIORITY_REASONS.hard_dependency_unmet
  if (item.dependentCount > 0) return PRIORITY_REASONS.hard_dependency_met
  if (item.verificationPending) return PRIORITY_REASONS.verification_overdue
  if (item.approvalPending) return PRIORITY_REASONS.approval_expired
  if (item.budgetExhausted) return PRIORITY_REASONS.budget_depleted
  if (item.evidenceState === 'stale') return PRIORITY_REASONS.evidence_stale
  if (item.evidenceState === 'conflicted') return PRIORITY_REASONS.evidence_conflicted
  return PRIORITY_REASONS.no_signals
}

/* ------------------------------------------------------------------ ranking */

/**
 * Assess a single work item's priority.
 */
export function assessItem(item: WorkItemMetadata, context: PrioritizerContext): PriorityAssessment {
  const signals = collectSignals(item, context.now, context.activeItemIds)
  const reason = determineReason(item, context.now, context.activeItemIds)
  const score = computeScore(item, context.now, context.activeItemIds)
  const tier = scoreToTier(score)
  return {
    itemId: item.itemId,
    tier,
    signals,
    reason,
    assessedAt: context.now,
  }
}

/**
 * Determine the blocker for a blocked item, if any.
 *
 * `activeItemIds` is the set of ids still in flight, so a dependency that has
 * completed is met. `now` is the injected clock: a deadline is expired when it
 * is at or before `now`, never when it is merely before creation.
 */
export function determineBlocker(
  item: WorkItemMetadata,
  activeItemIds: ReadonlySet<string> = new Set(),
  now: string = item.createdAt,
): Blocker | null {
  if (item.stopAllActive) return { type: 'stop-all' }
  if (item.budgetExhausted) return { type: 'budget-exhausted', grantId: 'unknown' }
  if (item.approvalPending) return { type: 'approval-pending', approvalId: 'unknown' }
  const unmet = unmetDependencies(item, activeItemIds)
  if (unmet.length > 0) return { type: 'dependency-unmet', dependsOn: unmet }
  if (item.evidenceState === 'conflicted') return { type: 'conflicted-evidence' }
  if (item.deadlineAt !== null) {
    const deadlineMs = instantMs(item.deadlineAt)
    const nowMs = instantMs(now)
    if (deadlineMs !== null && nowMs !== null && deadlineMs <= nowMs) {
      return { type: 'deadline-expired', deadlineAt: item.deadlineAt }
    }
  }
  return null
}

/**
 * Create a bounded action for a ranked work item.
 */
export function createBoundedAction(item: WorkItemMetadata, now: string): BoundedAction {
  const urgency = computeUrgency(item.deadlineAt, now)
  const baseDeadline =
    item.deadlineAt ??
    new Date((instantMs(now) ?? 0) + EXECUTIVE_LIMITS.maxWaitMs).toISOString()
  return {
    actionId: `action-${item.itemId}`,
    kind: urgency === 'immediate' ? 'execute' : 'wait',
    target: item.itemId,
    maxDurationMs: EXECUTIVE_LIMITS.maxWaitMs,
    maxAttempts: EXECUTIVE_LIMITS.maxRetryAttempts,
    deadlineAt: baseDeadline,
  }
}

/**
 * Prioritize a set of work items.
 *
 * Deterministic: same inputs + same clock = same ranking.
 * Items are sorted by score descending. Ties are broken by:
 * 1. Earlier `createdAt`
 * 2. Lexicographic `itemId`
 */
export function prioritize(context: PrioritizerContext): PrioritizationResult {
  const now = context.now
  const activeIds = context.activeItemIds

  const ranked: RankedWorkItem[] = []
  const blocked: BlockedWorkItem[] = []
  const deferred: DeferredWorkItem[] = []
  const assumptions: PlanningAssumption[] = []

  for (const item of context.items) {
    if (item.ownerIntent === 'block') {
      deferred.push({
        itemId: item.itemId,
        kind: item.kind,
        reason: 'owner-block',
        deferUntil: null,
      })
      continue
    }

    const blocker = determineBlocker(item, activeIds, now)
    if (blocker !== null) {
      blocked.push({
        itemId: item.itemId,
        kind: item.kind,
        blocker,
        reasoning: [determineReason(item, now, activeIds)],
      })
      continue
    }

    const score = computeScore(item, now, activeIds)
    const tier = scoreToTier(score)
    const urgency = computeUrgency(item.deadlineAt, now)
    const reason = determineReason(item, now, activeIds)

    if (item.ownerIntent === 'defer') {
      deferred.push({
        itemId: item.itemId,
        kind: item.kind,
        reason: 'owner-defer',
        deferUntil: null,
      })
      continue
    }

    ranked.push({
      itemId: item.itemId,
      kind: item.kind,
      priority: tier,
      urgency,
      importance: item.ownerImportance,
      score,
      reasoning: [reason],
      nextBoundedAction: createBoundedAction(item, now),
    })
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const aItem = context.items.find((i) => i.itemId === a.itemId)
    const bItem = context.items.find((i) => i.itemId === b.itemId)
    if (aItem && bItem && aItem.createdAt !== bItem.createdAt) {
      return aItem.createdAt < bItem.createdAt ? -1 : 1
    }
    return a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0
  })

  const boundedRanked = ranked.slice(0, EXECUTIVE_LIMITS.maxPrioritizationItems)

  return {
    ranked: boundedRanked,
    blocked,
    deferred,
    assumptions,
    generatedAt: now,
  }
}
