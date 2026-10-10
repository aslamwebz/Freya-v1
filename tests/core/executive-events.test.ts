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
import {
  isExecutiveTriggerEvent,
  evaluateExecutiveOnEvent,
  type ExecutiveDecisionOutcome,
} from '../../core/executive'
import type { MissionSummaryView } from '../../core/missions/types'

let dir: string
let core: Core | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-exec-4c-'))
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

describe('Phase 4C — Event-Driven Decisions and Continuation', () => {
  describe('Pure event classification and evaluation', () => {
    it('classifies authoritative executive trigger events correctly', () => {
      // Trigger events
      expect(isExecutiveTriggerEvent('mission.created')).toBe(true)
      expect(isExecutiveTriggerEvent('mission.activated')).toBe(true)
      expect(isExecutiveTriggerEvent('mission.completed')).toBe(true)
      expect(isExecutiveTriggerEvent('mission.failed')).toBe(true)
      expect(isExecutiveTriggerEvent('mission.blocker.added')).toBe(true)
      expect(isExecutiveTriggerEvent('work.run.started')).toBe(true)
      expect(isExecutiveTriggerEvent('work.step.verified')).toBe(true)
      expect(isExecutiveTriggerEvent('work.approval.requested')).toBe(true)
      expect(isExecutiveTriggerEvent('workforce.worker.registered')).toBe(true)
      expect(isExecutiveTriggerEvent('workforce.assignment.completed')).toBe(true)
      expect(isExecutiveTriggerEvent('security.stop_all.activated')).toBe(true)
      expect(isExecutiveTriggerEvent('security.stop_all.cleared')).toBe(true)
      expect(isExecutiveTriggerEvent('stop_all.requested')).toBe(true)
      expect(isExecutiveTriggerEvent('stop_all.cleared')).toBe(true)
      expect(isExecutiveTriggerEvent('lifeloop.wake')).toBe(true)

      // Ignored / non-triggering events
      expect(isExecutiveTriggerEvent('core.health')).toBe(false)
      expect(isExecutiveTriggerEvent('diagnostics.ping')).toBe(false)
      expect(isExecutiveTriggerEvent('learning.recalled')).toBe(false)
      expect(isExecutiveTriggerEvent('random.unrelated.event')).toBe(false)
      expect(isExecutiveTriggerEvent('')).toBe(false)
    })

    it('filters out non-triggering events without running evaluation', () => {
      const mission = makeMockMission({ missionId: 'm-1' })
      const res = evaluateExecutiveOnEvent({
        event: { type: 'core.health', occurredAt: '2026-10-10T12:00:00.000Z' },
        decisionInput: {
          missions: [mission],
          stopAllActive: false,
          guardMayManage: true,
          now: '2026-10-10T12:00:00.000Z',
        },
      })

      expect(res.triggered).toBe(false)
      expect(res.outcome).toBeNull()
    })

    it('evaluates decision deterministically when an authoritative event arrives', () => {
      const mission = makeMockMission({ missionId: 'm-event-ready', status: 'ready', priority: 'urgent' })
      const eventTime = '2026-10-10T12:00:00.000Z'

      const res = evaluateExecutiveOnEvent({
        event: { type: 'mission.activated', occurredAt: eventTime, payload: { missionId: 'm-event-ready' } },
        decisionInput: {
          missions: [mission],
          stopAllActive: false,
          guardMayManage: true,
          now: eventTime,
        },
      })

      expect(res.triggered).toBe(true)
      expect(res.outcome).not.toBeNull()
      expect(res.outcome?.decision).toBe('start')
      expect(res.outcome?.selectedMissionId).toBe('m-event-ready')
      expect(res.outcome?.evaluatedAt).toBe(eventTime)
      expect(res.outcome?.state.nextBoundedAction).not.toBeNull()
    })
  })

  describe('Production Core Event-Driven Lifecycle', () => {
    it('dispatches executive decisions on authoritative mission and workforce events without polling', async () => {
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

      const receivedDecisions: ExecutiveDecisionOutcome[] = []
      const unsubscribe = core.onExecutiveDecision((outcome) => {
        receivedDecisions.push(outcome)
      })

      // 1. Initial creation of Mission 1
      const mRes1 = await core.handleCommand({
        command: 'mission.create',
        requestId: 'create-m1',
        payload: { title: 'Goal 1', intent: 'Event-driven test mission 1' },
      })
      const mId1 = mRes1.mission!.missionId!

      // Ready Mission 1 -> triggers observeExecutiveSource
      await core.readyMission(mId1)

      // Listener should have received a decision
      expect(receivedDecisions.length).toBeGreaterThanOrEqual(1)
      const lastDecision1 = receivedDecisions[receivedDecisions.length - 1]!
      expect(lastDecision1.selectedMissionId).toBe(mId1)
      expect(lastDecision1.decision).toBe('start')

      // 2. Register a worker in workforce
      const scope = workforceOwnerScope(core)
      const workerRes = await scope.createWorker({ name: 'WorkerAlpha', specialisation: 'general' })
      expect(workerRes.ok).toBe(true)
      await scope.assignCapability(workerRes.workerId!, 'cognition.request')

      // Decision updated with worker assignment
      const lastDecision2 = core.lastExecutiveDecision()
      expect(lastDecision2).not.toBeNull()
      expect(lastDecision2?.selectedMissionId).toBe(mId1)
      expect(lastDecision2?.assignedWorkerId).toBe(workerRes.workerId)

      // 3. STOP ALL asserted event halts all decisions immediately
      const stopCmdRes = await core.handleCommand({
        command: 'security.stopAll',
        requestId: 'stop-req',
        payload: { reason: 'Emergency Stop Test' },
      })
      expect(stopCmdRes.ok).toBe(true)

      const lastDecision3 = core.lastExecutiveDecision()
      expect(lastDecision3?.decision).toBe('no_action')
      expect(lastDecision3?.reason).toBe('stop_all_active')
      expect(lastDecision3?.state.nextBoundedAction?.kind).toBe('stop')

      // 4. STOP ALL cleared event restores eligibility
      const resumeCmdRes = await core.handleCommand({
        command: 'security.resume',
        requestId: 'clear-stop-req',
        payload: { reason: 'Resume coordination' },
      })
      expect(resumeCmdRes.ok).toBe(true)

      const lastDecision4 = core.lastExecutiveDecision()
      // Worker remains stopped after stop_all until explicitly resumed, so mission is deferred honestly
      expect(lastDecision4?.decision).toBe('defer')
      expect(lastDecision4?.selectedMissionId).toBe(mId1)
      expect(lastDecision4?.reason).toBe('worker_unavailable')

      // 5. Worker explicitly resumed -> triggers event -> restores start decision
      const resumeWorkerRes = await scope.resumeWorker(workerRes.workerId!)
      expect(resumeWorkerRes.ok).toBe(true)

      const lastDecision5 = core.lastExecutiveDecision()
      expect(lastDecision5?.decision).toBe('start')
      expect(lastDecision5?.selectedMissionId).toBe(mId1)
      expect(lastDecision5?.assignedWorkerId).toBe(workerRes.workerId)

      unsubscribe()
    })

    it('settles safely into no_action at rest when all missions are complete', async () => {
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

      // When no missions exist: Executive rests at no_action without looping
      const decision = core.executiveDecision()
      expect(decision.decision).toBe('no_action')
      expect(decision.selectedMissionId).toBeNull()
      expect(decision.reason).toBe('no_open_missions')
      expect(decision.state.nextBoundedAction).toBeNull()
    })
  })
})
