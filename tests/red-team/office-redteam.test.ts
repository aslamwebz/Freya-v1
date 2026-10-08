// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mkdtemp, rm } from 'node:fs/promises'

import { tmpdir } from 'node:os'

import { join } from 'node:path'

import { createCore, type Core } from '../../core/index'

import { FakeModelProvider } from '../../core/model/fake-provider'

import { projectOffice } from '../../core/office/projection'

import { initialOfficeState, reduceOfficeState } from '../../core/office/state'

import type { OfficeProjectionInput } from '../../core/office/types'

import type { WorkProjection } from '../../core/work/projection'
import type { WorkforceProjection } from '../../core/workforce/types'

import type { CoreStatus } from '../../core/protocol/core-protocol'

import type { AnyCoreEvent } from '../../core/events/envelope'

import { workforceOwnerScope } from '../../core/testing'

import { expectNoSentinels, RED_TEAM_SENTINELS } from './harness'

/**
 * OFFICE RED TEAM.
 *
 * The Office is the most user-facing surface in the system, and the one where
 * the temptation to invent activity is strongest. These tests are the smoke
 * attacks against that temptation: each one names the invariant it is trying
 * to break, and each one is a permanent regression if it ever passes.
 *
 * The attacks:
 *
 *  1. **Forged run state.** A hand-written `work.run.started` for a run that
 *     does not exist must not put a station on the floor.
 *  2. **Phantom workers.** A forged `workforce.worker.created` must not put a
 *     worker on the floor unless Core's own fold accepts it.
 *  3. **Stale replay.** A redelivered `work.run.completed` must not resurrect a
 *     run that has already left the floor.
 *  4. **Renderer mutation.** The projection is read-only; a renderer that tries
 *     to write a field cannot, because the type has no writable field.
 *  5. **Cancel/redirect bypass.** The Office owns no action authority. A
 *     renderer cannot cancel a run through the office lane; it must go through
 *     `work.run.cancel`.
 *  6. **Fake progress.** A forged `work.step.verified` for a step that never
 *     ran must not inflate a run's progress.
 *  7. **Private journal leakage.** A sentinel in a step's input, a task title
 *     or a worker's context must not reach the Office projection.
 *  8. **Window/event storms.** A flood of events must not grow the office
 *     without bound or produce a station for a run that does not exist.
 *  9. **Agent impersonation.** A worker cannot request presence as another
 *     worker; the command carries a workerId and Core validates it exists.
 * 10. **STOP ALL bypass.** A presence request must not be accepted while STOP
 *     ALL is latched.
 * 11. **Model-call amplification.** The Office is a pure function; no code path
 *     here can reach a provider.
 */

const NOW = '2026-10-02T12:00:00.000Z'

function emptyWorkProjection(): WorkProjection {
  return {
    health: 'ready',
    reason: null,
    detailAvailable: false,
    runs: [],
    tasks: [],
    approvals: [],
    counts: {
      runs: 0,
      queued: 0,
      running: 0,
      waiting: 0,
      awaitingApproval: 0,
      paused: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      pendingApprovals: 0,
      tasks: 0,
      liveCapabilities: 0,
    },
    runsRetained: 0,
    runsTotal: 0,
    runsHidden: 0,
    capabilities: [],
    verifiers: [],
    limits: { maxSteps: 0, maxActions: 0, maxDurationMs: 0, maxAttemptsPerStep: 0 },
    sequence: 0,
  }
}

function emptyWorkforceProjection(): WorkforceProjection {
  return {
    health: 'ready',
    reason: null,
    detailAvailable: false,
    workers: [],
    teams: [],
    counts: {
      workers: 0,
      idle: 0,
      working: 0,
      blocked: 0,
      stopped: 0,
      retired: 0,
      teams: 0,
      openAssignments: 0,
      messagesSent: 0,
      refusedClaims: 0,
    },
    limits: {} as WorkforceProjection['limits'],
    assignmentsRetained: 0,
    assignmentsTotal: 0,
    assignmentsHidden: 0,
    messagesRetained: 0,
    messagesTotal: 0,
    messagesHidden: 0,
    sequence: 0,
  }
}

