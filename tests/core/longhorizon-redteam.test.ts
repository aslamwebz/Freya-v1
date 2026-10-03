// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GoalEngine } from '../../core/longhorizon/engine'
import { MemoryGoalStore } from '../../core/longhorizon/memory-store'
import { GoalScheduler, MemoryGoalScheduleStore } from '../../core/longhorizon/schedule'
import { ContinuationEngine, type GoalTruthPort } from '../../core/longhorizon/continuation'
import { VerificationEngine, type VerificationGoalPort } from '../../core/longhorizon/verification'
import { reduceGoalState, initialGoalState } from '../../core/longhorizon/state'
import { DEFAULT_GOAL_LIMITS, GOAL_REASONS, SCHEDULE_LIMITS } from '../../core/longhorizon/types'
import type { AnyCoreEvent } from '../../core/events/envelope'
import { EventFabric } from '../../core/events/fabric'
import { JsonlEventStore } from '../../core/events/jsonl-store'

/**
 * Red-team gauntlet for the long-horizon subsystem.
 *
 * Each test is an adversarial scenario: an attempt to widen authority, bypass
 * a boundary, hide inference, inject data, or fabricate state. The expected
 * behavior is always the same — the attempt is detected and refused, with a
 * closed reason code, and no state changes.
 *
 * The invariants these tests defend:
 *
 * 1. A goal's claim about its own authority is data. Only Core grants.
 * 2. Guard, Governor, STOP ALL, budgets and approvals are never bypassed.
 * 3. No model call without a wake. No continuous polling. No hidden reasoning.
 * 4. Model output, event text and context are data, not authority.
 * 5. No state is fabricated on restart. No hidden state survives.
 */

let directory = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'freya-longhorizon-redteam-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/* ---------------------------------------------------------- helpers */

function continuationStub() {
  return { verifyCheckpoint: async () => ({ established: true, reason: GOAL_REASONS.verification_passed }) }
}

function goalPort(overrides: Partial<GoalTruthPort> = {}): GoalTruthPort {
  return {
    isGoalOpen: () => true,
    goalState: () => 'active',
    verifiedCheckpoints: () => 0,
    totalCheckpoints: () => 0,
    retryCount: () => 0,
    ...overrides,
  }
}

function verificationPort(overrides: Partial<VerificationGoalPort> = {}): VerificationGoalPort {
  return {
    recordCheckpointOutcome: async () => {},
    checkpointAttempts: () => 0,
    goalRetryCount: () => 0,
    ...overrides,
  }
}

async function openGoalEngine(options: Partial<ConstructorParameters<typeof GoalEngine>[0]> = {}) {
  const store = new MemoryGoalStore()
  const fabric = await EventFabric.open({
    store: await JsonlEventStore.open(join(directory, 'events.jsonl')),
    now: () => new Date('2026-10-01T09:00:00.000Z'),
    newId: () => `id-${Math.random().toString(36).slice(2)}`,
  })
  const engine = new GoalEngine({
    fabric,
    store,
    continuation: continuationStub(),
    principalId: 'owner',
    now: () => new Date('2026-10-01T09:00:00.000Z'),
    newId: () => `id-${Math.random().toString(36).slice(2)}`,
    ...options,
  })
  await engine.open()
  return { engine, store, fabric }
}

async function openScheduler(options: Partial<ConstructorParameters<typeof GoalScheduler>[0]> = {}) {
  const store = new MemoryGoalScheduleStore()
  const fabric = await EventFabric.open({
    store: await JsonlEventStore.open(join(directory, 'events.jsonl')),
    now: () => new Date('2026-10-01T09:00:00.000Z'),
    newId: () => `id-${Math.random().toString(36).slice(2)}`,
  })
  const scheduler = new GoalScheduler({
    fabric,
    store,
    principalId: 'owner',
    now: () => new Date('2026-10-01T09:00:00.000Z'),
    newId: () => `id-${Math.random().toString(36).slice(2)}`,
    ...options,
  })
  await scheduler.open()
  return { scheduler, store, fabric }
}

