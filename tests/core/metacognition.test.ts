// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  MetacognitionEngine,
  MemoryMetacognitionStore,
  attributeFailure,
} from '../../core/metacognition'
import { VaultMetacognitionStore } from '../../core/vault/repositories/metacognition-store'
import { StaticVaultKeyProvider, Vault, type VaultKeyProvider } from '../../core/vault'
import { testVaultKey } from './testKey'
import { bindingAvailable, loadTestBinding } from './vault/binding'
import { makeVaultTempDir, removeVaultTempDir } from './vault/tmp'

let dir = ''
const opened: Vault[] = []

beforeEach(async () => {
  dir = await makeVaultTempDir()
  opened.length = 0
})

afterEach(async () => {
  for (const vault of opened.splice(0)) {
    try {
      vault.close()
    } catch {
      // ignore
    }
  }
  await removeVaultTempDir(dir)
})

async function openVault(path: string, keyProvider: VaultKeyProvider): Promise<Vault> {
  const vault = await Vault.open({ path, keyProvider, binding: await loadTestBinding() })
  opened.push(vault)
  return vault
}

describe('Phase 7A — Metacognition & Performance Awareness', () => {
  describe('7A.2 — Performance Observation & Zero Fabricated Telemetry', () => {
    it('accurately records mission outcomes and leaves missing telemetry as strictly null', async () => {
      const store = new MemoryMetacognitionStore()
      const engine = new MetacognitionEngine({ store })

      const telemetry = await engine.observeMission({
        missionId: 'msn-test-1',
        taskType: 'research',
        outcome: 'success',
        verified: true,
        verificationReason: 'Sources verified by independent check',
        planRevisions: 0,
        actionAttempts: 2,
        toolErrors: 0,
        // Omit durationMs, modelTokens, modelCalls, externalRequests
      })

      expect(telemetry.missionId).toBe('msn-test-1')
      expect(telemetry.outcome).toBe('success')
      expect(telemetry.verified).toBe(true)
      expect(telemetry.durationMs).toBeNull()
      expect(telemetry.modelTokens).toBeNull()
      expect(telemetry.modelCalls).toBeNull()
      expect(telemetry.externalRequests).toBeNull()
      expect(telemetry.failureAttribution).toBeNull()

      const summary = await engine.getSummary()
      expect(summary.totalMissions).toBe(1)
      expect(summary.successRate).toBe(1.0)
      expect(summary.verificationRate).toBe(1.0)
      expect(summary.telemetryCoverage.hasTokenTelemetry).toBe(false)
      expect(summary.telemetryCoverage.hasLatencyTelemetry).toBe(false)
    })

    it('preserves measured telemetry when provided without distortion', async () => {
      const store = new MemoryMetacognitionStore()
      const engine = new MetacognitionEngine({ store })

      await engine.observeMission({
        missionId: 'msn-test-2',
        taskType: 'code_review',
        outcome: 'success',
        verified: true,
        durationMs: 1420,
        modelTokens: 350,
        modelCalls: 2,
        externalRequests: 1,
      })

      const telemetries = await engine.getTelemetries()
      expect(telemetries).toHaveLength(1)
      expect(telemetries[0]!.durationMs).toBe(1420)
      expect(telemetries[0]!.modelTokens).toBe(350)
      expect(telemetries[0]!.modelCalls).toBe(2)
      expect(telemetries[0]!.externalRequests).toBe(1)

      const summary = await engine.getSummary()
      expect(summary.telemetryCoverage.hasTokenTelemetry).toBe(true)
      expect(summary.telemetryCoverage.hasLatencyTelemetry).toBe(true)
      expect(summary.telemetryCoverage.hasExternalRequestTelemetry).toBe(true)
    })
  })

  describe('7A.3 — Failure Attribution: Strategy vs Environmental / Tool Outages', () => {
    it('separates environmental and network disruptions from strategy defects', () => {
      const networkAttr = attributeFailure('Network timeout while connecting to provider endpoint: fetch failed')
      expect(networkAttr).not.toBeNull()
      expect(networkAttr!.category).toBe('environmental')
      expect(networkAttr!.isStrategyDefect).toBe(false)

      const outageAttr = attributeFailure('HTTP 503 service unavailable from external search API')
      expect(outageAttr).not.toBeNull()
      expect(outageAttr!.category).toBe('tool_outage')
      expect(outageAttr!.isStrategyDefect).toBe(false)

      const denialAttr = attributeFailure('Guard denied access: unauthorized host access')
      expect(denialAttr).not.toBeNull()
      expect(denialAttr!.category).toBe('external_denial')
      expect(denialAttr!.isStrategyDefect).toBe(false)
    })

    it('correctly identifies strategy defects and model planning misdirections', () => {
      const strategyAttr = attributeFailure('Research retrieval could not establish enough authorized sources: insufficient_sources')
      expect(strategyAttr).not.toBeNull()
      expect(strategyAttr!.category).toBe('strategy_defect')
      expect(strategyAttr!.isStrategyDefect).toBe(true)

      const modelAttr = attributeFailure('Model planning error: invalid_plan schema mismatch')
      expect(modelAttr).not.toBeNull()
      expect(modelAttr!.category).toBe('model_misdirection')
      expect(modelAttr!.isStrategyDefect).toBe(true)
    })
  })

  describe('7A.4 — Weakness Identification & Statistical Restraint', () => {
    it('does not classify an isolated single failure as a recurring weakness', async () => {
      const store = new MemoryMetacognitionStore()
      const engine = new MetacognitionEngine({ store })

      await engine.observeMission({
        missionId: 'msn-fail-1',
        taskType: 'research',
        outcome: 'failure',
        verified: false,
        rawErrorMessage: 'insufficient_sources for query',
      })

      const weaknesses = await engine.classifyWeaknesses()
      expect(weaknesses).toHaveLength(0)
    })

    it('does not classify repeated environmental outages as strategy weaknesses', async () => {
      const store = new MemoryMetacognitionStore()
      const engine = new MetacognitionEngine({ store })

      // 3 environmental failures
      for (let i = 1; i <= 3; i++) {
        await engine.observeMission({
          missionId: `msn-env-${i}`,
          taskType: 'research',
          outcome: 'failure',
          verified: false,
          rawErrorMessage: 'fetch failed: connection refused ECONNREFUSED',
        })
      }

      const weaknesses = await engine.classifyWeaknesses()
      expect(weaknesses).toHaveLength(0)
    })

    it('identifies recurring poor source selection when >= 2 strategy defects occur', async () => {
      const store = new MemoryMetacognitionStore()
      const engine = new MetacognitionEngine({ store })

      await engine.observeMission({
        missionId: 'msn-src-1',
        taskType: 'research',
        outcome: 'failure',
        verified: false,
        rawErrorMessage: 'Research retrieval failed: insufficient_sources',
      })

      await engine.observeMission({
        missionId: 'msn-src-2',
        taskType: 'research',
        outcome: 'failure',
        verified: false,
        rawErrorMessage: 'Independent source rereads failed: source changed',
      })

      const weaknesses = await engine.classifyWeaknesses()
      expect(weaknesses).toHaveLength(1)
      expect(weaknesses[0]!.kind).toBe('poor_source_selection')
      expect(weaknesses[0]!.occurrenceCount).toBe(2)
      expect(weaknesses[0]!.supportingEvidenceIds).toEqual(['msn-src-1', 'msn-src-2'])
      expect(weaknesses[0]!.confidence).toBe('preliminary')
      expect(weaknesses[0]!.causalEvidenceStatus).toBe('insufficient_evidence')
    })

    it('upgrades confidence to moderate and correlated as occurrences grow', async () => {
      const store = new MemoryMetacognitionStore()
      const engine = new MetacognitionEngine({ store })

      for (let i = 1; i <= 4; i++) {
        await engine.observeMission({
          missionId: `msn-replan-${i}`,
          taskType: 'complex_task',
          outcome: 'success',
          verified: true,
          planRevisions: 2,
        })
      }

      const weaknesses = await engine.classifyWeaknesses()
      const replanWeakness = weaknesses.find((w) => w.kind === 'unnecessary_replanning')
      expect(replanWeakness).toBeDefined()
      expect(replanWeakness!.occurrenceCount).toBe(4)
      expect(replanWeakness!.confidence).toBe('moderate')
      expect(replanWeakness!.causalEvidenceStatus).toBe('correlated')
    })
  })

  describe('7A.5 — Metacognitive Reporting (Strictly 0 Model Calls)', () => {
    it('answers metacognitive queries grounded in factual records and reports insufficient data when sample is small', async () => {
      const store = new MemoryMetacognitionStore()
      const engine = new MetacognitionEngine({ store })

      // Initial state: no data
      const trendInitial = await engine.areYouBecomingMoreEfficient()
      expect(trendInitial.status).toBe('insufficient_data')
      expect(trendInitial.statement).toContain('sample size < 4')

      // Add 2 source selection failures
      await engine.observeMission({
        missionId: 'msn-s-1',
        taskType: 'research',
        outcome: 'failure',
        verified: false,
        rawErrorMessage: 'insufficient_sources',
      })
      await engine.observeMission({
        missionId: 'msn-s-2',
        taskType: 'research',
        outcome: 'failure',
        verified: false,
        rawErrorMessage: 'source_verification_failed',
      })
      await engine.classifyWeaknesses()

      const struggling = await engine.whatAreYouStrugglingWith()
      expect(struggling).toContain('suboptimal research source ranking')

      const nextTarget = await engine.whatShouldWeImproveNext()
      expect(nextTarget).not.toBeNull()
      expect(nextTarget!.kind).toBe('poor_source_selection')

      const evidence = await engine.whatEvidenceSupportsThat('weakness-poor-source-selection')
      expect(evidence).toHaveLength(2)
      expect(evidence.map((e) => e.missionId)).toEqual(['msn-s-1', 'msn-s-2'])
    })

    it('tracks active and failed improvements in metacognitive reports', async () => {
      const store = new MemoryMetacognitionStore()
      const engine = new MetacognitionEngine({ store })

      await engine.recordActiveStrategy({
        strategyId: 'strat-source-rank-v1',
        name: 'prioritize-verified-domain-sources',
        kind: 'research_source_ranking',
        version: '1.0.0',
        status: 'active',
        activatedAt: '2026-10-10T12:00:00Z',
      })

      await engine.recordFailedImprovement({
        strategyId: 'strat-aggressive-crawl-v1',
        name: 'aggressive-source-concurrency',
        reason: 'Redundant rate limit errors observed during trial',
        failedAt: '2026-10-10T12:10:00Z',
        candidateVersion: '0.9.0',
      })

      const active = await engine.whatHaveYouImproved()
      expect(active).toHaveLength(1)
      expect(active[0]!.strategyId).toBe('strat-source-rank-v1')

      const failed = await engine.whichImprovementsFailed()
      expect(failed).toHaveLength(1)
      expect(failed[0]!.strategyId).toBe('strat-aggressive-crawl-v1')
    })
  })

  describe('7A.6 — Durable Encrypted Vault Persistence & Restart Recovery', () => {
    it('persists telemetries and weaknesses across restart with SQLCipher Vault', async () => {
      if (!bindingAvailable) {
        console.warn('SQLCipher binding unavailable; skipping vault persistence test')
        return
      }

      const dbPath = join(dir, 'freya-metacognition-vault.db')
      const keyProvider = new StaticVaultKeyProvider(testVaultKey())

      // Session 1: write telemetries and classify weaknesses
      const vault1 = await openVault(dbPath, keyProvider)
      const store1 = new VaultMetacognitionStore(vault1)
      const engine1 = new MetacognitionEngine({ store: store1 })

      await engine1.observeMission({
        missionId: 'msn-v-1',
        taskType: 'research',
        outcome: 'failure',
        verified: false,
        rawErrorMessage: 'insufficient_sources',
      })
      await engine1.observeMission({
        missionId: 'msn-v-2',
        taskType: 'research',
        outcome: 'failure',
        verified: false,
        rawErrorMessage: 'source_verification_failed',
      })

      await engine1.classifyWeaknesses()
      await engine1.recordActiveStrategy({
        strategyId: 'strat-durable-1',
        name: 'durable-strategy-test',
        kind: 'test',
        version: '1.0.0',
        status: 'active',
        activatedAt: '2026-10-10T12:00:00Z',
      })

      await engine1.close()
      vault1.close()

      // Session 2: reopen Vault and verify state recovery
      const vault2 = await openVault(dbPath, keyProvider)
      const store2 = new VaultMetacognitionStore(vault2)
      const engine2 = new MetacognitionEngine({ store: store2 })

      const recoveredTelemetries = await engine2.getTelemetries()
      expect(recoveredTelemetries).toHaveLength(2)
      expect(recoveredTelemetries.map((t) => t.missionId).sort()).toEqual(['msn-v-1', 'msn-v-2'])

      const summary = await engine2.getSummary()
      expect(summary.totalMissions).toBe(2)
      expect(summary.knownWeaknesses).toHaveLength(1)
      expect(summary.knownWeaknesses[0]!.kind).toBe('poor_source_selection')

      const active = await engine2.whatHaveYouImproved()
      expect(active).toHaveLength(1)
      expect(active[0]!.strategyId).toBe('strat-durable-1')

      await engine2.close()
    })
  })
})
