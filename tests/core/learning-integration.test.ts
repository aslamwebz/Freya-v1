// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore, type Core } from '../../core/index'
import { FakeModelProvider } from '../../core/model/fake-provider'
import { StaticVaultKeyProvider } from '../../core/vault'
import { testVaultKey } from './testKey'
import { bindingAvailable, loadTestBinding } from './vault/binding'
import { workforceOwnerScope } from '../../core/testing'
import type { LearningProjection } from '../../core/protocol/learning'

let dir: string
let core: Core | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-learning-int-'))
})

afterEach(async () => {
  await core?.stop('teardown')
  core = undefined
  await rm(dir, { recursive: true, force: true })
})

describe('Phase 3A — Production Learning Foundation', () => {
  it('exposes truthful initial learning projection without vault', async () => {
    const dataPath = join(dir, 'events.jsonl')
    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
    })
    await core.start()

    const proj = core.learning()
    expect(proj.mode).toBe('available')
    expect(proj.counts.outcomes).toBe(0)
    expect(proj.counts.experiences).toBe(0)
    expect(proj.counts.knowledge).toBe(0)
    expect(proj.authority).toBe('none')
    expect(proj.confidenceCeiling).toBe('medium')
    expect(proj.persistence.durable).toBe(false)
    expect(proj.persistence.mode).toBe('ephemeral')
  })

  it('exposes durable encrypted persistence mode when vault is configured', async () => {
    if (!bindingAvailable) return
    const dataPath = join(dir, 'events.jsonl')
    const vaultPath = join(dir, 'freya.db')
    const binding = await loadTestBinding()

    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
      vault: {
        path: vaultPath,
        keyProvider: new StaticVaultKeyProvider(testVaultKey()),
        binding,
      },
    })
    await core.start()

    const proj = core.learning()
    expect(proj.mode).toBe('available')
    expect(proj.persistence.mode).toBe('encrypted')
    expect(proj.persistence.durable).toBe(true)
    expect(proj.persistence.degraded).toBe(false)
  })

  it('admits real verified Work step outcome into LearningEngine without paid LLM calls', async () => {
    const testFile = join(dir, 'target-sample.txt')
    await writeFile(testFile, 'verified data content')

    const provider = new FakeModelProvider()
    const completeSpy = vi.spyOn(provider, 'complete').mockImplementation(async (request) => ({
      requestId: request.requestId,
      providerId: provider.id,
      model: provider.model,
      inputTokens: 30,
      outputTokens: 80,
      text: JSON.stringify({
        steps: [
          { intent: 'Inspect file', capability: 'filesystem.inspect', input: { path: testFile }, dependsOn: [] },
        ],
      }),
    }))

    const dataPath = join(dir, 'events.jsonl')
    core = createCore({
      dataPath,
      providers: [provider],
      missionKey: new Uint8Array(32).fill(7),
      missionReadRoots: [dir],
    })
    await core.start()

    // Listen for learning projection updates
    const updates: LearningProjection[] = []
    const unsub = core.onLearning((p) => updates.push(p))

    // Create and execute a verified mission with file inspection
    const createRes = await core.handleCommand({
      command: 'mission.create',
      requestId: 'create-1',
      payload: { title: 'File verify mission', intent: `Inspect file ${testFile}` },
    })
    const missionId = createRes.mission!.missionId!

    const scope = workforceOwnerScope(core)
    const worker = await scope.createWorker({ name: 'Inspector', specialisation: 'general' })
    await scope.assignCapability(worker.workerId!, 'cognition.request')

    await core.handleCommand({
      command: 'cognition.grant.create',
      requestId: 'grant-1',
      payload: {
        grantId: 'grant-plan',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        allowedOrigins: ['agent'],
        allowedCauses: ['run_finished'],
        goalId: missionId,
        backgroundAllowed: true,
        maxCalls: 1,
        maxOutputTokens: 2048,
      },
    })

    const planned = await core.planMissionGoal({ missionId, grantId: 'grant-plan', continueAfterVerification: true })
    expect(planned.ok).toBe(true)

    // Execute step
    await core.advanceMission(missionId, 'manual')
    await vi.waitFor(
      () => expect(core!.mission().missions.find((m) => m.missionId === missionId)?.status).toBe('completed'),
      { timeout: 10000 },
    )

    // Wait for learning observation to settle
    await vi.waitFor(
      () => {
        const records = core!.learningEngineInstance()?.records()
        expect(records?.outcomes.length).toBeGreaterThanOrEqual(1)
      },
      { timeout: 5000 },
    )

    const engine = core.learningEngineInstance()!
    const records = engine.records()

    expect(records.outcomes.length).toBe(1)
    const outcome = records.outcomes[0]!
    expect(outcome.result).toBe('succeeded')
    expect(outcome.verifierId).toBe('filesystem.inspect.verified')
    expect(outcome.sourceDomain).toBe('work')

    expect(records.experiences.length).toBe(1)
    const exp = records.experiences[0]!
    expect(exp.kind).toBe('tool-lesson')
    expect(exp.scope).toBe('one-instance')
    expect(exp.scopeLimits).toContain('no-future-guarantee')

    expect(records.knowledge.length).toBe(1)
    const claim = records.knowledge[0]!
    expect(claim.kind).toBe('tool-behaviour')
    expect(claim.scope).toBe('one-environment')
    expect(claim.status).toBe('admitted')

    // Model was called ONLY for mission planning (1 call), ZERO calls for learning derivation
    expect(completeSpy).toHaveBeenCalledTimes(1)

    // Verify projection reflects counts
    const proj = core.learning()
    expect(proj.counts.outcomes).toBe(1)
    expect(proj.counts.experiences).toBe(1)
    expect(proj.counts.knowledge).toBe(1)
    expect(updates.length).toBeGreaterThan(1)

    unsub()
  })

  it('deduplicates identical step inspections and filters repetitive checks', async () => {
    const testFile = join(dir, 'sample.txt')
    await writeFile(testFile, 'content')

    const dataPath = join(dir, 'events.jsonl')
    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
    })
    await core.start()

    const engine = core.learningEngineInstance()!

    // Fabricate two identical candidates using admitWorkStepOutcome directly
    const { admitWorkStepOutcome } = await import('../../core/learning/work-admission')
    const stepRecord = {
      stepId: 'step-duplicate-test',
      runId: 'run-1',
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
    const verificationRecord = {
      verificationId: 'ver-step-dup',
      runId: 'run-1',
      stepId: 'step-duplicate-test',
      verifier: 'filesystem.inspect.verified',
      status: 'passed' as const,
      verdictAt: new Date().toISOString(),
      reason: 'passed',
    }

    const first = await admitWorkStepOutcome(engine, {
      step: stepRecord,
      verification: verificationRecord,
      missionContent: null,
      nowIso: new Date().toISOString(),
    })
    expect(first.admitted).toBe(true)

    // Second admission of same stepId must be rejected as duplicate
    const second = await admitWorkStepOutcome(engine, {
      step: stepRecord,
      verification: verificationRecord,
      missionContent: null,
      nowIso: new Date().toISOString(),
    })
    expect(second.admitted).toBe(false)
    expect(second.reason).toContain('already been admitted')
    expect(engine.records().outcomes.length).toBe(1)
  })

  it('records verified failures cleanly as failure-lesson and failure-cause', async () => {
    const dataPath = join(dir, 'events.jsonl')
    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
    })
    await core.start()

    const engine = core.learningEngineInstance()!
    const { admitWorkStepOutcome } = await import('../../core/learning/work-admission')

    const failedStep = {
      stepId: 'step-fail-1',
      runId: 'run-fail',
      key: 'step_0',
      index: 0,
      status: 'failed' as const,
      attempts: 1,
      capability: 'filesystem.inspect',
      verifier: 'filesystem.inspect.verified',
      approvalId: null,
      startedAt: new Date().toISOString(),
      settledAt: new Date().toISOString(),
      reason: 'file not found',
    }
    const failedVer = {
      verificationId: 'ver-fail-1',
      runId: 'run-fail',
      stepId: 'step-fail-1',
      verifier: 'filesystem.inspect.verified',
      status: 'failed' as const,
      verdictAt: new Date().toISOString(),
      reason: 'file missing',
    }

    const result = await admitWorkStepOutcome(engine, {
      step: failedStep,
      verification: failedVer,
      missionContent: null,
      nowIso: new Date().toISOString(),
    })

    expect(result.admitted).toBe(true)
    const records = engine.records()
    const outcome = records.outcomes.find((o) => o.outcomeId === result.outcomeId)
    expect(outcome?.result).toBe('failed')

    const exp = records.experiences.find((e) => e.experienceId === result.experienceId)
    expect(exp?.kind).toBe('failure-lesson')

    const kn = records.knowledge.find((k) => k.knowledgeId === result.knowledgeId)
    expect(kn?.kind).toBe('failure-cause')
  })

  it('persists and recovers learning records across application restart with SQLCipher Vault', async () => {
    if (!bindingAvailable) return
    const dataPath = join(dir, 'events.jsonl')
    const vaultPath = join(dir, 'freya.db')
    const binding = await loadTestBinding()

    // 1. First session: start Core with Vault, admit an outcome
    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
      vault: {
        path: vaultPath,
        keyProvider: new StaticVaultKeyProvider(testVaultKey()),
        binding,
      },
    })
    await core.start()

    const engine1 = core.learningEngineInstance()!
    const { admitWorkStepOutcome } = await import('../../core/learning/work-admission')

    const step = {
      stepId: 'step-restart-persistence',
      runId: 'run-p',
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
      verificationId: 'ver-p',
      runId: 'run-p',
      stepId: 'step-restart-persistence',
      verifier: 'filesystem.inspect.verified',
      status: 'passed' as const,
      verdictAt: new Date().toISOString(),
      reason: 'ok',
    }

    const admitted = await admitWorkStepOutcome(engine1, {
      step,
      verification: ver,
      missionContent: null,
      nowIso: new Date().toISOString(),
    })
    expect(admitted.admitted).toBe(true)

    // Stop Core cleanly
    await core.stop('restart-test')
    core = undefined

    // 2. Second session: recreate Core pointing to same Vault path
    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
      vault: {
        path: vaultPath,
        keyProvider: new StaticVaultKeyProvider(testVaultKey()),
        binding,
      },
    })
    await core.start()

    const engine2 = core.learningEngineInstance()!
    const recoveredRecords = engine2.records()

    expect(recoveredRecords.outcomes.length).toBe(1)
    expect(recoveredRecords.outcomes[0]?.outcomeId).toBe(admitted.outcomeId)
    expect(recoveredRecords.experiences.length).toBe(1)
    expect(recoveredRecords.knowledge.length).toBe(1)

    const proj = core.learning()
    expect(proj.persistence.mode).toBe('encrypted')
    expect(proj.persistence.durable).toBe(true)
    expect(proj.counts.outcomes).toBe(1)
    expect(proj.counts.experiences).toBe(1)
    expect(proj.counts.knowledge).toBe(1)
  })

  it('enforces that learned proposals are strictly inert and carry authority none', async () => {
    const dataPath = join(dir, 'events.jsonl')
    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
    })
    await core.start()

    const proj = core.learning()
    expect(proj.authority).toBe('none')
    for (const proposal of proj.proposals) {
      expect(proposal.authority).toBe('none')
      expect(proposal.grantsCapability).toBe(false)
      expect(proposal.executable).toBe(false)
    }
  })
})