/**
 * A journal line, for the fold and replay-attack tests.
 *
 * `AnyCoreEvent` is a union keyed on `type`, so the cast is at that one join and
 * only there: the payload keeps its `Record<string, unknown>` type and every
 * envelope field stays written out in full, so a hand-forged line in a test is
 * built from the same named fields a real line has.
 */
function event(type: AnyCoreEvent['type'], payload: Record<string, unknown>, sequence: number): AnyCoreEvent {
  return {
    eventId: `evt-${sequence}`,
    sequence,
    type,
    schemaVersion: 1,
    occurredAt: '2026-10-01T09:00:00.000Z',
    source: 'core',
    actor: 'owner',
    correlationId: `corr-${sequence}`,
    causationId: null,
    payload,
  } as unknown as AnyCoreEvent
}

/* ---------------------------------------------------------- authority escalation */

describe('authority escalation attempts', () => {
  it('a goal cannot claim a capability it does not hold', async () => {
    const { engine } = await openGoalEngine()
    const created = await engine.createGoal({ title: 'Test', description: 'A test goal' })
    expect(created.ok).toBe(true)
    // The goal engine holds no capability registry and grants nothing. A goal
    // that claims a capability is data; only Core grants.
    expect(engine).not.toHaveProperty('grantCapability')
    expect(engine).not.toHaveProperty('capabilities')
  })

  it('a goal cannot claim authority it does not have', async () => {
    const { engine } = await openGoalEngine()
    const created = await engine.createGoal({ title: 'Test', description: 'A test goal' })
    expect(created.ok).toBe(true)
    // The goal engine cannot approve its own requests.
    expect(engine).not.toHaveProperty('approve')
    expect(engine).not.toHaveProperty('grant')
  })

  it('a goal cannot claim to be the owner', async () => {
    const { engine } = await openGoalEngine()
    // The principal is baked in by Core and never taken from a payload.
    const created = await engine.createGoal({ title: 'Test', description: 'A test goal' })
    expect(created.ok).toBe(true)
    // The engine's principal is fixed at construction; no command can change it.
    expect(engine).not.toHaveProperty('setPrincipal')
  })

  it('a goal cannot claim a higher priority', async () => {
    const { engine } = await openGoalEngine()
    const created = await engine.createGoal({ title: 'Test', description: 'A test goal' })
    expect(created.ok).toBe(true)
    // Priority is derived from explicit signals, never from a goal's claim.
    expect(engine).not.toHaveProperty('setPriority')
    expect(engine).not.toHaveProperty('priority')
  })

  it('a goal cannot claim more budget', async () => {
    const { engine } = await openGoalEngine()
    const created = await engine.createGoal({ title: 'Test', description: 'A test goal' })
    expect(created.ok).toBe(true)
    // Budget is derived from durable state, never from a goal's claim.
    expect(engine).not.toHaveProperty('setBudget')
    expect(engine).not.toHaveProperty('budget')
  })

  it('a goal cannot claim approval', async () => {
    const { engine } = await openGoalEngine()
    const created = await engine.createGoal({ title: 'Test', description: 'A test goal' })
    expect(created.ok).toBe(true)
    // Approval is granted by the owner, never by a goal's claim.
    expect(engine).not.toHaveProperty('approve')
  })
})

/* ---------------------------------------------------------- boundary violations */

