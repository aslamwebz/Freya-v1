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
import type { MissionSummaryView } from '../../core/missions/types'
import type { WorkerView } from '../../core/workforce/types'

let dir: string
let core: Core | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-exec-4b-'))
})

afterEach(async () => {
  await core?.stop('teardown')
  core = undefined
  await rm(dir, { recursive: true, force: true })
})

function makeMockMission(overrides: Partial<MissionSummaryView> & { missionId: string }): MissionSummaryView {
  return {
    status: 'ready',
    priority: 'routine',
    deadlineAt: '2026-10-15T12:00:00.000Z',
    createdAt: '2026-10-10T10:00:00.000Z',
    settledAt: null,
    reason: null,
    counts: { total: 0, queued: 0, running: 0, waiting: 0, awaitingApproval: 0, paused: 0, completed: 0, failed: 0, cancelled: 0, verified: 0 },
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
    evidence: { total: 0, observed: 0, reported: 0, expired: 0, uncertain: 0 },
    nextWake: null,
    lastUpdatedAt: '2026-10-10T10:00:00.000Z',
    awaitingOwner: false,
    budgetRemaining: {
      modelCalls: 32,
      actions: 128,
      externalRequests: 32,
      retries: 8,
      delegations: 64,
      planRevisions: 8,
      concurrentDelegations: 4,
    },
    ...overrides,
  }
}

function makeMockWorker(overrides: Partial<WorkerView> & { workerId: string }): WorkerView {
  const { workerId, ...rest } = overrides
  return {
    workerId,
    name: 'TestWorker',
    status: 'idle',
    specialisation: 'general',
    createdAt: '2026-10-10T10:00:00.000Z',
    settledAt: null,
    reason: null,
    teams: [],
    capabilities: ['cognition.request'],
    contextRefs: [],
    budget: {
      maxAssignments: 32,
      maxOpenAssignments: 1,
      maxAssignmentMs: 60000,
      maxCognitionCalls: 10,
      maxCognitionTokens: 1000,
      maxMessages: 10,
    },
    spend: {
      assignments: 0,
      openAssignments: 0,
      cognitionCalls: 0,
      cognitionTokens: 0,
      messages: 0,
    },
    remaining: {
      assignments: 1,
      openAssignments: 1,
      cognitionCalls: 10,
      cognitionTokens: 1000,
      messages: 10,
    },
    availableActions: [],
    limitsHit: [],
    assignments: [],
    refusedClaims: 0,
    ...rest,
  }
}

