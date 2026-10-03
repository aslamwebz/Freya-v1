// @vitest-environment node
import { describe, expect, it } from 'vitest'
import * as executive from '../../core/executive'
import {
  coordinateItem,
  computeUrgency,
  computeScore,
  determineBlocker,
  collectSignals,
  escalate,
  isWorkerEligible,
  prioritize,
  projectExecutiveState,
  type CoordinationItem,
  type CoordinatorContext,
  type PrioritizerContext,
  type ProjectionContext,
  type WorkerInfo,
  type WorkItemMetadata,
} from '../../core/executive'

/**
 * Attack family: the executive layer cannot be tricked into authority.
 *
 * Phase 24 is pure planning and coordination. These attacks try to make a
 * prioritizer, planner or coordinator mint authority from a claim. The
 * invariant under attack:
 *
 *   > Planning is not authority. Coordination is not sovereignty.
 *   > Confidence is not permission.
 *
 * Every refusal is structural: the executive vocabulary has no `grant`, no
 * `approve`, no `bypass` and no `spend`. Priority and confidence only ever
 * change ordering, never permission.
 */

const NOW = '2026-10-01T12:00:00.000Z'

function item(over: Partial<WorkItemMetadata> = {}): WorkItemMetadata {
  return {
    itemId: 'item-1',
    kind: 'run',
    createdAt: NOW,
    deadlineAt: null,
    ownerImportance: 'normal',
    ownerIntent: 'none',
    dependencies: [],
    dependentCount: 0,
    evidenceState: 'fresh',
    confidence: 'high',
    verificationPending: false,
    approvalPending: false,
    budgetExhausted: false,
    stopAllActive: false,
    ...over,
  }
}

function prioContext(items: readonly WorkItemMetadata[]): PrioritizerContext {
  return { now: NOW, items, evidence: [], activeItemIds: new Set() }
}

