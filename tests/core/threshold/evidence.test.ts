import { describe, expect, it } from 'vitest'
import { analyseThresholdAssertions, passingThresholdAssertions, scanThresholdSource } from '../../../core/threshold/assertions'
import { reduceThresholdState, initialThresholdState } from '../../../core/threshold/state'
import { T0 } from './harness'

/**
 * Evidence integrity tests.
 */

describe('assertion analysis', () => {
  it('passes on an empty journal', () => {
    const report = analyseThresholdAssertions({ entries: [] })
    expect(report.holds).toBe(true)
  })

  it('passes on a clean journal', () => {
    const report = analyseThresholdAssertions({
      entries: [
        {
          type: 'threshold.assessment.started',
          recordedAt: T0,
          payload: { assessmentId: 'a-1', dimension: 'autonomy', startedAt: T0 },
        },
      ],
    })
    expect(report.holds).toBe(true)
  })

  it('fails on an unknown event type', () => {
    const report = analyseThresholdAssertions({
      entries: [
        {
          type: 'threshold.unknown.event',
          recordedAt: T0,
          payload: {},
        },
      ],
    })
    expect(report.holds).toBe(false)
  })

  it('fails on a forbidden payload key', () => {
    const report = analyseThresholdAssertions({
      entries: [
        {
          type: 'threshold.assessment.started',
          recordedAt: T0,
          payload: { assessmentId: 'a-1', dimension: 'autonomy', startedAt: T0, realMoney: true },
        },
      ],
    })
    expect(report.holds).toBe(false)
  })

  it('fails on a self-modification key', () => {
    const report = analyseThresholdAssertions({
      entries: [
        {
          type: 'threshold.assessment.started',
          recordedAt: T0,
          payload: { assessmentId: 'a-1', dimension: 'autonomy', startedAt: T0, selfModify: true },
        },
      ],
    })
    expect(report.holds).toBe(false)
  })

  it('fails on a capability widening key', () => {
    const report = analyseThresholdAssertions({
      entries: [
        {
          type: 'threshold.assessment.started',
          recordedAt: T0,
          payload: { assessmentId: 'a-1', dimension: 'autonomy', startedAt: T0, widenCapability: true },
        },
      ],
    })
    expect(report.holds).toBe(false)
  })

  it('fails on a grant creation key', () => {
    const report = analyseThresholdAssertions({
      entries: [
        {
          type: 'threshold.assessment.started',
          recordedAt: T0,
          payload: { assessmentId: 'a-1', dimension: 'autonomy', startedAt: T0, createGrant: true },
        },
      ],
    })
    expect(report.holds).toBe(false)
  })

  it('fails on a silent resume key', () => {
    const report = analyseThresholdAssertions({
      entries: [
        {
          type: 'threshold.assessment.started',
          recordedAt: T0,
          payload: { assessmentId: 'a-1', dimension: 'autonomy', startedAt: T0, silentResume: true },
        },
      ],
    })
    expect(report.holds).toBe(false)
  })

  it('fails on a state fabrication key', () => {
    const report = analyseThresholdAssertions({
      entries: [
        {
          type: 'threshold.assessment.started',
          recordedAt: T0,
          payload: { assessmentId: 'a-1', dimension: 'autonomy', startedAt: T0, fabricateState: true },
        },
      ],
    })
    expect(report.holds).toBe(false)
  })

  it('fails on a degradation hiding key', () => {
    const report = analyseThresholdAssertions({
      entries: [
        {
          type: 'threshold.assessment.started',
          recordedAt: T0,
          payload: { assessmentId: 'a-1', dimension: 'autonomy', startedAt: T0, hideDegradation: true },
        },
      ],
    })
    expect(report.holds).toBe(false)
  })

  it('fails on a capability fabrication key', () => {
    const report = analyseThresholdAssertions({
      entries: [
        {
          type: 'threshold.assessment.started',
          recordedAt: T0,
          payload: { assessmentId: 'a-1', dimension: 'autonomy', startedAt: T0, fabricateCapability: true },
        },
      ],
    })
    expect(report.holds).toBe(false)
  })

  it('fails on an evidence fabrication key', () => {
    const report = analyseThresholdAssertions({
      entries: [
        {
          type: 'threshold.assessment.started',
          recordedAt: T0,
          payload: { assessmentId: 'a-1', dimension: 'autonomy', startedAt: T0, fabricateEvidence: true },
        },
      ],
    })
    expect(report.holds).toBe(false)
  })

  it('fails on a maturity self-grant key', () => {
    const report = analyseThresholdAssertions({
      entries: [
        {
          type: 'threshold.assessment.started',
          recordedAt: T0,
          payload: { assessmentId: 'a-1', dimension: 'autonomy', startedAt: T0, selfGrantMaturity: true },
        },
      ],
    })
    expect(report.holds).toBe(false)
  })

  it('fails on a maturity authority widening key', () => {
    const report = analyseThresholdAssertions({
      entries: [
        {
          type: 'threshold.assessment.started',
          recordedAt: T0,
          payload: { assessmentId: 'a-1', dimension: 'autonomy', startedAt: T0, maturityWidensAuthority: true },
        },
      ],
    })
    expect(report.holds).toBe(false)
  })

  it('fails on an inference key', () => {
    const report = analyseThresholdAssertions({
      entries: [
        {
          type: 'threshold.assessment.started',
          recordedAt: T0,
          payload: { assessmentId: 'a-1', dimension: 'autonomy', startedAt: T0, model: 'gpt-4' },
        },
      ],
    })
    expect(report.holds).toBe(false)
  })

  it('fails on an unknown payload key', () => {
    const report = analyseThresholdAssertions({
      entries: [
        {
          type: 'threshold.assessment.started',
          recordedAt: T0,
          payload: { assessmentId: 'a-1', dimension: 'autonomy', startedAt: T0, unknownKey: 'value' },
        },
      ],
    })
    expect(report.holds).toBe(false)
  })

  it('fails on a model call attributed to threshold', () => {
    const report = analyseThresholdAssertions({
      entries: [
        {
          type: 'model.request.started',
          recordedAt: T0,
          payload: { requestId: 'r-1', correlationId: 'threshold-1' },
        },
      ],
    })
    expect(report.holds).toBe(false)
  })
})