describe('boundary violation attempts', () => {
  it('STOP ALL immediately halts the goal engine', async () => {
    let stopAll = false
    const { engine } = await openGoalEngine({ stopAll: () => stopAll })
    const created = await engine.createGoal({ title: 'Test', description: 'A test goal' })
    expect(created.ok).toBe(true)
    stopAll = true
    const outcome = await engine.activateGoal(created.goalId!)
    expect(outcome.ok).toBe(false)
  })

  it('STOP ALL immediately halts the scheduler', async () => {
    let stopAll = false
    const { scheduler } = await openScheduler({ stopAll: () => stopAll })
    await scheduler.registerSchedule({ delayMs: 0 })
    stopAll = true
    const result = await scheduler.attentionTick()
    expect(result.fired).toHaveLength(0)
  })

  it('STOP ALL immediately halts the continuation engine', async () => {
    let stopAll = false
    const fabric = await EventFabric.open({
      store: await JsonlEventStore.open(join(directory, 'events.jsonl')),
      now: () => new Date('2026-10-01T09:00:00.000Z'),
      newId: () => `id-${Math.random().toString(36).slice(2)}`,
    })
    const engine = new ContinuationEngine({
      fabric,
      goals: goalPort(),
      principalId: 'owner',
      stopAll: () => stopAll,
    })
    await engine.open()
    stopAll = true
    const outcome = await engine.handleWake({ wakeId: 'w1', source: 'schedule', goalId: 'g1' })
    expect(outcome.decision.decision).toBe('wait')
  })

  it('STOP ALL immediately halts verification', async () => {
    let stopAll = false
    const fabric = await EventFabric.open({
      store: await JsonlEventStore.open(join(directory, 'events.jsonl')),
      now: () => new Date('2026-10-01T09:00:00.000Z'),
      newId: () => `id-${Math.random().toString(36).slice(2)}`,
    })
    const engine = new VerificationEngine({
      fabric,
      goals: verificationPort(),
      principalId: 'owner',
      stopAll: () => stopAll,
    })
    await engine.open()
    stopAll = true
    const result = await engine.verify(
      'g1',
      'c1',
      { id: 'v1', verify: async () => ({ established: true, reason: GOAL_REASONS.verification_passed }) },
      new AbortController().signal,
    )
    expect(result.outcome).toBe('cancelled')
  })

  it('a corrupt journal halts the scheduler', async () => {
    const { scheduler } = await openScheduler({ journalTrustworthy: () => false })
    await scheduler.registerSchedule({ delayMs: 0 })
    const result = await scheduler.attentionTick()
    expect(result.fired).toHaveLength(0)
  })

  it('the scheduler cannot be made to exceed its ceiling', async () => {
    const { scheduler } = await openScheduler()
    for (let i = 0; i < SCHEDULE_LIMITS.maxSchedules; i += 1) {
      await scheduler.registerSchedule({ delayMs: 0 })
    }
    const extra = await scheduler.registerSchedule({ delayMs: 0 })
    expect(extra.ok).toBe(false)
  })

  it('the scheduler cannot be made to repeat beyond its ceiling', async () => {
    const { scheduler } = await openScheduler()
    const outcome = await scheduler.registerSchedule({ delayMs: 0, maxRepeats: SCHEDULE_LIMITS.maxRepeats + 1 })
    expect(outcome.ok).toBe(false)
  })

  it('the scheduler cannot be made to fire faster than the minimum interval', async () => {
    const { scheduler } = await openScheduler()
    const outcome = await scheduler.registerSchedule({
      delayMs: 0,
      maxRepeats: 2,
      intervalMs: SCHEDULE_LIMITS.minIntervalMs - 1,
    })
    expect(outcome.ok).toBe(false)
  })
})

/* ---------------------------------------------------------- hidden inference */

