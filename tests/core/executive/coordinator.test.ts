// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  isWorkerEligible,
  sortWorkersByPreference,
  shouldPreempt,
  computeBackoff,
  isRetryCeilingExceeded,
  coordinateItem,
  coordinate,
  isWaitDeadlineExpired,
  escalate,
  instantMs,
  type WorkerInfo,
  type CoordinationItem,
  type CoordinatorContext,
  type DelegationRecord,
} from '../../../core/executive'

const NOW = '2026-10-01T12:00:00.000Z'

function makeWorker(over: Partial<WorkerInfo> = {}): WorkerInfo {
  return {
    workerId: 'worker-1',
    status: 'idle',
    capabilities: ['cap-1'],
    specialisation: 'general',
    maxOpenAssignments: 3,
    currentOpenAssignments: 0,
    remainingBudget: 100,
    ...over,
  }
}

function makeItem(over: Partial<CoordinationItem> = {}): CoordinationItem {
  return {
    itemId: 'item-1',
    requiredCapabilities: ['cap-1'],
    requiredBudget: 10,
    priority: 0.5,
    missionId: null,
    runId: null,
    requiresApproval: false,
    approvalId: null,
    allowedSpecialisations: [],
    ...over,
  }
}

function makeContext(over: Partial<CoordinatorContext> = {}): CoordinatorContext {
  return {
    now: NOW,
    items: [],
    workers: [],
    activeDelegations: [],
    stopAllActive: false,
    budgetRemaining: 1000,
    pendingApprovals: new Set(),
    maxConcurrentAssignments: 8,
    guardCleared: true,
    governorAuthorized: true,
    ...over,
  }
}

function makeDelegationRecord(delegationId: string, workerId: string): DelegationRecord {
  return {
    delegationId,
    workerId,
    missionId: null,
    runId: null,
    status: 'active',
    assignedAt: NOW,
    deadlineAt: NOW,
    capabilities: ['cap-1'],
    contextRefs: [],
  }
}

describe('isWorkerEligible', () => {
  it('returns true for idle worker with required capabilities', () => {
    expect(isWorkerEligible(makeWorker(), makeItem(), makeContext())).toBe(true)
  })

  it('returns false for non-idle worker', () => {
    expect(isWorkerEligible(makeWorker({ status: 'working' }), makeItem(), makeContext())).toBe(false)
  })

  it('returns false for blocked, stopped and retired workers', () => {
    for (const status of ['blocked', 'stopped', 'retired'] as const) {
      expect(isWorkerEligible(makeWorker({ status }), makeItem(), makeContext())).toBe(false)
    }
  })

  it('returns false when worker lacks a required capability', () => {
    const worker = makeWorker({ capabilities: ['cap-2'] })
    const item = makeItem({ requiredCapabilities: ['cap-1'] })
    expect(isWorkerEligible(worker, item, makeContext())).toBe(false)
  })

  it('returns true when worker holds all required capabilities', () => {
    const worker = makeWorker({ capabilities: ['cap-1', 'cap-2'] })
    const item = makeItem({ requiredCapabilities: ['cap-1', 'cap-2'] })
    expect(isWorkerEligible(worker, item, makeContext())).toBe(true)
  })

  it('returns false when worker has insufficient budget', () => {
    const worker = makeWorker({ remainingBudget: 5 })
    const item = makeItem({ requiredBudget: 10 })
    expect(isWorkerEligible(worker, item, makeContext())).toBe(false)
  })

  it('returns true when worker has exactly enough budget', () => {
    const worker = makeWorker({ remainingBudget: 10 })
    const item = makeItem({ requiredBudget: 10 })
    expect(isWorkerEligible(worker, item, makeContext())).toBe(true)
  })

  it('returns false when worker is at the concurrency ceiling', () => {
    const worker = makeWorker({ currentOpenAssignments: 3, maxOpenAssignments: 3 })
    expect(isWorkerEligible(worker, makeItem(), makeContext())).toBe(false)
  })

  it('returns true when worker is one below the concurrency ceiling', () => {
    const worker = makeWorker({ currentOpenAssignments: 2, maxOpenAssignments: 3 })
    expect(isWorkerEligible(worker, makeItem(), makeContext())).toBe(true)
  })
})

