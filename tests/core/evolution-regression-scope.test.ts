// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { StrategyLifecycleManager } from '../../core/evolution/lifecycle'
import { MemoryEvolutionStore } from '../../core/evolution/store'
import { generateCandidateFromWeakness } from '../../core/evolution/strategy'
import { MetacognitionEngine } from '../../core/metacognition/engine'
import { MemoryMetacognitionStore } from '../../core/metacognition/store'

const activation = '2026-10-10T13:00:00.000Z'
const observed = '2026-10-10T14:00:00.000Z'

async function fixture() {
  const evolution = new MemoryEvolutionStore()
  const metacognition = new MemoryMetacognitionStore()
  const candidate = generateCandidateFromWeakness({
    weaknessId: 'weak-1',
    kind: 'poor_source_selection',
    description: 'Poor source selection verified in several missions',
    occurrenceCount: 3,
    supportingEvidenceIds: ['mission-1', 'mission-2', 'mission-3'],
    confidence: 'moderate',
    causalEvidenceStatus: 'correlated',
    sampleSize: 3,
    firstObservedAt: activation,
    lastObservedAt: observed,
  })!
  await evolution.writeCandidate({ ...candidate, status: 'promoted' })
  await metacognition.writeActiveStrategy({
    strategyId: candidate.candidateId,
    name: candidate.name,
    kind: candidate.category,
    version: candidate.version,
    status: 'active',
    activatedAt: activation,
    rollbackTargetVersion: candidate.baselineStrategyId,
    parameters: candidate.parameters,
  })
  const lifecycle = new StrategyLifecycleManager(evolution, metacognition)
  await lifecycle.initialize()
  const observer = new MetacognitionEngine({ store: metacognition })

  async function failure(
    missionId: string,
    overrides: { strategyId?: string | null; strategyVersion?: string | null; message?: string; recordedAt?: string } = {},
  ) {
    return observer.observeMission({
      missionId,
      taskType: 'research',
      strategyId: overrides.strategyId === undefined ? candidate.candidateId : overrides.strategyId,
      strategyVersion: overrides.strategyVersion === undefined ? candidate.version : overrides.strategyVersion,
      outcome: 'failure',
      verified: false,
      rawErrorMessage: overrides.message ?? 'insufficient_sources: poor source selection',
      recordedAt: overrides.recordedAt ?? observed,
    })
  }

  return { lifecycle, observer, candidate, failure }
}

describe('Phase 7 hardening ? regression evidence attribution', () => {
  it('does not roll back a strategy for unrelated missions or different strategy versions', async () => {
    const { lifecycle, candidate, failure } = await fixture()
    const records = [
      await failure('unrelated', { strategyId: null, strategyVersion: null }),
      await failure('other', { strategyId: 'other-strategy' }),
      await failure('stale', { strategyVersion: '0.0.1' }),
      await failure('before-activation', { recordedAt: '2026-10-10T12:00:00.000Z' }),
    ]
    expect((await lifecycle.monitorAndEvaluateRegression(records)).regressionDetected).toBe(false)
    expect(lifecycle.getActiveStrategy()?.strategyId).toBe(candidate.candidateId)
    expect(lifecycle.getRollbackHistory()).toHaveLength(0)
  })

  it('does not interpret an ordinary Guard/owner denial as a strategy defect', async () => {
    const { lifecycle, candidate, failure } = await fixture()
    const records = [
      await failure('denied-1', { message: 'owner denied approval' }),
      await failure('denied-2', { message: 'owner denied approval' }),
    ]
    expect((await lifecycle.monitorAndEvaluateRegression(records)).regressionDetected).toBe(false)
    expect(lifecycle.getActiveStrategy()?.strategyId).toBe(candidate.candidateId)
  })

  it('requires distinct consecutive strategy-specific failures and rolls back exactly once', async () => {
    const { lifecycle, candidate, failure } = await fixture()
    const first = await failure('mission-1')
    expect((await lifecycle.monitorAndEvaluateRegression([first])).regressionDetected).toBe(false)
    expect((await lifecycle.monitorAndEvaluateRegression([first, first])).regressionDetected).toBe(false)
    const second = await failure('mission-2')
    const result = await lifecycle.monitorAndEvaluateRegression([first, second])
    expect(result.regressionDetected).toBe(true)
    expect(result.reason).toContain('Consecutive strategy defects')
    expect(lifecycle.getActiveStrategy()?.strategyId).toBe(candidate.baselineStrategyId)
    expect((await lifecycle.monitorAndEvaluateRegression([first, second])).regressionDetected).toBe(false)
    expect(lifecycle.getRollbackHistory()).toHaveLength(1)
  })
})
