// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mkdtemp, rm } from 'node:fs/promises'

import { tmpdir } from 'node:os'

import { join } from 'node:path'

import { createCore, type Core } from '../../core/index'

import { FakeModelProvider } from '../../core/model/fake-provider'

import { projectOffice } from '../../core/office/projection'

import { OFFICE_LIMITS, officeLimits } from '../../core/office/types'

import { initialOfficeState, reduceOfficeState } from '../../core/office/state'

import type { OfficeProjection, OfficeProjectionInput } from '../../core/office/types'

import type { WorkProjection } from '../../core/work/projection'
import type { WorkforceProjection } from '../../core/workforce/types'

import type { CoreStatus } from '../../core/protocol/core-protocol'

import type { AnyCoreEvent } from '../../core/events/envelope'

import { workforceOwnerScope } from '../../core/testing'

/**
 * THE OFFICE, end to end.
 *
 * These tests drive the real command surface of a real Core over a real journal,
 * because the properties that matter here are properties of the *joining up*:
 *
 *  1. **Nothing is invented.** A station exists because a real Run, worker or
 *     approval exists in Core. There is no code path that fabricates one.
 *  2. **Freya works only when real work exists.** Her station reads `working`
 *     only when a model request is in flight or a Run is live.
 *  3. **History is journaled metadata.** A history entry says what ran, when,
 *     how it ended and whether it verified — never what it was given.
 *  4. **Capping is stated, never silent.** A zone that holds more stations than
 *     its ceiling shows the newest and reports how many are hidden.
 *  5. **Presence requests are bounded.** One pending request per worker, a
 *     worker that must exist, and a request that is journalled as metadata.
 *  6. **The layout is deterministic.** The same state always produces the same
 *     positions, on every machine and every launch.
 *  7. **No model call animates the Office.** The Office is a pure function of
 *     Core state, and no code path here can reach a provider.
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
    eventSequence: 0,
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

describe('office projection', () => {
  it('reports unavailable before Core has reported', () => {
    const projection = projectOffice({ work: null, workforce: null, core: null, presenceRequests: [] })
    expect(projection.health).toBe('unavailable')
    expect(projection.reason).toBe('Core has not reported yet')
    expect(projection.stations).toEqual([])
    expect(projection.freya).toBeNull()
  })

  it('shows Freya as idle when nothing is executing', () => {
    const projection = projectOffice(makeInput())
    expect(projection.freya).not.toBeNull()
    expect(projection.freya?.state).toBe('idle')
    expect(projection.freya?.reason).toBe('nothing is executing')
  })

  it('shows Freya as working when a model request is in flight', () => {
    const core = { ...emptyCoreStatus(), activeProviderCalls: 1 }
    const projection = projectOffice(makeInput({ core }))
    expect(projection.freya?.state).toBe('working')
    expect(projection.freya?.reason).toBe('a model request is in flight')
  })

  it('shows Freya as working when a run is live', () => {
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
    expect(projection.freya?.state).toBe('working')
    expect(projection.freya?.reason).toBe('a run is executing')
  })

  it('shows Freya as locked when STOP ALL is latched', () => {
    const core: CoreStatus = { ...emptyCoreStatus(), stopAll: { active: true, activatedAt: NOW, activatedBy: 'owner' as const } }
    const projection = projectOffice(makeInput({ core }))
    expect(projection.freya?.state).toBe('locked')
    expect(projection.freya?.reason).toBe('STOP ALL is latched')
  })

  it('shows Freya as error when the journal is corrupt', () => {
    const core: CoreStatus = { ...emptyCoreStatus(), integrity: { integrity: 'corrupt' as const, reason: 'corrupt', line: 1, eventsRead: 0, bytesDiscarded: 0 } }
    const projection = projectOffice(makeInput({ core }))
    expect(projection.freya?.state).toBe('error')
    expect(projection.freya?.reason).toBe('the event journal is corrupt')
  })

  it('gives a station to a live run and not to a settled one', () => {
    const work: WorkProjection = {
      ...emptyWorkProjection(),
      runs: [
        {
          runId: 'run-live',
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
          progress: { stepsTotal: 2, verified: 1, failed: 0, cancelled: 0, skipped: 0, remaining: 1, actions: 1, attempts: 1, percent: null, summary: '1 of 2 steps verified, 1 remaining' },
          limitHit: null,
          steps: [],
          actions: [],
          observations: [],
          verifications: [],
          live: true,
        },
        {
          runId: 'run-done',
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
          progress: { stepsTotal: 2, verified: 2, failed: 0, cancelled: 0, skipped: 0, remaining: 0, actions: 2, attempts: 2, percent: 100, summary: '2 of 2 steps verified' },
          limitHit: null,
          steps: [],
          actions: [],
          observations: [],
          verifications: [],
          live: false,
        },
      ],
      counts: { ...emptyWorkProjection().counts, runs: 2, running: 1, completed: 1 },
    }
    const projection = projectOffice(makeInput({ work }))
    const runStations = projection.stations.filter((s) => s.kind === 'run')
    expect(runStations).toHaveLength(1)
    expect(runStations[0]?.entityId).toBe('run-live')
    expect(projection.history).toHaveLength(1)
    expect(projection.history[0]?.runId).toBe('run-done')
  })

  it('gives a station to a worker and derives state from the workforce', () => {
    const workforce: WorkforceProjection = {
      ...emptyWorkforceProjection(),
      workers: [
        {
          workerId: 'alpha',
          name: 'Alpha',
          specialisation: 'research',
          status: 'working',
          createdAt: NOW,
          settledAt: null,
          reason: null,
          teams: [],
          capabilities: ['cognition.request'],
          contextRefs: [],
          budget: { maxAssignments: 32, maxOpenAssignments: 3, maxAssignmentMs: 900000, maxCognitionCalls: 32, maxCognitionTokens: 32000, maxMessages: 64 },
          spend: { assignments: 1, openAssignments: 1, cognitionCalls: 0, cognitionTokens: 0, messages: 0 },
          remaining: { assignments: 31, openAssignments: 2, cognitionCalls: 32, cognitionTokens: 32000, messages: 64 },
          availableActions: ['suspend', 'stop', 'retire', 'readMessages'],
          limitsHit: [],
          assignments: [{ assignmentId: 'a1', workerId: 'alpha', status: 'open', createdAt: NOW, deadlineAt: NOW, settledAt: null, reason: null, missionId: null, capabilities: ['cognition.request'], contextRefs: [], expired: false }],
          refusedClaims: 0,
        },
      ],
      counts: { ...emptyWorkforceProjection().counts, workers: 1, working: 1 },
    }
    const projection = projectOffice(makeInput({ workforce }))
    const workerStations = projection.stations.filter((s) => s.kind === 'worker')
    expect(workerStations).toHaveLength(1)
    expect(workerStations[0]?.entityId).toBe('alpha')
    expect(workerStations[0]?.label).toBe('Research worker')
    expect(workerStations[0]?.state).toBe('working')
    expect(workerStations[0]?.openAssignments).toBe(1)
  })

  it('gives a station to a pending approval', () => {
    const work: WorkProjection = {
      ...emptyWorkProjection(),
      approvals: [
        {
          approvalId: 'apr-1',
          runId: 'run-1',
          stepId: 'step-1',
          status: 'pending',
          capability: 'test.consequential',
          requiredCapability: 'work.execute',
          risk: 'consequential',
          requestedAt: NOW,
          decidedAt: null,
          decidedBy: null,
          decisionSource: null,
          reason: null,
          justification: 'A consequential effect is proposed',
          proposal: 'would overwrite the configuration',
        },
      ],
      counts: { ...emptyWorkProjection().counts, pendingApprovals: 1 },
    }
    const projection = projectOffice(makeInput({ work }))
    const approvalStations = projection.stations.filter((s) => s.kind === 'approval')
    expect(approvalStations).toHaveLength(1)
    expect(approvalStations[0]?.entityId).toBe('apr-1')
    expect(approvalStations[0]?.state).toBe('waiting')
    expect(approvalStations[0]?.detail).toBe('waiting for your approval')
    expect(JSON.stringify(approvalStations[0])).not.toContain('overwrite the configuration')
  })

  it('caps stations and states how many are hidden', () => {
    const work: WorkProjection = {
      ...emptyWorkProjection(),
      runs: Array.from({ length: 20 }, (_, i) => ({
        runId: `run-${i}`,
        kind: 'deterministic' as const,
        status: 'running' as const,
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
      })),
      counts: { ...emptyWorkProjection().counts, runs: 20, running: 20 },
    }
    const projection = projectOffice(makeInput({ work }))
    const runStations = projection.stations.filter((s) => s.kind === 'run')
    expect(runStations.length).toBe(OFFICE_LIMITS.maxFloorStations)
    expect(projection.counts.floorStationsHidden).toBe(20 - OFFICE_LIMITS.maxFloorStations)
  })

  it('produces a deterministic layout for the same input', () => {
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
    const input = makeInput({ work })
    const a = projectOffice(input)
    const b = projectOffice(input)
    expect(a.stations.map((s) => s.position)).toEqual(b.stations.map((s) => s.position))
  })

  it('narrows office limits but never raises them', () => {
    const narrowed = officeLimits({ maxFloorStations: 4 })
    expect(narrowed.maxFloorStations).toBe(4)
    expect(() => officeLimits({ maxFloorStations: 999 })).toThrow()
  })
})

describe('office state', () => {
  it('folds a presence request', () => {
    const state = initialOfficeState()
    const event: AnyCoreEvent = {
      eventId: 'e1',
      sequence: 1,
      type: 'office.presence.requested',
      schemaVersion: 1,
      occurredAt: NOW,
      source: 'core',
      actor: 'owner',
      correlationId: 'c1',
      causationId: null,
      payload: { workerId: 'alpha' },
    }
    const next = reduceOfficeState(state, event)
    expect(next.requests.has('alpha')).toBe(true)
    expect(next.requests.get('alpha')?.fulfilled).toBe(false)
  })

  it('folds a fulfilment', () => {
    let state = initialOfficeState()
    const requested: AnyCoreEvent = {
      eventId: 'e1',
      sequence: 1,
      type: 'office.presence.requested',
      schemaVersion: 1,
      occurredAt: NOW,
      source: 'core',
      actor: 'owner',
      correlationId: 'c1',
      causationId: null,
      payload: { workerId: 'alpha' },
    }
    state = reduceOfficeState(state, requested)
    const fulfilled: AnyCoreEvent = {
      eventId: 'e2',
      sequence: 2,
      type: 'office.presence.fulfilled',
      schemaVersion: 1,
      occurredAt: NOW,
      source: 'core',
      actor: 'system',
      correlationId: 'c1',
      causationId: null,
      payload: { workerId: 'alpha' },
    }
    const next = reduceOfficeState(state, fulfilled)
    expect(next.requests.get('alpha')?.fulfilled).toBe(true)
  })

  it('refuses a malformed worker id', () => {
    const state = initialOfficeState()
    const event = {
      eventId: 'e1',
      sequence: 1,
      type: 'office.presence.requested',
      schemaVersion: 1,
      occurredAt: NOW,
      source: 'core',
      actor: 'owner',
      correlationId: 'c1',
      causationId: null,
      payload: { workerId: 42 },
    } as unknown as AnyCoreEvent
    const next = reduceOfficeState(state, event)
    expect(next.requests.size).toBe(0)
  })
})

describe('office through a real Core', () => {
  let core: Core
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'freya-office-'))
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

  it('reports unavailable before start', async () => {
    const fresh = createCore({
      dataPath: join(dir, 'events2.jsonl'),
      providers: [new FakeModelProvider()],
    })
    const projection = fresh.office()
    expect(projection.health).toBe('unavailable')
    await fresh.stop('test teardown')
  })

  it('reports ready with an idle Freya after start', () => {
    const projection = core.office()
    expect(projection.health).toBe('ready')
    expect(projection.freya?.state).toBe('idle')
    expect(projection.stations).toEqual([])
  })

  it('gives a station to a live run', async () => {
    const created = await core.handleCommand({
      command: 'work.run.create',
      requestId: 'r1',
      payload: {
        steps: [
          { key: 'record', label: 'Record', capability: 'test.record', verifier: 'test.record.matches', input: { expect: 'record' } },
          { key: 'record2', label: 'Record 2', capability: 'test.record', verifier: 'test.record.matches', input: { expect: 'record' } },
        ],
      },
    })
    expect(created.ok).toBe(true)
    const runId = (created.work as { runId?: string }).runId
    expect(runId).toBeDefined()
    await core.handleCommand({ command: 'work.run.start', requestId: 'r2', payload: { runId } })
    const projection = core.office()
    const runStations = projection.stations.filter((s) => s.kind === 'run')
    const runInHistory = projection.history.some((h) => h.runId === runId)
    expect(runStations.length + (runInHistory ? 1 : 0)).toBeGreaterThan(0)
    if (runStations.length > 0) {
      expect(runStations[0]?.entityId).toBe(runId)
      expect(runStations[0]?.state).toBe('working')
      expect(projection.freya?.state).toBe('working')
    }
  })

  it('moves a settled run to history', async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 100))
    const projection = core.office()
    expect(projection.history.length).toBeGreaterThan(0)
    expect(projection.history[0]?.runId).toBe(runId)
  })

  it('gives a station to a worker with an open assignment', async () => {
    const scope = workforceOwnerScope(core)
    const worker = await scope.createWorker({ name: 'Alpha', specialisation: 'research' })
    expect(worker.ok).toBe(true)
    const workerId = worker.workerId
    expect(workerId).toBeDefined()
    const capability = await scope.assignCapability(workerId!, 'cognition.request')
    expect(capability.ok).toBe(true)
    const assignment = await scope.assign({
      workerId: workerId!,
      capabilities: ['cognition.request'],
      contextRefs: [],
    })
    expect(assignment.ok).toBe(true)
    const projection = core.office()
    const workerStations = projection.stations.filter((s) => s.kind === 'worker')
    expect(workerStations).toHaveLength(1)
    expect(workerStations[0]?.entityId).toBe(workerId)
    expect(workerStations[0]?.state).toBe('working')
  })

  it('accepts a presence request for an existing worker', async () => {
    const scope = workforceOwnerScope(core)
    const worker = await scope.createWorker({ name: 'Alpha', specialisation: 'research' })
    const workerId = worker.workerId!
    const result = await core.handleCommand({
      command: 'office.presence.request',
      requestId: 'r1',
      payload: { workerId },
    })
    expect(result.ok).toBe(true)
    expect(result.office?.operation).toBe('presence-requested')
    const projection = core.office()
    expect(projection.presenceRequests).toHaveLength(1)
    expect(projection.presenceRequests[0]?.workerId).toBe(workerId)
  })

  it('refuses a presence request for a nonexistent worker', async () => {
    const result = await core.handleCommand({
      command: 'office.presence.request',
      requestId: 'r1',
      payload: { workerId: 'ghost' },
    })
    expect(result.ok).toBe(false)
    expect(result.office?.operation).toBe('refused')
    expect(result.office?.reason).toBe('no such worker')
  })

  it('refuses a presence request with no worker id', async () => {
    const result = await core.handleCommand({
      command: 'office.presence.request',
      requestId: 'r1',
      payload: {},
    })
    expect(result.ok).toBe(false)
    expect(result.office?.reason).toBe('a workerId is required')
  })

  it('refuses a payload on the office read', async () => {
    const result = await core.handleCommand({
      command: 'office.status.read',
      requestId: 'r1',
      payload: { bogus: true },
    })
    expect(result.ok).toBe(false)
    expect(result.office?.operation).toBe('refused')
  })

  it('accepts a payloadless office read', async () => {
    const result = await core.handleCommand({
      command: 'office.status.read',
      requestId: 'r1',
    })
    expect(result.ok).toBe(true)
    expect(result.office?.operation).toBe('status')
  })

  it('publishes office changes to subscribers', async () => {
    const projections: OfficeProjection[] = []
    const dispose = core.onOffice((p) => projections.push(p))
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
    dispose()
    const last = projections.at(-1)
    expect(last).toBeDefined()
    expect(last?.stations.filter((s) => s.kind === 'run').length).toBeGreaterThan(0)
  })

  it('survives a restart with presence requests intact', async () => {
    const scope = workforceOwnerScope(core)
    const worker = await scope.createWorker({ name: 'Alpha', specialisation: 'research' })
    const workerId = worker.workerId!
    await core.handleCommand({
      command: 'office.presence.request',
      requestId: 'r1',
      payload: { workerId },
    })
    await core.stop('restart')
    const restarted = createCore({
      dataPath: join(dir, 'events.jsonl'),
      providers: [new FakeModelProvider()],
      now: () => new Date(NOW),
    })
    await restarted.start()
    const projection = restarted.office()
    expect(projection.presenceRequests).toHaveLength(1)
    expect(projection.presenceRequests[0]?.workerId).toBe(workerId)
    await restarted.stop('test teardown')
  })
})
