// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  validateMilestoneGraph,
  resolveMilestoneEligibility,
} from '../../core/longhorizon/decomposition/dag'
import {
  validateRoadmap,
} from '../../core/longhorizon/decomposition/validator'
import {
  ProgressiveRoadmapPlanner,
} from '../../core/longhorizon/decomposition/progressive-planner'
import {
  DEFAULT_DECOMPOSITION_LIMITS,
  type GoalMilestone,
  type GoalRoadmapInput,
} from '../../core/longhorizon/decomposition/types'
import type { GoalContent } from '../../core/longhorizon/types'
import { createCore, type Core } from '../../core/index'
import { FakeModelProvider } from '../../core/model/fake-provider'
import { StaticVaultKeyProvider } from '../../core/vault'
import { testVaultKey } from './testKey'
import { bindingAvailable, loadTestBinding } from './vault/binding'
import { LearningEngine } from '../../core/learning/engine'
import { MemoryLearningStore } from '../../core/vault/repositories/learning-store'
import { recallRelevantLearning } from '../../core/learning/recall'

function sampleMilestone(overrides: Partial<GoalMilestone> = {}): GoalMilestone {
  return {
    milestoneId: 'm-1',
    goalId: 'g-1',
    title: 'Milestone 1',
    intent: 'Intent of milestone 1',
    expectedOutcome: 'Outcome of milestone 1',
    acceptanceCriteria: ['Criteria 1'],
    requiredCapabilities: ['work.execute'],
    dependencies: [],
    estimatedEffort: {
      minHours: 1,
      maxHours: 4,
      confidence: 'medium',
      description: '1-4h',
    },
    potentialBlockers: [],
    resourcesNeeded: [],
    approvalRequired: false,
    status: 'pending',
    checkpointId: null,
    boundMissionIds: [],
    verifiedAt: null,
    failureReason: null,
    advisoryLessonsApplied: [],
    ...overrides,
  }
}