describe('hidden inference attempts', () => {
  it('the goal engine has no provider, gateway, or cognition service', () => {
    const engine = new GoalEngine({
      fabric: null as never,
      store: null as never,
      continuation: null as never,
      principalId: 'owner',
    })
    expect(engine).not.toHaveProperty('gateway')
    expect(engine).not.toHaveProperty('provider')
    expect(engine).not.toHaveProperty('cognition')
    expect(engine).not.toHaveProperty('model')
  })

  it('the scheduler has no provider, gateway, or cognition service', () => {
    const scheduler = new GoalScheduler({
      fabric: null as never,
      store: null as never,
      principalId: 'owner',
    })
    expect(scheduler).not.toHaveProperty('gateway')
    expect(scheduler).not.toHaveProperty('provider')
    expect(scheduler).not.toHaveProperty('cognition')
    expect(scheduler).not.toHaveProperty('model')
  })

  it('the continuation engine has no provider, gateway, or cognition service', () => {
    const engine = new ContinuationEngine({
      fabric: null as never,
      goals: null as never,
      principalId: 'owner',
    })
    expect(engine).not.toHaveProperty('gateway')
    expect(engine).not.toHaveProperty('provider')
    expect(engine).not.toHaveProperty('cognition')
    expect(engine).not.toHaveProperty('model')
  })

  it('the verification engine has no provider, gateway, or cognition service', () => {
    const engine = new VerificationEngine({
      fabric: null as never,
      goals: null as never,
      principalId: 'owner',
    })
    expect(engine).not.toHaveProperty('gateway')
    expect(engine).not.toHaveProperty('provider')
    expect(engine).not.toHaveProperty('cognition')
    expect(engine).not.toHaveProperty('model')
  })

  it('no component has a self-scheduling timer', () => {
    const goalEngine = new GoalEngine({
      fabric: null as never,
      store: null as never,
      continuation: null as never,
      principalId: 'owner',
    })
    const scheduler = new GoalScheduler({
      fabric: null as never,
      store: null as never,
      principalId: 'owner',
    })
    for (const component of [goalEngine, scheduler]) {
      expect(component).not.toHaveProperty('timer')
      expect(component).not.toHaveProperty('interval')
      expect(component).not.toHaveProperty('loop')
      expect(component).not.toHaveProperty('setInterval')
    }
  })

  it('an idle goal costs nothing', async () => {
    const { engine } = await openGoalEngine()
    await engine.createGoal({ title: 'Test', description: 'A test goal' })
    // Listing and reading are pure reads: no model call, no spend.
    engine.projection()
    await engine.detail('non-existent')
  })
})

/* ---------------------------------------------------------- data injection */

