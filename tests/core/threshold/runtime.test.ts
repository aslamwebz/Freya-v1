import { describe, expect, it } from 'vitest'
import { ThresholdRuntime } from '../../../core/threshold/runtime'
import { projectThresholdState } from '../../../core/threshold/projection'
import { THRESHOLD_LIMITS } from '../../../core/threshold/types'
import { narrowThresholdLimits } from '../../../core/threshold/limits'
import {
  T0,
  T_PLUS_1D,
  harness,
  wake,
} from './harness'

/**
 * The runtime, end to end and deterministically.
 */

async function opened(h = harness()) {
  const runtime = new ThresholdRuntime({ ports: h.ports })
  await runtime.open()
  return { runtime, h }
}

describe('opening the runtime', () => {
  it('is deterministic: same journal = same state', async () => {
    const h1 = harness()
    const h2 = harness()
    const r1 = new ThresholdRuntime({ ports: h1.ports })
    const r2 = new ThresholdRuntime({ ports: h2.ports })
    await r1.open()
    await r2.open()
    expect(r1.folded()).toEqual(r2.folded())
  })

  it('starts in UNPROVEN state', async () => {
    const { runtime } = await opened()
    expect(runtime.folded().currentState).toBe('UNPROVEN')
  })
})

describe('assessment', () => {
  it('starts an assessment and transitions to ASSESSING', async () => {
    const { runtime, h } = await opened()
    const outcome = await runtime.startAssessment('autonomy')
    expect(outcome.ok).toBe(true)
    expect(runtime.folded().currentState).toBe('ASSESSING')
    expect(h.types()).toContain('threshold.assessment.started')
  })

  it('completes an assessment and transitions to EVALUATING', async () => {
    const { runtime, h } = await opened()
    const result = await runtime.startAssessment('autonomy')
    if (!result.ok) throw new Error('assessment start failed')
    const outcome = await runtime.completeAssessment(result.value.assessmentId, 'developing', 8, 4)
    expect(outcome.ok).toBe(true)
    expect(runtime.folded().currentState).toBe('EVALUATING')
    expect(h.types()).toContain('threshold.assessment.completed')
  })

  it('refuses an assessment when STOP ALL is active', async () => {
    const h = harness({ stopAll: true })
    const { runtime } = await opened(h)
    const outcome = await runtime.startAssessment('autonomy')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('stop-all-active')
  })

  it('refuses an assessment when the journal is not trustworthy', async () => {
    const h = harness({ journalTrustworthy: false })
    const { runtime } = await opened(h)
    const outcome = await runtime.startAssessment('autonomy')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.code).toBe('journal-not-trustworthy')
  })

  it('refuses an unknown dimension', async () => {
    const { runtime } = await opened()
    const outcome = await runtime.startAssessment('unknown-dimension')
    expect(outcome.ok).toBe(false)
  })
})

describe('evidence', () => {
  it('collects evidence and transitions to EVIDENCING', async () => {
    const { runtime, h } = await opened()
    const outcome = await runtime.collectEvidence('AUT-1', 'test', 'strong')
    expect(outcome.ok).toBe(true)
    expect(runtime.folded().currentState).toBe('EVIDENCING')
    expect(h.types()).toContain('threshold.evidence.collected')
  })

  it('verifies evidence and transitions to EVALUATING', async () => {
    const { runtime, h } = await opened()
    const result = await runtime.collectEvidence('AUT-1', 'test', 'strong')
    if (!result.ok) throw new Error('evidence collection failed')
    const outcome = await runtime.verifyEvidence(result.value.evidenceId, 'verified', T_PLUS_1D)
    expect(outcome.ok).toBe(true)
    expect(runtime.folded().currentState).toBe('EVALUATING')
    expect(h.types()).toContain('threshold.evidence.verified')
  })

  it('detects evidence fabrication and transitions to SUSPENDED', async () => {
    const { runtime, h } = await opened()
    const result = await runtime.collectEvidence('AUT-1', 'test', 'strong')
    if (!result.ok) throw new Error('evidence collection failed')
    const outcome = await runtime.detectEvidenceFabrication(result.value.evidenceId, 'Fabricated test result')
    expect(outcome.ok).toBe(true)
    expect(runtime.folded().currentState).toBe('SUSPENDED')
    expect(h.types()).toContain('threshold.evidence.fabrication-detected')
  })
})

