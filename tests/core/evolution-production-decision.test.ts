/**
 * FREYA EVOLUTION — Real Production Decision Integration Tests
 *
 * Verifies P0 Review Finding 2:
 * 1. Resolves authorized active strategy for task scope 'research_source_ranking'.
 * 2. Validates strategy version and parameters.
 * 3. Applies allowlisted heuristics (prioritizeVerifiedDomains, maxSourcesPerDomain).
 * 4. Preserves source safety and URL normalization.
 * 5. Demonstrates meaningful behavioral change between baseline and promoted candidate on identical inputs.
 * 6. Demonstrates that rollback restores exact baseline behavior.
 * 7. Records the strategy version used for every decision.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { selectSourcesDetailed, selectSources } from '../../core/research/evidence'
import type { SearchResult } from '../../core/research/types'
import {
  StrategyLifecycleManager,
  MemoryEvolutionStore,
  type StrategyCandidate,
} from '../../core/evolution'
import { MemoryMetacognitionStore } from '../../core/metacognition'

describe('Phase 7 Post-Review — Production Strategy Decision Integration', () => {
  let evolutionStore: MemoryEvolutionStore
  let metacognitionStore: MemoryMetacognitionStore
  let lifecycle: StrategyLifecycleManager
  let candidate: StrategyCandidate

  // 6 identical search results from different domains, with varying verification status and domain repeats
  const rawSearchResults: SearchResult[] = [
    {
      title: 'Blog Post on Domain A - Hit 1',
      url: 'https://unverified-blog.com/article1',
      snippet: 'Snippet 1',
      sourceDomain: 'unverified-blog.com',
      rank: 1,
      publishedAt: '2026-01-01T00:00:00Z',
      retrievedAt: '2026-10-10T00:00:00Z',
    },
    {
      title: 'Blog Post on Domain A - Hit 2',
      url: 'https://unverified-blog.com/article2',
      snippet: 'Snippet 2',
      sourceDomain: 'unverified-blog.com',
      rank: 2,
      publishedAt: '2026-01-02T00:00:00Z',
      retrievedAt: '2026-10-10T00:00:00Z',
    },
    {
      title: 'Official Node.js Docs',
      url: 'https://nodejs.org/en/docs',
      snippet: 'Official API documentation',
      sourceDomain: 'nodejs.org',
      rank: 3,
      publishedAt: '2026-01-03T00:00:00Z',
      retrievedAt: '2026-10-10T00:00:00Z',
      metadata: { verified: 'true' },
    },
    {
      title: 'Blog Post on Domain A - Hit 3',
      url: 'https://unverified-blog.com/article3',
      snippet: 'Snippet 3',
      sourceDomain: 'unverified-blog.com',
      rank: 4,
      publishedAt: '2026-01-04T00:00:00Z',
      retrievedAt: '2026-10-10T00:00:00Z',
    },
    {
      title: 'MDN Web Docs JavaScript Reference',
      url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript',
      snippet: 'Comprehensive web docs',
      sourceDomain: 'developer.mozilla.org',
      rank: 5,
      publishedAt: '2026-01-05T00:00:00Z',
      retrievedAt: '2026-10-10T00:00:00Z',
      metadata: { verified: 'true' },
    },
    {
      title: 'Untrusted Forum Post',
      url: 'https://random-forum.net/thread/42',
      snippet: 'Forum discussion',
      sourceDomain: 'random-forum.net',
      rank: 6,
      publishedAt: '2026-01-06T00:00:00Z',
      retrievedAt: '2026-10-10T00:00:00Z',
    },
  ]

  beforeEach(async () => {
    evolutionStore = new MemoryEvolutionStore()
    metacognitionStore = new MemoryMetacognitionStore()
    lifecycle = new StrategyLifecycleManager(evolutionStore, metacognitionStore)
    await lifecycle.initialize()

    candidate = {
      candidateId: 'cand-source-ranking-001',
      name: 'verified-domain-priority-source-selection',
      category: 'research_source_ranking',
      weaknessId: 'weakness-source-selection-001',
      weaknessKind: 'poor_source_selection',
      supportingEvidenceIds: ['ev-01', 'ev-02'],
      proposedChange:
        'Prioritize verified domain sources and enforce domain diversity (max 1 source per domain)',
      parameters: {
        prioritizeVerifiedDomains: true,
        maxSourcesPerDomain: 1,
        minHostDiversity: 3,
        trustedDomains: ['nodejs.org', 'developer.mozilla.org'],
      },
      expectedBenefit: 'Reduces retrieval failures by prioritizing high-trust documentation sources',
      applicableTaskScope: 'research_source_ranking',
      potentialRisks: ['Slightly lower novel source diversity'],
      measurementCriteria: [
        { metric: 'verification_rate', targetThreshold: 0.85, unit: 'ratio', comparator: 'greater_than_or_equal' },
      ],
      baselineStrategyId: 'strat-source-ranking-default',
      baselineParameters: {
        prioritizeVerifiedDomains: false,
        maxSourcesPerDomain: 5,
      },
      experimentRequirements: { maxRuns: 3, maxTokens: 10000, maxActions: 20, timeoutMs: 20000 },
      budgetCeiling: { maxTokens: 15000, maxModelCalls: 2, maxCostUsd: 0.02 },
      rollbackMechanism: {
        targetStrategyId: 'strat-source-ranking-default',
        targetParameters: { prioritizeVerifiedDomains: false, maxSourcesPerDomain: 5 },
        verificationTest: 'verify_default_source_ranking_restored',
      },
      requiredAuthorization: 'owner',
      status: 'eligible_for_promotion',
      version: '1.1.0',
      structuredHypothesis: {
        observation: 'Repeated missions fail verification due to selecting unverified blog posts',
        hypothesis: 'Prioritizing verified domains and capping domain repeat to 1 eliminates errors',
        candidate: 'candidate v1.1.0',
        baseline: 'baseline v1.0.0',
        measurement: 'verification rate',
        regressionRisks: ['Lower diversity'],
        acceptanceCriteria: 'Verification rate >= 85%',
      },
      createdAt: '2026-10-10T10:00:00Z',
      updatedAt: '2026-10-10T10:00:00Z',
    }

    await evolutionStore.writeCandidate(candidate)
  })

  it('proves that promotion changes real behavior and rollback restores baseline', async () => {
    // -------------------------------------------------------------------------
    // 1. Baseline Execution (No promoted strategy active)
    // -------------------------------------------------------------------------
    const activeBeforePromotion = lifecycle.getActiveStrategy('research_source_ranking')
    expect(activeBeforePromotion).toBeNull()

    const baselineSelection = selectSourcesDetailed(rawSearchResults, 3, {
      strategy: activeBeforePromotion,
    })

    // Baseline behavior: takes top ranks in sequential/host-balanced order
    expect(baselineSelection.strategyUsed).toBeNull()
    expect(baselineSelection.sources).toHaveLength(3)
    // First source is the unverified blog post (rank 1)
    expect(baselineSelection.sources[0]?.url).toBe('https://unverified-blog.com/article1')
    expect(baselineSelection.sources[1]?.url).toBe('https://nodejs.org/en/docs')
    expect(baselineSelection.sources[2]?.url).toBe('https://developer.mozilla.org/en-US/docs/Web/JavaScript')

    // -------------------------------------------------------------------------
    // 2. Owner Requests, Approves, and Promotes Candidate
    // -------------------------------------------------------------------------
    const req = await lifecycle.requestPromotionApproval(candidate.candidateId)
    expect(req.ok).toBe(true)
    if (!req.ok) return

    const decide = await lifecycle.decidePromotionApproval({
      approvalId: req.approval.approvalId,
      decision: 'approved',
      decidedBy: 'owner',
      reason: 'Approved after independent verification',
    })
    expect(decide.ok).toBe(true)

    const promoRes = await lifecycle.promoteCandidate(candidate.candidateId, {
      approvalId: req.approval.approvalId,
      authorizedBy: 'owner',
    })
    expect(promoRes.ok).toBe(true)

    // Verify active strategy is now the promoted candidate
    const activePromoted = lifecycle.getActiveStrategy('research_source_ranking')
    expect(activePromoted).not.toBeNull()
    expect(activePromoted!.strategyId).toBe('cand-source-ranking-001')
    expect(activePromoted!.version).toBe('1.1.0')
    expect(activePromoted!.parameters).toBeDefined()

    // -------------------------------------------------------------------------
    // 3. Promoted Candidate Execution on Identical Input
    // -------------------------------------------------------------------------
    const candidateSelection = selectSourcesDetailed(rawSearchResults, 3, {
      strategy: activePromoted,
    })

    // Provenance check: records exact candidate ID and version used
    expect(candidateSelection.strategyUsed).toEqual({
      id: 'cand-source-ranking-001',
      version: '1.1.0',
    })

    expect(candidateSelection.sources).toHaveLength(3)

    // BEHAVIORAL DIFFERENCE PROOF:
    // With candidate strategy active (prioritizeVerifiedDomains: true, maxSourcesPerDomain: 1):
    // 1st selected source MUST be verified (nodejs.org)
    // 2nd selected source MUST be verified (developer.mozilla.org)
    // 3rd selected source is the blog post (unverified-blog.com)
    expect(candidateSelection.sources[0]?.sourceDomain).toBe('nodejs.org')
    expect(candidateSelection.sources[1]?.sourceDomain).toBe('developer.mozilla.org')
    expect(candidateSelection.sources[2]?.sourceDomain).toBe('unverified-blog.com')

    // Contrast with baseline:
    // Baseline chose unverified blog as first source; promoted candidate chose nodejs.org!
    expect(candidateSelection.sources[0]?.url).not.toBe(baselineSelection.sources[0]?.url)
    expect(candidateSelection.sources[0]?.url).toBe('https://nodejs.org/en/docs')

    // Domain diversity check: only 1 article from unverified-blog.com was permitted
    const unverifiedBlogCount = candidateSelection.sources.filter(
      (s) => s.sourceDomain === 'unverified-blog.com',
    ).length
    expect(unverifiedBlogCount).toBe(1)

    // -------------------------------------------------------------------------
    // 4. Safe Rollback Execution
    // -------------------------------------------------------------------------
    const rollbackRes = await lifecycle.rollbackStrategy(
      candidate.candidateId,
      'Performance regression observed in production',
    )
    expect(rollbackRes.ok).toBe(true)

    const activeAfterRollback = lifecycle.getActiveStrategy('research_source_ranking')
    // Active strategy is now restored baseline
    expect(activeAfterRollback?.strategyId).toBe('strat-source-ranking-default')

    // -------------------------------------------------------------------------
    // 5. Execution After Rollback Returns Exactly to Baseline Behavior
    // -------------------------------------------------------------------------
    const postRollbackSelection = selectSourcesDetailed(rawSearchResults, 3, {
      strategy: activeAfterRollback,
    })

    // Behavioral restoration proof:
    // Since strat-source-ranking-default has no candidate parameters, it behaves as baseline
    expect(postRollbackSelection.sources[0]?.url).toBe(baselineSelection.sources[0]?.url)
    expect(postRollbackSelection.sources[1]?.url).toBe(baselineSelection.sources[1]?.url)
    expect(postRollbackSelection.sources[2]?.url).toBe(baselineSelection.sources[2]?.url)

    // Standard selectSources helper also reflects baseline behavior
    const standardPostRollback = selectSources(rawSearchResults, 3, {
      strategy: activeAfterRollback,
    })
    expect(standardPostRollback.map((s) => s.url)).toEqual(
      baselineSelection.sources.map((s) => s.url),
    )
  })

  it('preserves source safety and skips malformed URLs under active candidate', async () => {
    const activePromoted = {
      strategyId: 'cand-001',
      version: '1.1.0',
      kind: 'research_source_ranking',
      parameters: {
        prioritizeVerifiedDomains: true,
        maxSourcesPerDomain: 1,
      },
    }

    const searchHitsWithMalformed: SearchResult[] = [
      {
        title: 'Malformed URL hit',
        url: 'not-a-valid-url',
        snippet: 'bad url',
        sourceDomain: 'bad',
        rank: 1,
        publishedAt: null,
        retrievedAt: '2026-10-10T00:00:00Z',
      },
      ...rawSearchResults,
    ]

    const selection = selectSourcesDetailed(searchHitsWithMalformed, 2, {
      strategy: activePromoted,
    })

    expect(selection.sources).toHaveLength(2)
    // Malformed URL was safely skipped; valid verified sources were selected
    expect(selection.sources[0]?.url).toBe('https://nodejs.org/en/docs')
    expect(selection.sources[1]?.url).toBe('https://developer.mozilla.org/en-US/docs/Web/JavaScript')
  })
})