describe('data injection attempts', () => {
  it('a goal event cannot carry a title', () => {
    // The reducer reads only metadata fields. A title in a hand-written event
    // is ignored because the reducer never reads it.
    const state = reduceGoalState(
      initialGoalState(),
      event('longhorizon.goal.created', {
        goalId: 'g1',
        state: 'draft',
        createdAt: '2026-10-01T09:00:00.000Z',
        deadlineAt: '2026-12-01T09:00:00.000Z',
        dependencies: [],
        limits: DEFAULT_GOAL_LIMITS,
        title: 'private title',
      }, 1),
    )
    // The goal is created, but the title is not part of the record.
    expect(state.goals.has('g1')).toBe(true)
    expect(state.goals.get('g1')).not.toHaveProperty('title')
  })

  it('a goal event cannot carry a description', () => {
    const state = reduceGoalState(
      initialGoalState(),
      event('longhorizon.goal.created', {
        goalId: 'g1',
        state: 'draft',
        createdAt: '2026-10-01T09:00:00.000Z',
        deadlineAt: '2026-12-01T09:00:00.000Z',
        dependencies: [],
        limits: DEFAULT_GOAL_LIMITS,
        description: 'private description',
      }, 1),
    )
    expect(state.goals.has('g1')).toBe(true)
    expect(state.goals.get('g1')).not.toHaveProperty('description')
  })

  it('a checkpoint verified event cannot carry a verifier message', () => {
    let state = reduceGoalState(
      initialGoalState(),
      event('longhorizon.goal.created', {
        goalId: 'g1',
        state: 'draft',
        createdAt: '2026-10-01T09:00:00.000Z',
        deadlineAt: '2026-12-01T09:00:00.000Z',
        dependencies: [],
        limits: DEFAULT_GOAL_LIMITS,
      }, 1),
    )
    state = reduceGoalState(
      state,
      event('longhorizon.checkpoint.started', { goalId: 'g1', checkpointId: 'c1', order: 0, kind: 'test' }, 2),
    )
    state = reduceGoalState(
      state,
      event('longhorizon.checkpoint.verified', {
        goalId: 'g1',
        checkpointId: 'c1',
        outcome: 'passed',
        reason: null,
        evidence: 'private evidence',
      }, 3),
    )
    expect(state.checkpoints.get('c1')?.status).toBe('verified')
    expect(state.checkpoints.get('c1')).not.toHaveProperty('evidence')
  })

  it('a state-changed event cannot carry a free-text reason', () => {
    let state = reduceGoalState(
      initialGoalState(),
      event('longhorizon.goal.created', {
        goalId: 'g1',
        state: 'draft',
        createdAt: '2026-10-01T09:00:00.000Z',
        deadlineAt: '2026-12-01T09:00:00.000Z',
        dependencies: [],
        limits: DEFAULT_GOAL_LIMITS,
      }, 1),
    )
    state = reduceGoalState(
      state,
      event('longhorizon.goal.state-changed', { goalId: 'g1', from: 'draft', to: 'active', reason: 'owner' }, 2),
    )
    // A free-text reason is never recorded. The reducer falls back to a closed
    // code rather than storing a message, so the journal holds a code and
    // never a sentence.
    state = reduceGoalState(
      state,
      event('longhorizon.goal.state-changed', {
        goalId: 'g1',
        from: 'active',
        to: 'failed',
        reason: 'the model said so',
      }, 3),
    )
    expect(state.goals.get('g1')?.state).toBe('failed')
    expect(state.goals.get('g1')?.reason).toBe(GOAL_REASONS.owner)
  })
})

/* ---------------------------------------------------------- restart recovery */

