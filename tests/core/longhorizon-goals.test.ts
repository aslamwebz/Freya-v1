// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GoalEngine } from '../../core/longhorizon/engine'
import { MemoryGoalStore } from '../../core/longhorizon/memory-store'
import type { GoalStore } from '../../core/longhorizon/store'
import {
  DEFAULT_GOAL_LIMITS,
  GOAL_REASONS,
  GOAL_STATES,
  GOAL_TERMINAL_STATES,
  GOAL_TRANSITIONS,
  canTransitionGoal,
  isTerminalGoalStatus,
  normaliseGoalContent,
  goalLimits,
  type GoalStatus,
} from '../../core/longhorizon/types'
import { reduceGoalState, initialGoalState } from '../../core/longhorizon/state'
import type { AnyCoreEvent } from '../../core/events/envelope'
import { EventFabric } from '../../core/events/fabric'
import { JsonlEventStore } from '../../core/events/jsonl-store'

/**
 * The goal domain: types, state machine, store, engine, reducer.
 *
 * Grouped by the property each group defends rather than by method, because the
 * methods are not what matters — what matters is which of them cannot be made to
 * lie.
 *
 * The continuation port is stubbed here on purpose: these tests are about the goal
 * engine's own rules (limits, verification, races, settlement), and a stub makes
 * the boundary under test the boundary that is actually being tested.
 */

let directory = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'freya-goal-engine-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/* ---------------------------------------------------------- helpers */

function memoryStore(): GoalStore {
  return new MemoryGoalStore()
}

function continuationStub(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    verifyCheckpoint: async () => ({ established: true, reason: GOAL_REASONS.verification_passed }),
    ...overrides,
  }
}

