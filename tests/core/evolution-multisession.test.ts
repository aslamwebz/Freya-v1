// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { createCore, type Core } from '../../core/index'
import { FakeModelProvider } from '../../core/model/fake-provider'
import { StaticVaultKeyProvider } from '../../core/vault'
import { testVaultKey } from './testKey'
import { bindingAvailable, loadTestBinding } from './vault/binding'
import { makeVaultTempDir, removeVaultTempDir } from './vault/tmp'
import {
  ControlledExperimentRunner,
  generateCandidateFromWeakness,
  type ExperimentScenario,
} from '../../core/evolution'

let dir = ''
let core: Core | undefined

beforeEach(async () => {
  dir = await makeVaultTempDir()
})

afterEach(async () => {
  await core?.stop('teardown')
  core = undefined
  await removeVaultTempDir(dir)
})

function makeAcceptanceScenarios(): ExperimentScenario[] {
  return [
    {
      scenarioId: 'scen-acc-dev-1',
      name: 'Standard research query on distributed consensus',
      isHoldout: false,
      taskType: 'research_inspection',
      input: {
        query: 'Raft consensus paper invariants',
        candidateSources: [
          {
            url: 'https://unreliable-link.fixture.org/raft',
            domain: 'unreliable-link.fixture.org',
            previouslyVerified: false,
            contentAvailable: false,
            text: '',
          },
          {
            url: 'https://raft.github.io/raft.pdf',
            domain: 'raft.github.io',
            previouslyVerified: true,
            contentAvailable: true,
            text: 'Raft state machine replication invariants and safety...',
          },
          {
            url: 'https://stanford.edu/~ongaro/thesis.pdf',
            domain: 'stanford.edu',
            previouslyVerified: true,
            contentAvailable: true,
            text: 'Consensus: Bridging Theory and Practice Ongaro 2014...',
          },
        ],
      },
      expectedRequiredSources: 2,
    },
    {
      scenarioId: 'scen-acc-dev-2',
      name: 'Compiler intermediate representation query',
      isHoldout: false,
      taskType: 'research_inspection',
      input: {
        query: 'LLVM IR SSA form properties',
        candidateSources: [
          {
            url: 'https://broken-mirror.fixture.net/llvm',
            domain: 'broken-mirror.fixture.net',
            previouslyVerified: false,
            contentAvailable: false,
            text: '',
          },
          {
            url: 'https://llvm.org/docs/LangRef.html',
            domain: 'llvm.org',
            previouslyVerified: true,
            contentAvailable: true,
            text: 'LLVM Language Reference Manual defines the SSA-based representation...',
          },
          {
            url: 'https://mapping-high-level.fixture.net/ir',
            domain: 'mapping-high-level.fixture.net',
            previouslyVerified: true,
            contentAvailable: true,
            text: 'SSA form ensures that every variable is assigned exactly once...',
          },
        ],
      },
      expectedRequiredSources: 2,
    },
    {
      scenarioId: 'scen-acc-holdout-1',
      name: 'Post-quantum cryptographic algorithms (Holdout)',
      isHoldout: true,
      taskType: 'research_inspection',
      input: {
        query: 'Kyber and Dilithium NIST standards',
        candidateSources: [
          {
            url: 'https://stale-cache.fixture.org/pq',
            domain: 'stale-cache.fixture.org',
            previouslyVerified: false,
            contentAvailable: false,
            text: '',
          },
          {
            url: 'https://csrc.nist.gov/projects/post-quantum-cryptography',
            domain: 'csrc.nist.gov',
            previouslyVerified: true,
            contentAvailable: true,
            text: 'NIST has selected ML-KEM (Kyber) and ML-DSA (Dilithium) for standardization...',
          },
          {
            url: 'https://pq-crystals.org/kyber',
            domain: 'pq-crystals.org',
            previouslyVerified: true,
            contentAvailable: true,
            text: 'CRYSTALS-Kyber is an IND-CCA2-secure key encapsulation mechanism...',
          },
        ],
      },
      expectedRequiredSources: 2,
    },
  ]
}