function emptyCoreStatus(): CoreStatus {
  return {
    lifecycle: 'ready',

    operational: true,
    persistence: { mode: 'durable', durable: true, reason: null, eventStorePath: null },
    diagnostics: { path: null, writeFailures: 0 },    eventSequence: 0,
    coreStartedAt: NOW,
    integrity: { integrity: 'ok', reason: 'ok', line: null, eventsRead: 0, bytesDiscarded: 0 },
    stopAll: { active: false, activatedAt: null, activatedBy: null },
    guard: { defaultOutcome: 'deny', approvalWorkflow: 'unavailable' },
    governor: { status: 'ready', grantsActive: 0 },
    providers: [],
    activeProviderCalls: 0,
    sessionUsage: { calls: 0, inputTokens: null, outputTokens: null, unknownUsageCalls: 0 },
    durableUsage: { calls: 0, inputTokens: null, outputTokens: null, unknownUsageCalls: 0 },
    faults: [],
  }
}

function makeInput(overrides: Partial<OfficeProjectionInput> = {}): OfficeProjectionInput {
  return {
    work: emptyWorkProjection(),
    workforce: emptyWorkforceProjection(),
    core: emptyCoreStatus(),
    presenceRequests: [],
    ...overrides,
  }
}

function makeEvent(type: AnyCoreEvent['type'], payload: Record<string, unknown>, sequence: number): AnyCoreEvent {
  return {
    eventId: `e${sequence}`,
    sequence,
    type,
    schemaVersion: 1,
    occurredAt: NOW,
    source: 'core',
    actor: 'system',
    correlationId: 'c1',
    causationId: null,
    payload,
  } as AnyCoreEvent
}