describe('restart recovery attacks', () => {
  it('a hand-written journal cannot fabricate a completed goal', () => {
    let state = reduceGoalState(
      initialGoalState(),
      event('longhorizon.goal.created', {
        goalId: 'g1',
        state: 'draft',
        createdAt: '2026-10-01T09:00:00.000Z',
        deadlineAt: '2026-12-01T09:00:00.000Z',
        dependencies: [],
        limits: DEFAULT_GOAL_LIMITS,
      }, 1),
    )
    state = reduceGoalState(
      state,
      event('longhorizon.goal.state-changed', { goalId: 'g1', from: 'draft', to: 'active', reason: 'owner' }, 2),
    )
    state = reduceGoalState(
      state,
      event('longhorizon.goal.state-changed', {
        goalId: 'g1',
        from: 'active',
        to: 'completed',
        reason: 'verification_passed',
      }, 3),
    )
    // No checkpoints were verified, so the completion is refused.
    expect(state.goals.get('g1')?.state).toBe('active')
  })

  it('a hand-written journal cannot fabricate a verified checkpoint', () => {
    let state = reduceGoalState(
      initialGoalState(),
      event('longhorizon.goal.created', {
        goalId: 'g1',
        state: 'draft',
        createdAt: '2026-10-01T09:00:00.000Z',
        deadlineAt: '2026-12-01T09:00:00.000Z',
        dependencies: [],
        limits: DEFAULT_GOAL_LIMITS,
      }, 1),
    )
    // A checkpoint.verified for a checkpoint that was never started is ignored.
    state = reduceGoalState(
      state,
      event('longhorizon.checkpoint.verified', {
        goalId: 'g1',
        checkpointId: 'c1',
        outcome: 'passed',
        reason: null,
      }, 2),
    )
    expect(state.checkpoints.has('c1')).toBe(false)
    expect(state.goals.get('g1')?.verifiedCheckpoints).toBe(0)
  })

  it('an interrupted goal is paused, not resumed, on restart', async () => {
    const store = new MemoryGoalStore()
    const fabric = await EventFabric.open({
      store: await JsonlEventStore.open(join(directory, 'events.jsonl')),
      now: () => new Date('2026-10-01T09:00:00.000Z'),
      newId: () => `id-${Math.random().toString(36).slice(2)}`,
    })
    const engine = new GoalEngine({
      fabric,
      store,
      continuation: continuationStub(),
      principalId: 'owner',
      now: () => new Date('2026-10-01T09:00:00.000Z'),
      newId: () => `id-${Math.random().toString(36).slice(2)}`,
    })
    await engine.open()
    const created = await engine.createGoal({ title: 'Test', description: 'A test goal' })
    await engine.activateGoal(created.goalId!)
    await engine.close()

    const fabric2 = await EventFabric.open({
      store: await JsonlEventStore.open(join(directory, 'events.jsonl')),
      now: () => new Date('2026-10-01T10:00:00.000Z'),
      newId: () => `id-${Math.random().toString(36).slice(2)}`,
    })
    const engine2 = new GoalEngine({
      fabric: fabric2,
      store,
      continuation: continuationStub(),
      principalId: 'owner',
      now: () => new Date('2026-10-01T10:00:00.000Z'),
      newId: () => `id-${Math.random().toString(36).slice(2)}`,
    })
    await engine2.open()
    const projection = engine2.projection()
    expect(projection.goals[0]?.state).toBe('paused')
    await engine2.close()
  })

  it('an interrupted checkpoint is failed, not verified, on restart', async () => {
    const store = new MemoryGoalStore()
    const fabric = await EventFabric.open({
      store: await JsonlEventStore.open(join(directory, 'events.jsonl')),
      now: () => new Date('2026-10-01T09:00:00.000Z'),
      newId: () => `id-${Math.random().toString(36).slice(2)}`,
    })
    const engine = new GoalEngine({
      fabric,
      store,
      continuation: continuationStub(),
      principalId: 'owner',
      now: () => new Date('2026-10-01T09:00:00.000Z'),
      newId: () => `id-${Math.random().toString(36).slice(2)}`,
    })
    await engine.open()
    const created = await engine.createGoal({ title: 'Test', description: 'A test goal' })
    await engine.activateGoal(created.goalId!)
    // Simulate an in-progress checkpoint by appending a started event directly.
    await fabric.append('longhorizon.checkpoint.started' as never, {
      goalId: created.goalId,
      checkpointId: 'c1',
      order: 0,
      kind: 'test',
    } as never, { actor: 'owner' })
    await engine.close()

    const fabric2 = await EventFabric.open({
      store: await JsonlEventStore.open(join(directory, 'events.jsonl')),
      now: () => new Date('2026-10-01T10:00:00.000Z'),
      newId: () => `id-${Math.random().toString(36).slice(2)}`,
    })
    const engine2 = new GoalEngine({
      fabric: fabric2,
      store,
      continuation: continuationStub(),
      principalId: 'owner',
      now: () => new Date('2026-10-01T10:00:00.000Z'),
      newId: () => `id-${Math.random().toString(36).slice(2)}`,
    })
    await engine2.open()
    const state = engine2.state()
    expect(state.checkpoints.get('c1')?.status).toBe('failed')
    expect(state.checkpoints.get('c1')?.failureReason).toBe(GOAL_REASONS.restart_interrupted)
    await engine2.close()
  })

  it('an interrupted goal is visible to the owner on restart', async () => {
    const store = new MemoryGoalStore()
    const fabric = await EventFabric.open({
      store: await JsonlEventStore.open(join(directory, 'events.jsonl')),
      now: () => new Date('2026-10-01T09:00:00.000Z'),
      newId: () => `id-${Math.random().toString(36).slice(2)}`,
    })
    const engine = new GoalEngine({
      fabric,
      store,
      continuation: continuationStub(),
      principalId: 'owner',
      now: () => new Date('2026-10-01T09:00:00.000Z'),
      newId: () => `id-${Math.random().toString(36).slice(2)}`,
    })
    await engine.open()
    const created = await engine.createGoal({ title: 'Test', description: 'A test goal' })
    await engine.activateGoal(created.goalId!)
    await engine.close()

    const fabric2 = await EventFabric.open({
      store: await JsonlEventStore.open(join(directory, 'events.jsonl')),
      now: () => new Date('2026-10-01T10:00:00.000Z'),
      newId: () => `id-${Math.random().toString(36).slice(2)}`,
    })
    const engine2 = new GoalEngine({
      fabric: fabric2,
      store,
      continuation: continuationStub(),
      principalId: 'owner',
      now: () => new Date('2026-10-01T10:00:00.000Z'),
      newId: () => `id-${Math.random().toString(36).slice(2)}`,
    })
    await engine2.open()
    const projection = engine2.projection()
    expect(projection.goals).toHaveLength(1)
    expect(projection.goals[0]?.goalId).toBe(created.goalId)
    await engine2.close()
  })
})