describe('Phase 5B — Goal Decomposition and Milestone Intelligence', () => {
  describe('5B.3 Milestone Dependency DAG', () => {
    it('validates an empty milestone list as valid', () => {
      const res = validateMilestoneGraph([])
      expect(res.valid).toBe(true)
      if (res.valid) {
        expect(res.topologicalOrder).toEqual([])
      }
    })

    it('rejects duplicate milestone IDs', () => {
      const m1 = sampleMilestone({ milestoneId: 'm-1' })
      const m2 = sampleMilestone({ milestoneId: 'm-1' })
      const res = validateMilestoneGraph([m1, m2])
      expect(res.valid).toBe(false)
      if (!res.valid) {
        expect(res.error).toContain('duplicate milestone id')
      }
    })

    it('rejects self-dependency', () => {
      const m1 = sampleMilestone({ milestoneId: 'm-1', dependencies: ['m-1'] })
      const res = validateMilestoneGraph([m1])
      expect(res.valid).toBe(false)
      if (!res.valid) {
        expect(res.error).toContain('cannot depend on itself')
      }
    })

    it('rejects unknown (dangling) dependencies', () => {
      const m1 = sampleMilestone({ milestoneId: 'm-1', dependencies: ['m-ghost'] })
      const res = validateMilestoneGraph([m1])
      expect(res.valid).toBe(false)
      if (!res.valid) {
        expect(res.error).toContain('unknown dependency')
      }
    })

    it('detects a 2-node dependency cycle (A -> B -> A)', () => {
      const m1 = sampleMilestone({ milestoneId: 'm-1', dependencies: ['m-2'] })
      const m2 = sampleMilestone({ milestoneId: 'm-2', dependencies: ['m-1'] })
      const res = validateMilestoneGraph([m1, m2])
      expect(res.valid).toBe(false)
      if (!res.valid) {
        expect(res.error).toContain('dependency cycle detected')
        expect(res.cycle).toBeDefined()
      }
    })

    it('detects a 3-node dependency cycle (A -> B -> C -> A)', () => {
      const m1 = sampleMilestone({ milestoneId: 'm-1', dependencies: ['m-3'] })
      const m2 = sampleMilestone({ milestoneId: 'm-2', dependencies: ['m-1'] })
      const m3 = sampleMilestone({ milestoneId: 'm-3', dependencies: ['m-2'] })
      const res = validateMilestoneGraph([m1, m2, m3])
      expect(res.valid).toBe(false)
      if (!res.valid) {
        expect(res.error).toContain('dependency cycle detected')
      }
    })

    it('accepts a valid DAG and produces prerequisites-first topological order', () => {
      const m1 = sampleMilestone({ milestoneId: 'm-1', dependencies: [] })
      const m2 = sampleMilestone({ milestoneId: 'm-2', dependencies: ['m-1'] })
      const m3 = sampleMilestone({ milestoneId: 'm-3', dependencies: ['m-2'] })
      const res = validateMilestoneGraph([m3, m1, m2])
      expect(res.valid).toBe(true)
      if (res.valid) {
        expect(res.topologicalOrder).toEqual(['m-1', 'm-2', 'm-3'])
      }
    })
  })

  describe('5B.3 Milestone Eligibility Resolution', () => {
    it('milestone without dependencies becomes ready', () => {
      const m1 = sampleMilestone({ milestoneId: 'm-1', dependencies: [], status: 'pending' })
      const resolution = resolveMilestoneEligibility([m1])
      expect(resolution.readyMilestones.map((m) => m.milestoneId)).toEqual(['m-1'])
      expect(resolution.blockedMilestones).toEqual([])
    })

    it('milestone with unmet dependency becomes blocked', () => {
      const m1 = sampleMilestone({ milestoneId: 'm-1', dependencies: [], status: 'pending' })
      const m2 = sampleMilestone({ milestoneId: 'm-2', dependencies: ['m-1'], status: 'pending' })
      const resolution = resolveMilestoneEligibility([m1, m2])
      expect(resolution.readyMilestones.map((m) => m.milestoneId)).toEqual(['m-1'])
      expect(resolution.blockedMilestones.map((m) => m.milestoneId)).toEqual(['m-2'])
      expect(resolution.blockedMilestones[0]?.failureReason).toContain('waiting on dependency')
    })

    it('milestone becomes ready once dependency is completed', () => {
      const m1 = sampleMilestone({ milestoneId: 'm-1', dependencies: [], status: 'completed' })
      const m2 = sampleMilestone({ milestoneId: 'm-2', dependencies: ['m-1'], status: 'pending' })
      const resolution = resolveMilestoneEligibility([m1, m2])
      expect(resolution.readyMilestones.map((m) => m.milestoneId)).toEqual(['m-2'])
      expect(resolution.completedMilestones.map((m) => m.milestoneId)).toEqual(['m-1'])
    })

    it('milestone becomes blocked with error when dependency fails', () => {
      const m1 = sampleMilestone({ milestoneId: 'm-1', dependencies: [], status: 'failed' })
      const m2 = sampleMilestone({ milestoneId: 'm-2', dependencies: ['m-1'], status: 'pending' })
      const resolution = resolveMilestoneEligibility([m1, m2])
      expect(resolution.readyMilestones).toEqual([])
      expect(resolution.blockedMilestones.map((m) => m.milestoneId)).toEqual(['m-2'])
      expect(resolution.blockedMilestones[0]?.failureReason).toContain('dependency failed: m-1')
    })

    it('preserves in_progress status without forcing it to ready or blocked', () => {
      const m1 = sampleMilestone({ milestoneId: 'm-1', dependencies: [], status: 'in_progress' })
      const resolution = resolveMilestoneEligibility([m1])
      expect(resolution.inProgressMilestones.map((m) => m.milestoneId)).toEqual(['m-1'])
      expect(resolution.readyMilestones).toEqual([])
    })
  })

  describe('5B.1 Code-Owned Ceilings and Roadmap Validator', () => {
    it('enforces maximum milestones ceiling', () => {
      const tooMany = Array.from({ length: DEFAULT_DECOMPOSITION_LIMITS.maxMilestonesPerGoal + 1 }, (_, i) => ({
        milestoneId: `m-${i + 1}`,
        title: `Milestone ${i + 1}`,
        intent: 'Intent',
        expectedOutcome: 'Outcome',
        acceptanceCriteria: ['Valid criteria'],
      }))

      const res = validateRoadmap({ goalId: 'g-1', milestones: tooMany })
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.reason).toContain('exceeds maximum')
      }
    })

    it('enforces maximum dependencies per milestone', () => {
      const deps = Array.from({ length: DEFAULT_DECOMPOSITION_LIMITS.maxDependenciesPerMilestone + 1 }, (_, i) => `dep-${i}`)
      const milestones = [
        {
          milestoneId: 'm-main',
          title: 'Main Milestone',
          intent: 'Intent',
          expectedOutcome: 'Outcome',
          acceptanceCriteria: ['Valid criteria'],
          dependencies: deps,
        },
      ]
      const res = validateRoadmap({ goalId: 'g-1', milestones })
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.reason).toContain('exceeds maximum of 8 dependencies')
      }
    })

    it('enforces plan revision limit ceiling', () => {
      const input: GoalRoadmapInput = {
        goalId: 'g-1',
        milestones: [
          {
            milestoneId: 'm-1',
            title: 'M1',
            intent: 'Intent',
            expectedOutcome: 'Outcome',
            acceptanceCriteria: ['Criteria'],
          },
        ],
      }
      const atCeiling = validateRoadmap(input, DEFAULT_DECOMPOSITION_LIMITS.maxPlanRevisions)
      expect(atCeiling.ok).toBe(false)
      if (!atCeiling.ok) {
        expect(atCeiling.reason).toContain('maximum plan revision ceiling')
      }
    })

    it('strips control characters and normalizes input text', () => {
      const input: GoalRoadmapInput = {
        goalId: 'g-1',
        milestones: [
          {
            milestoneId: 'm-1',
            title: 'M1 with \x00\x08 control chars',
            intent: 'Intent \x1b[31m colored \x1b[0m',
            expectedOutcome: 'Outcome',
            acceptanceCriteria: ['Valid criterion \x07'],
          },
        ],
      }
      const res = validateRoadmap(input, 0)
      expect(res.ok).toBe(true)
      if (res.ok) {
        expect(res.value.milestones[0]?.title).toBe('M1 with  control chars')
        expect(res.value.milestones[0]?.acceptanceCriteria[0]).toBe('Valid criterion')
      }
    })
  })

  describe('5B.4 Progressive Elaboration & Milestone Lifecycle', () => {
    const planner = new ProgressiveRoadmapPlanner()

    it('proposes a high-level roadmap with uncertain effort estimates', () => {
      const goal: GoalContent = {
        goalId: 'g-100',
        title: 'Launch SaaS Product',
        description: 'Build and launch a profitable SaaS product in 90 days',
        completionCriteria: ['Market Research', 'Core Engine MVP', 'Public Beta & Launch'],
        createdAt: new Date().toISOString(),
      }

      const res = planner.proposeRoadmap(goal)
      expect(res.ok).toBe(true)
      if (res.ok) {
        expect(res.value.milestones.length).toBe(3)
        expect(res.value.milestones[0]?.title).toContain('Market Research')
        expect(res.value.milestones[1]?.dependencies).toEqual(['m-1'])
        expect(res.value.milestones[2]?.dependencies).toEqual(['m-2'])
        expect(res.value.milestones[0]?.estimatedEffort.confidence).toBe('medium')
        expect(res.value.milestones[0]?.estimatedEffort.description).toContain('uncertain')
      }
    })

    it('identifies next eligible milestone and elaborates into a bounded Mission', () => {
      const goal: GoalContent = {
        goalId: 'g-100',
        title: 'Launch SaaS Product',
        description: 'Build and launch SaaS',
        completionCriteria: ['Phase 1', 'Phase 2'],
        createdAt: new Date().toISOString(),
      }

      const roadmapRes = planner.proposeRoadmap(goal)
      expect(roadmapRes.ok).toBe(true)
      if (!roadmapRes.ok) return

      const eligible = planner.nextEligibleMilestone(roadmapRes.value)
      expect(eligible).not.toBeNull()
      expect(eligible?.milestoneId).toBe('m-1')

      const mission = planner.createMissionForMilestone(eligible!, goal)
      expect(mission.milestoneId).toBe('m-1')
      expect(mission.title).toBe('Launch SaaS Product — Milestone 1: Phase 1')
      expect(mission.successCriteria).toEqual(['Phase 1'])
      expect(mission.requiredCapabilities).toContain('work.execute')
    })

    it('settling milestone advances roadmap without completing entire goal prematurely', () => {
      const goal: GoalContent = {
        goalId: 'g-100',
        title: 'Launch SaaS Product',
        description: 'Build and launch SaaS',
        completionCriteria: ['Phase 1', 'Phase 2'],
        createdAt: new Date().toISOString(),
      }

      const roadmapRes = planner.proposeRoadmap(goal)
      expect(roadmapRes.ok).toBe(true)
      if (!roadmapRes.ok) return

      const updated = planner.settleMilestone(roadmapRes.value, 'm-1', 'completed', {
        missionId: 'mission-abc-1',
      })

      const m1 = updated.milestones.find((m) => m.milestoneId === 'm-1')
      const m2 = updated.milestones.find((m) => m.milestoneId === 'm-2')

      expect(m1?.status).toBe('completed')
      expect(m1?.boundMissionIds).toContain('mission-abc-1')
      expect(m1?.verifiedAt).not.toBeNull()

      expect(m2?.status).toBe('ready')

      const next = planner.nextEligibleMilestone(updated)
      expect(next?.milestoneId).toBe('m-2')
    })
  })

  describe('5B.5 Learning Integration (Advisory Lessons)', () => {
    it('applies admitted lessons as advisory context without granting unverified capabilities', async () => {
      const store = new MemoryLearningStore()
      const learning = new LearningEngine({ store })

      const outcome = await learning.recordVerifiedOutcome({
        outcomeId: 'out-1',
        sourceDomain: 'work',
        verificationId: 'ver-1',
        verifierId: 'work.step.verified',
        checked: 'external API network timeout checked',
        subjectRef: 'run-1',
        result: 'failed',
        establishedAt: new Date().toISOString(),
      })
      expect(outcome.ok).toBe(true)

      const lesson = await learning.distilExperience('out-1', {
        experienceId: 'exp-1',
        kind: 'failure-lesson',
        lesson: 'external API call failed due to network timeout',
        scope: 'one-instance',
        scopeLimits: ['observed-once', 'no-future-guarantee'],
        observedAt: new Date().toISOString(),
      })
      expect(lesson.ok).toBe(true)

      const claim = await learning.deriveKnowledge({
        knowledgeId: 'kn-1',
        kind: 'failure-cause',
        claim: 'External API calls without retry limits frequently hang',
        scope: 'one-instance',
        scopeLimits: ['observed-once', 'no-future-guarantee'],
        supports: ['exp-1'],
        tags: ['work_execute'],
        observedAt: new Date().toISOString(),
      })
      expect(claim.ok).toBe(true)

      const advice = recallRelevantLearning(learning, {
        capabilities: ['work.execute'],
        goal: 'Scrape external API data for market analysis',
      })

      expect(advice.lessons.length).toBeGreaterThan(0)
      expect(advice.promptSection).toContain('ADVISORY PRIOR EXPERIENCE (Non-authoritative)')
      expect(advice.promptSection).toContain('External API calls without retry limits')

      const planner = new ProgressiveRoadmapPlanner()
      const goal: GoalContent = {
        goalId: 'g-200',
        title: 'External API Data Collection',
        description: 'Scrape market API',
        completionCriteria: ['Extract data'],
        createdAt: new Date().toISOString(),
      }

      const roadmapRes = planner.proposeRoadmap(goal, undefined, {
        advisoryLessons: advice.lessons.map((l) => ({
          recordId: l.recordId,
          claim: l.text,
          confidence: l.confidence,
        })),
      })

      expect(roadmapRes.ok).toBe(true)
      if (roadmapRes.ok) {
        const m1 = roadmapRes.value.milestones[0]
        expect(m1?.advisoryLessonsApplied).toContain('lesson:kn-1')
        expect(roadmapRes.value.advisoryNotes?.[0]).toContain('External API calls without retry limits')
      }
    })

    it('ignores retracted lessons so they do not contaminate planning', async () => {
      const store = new MemoryLearningStore()
      const learning = new LearningEngine({ store })

      await learning.recordVerifiedOutcome({
        outcomeId: 'out-retract',
        sourceDomain: 'work',
        verificationId: 'ver-retract',
        verifierId: 'work.step.verified',
        checked: 'cache check',
        subjectRef: 'run-retract',
        result: 'succeeded',
        establishedAt: new Date().toISOString(),
      })

      await learning.distilExperience('out-retract', {
        experienceId: 'exp-retracted',
        kind: 'tool-lesson',
        lesson: 'cache configuration inspected',
        scope: 'one-instance',
        scopeLimits: ['observed-once', 'no-future-guarantee'],
        observedAt: new Date().toISOString(),
      })

      await learning.deriveKnowledge({
        knowledgeId: 'kn-retracted',
        kind: 'process-fact',
        claim: 'Do not use caching',
        scope: 'one-instance',
        scopeLimits: ['observed-once', 'no-future-guarantee'],
        supports: ['exp-retracted'],
        tags: ['work_execute'],
        observedAt: new Date().toISOString(),
      })

      await learning.withdraw('kn-retracted') // Retract the knowledge claim!

      const advice = recallRelevantLearning(learning, {
        capabilities: ['work.execute'],
        goal: 'Caching system setup',
      })

      expect(advice.lessons.find((l) => l.recordId === 'kn-retracted')).toBeUndefined()
    })
  })

  describe('5B Core Production Integration', () => {
    let dir: string
    let core: Core | undefined

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'freya-5b-core-'))
    })

    afterEach(async () => {
      await core?.stop('teardown')
      core = undefined
      await rm(dir, { recursive: true, force: true })
    })

    it('creates goal with structured roadmap and verifies persistence across detail reads', async () => {
      const dataPath = join(dir, 'events.jsonl')
      const vaultPath = join(dir, 'freya.db')
      const binding = bindingAvailable ? await loadTestBinding() : undefined

      core = createCore({
        dataPath,
        providers: [new FakeModelProvider()],
        ...(binding
          ? {
              vault: {
                path: vaultPath,
                keyProvider: new StaticVaultKeyProvider(testVaultKey()),
                binding,
              },
            }
          : {}),
      })
      await core.start()

      const createRes = await core.handleCommand({
        command: 'goal.create',
        requestId: 'cmd-decomp-1',
        payload: {
          title: '3-Month Software Product',
          description: 'Build a production SaaS product with verified milestones',
          completionCriteria: ['Market Discovery', 'Core MVP', 'Customer Validation'],
          roadmap: {
            milestones: [
              {
                milestoneId: 'm-1',
                title: 'Market Discovery',
                intent: 'Interview 20 potential users',
                expectedOutcome: 'Clear problem validation',
                acceptanceCriteria: ['20 interviews logged'],
                dependencies: [],
              },
              {
                milestoneId: 'm-2',
                title: 'Core MVP',
                intent: 'Implement initial workable prototype',
                expectedOutcome: 'Working prototype deployed',
                acceptanceCriteria: ['Deploy to staging'],
                dependencies: ['m-1'],
              },
            ],
          },
        },
      })

      expect(createRes.ok).toBe(true)
      const goalId = createRes.goal?.goalId
      expect(goalId).toBeDefined()

      const detail = await core.goalDetail(goalId!)
      expect(detail).not.toBeNull()
      expect(detail?.content?.title).toBe('3-Month Software Product')
      expect(detail?.roadmap).toBeDefined()
      expect(detail?.roadmap?.milestones.length).toBe(2)
      expect(detail?.roadmap?.milestones[0]?.milestoneId).toBe('m-1')
      expect(detail?.roadmap?.milestones[1]?.dependencies).toEqual(['m-1'])
    })

    it('proposes roadmap using core.proposeGoalRoadmap and elaborates milestone mission', async () => {
      const dataPath = join(dir, 'events.jsonl')
      core = createCore({
        dataPath,
        providers: [new FakeModelProvider()],
      })
      await core.start()

      const createRes = await core.handleCommand({
        command: 'goal.create',
        requestId: 'cmd-decomp-2',
        payload: {
          title: 'Autonomous Research Initiative',
          description: 'Investigate and build autonomous agent pipelines',
          completionCriteria: ['Literature Review', 'Architecture Spike', 'Pilot Implementation'],
        },
      })

      expect(createRes.ok).toBe(true)
      const goalId = createRes.goal?.goalId as string

      // Propose roadmap via core helper
      const roadmapProposal = await core.proposeGoalRoadmap(goalId)
      expect(roadmapProposal.ok).toBe(true)
      if (!roadmapProposal.ok) return

      // Set the roadmap via command
      const setRoadmapRes = await core.handleCommand({
        command: 'goal.roadmap.set',
        requestId: 'cmd-decomp-3',
        payload: {
          goalId,
          milestones: roadmapProposal.value.milestones,
          advisoryNotes: roadmapProposal.value.advisoryNotes,
        },
      })
      expect(setRoadmapRes.ok).toBe(true)

      // Elaborate eligible milestone mission
      const missionProposal = await core.elaborateMilestoneMission(goalId)
      expect(missionProposal).not.toBeNull()
      expect(missionProposal?.milestoneId).toBe('m-1')
      expect(missionProposal?.title).toContain('Autonomous Research Initiative')

      // Settle milestone 1 via command
      const settleRes = await core.handleCommand({
        command: 'goal.milestone.settle',
        requestId: 'cmd-decomp-4',
        payload: {
          goalId,
          milestoneId: 'm-1',
          outcome: 'completed',
          evidence: { reason: 'Literature review published', missionId: 'm-review-1' },
        },
      })
      expect(settleRes.ok).toBe(true)

      // Detail should reflect m-1 completed and m-2 ready
      const detail = await core.goalDetail(goalId)
      const m1 = detail?.roadmap?.milestones.find((m: GoalMilestone) => m.milestoneId === 'm-1')
      const m2 = detail?.roadmap?.milestones.find((m: GoalMilestone) => m.milestoneId === 'm-2')
      expect(m1?.status).toBe('completed')
      expect(m2?.status).toBe('ready')

      // Next eligible milestone is now m-2
      const nextMission = await core.elaborateMilestoneMission(goalId)
      expect(nextMission?.milestoneId).toBe('m-2')
    })

    it('enforces STOP ALL: blocks roadmap updates and milestone settlement while STOP ALL is active', async () => {
      const dataPath = join(dir, 'events.jsonl')
      core = createCore({
        dataPath,
        providers: [new FakeModelProvider()],
      })
      await core.start()

      const createRes = await core.handleCommand({
        command: 'goal.create',
        requestId: 'cmd-decomp-5',
        payload: {
          title: 'Stop All Verification Goal',
          description: 'Testing STOP ALL safety enforcement on roadmap operations',
          completionCriteria: ['Milestone A'],
        },
      })
      const goalId = createRes.goal?.goalId as string

      // Engage STOP ALL
      await core.handleCommand({ command: 'security.stopAll', requestId: 'cmd-decomp-6' })

      const setRoadmapRes = await core.handleCommand({
        command: 'goal.roadmap.set',
        requestId: 'cmd-decomp-7',
        payload: {
          goalId,
          milestones: [
            {
              milestoneId: 'm-1',
              title: 'M1',
              intent: 'Intent',
              expectedOutcome: 'Outcome',
              acceptanceCriteria: ['Crit'],
            },
          ],
        },
      })
      expect(setRoadmapRes.ok).toBe(false)
      expect(setRoadmapRes.goal?.reason).toContain('STOP ALL is active')

      const settleRes = await core.handleCommand({
        command: 'goal.milestone.settle',
        requestId: 'cmd-decomp-8',
        payload: {
          goalId,
          milestoneId: 'm-1',
          outcome: 'completed',
        },
      })
      expect(settleRes.ok).toBe(false)
      expect(settleRes.goal?.reason).toContain('STOP ALL is active')
    })
  })
})