describe('sortWorkersByPreference', () => {
  it('sorts by fewest active assignments first', () => {
    const w1 = makeWorker({ workerId: 'w1', currentOpenAssignments: 2 })
    const w2 = makeWorker({ workerId: 'w2', currentOpenAssignments: 1 })
    expect(sortWorkersByPreference([w1, w2])[0]?.workerId).toBe('w2')
  })

  it('breaks ties by most remaining budget', () => {
    const w1 = makeWorker({ workerId: 'w1', remainingBudget: 50 })
    const w2 = makeWorker({ workerId: 'w2', remainingBudget: 100 })
    expect(sortWorkersByPreference([w1, w2])[0]?.workerId).toBe('w2')
  })

  it('breaks ties by lexicographic worker id', () => {
    const w1 = makeWorker({ workerId: 'b' })
    const w2 = makeWorker({ workerId: 'a' })
    expect(sortWorkersByPreference([w1, w2])[0]?.workerId).toBe('a')
  })

  it('is deterministic and does not mutate input', () => {
    const w1 = makeWorker({ workerId: 'w1' })
    const w2 = makeWorker({ workerId: 'w2' })
    const input = [w1, w2]
    const a = sortWorkersByPreference(input)
    const b = sortWorkersByPreference(input)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(input[0]?.workerId).toBe('w1')
  })

  it('handles empty and single-element inputs', () => {
    expect(sortWorkersByPreference([])).toEqual([])
    const only = makeWorker({ workerId: 'only' })
    expect(sortWorkersByPreference([only]).length).toBe(1)
  })
})

describe('shouldPreempt', () => {
  it('returns true for a P0 item when only busy workers exist', () => {
    const context = makeContext({ workers: [makeWorker({ status: 'working' })] })
    expect(shouldPreempt(makeItem({ priority: 0.95 }), context)).toBe(true)
  })

  it('returns false for a non-P0 item', () => {
    const context = makeContext({ workers: [makeWorker({ status: 'working' })] })
    expect(shouldPreempt(makeItem({ priority: 0.5 }), context)).toBe(false)
  })

  it('returns false for a P0 item when an idle worker exists', () => {
    const context = makeContext({ workers: [makeWorker({ status: 'idle' })] })
    expect(shouldPreempt(makeItem({ priority: 0.95 }), context)).toBe(false)
  })

  it('returns false when no workers exist at all', () => {
    expect(shouldPreempt(makeItem({ priority: 0.95 }), makeContext({ workers: [] }))).toBe(false)
  })

  it('returns false when no worker is currently running anything', () => {
    const context = makeContext({ workers: [makeWorker({ status: 'blocked' })] })
    expect(shouldPreempt(makeItem({ priority: 0.95 }), context)).toBe(false)
  })

  it('returns true for a P0 item when one worker is busy among idle-less peers', () => {
    const context = makeContext({
      workers: [makeWorker({ status: 'blocked' }), makeWorker({ status: 'working' })],
    })
    expect(shouldPreempt(makeItem({ priority: 0.95 }), context)).toBe(true)
  })
})

describe('computeBackoff', () => {
  it('returns a positive backoff', () => {
    expect(computeBackoff(1)).toBeGreaterThan(0)
  })

  it('is deterministic for the same attempt', () => {
    expect(computeBackoff(3)).toBe(computeBackoff(3))
  })

  it('grows with attempt number', () => {
    expect(computeBackoff(2)).toBeGreaterThanOrEqual(computeBackoff(1))
    expect(computeBackoff(3)).toBeGreaterThanOrEqual(computeBackoff(2))
  })

  it('never exceeds the max backoff', () => {
    for (const attempt of [1, 5, 10, 100, 1000]) {
      expect(computeBackoff(attempt)).toBeLessThanOrEqual(5 * 60 * 1000)
    }
  })

  it('clamps very large attempt numbers to the ceiling', () => {
    expect(computeBackoff(50)).toBe(5 * 60 * 1000)
  })
})

describe('isRetryCeilingExceeded', () => {
  it('returns false below the ceiling', () => {
    expect(isRetryCeilingExceeded(0)).toBe(false)
    expect(isRetryCeilingExceeded(1)).toBe(false)
    expect(isRetryCeilingExceeded(2)).toBe(false)
  })

  it('returns true at or above the ceiling', () => {
    expect(isRetryCeilingExceeded(3)).toBe(true)
    expect(isRetryCeilingExceeded(4)).toBe(true)
    expect(isRetryCeilingExceeded(100)).toBe(true)
  })
})

