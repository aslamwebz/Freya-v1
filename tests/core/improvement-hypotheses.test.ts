// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  generateCandidateFromWeakness,
  validateCandidateProposal,
  MemoryEvolutionStore,
  type StrategyCandidate,
} from '../../core/evolution'
import { VaultEvolutionStore } from '../../core/vault/repositories/evolution-store'
import type { WeaknessRecord } from '../../core/metacognition'
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

function makeMockWeakness(overrides?: Partial<WeaknessRecord>): WeaknessRecord {
  return {
    weaknessId: 'weakness-source-sel-1',
    kind: 'poor_source_selection',
    description: 'Suboptimal source ranking causing retrieval failures',
    occurrenceCount: 3,
    supportingEvidenceIds: ['msn-obs-1', 'msn-obs-2', 'msn-obs-3'],
    confidence: 'moderate',
    causalEvidenceStatus: 'correlated',
    sampleSize: 5,
    firstObservedAt: '2026-10-10T11:00:00Z',
    lastObservedAt: '2026-10-10T12:00:00Z',
    ...overrides,
  }
}

describe('Phase 7B — Hypothesis Generation & Strategy Design', () => {
  describe('7B.1 & 7B.4 — Evidence-Backed Proposal Generation & Structured Hypotheses', () => {
    it('generates a concrete, versioned candidate from an observed weakness with structured hypothesis', () => {
      const weakness = makeMockWeakness()
      const candidate = generateCandidateFromWeakness(weakness)

      expect(candidate).not.toBeNull()
      expect(candidate!.category).toBe('research_source_ranking')
      expect(candidate!.weaknessId).toBe(weakness.weaknessId)
      expect(candidate!.supportingEvidenceIds).toEqual(weakness.supportingEvidenceIds)
      expect(candidate!.version).toBe('1.1.0')
      expect(candidate!.status).toBe('pending')
      expect(candidate!.requiredAuthorization).toBe('owner')

      // Structured Hypothesis
      expect(candidate!.structuredHypothesis.hypothesis).toContain(
        'Prioritizing verified domain sources',
      )
      expect(candidate!.structuredHypothesis.candidate).toContain('v1.1.0')
      expect(candidate!.structuredHypothesis.acceptanceCriteria).toBeDefined()

      // Measurable criteria
      expect(candidate!.measurementCriteria.length).toBeGreaterThan(0)
      expect(candidate!.rollbackMechanism.targetStrategyId).toBe('strat-source-ranking-default')

      // Validates successfully
      const validation = validateCandidateProposal(candidate!)
      expect(validation.valid).toBe(true)
    })

    it('refuses to generate proposal when weakness lacks sufficient evidence', () => {
      const weaknessWith1 = makeMockWeakness({
        occurrenceCount: 1,
        supportingEvidenceIds: ['msn-obs-1'],
      })
      const candidate = generateCandidateFromWeakness(weaknessWith1)
      expect(candidate).toBeNull()
    })
  })

  describe('7B.2, 7B.3 & 7B.5 — Candidate Validation & Security Boundaries', () => {
    it('strictly refuses proposals attempting prohibited security modifications', () => {
      const candidate = generateCandidateFromWeakness(makeMockWeakness())!

      // 1. Guard modification attempt
      const guardTampering: StrategyCandidate = {
        ...candidate,
        proposedChange: 'Bypass guard security check for faster downloads',
      }
      const val1 = validateCandidateProposal(guardTampering)
      expect(val1.valid).toBe(false)
      if (!val1.valid) expect(val1.code).toBe('prohibited_security_modification')

      // 2. Self-modification of code
      const codeMutation: StrategyCandidate = {
        ...candidate,
        name: 'self-modify-runtime-engine',
        proposedChange: 'Modify code in core/missions/engine.ts dynamically',
      }
      const val2 = validateCandidateProposal(codeMutation)
      expect(val2.valid).toBe(false)
      if (!val2.valid) expect(val2.code).toBe('prohibited_security_modification')

      // 3. Governor spending override
      const budgetTampering: StrategyCandidate = {
        ...candidate,
        parameters: { unlimited_budget: true },
      }
      const val3 = validateCandidateProposal(budgetTampering)
      expect(val3.valid).toBe(false)
      if (!val3.valid) expect(val3.code).toBe('prohibited_security_modification')

      // 4. STOP ALL clearing
      const stopAllTampering: StrategyCandidate = {
        ...candidate,
        proposedChange: 'Clear stop-all latch automatically on wake',
      }
      const val4 = validateCandidateProposal(stopAllTampering)
      expect(val4.valid).toBe(false)
      if (!val4.valid) expect(val4.code).toBe('prohibited_security_modification')
    })

    it('refuses vague or unmeasurable proposals', () => {
      const candidate = generateCandidateFromWeakness(makeMockWeakness())!

      // Vague proposal
      const vague: StrategyCandidate = {
        ...candidate,
        proposedChange: 'Try to be smarter and reason harder on queries',
      }
      const val1 = validateCandidateProposal(vague)
      expect(val1.valid).toBe(false)
      if (!val1.valid) expect(val1.code).toBe('vague_proposal')

      // Unmeasurable proposal
      const unmeasurable: StrategyCandidate = {
        ...candidate,
        measurementCriteria: [],
      }
      const val2 = validateCandidateProposal(unmeasurable)
      expect(val2.valid).toBe(false)
      if (!val2.valid) expect(val2.code).toBe('unmeasurable_proposal')
    })

    it('refuses proposals with missing rollback mechanisms', () => {
      const candidate = generateCandidateFromWeakness(makeMockWeakness())!
      const noRollback: StrategyCandidate = {
        ...candidate,
        rollbackMechanism: {
          targetStrategyId: '',
          targetParameters: {},
          verificationTest: '',
        },
      }
      const val = validateCandidateProposal(noRollback)
      expect(val.valid).toBe(false)
      if (!val.valid) expect(val.code).toBe('missing_rollback_path')
    })

    it('refuses proposals relying on retracted or invalidated evidence', () => {
      const candidate = generateCandidateFromWeakness(makeMockWeakness())!
      const invalidSet = new Set(['msn-obs-2']) // msn-obs-2 retracted

      const val = validateCandidateProposal(candidate, {
        invalidEvidenceIds: invalidSet,
      })
      expect(val.valid).toBe(false)
      if (!val.valid) expect(val.code).toBe('retracted_supporting_evidence')
    })

    it('detects and rejects duplicate active candidates for the same weakness and version', () => {
      const candidate1 = generateCandidateFromWeakness(makeMockWeakness())!
      const candidate2: StrategyCandidate = {
        ...candidate1,
        candidateId: 'cand-strat-source-ranking-duplicate',
      }

      const val = validateCandidateProposal(candidate2, {
        existingCandidates: [candidate1],
      })
      expect(val.valid).toBe(false)
      if (!val.valid) expect(val.code).toBe('duplicate_candidate')
    })
  })

  describe('7B.6 — Candidate Persistence & Restart Recovery', () => {
    it('persists and recovers strategy candidates across restarts using encrypted Vault', async () => {
      if (!bindingAvailable) {
        console.warn('SQLCipher binding unavailable; skipping vault candidate persistence test')
        return
      }

      const dbPath = join(dir, 'freya-evolution-vault.db')
      const keyProvider = new StaticVaultKeyProvider(testVaultKey())

      // Session 1: Store candidate
      const vault1 = await openVault(dbPath, keyProvider)
      const store1 = new VaultEvolutionStore(vault1)

      const candidate = generateCandidateFromWeakness(makeMockWeakness())!
      await store1.writeCandidate(candidate)
      await store1.updateCandidateStatus(candidate.candidateId, 'approved_for_experiment')

      await store1.close()
      vault1.close()

      // Session 2: Recover candidate
      const vault2 = await openVault(dbPath, keyProvider)
      const store2 = new VaultEvolutionStore(vault2)

      const candidates = await store2.readCandidates()
      expect(candidates).toHaveLength(1)
      expect(candidates[0]!.candidateId).toBe(candidate.candidateId)
      expect(candidates[0]!.status).toBe('approved_for_experiment')
      expect(candidates[0]!.parameters).toEqual(candidate.parameters)
      expect(candidates[0]!.structuredHypothesis.hypothesis).toBe(
        candidate.structuredHypothesis.hypothesis,
      )

      await store2.close()
    })

    it('in-memory store functions correctly without durable storage', async () => {
      const store = new MemoryEvolutionStore()
      const candidate = generateCandidateFromWeakness(makeMockWeakness())!

      await store.writeCandidate(candidate)
      const retrieved = await store.getCandidate(candidate.candidateId)
      expect(retrieved).not.toBeNull()
      expect(retrieved!.candidateId).toBe(candidate.candidateId)

      await store.updateCandidateStatus(candidate.candidateId, 'under_evaluation')
      const updated = await store.getCandidate(candidate.candidateId)
      expect(updated!.status).toBe('under_evaluation')

      await store.deleteCandidate(candidate.candidateId)
      const deleted = await store.getCandidate(candidate.candidateId)
      expect(deleted).toBeNull()
    })
  })
})
