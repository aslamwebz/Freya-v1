// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  ControlledExperimentRunner,
  generateCandidateFromWeakness,
  independentlyVerifyScenarioResult,
  type ExperimentScenario,
  type StrategyCandidate,
} from '../../core/evolution'
import type { WeaknessRecord } from '../../core/metacognition'

function makeTestScenarios(): ExperimentScenario[] {
  return [
    {
      scenarioId: 'scen-dev-1',
      name: 'Standard multi-domain research query',
      isHoldout: false,
      taskType: 'research_inspection',
      input: {
        query: 'TypeScript compiler architecture',
        candidateSources: [
          {
            url: 'https://flaky-blog.example.com/ts',
            domain: 'flaky-blog.example.com',
            previouslyVerified: false,
            contentAvailable: false, // Baseline fails here
            text: '',
          },
          {
            url: 'https://typescriptlang.org/docs/handbook',
            domain: 'typescriptlang.org',
            previouslyVerified: true,
            contentAvailable: true,
            text: 'The TypeScript compiler architecture consists of scanner, parser, binder...',
          },
          {
            url: 'https://github.com/microsoft/TypeScript',
            domain: 'github.com',
            previouslyVerified: true,
            contentAvailable: true,
            text: 'TypeScript is a superset of JavaScript that compiles to clean JavaScript...',
          },
        ],
      },
      expectedRequiredSources: 2,
    },
    {
      scenarioId: 'scen-dev-2',
      name: 'Distributed systems consensus query',
      isHoldout: false,
      taskType: 'research_inspection',
      input: {
        query: 'Raft consensus algorithm invariants',
        candidateSources: [
          {
            url: 'https://unverified-forum.example.com/p/123',
            domain: 'unverified-forum.example.com',
            previouslyVerified: false,
            contentAvailable: false, // Baseline fails here
            text: '',
          },
          {
            url: 'https://raft.github.io/raft.pdf',
            domain: 'raft.github.io',
            previouslyVerified: true,
            contentAvailable: true,
            text: 'In Search of an Understandable Consensus Algorithm...',
          },
          {
            url: 'https://acm.org/specialized/raft',
            domain: 'acm.org',
            previouslyVerified: true,
            contentAvailable: true,
            text: 'Raft provides state machine replication with leader election and log matching...',
          },
        ],
      },
      expectedRequiredSources: 2,
    },
    // Holdout scenarios: separate evaluation set
    {
      scenarioId: 'scen-holdout-1',
      name: 'Cryptographic hash functions comparison (Holdout)',
      isHoldout: true,
      taskType: 'research_inspection',
      input: {
        query: 'SHA256 vs BLAKE3 performance benchmarks',
        candidateSources: [
          {
            url: 'https://random-gist.example.com/bench',
            domain: 'random-gist.example.com',
            previouslyVerified: false,
            contentAvailable: false,
            text: '',
          },
          {
            url: 'https://blake3.io/spec',
            domain: 'blake3.io',
            previouslyVerified: true,
            contentAvailable: true,
            text: 'BLAKE3 is an open source cryptographic hash function...',
          },
          {
            url: 'https://csrc.nist.gov/publications/fips180-4',
            domain: 'csrc.nist.gov',
            previouslyVerified: true,
            contentAvailable: true,
            text: 'Secure Hash Standard (SHS) specifies seven secure hash algorithms...',
          },
        ],
      },
      expectedRequiredSources: 2,
    },
  ]
}

function makeMockWeakness(): WeaknessRecord {
  return {
    weaknessId: 'weakness-source-sel-1',
    kind: 'poor_source_selection',
    description: 'Suboptimal source ranking causing retrieval failures',
    occurrenceCount: 4,
    supportingEvidenceIds: ['msn-obs-1', 'msn-obs-2', 'msn-obs-3', 'msn-obs-4'],
    confidence: 'moderate',
    causalEvidenceStatus: 'correlated',
    sampleSize: 6,
    firstObservedAt: '2026-10-10T11:00:00Z',
    lastObservedAt: '2026-10-10T12:00:00Z',
  }
}