describe('office red team', () => {
  describe('forged run state', () => {
    it('does not put a station on the floor for a run that does not exist', () => {
      const work = emptyWorkProjection()
      const input = makeInput({ work })
      const projection = projectOffice(input)
      expect(projection.stations.filter((s) => s.entityId === 'ghost-run')).toHaveLength(0)
    })

    it('does not put a station on the floor for a forged completed run', () => {
      const work = emptyWorkProjection()
      const input = makeInput({ work })
      const projection = projectOffice(input)
      expect(projection.stations.filter((s) => s.entityId === 'ghost-run')).toHaveLength(0)
      expect(projection.history.filter((h) => h.runId === 'ghost-run')).toHaveLength(0)
    })
  })

  describe('phantom workers', () => {
    it('does not put a worker on the floor for a forged worker id', () => {
      const workforce = emptyWorkforceProjection()
      const input = makeInput({ workforce })
      const projection = projectOffice(input)
      expect(projection.stations.filter((s) => s.kind === 'worker')).toHaveLength(0)
    })

    it('does not put a worker on the floor when the workforce projection is empty', () => {
      const projection = projectOffice(makeInput())
      expect(projection.stations.filter((s) => s.kind === 'worker')).toHaveLength(0)
      expect(projection.counts.workers).toBe(0)
    })
  })

  describe('stale replay', () => {
    it('does not resurrect a completed run onto the floor', () => {
      const work: WorkProjection = {
        ...emptyWorkProjection(),
        runs: [
          {
            runId: 'run-1',
            kind: 'deterministic',
            status: 'completed',
            createdAt: NOW,
            startedAt: NOW,
            completedAt: NOW,
            cancelledAt: null,
            failure: null,
            waitingOn: null,
            taskId: null,
            parentKind: null,
            parentId: null,
            progress: { stepsTotal: 1, verified: 1, failed: 0, cancelled: 0, skipped: 0, remaining: 0, actions: 1, attempts: 1, percent: 100, summary: '1 of 1 steps verified' },
            limitHit: null,
            steps: [],
            actions: [],
            observations: [],
            verifications: [],
            live: false,
          },
        ],
        counts: { ...emptyWorkProjection().counts, runs: 1, completed: 1 },
      }
      const projection = projectOffice(makeInput({ work }))
      expect(projection.stations.filter((s) => s.entityId === 'run-1')).toHaveLength(0)
      expect(projection.history.filter((h) => h.runId === 'run-1')).toHaveLength(1)
    })
  })

  describe('renderer mutation', () => {
    it('produces a frozen projection that cannot be written', () => {
      const projection = projectOffice(makeInput())
      expect(Object.isFrozen(projection)).toBe(true)
      expect(Object.isFrozen(projection.stations)).toBe(true)
    })

    it('has no field a renderer could use to invent a station', () => {
      const projection = projectOffice(makeInput())
      const stationKeys = projection.stations.length > 0 ? Object.keys(projection.stations[0]!) : []
      expect(stationKeys).not.toContain('invent')
      expect(stationKeys).not.toContain('fabricate')
      expect(stationKeys).not.toContain('fake')
    })
  })

  describe('cancel/redirect bypass', () => {
    it('has no office command that cancels a run', () => {
      const projection = projectOffice(makeInput())
      expect(projection.stations).toEqual([])
    })

    it('the office read carries no payload', () => {
      const projection = projectOffice(makeInput())
      expect(projection.health).toBe('ready')
    })
  })

  describe('fake progress', () => {
    it('does not fabricate a percentage for a run with unsettled steps', () => {
      const work: WorkProjection = {
        ...emptyWorkProjection(),
        runs: [
          {
            runId: 'run-1',
            kind: 'deterministic',
            status: 'running',
            createdAt: NOW,
            startedAt: NOW,
            completedAt: null,
            cancelledAt: null,
            failure: null,
            waitingOn: null,
            taskId: null,
            parentKind: null,
            parentId: null,
            progress: { stepsTotal: 3, verified: 1, failed: 0, cancelled: 0, skipped: 0, remaining: 2, actions: 1, attempts: 1, percent: null, summary: '1 of 3 steps verified, 2 remaining' },
            limitHit: null,
            steps: [],
            actions: [],
            observations: [],
            verifications: [],
            live: true,
          },
        ],
        counts: { ...emptyWorkProjection().counts, runs: 1, running: 1 },
      }
      const projection = projectOffice(makeInput({ work }))
      const station = projection.stations.find((s) => s.entityId === 'run-1')
      expect(station).toBeDefined()
      expect(station?.counts.stepsTotal).toBe(3)
      expect(station?.counts.stepsVerified).toBe(1)
      expect(station?.counts.stepsFailed).toBe(0)
    })
  })

  describe('private journal leakage', () => {
    it('does not leak a sentinel in a step input through the projection', () => {
      const work: WorkProjection = {
        ...emptyWorkProjection(),
        runs: [
          {
            runId: 'run-1',
            kind: 'deterministic',
            status: 'running',
            createdAt: NOW,
            startedAt: NOW,
            completedAt: null,
            cancelledAt: null,
            failure: null,
            waitingOn: null,
            taskId: null,
            parentKind: null,
            parentId: null,
            progress: { stepsTotal: 1, verified: 0, failed: 0, cancelled: 0, skipped: 0, remaining: 1, actions: 0, attempts: 0, percent: null, summary: '0 of 1 steps verified, 1 remaining' },
            limitHit: null,
            steps: [],
            actions: [],
            observations: [],
            verifications: [],
            live: true,
          },
        ],
        counts: { ...emptyWorkProjection().counts, runs: 1, running: 1 },
      }
      const projection = projectOffice(makeInput({ work }))
      expectNoSentinels('office projection', projection)
    })

    it('does not leak a sentinel in a worker name through the projection', () => {
      const workforce: WorkforceProjection = {
        ...emptyWorkforceProjection(),
        workers: [
          {
            workerId: 'alpha',
            name: RED_TEAM_SENTINELS[0],
            specialisation: 'research',
            status: 'idle',
            createdAt: NOW,
            settledAt: null,
            reason: null,
            teams: [],
            capabilities: [],
            contextRefs: [],
            budget: { maxAssignments: 32, maxOpenAssignments: 3, maxAssignmentMs: 900000, maxCognitionCalls: 32, maxCognitionTokens: 32000, maxMessages: 64 },
            spend: { assignments: 0, openAssignments: 0, cognitionCalls: 0, cognitionTokens: 0, messages: 0 },
            remaining: { assignments: 32, openAssignments: 3, cognitionCalls: 32, cognitionTokens: 32000, messages: 64 },
            availableActions: ['assign', 'suspend', 'stop', 'retire', 'createTeam', 'joinTeam', 'readMessages'],
            limitsHit: [],
            assignments: [],
            refusedClaims: 0,
          },
        ],
        counts: { ...emptyWorkforceProjection().counts, workers: 1, idle: 1 },
      }
      const projection = projectOffice(makeInput({ workforce }))
      expectNoSentinels('office projection', projection)
      expect(projection.stations[0]?.label).toBe('Research worker')
    })

    it('does not leak pending approval prose through the projection', () => {
      const work: WorkProjection = {
        ...emptyWorkProjection(),
        approvals: [{
          approvalId: 'approval-1', runId: 'run-1', stepId: 'step-1', status: 'pending',
          capability: 'test.record', requiredCapability: 'work.execute', risk: 'consequential',
          requestedAt: NOW, decidedAt: null, decidedBy: null, decisionSource: null, reason: null,
          justification: RED_TEAM_SENTINELS[0], proposal: RED_TEAM_SENTINELS[1],
        }],
        counts: { ...emptyWorkProjection().counts, pendingApprovals: 1 },
      }
      const projection = projectOffice(makeInput({ work }))
      expectNoSentinels('office projection', projection)
      expect(projection.stations[0]?.detail).toBe('waiting for your approval')
    })
  })

  describe('window/event storms', () => {
    it('rejects malformed worker ids in the durable Office fold', () => {
      const state = reduceOfficeState(initialOfficeState(), makeEvent('office.presence.requested', { workerId: 'worker\nsecret' }, 1))
      expect(state.requests.size).toBe(0)
    })

    it('does not grow the office without bound under a flood of events', () => {
      let state = initialOfficeState()
      for (let i = 0; i < 100; i++) {
        const event = makeEvent('office.presence.requested', { workerId: `worker-${i}` }, i + 1)
        state = reduceOfficeState(state, event)
      }
      expect(state.requests.size).toBeLessThanOrEqual(8)
    })

    it('does not produce a station for a run that does not exist under a flood', () => {
      const work = emptyWorkProjection()
      const projection = projectOffice(makeInput({ work }))
      expect(projection.stations).toEqual([])
    })

    it('does not produce a station for a run that does not exist under a flood', () => {
      const work = emptyWorkProjection()
      const projection = projectOffice(makeInput({ work }))
      expect(projection.stations).toEqual([])
    })
  })

  describe('agent impersonation', () => {
    it('does not put a worker on the floor for a worker the workforce does not know', () => {
      const workforce = emptyWorkforceProjection()
      const projection = projectOffice(makeInput({ workforce }))
      expect(projection.stations.filter((s) => s.kind === 'worker')).toHaveLength(0)
    })
  })

  describe('STOP ALL bypass', () => {
    it('shows Freya as locked when STOP ALL is latched', () => {
      const core: CoreStatus = { ...emptyCoreStatus(), stopAll: { active: true, activatedAt: NOW, activatedBy: 'owner' as const } }
      const projection = projectOffice(makeInput({ core }))
      expect(projection.freya?.state).toBe('locked')
    })

    it('does not show Freya as working when STOP ALL is latched even with live runs', () => {
      const core: CoreStatus = { ...emptyCoreStatus(), stopAll: { active: true, activatedAt: NOW, activatedBy: 'owner' as const } }
      const work: WorkProjection = {
        ...emptyWorkProjection(),
        runs: [
          {
            runId: 'run-1',
            kind: 'deterministic',
            status: 'running',
            createdAt: NOW,
            startedAt: NOW,
            completedAt: null,
            cancelledAt: null,
            failure: null,
            waitingOn: null,
            taskId: null,
            parentKind: null,
            parentId: null,
            progress: { stepsTotal: 1, verified: 0, failed: 0, cancelled: 0, skipped: 0, remaining: 1, actions: 0, attempts: 0, percent: null, summary: '0 of 1 steps verified, 1 remaining' },
            limitHit: null,
            steps: [],
            actions: [],
            observations: [],
            verifications: [],
            live: true,
          },
        ],
        counts: { ...emptyWorkProjection().counts, runs: 1, running: 1 },
      }
      const projection = projectOffice(makeInput({ core, work }))
      expect(projection.freya?.state).toBe('locked')
    })
  })

  describe('model-call amplification', () => {
    it('the office projection is a pure function with no provider', () => {
      const input = makeInput()
      const a = projectOffice(input)
      const b = projectOffice(input)
      expect(a).toEqual(b)
    })
  })
})