function worker(over: Partial<WorkerInfo> = {}): WorkerInfo {
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

function coordItem(over: Partial<CoordinationItem> = {}): CoordinationItem {
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

function coordContext(over: Partial<CoordinatorContext> = {}): CoordinatorContext {
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

describe('redteam: model output is data, not authority', () => {
  it('model-claimed urgency cannot move the deterministic urgency ladder', () => {
    // Urgency is a function of (deadline, now) only. A payload claiming
    // "urgent" has nowhere to enter, because no field carries it.
    expect(computeUrgency(null, NOW)).toBe('whenever')
    const far = new Date(Date.parse(NOW) + 30 * 24 * 60 * 60 * 1000).toISOString()
    expect(computeUrgency(far, NOW)).toBe('later')
  })

  it('model-claimed priority cannot outrank owner-declared importance', () => {
    // A "claimed" priority has no vocabulary. Importance is owner-declared
    // and scored; a run with no signals cannot reach critical.
    const claimed = item({ itemId: 'claimed', ownerImportance: 'trivial', ownerIntent: 'none' })
    const owner = item({ itemId: 'owner', ownerImportance: 'critical', ownerIntent: 'priority' })
    expect(computeScore(claimed, NOW, new Set())).toBeLessThan(computeScore(owner, NOW, new Set()))
  })

  it('model-claimed outcome cannot create evidence state', () => {
    // Evidence state comes from the Evidence records, never from a claim.
    const signals = collectSignals(item({ evidenceState: 'fresh' }), NOW, new Set())
    expect(signals).not.toContain('conflicted-evidence')
    expect(signals).not.toContain('stale-evidence')
  })

  it('model output never reaches a provider from the executive layer', () => {
    // Structural: the executive domain is pure. No provider, no clock, no
    // randomness. This is asserted by the deterministic unit tests too.
    const context = prioContext([item()])
    expect(prioritize(context)).toEqual(prioritize(context))
  })
})

describe('redteam: a worker cannot claim capability, budget or priority', () => {
  it('worker-claimed capability is refused when it does not hold it', () => {
    const claimant = worker({ capabilities: ['claimed-cap'] })
    const required = coordItem({ requiredCapabilities: ['cap-1'] })
    expect(isWorkerEligible(claimant, required, coordContext())).toBe(false)
  })

  it('worker-claimed budget is refused when its durable budget is short', () => {
    const claimant = worker({ remainingBudget: 5 })
    const required = coordItem({ requiredBudget: 10 })
    expect(isWorkerEligible(claimant, required, coordContext())).toBe(false)
  })

  it('a claimed higher priority does not change coordination order', () => {
    // priority is a number carried by the caller, but coordination is
    // authority-free: even the highest priority cannot clear STOP ALL.
    const context = coordContext({ stopAllActive: true, workers: [worker()] })
    const result = coordinateItem(coordItem({ priority: 1 }), context)
    expect(result.decision).toBe('stop')
    expect(result.delegation).toBeNull()
  })
})

describe('redteam: boundary violations are refusals, not warnings', () => {
  it('bypassing STOP ALL is impossible: stop always wins', () => {
    const context = coordContext({ stopAllActive: true, workers: [worker()], budgetRemaining: 1_000_000 })
    const result = coordinateItem(coordItem({ priority: 1 }), context)
    expect(result.decision).toBe('stop')
  })

  it('exceeding the budget is refused with no delegation', () => {
    const context = coordContext({ budgetRemaining: 5 })
    const result = coordinateItem(coordItem({ requiredBudget: 10 }), context)
    expect(result.decision).toBe('escalate')
    expect(result.delegation).toBeNull()
  })

  it('skipping an approval is refused: a pending approval blocks the item', () => {
    const blocked = item({ approvalPending: true })
    expect(determineBlocker(blocked)).toEqual({ type: 'approval-pending', approvalId: 'unknown' })
    const result = prioritize(prioContext([blocked]))
    expect(result.blocked.length).toBe(1)
    expect(result.ranked.length).toBe(0)
  })

  it('widening a capability is refused: a delegation carries only the request', () => {
    const context = coordContext({ workers: [worker({ capabilities: ['cap-1'] })] })
    const required = coordItem({ requiredCapabilities: ['cap-1'] })
    const result = coordinateItem(required, context)
    expect(result.decision).toBe('proceed')
    expect(result.delegation?.capabilities).toEqual(['cap-1'])
    expect(result.delegation?.capabilities).not.toContain('cognition.grant.manage')
  })

  it('self-approval is impossible: escalation mints nothing', () => {
    const result = escalate(coordItem(), 'approval required')
    expect(result.decision).toBe('escalate')
    expect(result.delegation).toBeNull()
    expect(result.workerId).toBeNull()
  })

  it('creating a grant is impossible: the executive vocabulary is closed', () => {
    // No exported value or type names a grant mint. This is a vocabulary
    // check, not a behavioural one: the words do not exist to be called.
    const minting = Object.keys(executive).filter((key) =>
      /createGrant|mint|approve|bypass|spend/i.test(key),
    )
    expect(minting).toEqual([])
  })
})

describe('redteam: STOP ALL precedence is absolute', () => {
  it('STOP ALL outranks budget, capability and priority together', () => {
    const context = coordContext({
      stopAllActive: true,
      budgetRemaining: 1_000_000,
      workers: [worker({ capabilities: ['cap-1'], remainingBudget: 1_000_000 })],
    })
    const result = coordinateItem(coordItem({ priority: 1 }), context)
    expect(result.decision).toBe('stop')
    expect(result.reasoning).toContain('stop-all-active')
  })

  it('a blocked STOP ALL item is surfaced, never silently dropped', () => {
    const result = prioritize(prioContext([item({ stopAllActive: true })]))
    expect(result.blocked[0]?.blocker).toEqual({ type: 'stop-all' })
  })
})

describe('redteam: the executive state is honest about uncertainty', () => {
  it('does not fabricate confidence for an empty state', () => {
    const context: ProjectionContext = {
      now: NOW,
      prioritization: { ranked: [], blocked: [], deferred: [], assumptions: [], generatedAt: NOW },
      plans: [],
      confidence: 'unknown',
    }
    const state = projectExecutiveState(context)
    expect(state.whatMatters).toEqual([])
    expect(state.nextBoundedAction).toBeNull()
  })

  it('is deterministic under adversarial repetition', () => {
    const context = prioContext([item({ itemId: 'a' }), item({ itemId: 'b', stopAllActive: true })])
    expect(JSON.stringify(prioritize(context))).toBe(JSON.stringify(prioritize(context)))
  })
})
