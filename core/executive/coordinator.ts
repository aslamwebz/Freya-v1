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
 * The domain never reaches a service. Authority is carried in as **proof**:
 * `guardCleared` and `governorAuthorized` are preconditions a caller may only
 * obtain from Guard and Governor, and `pendingApprovals` is the durable set of
 * approvals that have not been granted. A coordination failure is a refusal,
 * not a warning. There is no "proceed anyway" branch.
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
  /** Whether this item's action requires an owner approval before delegation. */
  readonly requiresApproval: boolean
  /** The approval this item depends on. Required when `requiresApproval` is true. */
  readonly approvalId: string | null
  /**
   * The worker specialisations this item may be assigned to. An empty list
   * means unrestricted. This is a *narrowing*: it can only remove workers.
   */
  readonly allowedSpecialisations: readonly string[]
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
  /**
   * Proof that Guard's capability check has cleared for this coordination pass.
   * The coordinator cannot call Guard; the caller must carry the proof in.
   */
  readonly guardCleared: boolean
  /**
   * Proof that Governor cognition authorization is available for this pass.
   * The coordinator cannot call Governor; the caller must carry the proof in.
   */
  readonly governorAuthorized: boolean
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

/** A refusal that mints nothing. */
function refuse(
  decision: CoordinationDecision,
  item: CoordinationItem,
  reasoning: string,
  blockedReason: string,
): CoordinationResult {
  return {
    decision,
    itemId: item.itemId,
    workerId: null,
    delegation: null,
    reasoning: [reasoning],
    blockedReason,
  }
}

/**
 * The effective global concurrency ceiling.
 *
 * A caller may narrow `maxConcurrentAssignments`, but it may never raise it
 * above the code-owned `EXECUTIVE_LIMITS.maxActiveDelegations`. A caller that
 * passes a wider number gets the ceiling, not the widening.
 */
function concurrencyCeiling(context: CoordinatorContext): number {
  const requested = Number.isFinite(context.maxConcurrentAssignments)
    ? context.maxConcurrentAssignments
    : 0
  return Math.max(0, Math.min(requested, EXECUTIVE_LIMITS.maxActiveDelegations))
}

/**
 * Check if a worker is eligible for assignment.
 *
 * Filters: status must be idle, must hold required capabilities, must satisfy
 * the item's specialisation narrowing, must have remaining budget, must not
 * exceed the per-worker concurrency ceiling.
 */