describe('Phase 4B — Intelligent Prioritization and Resource Allocation', () => {
  it('Scenario 1: two missions competing for one worker -> higher priority wins, other deferred', () => {
    const mUrgent = makeMockMission({ missionId: 'm-urgent', priority: 'urgent' })
    const mRoutine = makeMockMission({ missionId: 'm-routine', priority: 'routine' })
    const w1 = makeMockWorker({
      workerId: 'worker-single',
    })

    const outcome = evaluateExecutiveDecision({
      missions: [mRoutine, mUrgent], // Passed in reverse order
      workers: [w1],
      stopAllActive: false,
      guardMayManage: true,
      now: '2026-10-10T12:00:00.000Z',
    })

    expect(outcome.decision).toBe('start')
    expect(outcome.selectedMissionId).toBe('m-urgent')
    expect(outcome.assignedWorkerId).toBe('worker-single')
    expect(outcome.deferredMissions.some((d) => d.missionId === 'm-routine')).toBe(true)
  })

  it('Scenario 2: high-priority blocked versus lower-priority ready -> lower priority runs, high priority waits', () => {
    const mBlocked = makeMockMission({
      missionId: 'm-urgent-blocked',
      priority: 'urgent',
      pendingApproval: {
        approvalId: 'app-gate-1',
        stepId: 'step-1',
        capability: 'cognition.request',
        risk: 'consequential',
        requestedAt: '2026-10-10T11:00:00.000Z',
        source: 'requested',
      },
    })
    const mReady = makeMockMission({ missionId: 'm-routine-ready', priority: 'routine' })
    const w1 = makeMockWorker({ workerId: 'worker-1' })

    const outcome = evaluateExecutiveDecision({
      missions: [mBlocked, mReady],
      workers: [w1],
      stopAllActive: false,
      guardMayManage: true,
      now: '2026-10-10T12:00:00.000Z',
    })

    expect(outcome.decision).toBe('start')
    expect(outcome.selectedMissionId).toBe('m-routine-ready')
    expect(outcome.assignedWorkerId).toBe('worker-1')
    expect(outcome.deferredMissions.some((d) => d.missionId === 'm-urgent-blocked' && d.reason.includes('approval_pending'))).toBe(true)
  })

  it('Scenario 3: deadline-sensitive work -> imminent deadline elevates mission over normal', () => {
    const now = '2026-10-10T12:00:00.000Z'
    const mImminent = makeMockMission({
      missionId: 'm-routine-imminent',
      priority: 'routine',
      deadlineAt: '2026-10-10T12:30:00.000Z', // 30 minutes away (< 1h urgentWindow)
    })
    const mImportant = makeMockMission({
      missionId: 'm-important-later',
      priority: 'important',
      deadlineAt: '2026-10-15T12:00:00.000Z', // 5 days away
    })

    const outcome = evaluateExecutiveDecision({
      missions: [mImminent, mImportant],
      stopAllActive: false,
      guardMayManage: true,
      now,
    })

    expect(outcome.selectedMissionId).toBe('m-routine-imminent')
    expect(outcome.decision).toBe('start')
  })

  it('Scenario 4: exhausted mission budget (actions) -> paused', () => {
    const mExhausted = makeMockMission({
      missionId: 'm-actions-depleted',
      status: 'active',
      budgetRemaining: {
        modelCalls: 10,
        actions: 0, // actions depleted
        externalRequests: 5,
        retries: 2,
        delegations: 2,
        planRevisions: 2,
        concurrentDelegations: 1,
      },
    })

    const outcome = evaluateExecutiveDecision({
      missions: [mExhausted],
      stopAllActive: false,
      guardMayManage: true,
      now: '2026-10-10T12:00:00.000Z',
    })

    expect(outcome.decision).toBe('pause')
    expect(outcome.selectedMissionId).toBe('m-actions-depleted')
    expect(outcome.reason).toBe('budget_exhausted')
    expect(outcome.blockedMissions.some((b) => b.missionId === 'm-actions-depleted' && b.reason === 'budget_exhausted')).toBe(true)
  })

  it('Scenario 4b: exhausted mission budget via explicit budgetLimits and budgetSpends -> paused', () => {
    const mActive = makeMockMission({ missionId: 'm-calls-exhausted', status: 'active' })

    const outcome = evaluateExecutiveDecision({
      missions: [mActive],
      budgetLimits: { 'm-calls-exhausted': { maxModelCalls: 10 } },
      budgetSpends: { 'm-calls-exhausted': { modelCalls: 10 } },
      stopAllActive: false,
      guardMayManage: true,
      now: '2026-10-10T12:00:00.000Z',
    })

    expect(outcome.decision).toBe('pause')
    expect(outcome.selectedMissionId).toBe('m-calls-exhausted')
    expect(outcome.reason).toBe('budget_exhausted')
  })

  it('Scenario 5: limited external request budget -> paused', () => {
    const mExternal = makeMockMission({
      missionId: 'm-external-exhausted',
      status: 'active',
      budgetRemaining: {
        modelCalls: 10,
        actions: 10,
        externalRequests: 0, // external requests depleted
        retries: 2,
        delegations: 2,
        planRevisions: 2,
        concurrentDelegations: 1,
      },
    })

    const outcome = evaluateExecutiveDecision({
      missions: [mExternal],
      stopAllActive: false,
      guardMayManage: true,
      now: '2026-10-10T12:00:00.000Z',
    })

    expect(outcome.decision).toBe('pause')
    expect(outcome.selectedMissionId).toBe('m-external-exhausted')
    expect(outcome.reason).toBe('budget_exhausted')
  })

  it('Scenario 6: fairness under repeated requests -> aging policy prevents starvation among equal priority', () => {
    const mOlder = makeMockMission({
      missionId: 'm-older',
      priority: 'routine',
      createdAt: '2026-10-10T10:00:00.000Z',
    })
    const mNewer = makeMockMission({
      missionId: 'm-newer',
      priority: 'routine',
      createdAt: '2026-10-10T11:00:00.000Z',
    })

    const outcome1 = evaluateExecutiveDecision({
      missions: [mNewer, mOlder],
      stopAllActive: false,
      guardMayManage: true,
      now: '2026-10-10T12:00:00.000Z',
    })

    expect(outcome1.selectedMissionId).toBe('m-older')

    // Even when repeated newer requests arrive, older request is protected from starvation
    const mLatest = makeMockMission({
      missionId: 'm-latest',
      priority: 'routine',
      createdAt: '2026-10-10T11:45:00.000Z',
    })

    const outcome2 = evaluateExecutiveDecision({
      missions: [mLatest, mNewer, mOlder],
      missionAges: { 'm-older': 7200000 }, // 2 hours waited
      stopAllActive: false,
      guardMayManage: true,
      now: '2026-10-10T12:00:00.000Z',
    })

    expect(outcome2.selectedMissionId).toBe('m-older')
  })

  it('Scenario 7: resource claim conflict -> worker cannot be double-booked in same pass', () => {
    const m1 = makeMockMission({ missionId: 'm-first', priority: 'urgent' })
    const m2 = makeMockMission({ missionId: 'm-second', priority: 'urgent' })
    const wSingle = makeMockWorker({
      workerId: 'worker-capacity-1',
    })

    const outcome = evaluateExecutiveDecision({
      missions: [m1, m2],
      workers: [wSingle],
      stopAllActive: false,
      guardMayManage: true,
      now: '2026-10-10T12:00:00.000Z',
    })

    expect(outcome.selectedMissionId).toBe('m-first')
    expect(outcome.assignedWorkerId).toBe('worker-capacity-1')

    // Second mission m-second cannot receive the same worker in this pass
    const cand2 = outcome.candidates.find((c) => c.missionId === 'm-second')
    expect(cand2?.assignedWorkerId).toBeNull()
    expect(outcome.deferredMissions.some((d) => d.missionId === 'm-second')).toBe(true)
  })

  it('Scenario 8: worker becomes unavailable -> deferred rather than inventing a worker', () => {
    const mReady = makeMockMission({ missionId: 'm-worker-needed', priority: 'routine' })
    const wStopped = makeMockWorker({ workerId: 'worker-stopped', status: 'stopped' })

    const outcome = evaluateExecutiveDecision({
      missions: [mReady],
      workers: [wStopped],
      stopAllActive: false,
      guardMayManage: true,
      now: '2026-10-10T12:00:00.000Z',
    })

    expect(outcome.decision).toBe('defer')
    expect(outcome.selectedMissionId).toBe('m-worker-needed')
    expect(outcome.assignedWorkerId).toBeNull()
    expect(outcome.reason).toBe('worker_unavailable')
  })

  it('Scenario 8b: specialised worker unavailable -> deferred with specialised_worker_unavailable', () => {
    const mData = makeMockMission({ missionId: 'm-data', priority: 'routine' })
    const wGeneral = makeMockWorker({ workerId: 'worker-gen', specialisation: 'general' })

    const outcome = evaluateExecutiveDecision({
      missions: [mData],
      workers: [wGeneral],
      requiredSpecialisations: { 'm-data': ['data_science'] },
      stopAllActive: false,
      guardMayManage: true,
      now: '2026-10-10T12:00:00.000Z',
    })

    expect(outcome.decision).toBe('defer')
    expect(outcome.selectedMissionId).toBe('m-data')
    expect(outcome.reason).toBe('specialised_worker_unavailable')
    expect(outcome.assignedWorkerId).toBeNull()
  })

  it('Scenario 9: explicit owner reprioritization -> selection changes immediately', () => {
    const m1 = makeMockMission({ missionId: 'm-routine-initially', priority: 'routine' })
    const m2 = makeMockMission({ missionId: 'm-important-initially', priority: 'important' })

    // Baseline: m2 is selected
    const baseOutcome = evaluateExecutiveDecision({
      missions: [m1, m2],
      stopAllActive: false,
      guardMayManage: true,
      now: '2026-10-10T12:00:00.000Z',
    })
    expect(baseOutcome.selectedMissionId).toBe('m-important-initially')

    // Explicit owner reprioritization switches selected mission immediately
    const reprioOutcome = evaluateExecutiveDecision({
      missions: [m1, m2],
      explicitPriorities: new Map([['m-routine-initially', 'urgent']]),
      stopAllActive: false,
      guardMayManage: true,
      now: '2026-10-10T12:00:00.000Z',
    })
    expect(reprioOutcome.selectedMissionId).toBe('m-routine-initially')
    expect(reprioOutcome.candidates.find((c) => c.missionId === 'm-routine-initially')?.priority).toBe('urgent')
  })

  it('Scenario 10: STOP ALL during active coordination -> stops all decisions with stop_all_active', () => {
    const mUrgent = makeMockMission({ missionId: 'm-urgent', priority: 'urgent' })
    const w1 = makeMockWorker({ workerId: 'w-1' })

    const outcome = evaluateExecutiveDecision({
      missions: [mUrgent],
      workers: [w1],
      stopAllActive: true,
      guardMayManage: true,
      now: '2026-10-10T12:00:00.000Z',
    })

    expect(outcome.decision).toBe('no_action')
    expect(outcome.reason).toBe('stop_all_active')
    expect(outcome.selectedMissionId).toBeNull()
    expect(outcome.assignedWorkerId).toBeNull()
    expect(outcome.state.nextBoundedAction?.kind).toBe('stop')
    expect(outcome.state.nextBoundedAction?.target).toBe('all')
    expect(outcome.blockedMissions).toEqual([{ missionId: 'm-urgent', reason: 'stop_all_active' }])
  })

  it('In-flight mission preemption handling: in-flight continues to safe checkpoint', () => {
    const mInFlight = makeMockMission({
      missionId: 'm-inflight',
      status: 'active',
      priority: 'routine',
      currentStep: {
        stepId: 'step-running',
        index: 1,
        status: 'running',
        capability: 'cognition.request',
        attempts: 1,
        workerId: 'w-busy',
        runId: 'run-1',
        reason: null,
        dependsOn: [],
      },
    })
    const mUrgent = makeMockMission({
      missionId: 'm-urgent-new',
      status: 'ready',
      priority: 'urgent',
    })
    const wBusy = makeMockWorker({
      workerId: 'w-busy',
      status: 'working',
      remaining: {
        assignments: 0,
        openAssignments: 0,
        cognitionCalls: 0,
        cognitionTokens: 0,
        messages: 0,
      },
    })

    const outcome = evaluateExecutiveDecision({
      missions: [mInFlight, mUrgent],
      workers: [wBusy],
      stopAllActive: false,
      guardMayManage: true,
      now: '2026-10-10T12:00:00.000Z',
    })

    // In-flight mission has safe checkpoint annotation
    const inflightCand = outcome.candidates.find((c) => c.missionId === 'm-inflight')
    expect(inflightCand?.reasoning.some((r) => r.includes('safe checkpoint'))).toBe(true)

    // Preemption is cleanly signaled without destructive abort
    expect(outcome.decision).toBe('defer')
    expect(outcome.reason).toBe('preemption_required')
  })

  it('End-to-End Core Integration: verifies budget exhaustion and specialization matching in production core', async () => {
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

    const mRes = await core.handleCommand({
      command: 'mission.create',
      requestId: 'create-m-prod',
      payload: { title: 'Production Goal', intent: 'Goal for executive testing' },
    })
    const missionId = mRes.mission!.missionId!
    await core.readyMission(missionId)

    const scope = workforceOwnerScope(core)
    const workerRes = await scope.createWorker({ name: 'SpecialistWorker', specialisation: 'research' })
    expect(workerRes.ok).toBe(true)
    const workerId = workerRes.workerId!
    await scope.assignCapability(workerId, 'cognition.request')

    // 1. Without specialisation match requirement: worker is assigned
    const decision1 = core.executiveDecision()
    expect(decision1.decision).toBe('start')
    expect(decision1.selectedMissionId).toBe(missionId)
    expect(decision1.assignedWorkerId).toBe(workerId)

    // 2. With unmatched specialisation requirement: deferred with specialised_worker_unavailable
    const decision2 = core.executiveDecision({
      requiredSpecialisations: { [missionId]: ['code'] },
    })
    expect(decision2.decision).toBe('defer')
    expect(decision2.reason).toBe('specialised_worker_unavailable')

    // 3. With budget limit reached: paused with budget_exhausted
    const decision3 = core.executiveDecision({
      budgetLimits: { [missionId]: { maxActions: 5 } },
      budgetSpends: { [missionId]: { actions: 5 } },
    })
    expect(decision3.decision).toBe('pause')
    expect(decision3.reason).toBe('budget_exhausted')
  })
})