describe('coordinateItem', () => {
  it('returns stop when STOP ALL is active', () => {
    const context = makeContext({ stopAllActive: true, workers: [makeWorker()] })
    const result = coordinateItem(makeItem(), context)
    expect(result.decision).toBe('stop')
    expect(result.delegation).toBeNull()
  })

  it('returns escalate when the budget is exhausted', () => {
    const context = makeContext({ budgetRemaining: 50 })
    const result = coordinateItem(makeItem({ requiredBudget: 100 }), context)
    expect(result.decision).toBe('escalate')
    expect(result.delegation).toBeNull()
  })

  it('returns wait when no eligible worker exists', () => {
    const context = makeContext({ workers: [makeWorker({ status: 'working' })] })
    const result = coordinateItem(makeItem(), context)
    expect(result.decision).toBe('wait')
    expect(result.delegation).toBeNull()
  })

  it('reports preemption-required for a P0 item with only busy workers', () => {
    const context = makeContext({ workers: [makeWorker({ status: 'working' })] })
    const result = coordinateItem(makeItem({ priority: 0.95 }), context)
    expect(result.decision).toBe('wait')
    expect(result.reasoning).toContain('preemption-required')
  })

  it('returns proceed with a bounded delegation when a worker is eligible', () => {
    const context = makeContext({ workers: [makeWorker()] })
    const result = coordinateItem(makeItem(), context)
    expect(result.decision).toBe('proceed')
    expect(result.workerId).toBe('worker-1')
    expect(result.delegation).not.toBeNull()
    expect(result.delegation?.maxActions).toBe(1)
    expect(result.delegation?.maxDurationMs).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1000)
  })

  it('never creates a delegation for a refused item', () => {
    const cases: CoordinatorContext[] = [
      makeContext({ stopAllActive: true, workers: [makeWorker()] }),
      makeContext({ budgetRemaining: 0 }),
      makeContext({ workers: [makeWorker({ capabilities: ['cap-2'] })] }),
      makeContext({ workers: [makeWorker({ remainingBudget: 1 })] }),
      makeContext({ workers: [makeWorker({ currentOpenAssignments: 3, maxOpenAssignments: 3 })] }),
      makeContext({ workers: [makeWorker({ status: 'blocked' })] }),
    ]
    for (const context of cases) {
      expect(coordinateItem(makeItem(), context).delegation).toBeNull()
    }
  })
})

describe('coordinate', () => {
  it('processes items in priority order', () => {
    const low = makeItem({ itemId: 'low', priority: 0.3 })
    const high = makeItem({ itemId: 'high', priority: 0.9 })
    const context = makeContext({ items: [low, high], workers: [makeWorker()] })
    const results = coordinate(context)
    expect(results.length).toBe(2)
    expect(results[0]?.itemId).toBe('high')
  })

  it('is deterministic', () => {
    const context = makeContext({
      items: [makeItem({ itemId: 'a' }), makeItem({ itemId: 'b', priority: 0.9 })],
      workers: [makeWorker()],
    })
    expect(JSON.stringify(coordinate(context))).toBe(JSON.stringify(coordinate(context)))
  })

  it('halts every item under STOP ALL', () => {
    const context = makeContext({
      items: [makeItem({ itemId: 'a' }), makeItem({ itemId: 'b' })],
      workers: [makeWorker()],
      stopAllActive: true,
    })
    expect(coordinate(context).every((r) => r.decision === 'stop')).toBe(true)
  })

  it('never exceeds the budget for any item', () => {
    const context = makeContext({
      items: [makeItem({ itemId: 'a', requiredBudget: 100 }), makeItem({ itemId: 'b', requiredBudget: 100 })],
      workers: [makeWorker()],
      budgetRemaining: 50,
    })
    const results = coordinate(context)
    expect(results.every((r) => r.decision === 'escalate' && r.delegation === null)).toBe(true)
  })
})

describe('isWaitDeadlineExpired', () => {
  it('returns false within the wait window', () => {
    const start = new Date(instantMs(NOW)! - 60 * 1000).toISOString()
    expect(isWaitDeadlineExpired(start, NOW)).toBe(false)
  })

  it('returns true beyond the wait window', () => {
    const start = new Date(instantMs(NOW)! - 31 * 24 * 60 * 60 * 1000).toISOString()
    expect(isWaitDeadlineExpired(start, NOW)).toBe(true)
  })

  it('returns true for future, equal or invalid instants', () => {
    const future = new Date(instantMs(NOW)! + 60 * 1000).toISOString()
    expect(isWaitDeadlineExpired(future, NOW)).toBe(false)
    expect(isWaitDeadlineExpired(NOW, NOW)).toBe(false)
    // A wait that cannot be measured must not become unbounded: a malformed
    // instant escalates rather than waiting forever.
    expect(isWaitDeadlineExpired('invalid', NOW)).toBe(true)
    expect(isWaitDeadlineExpired(NOW, 'invalid')).toBe(true)
  })
})

