import { describe, expect, it } from 'vitest'
import { ThresholdRuntime } from '../../../core/threshold/runtime'
import { harness } from './harness'

/**
 * Rollback tests.
 */

async function opened(h = harness()) {
  const runtime = new ThresholdRuntime({ ports: h.ports })
  await runtime.open()
  return { runtime, h }
}

describe('rollback', () => {
  it('starts a rollback and transitions to ROLLED_BACK', async () => {
    const { runtime, h } = await opened()
    const outcome = await runtime.startRollback('authority-widening')
    expect(outcome.ok).toBe(true)
    expect(runtime.folded().currentState).toBe('ROLLED_BACK')
    expect(h.types()).toContain('threshold.rollback.started')
  })

  it('completes a rollback with owner approval', async () => {
    const { runtime, h } = await opened()
    const result = await runtime.startRollback('authority-widening')
    if (!result.ok) throw new Error('rollback start failed')
    const outcome = await runtime.completeRollback(result.value.rollbackId, 'owner')
    expect(outcome.ok).toBe(true)
    expect(h.types()).toContain('threshold.rollback.completed')
  })

  it('refuses a rollback without owner approval', async () => {
    const { runtime } = await opened()
    const result = await runtime.startRollback('authority-widening')
    if (!result.ok) throw new Error('rollback start failed')
    const outcome = await runtime.completeRollback(result.value.rollbackId, '')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('self-approval-prohibited')
  })

  it('refuses a rollback when STOP ALL is active', async () => {
    const h = harness({ stopAll: true })
    const { runtime } = await opened(h)
    const outcome = await runtime.startRollback('authority-widening')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('stop-all-active')
  })

  it('refuses a rollback when the journal is not trustworthy', async () => {
    const h = harness({ journalTrustworthy: false })
    const { runtime } = await opened(h)
    const outcome = await runtime.startRollback('authority-widening')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('journal-not-trustworthy')
  })

  it('refuses a rollback when the Guard denies', async () => {
    const h = harness({ guardAllows: false })
    const { runtime } = await opened(h)
    const outcome = await runtime.startRollback('authority-widening')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('guard-denied')
  })

  it('refuses a rollback when the Governor denies', async () => {
    const h = harness({ governorAuthorized: false })
    const { runtime } = await opened(h)
    const outcome = await runtime.startRollback('authority-widening')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('governor-denied')
  })

  it('refuses a rollback when the budget is exhausted', async () => {
    const h = harness({ budgetRemainingUnits: 0 })
    const { runtime } = await opened(h)
    const outcome = await runtime.startRollback('authority-widening')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('budget-exhausted')
  })

  it('refuses a rollback when approval is not satisfied', async () => {
    const h = harness({ approvalSatisfied: false })
    const { runtime } = await opened(h)
    const outcome = await runtime.startRollback('authority-widening')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('approval-required')
  })

  it('refuses an unknown rollback reason', async () => {
    const { runtime } = await opened()
    const outcome = await runtime.startRollback('unknown-reason')
    expect(outcome.ok).toBe(false)
  })

  it('can re-proven after rollback', async () => {
    const { runtime } = await opened()
    const rollbackResult = await runtime.startRollback('authority-widening')
    if (!rollbackResult.ok) throw new Error('rollback start failed')
    await runtime.completeRollback(rollbackResult.value.rollbackId, 'owner')
    expect(runtime.folded().currentState).toBe('ROLLED_BACK')
    const resetResult = await runtime.startAssessment('autonomy')
    expect(resetResult.ok).toBe(true)
    expect(runtime.folded().currentState).toBe('ASSESSING')
  })
})

describe('suspend and resume', () => {
  it('suspends the threshold', async () => {
    const { runtime, h } = await opened()
    const outcome = await runtime.suspend('owner-requested')
    expect(outcome.ok).toBe(true)
    expect(runtime.folded().currentState).toBe('SUSPENDED')
    expect(h.types()).toContain('threshold.suspended')
  })

  it('resumes the threshold', async () => {
    const { runtime, h } = await opened()
    await runtime.suspend('owner-requested')
    const outcome = await runtime.resume('owner-cleared')
    expect(outcome.ok).toBe(true)
    expect(runtime.folded().currentState).toBe('UNPROVEN')
    expect(h.types()).toContain('threshold.resumed')
  })

  it('refuses to resume when not suspended', async () => {
    const { runtime } = await opened()
    const outcome = await runtime.resume('owner-cleared')
    expect(outcome.ok).toBe(false)
  })
})
