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
import { evaluateExecutiveDecision } from '../../core/executive'

let dir: string
let core: Core | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-exec-4a-'))
})

afterEach(async () => {
  await core?.stop('teardown')
  core = undefined
  await rm(dir, { recursive: true, force: true })
})

describe('Phase 4A — Unified Executive Composition', () => {
  it('reads real production Mission state and yields deterministic explainable decisions', async () => {
    if (!bindingAvailable) return

    const dataPath = join(dir, 'events.jsonl')
    const vaultPath = join(dir, 'freya.db')
    const binding = await loadTestBinding()

    const provider = new FakeModelProvider()
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

    // 1. Initial state: no open missions -> safe no_action decision
    const initialDecision = core.executiveDecision()
    expect(initialDecision.decision).toBe('no_action')
    expect(initialDecision.reason).toBe('no_open_missions')
    expect(initialDecision.selectedMissionId).toBeNull()

    // 2. Create Mission 1 (Routine) and Mission 2 (Urgent)
    const m1 = await core.handleCommand({
      command: 'mission.create',
      requestId: 'create-m1',
      payload: { title: 'Routine Mission', intent: 'Routine maintenance inspect' },
    })
    const id1 = m1.mission!.missionId!

    const m2 = await core.handleCommand({
      command: 'mission.create',
      requestId: 'create-m2',
      payload: { title: 'Urgent Mission', intent: 'Urgent security audit' },
    })
    const id2 = m2.mission!.missionId!

    // Mark goals ready
    await core.handleCommand({
      command: 'mission.ready',
      requestId: 'ready-m1',
      payload: { missionId: id1 },
    })
    await core.handleCommand({
      command: 'mission.ready',
      requestId: 'ready-m2',
      payload: { missionId: id2 },
    })

    // Assign explicit priority: id1 = routine, id2 = urgent
    const priorityMap = new Map([
      [id1, 'routine' as const],
      [id2, 'urgent' as const],
    ])

    // Executive decision evaluation
    const execDecision = core.executiveDecision({ explicitPriorities: priorityMap })
    expect(execDecision.decision).toBe('start')
    expect(execDecision.selectedMissionId).toBe(id2) // Urgent mission selected over routine!
    expect(execDecision.reason).toBe('highest_priority_eligible')
    expect(execDecision.explanation).toContain(id2)
    expect(execDecision.candidates.length).toBe(2)

    // State projection check
    const execState = core.executiveState({ explicitPriorities: priorityMap })
    expect(execState.whatMatters.length).toBeGreaterThanOrEqual(1)
    expect(execState.nextBoundedAction?.target).toBe(id2)
  })

  it('recognizes blocked work and approvals without granting unauthorized actions', async () => {
    if (!bindingAvailable) return

    const dataPath = join(dir, 'events.jsonl')
    const vaultPath = join(dir, 'freya.db')
    const binding = await loadTestBinding()

    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
      missionKey: new Uint8Array(32).fill(9),
      missionReadRoots: [dir],
      vault: {
        path: vaultPath,
        keyProvider: new StaticVaultKeyProvider(testVaultKey()),
        binding,
      },
    })
    await core.start()

    // Create high-priority Mission A and low-priority Mission B
    const mA = await core.handleCommand({
      command: 'mission.create',
      requestId: 'create-ma',
      payload: { title: 'High Priority Waiting Approval', intent: 'Requires person approval' },
    })
    const idA = mA.mission!.missionId!

    const mB = await core.handleCommand({
      command: 'mission.create',
      requestId: 'create-mb',
      payload: { title: 'Routine Ready', intent: 'Ready to proceed' },
    })
    const idB = mB.mission!.missionId!

    // Mark mB ready
    await core.handleCommand({
      command: 'mission.ready',
      requestId: 'ready-mb',
      payload: { missionId: idB },
    })

    // Evaluate directly with pure function: idA is pending approval, idB is ready
    const simulatedMissions = [
      {
        missionId: idA,
        status: 'ready' as const,
        priority: 'urgent' as const,
        deadlineAt: new Date(Date.now() + 3600000).toISOString(),
        createdAt: new Date().toISOString(),
        settledAt: null,
        reason: null,
        counts: { total: 0, live: 0, succeeded: 0, failed: 0, cancelled: 0, paused: 0, waiting: 0 },
        needsAttention: true,
        availableActions: [],
        verification: null,
        planRevision: null,
        progress: {
          steps: { total: 0, pending: 0, blocked: 0, delegated: 0, running: 0, verified: 0, failed: 0, cancelled: 0, skipped: 0 },
          planSteps: 0,
          observed: 0,
          reported: 0,
          requestedQuantity: null,
          quantitySatisfied: null,
        },
        currentStep: null,
        nextAction: null,
        blockers: [],
        pendingApproval: {
          approvalId: 'appr-req-1',
          stepId: 'step-1',
          capability: 'work.execute',
          risk: 'high' as const,
          requestedAt: new Date().toISOString(),
          source: 'requested' as const,
        },
      },
      {
        missionId: idB,
        status: 'ready' as const,
        priority: 'routine' as const,
        deadlineAt: new Date(Date.now() + 7200000).toISOString(),
        createdAt: new Date().toISOString(),
        settledAt: null,
        reason: null,
        counts: { total: 0, live: 0, succeeded: 0, failed: 0, cancelled: 0, paused: 0, waiting: 0 },
        needsAttention: false,
        availableActions: [],
        verification: null,
        planRevision: null,
        progress: {
          steps: { total: 0, pending: 0, blocked: 0, delegated: 0, running: 0, verified: 0, failed: 0, cancelled: 0, skipped: 0 },
          planSteps: 0,
          observed: 0,
          reported: 0,
          requestedQuantity: null,
          quantitySatisfied: null,
        },
        currentStep: null,
        nextAction: null,
        blockers: [],
        pendingApproval: null,
      },
    ]

    const outcome = evaluateExecutiveDecision({
      missions: simulatedMissions,
      stopAllActive: false,
      guardMayManage: true,
      now: new Date().toISOString(),
    })

    // Mission A is urgent but ineligible due to pending approval.
    // Mission B is routine but ready and eligible -> selected!
    expect(outcome.selectedMissionId).toBe(idB)
    expect(outcome.decision).toBe('start')
    expect(outcome.deferredMissions.some((d) => d.missionId === idA && d.reason.includes('approval_pending'))).toBe(true)
  })

  it('strictly enforces STOP ALL and Guard authority boundaries', async () => {
    if (!bindingAvailable) return

    const dataPath = join(dir, 'events.jsonl')
    const vaultPath = join(dir, 'freya.db')
    const binding = await loadTestBinding()

    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
      missionKey: new Uint8Array(32).fill(9),
      missionReadRoots: [dir],
      vault: {
        path: vaultPath,
        keyProvider: new StaticVaultKeyProvider(testVaultKey()),
        binding,
      },
    })
    await core.start()

    await core.handleCommand({
      command: 'mission.create',
      requestId: 'create-m-stop',
      payload: { title: 'Active Mission', intent: 'Active work' },
    })

    // Test STOP ALL outranking all decisions
    const stopOutcome = evaluateExecutiveDecision({
      missions: core.mission().missions,
      stopAllActive: true,
      guardMayManage: true,
      now: new Date().toISOString(),
    })
    expect(stopOutcome.decision).toBe('no_action')
    expect(stopOutcome.reason).toBe('stop_all_active')
    expect(stopOutcome.selectedMissionId).toBeNull()

    // Test Guard denial inhibiting executive coordination
    const guardOutcome = evaluateExecutiveDecision({
      missions: core.mission().missions,
      stopAllActive: false,
      guardMayManage: false,
      now: new Date().toISOString(),
    })
    expect(guardOutcome.decision).toBe('no_action')
    expect(guardOutcome.reason).toBe('guard_denied')
    expect(guardOutcome.selectedMissionId).toBeNull()
  })

  it('allocates workers accurately and survives encrypted Core restart', async () => {
    if (!bindingAvailable) return

    const dataPath = join(dir, 'events.jsonl')
    const vaultPath = join(dir, 'freya.db')
    const binding = await loadTestBinding()

    // Session 1: Create Mission and Worker
    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
      missionKey: new Uint8Array(32).fill(9),
      missionReadRoots: [dir],
      vault: {
        path: vaultPath,
        keyProvider: new StaticVaultKeyProvider(testVaultKey()),
        binding,
      },
    })
    await core.start()

    const mRes = await core.handleCommand({
      command: 'mission.create',
      requestId: 'create-restart-m',
      payload: { title: 'Durable Mission', intent: 'Durable goal' },
    })
    const missionId = mRes.mission!.missionId!

    const scope = workforceOwnerScope(core)
    const worker = await scope.createWorker({ name: 'WorkerExec', specialisation: 'general' })
    await scope.assignCapability(worker.workerId!, 'cognition.request')

    await core.handleCommand({
      command: 'mission.ready',
      requestId: 'ready-restart-m',
      payload: { missionId },
    })

    const session1Decision = core.executiveDecision()
    expect(session1Decision.decision).toBe('start')
    expect(session1Decision.selectedMissionId).toBe(missionId)
    expect(session1Decision.assignedWorkerId).toBe(worker.workerId)

    // Stop Core cleanly
    await core.stop('clean-restart')
    core = undefined

    // Session 2: Re-create Core with same encrypted Vault
    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
      missionKey: new Uint8Array(32).fill(9),
      missionReadRoots: [dir],
      vault: {
        path: vaultPath,
        keyProvider: new StaticVaultKeyProvider(testVaultKey()),
        binding,
      },
    })
    await core.start()

    // Mission and worker state recovered across restart
    const session2Decision = core.executiveDecision()
    expect(session2Decision.decision).toBe('start')
    expect(session2Decision.selectedMissionId).toBe(missionId)
    expect(session2Decision.state.whatMatters.length).toBeGreaterThanOrEqual(1)
  })
})
