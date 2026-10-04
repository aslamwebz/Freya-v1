import { describe, expect, it } from 'vitest'
import { ThresholdRuntime } from '../../../core/threshold/runtime'
import { projectThresholdState } from '../../../core/threshold/projection'
import { reduceThresholdState } from '../../../core/threshold/state'
import { T0, T_PLUS_1D, harness, wake } from './harness'

/**
 * Integration tests.
 *
 * These tests prove the full threshold flow: wake → assess → collect →
 * verify → evaluate → prove, and the fail-closed flows.
 */

async function opened(h = harness()) {
  const runtime = new ThresholdRuntime({ ports: h.ports })
  await runtime.open()
  return { runtime, h }
}

describe('full threshold flow', () => {
  it('wake → assess → collect → verify → evaluate → prove', async () => {
    const { runtime, h } = await opened()

    const wakeResult = await runtime.considerWake(wake())
    expect(wakeResult.outcome).toBe('accepted')

    const assessResult = await runtime.startAssessment('autonomy')
    expect(assessResult.ok).toBe(true)
    if (!assessResult.ok) throw new Error('assessment start failed')

    const evidenceResult = await runtime.collectEvidence('AUT-1', 'test', 'strong')
    expect(evidenceResult.ok).toBe(true)
    if (!evidenceResult.ok) throw new Error('evidence collection failed')

    const verifyResult = await runtime.verifyEvidence(evidenceResult.value.evidenceId, 'verified', T_PLUS_1D)
    expect(verifyResult.ok).toBe(true)

    const completeResult = await runtime.completeAssessment(assessResult.value.assessmentId, 'proven', 8, 1)
    expect(completeResult.ok).toBe(true)

    const decisionResult = await runtime.decideProven(14, 112)
    expect(decisionResult.ok).toBe(true)
    expect(runtime.folded().currentState).toBe('PROVEN')

    expect(h.types()).toContain('threshold.wake.received')
    expect(h.types()).toContain('threshold.assessment.started')
    expect(h.types()).toContain('threshold.evidence.collected')
    expect(h.types()).toContain('threshold.evidence.verified')
    expect(h.types()).toContain('threshold.assessment.completed')
    expect(h.types()).toContain('threshold.decision.proven')
  })

  it('wake → ... → fail-closed triggered → suspend', async () => {
    const { runtime, h } = await opened()

    await runtime.considerWake(wake())
    await runtime.startAssessment('autonomy')

    const failClosedResult = await runtime.triggerFailClosed('ambiguity', 'Wake source is ambiguous')
    expect(failClosedResult.ok).toBe(true)
    expect(runtime.folded().currentState).toBe('SUSPENDED')

    expect(h.types()).toContain('threshold.fail-closed.triggered')
  })

  it('wake → ... → STOP ALL → halt', async () => {
    const h = harness({ stopAll: true })
    const { runtime } = await opened(h)

    const wakeResult = await runtime.considerWake(wake())
    expect(wakeResult.outcome).toBe('denied')

    const assessResult = await runtime.startAssessment('autonomy')
    expect(assessResult.ok).toBe(false)
  })

  it('multi-day threshold continuation across wakes', async () => {
    const { runtime, h } = await opened()

    h.setClock(T0)
    const wake1 = await runtime.considerWake(wake({ occurredAt: T0 }))
    expect(wake1.outcome).toBe('accepted')

    h.setClock(T_PLUS_1D)
    const wake2 = await runtime.considerWake(wake({ occurredAt: T_PLUS_1D, sourceRef: 'src-2' }))
    expect(wake2.outcome).toBe('accepted')

    expect(runtime.folded().processedWakeKeys.length).toBe(2)
  })

  it('evidence collection flow', async () => {
    const { runtime } = await opened()

    const result = await runtime.collectEvidence('AUT-1', 'test', 'strong')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('evidence collection failed')

    const evidence = runtime.folded().evidence[0]
    expect(evidence).toBeDefined()
    if (evidence === undefined) throw new Error('no evidence was recorded')
    expect(evidence.criterionId).toBe('AUT-1')
    expect(evidence.source).toBe('test')
    expect(evidence.quality).toBe('strong')
  })

  it('fail-closed prevention flow', async () => {
    const { runtime } = await opened()

    await runtime.startAssessment('autonomy')
    const result = await runtime.triggerFailClosed('boundary-violation', 'Capability escalation attempt')
    expect(result.ok).toBe(true)
    expect(runtime.folded().currentState).toBe('SUSPENDED')

    const failClosed = runtime.folded().failClosed[0]
    expect(failClosed).toBeDefined()
    if (failClosed === undefined) throw new Error('no fail-closed record was written')
    expect(failClosed.kind).toBe('boundary-violation')
  })

  it('interrupted assessment reconciliation', async () => {
    const { runtime } = await opened()

    const result = await runtime.startAssessment('autonomy')
    expect(result.ok).toBe(true)
    expect(runtime.folded().currentState).toBe('ASSESSING')

    await runtime.suspend('interrupted')
    expect(runtime.folded().currentState).toBe('SUSPENDED')

    const assessment = runtime.folded().assessments[0]
    expect(assessment).toBeDefined()
    if (assessment === undefined) throw new Error('no assessment was recorded')
    expect(assessment.completedAt).toBeNull()
  })

  it('evidence verification flow', async () => {
    const { runtime } = await opened()

    const collectResult = await runtime.collectEvidence('AUT-1', 'test', 'strong')
    if (!collectResult.ok) throw new Error('evidence collection failed')

    const verifyResult = await runtime.verifyEvidence(collectResult.value.evidenceId, 'verified', T_PLUS_1D)
    expect(verifyResult.ok).toBe(true)

    const evidence = runtime.folded().evidence[0]
    expect(evidence).toBeDefined()
    if (evidence === undefined) throw new Error('no evidence was recorded')
    expect(evidence.verifiedAt).not.toBeNull()
    expect(evidence.expiresAt).toBe(T_PLUS_1D)
  })

  it('self-modification refusal flow', async () => {
    const { runtime, h } = await opened()

    await runtime.refuseSelfModification('guard', 'Attempted to modify Guard')
    expect(h.types()).toContain('threshold.fail-closed.triggered')

    const failClosed = runtime.folded().failClosed[0]
    expect(failClosed).toBeDefined()
    if (failClosed === undefined) throw new Error('no fail-closed record was written')
    expect(failClosed.kind).toBe('self-modification')
  })

  it('rollback flow', async () => {
    const { runtime } = await opened()

    const startResult = await runtime.startRollback('authority-widening')
    expect(startResult.ok).toBe(true)
    if (!startResult.ok) throw new Error('rollback did not start')
    expect(runtime.folded().currentState).toBe('ROLLED_BACK')

    const completeResult = await runtime.completeRollback(startResult.value.rollbackId, 'owner')
    expect(completeResult.ok).toBe(true)

    const rollback = runtime.folded().rollbacks[0]
    expect(rollback).toBeDefined()
    if (rollback === undefined) throw new Error('no rollback was recorded')
    expect(rollback.completedAt).not.toBeNull()
    expect(rollback.approvedBy).toBe('owner')
  })

  it('maturity re-proven after rollback', async () => {
    const { runtime } = await opened()

    const rollbackResult = await runtime.startRollback('authority-widening')
    if (!rollbackResult.ok) throw new Error('rollback start failed')
    await runtime.completeRollback(rollbackResult.value.rollbackId, 'owner')
    expect(runtime.folded().currentState).toBe('ROLLED_BACK')

    const assessResult = await runtime.startAssessment('autonomy')
    expect(assessResult.ok).toBe(true)
    expect(runtime.folded().currentState).toBe('ASSESSING')
  })
})