describe('passing assertions', () => {
  it('returns a passing report', () => {
    const report = passingThresholdAssertions()
    expect(report.holds).toBe(true)
    expect(report.violations).toEqual([])
  })
})

describe('source scan', () => {
  it('finds timer usage in source', () => {
    const violations = scanThresholdSource('const x = setInterval(() => {}, 1000)')
    expect(violations.length).toBeGreaterThan(0)
  })

  it('finds unbounded loops in source', () => {
    const violations = scanThresholdSource('while (true) { doWork() }')
    expect(violations.length).toBeGreaterThan(0)
  })

  it('returns no violations for clean source', () => {
    const violations = scanThresholdSource('const x = 1 + 2')
    expect(violations).toEqual([])
  })
})

describe('state fold', () => {
  it('starts in UNPROVEN state', () => {
    const state = initialThresholdState()
    expect(state.currentState).toBe('UNPROVEN')
  })

  it('folds an assessment started event', () => {
    const result = reduceThresholdState([
      {
        type: 'threshold.assessment.started',
        recordedAt: T0,
        payload: { assessmentId: 'a-1', dimension: 'autonomy', startedAt: T0 },
      },
    ])
    expect(result.state.currentState).toBe('ASSESSING')
    expect(result.state.assessments.length).toBe(1)
  })

  it('folds an evidence collected event', () => {
    const result = reduceThresholdState([
      {
        type: 'threshold.evidence.collected',
        recordedAt: T0,
        payload: { evidenceId: 'e-1', criterionId: 'AUT-1', source: 'test', quality: 'strong', collectedAt: T0 },
      },
    ])
    expect(result.state.currentState).toBe('EVIDENCING')
    expect(result.state.evidence.length).toBe(1)
  })

  it('folds a decision proven event', () => {
    const result = reduceThresholdState([
      {
        type: 'threshold.assessment.started',
        recordedAt: T0,
        payload: { assessmentId: 'a-1', dimension: 'autonomy', startedAt: T0 },
      },
      {
        type: 'threshold.evidence.collected',
        recordedAt: T0,
        payload: { evidenceId: 'e-1', criterionId: 'AUT-1', source: 'test', quality: 'strong', collectedAt: T0 },
      },
      {
        type: 'threshold.evidence.verified',
        recordedAt: T0,
        payload: { evidenceId: 'e-1', quality: 'verified', verifiedAt: T0, expiresAt: T0 },
      },
      {
        type: 'threshold.decision.proven',
        recordedAt: T0,
        payload: { decisionId: 'd-1', assessmentCount: 14, evidenceCount: 112, decidedAt: T0 },
      },
    ])
    expect(result.state.currentState).toBe('PROVEN')
    expect(result.state.lastDecision).toBe('proven')
  })

  it('folds a decision not-proven event', () => {
    const result = reduceThresholdState([
      {
        type: 'threshold.decision.not-proven',
        recordedAt: T0,
        payload: { decisionId: 'd-1', failedDimensions: 'autonomy|memory', reason: 'Insufficient evidence', decidedAt: T0 },
      },
    ])
    expect(result.state.currentState).toBe('UNPROVEN')
    expect(result.state.lastDecision).toBe('not-proven')
  })

  it('folds a rollback started event', () => {
    const result = reduceThresholdState([
      {
        type: 'threshold.rollback.started',
        recordedAt: T0,
        payload: { rollbackId: 'r-1', reason: 'authority-widening', startedAt: T0 },
      },
    ])
    expect(result.state.currentState).toBe('ROLLED_BACK')
    expect(result.state.rollbacks.length).toBe(1)
  })

  it('folds a fail-closed triggered event', () => {
    const result = reduceThresholdState([
      {
        type: 'threshold.assessment.started',
        recordedAt: T0,
        payload: { assessmentId: 'a-1', dimension: 'autonomy', startedAt: T0 },
      },
      {
        type: 'threshold.fail-closed.triggered',
        recordedAt: T0,
        payload: { recordId: 'fc-1', kind: 'ambiguity', reason: 'Wake source is ambiguous', triggeredAt: T0 },
      },
    ])
    expect(result.state.currentState).toBe('SUSPENDED')
    expect(result.state.failClosed.length).toBe(1)
  })

  it('folds a stop-all event', () => {
    const result = reduceThresholdState([
      {
        type: 'security.stop_all.activated',
        recordedAt: T0,
        payload: {},
      },
    ])
    expect(result.state.stopAllLatched).toBe(true)
    expect(result.state.currentState).toBe('SUSPENDED')
  })

  it('produces anomalies for unknown event types', () => {
    const result = reduceThresholdState([
      {
        type: 'threshold.unknown.event',
        recordedAt: T0,
        payload: {},
      },
    ])
    expect(result.anomalies.length).toBeGreaterThan(0)
  })

  it('produces anomalies for forbidden payload keys', () => {
    const result = reduceThresholdState([
      {
        type: 'threshold.assessment.started',
        recordedAt: T0,
        payload: { assessmentId: 'a-1', dimension: 'autonomy', startedAt: T0, realMoney: true },
      },
    ])
    expect(result.anomalies.length).toBeGreaterThan(0)
  })
})
