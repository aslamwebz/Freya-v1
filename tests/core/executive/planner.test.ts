// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  detectEvidenceState,
  detectConflictedEvidence,
  conservativeInterpretation,
  createAssumption,
  createAssumptionsForGaps,
  createPlannedStep,
  markReversibility,
  planForGoal,
  produceBoundedActions,
  instantMs,
  type PlanGoal,
  type PlannerContext,
} from '../../../core/executive'

const NOW = '2026-10-01T12:00:00.000Z'

function makeGoal(over: Partial<PlanGoal> = {}): PlanGoal {
  return {
    goalId: 'goal-1',
    description: 'Test goal',
    requiredCapabilities: ['cap-1'],
    deadlineAt: null,
    dependencies: [],
    reversible: true,
    ...over,
  }
}

function makeContext(over: Partial<PlannerContext> = {}): PlannerContext {
  return {
    now: NOW,
    goals: [],
    evidence: [],
    knownCapabilities: new Set(['cap-1']),
    pendingApprovals: new Set(),
    ...over,
  }
}

describe('detectEvidenceState', () => {
  it('returns missing when no evidence exists', () => {
    expect(detectEvidenceState([], NOW)).toBe('missing')
  })

  it('returns fresh when evidence is recent', () => {
    const evidence = [
      { evidenceId: 'e1', source: 'test', observedAt: NOW, state: 'fresh' as const },
    ]
    expect(detectEvidenceState(evidence, NOW)).toBe('fresh')
  })

  it('returns stale when evidence is old', () => {
    const old = new Date(instantMs(NOW)! - 48 * 60 * 60 * 1000).toISOString()
    const evidence = [
      { evidenceId: 'e1', source: 'test', observedAt: old, state: 'stale' as const },
    ]
    expect(detectEvidenceState(evidence, NOW)).toBe('stale')
  })

  it('honours an explicit stale marker on recent evidence', () => {
    const evidence = [
      { evidenceId: 'e1', source: 'test', observedAt: NOW, state: 'stale' as const },
    ]
    expect(detectEvidenceState(evidence, NOW)).toBe('stale')
  })
})

describe('detectConflictedEvidence', () => {
  it('returns conflicted evidence', () => {
    const evidence = [
      { evidenceId: 'e1', source: 'a', observedAt: NOW, state: 'conflicted' as const, conflictsWith: ['e2'] },
      { evidenceId: 'e2', source: 'b', observedAt: NOW, state: 'fresh' as const },
    ]
    const conflicted = detectConflictedEvidence(evidence)
    expect(conflicted.length).toBe(1)
    expect(conflicted[0]?.evidenceId).toBe('e1')
  })
})

describe('conservativeInterpretation', () => {
  it('returns low confidence for conflicted evidence', () => {
    const evidence = [
      { evidenceId: 'e1', source: 'a', observedAt: NOW, state: 'conflicted' as const },
    ]
    expect(conservativeInterpretation(evidence)).toBe('low')
  })

  it('returns high confidence for fresh evidence', () => {
    const evidence = [
      { evidenceId: 'e1', source: 'a', observedAt: NOW, state: 'fresh' as const },
    ]
    expect(conservativeInterpretation(evidence)).toBe('high')
  })
})

describe('createAssumption', () => {
  it('creates an assumption with expiration', () => {
    const assumption = createAssumption('Test assumption', 'test-basis', 'medium', NOW)
    expect(assumption.statement).toBe('Test assumption')
    expect(assumption.confidence).toBe('medium')
    expect(assumption.expiresAt).toBeDefined()
    expect(assumption.reversible).toBe(true)
  })
})

describe('createAssumptionsForGaps', () => {
  it('creates assumptions for missing capabilities and a missing deadline', () => {
    const goal = makeGoal({ requiredCapabilities: ['cap-1', 'cap-2'] })
    const context = makeContext({ knownCapabilities: new Set(['cap-1']) })
    const assumptions = createAssumptionsForGaps(goal, context)
    expect(assumptions.length).toBe(2)
    expect(assumptions.map((a) => a.statement).join(' ')).toContain('cap-2')
  })
})

describe('createPlannedStep', () => {
  it('creates a bounded step', () => {
    const step = createPlannedStep('cap-1', 'verify-1', 0, true)
    expect(step.capability).toBe('cap-1')
    expect(step.verifier).toBe('verify-1')
    expect(step.reversible).toBe(true)
    expect(step.maxAttempts).toBeGreaterThan(0)
  })
})

describe('markReversibility', () => {
  it('marks irreversible decisions as requiring approval', () => {
    const step = createPlannedStep('cap-1', 'verify-1', 0, false)
    const marked = markReversibility(step, false)
    expect(marked.reversible).toBe(false)
    expect(marked.requiresApproval).toBe(true)
  })
})

describe('planForGoal', () => {
  it('produces a bounded plan', () => {
    const goal = makeGoal({ requiredCapabilities: ['cap-1', 'cap-2'] })
    const context = makeContext()
    const plan = planForGoal(goal, context)
    expect(plan.goalRef).toBe('goal-1')
    expect(plan.steps.length).toBe(2)
    expect(plan.confidence).toBeDefined()
    expect(plan.deadlineAt).toBeDefined()
  })

  it('is deterministic', () => {
    const goal = makeGoal()
    const context = makeContext()
    const p1 = planForGoal(goal, context)
    const p2 = planForGoal(goal, context)
    expect(p1).toEqual(p2)
  })
})

describe('produceBoundedActions', () => {
  it('produces bounded actions from a plan', () => {
    const goal = makeGoal({ requiredCapabilities: ['cap-1'] })
    const context = makeContext()
    const plan = planForGoal(goal, context)
    const actions = produceBoundedActions(plan)
    expect(actions.length).toBe(1)
    expect(actions[0]?.maxAttempts).toBeLessThanOrEqual(3)
  })
})
