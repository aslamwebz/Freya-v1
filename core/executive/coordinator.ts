/**
 * THE COORDINATOR — bounded Workforce scheduling.
 *
 * Pure functions only: no I/O, no clock read (injected `now`), no model, no
 * randomness. Same inputs + same clock = same decision.
 *
 * The coordinator schedules bounded Workforce assignments while preserving
 * every authority boundary. It does not create authority, does not bypass
 * Guard, does not override Governor, does not clear STOP ALL, does not
 * exceed budgets, and does not approve its own requests.
 *
 * A coordination failure is a refusal, not a warning. There is no
 * "proceed anyway" branch.
 */

import {
  EXECUTIVE_LIMITS,
  instantMs,
  type CoordinationDecision,
  type Delegation,
  type DelegationRecord,
} from './types'

/* ------------------------------------------------------------------ inputs */

/** A worker available for coordination. */
export interface WorkerInfo {
  readonly workerId: string
  readonly status: 'idle' | 'working' | 'blocked' | 'stopped' | 'retired'
  readonly capabilities: readonly string[]
  readonly specialisation: string
  readonly maxOpenAssignments: number
  readonly currentOpenAssignments: number
  readonly remainingBudget: number
}

/** A work item to coordinate. */
export interface CoordinationItem {
  readonly itemId: string
  readonly requiredCapabilities: readonly string[]
  readonly requiredBudget: number
  readonly priority: number
  readonly missionId: string | null
  readonly runId: string | null
}

/** The coordination context. */
export interface CoordinatorContext {
  readonly now: string
  readonly items: readonly CoordinationItem[]
  readonly workers: readonly WorkerInfo[]
  readonly activeDelegations: readonly DelegationRecord[]
  readonly stopAllActive: boolean
  readonly budgetRemaining: number
  readonly pendingApprovals: ReadonlySet<string>
  readonly maxConcurrentAssignments: number
}

/* ------------------------------------------------------------------ decisions */

/** The result of a coordination decision. */
export interface CoordinationResult {
  readonly decision: CoordinationDecision
  readonly itemId: string
  readonly workerId: string | null
  readonly delegation: Delegation | null
  readonly reasoning: readonly string[]
  readonly blockedReason: string | null
}

/**
 * Check if a worker is eligible for assignment.
 *
 * Filters: status must be idle, must hold required capabilities,
 * must have remaining budget, must not exceed concurrency ceiling.
 */
export function isWorkerEligible(
  worker: WorkerInfo,
  item: CoordinationItem,
  _context: CoordinatorContext,
): boolean {
  if (worker.status !== 'idle') return false
  if (worker.currentOpenAssignments >= worker.maxOpenAssignments) return false
  if (worker.remainingBudget < item.requiredBudget) return false
  for (const cap of item.requiredCapabilities) {
    if (!worker.capabilities.includes(cap)) return false
  }
  return true
}

/**
 * Sort eligible workers by load balancing.
 *
 * 1. Fewest active assignments
 * 2. Most remaining budget
 * 3. Lexicographic worker id (deterministic tiebreaker)
 */
export function sortWorkersByPreference(workers: readonly WorkerInfo[]): WorkerInfo[] {
  return [...workers].sort((a, b) => {
    if (a.currentOpenAssignments !== b.currentOpenAssignments) {
      return a.currentOpenAssignments - b.currentOpenAssignments
    }
    if (a.remainingBudget !== b.remainingBudget) {
      return b.remainingBudget - a.remainingBudget
    }
    return a.workerId < b.workerId ? -1 : a.workerId > b.workerId ? 1 : 0
  })
}

/**
 * Check if preemption is needed.
 *
 * Preemption only occurs when a P0 item is ready and no idle worker exists.
 * The preempted delegation is paused, not cancelled.
 */
export function shouldPreempt(item: CoordinationItem, context: CoordinatorContext): boolean {
  if (item.priority < 0.9) return false
  const idleWorkers = context.workers.filter((w) => w.status === 'idle')
  const busyWorkers = context.workers.filter((w) => w.status === 'working')
  return idleWorkers.length === 0 && busyWorkers.length > 0
}

/**
 * Compute a deterministic pseudo-jitter in `[0, jitterMs)` from the attempt.
 *
 * Determinism matters more than unpredictability here: the retry delay must be
 * reproducible so a restart reconciles the same schedule. There is no
 * randomness anywhere in Phase 24.
 */
function deterministicJitter(attempt: number): number {
  const x = Math.sin(attempt) * 10_000
  const frac = x - Math.floor(x)
  return Math.floor(frac * EXECUTIVE_LIMITS.jitterMs)
}