describe('escalate', () => {
  it('creates a visible escalation with no authority', () => {
    const result = escalate(makeItem(), 'test reason')
    expect(result.decision).toBe('escalate')
    expect(result.blockedReason).toBe('test reason')
    expect(result.delegation).toBeNull()
    expect(result.workerId).toBeNull()
  })
})

describe('authority preservation: proof-carrying preconditions', () => {
  it('refuses to delegate when Guard has not cleared', () => {
    const context = makeContext({ guardCleared: false, workers: [makeWorker()] })
    const result = coordinateItem(makeItem(), context)
    expect(result.decision).toBe('stop')
    expect(result.delegation).toBeNull()
    expect(result.reasoning).toContain('guard-not-cleared')
  })

  it('refuses to delegate when Governor has not authorized cognition', () => {
    const context = makeContext({ governorAuthorized: false, workers: [makeWorker()] })
    const result = coordinateItem(makeItem(), context)
    expect(result.decision).toBe('stop')
    expect(result.delegation).toBeNull()
    expect(result.reasoning).toContain('governor-not-authorized')
  })

  it('STOP ALL still outranks an uncleared Guard', () => {
    const context = makeContext({
      stopAllActive: true,
      guardCleared: false,
      workers: [makeWorker()],
    })
    expect(coordinateItem(makeItem(), context).reasoning).toContain('stop-all-active')
  })

  it('waits while a required approval is still pending', () => {
    const item = makeItem({ requiresApproval: true, approvalId: 'approval-1' })
    const context = makeContext({
      workers: [makeWorker()],
      pendingApprovals: new Set(['approval-1']),
    })
    const result = coordinateItem(item, context)
    expect(result.decision).toBe('wait')
    expect(result.delegation).toBeNull()
    expect(result.reasoning).toContain('approval-pending')
  })

  it('escalates when a required approval is not named', () => {
    const item = makeItem({ requiresApproval: true, approvalId: null })
    const context = makeContext({ workers: [makeWorker()] })
    const result = coordinateItem(item, context)
    expect(result.decision).toBe('escalate')
    expect(result.delegation).toBeNull()
    expect(result.reasoning).toContain('approval-id-missing')
  })

  it('proceeds once the required approval is no longer pending', () => {
    const item = makeItem({ requiresApproval: true, approvalId: 'approval-1' })
    const context = makeContext({ workers: [makeWorker()], pendingApprovals: new Set() })
    expect(coordinateItem(item, context).decision).toBe('proceed')
  })
})

describe('specialisation narrowing', () => {
  it('refuses a worker whose specialisation is not allowed', () => {
    const item = makeItem({ allowedSpecialisations: ['code'] })
    const context = makeContext({ workers: [makeWorker({ specialisation: 'research' })] })
    const result = coordinateItem(item, context)
    expect(result.decision).toBe('wait')
    expect(result.delegation).toBeNull()
  })

  it('accepts a worker whose specialisation is allowed', () => {
    const item = makeItem({ allowedSpecialisations: ['code', 'research'] })
    const context = makeContext({ workers: [makeWorker({ specialisation: 'research' })] })
    expect(coordinateItem(item, context).decision).toBe('proceed')
  })

  it('treats an empty allowed list as unrestricted', () => {
    const item = makeItem({ allowedSpecialisations: [] })
    const context = makeContext({ workers: [makeWorker({ specialisation: 'writing' })] })
    expect(coordinateItem(item, context).decision).toBe('proceed')
  })
})