async function openEngine(options: Partial<ConstructorParameters<typeof GoalEngine>[0]> = {}) {
  const store = options.store ?? memoryStore()
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

/**
 * A journal line, for the fold tests.
 *
 * `AnyCoreEvent` is a union keyed on `type`, so no single object literal can name
 * an arbitrary type and an arbitrary payload at once — the cast is at that one
 * join, not on the payload: `payload` stays `Record<string, unknown>`, so every
 * field this helper writes is still checked, and the reducer still has to accept
 * what it is given.
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

/* ---------------------------------------------------------- state machine */

describe('the goal state machine', () => {
  it('has exactly the six documented states', () => {
    expect([...GOAL_STATES]).toEqual([
      'draft',
      'active',
      'paused',
      'completed',
      'failed',
      'cancelled',
    ])
  })

  it('names exactly three of them terminal', () => {
    expect([...GOAL_TERMINAL_STATES]).toEqual(['completed', 'failed', 'cancelled'])
    for (const state of GOAL_STATES) {
      expect(isTerminalGoalStatus(state)).toBe(GOAL_TERMINAL_STATES.includes(state as never))
    }
  })

  it('permits exactly the documented transitions', () => {
    expect(GOAL_TRANSITIONS.draft).toEqual(['active', 'cancelled'])
    expect(GOAL_TRANSITIONS.active).toEqual(['paused', 'completed', 'failed', 'cancelled'])
    expect(GOAL_TRANSITIONS.paused).toEqual(['active', 'failed', 'cancelled'])
    expect(GOAL_TRANSITIONS.completed).toEqual([])
    expect(GOAL_TRANSITIONS.failed).toEqual([])
    expect(GOAL_TRANSITIONS.cancelled).toEqual([])
  })

  it('has no way out of a terminal state — no resurrection', () => {
    for (const state of GOAL_TERMINAL_STATES) {
      for (const target of GOAL_STATES) {
        expect(canTransitionGoal(state, target)).toBe(false)
      }
    }
  })

  it('refuses every undocumented shortcut', () => {
    const illegal: readonly [GoalStatus, GoalStatus][] = [
      ['draft', 'paused'],
      ['draft', 'completed'],
      ['draft', 'failed'],
      ['active', 'draft'],
      ['paused', 'draft'],
      ['paused', 'completed'],
      ['active', 'active'],
      ['paused', 'paused'],
      ['draft', 'draft'],
    ]
    for (const [from, to] of illegal) {
      expect(canTransitionGoal(from, to)).toBe(false)
    }
  })

  it('permits exactly the legal moves', () => {
    const legal: readonly [GoalStatus, GoalStatus][] = [
      ['draft', 'active'],
      ['draft', 'cancelled'],
      ['active', 'paused'],
      ['active', 'completed'],
      ['active', 'failed'],
      ['active', 'cancelled'],
      ['paused', 'active'],
      ['paused', 'failed'],
      ['paused', 'cancelled'],
    ]
    for (const [from, to] of legal) {
      expect(canTransitionGoal(from, to)).toBe(true)
    }
  })

  it('has closed reason codes rather than free text for durable records', () => {
    for (const reason of Object.values(GOAL_REASONS)) {
      expect(typeof reason).toBe('string')
      expect(reason.length).toBeGreaterThan(0)
    }
    expect(GOAL_REASONS.owner).toBeTruthy()
    expect(GOAL_REASONS.verification_passed).toBeTruthy()
    expect(GOAL_REASONS.verification_not_established).toBeTruthy()
    expect(GOAL_REASONS.verification_timeout).toBeTruthy()
    expect(GOAL_REASONS.deadline_expired).toBeTruthy()
    expect(GOAL_REASONS.retry_ceiling_reached).toBeTruthy()
    expect(GOAL_REASONS.hard_blocker).toBeTruthy()
    expect(GOAL_REASONS.stop_all).toBeTruthy()
    expect(GOAL_REASONS.budget_exhausted).toBeTruthy()
    expect(GOAL_REASONS.dependency_unmet).toBeTruthy()
    expect(GOAL_REASONS.dependency_met).toBeTruthy()
    expect(GOAL_REASONS.recovery).toBeTruthy()
    expect(GOAL_REASONS.shutdown).toBeTruthy()
  })
})

/* ---------------------------------------------------------- limits */

describe('goal limits', () => {
  it('has code-owned ceilings that cannot be widened', () => {
    expect(() => goalLimits({ maxCheckpointsPerGoal: 1000 })).toThrow()
    expect(() => goalLimits({ lifetimeMs: 999999999999 })).toThrow()
    expect(() => goalLimits({ maxRetryCeiling: 100 })).toThrow()
  })

  it('permits narrowing', () => {
    const narrowed = goalLimits({ maxCheckpointsPerGoal: 32 })
    expect(narrowed.maxCheckpointsPerGoal).toBe(32)
    expect(narrowed.lifetimeMs).toBe(DEFAULT_GOAL_LIMITS.lifetimeMs)
  })

  it('refuses unknown keys', () => {
    expect(() => goalLimits({ unknownLimit: 10 } as never)).toThrow()
  })

  it('refuses non-positive integers', () => {
    expect(() => goalLimits({ maxCheckpointsPerGoal: 0 })).toThrow()
    expect(() => goalLimits({ maxCheckpointsPerGoal: -1 })).toThrow()
    expect(() => goalLimits({ maxCheckpointsPerGoal: 1.5 })).toThrow()
  })
})

/* ---------------------------------------------------------- content */

describe('goal content', () => {
  it('normalises and bounds a valid input', () => {
    const result = normaliseGoalContent({
      title: 'Test goal',
      description: 'A test goal description',
      completionCriteria: ['criterion-1', 'criterion-2'],
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.title).toBe('Test goal')
      expect(result.value.description).toBe('A test goal description')
      expect(result.value.completionCriteria).toEqual(['criterion-1', 'criterion-2'])
    }
  })

  it('refuses an empty title', () => {
    const result = normaliseGoalContent({ title: '', description: 'desc' })
    expect(result.ok).toBe(false)
  })

  it('refuses a title that is too long', () => {
    const result = normaliseGoalContent({ title: 'x'.repeat(200), description: 'desc' })
    expect(result.ok).toBe(false)
  })

  it('refuses an empty description', () => {
    const result = normaliseGoalContent({ title: 'title', description: '' })
    expect(result.ok).toBe(false)
  })

  it('refuses too many completion criteria', () => {
    const criteria = Array.from({ length: 100 }, (_, i) => `criterion-${i}`)
    const result = normaliseGoalContent({ title: 'title', description: 'desc', completionCriteria: criteria })
    expect(result.ok).toBe(false)
  })

  it('strips control characters from title', () => {
    const result = normaliseGoalContent({ title: 'title\x00\x01', description: 'desc' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.title).toBe('title')
    }
  })

  it('trims whitespace', () => {
    const result = normaliseGoalContent({ title: '  title  ', description: '  desc  ' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.title).toBe('title')
      expect(result.value.description).toBe('desc')
    }
  })
})

/* ---------------------------------------------------------- engine */

describe('the goal engine', () => {
  it('creates a goal in draft state', async () => {
    const { engine } = await openEngine()
    const outcome = await engine.createGoal({ title: 'Test', description: 'A test goal' })
    expect(outcome.ok).toBe(true)
    expect(outcome.state).toBe('draft')
    const projection = engine.projection()
    expect(projection.goals).toHaveLength(1)
    expect(projection.goals[0]?.state).toBe('draft')
  })

  it('activates a draft goal', async () => {
    const { engine } = await openEngine()
    const created = await engine.createGoal({ title: 'Test', description: 'A test goal' })
    expect(created.ok).toBe(true)
    const goalId = created.goalId!
    const activated = await engine.activateGoal(goalId)
    expect(activated.ok).toBe(true)
    expect(activated.state).toBe('active')
  })

  it('pauses an active goal', async () => {
    const { engine } = await openEngine()
    const created = await engine.createGoal({ title: 'Test', description: 'A test goal' })
    const goalId = created.goalId!
    await engine.activateGoal(goalId)
    const paused = await engine.pauseGoal(goalId)
    expect(paused.ok).toBe(true)
    expect(paused.state).toBe('paused')
  })

  it('resumes a paused goal', async () => {
    const { engine } = await openEngine()
    const created = await engine.createGoal({ title: 'Test', description: 'A test goal' })
    const goalId = created.goalId!
    await engine.activateGoal(goalId)
    await engine.pauseGoal(goalId)
    const resumed = await engine.resumeGoal(goalId)
    expect(resumed.ok).toBe(true)
    expect(resumed.state).toBe('active')
  })

  it('refuses to activate a paused goal', async () => {
    const { engine } = await openEngine()
    const created = await engine.createGoal({ title: 'Test', description: 'A test goal' })
    const goalId = created.goalId!
    await engine.activateGoal(goalId)
    await engine.pauseGoal(goalId)
    const outcome = await engine.activateGoal(goalId)
    expect(outcome.ok).toBe(false)
  })

  it('refuses to complete a goal with no checkpoints', async () => {
    const { engine } = await openEngine()
    const created = await engine.createGoal({ title: 'Test', description: 'A test goal' })
    const goalId = created.goalId!
    await engine.activateGoal(goalId)
    const outcome = await engine.completeGoal(goalId)
    expect(outcome.ok).toBe(false)
  })

  it('refuses to transition a terminal goal', async () => {
    const { engine } = await openEngine()
    const created = await engine.createGoal({ title: 'Test', description: 'A test goal' })
    const goalId = created.goalId!
    await engine.cancelGoal(goalId)
    const outcome = await engine.activateGoal(goalId)
    expect(outcome.ok).toBe(false)
  })

  it('refuses to transition a non-existent goal', async () => {
    const { engine } = await openEngine()
    const outcome = await engine.activateGoal('non-existent')
    expect(outcome.ok).toBe(false)
  })

  it('does nothing while STOP ALL is active', async () => {
    let stopAll = false
    const { engine } = await openEngine({ stopAll: () => stopAll })
    const created = await engine.createGoal({ title: 'Test', description: 'A test goal' })
    expect(created.ok).toBe(true)
    stopAll = true
    const outcome = await engine.activateGoal(created.goalId!)
    expect(outcome.ok).toBe(false)
  })

  it('produces a projection with counts', async () => {
    const { engine } = await openEngine()
    await engine.createGoal({ title: 'Test', description: 'A test goal' })
    const projection = engine.projection()
    expect(projection.counts.total).toBe(1)
    expect(projection.counts.draft).toBe(1)
    expect(projection.goals).toHaveLength(1)
  })

  it('produces a detail with content', async () => {
    const { engine } = await openEngine()
    const created = await engine.createGoal({ title: 'Test', description: 'A test goal' })
    const detail = await engine.detail(created.goalId!)
    expect(detail).not.toBeNull()
    expect(detail!.content).not.toBeNull()
    expect(detail!.content!.title).toBe('Test')
  })
})

/* ---------------------------------------------------------- reducer */

describe('the goal reducer', () => {
  it('folds a created goal', () => {
    const state = reduceGoalState(
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
    expect(state.goals.has('g1')).toBe(true)
    expect(state.goals.get('g1')?.state).toBe('draft')
  })

  it('folds a state transition', () => {
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
      event('longhorizon.goal.state-changed', {
        goalId: 'g1',
        from: 'draft',
        to: 'active',
        reason: 'owner',
      }, 2),
    )
    expect(state.goals.get('g1')?.state).toBe('active')
  })

  it('refuses an illegal transition', () => {
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
      event('longhorizon.goal.state-changed', {
        goalId: 'g1',
        from: 'draft',
        to: 'completed',
        reason: 'owner',
      }, 2),
    )
    expect(state.goals.get('g1')?.state).toBe('draft')
  })

  it('refuses a transition from a non-existent goal', () => {
    const state = reduceGoalState(
      initialGoalState(),
      event('longhorizon.goal.state-changed', {
        goalId: 'non-existent',
        from: 'draft',
        to: 'active',
        reason: 'owner',
      }, 1),
    )
    expect(state.goals.size).toBe(0)
  })

  it('refuses a completed goal without verified checkpoints', () => {
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
      event('longhorizon.goal.state-changed', {
        goalId: 'g1',
        from: 'draft',
        to: 'active',
        reason: 'owner',
      }, 2),
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
    expect(state.goals.get('g1')?.state).toBe('active')
  })

  it('folds a checkpoint started', () => {
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
      event('longhorizon.checkpoint.started', {
        goalId: 'g1',
        checkpointId: 'c1',
        order: 0,
        kind: 'test',
      }, 2),
    )
    expect(state.checkpoints.has('c1')).toBe(true)
    expect(state.goals.get('g1')?.checkpoints).toContain('c1')
  })

  it('folds a checkpoint verified', () => {
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
      event('longhorizon.checkpoint.started', {
        goalId: 'g1',
        checkpointId: 'c1',
        order: 0,
        kind: 'test',
      }, 2),
    )
    state = reduceGoalState(
      state,
      event('longhorizon.checkpoint.verified', {
        goalId: 'g1',
        checkpointId: 'c1',
        outcome: 'passed',
        reason: null,
      }, 3),
    )
    expect(state.checkpoints.get('c1')?.status).toBe('verified')
    expect(state.goals.get('g1')?.verifiedCheckpoints).toBe(1)
  })

  it('ignores non-goal events', () => {
    const state = reduceGoalState(
      initialGoalState(),
      event('mission.created', { missionId: 'm1' }, 1),
    )
    expect(state.goals.size).toBe(0)
    expect(state.sequence).toBe(0)
  })

  it('is idempotent for duplicate checkpoint starts', () => {
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
      event('longhorizon.checkpoint.started', {
        goalId: 'g1',
        checkpointId: 'c1',
        order: 0,
        kind: 'test',
      }, 2),
    )
    state = reduceGoalState(
      state,
      event('longhorizon.checkpoint.started', {
        goalId: 'g1',
        checkpointId: 'c1',
        order: 0,
        kind: 'test',
      }, 3),
    )
    expect(state.goals.get('g1')?.checkpoints).toHaveLength(1)
  })
})

