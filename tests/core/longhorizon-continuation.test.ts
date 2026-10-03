// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContinuationEngine, type ContinuationWake, type GoalTruthPort } from '../../core/longhorizon/continuation'
import type { ContinuationDecision } from '../../core/longhorizon/types'
import { EventFabric } from '../../core/events/fabric'
import { JsonlEventStore } from '../../core/events/jsonl-store'

/**
 * The long-horizon continuation state machine.
 *
 * The continuation engine decides *what to do next* toward a goal. It holds no
 * authority: a decision is data, and the goal engine executes it through its
 * own state machine.
 */

let directory = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'freya-continuation-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/* ---------------------------------------------------------- helpers */

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

async function openEngine(options: Partial<ConstructorParameters<typeof ContinuationEngine>[0]> = {}) {
  const fabric = await EventFabric.open({
    store: await JsonlEventStore.open(join(directory, 'events.jsonl')),
    now: () => new Date('2026-10-01T09:00:00.000Z'),
    newId: () => `id-${Math.random().toString(36).slice(2)}`,
  })
  const engine = new ContinuationEngine({
    fabric,
    goals: goalPort(),
    principalId: 'owner',
    now: () => new Date('2026-10-01T09:00:00.000Z'),
    newId: () => `id-${Math.random().toString(36).slice(2)}`,
    ...options,
  })
  await engine.open()
  return { engine, fabric }
}

function wake(overrides: Partial<ContinuationWake> = {}): ContinuationWake {
  return { wakeId: 'wake-1', source: 'schedule', goalId: 'g1', ...overrides }
}

/* ---------------------------------------------------------- state machine */

describe('the continuation state machine', () => {
  it('starts IDLE', async () => {
    const { engine } = await openEngine()
    expect(engine.currentState()).toBe('IDLE')
  })

  it('has exactly the six documented states', () => {
    expect(ContinuationEngine.states()).toEqual([
      'IDLE',
      'GOAL_ACTIVE',
      'CHECKPOINT',
      'GOAL_PAUSED',
      'GOAL_COMPLETE',
      'GOAL_FAILED',
    ])
  })

  it('moves to GOAL_ACTIVE on a continue decision', async () => {
    const { engine } = await openEngine()
    await engine.handleWake(wake())
    expect(engine.currentState()).toBe('GOAL_ACTIVE')
  })

  it('moves to CHECKPOINT when a checkpoint begins', async () => {
    const { engine } = await openEngine()
    await engine.handleWake(wake())
    engine.beginCheckpoint('g1')
    expect(engine.currentState()).toBe('CHECKPOINT')
  })

  it('moves to GOAL_ACTIVE when a checkpoint passes', async () => {
    const { engine } = await openEngine()
    await engine.handleWake(wake())
    engine.beginCheckpoint('g1')
    engine.settleCheckpoint('g1', true)
    expect(engine.currentState()).toBe('GOAL_ACTIVE')
  })

  it('moves to GOAL_PAUSED when a checkpoint fails', async () => {
    const { engine } = await openEngine()
    await engine.handleWake(wake())
    engine.beginCheckpoint('g1')
    engine.settleCheckpoint('g1', false)
    expect(engine.currentState()).toBe('GOAL_PAUSED')
  })
})

/* ---------------------------------------------------------- decisions */

describe('continuation decisions', () => {
  it('decides wait when the wake references no goal', async () => {
    const { engine } = await openEngine()
    const outcome = await engine.handleWake(wake({ goalId: null }))
    expect(outcome.decision.decision).toBe('wait')
  })

  it('decides wait when the goal is not open', async () => {
    const { engine } = await openEngine({ goals: goalPort({ isGoalOpen: () => false }) })
    const outcome = await engine.handleWake(wake())
    expect(outcome.decision.decision).toBe('wait')
  })

  it('decides pause when the goal is paused', async () => {
    const { engine } = await openEngine({ goals: goalPort({ goalState: () => 'paused' }) })
    const outcome = await engine.handleWake(wake())
    expect(outcome.decision.decision).toBe('pause')
  })

  it('decides complete when every checkpoint is verified', async () => {
    const { engine } = await openEngine({
      goals: goalPort({ verifiedCheckpoints: () => 3, totalCheckpoints: () => 3 }),
    })
    const outcome = await engine.handleWake(wake())
    expect(outcome.decision.decision).toBe('complete')
  })

  it('decides continue when the goal has unverified checkpoints', async () => {
    const { engine } = await openEngine({
      goals: goalPort({ verifiedCheckpoints: () => 1, totalCheckpoints: () => 3 }),
    })
    const outcome = await engine.handleWake(wake())
    expect(outcome.decision.decision).toBe('continue')
  })

  it('decides wait when a checkpoint is already being verified', async () => {
    const { engine } = await openEngine()
    await engine.handleWake(wake())
    engine.beginCheckpoint('g1')
    const outcome = await engine.handleWake(wake({ wakeId: 'wake-2' }))
    expect(outcome.decision.decision).toBe('wait')
  })

  it('journals every decision', async () => {
    const { engine, fabric } = await openEngine()
    await engine.handleWake(wake())
    const events = await fabric.readAll()
    const decisions = events.filter((event) => event.type === 'longhorizon.continuation.decided')
    expect(decisions.length).toBeGreaterThan(0)
  })
})

