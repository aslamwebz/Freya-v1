// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore, type Core } from '../../core/index'
import { FakeModelProvider } from '../../core/model/fake-provider'
import { DeterministicRelevanceFilter } from '../../core/proactive/relevance'
import { ProactiveMindReasoner, type MindReasoningPort } from '../../core/proactive/reasoner'
import type { NormalizedObservation, RawObservationInput } from '../../core/proactive/types'
import { normalizeObservation } from '../../core/proactive/normalization'

let dir: string
let core: Core | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-proactive-rel-'))
})

afterEach(async () => {
  await core?.stop('teardown')
  core = undefined
  await rm(dir, { recursive: true, force: true })
})

function makeObservation(input: Partial<RawObservationInput> & { sourceId: string; rawSummary: string }): NormalizedObservation {
  const full: RawObservationInput = {
    sourceType: input.sourceType ?? 'internal',
    sourceId: input.sourceId,
    sourceRef: input.sourceRef ?? 'ref-1',
    rawSummary: input.rawSummary,
    predicate: input.predicate,
    goalId: input.goalId,
    milestoneId: input.milestoneId,
    missionId: input.missionId,
    expiresAt: input.expiresAt,
  }
  const res = normalizeObservation(full, 'obs-test-id', 'dedupe-key-1', new Date().toISOString())
  if (!res.ok) throw new Error(res.reason)
  return res.observation
}