/* ---------------------------------------------------------- restart recovery */

describe('restart recovery', () => {
  it('pauses an active goal on recovery', async () => {
    const store = memoryStore()
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

  it('settles an expired goal on recovery', async () => {
    const store = memoryStore()
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
      now: () => new Date('2027-01-01T09:00:00.000Z'),
      newId: () => `id-${Math.random().toString(36).slice(2)}`,
    })
    const engine2 = new GoalEngine({
      fabric: fabric2,
      store,
      continuation: continuationStub(),
      principalId: 'owner',
      now: () => new Date('2027-01-01T09:00:00.000Z'),
      newId: () => `id-${Math.random().toString(36).slice(2)}`,
    })
    await engine2.open()
    const projection = engine2.projection()
    expect(projection.goals[0]?.state).toBe('failed')
    await engine2.close()
  })

  it('does not resume a paused goal on recovery', async () => {
    const store = memoryStore()
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
    await engine.pauseGoal(created.goalId!)
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
})

/* ---------------------------------------------------------- no model calls */

describe('zero idle inference', () => {
  it('never calls a model', async () => {
    const { engine } = await openEngine()
    await engine.createGoal({ title: 'Test', description: 'A test goal' })
    const projection = engine.projection()
    expect(projection.goals).toHaveLength(1)
  })

  it('has no provider, gateway, or cognition service', () => {
    const engine = new GoalEngine({
      fabric: null as never,
      store: null as never,
      continuation: null as never,
      principalId: 'owner',
    })
    expect(engine).not.toHaveProperty('gateway')
    expect(engine).not.toHaveProperty('provider')
    expect(engine).not.toHaveProperty('cognition')
  })
})