/**
 * Compute the next retry delay with exponential backoff.
 *
 * Base backoff: 1 second. Maximum backoff: 5 minutes. Jitter: deterministic,
 * bounded by `jitterMs`. Same attempt = same delay.
 */
export function computeBackoff(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt))
  const exponential = EXECUTIVE_LIMITS.baseBackoffMs * Math.pow(2, n - 1)
  const withJitter = exponential + deterministicJitter(n)
  return Math.min(withJitter, EXECUTIVE_LIMITS.maxBackoffMs)
}

/**
 * Check if retry ceiling is exceeded.
 */
export function isRetryCeilingExceeded(attempt: number): boolean {
  return attempt >= EXECUTIVE_LIMITS.maxRetryAttempts
}

/**
 * Make a coordination decision for a single item.
 *
 * Deterministic: same inputs + same clock = same decision.
 * A coordination failure is a refusal, not a warning.
 */
export function coordinateItem(item: CoordinationItem, context: CoordinatorContext): CoordinationResult {
  if (context.stopAllActive) {
    return {
      decision: 'stop',
      itemId: item.itemId,
      workerId: null,
      delegation: null,
      reasoning: ['stop-all-active'],
      blockedReason: 'STOP ALL is active',
    }
  }

  if (context.budgetRemaining < item.requiredBudget) {
    return {
      decision: 'escalate',
      itemId: item.itemId,
      workerId: null,
      delegation: null,
      reasoning: ['budget-exhausted'],
      blockedReason: 'Insufficient budget remaining',
    }
  }

  const eligibleWorkers = context.workers.filter((w) => isWorkerEligible(w, item, context))

  if (eligibleWorkers.length === 0) {
    if (shouldPreempt(item, context)) {
      return {
        decision: 'wait',
        itemId: item.itemId,
        workerId: null,
        delegation: null,
        reasoning: ['preemption-required'],
        blockedReason: 'No idle worker available; preemption required',
      }
    }
    return {
      decision: 'wait',
      itemId: item.itemId,
      workerId: null,
      delegation: null,
      reasoning: ['no-eligible-worker'],
      blockedReason: 'No eligible worker available',
    }
  }

  const sorted = sortWorkersByPreference(eligibleWorkers)
  const selected = sorted[0]

  if (selected === undefined) {
    return {
      decision: 'escalate',
      itemId: item.itemId,
      workerId: null,
      delegation: null,
      reasoning: ['no-worker-selected'],
      blockedReason: 'No worker could be selected',
    }
  }

  const nowMs = instantMs(context.now)
  const deadlineMs = (nowMs ?? 0) + EXECUTIVE_LIMITS.maxWaitMs

  const delegation: Delegation = {
    delegationId: `delegation-${item.itemId}-${context.now}`,
    workerId: selected.workerId,
    capabilities: item.requiredCapabilities,
    contextRefs: [],
    maxActions: 1,
    maxDurationMs: EXECUTIVE_LIMITS.maxWaitMs,
    deadlineAt: new Date(deadlineMs).toISOString(),
    missionId: item.missionId,
  }

  return {
    decision: 'proceed',
    itemId: item.itemId,
    workerId: selected.workerId,
    delegation,
    reasoning: ['worker-selected'],
    blockedReason: null,
  }
}

/**
 * Coordinate multiple items.
 *
 * Items are processed in priority order (highest first).
 * Deterministic: same inputs + same clock = same decisions.
 */
export function coordinate(context: CoordinatorContext): readonly CoordinationResult[] {
  const sortedItems = [...context.items].sort((a, b) => b.priority - a.priority)
  return sortedItems.map((item) => coordinateItem(item, context))
}

/**
 * Check if a wait deadline has expired.
 */
export function isWaitDeadlineExpired(waitStartedAt: string, now: string): boolean {
  const startMs = instantMs(waitStartedAt)
  const nowMs = instantMs(now)
  if (startMs === null || nowMs === null) return false
  return nowMs - startMs > EXECUTIVE_LIMITS.maxWaitMs
}

/**
 * Escalate an item to the owner.
 *
 * Escalation does not grant authority, does not bypass approval, does not
 * create new capabilities, and is always visible to the owner.
 */
export function escalate(item: CoordinationItem, reason: string): CoordinationResult {
  return {
    decision: 'escalate',
    itemId: item.itemId,
    workerId: null,
    delegation: null,
    reasoning: ['escalated-to-owner'],
    blockedReason: reason,
  }
}
