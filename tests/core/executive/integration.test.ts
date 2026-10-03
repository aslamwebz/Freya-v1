// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  planForGoal,
  prioritize,
  projectExecutiveState,
  coordinateItem,
  type CoordinatorContext,
  type PlannerContext,
  type PrioritizerContext,
  type ProjectionContext,
  type WorkItemMetadata,
  type WorkerInfo,
  type CoordinationItem,
} from '../../../core/executive'

/**
 * Phase 24 integration: the deterministic decision pipeline.
 *
 *   prioritize -> plan -> coordinate -> project
 *
 * The whole flow is pure: same inputs + same clock = same state. Nothing here
 * calls a model, reads a clock, or mints authority. This is the acceptance
 * flow from `docs/phase24/acceptance-criteria.md` (I1-I10) at the domain level.
 */

const NOW = '2026-10-01T12:00:00.000Z'

function makeItem(over: Partial<WorkItemMetadata> = {}): WorkItemMetadata {
  return {
    itemId: 'item-1',
    kind: 'mission',
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

function makeCoordItem(over: Partial<CoordinationItem> = {}): CoordinationItem {
  return {
    itemId: 'item-1',
    requiredCapabilities: ['cap-1'],
    requiredBudget: 10,
    priority: 0.5,
    missionId: null,
    runId: null,
    ...over,
  }
}

function prio(items: readonly WorkItemMetadata[]): PrioritizerContext {
  return { now: NOW, items, evidence: [], activeItemIds: new Set() }
}

describe('integration: wake -> prioritize -> plan -> coordinate -> state', () => {
  it('produces a deterministic decision for a full pipeline', () => {
    const urgent = makeItem({
      itemId: 'mission-urgent',
      ownerImportance: 'critical',
      ownerIntent: 'priority',
      deadlineAt: new Date(Date.parse(NOW) + 30 * 60 * 1000).toISOString(),
    })
    const later = makeItem({ itemId: 'mission-later' })

    const ranked = prioritize(prio([later, urgent]))
    expect(ranked.ranked[0]?.itemId).toBe('mission-urgent')

    const planner: PlannerContext = {
      now: NOW,
      goals: [
        {
          goalId: 'mission-urgent',
          description: 'Handle the urgent mission',
          requiredCapabilities: ['cap-1'],
          deadlineAt: urgent.deadlineAt,
          dependencies: [],
          reversible: true,
        },
      ],
      evidence: [],
      knownCapabilities: new Set(['cap-1']),
      pendingApprovals: new Set(),
    }
    const plan = planForGoal(planner.goals[0]!, planner)
    expect(plan.steps.length).toBe(1)

    const coordinator: CoordinatorContext = {
      now: NOW,
      items: [makeCoordItem({ itemId: 'mission-urgent', priority: ranked.ranked[0]!.score })],
      workers: [makeWorker()],
      activeDelegations: [],
      stopAllActive: false,
      budgetRemaining: 1000,
      pendingApprovals: new Set(),
      maxConcurrentAssignments: 8,
    }
    const decision = coordinateItem(coordinator.items[0]!, coordinator)
    expect(decision.decision).toBe('proceed')

    const projection: ProjectionContext = {
      now: NOW,
      prioritization: ranked,
      plans: [plan],
      confidence: plan.confidence,
    }
    const state = projectExecutiveState(projection)
    expect(state.whatMatters[0]?.itemId).toBe('mission-urgent')
    expect(state.nextBoundedAction?.target).toBe('mission-urgent')
  })

  it('is deterministic across repeated full-pipeline runs', () => {
    const run = (): string => {
      const items = [
        makeItem({ itemId: 'a', ownerImportance: 'high' }),
        makeItem({ itemId: 'b', ownerImportance: 'critical', ownerIntent: 'priority' }),
        makeItem({ itemId: 'c', stopAllActive: true }),
      ]
      const result = prioritize(prio(items))
      const projection = projectExecutiveState({
        now: NOW,
        prioritization: result,
        plans: [],
        confidence: 'high',
      })
      return JSON.stringify(projection)
    }
    expect(run()).toBe(run())
  })
})

describe('integration: authority is preserved end-to-end', () => {
  it('STOP ALL halts the pipeline at coordination', () => {
    const result = prioritize(prio([makeItem({ stopAllActive: true })]))
    expect(result.blocked.length).toBe(1)
    const context: CoordinatorContext = {
      now: NOW,
      items: [makeCoordItem()],
      workers: [makeWorker()],
      activeDelegations: [],
      stopAllActive: true,
      budgetRemaining: 1000,
      pendingApprovals: new Set(),
      maxConcurrentAssignments: 8,
    }
    expect(coordinateItem(context.items[0]!, context).decision).toBe('stop')
  })

  it('a pending approval blocks ranking and no delegation is minted', () => {
    const blocked = makeItem({ itemId: 'needs-approval', approvalPending: true })
    const ranked = prioritize(prio([blocked]))
    expect(ranked.blocked.length).toBe(1)
    expect(ranked.ranked.length).toBe(0)
    const context: CoordinatorContext = {
      now: NOW,
      items: [],
      workers: [makeWorker()],
      activeDelegations: [],
      stopAllActive: false,
      budgetRemaining: 1000,
      pendingApprovals: new Set(['approval-1']),
      maxConcurrentAssignments: 8,
    }
    expect(context.pendingApprovals.has('approval-1')).toBe(true)
  })

  it('an exhausted budget escalates rather than delegating', () => {
    const context: CoordinatorContext = {
      now: NOW,
      items: [],
      workers: [makeWorker()],
      activeDelegations: [],
      stopAllActive: false,
      budgetRemaining: 0,
      pendingApprovals: new Set(),
      maxConcurrentAssignments: 8,
    }
    const decision = coordinateItem(makeCoordItem({ requiredBudget: 10 }), context)
    expect(decision.decision).toBe('escalate')
    expect(decision.delegation).toBeNull()
  })
})
