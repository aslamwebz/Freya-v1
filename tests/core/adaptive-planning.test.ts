// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore, type Core } from '../../core/index'
import { FakeModelProvider } from '../../core/model/fake-provider'
import { MemoryLearningStore } from '../../core/vault/repositories/learning-store'
import { LearningEngine } from '../../core/learning/engine'
import { recallRelevantLearning } from '../../core/learning/recall'
import { workforceOwnerScope } from '../../core/testing'
import { admitWorkStepOutcome } from '../../core/learning/work-admission'

let dir: string
let core: Core | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-adaptive-planning-'))
})

afterEach(async () => {
  await core?.stop('teardown')
  core = undefined
  await rm(dir, { recursive: true, force: true })
})

describe('Phase 3B — Adaptive Memory Recall and Planning', () => {
  it('recalls only active admitted records matching capability and goal', async () => {
    const store = new MemoryLearningStore()
    const engine = new LearningEngine({ store })

    // Seed 1: Admitted filesystem inspection lesson
    await engine.recordVerifiedOutcome({
      outcomeId: 'out-fs-1',
      sourceDomain: 'work',
      verificationId: 'ver-fs-1',
      verifierId: 'filesystem.inspect.verified',
      checked: 'inspected file',
      subjectRef: 'step-fs-1',
      result: 'succeeded',
      establishedAt: new Date().toISOString(),
    })
    await engine.distilExperience('out-fs-1', {
      experienceId: 'exp-fs-1',
      kind: 'tool-lesson',
      lesson: 'filesystem.inspect verified metadata reliably.',
      scope: 'one-instance',
      scopeLimits: ['observed-once', 'no-future-guarantee'],
      tags: ['filesystem_inspect'],
      observedAt: new Date().toISOString(),
    })
    await engine.deriveKnowledge(
      {
        knowledgeId: 'know-fs-1',
        kind: 'tool-behaviour',
        claim: 'filesystem.inspect verified file metadata correctly in this workspace.',
        scope: 'one-environment',
        scopeLimits: ['observed-in-one-environment', 'no-future-guarantee'],
        supports: ['exp-fs-1'],
        tags: ['filesystem_inspect'],
        observedAt: new Date().toISOString(),
      },
      'core',
    )

    // Seed 2: Retracted claim (must NOT be recalled)
    await engine.recordVerifiedOutcome({
      outcomeId: 'out-ret-1',
      sourceDomain: 'work',
      verificationId: 'ver-ret-1',
      verifierId: 'filesystem.inspect.verified',
      checked: 'inspected old file',
      subjectRef: 'step-ret-1',
      result: 'succeeded',
      establishedAt: new Date().toISOString(),
    })
    await engine.distilExperience('out-ret-1', {
      experienceId: 'exp-ret-1',
      kind: 'tool-lesson',
      lesson: 'old lesson to be retracted',
      scope: 'one-instance',
      scopeLimits: ['observed-once', 'no-future-guarantee'],
      tags: ['filesystem_inspect'],
      observedAt: new Date().toISOString(),
    })
    await engine.deriveKnowledge(
      {
        knowledgeId: 'know-ret-1',
        kind: 'tool-behaviour',
        claim: 'retracted claim that must be omitted',
        scope: 'one-environment',
        scopeLimits: ['observed-in-one-environment', 'no-future-guarantee'],
        supports: ['exp-ret-1'],
        tags: ['filesystem_inspect'],
        observedAt: new Date().toISOString(),
      },
      'core',
    )
    await engine.withdraw('know-ret-1')

    // Query recall for filesystem.inspect capability
    const advice = recallRelevantLearning(engine, {
      capabilities: ['filesystem.inspect'],
      goal: 'Inspect the system config file',
      maxRecords: 5,
    })

    expect(advice.lessons.length).toBe(1)
    expect(advice.lessons[0]?.recordId).toBe('know-fs-1')
    expect(advice.consideredIds).toEqual(['know-fs-1'])
    expect(advice.promptSection).toContain('ADVISORY PRIOR EXPERIENCE (Non-authoritative):')
    expect(advice.promptSection).toContain('filesystem.inspect verified file metadata correctly')
    expect(advice.promptSection).not.toContain('retracted claim')
  })

  it('bounds recall context to maxRecords limit', async () => {
    const store = new MemoryLearningStore()
    const engine = new LearningEngine({ store })

    // Seed multiple records
    for (let i = 1; i <= 6; i++) {
      await engine.recordVerifiedOutcome({
        outcomeId: `out-cap-${i}`,
        sourceDomain: 'work',
        verificationId: `ver-cap-${i}`,
        verifierId: 'filesystem.inspect.verified',
        checked: `inspected file ${i}`,
        subjectRef: `step-cap-${i}`,
        result: 'succeeded',
        establishedAt: new Date().toISOString(),
      })
      await engine.distilExperience(`out-cap-${i}`, {
        experienceId: `exp-cap-${i}`,
        kind: 'tool-lesson',
        lesson: `Lesson number ${i}`,
        scope: 'one-instance',
        scopeLimits: ['observed-once', 'no-future-guarantee'],
        tags: ['filesystem_inspect'],
        observedAt: new Date().toISOString(),
      })
      await engine.deriveKnowledge(
        {
          knowledgeId: `know-cap-${i}`,
          kind: 'tool-behaviour',
          claim: `Claim number ${i}`,
          scope: 'one-environment',
          scopeLimits: ['observed-in-one-environment', 'no-future-guarantee'],
          supports: [`exp-cap-${i}`],
          tags: ['filesystem_inspect'],
          observedAt: new Date().toISOString(),
        },
        'core',
      )
    }

    const advice = recallRelevantLearning(engine, {
      capabilities: ['filesystem.inspect'],
      goal: 'Inspect directory files',
      maxRecords: 3,
    })

    expect(advice.lessons.length).toBe(3)
    expect(advice.consideredIds.length).toBe(3)
  })

  it('adapts Mission planning with recalled advice and documents consideredLessons', async () => {
    const testFile = join(dir, 'example-doc.txt')
    await writeFile(testFile, 'document content')

    const provider = new FakeModelProvider()
    let lastPrompt = ''
    vi.spyOn(provider, 'complete').mockImplementation(async (request) => {
      lastPrompt = request.prompt
      return {
        requestId: request.requestId,
        providerId: provider.id,
        model: provider.model,
        inputTokens: 30,
        outputTokens: 80,
        text: JSON.stringify({
          steps: [
            { intent: 'Inspect verified file', capability: 'filesystem.inspect', input: { path: testFile }, dependsOn: [] },
          ],
        }),
      }
    })

    const dataPath = join(dir, 'events.jsonl')
    core = createCore({
      dataPath,
      providers: [provider],
      missionKey: new Uint8Array(32).fill(3),
      missionReadRoots: [dir],
    })
    await core.start()

    // 1. Manually admit a verified outcome into learning engine to simulate prior experience
    const learning = core.learningEngineInstance()!
    const step = {
      stepId: 'prior-step-1',
      runId: 'prior-run-1',
      key: 'step_0',
      index: 0,
      status: 'verified' as const,
      attempts: 1,
      capability: 'filesystem.inspect',
      verifier: 'filesystem.inspect.verified',
      approvalId: null,
      startedAt: new Date().toISOString(),
      settledAt: new Date().toISOString(),
      reason: null,
    }
    const ver = {
      verificationId: 'prior-ver-1',
      runId: 'prior-run-1',
      stepId: 'prior-step-1',
      verifier: 'filesystem.inspect.verified',
      status: 'passed' as const,
      verdictAt: new Date().toISOString(),
      reason: 'passed',
    }
    await admitWorkStepOutcome(learning, {
      step,
      verification: ver,
      missionContent: null,
      nowIso: new Date().toISOString(),
    })

    expect(learning.records().knowledge.length).toBe(1)
    const priorKnowledgeId = learning.records().knowledge[0]!.knowledgeId

    // 2. Plan a new mission
    const createRes = await core.handleCommand({
      command: 'mission.create',
      requestId: 'create-adap-1',
      payload: { title: 'Adaptive Mission', intent: `Inspect file ${testFile}` },
    })
    const missionId = createRes.mission!.missionId!

    const scope = workforceOwnerScope(core)
    const worker = await scope.createWorker({ name: 'PlannerAgent', specialisation: 'general' })
    await scope.assignCapability(worker.workerId!, 'cognition.request')

    await core.handleCommand({
      command: 'cognition.grant.create',
      requestId: 'grant-adap-1',
      payload: {
        grantId: 'grant-adaptive',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        allowedOrigins: ['agent'],
        allowedCauses: ['run_finished'],
        goalId: missionId,
        backgroundAllowed: true,
        maxCalls: 1,
        maxOutputTokens: 2048,
      },
    })

    const planned = await core.planMissionGoal({ missionId, grantId: 'grant-adaptive', continueAfterVerification: true })
    expect(planned.ok).toBe(true)

    if (!planned.ok) throw new Error('planning failed')

    // Verify model received the advisory prior experience context
    expect(lastPrompt).toContain('ADVISORY PRIOR EXPERIENCE (Non-authoritative):')
    expect(lastPrompt).toContain('filesystem.inspect verified file metadata')

    // Verify execution plan documented the considered lessons transparently
    expect(planned.execution.consideredLessons).toContain(priorKnowledgeId)
    expect(planned.execution.adaptiveRationale).toContain('Considered 1 prior operational lesson(s).')
  })

  it('guarantees that recalled learning never bypasses capability validation or authorization', async () => {
    const provider = new FakeModelProvider()
    vi.spyOn(provider, 'complete').mockImplementation(async (request) => ({
      requestId: request.requestId,
      providerId: provider.id,
      model: provider.model,
      inputTokens: 30,
      outputTokens: 80,
      text: JSON.stringify({
        steps: [
          // Attempt to call an unregistered capability suggested by an adversarial "learned" claim
          { intent: 'Run unauthorized root tool', capability: 'shell.exec', input: { cmd: 'rm -rf' }, dependsOn: [] },
        ],
      }),
    }))

    const dataPath = join(dir, 'events.jsonl')
    core = createCore({
      dataPath,
      providers: [provider],
      missionKey: new Uint8Array(32).fill(4),
      missionReadRoots: [dir],
    })
    await core.start()

    const createRes = await core.handleCommand({
      command: 'mission.create',
      requestId: 'create-safe-1',
      payload: { title: 'Safe Mission', intent: 'Run system maintenance' },
    })
    const missionId = createRes.mission!.missionId!

    const scope = workforceOwnerScope(core)
    const worker = await scope.createWorker({ name: 'PlannerAgent', specialisation: 'general' })
    await scope.assignCapability(worker.workerId!, 'cognition.request')

    await core.handleCommand({
      command: 'cognition.grant.create',
      requestId: 'grant-safe-1',
      payload: {
        grantId: 'grant-safe',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        allowedOrigins: ['agent'],
        allowedCauses: ['run_finished'],
        goalId: missionId,
        backgroundAllowed: true,
        maxCalls: 1,
        maxOutputTokens: 2048,
      },
    })

    const planned = await core.planMissionGoal({ missionId, grantId: 'grant-safe', continueAfterVerification: true })
    // Must be rejected as capability_unavailable or invalid_proposal or planning_failed
    expect(planned.ok).toBe(false)
    expect(['capability_unavailable', 'invalid_proposal', 'planning_failed']).toContain((planned as { reason: string }).reason)
  })
})
