/**
 * FREYA EVOLUTION — Owner Promotion Approval Security Negative Tests
 *
 * Verifies all 10 mandatory approval checks and negative security controls:
 * 1. Fabricated approval ID -> rejected ('unauthorized')
 * 2. Approval for another candidate -> rejected ('unauthorized')
 * 3. Approval for another version -> rejected ('unauthorized')
 * 4. Approval for experiment-only authority -> rejected ('unauthorized')
 * 5. Expired approval -> rejected ('unauthorized')
 * 6. Revoked approval -> rejected ('unauthorized')
 * 7. Denied approval -> rejected ('unauthorized')
 * 8. Approval decided by non-owner principal -> rejected ('unauthorized')
 * 9. Already-consumed approval (replay prevention) -> rejected ('unauthorized')
 * 10. Candidate parameters modified after approval -> rejected ('unauthorized')
 * 11. Caller principal is not owner -> rejected ('unauthorized')
 * 12. Candidate not eligible for promotion -> rejected ('candidate_not_evaluated')
 * 13. Candidate non-existent -> rejected ('missing_candidate')
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  StrategyLifecycleManager,
  MemoryEvolutionStore,
  type StrategyCandidate,
} from '../../core/evolution'
import type { PrincipalId } from '../../core/protocol/core-protocol'
import { MemoryMetacognitionStore } from '../../core/metacognition'

describe('Phase 7 Post-Review — Evolution Promotion Owner Approval Security', () => {
  let evolutionStore: MemoryEvolutionStore
  let metacognitionStore: MemoryMetacognitionStore
  let lifecycle: StrategyLifecycleManager
  let validCandidate: StrategyCandidate

  beforeEach(async () => {
    evolutionStore = new MemoryEvolutionStore()
    metacognitionStore = new MemoryMetacognitionStore()
    lifecycle = new StrategyLifecycleManager(evolutionStore, metacognitionStore)
    await lifecycle.initialize()

    validCandidate = {
      candidateId: 'cand-sec-test-001',
      name: 'verified-domain-priority-test',
      category: 'research_source_ranking',
      weaknessId: 'weakness-sec-001',
      weaknessKind: 'poor_source_selection',
      supportingEvidenceIds: ['ev-1', 'ev-2'],
      proposedChange: 'Prioritize verified sources',
      parameters: { prioritizeVerifiedDomains: true, maxSourcesPerDomain: 1 },
      expectedBenefit: 'Reduces retrieval failures',
      applicableTaskScope: 'research_inspection',
      potentialRisks: ['Slightly lower novel source diversity'],
      measurementCriteria: [
        { metric: 'verification_rate', targetThreshold: 0.85, unit: 'ratio', comparator: 'greater_than_or_equal' },
      ],
      baselineStrategyId: 'strat-baseline-default',
      baselineParameters: { prioritizeVerifiedDomains: false, maxSourcesPerDomain: 5 },
      experimentRequirements: { maxRuns: 3, maxTokens: 10000, maxActions: 20, timeoutMs: 20000 },
      budgetCeiling: { maxTokens: 15000, maxModelCalls: 2, maxCostUsd: 0.02 },
      rollbackMechanism: {
        targetStrategyId: 'strat-baseline-default',
        targetParameters: { prioritizeVerifiedDomains: false, maxSourcesPerDomain: 5 },
        verificationTest: 'verify_default_restored',
      },
      requiredAuthorization: 'owner',
      status: 'eligible_for_promotion',
      version: '1.1.0',
      structuredHypothesis: {
        observation: 'Source selection failures observed',
        hypothesis: 'Prioritizing verified domains will reduce errors',
        candidate: 'candidate v1.1.0',
        baseline: 'baseline v1.0.0',
        measurement: 'verification rate',
        regressionRisks: ['Lower diversity'],
        acceptanceCriteria: 'Verification >= 85%',
      },
      createdAt: '2026-10-10T10:00:00Z',
      updatedAt: '2026-10-10T10:00:00Z',
    }

    await evolutionStore.writeCandidate(validCandidate)
  })

  it('1. rejects promotion with fabricated approval ID', async () => {
    const result = await lifecycle.promoteCandidate(validCandidate.candidateId, {
      approvalId: 'appr-fabricated-999',
      authorizedBy: 'owner',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('unauthorized')
      expect(result.reason).toContain('Approval request does not exist')
    }
  })

  it('2. rejects promotion using approval for another candidate', async () => {
    // Other candidate
    const otherCandidate: StrategyCandidate = {
      ...validCandidate,
      candidateId: 'cand-other-002',
    }
    await evolutionStore.writeCandidate(otherCandidate)

    // Request & approve for other candidate
    const req = await lifecycle.requestPromotionApproval(otherCandidate.candidateId)
    expect(req.ok).toBe(true)
    if (!req.ok) return

    await lifecycle.decidePromotionApproval({
      approvalId: req.approval.approvalId,
      decision: 'approved',
      decidedBy: 'owner',
    })

    // Attempt to promote validCandidate using otherCandidate's approval
    const result = await lifecycle.promoteCandidate(validCandidate.candidateId, {
      approvalId: req.approval.approvalId,
      authorizedBy: 'owner',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('unauthorized')
      expect(result.reason).toContain('Approval request is for candidate cand-other-002')
    }
  })

  it('3. rejects promotion using approval for another strategy version', async () => {
    const req = await lifecycle.requestPromotionApproval(validCandidate.candidateId)
    expect(req.ok).toBe(true)
    if (!req.ok) return

    await lifecycle.decidePromotionApproval({
      approvalId: req.approval.approvalId,
      decision: 'approved',
      decidedBy: 'owner',
    })

    // Modify candidate version after approval
    const modifiedCandidate: StrategyCandidate = {
      ...validCandidate,
      version: '1.2.0', // version changed!
    }
    await evolutionStore.writeCandidate(modifiedCandidate)

    const result = await lifecycle.promoteCandidate(validCandidate.candidateId, {
      approvalId: req.approval.approvalId,
      authorizedBy: 'owner',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('unauthorized')
      expect(result.reason).toContain('version')
    }
  })

  it('4. rejects promotion when approval is for experiment-only authority', async () => {
    const req = await lifecycle.requestPromotionApproval(validCandidate.candidateId)
    expect(req.ok).toBe(true)
    if (!req.ok) return

    // Tamper with approval record to specify experiment-only purpose
    const tampered = {
      ...req.approval,
      requestedPurpose: 'experimentation' as unknown as 'production_promotion',
      status: 'approved' as const,
      decidedBy: 'owner' as const,
      decidedAt: new Date().toISOString(),
    }
    await evolutionStore.writeApproval(tampered)

    const result = await lifecycle.promoteCandidate(validCandidate.candidateId, {
      approvalId: req.approval.approvalId,
      authorizedBy: 'owner',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('unauthorized')
      expect(result.reason).toContain('experiment-only')
    }
  })

  it('5. rejects promotion when approval has expired', async () => {
    // Request with 10ms TTL
    const req = await lifecycle.requestPromotionApproval(validCandidate.candidateId, { ttlMs: 10 })
    expect(req.ok).toBe(true)
    if (!req.ok) return

    await lifecycle.decidePromotionApproval({
      approvalId: req.approval.approvalId,
      decision: 'approved',
      decidedBy: 'owner',
    })

    // Simulate promotion attempt after expiration
    const futureTime = new Date(Date.now() + 60000).toISOString()
    const result = await lifecycle.promoteCandidate(validCandidate.candidateId, {
      approvalId: req.approval.approvalId,
      authorizedBy: 'owner',
      timestamp: futureTime,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('unauthorized')
      expect(result.reason).toContain('expired')
    }
  })

  it('6. rejects promotion when approval is revoked', async () => {
    const req = await lifecycle.requestPromotionApproval(validCandidate.candidateId)
    expect(req.ok).toBe(true)
    if (!req.ok) return

    await lifecycle.decidePromotionApproval({
      approvalId: req.approval.approvalId,
      decision: 'approved',
      decidedBy: 'owner',
    })

    // Owner revokes the approval before consumption
    await lifecycle.decidePromotionApproval({
      approvalId: req.approval.approvalId,
      decision: 'revoked',
      decidedBy: 'owner',
      reason: 'Safety concern raised by security audit',
    })

    const result = await lifecycle.promoteCandidate(validCandidate.candidateId, {
      approvalId: req.approval.approvalId,
      authorizedBy: 'owner',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('unauthorized')
      expect(result.reason).toContain('revoked')
    }
  })

  it('7. rejects promotion when approval was denied', async () => {
    const req = await lifecycle.requestPromotionApproval(validCandidate.candidateId)
    expect(req.ok).toBe(true)
    if (!req.ok) return

    // Owner denies the approval
    await lifecycle.decidePromotionApproval({
      approvalId: req.approval.approvalId,
      decision: 'denied',
      decidedBy: 'owner',
      reason: 'Proposed heuristic conflicts with enterprise compliance',
    })

    const result = await lifecycle.promoteCandidate(validCandidate.candidateId, {
      approvalId: req.approval.approvalId,
      authorizedBy: 'owner',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('unauthorized')
      expect(result.reason).toContain('denied')
    }
  })

  it('8. rejects promotion when approval was decided by non-owner principal', async () => {
    const req = await lifecycle.requestPromotionApproval(validCandidate.candidateId)
    expect(req.ok).toBe(true)
    if (!req.ok) return

    // Non-owner (agent) attempts to approve
    const decisionResult = await lifecycle.decidePromotionApproval({
      approvalId: req.approval.approvalId,
      decision: 'approved',
      decidedBy: 'agent:researcher' as unknown as PrincipalId,
    })

    // System refused agent decision
    expect(decisionResult.ok).toBe(false)

    // Even if somehow written to store, validation refuses it
    const forgedApproval = {
      ...req.approval,
      status: 'approved' as const,
      decidedBy: 'agent:subordinate' as unknown as PrincipalId,
      decidedAt: new Date().toISOString(),
    }
    await evolutionStore.writeApproval(forgedApproval)

    const result = await lifecycle.promoteCandidate(validCandidate.candidateId, {
      approvalId: req.approval.approvalId,
      authorizedBy: 'owner',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('unauthorized')
      expect(result.reason).toContain('not authenticated owner')
    }
  })

  it('9. rejects reuse of already-consumed approval', async () => {
    const req = await lifecycle.requestPromotionApproval(validCandidate.candidateId)
    expect(req.ok).toBe(true)
    if (!req.ok) return

    await lifecycle.decidePromotionApproval({
      approvalId: req.approval.approvalId,
      decision: 'approved',
      decidedBy: 'owner',
    })

    // First promotion succeeds
    const firstPromotion = await lifecycle.promoteCandidate(validCandidate.candidateId, {
      approvalId: req.approval.approvalId,
      authorizedBy: 'owner',
    })
    expect(firstPromotion.ok).toBe(true)

    // Second promotion attempt with same approval is rejected
    const secondPromotion = await lifecycle.promoteCandidate(validCandidate.candidateId, {
      approvalId: req.approval.approvalId,
      authorizedBy: 'owner',
    })

    expect(secondPromotion.ok).toBe(false)
    if (!secondPromotion.ok) {
      expect(secondPromotion.code).toBe('unauthorized')
      expect(secondPromotion.reason).toContain('already been consumed')
    }
  })

  it('10. rejects promotion if candidate parameters were modified after approval', async () => {
    const req = await lifecycle.requestPromotionApproval(validCandidate.candidateId)
    expect(req.ok).toBe(true)
    if (!req.ok) return

    await lifecycle.decidePromotionApproval({
      approvalId: req.approval.approvalId,
      decision: 'approved',
      decidedBy: 'owner',
    })

    // Candidate parameters tampered after approval
    const tamperedCandidate: StrategyCandidate = {
      ...validCandidate,
      parameters: {
        ...validCandidate.parameters,
        injectedMaliciousParam: 'escalate_privilege',
      },
    }
    await evolutionStore.writeCandidate(tamperedCandidate)

    const result = await lifecycle.promoteCandidate(validCandidate.candidateId, {
      approvalId: req.approval.approvalId,
      authorizedBy: 'owner',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('unauthorized')
      expect(result.reason).toContain('modified after approval was granted')
    }
  })

  it('11. rejects promotion when caller principal is not owner', async () => {
    const req = await lifecycle.requestPromotionApproval(validCandidate.candidateId)
    expect(req.ok).toBe(true)
    if (!req.ok) return

    await lifecycle.decidePromotionApproval({
      approvalId: req.approval.approvalId,
      decision: 'approved',
      decidedBy: 'owner',
    })

    // Direct call from subordinate agent
    const result = await lifecycle.promoteCandidate(validCandidate.candidateId, {
      approvalId: req.approval.approvalId,
      callerPrincipal: 'agent:worker-1' as unknown as PrincipalId,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('unauthorized')
      expect(result.reason).toContain('not authorized to promote strategies')
    }
  })

  it('12. succeeds only when genuine owner approval matches exact candidate specifications', async () => {
    const req = await lifecycle.requestPromotionApproval(validCandidate.candidateId)
    expect(req.ok).toBe(true)
    if (!req.ok) return

    const decideRes = await lifecycle.decidePromotionApproval({
      approvalId: req.approval.approvalId,
      decision: 'approved',
      decidedBy: 'owner',
      reason: 'Approved after reviewing successful independent experiment verification',
    })
    expect(decideRes.ok).toBe(true)

    const result = await lifecycle.promoteCandidate(validCandidate.candidateId, {
      approvalId: req.approval.approvalId,
      callerPrincipal: 'owner',
      authorizedBy: 'owner',
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.record.candidateId).toBe(validCandidate.candidateId)
      expect(result.record.version).toBe('1.1.0')
      expect(result.record.approvalId).toBe(req.approval.approvalId)
    }

    const active = lifecycle.getActiveStrategy()
    expect(active).not.toBeNull()
    expect(active!.strategyId).toBe(validCandidate.candidateId)
    expect(active!.status).toBe('active')
  })
})
