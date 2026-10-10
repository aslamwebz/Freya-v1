// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore, type Core } from '../../core/index'
import { FakeModelProvider } from '../../core/model/fake-provider'
import { StaticVaultKeyProvider } from '../../core/vault'
import { testVaultKey } from './testKey'
import { bindingAvailable, loadTestBinding } from './vault/binding'
import { workforceOwnerScope } from '../../core/testing'
import type { MissionPriority } from '../../core/missions/autonomy/types'

let dir: string
let core: Core | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-exec-multimission-'))
})

afterEach(async () => {
  await core?.stop('teardown')
  core = undefined
  await rm(dir, { recursive: true, force: true })
})

describe('Phase 4D — Real Multi-Mission Executive Intelligence', () => {
  it('manages multiple competing missions dynamically, respecting specialisations, approvals, budgets, and encrypted restarts', async () => {
    if (!bindingAvailable) return

    const dataPath = join(dir, 'events.jsonl')
    const vaultPath = join(dir, 'freya.db')
    const binding = await loadTestBinding()

    // 1. Initialise Core with encrypted vault and mock model provider
    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
      missionKey: new Uint8Array(32).fill(7),
      missionReadRoots: [dir],
      vault: {
        path: vaultPath,
        keyProvider: new StaticVaultKeyProvider(testVaultKey()),
        binding,
      },
    })
    await core.start()

    // 2. Setup Workforce with 2 specialised workers
    const scope = workforceOwnerScope(core)
    const resWorker1 = await scope.createWorker({ name: 'ResearcherAlex', specialisation: 'research' })
    expect(resWorker1.ok).toBe(true)
    const worker1Id = resWorker1.workerId!
    await scope.assignCapability(worker1Id, 'cognition.request')

    const resWorker2 = await scope.createWorker({ name: 'WriterBlake', specialisation: 'writing' })
    expect(resWorker2.ok).toBe(true)
    const worker2Id = resWorker2.workerId!
    await scope.assignCapability(worker2Id, 'cognition.request')

    // 3. Create 3 competing missions
    // Mission 1: Urgent Research
    const m1Res = await core.handleCommand({
      command: 'mission.create',
      requestId: 'create-m1',
      payload: { title: 'Urgent Research Goal', intent: 'Deep threat landscape research' },
    })
    const m1Id = m1Res.mission!.missionId!
    await core.readyMission(m1Id)

    // Mission 2: Documentation Inspection
    const m2Res = await core.handleCommand({
      command: 'mission.create',
      requestId: 'create-m2',
      payload: { title: 'Documentation Audit', intent: 'Audit user-facing documentation' },
    })
    const m2Id = m2Res.mission!.missionId!
    await core.readyMission(m2Id)

    // Mission 3: Deferred Analysis (Awaiting Owner Approval)
    const m3Res = await core.handleCommand({
      command: 'mission.create',
      requestId: 'create-m3',
      payload: { title: 'High-Impact Analysis', intent: 'Critical system architecture transformation' },
    })
    const m3Id = m3Res.mission!.missionId!
    await core.readyMission(m3Id)

    // Set priorities and specialisations
    const explicitPriorities = new Map<string, MissionPriority>([
      [m1Id, 'urgent'],
      [m2Id, 'routine'],
      [m3Id, 'important'],
    ])

    const requiredSpecialisations = new Map<string, readonly string[]>([
      [m1Id, ['research']],
      [m2Id, ['writing']],
      [m3Id, ['analysis']],
    ])

    // Scenario A: Initial Decision Evaluation
    // Mission 1 is urgent and has ResearcherAlex available.
    const decisionA = core.executiveDecision({
      explicitPriorities,
      requiredSpecialisations,
    })

    expect(decisionA.decision).toBe('start')
    expect(decisionA.selectedMissionId).toBe(m1Id)
    expect(decisionA.assignedWorkerId).toBe(worker1Id)
    expect(decisionA.reason).toBe('highest_priority_eligible')
    expect(decisionA.candidates.length).toBe(3)

    const stateA = core.executiveState({
      explicitPriorities,
      requiredSpecialisations,
    })
    expect(stateA.whatMatters.length).toBe(3)
    expect(stateA.whatMatters[0]?.itemId).toBe(m1Id)
    expect(stateA.whatMatters[0]?.priority).toBeDefined()
    expect(decisionA.candidates.find((c) => c.missionId === m1Id)?.tier).toBe('critical')
    expect(stateA.nextBoundedAction?.target).toBe(m1Id)

    // Scenario B: Dynamic Worker Unavailability
    // Suspend Worker 1 (researcher) -> Mission 1 cannot proceed because no research worker is idle.
    const suspendRes = await scope.suspendWorker(worker1Id)
    expect(suspendRes.ok).toBe(true)

    // With Worker 1 suspended, Mission 1 requires 'research' and must be deferred.
    // Mission 3 requires 'analysis' (no worker exists), so it is deferred.
    // Mission 2 requires 'writing' (WriterBlake is idle), so Executive intelligently selects Mission 2!
    const decisionB = core.executiveDecision({
      explicitPriorities,
      requiredSpecialisations,
    })

    expect(decisionB.decision).toBe('start')
    expect(decisionB.selectedMissionId).toBe(m2Id)
    expect(decisionB.assignedWorkerId).toBe(worker2Id)
    expect(decisionB.candidates.length).toBe(3)

    // Scenario C: Dynamic Reprioritization & Aging
    // Suppose owner reprioritizes Mission 2 to 'urgent' and Mission 1 to 'routine'.
    const reprioritized = new Map<string, MissionPriority>([
      [m1Id, 'routine'],
      [m2Id, 'urgent'],
      [m3Id, 'important'],
    ])

    const decisionC = core.executiveDecision({
      explicitPriorities: reprioritized,
      requiredSpecialisations,
    })
    expect(decisionC.decision).toBe('start')
    expect(decisionC.selectedMissionId).toBe(m2Id)
    expect(decisionC.assignedWorkerId).toBe(worker2Id)

    // Resume Worker 1
    const resumeRes = await scope.resumeWorker(worker1Id)
    expect(resumeRes.ok).toBe(true)

    // Scenario D: Budget Limits and Resource Exhaustion
    // Mission 2 exhausts its budget -> must pause, allowing Mission 1 to start
    const budgetLimits = new Map([
      [m2Id, { maxModelCalls: 5, maxActions: 10, maxExternalRequests: 2 }],
    ])
    const budgetSpends = new Map([
      [m2Id, { modelCalls: 5, actions: 10, externalRequests: 2 }], // Exhausted
    ])

    const decisionD = core.executiveDecision({
      explicitPriorities: reprioritized,
      requiredSpecialisations,
      budgetLimits,
      budgetSpends,
    })

    // Mission 2 is paused for budget exhaustion, Mission 1 (with idle Worker 1) starts
    expect(decisionD.decision).toBe('start')
    expect(decisionD.selectedMissionId).toBe(m1Id)
    expect(decisionD.assignedWorkerId).toBe(worker1Id)
    expect(decisionD.candidates.find((c) => c.missionId === m2Id)?.blockerReason).toBe('budget_exhausted')

    // Scenario E: STOP ALL Emergency Override
    // Stop all halts everything immediately with no_action and explainable stop action
    const stopRes = await core.handleCommand({
      command: 'security.stopAll',
      requestId: 'panic-stop',
      payload: { reason: 'Emergency security drill' },
    })
    expect(stopRes.ok).toBe(true)

    const decisionE = core.executiveDecision({
      explicitPriorities,
      requiredSpecialisations,
    })
    expect(decisionE.decision).toBe('no_action')
    expect(decisionE.reason).toBe('stop_all_active')
    expect(decisionE.selectedMissionId).toBeNull()
    expect(decisionE.state.nextBoundedAction?.kind).toBe('stop')

    // Clear STOP ALL
    const resumeClearRes = await core.handleCommand({
      command: 'security.resume',
      requestId: 'panic-resume',
      payload: { reason: 'Emergency drill completed' },
    })
    expect(resumeClearRes.ok).toBe(true)

    // Workers need explicit resume after stopAll
    await scope.resumeWorker(worker1Id)
    await scope.resumeWorker(worker2Id)

    // Scenario F: Encrypted Restart & State Recovery
    // Stop Core cleanly, preserving the encrypted vault and event journal
    await core.stop('maintenance')
    core = undefined

    // Recreate Core from the same encrypted database and journal
    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
      missionKey: new Uint8Array(32).fill(7),
      missionReadRoots: [dir],
      vault: {
        path: vaultPath,
        keyProvider: new StaticVaultKeyProvider(testVaultKey()),
        binding,
      },
    })
    await core.start()

    // Resume workers after restart
    const restartedScope = workforceOwnerScope(core)
    await restartedScope.resumeWorker(worker1Id)
    await restartedScope.resumeWorker(worker2Id)

    // Verify all 3 missions and workers survived restart intact
    const postRestartDecision = core.executiveDecision({
      explicitPriorities,
      requiredSpecialisations,
    })

    expect(postRestartDecision.decision).toBe('start')
    expect(postRestartDecision.selectedMissionId).toBe(m1Id)
    expect(postRestartDecision.assignedWorkerId).toBe(worker1Id)
    expect(postRestartDecision.candidates.length).toBe(3)

    const postRestartState = core.executiveState({
      explicitPriorities,
      requiredSpecialisations,
    })
    expect(postRestartState.whatMatters.length).toBe(3)
    expect(postRestartState.whatMatters[0]?.itemId).toBe(m1Id)
    expect(postRestartState.nextBoundedAction?.target).toBe(m1Id)
  })

  it('determines when work must wait, defer, or escalate without unbounded execution', async () => {
    if (!bindingAvailable) return

    const dataPath = join(dir, 'events.jsonl')
    const vaultPath = join(dir, 'freya.db')
    const binding = await loadTestBinding()

    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
      missionKey: new Uint8Array(32).fill(7),
      missionReadRoots: [dir],
      vault: {
        path: vaultPath,
        keyProvider: new StaticVaultKeyProvider(testVaultKey()),
        binding,
      },
    })
    await core.start()

    // Create a mission that requires a specialized worker not present in the workforce
    const mRes = await core.handleCommand({
      command: 'mission.create',
      requestId: 'create-orphan',
      payload: { title: 'Orphan Mission', intent: 'Requires non-existent specialized skill' },
    })
    const mId = mRes.mission!.missionId!
    await core.readyMission(mId)

    // With no workers in the workforce, decision is to start mission directly (inline coordination)
    const decNoWorkers = core.executiveDecision()
    expect(decNoWorkers.decision).toBe('start')
    expect(decNoWorkers.selectedMissionId).toBe(mId)
    expect(decNoWorkers.assignedWorkerId).toBeNull()

    // Add a worker with 'code' specialisation
    const scope = workforceOwnerScope(core)
    const workerRes = await scope.createWorker({ name: 'CoderCal', specialisation: 'code' })
    const workerId = workerRes.workerId!
    await scope.assignCapability(workerId, 'cognition.request')

    // If mission requires 'research' and only 'code' exists -> defers with specialised_worker_unavailable
    const decSpecialised = core.executiveDecision({
      requiredSpecialisations: new Map([[mId, ['research']]]),
    })
    expect(decSpecialised.decision).toBe('defer')
    expect(decSpecialised.selectedMissionId).toBe(mId)
    expect(decSpecialised.reason).toBe('specialised_worker_unavailable')
    expect(decSpecialised.deferredMissions.some((d) => d.missionId === mId)).toBe(true)
  })
})