describe('decisions', () => {
  it('decides proven and transitions to PROVEN', async () => {
    const { runtime, h } = await opened()
    await runtime.startAssessment('autonomy')
    await runtime.collectEvidence('AUT-1', 'test', 'strong')
    const evidence = runtime.folded().evidence[0]
    if (!evidence) throw new Error('evidence not found')
    await runtime.verifyEvidence(evidence.evidenceId, 'verified', T_PLUS_1D)
    const outcome = await runtime.decideProven(14, 112)
    expect(outcome.ok).toBe(true)
    expect(runtime.folded().currentState).toBe('PROVEN')
    expect(h.types()).toContain('threshold.decision.proven')
  })

  it('decides not-proven and transitions to UNPROVEN', async () => {
    const { runtime, h } = await opened()
    const outcome = await runtime.decideNotProven(['autonomy', 'memory'], 'Insufficient evidence')
    expect(outcome.ok).toBe(true)
    expect(runtime.folded().currentState).toBe('UNPROVEN')
    expect(h.types()).toContain('threshold.decision.not-proven')
  })
})

describe('fail-closed', () => {
  it('triggers fail-closed and transitions to SUSPENDED', async () => {
    const { runtime, h } = await opened()
    await runtime.startAssessment('autonomy')
    const outcome = await runtime.triggerFailClosed('ambiguity', 'Wake source is ambiguous')
    expect(outcome.ok).toBe(true)
    expect(runtime.folded().currentState).toBe('SUSPENDED')
    expect(h.types()).toContain('threshold.fail-closed.triggered')
  })

  it('resolves fail-closed', async () => {
    const { runtime, h } = await opened()
    const result = await runtime.triggerFailClosed('ambiguity', 'Wake source is ambiguous')
    if (!result.ok) throw new Error('fail-closed trigger failed')
    const outcome = await runtime.resolveFailClosed(result.value.recordId, 'refused')
    expect(outcome.ok).toBe(true)
    expect(h.types()).toContain('threshold.fail-closed.resolved')
  })
})

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
})

describe('wake', () => {
  it('accepts a valid wake', async () => {
    const { runtime, h } = await opened()
    const outcome = await runtime.considerWake(wake())
    expect(outcome.outcome).toBe('accepted')
    expect(h.types()).toContain('threshold.wake.received')
  })

  it('denies a wake from an unauthorized source', async () => {
    const { runtime, h } = await opened()
    const outcome = await runtime.considerWake(wake({ source: 'unknown-source' as never }))
    expect(outcome.outcome).toBe('denied')
    expect(h.types()).toContain('threshold.wake.denied')
  })

  it('denies a wake when STOP ALL is active', async () => {
    const h = harness({ stopAll: true })
    const { runtime } = await opened(h)
    const outcome = await runtime.considerWake(wake())
    expect(outcome.outcome).toBe('denied')
  })

  it('denies a duplicate wake', async () => {
    const { runtime } = await opened()
    const first = await runtime.considerWake(wake())
    expect(first.outcome).toBe('accepted')
    const second = await runtime.considerWake(wake())
    expect(second.outcome).toBe('denied')
  })
})

describe('self-modification', () => {
  it('refuses self-modification and journals the attempt', async () => {
    const { runtime, h } = await opened()
    await runtime.refuseSelfModification('guard', 'Attempted to modify Guard')
    expect(h.types()).toContain('threshold.fail-closed.triggered')
  })
})

describe('projection', () => {
  it('projects the current state', async () => {
    const { runtime, h } = await opened()
    await runtime.startAssessment('autonomy')
    const snapshot = runtime.snapshot()
    const projection = projectThresholdState({
      state: runtime.folded(),
      snapshot,
      now: T0,
      sequence: 1,
    })
    expect(projection.health).toBe('assessing')
    expect(projection.summary.currentState).toBe('ASSESSING')
  })
})

describe('assertions', () => {
  it('passes assertions on a clean journal', async () => {
    const { runtime } = await opened()
    const report = await runtime.audit()
    expect(report.holds).toBe(true)
  })

  it('fails assertions when forbidden keys are present', async () => {
    const { runtime, h } = await opened()
    h.seed([
      {
        type: 'threshold.assessment.started',
        recordedAt: T0,
        payload: { assessmentId: 'a-1', dimension: 'autonomy', startedAt: T0, realMoney: true },
      },
    ])
    const report = await runtime.audit()
    expect(report.holds).toBe(false)
  })
})

describe('determinism', () => {
  it('produces the same state from the same journal', async () => {
    const h1 = harness()
    const h2 = harness()
    const r1 = new ThresholdRuntime({ ports: h1.ports })
    const r2 = new ThresholdRuntime({ ports: h2.ports })
    await r1.open()
    await r2.open()
    await r1.startAssessment('autonomy')
    await r2.startAssessment('autonomy')
    expect(r1.folded()).toEqual(r2.folded())
  })
})
