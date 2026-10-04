import { describe, expect, it } from 'vitest'
import {
  advanceImprovement,
  applyImprovement,
  canTransitionImprovement,
  createImprovementRecord,
  improvementProgress,
  rollBackImprovement,
  IMPROVEMENT_TRANSITIONS,
} from '../../../core/evolution'

const AT = '2026-06-01T09:00:00.000Z'
const LATER = '2026-06-02T09:00:00.000Z'

function improvementInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    improvementId: 'imp-1',
    kind: 'planning',
    description: 'improve the planning of long runs',
    evidenceIds: ['ev-1'],
    createdAt: AT,
    ...overrides,
  }
}

function improvement(overrides: Record<string, unknown> = {}) {
  const created = createImprovementRecord(improvementInput(overrides))
  if (!created.ok) throw new Error(`fixture refused: ${created.code} ${created.reason}`)
  return created.value
}

describe('an improvement starts proposed', () => {
  it('creates an improvement in the proposed state', () => {
    const record = improvement()
    expect(record.state).toBe('proposed')
    expect(record.appliedAt).toBeNull()
  })

  it('refuses a payload that sets the state', () => {
    const result = createImprovementRecord({ ...improvementInput(), state: 'applied' })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('key-set-mismatch')
  })

  it('refuses a payload that sets the applied instant', () => {
    const result = createImprovementRecord({ ...improvementInput(), appliedAt: AT })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('key-set-mismatch')
  })
})

describe('the improvement lifecycle is a closed table', () => {
  it('has no edge out of a terminal status', () => {
    expect(IMPROVEMENT_TRANSITIONS.applied).toEqual(['failed'])
    expect(IMPROVEMENT_TRANSITIONS.failed).toEqual([])
    expect(canTransitionImprovement('applied', 'staged')).toBe(false)
    expect(canTransitionImprovement('failed', 'proposed')).toBe(false)
  })

  it('makes applied â†’ failed the only edge out of applied', () => {
    expect(IMPROVEMENT_TRANSITIONS.applied).toEqual(['failed'])
    expect(canTransitionImprovement('applied', 'staged')).toBe(false)
    expect(canTransitionImprovement('applied', 'proposed')).toBe(false)
  })

  it('separates evaluating from approved', () => {
    expect(canTransitionImprovement('proposed', 'approved')).toBe(false)
    expect(canTransitionImprovement('proposed', 'evaluating')).toBe(true)
    expect(canTransitionImprovement('evaluating', 'approved')).toBe(true)
    expect(canTransitionImprovement('evaluating', 'applied')).toBe(false)
  })
})

describe('improvement transitions are checked', () => {
  it('advances a proposed improvement to evaluating', () => {
    const result = advanceImprovement(improvement(), { now: AT, to: 'evaluating' })
    expect(result.ok).toBe(true)
    expect(result.ok && result.value.state).toBe('evaluating')
  })

  it('refuses an illegal transition', () => {
    const result = advanceImprovement(improvement(), { now: AT, to: 'applied' })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('illegal-transition')
  })

  it('refuses a transition to the same state', () => {
    const result = advanceImprovement(improvement(), { now: AT, to: 'proposed' })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('illegal-transition')
  })
})

describe('an improvement is applied through applyImprovement', () => {
  it('applies a staged improvement and records the instant', () => {
    let current = improvement()
    current = advanceImprovement(current, { now: AT, to: 'evaluating' }).ok
      ? (advanceImprovement(current, { now: AT, to: 'evaluating' }) as { ok: true; value: typeof current }).value
      : current
    current = advanceImprovement(current, { now: AT, to: 'approved' }).ok
      ? (advanceImprovement(current, { now: AT, to: 'approved' }) as { ok: true; value: typeof current }).value
      : current
    current = advanceImprovement(current, { now: AT, to: 'staged' }).ok
      ? (advanceImprovement(current, { now: AT, to: 'staged' }) as { ok: true; value: typeof current }).value
      : current
    const applied = applyImprovement(current, { now: LATER })
    expect(applied.ok).toBe(true)
    expect(applied.ok && applied.value.state).toBe('applied')
    expect(applied.ok && applied.value.appliedAt).toBe(LATER)
  })

  it('refuses to apply an improvement that is not staged', () => {
    const result = applyImprovement(improvement(), { now: AT })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('illegal-transition')
  })
})

describe('rollback is a mechanism, not a promise', () => {
  it('rolls an applied improvement back to failed', () => {
    let current = improvement()
    for (const to of ['evaluating', 'approved', 'staged'] as const) {
      const result = advanceImprovement(current, { now: AT, to })
      if (!result.ok) throw new Error(`fixture refused: ${result.code}`)
      current = result.value
    }
    const applied = applyImprovement(current, { now: LATER })
    if (!applied.ok) throw new Error('fixture refused')
    const rolled = rollBackImprovement(applied.value, { now: LATER, reason: 'the change degraded' })
    expect(rolled.ok).toBe(true)
    expect(rolled.ok && rolled.value.state).toBe('failed')
    expect(rolled.ok && rolled.value.appliedAt).toBeNull()
  })

  it('refuses a rollback with no reason', () => {
    const result = rollBackImprovement(improvement(), { now: AT, reason: '' })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('invalid-reason')
  })

  it('refuses a rollback of a proposed improvement', () => {
    const result = rollBackImprovement(improvement(), { now: AT, reason: 'too early' })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('illegal-transition')
  })
})

describe('improvement progress is a fact about the lifecycle', () => {
  it('reports 0 for proposed and 1 for applied', () => {
    expect(improvementProgress(improvement())).toBe(0)
    let current = improvement()
    for (const to of ['evaluating', 'approved', 'staged'] as const) {
      const result = advanceImprovement(current, { now: AT, to })
      if (!result.ok) throw new Error('fixture refused')
      current = result.value
    }
    const applied = applyImprovement(current, { now: LATER })
    if (!applied.ok) throw new Error('fixture refused')
    expect(improvementProgress(applied.value)).toBe(1)
  })
})

describe('improvement input is bounded', () => {
  it('refuses a description that is too long', () => {
    const result = createImprovementRecord(improvementInput({ description: 'x'.repeat(601) }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('invalid-description')
  })

  it('refuses no evidence references', () => {
    const result = createImprovementRecord(improvementInput({ evidenceIds: [] }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('invalid-evidence-refs')
  })

  it('refuses an unknown kind', () => {
    const result = createImprovementRecord(improvementInput({ kind: 'unknown-kind' }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('invalid-kind')
  })
})