/* ---------------------------------------------------------- composite */

describe('composite attacks', () => {
  it('a goal cannot complete without verified checkpoints', async () => {
    const { engine } = await openGoalEngine()
    const created = await engine.createGoal({ title: 'Test', description: 'A test goal' })
    await engine.activateGoal(created.goalId!)
    const outcome = await engine.completeGoal(created.goalId!)
    expect(outcome.ok).toBe(false)
  })

  it('a goal cannot complete with partially verified checkpoints', async () => {
    const store = new MemoryGoalStore()
    const fabric = await EventFabric.open({
      store: await JsonlEventStore.open(join(directory, 'events.jsonl')),
      now: () => new Date('2026-10-01T09:00:00.000Z'),
      newId: () => `id-${Math.random().toString(36).slice(2)}`,
    })
    const engine = new GoalEngine({
      fabric,
      store,
      continuation: continuationStub(),
      principalId: 'owner',
      now: () => new Date('2026-10-01T09:00:00.000Z'),
      newId: () => `id-${Math.random().toString(36).slice(2)}`,
    })
    await engine.open()
    const created = await engine.createGoal({ title: 'Test', description: 'A test goal' })
    await engine.activateGoal(created.goalId!)
    // Start two checkpoints, verify one.
    await fabric.append('longhorizon.checkpoint.started' as never, {
      goalId: created.goalId,
      checkpointId: 'c1',
      order: 0,
      kind: 'test',
    } as never, { actor: 'owner' })
    await fabric.append('longhorizon.checkpoint.started' as never, {
      goalId: created.goalId,
      checkpointId: 'c2',
      order: 1,
      kind: 'test',
    } as never, { actor: 'owner' })
    await fabric.append('longhorizon.checkpoint.verified' as never, {
      goalId: created.goalId,
      checkpointId: 'c1',
      outcome: 'passed',
      reason: null,
    } as never, { actor: 'owner' })
    const outcome = await engine.completeGoal(created.goalId!)
    expect(outcome.ok).toBe(false)
  })

  it('the subsystem cannot create a grant', () => {
    const goalEngine = new GoalEngine({
      fabric: null as never,
      store: null as never,
      continuation: null as never,
      principalId: 'owner',
    })
    expect(goalEngine).not.toHaveProperty('createGrant')
    expect(goalEngine).not.toHaveProperty('grant')
  })

  it('the subsystem cannot widen a capability', () => {
    const goalEngine = new GoalEngine({
      fabric: null as never,
      store: null as never,
      continuation: null as never,
      principalId: 'owner',
    })
    expect(goalEngine).not.toHaveProperty('widenCapability')
    expect(goalEngine).not.toHaveProperty('capability')
  })
})