describe('global concurrency ceiling', () => {
  it('waits when the global assignment ceiling is already reached', () => {
    const context = makeContext({
      workers: [makeWorker()],
      activeDelegations: [makeDelegationRecord('delegation-1', 'worker-9')],
      maxConcurrentAssignments: 1,
    })
    const result = coordinateItem(makeItem(), context)
    expect(result.decision).toBe('wait')
    expect(result.delegation).toBeNull()
    expect(result.reasoning).toContain('concurrency-ceiling-reached')
  })

  it('cannot be widened past the code-owned ceiling', () => {
    const active = Array.from({ length: 8 }, (_, i) =>
      makeDelegationRecord(`delegation-${i}`, `worker-${i}`),
    )
    const context = makeContext({
      workers: [makeWorker()],
      activeDelegations: active,
      maxConcurrentAssignments: 1_000_000,
    })
    expect(coordinateItem(makeItem(), context).decision).toBe('wait')
  })

  it('consumes the global ceiling across a batch', () => {
    const context = makeContext({
      items: [makeItem({ itemId: 'a', priority: 0.9 }), makeItem({ itemId: 'b', priority: 0.8 })],
      workers: [makeWorker()],
      maxConcurrentAssignments: 1,
    })
    const results = coordinate(context)
    expect(results[0]?.decision).toBe('proceed')
    expect(results[1]?.decision).toBe('wait')
    expect(results[1]?.reasoning).toContain('concurrency-ceiling-reached')
  })
})

describe('batch resource consumption', () => {
  it('does not over-allocate global budget across items', () => {
    const context = makeContext({
      items: [
        makeItem({ itemId: 'a', priority: 0.9, requiredBudget: 60 }),
        makeItem({ itemId: 'b', priority: 0.8, requiredBudget: 60 }),
      ],
      workers: [makeWorker({ remainingBudget: 1000 })],
      budgetRemaining: 100,
    })
    const results = coordinate(context)
    expect(results[0]?.decision).toBe('proceed')
    expect(results[1]?.decision).toBe('escalate')
  })

  it('does not over-allocate a worker budget across items', () => {
    const context = makeContext({
      items: [
        makeItem({ itemId: 'a', priority: 0.9, requiredBudget: 60 }),
        makeItem({ itemId: 'b', priority: 0.8, requiredBudget: 60 }),
      ],
      workers: [makeWorker({ remainingBudget: 100 })],
      budgetRemaining: 1000,
    })
    const results = coordinate(context)
    expect(results[0]?.decision).toBe('proceed')
    expect(results[1]?.decision).toBe('wait')
  })

  it('does not exceed a worker open-assignment ceiling across a batch', () => {
    const context = makeContext({
      items: [makeItem({ itemId: 'a', priority: 0.9 }), makeItem({ itemId: 'b', priority: 0.8 })],
      workers: [makeWorker({ maxOpenAssignments: 1 })],
      maxConcurrentAssignments: 8,
    })
    const results = coordinate(context)
    expect(results[0]?.decision).toBe('proceed')
    expect(results[1]?.decision).toBe('wait')
  })
})

describe('invalid injected clock', () => {
  it('escalates instead of minting a 1970 delegation deadline', () => {
    const context = makeContext({ now: 'not-an-instant', workers: [makeWorker()] })
    const result = coordinateItem(makeItem(), context)
    expect(result.decision).toBe('escalate')
    expect(result.delegation).toBeNull()
    expect(result.reasoning).toContain('invalid-clock')
  })

  it('produces no delegation with a fabricated epoch deadline', () => {
    const context = makeContext({ now: 'not-an-instant', workers: [makeWorker()] })
    expect(coordinate(context).every((r) => r.delegation === null)).toBe(true)
  })
})

describe('malformed input cannot widen authority or budget', () => {
  it('refuses a negative required budget rather than increasing the batch budget', () => {
    const item = makeItem({ requiredBudget: -1000 })
    const context = makeContext({ workers: [makeWorker()], budgetRemaining: 10 })
    const result = coordinateItem(item, context)
    expect(result.decision).toBe('stop')
    expect(result.delegation).toBeNull()
    expect(result.reasoning).toContain('invalid-required-budget')
  })

  it('does not let a negative budget item mint a delegation in a batch', () => {
    const context = makeContext({
      items: [makeItem({ itemId: 'a', requiredBudget: -1000 })],
      workers: [makeWorker()],
      budgetRemaining: 10,
    })
    expect(coordinate(context)[0]?.delegation).toBeNull()
  })

  it('treats a non-finite concurrency ceiling as zero, never unbounded', () => {
    const context = makeContext({
      workers: [makeWorker()],
      maxConcurrentAssignments: Number.NaN,
    })
    const result = coordinateItem(makeItem(), context)
    expect(result.decision).toBe('wait')
    expect(result.delegation).toBeNull()
    expect(result.reasoning).toContain('concurrency-ceiling-reached')
  })
})
