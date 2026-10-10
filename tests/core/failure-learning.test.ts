// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore, type Core } from '../../core/index'
import { FakeModelProvider } from '../../core/model/fake-provider'
import {
  categorizeFailure,
  formatCorrectiveAdvice,
  isPlanRepeatingFailure,
} from '../../core/learning/failure'
import { proposeMissionPlan, type MissionPlanningInput } from '../../core/mind/mission-planning'
import { recallRelevantLearning } from '../../core/learning/recall'
import { DEFAULT_MISSION_BUDGET, type MissionPlanRecord } from '../../core/missions/autonomy/types'

let dir: string
let core: Core | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-failure-learning-'))
})

afterEach(async () => {
  await core?.stop('teardown')
  core = undefined
  await rm(dir, { recursive: true, force: true })
})

describe('Phase 3C — Failure Learning and Correction', () => {
  describe('Failure Categorization and Advisory Directives', () => {
    it('distinguishes verification failures, execution errors, authorization denials, and resource limits', () => {
      // 1. Verification failure
      const verFail = categorizeFailure('File content did not match expected checksum', {
        capability: 'filesystem.inspect',
        verifier: 'filesystem.inspect.verified',
      })
      expect(verFail.category).toBe('verification_failure')
      expect(verFail.advisedCorrection).toContain('Select an alternative path, query, or target')

      // 2. Execution error
      const execFail = categorizeFailure('Connection timeout reaching upstream endpoint', {
        capability: 'research.search',
      })
      expect(execFail.category).toBe('execution_error')
      expect(execFail.advisedCorrection).toContain('Adjust input format, verify environmental prerequisites')

      // 3. Authorization denied
      const authFail = categorizeFailure('Capability use denied: permission required', {
        capability: 'filesystem.write',
      })
      expect(authFail.category).toBe('authorization_denied')
      expect(authFail.advisedCorrection).toContain('Do not request actions requiring unauthorized capabilities')

      // 4. Resource exhausted
      const resFail = categorizeFailure('Budget limit exceeded for actions', {})
      expect(resFail.category).toBe('resource_exhausted')
      expect(resFail.advisedCorrection).toContain('Consolidate operations into fewer steps')
    })

    it('formats actionable non-repeating advice', () => {
      const failure = categorizeFailure('File not found at /path/missing.txt', {
        capability: 'filesystem.inspect',
      })
      const advice = formatCorrectiveAdvice(failure)
      expect(advice).toContain('CORRECTIVE REPLANNING REQUIRED:')
      expect(advice).toContain('verification_failure')
      expect(advice).toContain('Do not repeat this identical action.')
    })

    it('detects when candidate steps repeat failed parameters', () => {
      const failed = {
        capability: 'filesystem.inspect',
        input: { path: '/tmp/target.txt' },
      }

      // Exact repetition -> true
      expect(
        isPlanRepeatingFailure(
          [{ capability: 'filesystem.inspect', input: { path: '/tmp/target.txt' } }],
          failed,
        ),
      ).toBe(true)

      // Different path -> false
      expect(
        isPlanRepeatingFailure(
          [{ capability: 'filesystem.inspect', input: { path: '/tmp/alternative.txt' } }],
          failed,
        ),
      ).toBe(false)

      // Different capability -> false
      expect(
        isPlanRepeatingFailure(
          [{ capability: 'research.search', input: { query: 'test query', minSources: 1 } }],
          failed,
        ),
      ).toBe(false)
    })
  })

  describe('Corrective Mission Replanning', () => {
    const mockCapabilities = {
      known: () => ['filesystem.inspect'],
      lookup: (name: string) =>
        name === 'filesystem.inspect'
          ? { risk: 'none' as const, verifier: 'filesystem.inspect.verified' }
          : undefined,
      verifiers: () => ['filesystem.inspect.verified'],
    }

    const previousExecution = {
      planId: 'plan-1',
      continueAfterVerification: false,
      steps: [
        {
          stepId: 'step-1',
          capability: 'filesystem.inspect',
          verifier: 'filesystem.inspect.verified',
          intent: 'inspect missing file',
          input: { path: '/missing/data.json' },
        },
      ],
    }

    const previousPlan: MissionPlanRecord = {
      planId: 'plan-1',
      revision: 1,
      supersedes: null,
      reason: null,
      createdAt: '2026-10-10T00:00:00.000Z',
      steps: [
        {
          stepId: 'step-1',
          index: 0,
          capability: 'filesystem.inspect',
          verifier: 'filesystem.inspect.verified',
          dependsOn: [],
          status: 'failed',
          workerId: null,
          runId: null,
          attempts: 1,
          risk: 'none',
          requiresApproval: false,
          approvalId: null,
          reason: 'step_failed',
          startedAt: '2026-10-10T00:00:00.000Z',
          settledAt: '2026-10-10T00:00:01.000Z',
        },
      ],
    }

    it('rejects candidate proposals that attempt to repeat the exact failed step', async () => {
      let capturedSystemPrompt = ''
      const repeatingProviderResponse = JSON.stringify({
        steps: [
          {
            intent: 're-try missing file',
            capability: 'filesystem.inspect',
            input: { path: '/missing/data.json' },
            dependsOn: [],
          },
        ],
      })

      const input: MissionPlanningInput = {
        missionId: 'mis-repeat-1',
        grantId: 'grant-test-1',
        goal: 'Find data.json file',
        successCriteria: ['File metadata inspected'],
        budget: DEFAULT_MISSION_BUDGET,
        maxSteps: 3,
        now: new Date('2026-10-10T00:00:00.000Z'),
        previousPlan,
        previousExecution,
        failure: 'File not found at /missing/data.json',
      }

      const outcome = await proposeMissionPlan(
        input,
        mockCapabilities as any,
        () => true,
        async (intent) => {
          capturedSystemPrompt = intent.messages?.[0]?.content ?? ''
          return {
            status: 'allowed',
            requestId: 'req-test-1',
            text: repeatingProviderResponse,
            providerId: 'prov-test',
            model: 'test-model',
          }
        },
      )

      expect(capturedSystemPrompt).toContain('CORRECTIVE REPLANNING REQUIRED:')
      // Rejection: planner detects exact repeating failure
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        expect(outcome.reason).toBe('invalid_proposal')
      }
    })

    it('accepts alternative replan proposals and records corrective rationale', async () => {
      const alternativeProviderResponse = JSON.stringify({
        steps: [
          {
            intent: 'inspect fallback config instead',
            capability: 'filesystem.inspect',
            input: { path: '/fallback/config.json' },
            dependsOn: [],
          },
        ],
      })

      const input: MissionPlanningInput = {
        missionId: 'mis-alt-1',
        grantId: 'grant-test-1',
        goal: 'Find config file',
        successCriteria: ['File metadata inspected'],
        budget: DEFAULT_MISSION_BUDGET,
        maxSteps: 3,
        now: new Date('2026-10-10T00:00:00.000Z'),
        previousPlan,
        previousExecution,
        failure: 'File not found at /missing/data.json',
      }

      const outcome = await proposeMissionPlan(
        input,
        mockCapabilities as any,
        () => true,
        async () => ({
          status: 'allowed',
          requestId: 'req-test-2',
          text: alternativeProviderResponse,
          providerId: 'prov-test',
          model: 'test-model',
        }),
      )

      expect(outcome.ok).toBe(true)
      if (outcome.ok) {
        expect(outcome.plan.revision).toBe(2)
        expect(outcome.plan.supersedes).toBe('plan-1')
        expect(outcome.plan.reason).toBe('step_failed')
        expect(outcome.execution.adaptiveRationale).toContain('Corrective replan addressing verification_failure:')
        expect(outcome.execution.steps[0]?.input).toEqual({ path: '/fallback/config.json' })
      }
    })
  })

  describe('Owner Knowledge Correction and Withdrawal', () => {
    it('allows owner to correct and supersede an active knowledge claim', async () => {
      // Initialize Core
      const provider = new FakeModelProvider()
      const dataPath = join(dir, 'events.jsonl')
      core = createCore({
        dataPath,
        providers: [provider],
        missionKey: new Uint8Array(32).fill(3),
        missionReadRoots: [dir],
      })
      await core.start()

      // Seed directly into Core's engine
      const coreEngine = core.learningEngineInstance()!
      await coreEngine.recordVerifiedOutcome({
        outcomeId: 'out-corr-core',
        sourceDomain: 'work',
        verificationId: 'ver-corr-core',
        verifierId: 'filesystem.inspect.verified',
        checked: 'inspected node package',
        subjectRef: 'step-corr-core',
        result: 'succeeded',
        establishedAt: new Date().toISOString(),
      })
      await coreEngine.distilExperience('out-corr-core', {
        experienceId: 'exp-corr-core',
        kind: 'tool-lesson',
        lesson: 'package.json was found.',
        scope: 'one-instance',
        scopeLimits: ['observed-once', 'no-future-guarantee'],
        tags: ['filesystem_inspect'],
        observedAt: new Date().toISOString(),
      })
      const created = await coreEngine.deriveKnowledge(
        {
          knowledgeId: 'know-core-initial',
          kind: 'tool-behaviour',
          claim: 'package.json was observed at root directory path in this workspace.',
          scope: 'one-environment',
          scopeLimits: ['observed-in-one-environment', 'no-future-guarantee'],
          supports: ['exp-corr-core'],
          tags: ['filesystem_inspect'],
          observedAt: new Date().toISOString(),
        },
        'core',
      )
      expect(created.ok).toBe(true)

      // Owner issues correction through Core interface
      const correctionOutcome = await core.correctLearningClaim('know-core-initial', {
        claim: 'package.json was observed at relative path ./package.json in this workspace.',
        reason: 'Owner corrected inaccurate path claim',
      })

      expect(correctionOutcome.ok).toBe(true)
      expect(correctionOutcome.outcome).toBe('corrected')
      expect(correctionOutcome.superseded).toBe('know-core-initial')
      expect(correctionOutcome.recordId).toBeDefined()

      // Verify status in engine records: old is superseded, new is admitted
      const records = coreEngine.records()
      const oldRecord = records.knowledge.find((c) => c.knowledgeId === 'know-core-initial')
      const newRecord = records.knowledge.find((c) => c.knowledgeId === correctionOutcome.recordId)

      expect(oldRecord?.status).toBe('superseded')
      expect(newRecord?.status).toBe('admitted')
      expect(newRecord?.claim).toBe('package.json was observed at relative path ./package.json in this workspace.')

      // Verify projection counts reflect superseding
      const projection = core.learning()
      expect(projection.counts.superseded).toBeGreaterThanOrEqual(1)

      // Recall only recalls the active new claim
      const recall = recallRelevantLearning(coreEngine, {
        capabilities: ['filesystem.inspect'],
        goal: 'inspect package.json',
      })

      expect(recall.consideredIds).toContain(correctionOutcome.recordId)
      expect(recall.consideredIds).not.toContain('know-core-initial')
      expect(recall.promptSection).toContain('package.json was observed at relative path')
      expect(recall.promptSection).not.toContain('root directory path')

      // Now Owner withdraws the claim
      const withdrawalOutcome = await core.withdrawLearningClaim(correctionOutcome.recordId!)
      expect(withdrawalOutcome.ok).toBe(true)
      expect(withdrawalOutcome.outcome).toBe('withdrawn')

      const recordsAfterWithdraw = coreEngine.records()
      const withdrawnRecord = recordsAfterWithdraw.knowledge.find(
        (c) => c.knowledgeId === correctionOutcome.recordId,
      )
      expect(withdrawnRecord?.status).toBe('retracted')

      // Recall after withdrawal recalls neither
      const recallAfterWithdraw = recallRelevantLearning(coreEngine, {
        capabilities: ['filesystem.inspect'],
        goal: 'inspect package.json',
      })
      expect(recallAfterWithdraw.consideredIds).not.toContain(correctionOutcome.recordId)
    })
  })
})