export function isWorkerEligible(
  worker: WorkerInfo,
  item: CoordinationItem,
  _context: CoordinatorContext,
): boolean {
  if (worker.status !== 'idle') return false
  if (worker.currentOpenAssignments >= worker.maxOpenAssignments) return false
  if (worker.remainingBudget < item.requiredBudget) return false
  if (
    item.allowedSpecialisations.length > 0 &&
    !item.allowedSpecialisations.includes(worker.specialisation)
  ) {
    return false
  }
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
 *
 * Precedence is absolute and ordered: STOP ALL, then Guard, then Governor,
 * then a valid injected clock, then budget, then approvals, then the global
 * concurrency ceiling, then worker eligibility. Nothing later may override
 * anything earlier.
 */
export function coordinateItem(item: CoordinationItem, context: CoordinatorContext): CoordinationResult {
  if (context.stopAllActive) {
    return refuse('stop', item, 'stop-all-active', 'STOP ALL is active')
  }

  if (!context.guardCleared) {
    return refuse('stop', item, 'guard-not-cleared', 'Guard capability check has not cleared')
  }

  if (!context.governorAuthorized) {
    return refuse(
      'stop',
      item,
      'governor-not-authorized',
      'Governor cognition authorization is unavailable',
    )
  }

  // An invalid injected clock must not silently become an epoch deadline. A
  // delegation built from `0` would carry a 1970 deadline, which is a lie.
  if (instantMs(context.now) === null) {
    return refuse('escalate', item, 'invalid-clock', 'The injected clock is not a valid instant')
  }

  // A negative or non-finite budget must never widen a budget: subtracting it
  // from the batch total would *increase* the remaining budget.
  if (!Number.isFinite(item.requiredBudget) || item.requiredBudget < 0) {
    return refuse(
      'stop',
      item,
      'invalid-required-budget',
      'The required budget is not a non-negative number',
    )
  }

  if (context.budgetRemaining < item.requiredBudget) {
    return refuse('escalate', item, 'budget-exhausted', 'Insufficient budget remaining')
  }

  if (item.requiresApproval) {
    if (item.approvalId === null) {
      return refuse(
        'escalate',
        item,
        'approval-id-missing',
        'This item requires an approval it does not name',
      )
    }
    if (context.pendingApprovals.has(item.approvalId)) {
      return refuse('wait', item, 'approval-pending', 'The required approval is still pending')
    }
  }

  const ceiling = concurrencyCeiling(context)
  if (context.activeDelegations.length >= ceiling) {
    return refuse(
      'wait',
      item,
      'concurrency-ceiling-reached',
      `The workforce already holds its ${ceiling} open assignments`,
    )
  }

  const eligibleWorkers = context.workers.filter((w) => isWorkerEligible(w, item, context))

  if (eligibleWorkers.length === 0) {
    if (shouldPreempt(item, context)) {
      return refuse(
        'wait',
        item,
        'preemption-required',
        'No idle worker available; preemption required',
      )
    }
    return refuse('wait', item, 'no-eligible-worker', 'No eligible worker available')
  }

  const sorted = sortWorkersByPreference(eligibleWorkers)
  const selected = sorted[0]

  if (selected === undefined) {
    return refuse('escalate', item, 'no-worker-selected', 'No worker could be selected')
  }

  const nowMs = instantMs(context.now)
  if (nowMs === null) {
    // Defensive: the guard above already refused this. Kept so the deadline can
    // never be derived from a fabricated epoch even if the order changes.
    return refuse('escalate', item, 'invalid-clock', 'The injected clock is not a valid instant')
  }
  const deadlineMs = nowMs + EXECUTIVE_LIMITS.maxWaitMs

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
 * Items are processed in priority order (highest first), ties broken by
 * lexicographic item id so the order is total and deterministic.
 *
 * The batch is simulated: a `proceed` consumes global budget, the selected
 * worker's remaining budget and open-assignment slot, and one global
 * concurrency slot before the next item is considered. Without this, two items
 * could each be told there is budget and a worker for work that only fits one.
 */
export function coordinate(context: CoordinatorContext): readonly CoordinationResult[] {
  const sortedItems = [...context.items].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority
    return a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0
  })

  let budgetRemaining = context.budgetRemaining
  const workers = context.workers.map((worker) => ({ ...worker }))
  const activeDelegations = [...context.activeDelegations]
  const results: CoordinationResult[] = []

  for (const item of sortedItems) {
    const stepContext: CoordinatorContext = {
      ...context,
      budgetRemaining,
      workers,
      activeDelegations,
    }
    const result = coordinateItem(item, stepContext)
    results.push(result)

    if (result.decision === 'proceed' && result.delegation !== null) {
      budgetRemaining -= item.requiredBudget

      const index = workers.findIndex((worker) => worker.workerId === result.workerId)
      const worker = index >= 0 ? workers[index] : undefined
      if (worker !== undefined) {
        workers[index] = {
          ...worker,
          currentOpenAssignments: worker.currentOpenAssignments + 1,
          remainingBudget: worker.remainingBudget - item.requiredBudget,
        }
      }

      activeDelegations.push({
        delegationId: result.delegation.delegationId,
        workerId: result.delegation.workerId,
        missionId: result.delegation.missionId,
        runId: item.runId,
        status: 'active',
        assignedAt: context.now,
        deadlineAt: result.delegation.deadlineAt,
        capabilities: result.delegation.capabilities,
        contextRefs: result.delegation.contextRefs,
      })
    }
  }

  return results
}

/**
 * Check if a wait deadline has expired.
 *
 * A wait that cannot be measured must not become an unbounded wait. If either
 * instant is malformed the wait is treated as expired so the item escalates to
 * the owner rather than waiting forever on a clock nobody can read.
 */
export function isWaitDeadlineExpired(waitStartedAt: string, now: string): boolean {
  const startMs = instantMs(waitStartedAt)
  const nowMs = instantMs(now)
  if (startMs === null || nowMs === null) return true
  return nowMs - startMs > EXECUTIVE_LIMITS.maxWaitMs
}

/**
 * Escalate an item to the owner.
 *
 * Escalation does not grant authority, does not bypass approval, does not
 * create new capabilities, and is always visible to the owner.
 */
export function escalate(item: CoordinationItem, reason: string): CoordinationResult {
  return refuse('escalate', item, 'escalated-to-owner', reason)
}
