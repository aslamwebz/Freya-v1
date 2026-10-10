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
import type { MissionEngine } from '../../core/missions/engine'

let dir: string
let core: Core | undefined

function internal(c: Core | undefined) {
  return c as unknown as { missionEngine?: MissionEngine }
}

/**
 * Deterministic planner policy:
 * - Inspects user request messages and advisory prior experience.
 * - Does NOT key off call counters or session numbers.
 * - When advisory prior experience includes a verified target recommendation, adopts it directly (Plan 1).
 * - When corrective replan is triggered by failure feedback / previous plan revision, adopts fallback verified target (Plan 2).
 * - In baseline unguided conditions (or when advice is absent/irrelevant/retracted), chooses the unguided candidate (invalidFile).
 */
function createPlannerPolicy(provider: FakeModelProvider, validFile: string, invalidFile: string) {
  return async (request: {
    requestId: string
    prompt: string
    messages?: readonly { readonly role: string; readonly content: string }[]
  }) => {
    let userContent: { advisoryPriorExperience?: string; failure?: unknown; verifiedSteps?: unknown[]; correctiveReplanningAdvice?: string } = {}
    try {
      const userMsg = request.messages?.find((m) => m.role === 'user')?.content
      if (userMsg) userContent = JSON.parse(userMsg)
    } catch {
      // fallback
    }

    const advice = userContent.advisoryPriorExperience ?? ''
    const hasValidAdvice = advice.includes('valid-dataset.json') || advice.includes(validFile)

    // Policy Rule 1: Recalled experience recommends verified target -> select validFile directly on Plan 1
    if (hasValidAdvice) {
      return {
        requestId: request.requestId,
        providerId: provider.id,
        model: provider.model,
        inputTokens: 50,
        outputTokens: 75,
        text: JSON.stringify({
          steps: [
            {
              intent: 'Inspect verified dataset guided by recalled experience',
              capability: 'filesystem.inspect',
              input: { path: validFile },
              dependsOn: [],
            },
          ],
        }),
      }
    }

    const isReplan =
      'verifiedSteps' in userContent ||
      'correctiveReplanningAdvice' in userContent ||
      Boolean(userContent.failure) ||
      (request.messages?.[0]?.content?.includes('CORRECTIVE REPLANNING REQUIRED') ?? false)

    // Policy Rule 2: Corrective replan prompted with failure feedback -> select fallback validFile
    if (isReplan) {
      return {
        requestId: request.requestId,
        providerId: provider.id,
        model: provider.model,
        inputTokens: 60,
        outputTokens: 75,
        text: JSON.stringify({
          steps: [
            {
              intent: 'Inspect verified dataset fallback after step failure',
              capability: 'filesystem.inspect',
              input: { path: validFile },
              dependsOn: [],
            },
          ],
        }),
      }
    }

    // Policy Rule 3: Baseline / unguided proposal -> selects invalidFile (which will fail and require replan)
    return {
      requestId: request.requestId,
      providerId: provider.id,
      model: provider.model,
      inputTokens: 40,
      outputTokens: 75,
      text: JSON.stringify({
        steps: [
          {
            intent: 'Inspect target dataset (unguided initial proposal)',
            capability: 'filesystem.inspect',
            input: { path: invalidFile },
            dependsOn: [],
          },
        ],
      }),
    }
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-closed-loop-'))
})

afterEach(async () => {
  await core?.stop('teardown')
  core = undefined
  await rm(dir, { recursive: true, force: true })
})