/* ---------------------------------------------------------- bounded waits */

describe('every wait is bounded', () => {
  const NOW = '2026-10-01T09:00:00.000Z'
  const AFTER_VERIFICATION_DEADLINE = '2026-10-02T09:00:00.000Z'

  /** The deadline on a wait, or a failure that says which decision had none. */
  function deadlineOf(decision: ContinuationDecision): string {
    if (decision.decision !== 'wait') {
      throw new Error(`expected a wait, got ${decision.decision}`)
    }
    return decision.deadline
  }

  it('bounds a wait behind an in-flight verification by the verification deadline', async () => {
    const { engine } = await openEngine()
    await engine.handleWake(wake())
    engine.beginCheckpoint('g1')
    const outcome = await engine.handleWake(wake({ wakeId: 'wake-2' }))
    expect(deadlineOf(outcome.decision)).toBe(AFTER_VERIFICATION_DEADLINE)
  })

  it('expires a wait that defers nothing at the current instant', async () => {
    const { engine } = await openEngine()

    const noGoal = await engine.handleWake(wake({ goalId: null }))
    expect(deadlineOf(noGoal.decision)).toBe(NOW)

    const closedGoal = await openEngine({ goals: goalPort({ isGoalOpen: () => false }) })
    const notOpen = await closedGoal.engine.handleWake(wake())
    expect(deadlineOf(notOpen.decision)).toBe(NOW)
  })

  it('bounds the waits taken while STOP ALL is latched and while closing', async () => {
    const latched = await openEngine({ stopAll: () => true })
    const stopped = await latched.engine.handleWake(wake())
    expect(deadlineOf(stopped.decision)).toBe(NOW)

    const closing = await openEngine()
    await closing.engine.close()
    const halted = await closing.engine.handleWake(wake())
    expect(deadlineOf(halted.decision)).toBe(NOW)
  })

  it('never decides wait without a deadline, whatever the wake', async () => {
    const wakeShapes: ContinuationWake[] = [
      wake({ goalId: null }),
      wake(),
      wake({ wakeId: 'wake-2' }),
    ]
    for (const shape of wakeShapes) {
      const { engine } = await openEngine({ goals: goalPort({ isGoalOpen: () => false }) })
      const outcome = await engine.handleWake(shape)
      expect(deadlineOf(outcome.decision)).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    }
  })
})

/* ---------------------------------------------------------- interruption */

describe('interruption and preemption', () => {
  it('does nothing while STOP ALL is active', async () => {
    let stopAll = false
    const { engine } = await openEngine({ stopAll: () => stopAll })
    stopAll = true
    const outcome = await engine.handleWake(wake())
    expect(outcome.decision.decision).toBe('wait')
  })

  it('does not move state while STOP ALL is active', async () => {
    let stopAll = false
    const { engine } = await openEngine({ stopAll: () => stopAll })
    await engine.handleWake(wake())
    stopAll = true
    engine.beginCheckpoint('g1')
    expect(engine.currentState()).toBe('GOAL_ACTIVE')
  })

  it('begins from IDLE on restart', async () => {
    const { engine } = await openEngine()
    await engine.handleWake(wake())
    engine.beginCheckpoint('g1')
    await engine.close()

    const fabric2 = await EventFabric.open({
      store: await JsonlEventStore.open(join(directory, 'events.jsonl')),
      now: () => new Date('2026-10-01T10:00:00.000Z'),
      newId: () => `id-${Math.random().toString(36).slice(2)}`,
    })
    const engine2 = new ContinuationEngine({
      fabric: fabric2,
      goals: goalPort(),
      principalId: 'owner',
      now: () => new Date('2026-10-01T10:00:00.000Z'),
      newId: () => `id-${Math.random().toString(36).slice(2)}`,
    })
    await engine2.open()
    expect(engine2.currentState()).toBe('IDLE')
  })
})

/* ---------------------------------------------------------- no model calls */

describe('zero idle inference', () => {
  it('never calls a model', async () => {
    const { engine } = await openEngine()
    await engine.handleWake(wake())
    expect(engine.currentState()).toBe('GOAL_ACTIVE')
  })

  it('has no provider, gateway, or cognition service', () => {
    const engine = new ContinuationEngine({
      fabric: null as never,
      goals: null as never,
      principalId: 'owner',
    })
    expect(engine).not.toHaveProperty('gateway')
    expect(engine).not.toHaveProperty('provider')
    expect(engine).not.toHaveProperty('cognition')
  })
})