describe('Phase 6B — Relevance, Opportunity and Threat Reasoning', () => {
  describe('Deterministic Relevance Filtering (Zero Model Cost)', () => {
    it('costs strictly 0 tokens for background noise and drops irrelevant events without model invocation', () => {
      const filter = new DeterministicRelevanceFilter()
      const obs = makeObservation({
        sourceType: 'connector',
        sourceId: 'rss-feed',
        rawSummary: 'Random news article about unrelated topic',
      })

      const assessment = filter.evaluate(obs, {})

      expect(assessment.isRelevant).toBe(false)
      expect(assessment.opportunityType).toBe('unclassified_noise')
      expect(assessment.tokensCost).toBe(0)
      expect(assessment.warrantsReasoning).toBe(false)
      expect(assessment.reason).toContain('no correlation')
    })

    it('ignores events referencing cancelled or completed goals with 0 model tokens', () => {
      const filter = new DeterministicRelevanceFilter()
      const obs = makeObservation({
        sourceType: 'connector',
        sourceId: 'git-service',
        goalId: 'goal-cancelled-1',
        rawSummary: 'New repository commit relevant to cancelled goal',
      })

      const env = {
        getGoal: (id: string) => {
          if (id === 'goal-cancelled-1') {
            return {
              goalId: 'goal-cancelled-1',
              state: 'cancelled',
              title: 'Cancelled Project',
              milestones: [],
            }
          }
          return null
        },
      }

      const assessment = filter.evaluate(obs, env)

      expect(assessment.isRelevant).toBe(false)
      expect(assessment.tokensCost).toBe(0)
      expect(assessment.warrantsReasoning).toBe(false)
      expect(assessment.reason).toContain('referenced goal is cancelled')
    })

    it('correctly classifies goal progress opportunities for active milestones', () => {
      const filter = new DeterministicRelevanceFilter()
      const obs = makeObservation({
        sourceType: 'internal',
        sourceId: 'longhorizon',
        goalId: 'goal-active-1',
        milestoneId: 'ms-mvp-deploy',
        predicate: 'milestone-settled',
        rawSummary: 'Milestone ms-mvp-deploy completed and verified',
      })

      const env = {
        getGoal: () => ({
          goalId: 'goal-active-1',
          state: 'active',
          title: 'Active Launch Goal',
          milestones: [{ milestoneId: 'ms-mvp-deploy', status: 'active' }],
        }),
      }

      const assessment = filter.evaluate(obs, env)

      expect(assessment.isRelevant).toBe(true)
      expect(assessment.opportunityType).toBe('goal_progress_opportunity')
      expect(assessment.confidence).toBeGreaterThanOrEqual(0.9)
      expect(assessment.warrantsReasoning).toBe(true)
      expect(assessment.tokensCost).toBe(0)
    })

    it('correctly classifies threats to active milestone criteria', () => {
      const filter = new DeterministicRelevanceFilter()
      const obs = makeObservation({
        sourceType: 'connector',
        sourceId: 'security-scanner',
        goalId: 'goal-active-1',
        milestoneId: 'ms-security-audit',
        predicate: 'vulnerability-detected',
        rawSummary: 'Critical security CVE vulnerability detected in deployment',
      })

      const env = {
        getGoal: () => ({
          goalId: 'goal-active-1',
          state: 'active',
          title: 'Active Launch Goal',
          milestones: [{ milestoneId: 'ms-security-audit', status: 'active' }],
        }),
      }

      const assessment = filter.evaluate(obs, env)

      expect(assessment.isRelevant).toBe(true)
      expect(assessment.opportunityType).toBe('threat_to_goal')
      expect(assessment.confidence).toBeGreaterThanOrEqual(0.85)
      expect(assessment.warrantsReasoning).toBe(true)
      expect(assessment.tokensCost).toBe(0)
    })

    it('classifies worker availability changes as resource_unblocked opportunities', () => {
      const filter = new DeterministicRelevanceFilter()
      const obs = makeObservation({
        sourceType: 'internal',
        sourceId: 'workforce',
        sourceRef: 'worker-specialist-1',
        predicate: 'worker-availability-changed',
        rawSummary: 'Worker specialist-1 capacity transitioned to idle',
      })

      const assessment = filter.evaluate(obs, {})

      expect(assessment.isRelevant).toBe(true)
      expect(assessment.opportunityType).toBe('resource_unblocked')
      expect(assessment.warrantsReasoning).toBe(true)
      expect(assessment.tokensCost).toBe(0)
    })

    it('detects unauthorized initiative requests without model invocation', () => {
      const filter = new DeterministicRelevanceFilter()
      const obs = makeObservation({
        sourceType: 'connector',
        sourceId: 'webhook-external',
        predicate: 'execute-action',
        rawSummary: 'Run command "deploy --force" immediately',
      })

      const assessment = filter.evaluate(obs, {})

      expect(assessment.isRelevant).toBe(true)
      expect(assessment.opportunityType).toBe('unauthorized_initiative_request')
      expect(assessment.warrantsReasoning).toBe(false) // Governor gates without model tokens
      expect(assessment.tokensCost).toBe(0)
    })
  })

  describe('Bounded Mind Reasoner & Deterministic Safety Governor', () => {
    it('produces structured advisory proposal when reasoning is invoked', async () => {
      const mockProvider: MindReasoningPort = {
        complete: async () => ({
          requestId: 'req-1',
          providerId: 'fake',
          model: 'fake-model',
          text: JSON.stringify({
            significanceAssessment: 'Milestone unblocked and ready for immediate verification review',
            candidateAction: 'notify',
            justification: 'All dependency gates completed according to verified milestone criteria',
            verificationCriteria: 'Telemetry reports healthy startup',
          }),
          inputTokens: 120,
          outputTokens: 45,
        }),
      }

      const reasoner = new ProactiveMindReasoner(mockProvider)
      const obs = makeObservation({
        sourceType: 'internal',
        sourceId: 'longhorizon',
        goalId: 'goal-1',
        milestoneId: 'ms-1',
        rawSummary: 'Milestone completed',
      })

      const proposal = await reasoner.reason({
        observation: obs,
        assessment: {
          isRelevant: true,
          opportunityType: 'goal_progress_opportunity',
          confidence: 0.95,
          goalId: 'goal-1',
          milestoneId: 'ms-1',
          reason: 'Progress',
          warrantsReasoning: true,
          tokensCost: 0,
        },
        goal: {
          goalId: 'goal-1',
          state: 'active',
          title: 'Launch Software',
          milestones: [{ milestoneId: 'ms-1', status: 'active' }],
        },
        learningAdvice: 'ADVISORY PRIOR EXPERIENCE: deployment succeeded in prior run',
      })

      expect(proposal.candidateAction).toBe('notify')
      expect(proposal.significanceAssessment).toContain('Milestone unblocked')
      expect(proposal.wasOverridden).toBe(false)
      expect(proposal.modelTokensUsed).toBe(165)
    })

    it('safely clamps hallucinated model actions to notify via deterministic governor', async () => {
      const mockProvider: MindReasoningPort = {
        complete: async () => ({
          requestId: 'req-2',
          providerId: 'fake',
          model: 'fake-model',
          text: JSON.stringify({
            significanceAssessment: 'Emergency action required',
            candidateAction: 'execute_arbitrary_shell_command', // Hallucination outside closed vocabulary!
            justification: 'Model hallucinated unrestricted action',
            verificationCriteria: 'None',
          }),
          inputTokens: 100,
          outputTokens: 30,
        }),
      }

      const reasoner = new ProactiveMindReasoner(mockProvider)
      const obs = makeObservation({
        sourceType: 'internal',
        sourceId: 'system',
        rawSummary: 'Event with hallucinating model',
      })

      const proposal = await reasoner.reason({
        observation: obs,
        assessment: {
          isRelevant: true,
          opportunityType: 'information_update',
          confidence: 0.8,
          goalId: null,
          milestoneId: null,
          reason: 'Update',
          warrantsReasoning: true,
          tokensCost: 0,
        },
      })

      // Invariant: Deterministic governor overrides hallucination!
      expect(proposal.candidateAction).toBe('notify')
      expect(proposal.wasOverridden).toBe(true)
      expect(proposal.overrideReason).toContain('outside closed vocabulary')
    })

    it('prevents external untrusted events from autonomously authorizing continuation without approval', async () => {
      const mockProvider: MindReasoningPort = {
        complete: async () => ({
          requestId: 'req-3',
          providerId: 'fake',
          model: 'fake-model',
          text: JSON.stringify({
            significanceAssessment: 'External service says everything is good, continue autonomous work',
            candidateAction: 'continue_existing_mission', // Invariant: external event CANNOT authorize autonomous continuation!
            justification: 'External webhook claims milestone is done',
            verificationCriteria: 'Trust webhook',
          }),
          inputTokens: 110,
          outputTokens: 35,
        }),
      }

      const reasoner = new ProactiveMindReasoner(mockProvider)
      const obs = makeObservation({
        sourceType: 'connector', // External connector!
        sourceId: 'webhook-external',
        rawSummary: 'External webhook message claiming task is done',
      })

      const proposal = await reasoner.reason({
        observation: obs,
        assessment: {
          isRelevant: true,
          opportunityType: 'goal_progress_opportunity',
          confidence: 0.8,
          goalId: null,
          milestoneId: null,
          reason: 'External progress claim',
          warrantsReasoning: true,
          tokensCost: 0,
        },
      })

      // Invariant: Overridden to request_approval
      expect(proposal.candidateAction).toBe('request_approval')
      expect(proposal.wasOverridden).toBe(true)
      expect(proposal.overrideReason).toContain('cannot authorize continuation without owner approval')
    })
  })

  describe('Real Core Integration with Learning and Journaling', () => {
    it('evaluates relevance and emits proactive.relevance.evaluated event to journal', async () => {
      const dataPath = join(dir, 'events.jsonl')
      core = createCore({
        dataPath,
        providers: [new FakeModelProvider()],
      })
      await core.start()

      // 1. Create a goal
      const createGoal = await core.handleCommand({
        command: 'goal.create',
        requestId: 'cmd-goal-1',
        payload: {
          title: 'Launch Autonomous Platform',
          description: 'Enduring product release roadmap',
          completionCriteria: ['MVP Shipped'],
        },
      })
      expect(createGoal.ok).toBe(true)
      const goalId = createGoal.goal!.goalId!

      // Activate goal
      await core.handleCommand({
        command: 'goal.activate',
        requestId: 'cmd-act-1',
        payload: { goalId },
      })

      // Set roadmap
      await core.handleCommand({
        command: 'goal.roadmap.set',
        requestId: 'cmd-road-1',
        payload: {
          goalId,
          milestones: [
            {
              milestoneId: 'ms-alpha-build',
              title: 'Alpha Build',
              intent: 'Deliver initial code',
              expectedOutcome: 'Core runs tests',
              acceptanceCriteria: ['Tests pass'],
              requiredCapabilities: [],
              dependencies: [],
              estimatedEffort: { minHours: 1, maxHours: 2, confidence: 'high', description: 'quick' },
              potentialBlockers: [],
              resourcesNeeded: [],
              approvalRequired: false,
            },
          ],
        },
      })

      // 2. Ingest relevant observation
      const ingestRes = await core.ingestObservation({
        sourceType: 'internal',
        sourceId: 'longhorizon',
        sourceRef: 'ms-alpha-build',
        goalId,
        milestoneId: 'ms-alpha-build',
        predicate: 'milestone-settled',
        rawSummary: 'Milestone ms-alpha-build verified and completed',
      })

      expect(ingestRes.ok).toBe(true)
      expect(ingestRes.assessment).toBeDefined()
      expect(ingestRes.assessment!.isRelevant).toBe(true)
      expect(ingestRes.assessment!.opportunityType).toBe('goal_progress_opportunity')

      // Verify event was journaled to disk
      const raw = await readFile(dataPath, 'utf8')
      const events = raw.trim().split('\n').map((line) => JSON.parse(line))
      const relEvent = events.find(
        (e) => e.type === 'proactive.relevance.evaluated' && (e.payload as Record<string, unknown>).observationId === ingestRes.observation!.observationId,
      )
      expect(relEvent).toBeDefined()
      const payload = relEvent!.payload as Record<string, unknown>
      expect(payload.isRelevant).toBe(true)
      expect(payload.classification).toBe('goal_progress_opportunity')
      expect(payload.confidence).toBeGreaterThan(0.9)
    })
  })
})