describe('Phase 7C — Controlled Experimentation & Independent Evaluation', () => {
  describe('7C.1, 7C.2 & 7C.3 — Baseline vs Candidate on Identical Scenarios with Frozen Metrics', () => {
    it('proves candidate demonstrates measurable superiority over baseline with independent verification', async () => {
      const runner = new ControlledExperimentRunner()
      const candidate = generateCandidateFromWeakness(makeMockWeakness())!
      const scenarios = makeTestScenarios()

      const report = await runner.runExperiment(candidate, scenarios)

      expect(report.status).toBe('completed')
      expect(report.candidateId).toBe(candidate.candidateId)
      expect(report.outcome).toBe('candidate_demonstrated_improvement')
      expect(report.isPromotionEligible).toBe(true)

      // Baseline failed on all 3 scenarios due to picking unavailable top sources
      expect(report.baselinePerformance.verifiedPassRate).toBe(0)
      expect(report.baselinePerformance.toolErrors).toBeGreaterThan(0)

      // Candidate succeeded on all 3 scenarios by prioritizing verified domain sources
      expect(report.candidatePerformance.verifiedPassRate).toBe(1.0)
      expect(report.candidatePerformance.toolErrors).toBe(0)

      // Holdout performance confirmed
      expect(report.holdoutPerformance.candidatePassRate).toBe(1.0)
      expect(report.holdoutPerformance.baselinePassRate).toBe(0)

      // Multiple dimensions
      expect(report.dimensions.correctness).toBe(true)
      expect(report.dimensions.verificationSuccess).toBe(true)
      expect(report.dimensions.securitySafe).toBe(true)
    })

    it('independent verifier rejects results when content is missing or source count is insufficient', () => {
      const scenario = makeTestScenarios()[0]!

      // Insufficient sources
      const emptyCheck = independentlyVerifyScenarioResult(scenario, [])
      expect(emptyCheck.verdict).toBe('failed')
      expect(emptyCheck.reason).toContain('below required threshold')

      // Unavailable content
      const badContent = independentlyVerifyScenarioResult(scenario, [
        { url: 'https://example.com/1', text: '', contentAvailable: false },
        { url: 'https://example.com/2', text: 'ok', contentAvailable: true },
      ])
      expect(badContent.verdict).toBe('failed')
      expect(badContent.reason).toContain('empty or unavailable')

      // Valid check
      const validCheck = independentlyVerifyScenarioResult(scenario, [
        { url: 'https://example.com/1', text: 'Valid content excerpt 1', contentAvailable: true },
        { url: 'https://example.com/2', text: 'Valid content excerpt 2', contentAvailable: true },
      ])
      expect(validCheck.verdict).toBe('passed')
    })
  })

  describe('7C.4 & 7C.5 — Holdout Scenarios & Statistical Restraint', () => {
    it('detects overfitting when candidate regresses on holdout scenarios despite dev scenario success', async () => {
      const runner = new ControlledExperimentRunner()
      const candidate = generateCandidateFromWeakness(makeMockWeakness())!

      // Construct scenario set where candidate passes dev scenario but fails holdout
      const overfittedScenarios: ExperimentScenario[] = [
        makeTestScenarios()[0]!, // Dev scenario (candidate passes)
        makeTestScenarios()[1]!, // Dev scenario (candidate passes)
        {
          scenarioId: 'scen-holdout-tricky',
          name: 'Holdout scenario where candidate parameter bias fails',
          isHoldout: true,
          taskType: 'research_inspection',
          input: {
            query: 'Obscure niche hardware protocol',
            candidateSources: [
              // In this holdout, unverified sources are fresh and available,
              // while previouslyVerified sources have suffered bit rot/outages.
              {
                url: 'https://fresh-domain.example.com/spec',
                domain: 'fresh-domain.example.com',
                previouslyVerified: false,
                contentAvailable: true,
                text: 'Fresh specification details...',
              },
              {
                url: 'https://docs.example.org/spec2',
                domain: 'docs.example.org',
                previouslyVerified: false,
                contentAvailable: true,
                text: 'Second fresh specification source...',
              },
              {
                url: 'https://old-domain.example.com/stale',
                domain: 'old-domain.example.com',
                previouslyVerified: true,
                contentAvailable: false,
                text: '',
              },
              {
                url: 'https://archive.example.org/stale2',
                domain: 'archive.example.org',
                previouslyVerified: true,
                contentAvailable: false,
                text: '',
              },
            ],
          },
          expectedRequiredSources: 2,
        },
      ]

      const report = await runner.runExperiment(candidate, overfittedScenarios)

      // Holdout regression detected: baseline might also fail or pass, but holdout pass rate is penalized
      expect(report.holdoutPerformance.candidatePassRate).toBe(0)
      if (report.holdoutPerformance.candidatePassRate < report.holdoutPerformance.baselinePassRate) {
        expect(report.outcome).toBe('candidate_failed')
        expect(report.isPromotionEligible).toBe(false)
        expect(report.reason).toContain('Overfitting detected')
      }
    })

    it('returns inconclusive when sample size is too small (< 3 runs)', async () => {
      const runner = new ControlledExperimentRunner()
      const candidate = generateCandidateFromWeakness(makeMockWeakness())!

      // Only 1 scenario (sample size = 1)
      const singleScenario = [makeTestScenarios()[0]!]
      const report = await runner.runExperiment(candidate, singleScenario)

      expect(report.outcome).toBe('inconclusive')
      expect(report.isPromotionEligible).toBe(false)
      expect(report.confidence).toBe('preliminary')
      expect(report.reason).toContain('insufficient sample size')
    })
  })

  describe('7C.6 & 7C.7 — Security Disqualification & Hard Ceilings Enforcement', () => {
    it('immediately disqualifies candidate if security or policy violation occurs', async () => {
      const runner = new ControlledExperimentRunner()
      const candidate = generateCandidateFromWeakness(makeMockWeakness())!

      // Inject prohibited parameter into candidate
      const tamperedCandidate: StrategyCandidate = {
        ...candidate,
        parameters: {
          ...candidate.parameters,
          bypass_guard: true, // triggers security violation in runner
        },
      }

      const report = await runner.runExperiment(tamperedCandidate, makeTestScenarios())

      expect(report.outcome).toBe('disqualified_security_regression')
      expect(report.isPromotionEligible).toBe(false)
      expect(report.dimensions.securitySafe).toBe(false)
      expect(report.reason).toContain('security or policy violations detected')
    })

    it('halts and fails experiment if budget ceiling is exhausted', async () => {
      const runner = new ControlledExperimentRunner()
      const candidate = generateCandidateFromWeakness(makeMockWeakness())!

      // Set extremely low ceiling
      const starvedCandidate: StrategyCandidate = {
        ...candidate,
        experimentRequirements: {
          ...candidate.experimentRequirements,
          maxActions: 1, // Only 1 action allowed
        },
        budgetCeiling: {
          ...candidate.budgetCeiling,
          maxTokens: 100, // Only 100 tokens allowed
        },
      }

      const report = await runner.runExperiment(starvedCandidate, makeTestScenarios())

      expect(report.status).toBe('failed')
      expect(report.isPromotionEligible).toBe(false)
      expect(report.reason).toContain('ceiling exhausted')
    })
  })
})