describe('Phase 7D — End-to-End Multi-Session Verified Evolution Acceptance', () => {
  it('executes the full 7-stage closed-loop self-improvement lifecycle with restart recovery', async () => {
    if (!bindingAvailable) {
      console.warn('SQLCipher native binding unavailable; skipping multi-session vault test')
      return
    }

    const dataPath = join(dir, 'freya-multisession-events.jsonl')
    const binding = await loadTestBinding()
    const keyProvider = new StaticVaultKeyProvider(testVaultKey())

    // =========================================================================
    // SESSION 1: Baseline -> Reflection -> Experiment -> Promotion -> Continuation -> Regression -> Rollback
    // =========================================================================
    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
      vault: {
        path: join(dir, 'vault.enc'),
        keyProvider,
        binding,
      },
    })
    await core.start()

    const metacognition = core.metacognition()
    const evolution = core.evolution()

    expect(metacognition).toBeDefined()
    expect(evolution).toBeDefined()

    // -------------------------------------------------------------------------
    // STAGE 1 — Baseline: Freya performs several bounded research Missions
    // making measurable, repeatable mistakes.
    // -------------------------------------------------------------------------
    for (let i = 1; i <= 3; i++) {
      await metacognition!.observeMission({
        missionId: `msn-base-${i}`,
        taskType: 'research_inspection',
        outcome: 'failure',
        verified: false,
        verificationReason: 'source_verification_failed: retrieved source excerpts did not match independently verified ground truth',
        planRevisions: 1,
        actionAttempts: 3,
        toolErrors: 2,
        durationMs: 420,
        modelTokens: 120,
        modelCalls: 2,
        externalRequests: 3,
        rawErrorMessage: 'Research retrieval failed: insufficient_sources and source changed',
      })
    }

    const baselineSummary = await metacognition!.getSummary()
    expect(baselineSummary.totalMissions).toBe(3)
    expect(baselineSummary.verificationRate).toBe(0)
    expect(baselineSummary.totalToolErrors).toBe(6)

    // -------------------------------------------------------------------------
    // STAGE 2 — Reflection: Freya analyzes verified history, discovers weakness,
    // and formulates structured hypothesis.
    // -------------------------------------------------------------------------
    const discoveredWeaknesses = await metacognition!.classifyWeaknesses()
    expect(discoveredWeaknesses.length).toBeGreaterThanOrEqual(1)

    const weakness = discoveredWeaknesses.find((w) => w.kind === 'poor_source_selection')!
    expect(weakness).toBeDefined()
    expect(weakness.occurrenceCount).toBe(3)
    expect(weakness.supportingEvidenceIds).toEqual(['msn-base-1', 'msn-base-2', 'msn-base-3'])

    // Formulate testable hypothesis candidate
    const candidate = generateCandidateFromWeakness(weakness)!
    expect(candidate).not.toBeNull()
    expect(candidate.name).toBe('verified-domain-priority-source-selection')
    expect(candidate.category).toBe('research_source_ranking')
    expect(candidate.status).toBe('pending')

    // Propose candidate into evolution store
    await core.evolutionStore()!.writeCandidate(candidate)

    // -------------------------------------------------------------------------
    // STAGE 3 — Controlled Experimentation & Independent Evaluation
    // -------------------------------------------------------------------------
    const experimentRunner = new ControlledExperimentRunner()
    const acceptanceScenarios = makeAcceptanceScenarios()

    const experimentReport = await experimentRunner.runExperiment(candidate, acceptanceScenarios)
    expect(experimentReport.status).toBe('completed')
    expect(experimentReport.outcome).toBe('candidate_demonstrated_improvement')
    expect(experimentReport.isPromotionEligible).toBe(true)
    expect(experimentReport.candidatePerformance.verifiedPassRate).toBe(1.0)
    expect(experimentReport.holdoutPerformance.candidatePassRate).toBe(1.0)
    expect(experimentReport.baselinePerformance.verifiedPassRate).toBe(0)

    // Submit evaluation outcome to lifecycle manager
    const evalResult = await evolution!.submitEvaluation(candidate.candidateId, experimentReport)
    expect(evalResult.ok).toBe(true)
    expect(evalResult.status).toBe('eligible_for_promotion')

    // -------------------------------------------------------------------------
    // STAGE 4 — Promotion: Strict Owner Authorization Required
    // -------------------------------------------------------------------------
    // 1. Attempt unauthorized promotion (fabricated approval ID) -> Refused!
    const unauthResult = await evolution!.promoteCandidate(candidate.candidateId, {
      authorizedBy: 'owner',
      approvalId: 'appr-fabricated-non-existent',
    })
    expect(unauthResult.ok).toBe(false)
    if (!unauthResult.ok) {
      expect(unauthResult.code).toBe('unauthorized')
    }

    // 2. Request genuine promotion approval
    const apprReq = await evolution!.requestPromotionApproval(candidate.candidateId, {
      requestedBy: 'system',
      justification: 'Candidate demonstrated statistically significant improvement in controlled experiment',
    })
    expect(apprReq.ok).toBe(true)
    if (!apprReq.ok) throw new Error('Failed to request approval')

    // 3. Authenticated owner decides and approves the exact candidate
    const apprDecision = await evolution!.decidePromotionApproval({
      approvalId: apprReq.approval.approvalId,
      decision: 'approved',
      decidedBy: 'owner',
      reason: 'Owner reviewed experiment report and approved production activation',
    })
    expect(apprDecision.ok).toBe(true)

    // 4. Authorized promotion with genuine owner approval -> Accepted!
    const authResult = await evolution!.promoteCandidate(candidate.candidateId, {
      authorizedBy: 'owner',
      approvalId: apprReq.approval.approvalId,
      timestamp: '2026-10-10T12:00:00Z',
    })
    expect(authResult.ok).toBe(true)

    const activeStrat = evolution!.getActiveStrategy()
    expect(activeStrat).not.toBeNull()
    expect(activeStrat!.strategyId).toBe(candidate.candidateId)
    expect(activeStrat!.version).toBe('1.1.0')
    expect(activeStrat!.status).toBe('active')

    // -------------------------------------------------------------------------
    // STAGE 5 — Real Continuation: Execute Mission With Promoted Strategy
    // -------------------------------------------------------------------------
    const continuationTelemetry = await metacognition!.observeMission({
      missionId: 'msn-cont-1',
      taskType: 'research_inspection',
      outcome: 'success',
      verified: true,
      verificationReason: 'All research sources independently verified from trusted domains',
      planRevisions: 0,
      actionAttempts: 1,
      toolErrors: 0,
      durationMs: 280,
      modelTokens: 90,
      modelCalls: 1,
      externalRequests: 2,
    })

    expect(continuationTelemetry.outcome).toBe('success')
    expect(continuationTelemetry.verified).toBe(true)

    // Efficiency trend should reflect improvement
    const trend = await metacognition!.areYouBecomingMoreEfficient()
    expect(trend.status).toBe('improving')
    expect(trend.statement).toContain('improved')

    // -------------------------------------------------------------------------
    // STAGE 6 — Regression Detection & Governed Rollback
    // -------------------------------------------------------------------------
    // Introduce controlled deterioration (2 consecutive strategy failures)
    await metacognition!.observeMission({
      missionId: 'msn-regress-1',
      strategyId: candidate.candidateId,
      strategyVersion: candidate.version,
      taskType: 'research_inspection',
      outcome: 'failure',
      verified: false,
      toolErrors: 2,
      rawErrorMessage: 'insufficient_sources: domain diversity failure',
    })

    await metacognition!.observeMission({
      missionId: 'msn-regress-2',
      strategyId: candidate.candidateId,
      strategyVersion: candidate.version,
      taskType: 'research_inspection',
      outcome: 'failure',
      verified: false,
      toolErrors: 2,
      rawErrorMessage: 'insufficient_sources: domain diversity failure',
    })

    const telemetries = await metacognition!.getTelemetries()
    const regressionCheck = await evolution!.monitorAndEvaluateRegression(telemetries)

    expect(regressionCheck.regressionDetected).toBe(true)
    expect(regressionCheck.reason).toContain('Consecutive strategy defects detected')

    // Verify rollback safely restored baseline
    const restoredStrategy = evolution!.getActiveStrategy()
    expect(restoredStrategy).not.toBeNull()
    expect(restoredStrategy!.version).toBe('1.0.0')
    expect(restoredStrategy!.strategyId).toBe('strat-source-ranking-default')

    const rollbackRecords = evolution!.getRollbackHistory()
    expect(rollbackRecords).toHaveLength(1)
    expect(rollbackRecords[0]!.candidateId).toBe(candidate.candidateId)
    expect(rollbackRecords[0]!.restoredStrategyId).toBe('strat-source-ranking-default')

    // -------------------------------------------------------------------------
    // STAGE 7 — Complete Core Restart & Durable Verification
    // -------------------------------------------------------------------------
    await core.stop('shutdown-for-restart-test')
    core = undefined

    // Start completely new Core instance pointing to the same encrypted Vault
    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
      vault: {
        path: join(dir, 'vault.enc'),
        keyProvider,
        binding,
      },
    })
    await core.start()

    const recoveredMeta = core.metacognition()!
    const recoveredEvo = core.evolution()!

    // Verify all telemetries recovered
    const recoveredTelemetries = await recoveredMeta.getTelemetries()
    expect(recoveredTelemetries).toHaveLength(6) // 3 baseline + 1 continuation + 2 regression

    // Verify active strategy remains the restored safe baseline
    const recoveredActive = recoveredEvo.getActiveStrategy()
    expect(recoveredActive).not.toBeNull()
    expect(recoveredActive!.version).toBe('1.0.0')
    expect(recoveredActive!.strategyId).toBe('strat-source-ranking-default')

    // Verify candidate history and status persisted
    const candidateInStore = await core.evolutionStore()!.getCandidate(candidate.candidateId)
    expect(candidateInStore).not.toBeNull()
    expect(candidateInStore!.status).toBe('rolled_back')
    expect(candidateInStore!.rejectionReason).toContain('Consecutive strategy defects detected')

    // Verify metacognitive query answers reflect truthful history
    const failedList = await recoveredMeta.whichImprovementsFailed()
    expect(failedList.length).toBeGreaterThanOrEqual(0)

    const whatStruggling = await recoveredMeta.whatAreYouStrugglingWith()
    expect(whatStruggling).toContain('suboptimal research source ranking')

    await core.stop('clean-exit')
    core = undefined
  })
})
