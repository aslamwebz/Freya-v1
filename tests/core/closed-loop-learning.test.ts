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

let dir: string
let core: Core | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-closed-loop-'))
})

afterEach(async () => {
  await core?.stop('teardown')
  core = undefined
  await rm(dir, { recursive: true, force: true })
})

describe('Phase 3D — Closed-Loop Intelligence Validation', () => {
  it('demonstrates learning from experience across restarts: Mission A learns -> restart -> Mission B adapts and succeeds', async () => {
    if (!bindingAvailable) return

    const validFile = join(dir, 'valid-dataset.json')
    const invalidFile = join(dir, 'missing-dataset.json')
    await writeFile(validFile, JSON.stringify({ verified: true, count: 42 }))

    const dataPath = join(dir, 'events.jsonl')
    const vaultPath = join(dir, 'freya.db')
    const binding = await loadTestBinding()

    // ------------------------------------------------------------------------
    // SESSION 1: Mission A runs, fails initial step, replans, succeeds, learns
    // ------------------------------------------------------------------------
    let session1PlanCount = 0
    let session1Prompts: string[] = []
    const provider1 = new FakeModelProvider()
    vi.spyOn(provider1, 'complete').mockImplementation(async (request) => {
      session1PlanCount += 1
      session1Prompts.push(request.prompt)

      if (session1PlanCount === 1) {
        // First proposal: proposes nonexistent file path (will fail verification)
        return {
          requestId: request.requestId,
          providerId: provider1.id,
          model: provider1.model,
          inputTokens: 40,
          outputTokens: 75,
          text: JSON.stringify({
            steps: [
              {
                intent: 'Inspect target dataset',
                capability: 'filesystem.inspect',
                input: { path: invalidFile },
                dependsOn: [],
              },
            ],
          }),
        }
      }

      // Second proposal: corrective replan proposes the valid dataset
      return {
        requestId: request.requestId,
        providerId: provider1.id,
        model: provider1.model,
        inputTokens: 60,
        outputTokens: 75,
        text: JSON.stringify({
          steps: [
            {
              intent: 'Inspect verified dataset fallback',
              capability: 'filesystem.inspect',
              input: { path: validFile },
              dependsOn: [],
            },
          ],
        }),
      }
    })

    core = createCore({
      dataPath,
      providers: [provider1],
      missionKey: new Uint8Array(32).fill(9),
      missionReadRoots: [dir],
      vault: {
        path: vaultPath,
        keyProvider: new StaticVaultKeyProvider(testVaultKey()),
        binding,
      },
    })
    await core.start()

    // Create Mission A
    const resA = await core.handleCommand({
      command: 'mission.create',
      requestId: 'create-mis-a',
      payload: { title: 'Mission A', intent: 'Verify dataset json file' },
    })
    const missionIdA = resA.mission!.missionId!

    const scope1 = workforceOwnerScope(core)
    const worker1 = await scope1.createWorker({ name: 'WorkerA', specialisation: 'general' })
    await scope1.assignCapability(worker1.workerId!, 'cognition.request')

    await core.handleCommand({
      command: 'cognition.grant.create',
      requestId: 'grant-mis-a',
      payload: {
        grantId: 'grant-a',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        allowedOrigins: ['agent'],
        allowedCauses: ['run_finished'],
        goalId: missionIdA,
        backgroundAllowed: true,
        maxCalls: 5,
        maxOutputTokens: 16384,
      },
    })

    // Plan Mission A (Plan 1)
    const plan1Outcome = await core.planMissionGoal({
      missionId: missionIdA,
      grantId: 'grant-a',
      continueAfterVerification: true,
    })
    expect(plan1Outcome.ok).toBe(true)

    // Execute step 1 -> Fails because file does not exist
    await core.advanceMission(missionIdA, 'manual')

    // Wait for step failure -> mission status becomes blocked
    await vi.waitFor(
      () => {
        const m = core!.mission().missions.find((item) => item.missionId === missionIdA)
        expect(m?.status).toBe('blocked')
      },
      { timeout: 8000 },
    )

    // Replan Mission A (Plan 2: Corrective replan)
    const plan2Outcome = await core.planMissionGoal({
      missionId: missionIdA,
      grantId: 'grant-a',
      continueAfterVerification: true,
      revision: true,
    })
    expect(plan2Outcome.ok).toBe(true)

    // Execute step 2 -> Succeeds with validFile
    await core.advanceMission(missionIdA, 'manual')

    // Wait for step 2 verification
    await vi.waitFor(
      () => {
        const m = (core as any).missionEngine?.record(missionIdA)?.activePlan?.steps[0]
        expect(m?.status).toBe('verified')
      },
      { timeout: 5000 },
    )

    // Complete Mission A if pending completion decision
    if (core!.mission().missions.find((item) => item.missionId === missionIdA)?.status !== 'completed') {
      await core.advanceMission(missionIdA, 'manual')
    }

    // Wait for Mission A completion
    await vi.waitFor(
      () => {
        const m = core!.mission().missions.find((item) => item.missionId === missionIdA)
        expect(m?.status).toBe('completed')
      },
      { timeout: 5000 },
    )

    // Wait for learning engine observation to settle into SQLCipher Vault
    await vi.waitFor(
      () => {
        const records = core!.learningEngineInstance()?.records()
        expect(records?.outcomes.length).toBeGreaterThanOrEqual(1)
        expect(records?.knowledge.length).toBeGreaterThanOrEqual(1)
      },
      { timeout: 5000 },
    )

    const session1Records = core.learningEngineInstance()!.records()
    expect(session1Records.outcomes.some((o) => o.result === 'succeeded')).toBe(true)
    const learnedClaim = session1Records.knowledge.find((k) => k.status === 'admitted')
    expect(learnedClaim).toBeDefined()

    // Clean shutdown of Session 1
    await core.stop('clean-restart')
    core = undefined

    // ------------------------------------------------------------------------
    // SESSION 2: Restart with same SQLCipher Vault -> Verify persistence -> Run Mission B
    // ------------------------------------------------------------------------
    let session2PlanCount = 0
    let session2Prompt = ''
    const provider2 = new FakeModelProvider()
    vi.spyOn(provider2, 'complete').mockImplementation(async (request) => {
      session2PlanCount += 1
      session2Prompt = request.prompt

      // Model uses the recalled lesson to directly propose validFile on Plan 1
      return {
        requestId: request.requestId,
        providerId: provider2.id,
        model: provider2.model,
        inputTokens: 50,
        outputTokens: 75,
        text: JSON.stringify({
          steps: [
            {
              intent: 'Inspect verified dataset',
              capability: 'filesystem.inspect',
              input: { path: validFile },
              dependsOn: [],
            },
          ],
        }),
      }
    })

    // Re-create Core pointing to same encrypted Vault
    core = createCore({
      dataPath,
      providers: [provider2],
      missionKey: new Uint8Array(32).fill(9),
      missionReadRoots: [dir],
      vault: {
        path: vaultPath,
        keyProvider: new StaticVaultKeyProvider(testVaultKey()),
        binding,
      },
    })
    await core.start()

    // 1. Verify that learning records recovered cleanly across application restart
    const proj2 = core.learning()
    expect(proj2.persistence.mode).toBe('encrypted')
    expect(proj2.persistence.durable).toBe(true)
    expect(proj2.counts.outcomes).toBeGreaterThanOrEqual(1)
    expect(proj2.counts.knowledge).toBeGreaterThanOrEqual(1)

    const recoveredRecords = core.learningEngineInstance()!.records()
    const recoveredClaim = recoveredRecords.knowledge.find((k) => k.knowledgeId === learnedClaim?.knowledgeId)
    expect(recoveredClaim?.status).toBe('admitted')

    // 2. Execute Mission B with similar goal
    const resB = await core.handleCommand({
      command: 'mission.create',
      requestId: 'create-mis-b',
      payload: { title: 'Mission B', intent: 'Verify dataset json file' },
    })
    const missionIdB = resB.mission!.missionId!

    const scope2 = workforceOwnerScope(core)
    const worker2 = await scope2.createWorker({ name: 'WorkerB', specialisation: 'general' })
    await scope2.assignCapability(worker2.workerId!, 'cognition.request')

    await core.handleCommand({
      command: 'cognition.grant.create',
      requestId: 'grant-mis-b',
      payload: {
        grantId: 'grant-b',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        allowedOrigins: ['agent'],
        allowedCauses: ['run_finished'],
        goalId: missionIdB,
        backgroundAllowed: true,
        maxCalls: 5,
        maxOutputTokens: 16384,
      },
    })

    // Plan Mission B
    const planBOutcome = await core.planMissionGoal({
      missionId: missionIdB,
      grantId: 'grant-b',
      continueAfterVerification: true,
    })

    expect(planBOutcome.ok).toBe(true)
    if (planBOutcome.ok) {
      // Considered lessons from prior mission
      expect(planBOutcome.execution.consideredLessons).toContain(recoveredClaim?.knowledgeId)
      expect(planBOutcome.execution.adaptiveRationale).toContain('Considered')
      expect(planBOutcome.plan.revision).toBe(1) // Succeeded on Plan 1!
    }

    // Execute step for Mission B
    await core.advanceMission(missionIdB, 'manual')

    // Wait for step verification
    await vi.waitFor(
      () => {
        const m = (core as any).missionEngine?.record(missionIdB)?.activePlan?.steps[0]
        expect(m?.status).toBe('verified')
      },
      { timeout: 5000 },
    )

    // Complete Mission B if pending completion decision
    if (core!.mission().missions.find((item) => item.missionId === missionIdB)?.status !== 'completed') {
      await core.advanceMission(missionIdB, 'manual')
    }

    // Wait for Mission B completion on the first attempt
    await vi.waitFor(
      () => {
        const m = core!.mission().missions.find((item) => item.missionId === missionIdB)
        expect(m?.status).toBe('completed')
      },
      { timeout: 5000 },
    )

    // ------------------------------------------------------------------------
    // VERIFICATION ASSERTIONS: Closed-loop performance comparison
    // ------------------------------------------------------------------------
    expect(session2Prompt.length).toBeGreaterThan(0)
    // Mission A required 2 plans (initial failure + replan)
    expect(session1PlanCount).toBe(2)
    // Mission B succeeded on plan 1 (0 replans, 1 attempt)
    expect(session2PlanCount).toBe(1)

    // Zero paid LLM calls across both sessions
    // Learned procedure carried authority 'none'
    const finalProjection = core.learning()
    expect(finalProjection.authority).toBe('none')
    expect(finalProjection.confidenceCeiling).toBe('medium')
  })
})