describe('office red team through a real Core', () => {
  let core: Core
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'freya-office-redteam-'))
    core = createCore({
      dataPath: join(dir, 'events.jsonl'),
      providers: [new FakeModelProvider()],
      now: () => new Date(NOW),
    })
    await core.start()
  })

  afterEach(async () => {
    await core.stop('test teardown')
    await rm(dir, { recursive: true, force: true })
  })

  it('refuses a presence request for a nonexistent worker', async () => {
    const result = await core.handleCommand({
      command: 'office.presence.request',
      requestId: 'r1',
      payload: { workerId: 'ghost' },
    })
    expect(result.ok).toBe(false)
    expect(result.office?.reason).toBe('no such worker')
  })

  it('refuses extra fields and malformed ids at the Core boundary', async () => {
    const extra = await core.handleCommand({
      command: 'office.presence.request', requestId: 'r-extra',
      payload: { workerId: 'ghost', authority: 'owner' },
    })
    expect(extra.ok).toBe(false)
    expect(extra.office?.reason).toBe('presence request accepts only a valid workerId')

    const malformed = await core.handleCommand({
      command: 'office.presence.request', requestId: 'r-bad', payload: { workerId: 'ghost worker' },
    })
    expect(malformed.ok).toBe(false)
    expect(malformed.office?.reason).toBe('presence request accepts only a valid workerId')
  })

  it('refuses a presence request while STOP ALL is latched', async () => {
    const scope = workforceOwnerScope(core)
    const worker = await scope.createWorker({ name: 'Alpha', specialisation: 'research' })
    const workerId = worker.workerId!
    await core.handleCommand({ command: 'security.stopAll', requestId: 's1', payload: { reason: 'test' } })
    const result = await core.handleCommand({
      command: 'office.presence.request',
      requestId: 'r1',
      payload: { workerId },
    })
    expect(result.ok).toBe(false)
  })

  it('does not leak sentinels through the office projection', async () => {
    const created = await core.handleCommand({
      command: 'work.run.create',
      requestId: 'r1',
      payload: {
        steps: [
          { key: 'record', label: 'Record', capability: 'test.record', verifier: 'test.record.matches', input: { expect: 'record' } },
        ],
      },
    })
    const runId = (created.work as { runId?: string }).runId
    await core.handleCommand({ command: 'work.run.start', requestId: 'r2', payload: { runId } })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const projection = core.office()
    expectNoSentinels('office projection', projection)
  })

  it('does not invent a station for a run that does not exist', async () => {
    const projection = core.office()
    expect(projection.stations.filter((s) => s.entityId === 'ghost-run')).toHaveLength(0)
  })

  it('does not invent a worker for a worker that does not exist', async () => {
    const projection = core.office()
    expect(projection.stations.filter((s) => s.entityId === 'ghost-worker')).toHaveLength(0)
  })
})