describe('deterministic replay', () => {
  it('produces the same state from the same journal', async () => {
    const h1 = harness()
    const h2 = harness()
    const r1 = new ThresholdRuntime({ ports: h1.ports })
    const r2 = new ThresholdRuntime({ ports: h2.ports })
    await r1.open()
    await r2.open()

    await r1.startAssessment('autonomy')
    await r2.startAssessment('autonomy')

    const e1 = await r1.collectEvidence('AUT-1', 'test', 'strong')
    const e2 = await r2.collectEvidence('AUT-1', 'test', 'strong')
    if (!e1.ok || !e2.ok) throw new Error('evidence collection failed')

    await r1.verifyEvidence(e1.value.evidenceId, 'verified', T_PLUS_1D)
    await r2.verifyEvidence(e2.value.evidenceId, 'verified', T_PLUS_1D)

    expect(r1.folded()).toEqual(r2.folded())
  })

  it('replays a journal into the same state', async () => {
    const h = harness()
    const runtime = new ThresholdRuntime({ ports: h.ports })
    await runtime.open()

    await runtime.startAssessment('autonomy')
    const evidenceResult = await runtime.collectEvidence('AUT-1', 'test', 'strong')
    if (!evidenceResult.ok) throw new Error('evidence collection failed')
    await runtime.verifyEvidence(evidenceResult.value.evidenceId, 'verified', T_PLUS_1D)

    const entries = await h.ports.replay()
    const folded = reduceThresholdState(entries)

    expect(folded.state.currentState).toBe(runtime.folded().currentState)
    expect(folded.state.assessments.length).toBe(runtime.folded().assessments.length)
    expect(folded.state.evidence.length).toBe(runtime.folded().evidence.length)
  })
})

describe('projection integration', () => {
  it('projects the full flow', async () => {
    const { runtime } = await opened()

    await runtime.considerWake(wake())
    const assessResult = await runtime.startAssessment('autonomy')
    if (!assessResult.ok) throw new Error('assessment start failed')
    const evidenceResult = await runtime.collectEvidence('AUT-1', 'test', 'strong')
    if (!evidenceResult.ok) throw new Error('evidence collection failed')
    await runtime.verifyEvidence(evidenceResult.value.evidenceId, 'verified', T_PLUS_1D)
    await runtime.completeAssessment(assessResult.value.assessmentId, 'proven', 8, 1)
    await runtime.decideProven(14, 112)

    const snapshot = runtime.snapshot()
    const projection = projectThresholdState({
      state: runtime.folded(),
      snapshot,
      now: T0,
      sequence: 1,
    })

    expect(projection.health).toBe('proven')
    expect(projection.summary.currentState).toBe('PROVEN')
    expect(projection.summary.counters.assessmentsStarted).toBe(1)
    expect(projection.summary.counters.evidenceCollected).toBe(1)
    expect(projection.summary.counters.evidenceVerified).toBe(1)
    expect(projection.summary.counters.decisionsProven).toBe(1)
  })
})