describe('Phase 3D — Closed-Loop Intelligence Validation', () => {
  it('proves learning from experience across encrypted restarts: baseline fails and replans -> restart -> adapted mission succeeds on first attempt -> retraction reverts policy', async () => {
    if (!bindingAvailable) return

    const validFile = join(dir, 'valid-dataset.json')
    const invalidFile = join(dir, 'missing-dataset.json')
    await writeFile(validFile, JSON.stringify({ verified: true, count: 42 }))

    const dataPath = join(dir, 'events.jsonl')
    const vaultPath = join(dir, 'freya.db')
    const binding = await loadTestBinding()

    // ------------------------------------------------------------------------
    // SESSION 1: Baseline run with no prior learning.
    // Deterministic policy makes unguided choice -> fails step -> replans -> succeeds -> admits learning.
    // ------------------------------------------------------------------------
    let session1PlanCount = 0
    const session1Prompts: string[] = []
    const provider1 = new FakeModelProvider()
    const policy1 = createPlannerPolicy(provider1, validFile, invalidFile)
    vi.spyOn(provider1, 'complete').mockImplementation(async (request) => {
      session1PlanCount += 1
      session1Prompts.push(request.prompt)
      return policy1(request)
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

    // Create Mission A (Baseline)
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

    // Plan Mission A (Plan 1: unguided candidate)
    const plan1Outcome = await core.planMissionGoal({
      missionId: missionIdA,
      grantId: 'grant-a',
      continueAfterVerification: true,
    })
    expect(plan1Outcome.ok).toBe(true)

    // Execute step 1 -> Fails because invalidFile does not exist
    await core.advanceMission(missionIdA, 'manual')

    // Wait for step failure -> mission status becomes blocked
    await vi.waitFor(
      () => {
        const m = core!.mission().missions.find((item) => item.missionId === missionIdA)
        expect(m?.status).toBe('blocked')
      },
      { timeout: 8000 },
    )

    // Replan Mission A (Plan 2: Corrective replan with failure feedback)
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
        const m = internal(core).missionEngine?.record(missionIdA)?.activePlan?.steps[0]
        expect(m?.status).toBe('verified')
      },
      { timeout: 5000 },
    )

    // Complete Mission A if pending completion decision
    if (core.mission().missions.find((item) => item.missionId === missionIdA)?.status !== 'completed') {
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

    // Baseline measurements: Mission A required 2 plans (1 failed action + 1 replan)
    expect(session1PlanCount).toBe(2)

    // Clean shutdown of Session 1
    await core.stop('clean-restart')
    core = undefined

    // ------------------------------------------------------------------------
    // SESSION 2: Restart with same SQLCipher Vault -> Verify persistence -> Run Mission B
    // Uses the EXACT SAME deterministic planner policy function!
    // ------------------------------------------------------------------------
    let session2PlanCount = 0
    let session2Prompt = ''
    const provider2 = new FakeModelProvider()
    const policy2 = createPlannerPolicy(provider2, validFile, invalidFile)
    vi.spyOn(provider2, 'complete').mockImplementation(async (request) => {
      session2PlanCount += 1
      session2Prompt = request.prompt
      return policy2(request)
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

    // 1. Verify learning records recovered cleanly across application restart
    const proj2 = core.learning()
    expect(proj2.persistence.mode).toBe('encrypted')
    expect(proj2.persistence.durable).toBe(true)
    expect(proj2.counts.outcomes).toBeGreaterThanOrEqual(1)
    expect(proj2.counts.knowledge).toBeGreaterThanOrEqual(1)

    const recoveredRecords = core.learningEngineInstance()!.records()
    const recoveredClaim = recoveredRecords.knowledge.find((k) => k.knowledgeId === learnedClaim?.knowledgeId)
    expect(recoveredClaim?.status).toBe('admitted')

    // 2. Execute Mission B with similar goal using the same deterministic policy
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
        const m = internal(core).missionEngine?.record(missionIdB)?.activePlan?.steps[0]
        expect(m?.status).toBe('verified')
      },
      { timeout: 5000 },
    )

    // Complete Mission B if pending completion decision
    if (core.mission().missions.find((item) => item.missionId === missionIdB)?.status !== 'completed') {
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

    // Performance comparison:
    // Mission A required 2 plans (initial failure + replan)
    expect(session1PlanCount).toBe(2)
    // Mission B succeeded on plan 1 (0 replans, 1 attempt) directly due to recalled advice
    expect(session2PlanCount).toBe(1)
    expect(session2Prompt.length).toBeGreaterThan(0)

    // ------------------------------------------------------------------------
    // RETRACTION CONTROL: Retract all admitted learned claims -> Run Mission C
    // With the learned claims retracted, the exact same policy must revert to unguided proposal and fail step 1.
    // ------------------------------------------------------------------------
    const admittedClaims = core.learningEngineInstance()!.records().knowledge.filter((k) => k.status === 'admitted')
    expect(admittedClaims.length).toBeGreaterThanOrEqual(1)
    for (const claim of admittedClaims) {
      const withdrawResult = await core.withdrawLearningClaim(claim.knowledgeId)
      expect(withdrawResult.ok).toBe(true)
      expect(withdrawResult.outcome).toBe('withdrawn')
    }

    const afterRetractRecords = core.learningEngineInstance()!.records()
    expect(afterRetractRecords.knowledge.filter((k) => k.status === 'admitted').length).toBe(0)

    // Run Mission C with the same goal and same deterministic policy
    const resC = await core.handleCommand({
      command: 'mission.create',
      requestId: 'create-mis-c',
      payload: { title: 'Mission C', intent: 'Verify dataset json file' },
    })
    const missionIdC = resC.mission!.missionId!

    const scope3 = workforceOwnerScope(core)
    const worker3 = await scope3.createWorker({ name: 'WorkerC', specialisation: 'general' })
    await scope3.assignCapability(worker3.workerId!, 'cognition.request')

    await core.handleCommand({
      command: 'cognition.grant.create',
      requestId: 'grant-mis-c',
      payload: {
        grantId: 'grant-c',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        allowedOrigins: ['agent'],
        allowedCauses: ['run_finished'],
        goalId: missionIdC,
        backgroundAllowed: true,
        maxCalls: 5,
        maxOutputTokens: 16384,
      },
    })

    // Plan Mission C (Plan 1): advice is no longer recalled because claim is retracted
    const planC1 = await core.planMissionGoal({
      missionId: missionIdC,
      grantId: 'grant-c',
      continueAfterVerification: true,
    })
    expect(planC1.ok).toBe(true)

    // Advance step 1 -> Fails because policy reverted to invalidFile unguided choice!
    await core.advanceMission(missionIdC, 'manual')

    await vi.waitFor(
      () => {
        const m = core!.mission().missions.find((item) => item.missionId === missionIdC)
        expect(m?.status).toBe('blocked')
      },
      { timeout: 8000 },
    )

    // Replan Mission C (Plan 2: Corrective replan)
    const planC2 = await core.planMissionGoal({
      missionId: missionIdC,
      grantId: 'grant-c',
      continueAfterVerification: true,
      revision: true,
    })
    expect(planC2.ok).toBe(true)

    // Advance step 2 -> Succeeds with validFile fallback
    await core.advanceMission(missionIdC, 'manual')

    await vi.waitFor(
      () => {
        const m = internal(core).missionEngine?.record(missionIdC)?.activePlan?.steps[0]
        expect(m?.status).toBe('verified')
      },
      { timeout: 5000 },
    )

    // Mission C required 2 plans due to retracted learning, proving causal dependence on recalled experience
    expect(session2PlanCount).toBe(3) // 1 from Mission B + 2 from Mission C

    // Final safety invariants: authority none, confidence ceiling medium
    const finalProjection = core.learning()
    expect(finalProjection.authority).toBe('none')
    expect(finalProjection.confidenceCeiling).toBe('medium')
  })

  it('ensures that irrelevant lessons do not cause planner shortcutting', async () => {
    if (!bindingAvailable) return

    const validFile = join(dir, 'valid-dataset.json')
    const invalidFile = join(dir, 'missing-dataset.json')
    await writeFile(validFile, JSON.stringify({ verified: true, count: 42 }))

    const dataPath = join(dir, 'events-irrelevant.jsonl')
    const vaultPath = join(dir, 'freya-irrelevant.db')
    const binding = await loadTestBinding()

    const provider = new FakeModelProvider()
    const policy = createPlannerPolicy(provider, validFile, invalidFile)
    let planCount = 0
    vi.spyOn(provider, 'complete').mockImplementation(async (request) => {
      planCount += 1
      return policy(request)
    })

    core = createCore({
      dataPath,
      providers: [provider],
      missionKey: new Uint8Array(32).fill(9),
      missionReadRoots: [dir],
      vault: {
        path: vaultPath,
        keyProvider: new StaticVaultKeyProvider(testVaultKey()),
        binding,
      },
    })
    await core.start()

    // Manually admit an irrelevant lesson into the learning engine via the proper pipeline
    const le = core.learningEngineInstance()
    expect(le).toBeDefined()
    const nowIso = new Date().toISOString()
    const outRes = await le!.recordVerifiedOutcome({
      outcomeId: 'out-irr-1',
      sourceDomain: 'work',
      verificationId: 'ver-irr-1',
      verifierId: 'filesystem.inspect.verified',
      checked: 'Inspected unrelated-data.csv',
      subjectRef: 'work-step:irr-1',
      result: 'succeeded',
      establishedAt: nowIso,
      proposedConfidence: 'medium',
      actor: 'core',
    })
    expect(outRes.ok).toBe(true)

    const expRes = await le!.distilExperience('out-irr-1', {
      experienceId: 'exp-irr-1',
      kind: 'tool-lesson',
      lesson: 'filesystem.inspect successfully verified unrelated-data.csv',
      scope: 'one-instance',
      scopeLimits: ['observed-once', 'no-future-guarantee', 'outcome-verified-process-unverified'],
      tags: ['filesystem_inspect', 'verified_success'],
      observedAt: nowIso,
    })
    expect(expRes.ok).toBe(true)

    const deriveRes = await le!.deriveKnowledge(
      {
        knowledgeId: 'know-irrelevant-1',
        kind: 'tool-behaviour',
        claim: 'Observed that filesystem.inspect inspected unrelated-data.csv in this setup.',
        scope: 'one-environment',
        scopeLimits: ['observed-in-one-environment', 'no-future-guarantee'],
        supports: ['exp-irr-1'],
        tags: ['filesystem_inspect'],
        observedAt: nowIso,
      },
      'core',
    )
    expect(deriveRes.ok).toBe(true)

    // Verify irrelevant claim was admitted
    const records = le!.records()
    expect(records.knowledge.some((k) => k.knowledgeId === 'know-irrelevant-1' && k.status === 'admitted')).toBe(true)

    // Create and plan a mission for our dataset goal
    const res = await core.handleCommand({
      command: 'mission.create',
      requestId: 'create-mis-irr',
      payload: { title: 'Mission Irrelevant Check', intent: 'Verify dataset json file' },
    })
    const missionId = res.mission!.missionId!

    const scope = workforceOwnerScope(core)
    const worker = await scope.createWorker({ name: 'WorkerIrr', specialisation: 'general' })
    await scope.assignCapability(worker.workerId!, 'cognition.request')

    await core.handleCommand({
      command: 'cognition.grant.create',
      requestId: 'grant-mis-irr',
      payload: {
        grantId: 'grant-irr',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        allowedOrigins: ['agent'],
        allowedCauses: ['run_finished'],
        goalId: missionId,
        backgroundAllowed: true,
        maxCalls: 5,
        maxOutputTokens: 16384,
      },
    })

    const planOutcome = await core.planMissionGoal({
      missionId,
      grantId: 'grant-irr',
      continueAfterVerification: true,
    })
    expect(planOutcome.ok).toBe(true)

    // Execute step 1: because the admitted lesson is irrelevant to valid-dataset.json,
    // the planner policy made the unguided candidate proposal (invalidFile), which fails!
    await core.advanceMission(missionId, 'manual')

    await vi.waitFor(
      () => {
        const m = core!.mission().missions.find((item) => item.missionId === missionId)
        expect(m?.status).toBe('blocked')
      },
      { timeout: 8000 },
    )

    // Verifies that the irrelevant lesson did NOT trigger false shortcutting
    expect(planCount).toBe(1)
  })
})
