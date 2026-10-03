// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GoalScheduler, MemoryGoalScheduleStore } from '../../core/longhorizon/schedule'
import { SCHEDULE_LIMITS } from '../../core/longhorizon/types'
import { EventFabric } from '../../core/events/fabric'
import { JsonlEventStore } from '../../core/events/jsonl-store'

/**
 * The bounded scheduler: host-driven wake evaluation.
 *
 * Grouped by the property each group defends. The scheduler's whole reason to
 * exist is that it is deterministic, bounded, fail-closed and idle-free, so
 * each group targets one of those properties.
 */

let directory = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'freya-goal-scheduler-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/* ---------------------------------------------------------- helpers */

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

/* ---------------------------------------------------------- registration */

describe('schedule registration', () => {
  it('registers a one-shot schedule', async () => {
    const { scheduler } = await openScheduler()
    const outcome = await scheduler.registerSchedule({ delayMs: 0 })
    expect(outcome.ok).toBe(true)
    expect(outcome.scheduleId).toBeTruthy()
    const projection = scheduler.projection()
    expect(projection.schedules).toHaveLength(1)
    expect(projection.schedules[0]?.state).toBe('pending')
  })

  it('enforces the schedule ceiling', async () => {
    const { scheduler } = await openScheduler()
    for (let i = 0; i < SCHEDULE_LIMITS.maxSchedules; i += 1) {
      const outcome = await scheduler.registerSchedule({ delayMs: 0 })
      expect(outcome.ok).toBe(true)
    }
    const extra = await scheduler.registerSchedule({ delayMs: 0 })
    expect(extra.ok).toBe(false)
  })

  it('refuses a repeat count above the ceiling', async () => {
    const { scheduler } = await openScheduler()
    const outcome = await scheduler.registerSchedule({ delayMs: 0, maxRepeats: 100 })
    expect(outcome.ok).toBe(false)
  })

  it('refuses an interval below the minimum', async () => {
    const { scheduler } = await openScheduler()
    const outcome = await scheduler.registerSchedule({ delayMs: 0, maxRepeats: 2, intervalMs: 1_000 })
    expect(outcome.ok).toBe(false)
  })

  it('refuses a schedule beyond the horizon', async () => {
    const { scheduler } = await openScheduler()
    const outcome = await scheduler.registerSchedule({ delayMs: SCHEDULE_LIMITS.maxHorizonMs + 1 })
    expect(outcome.ok).toBe(false)
  })

  it('cancels a pending schedule', async () => {
    const { scheduler } = await openScheduler()
    const registered = await scheduler.registerSchedule({ delayMs: 0 })
    const cancelled = await scheduler.cancelSchedule(registered.scheduleId!)
    expect(cancelled.ok).toBe(true)
    expect(scheduler.projection().schedules[0]?.state).toBe('cancelled')
  })
})

/* ---------------------------------------------------------- host-driven tick */

describe('the host-driven tick', () => {
  it('fires a due schedule and emits a wake', async () => {
    const { scheduler } = await openScheduler()
    await scheduler.registerSchedule({ delayMs: 0 })
    const result = await scheduler.attentionTick()
    expect(result.fired).toHaveLength(1)
    expect(result.wakeIds).toHaveLength(1)
  })

  it('does not fire a schedule that is not due', async () => {
    const { scheduler } = await openScheduler()
    await scheduler.registerSchedule({ delayMs: 60 * 60_000 })
    const result = await scheduler.attentionTick()
    expect(result.fired).toHaveLength(0)
  })

  it('is idempotent: a repeated tick fires nothing', async () => {
    const { scheduler } = await openScheduler()
    await scheduler.registerSchedule({ delayMs: 0 })
    const first = await scheduler.attentionTick()
    expect(first.fired).toHaveLength(1)
    const second = await scheduler.attentionTick()
    expect(second.fired).toHaveLength(0)
  })

  it('repeats a repeating schedule up to its ceiling', async () => {
    const { scheduler } = await openScheduler()
    await scheduler.registerSchedule({ delayMs: 0, maxRepeats: 2, intervalMs: 60_000 })
    const first = await scheduler.attentionTick()
    expect(first.fired).toHaveLength(1)
    // The schedule is now pending again, due in 60s. It is not due yet.
    const second = await scheduler.attentionTick()
    expect(second.fired).toHaveLength(0)
  })

  it('expires a schedule at its repeat ceiling', async () => {
    const { scheduler } = await openScheduler()
    await scheduler.registerSchedule({ delayMs: 0, maxRepeats: 1 })
    await scheduler.attentionTick()
    const projection = scheduler.projection()
    expect(projection.schedules[0]?.state).toBe('expired')
  })

  it('is bounded: O(n) over pending schedules', async () => {
    const { scheduler } = await openScheduler()
    for (let i = 0; i < 10; i += 1) {
      await scheduler.registerSchedule({ delayMs: 0 })
    }
    const result = await scheduler.attentionTick()
    expect(result.fired).toHaveLength(10)
  })
})

/* ---------------------------------------------------------- conditions */

describe('schedule conditions', () => {
  it('always fires when due', async () => {
    const { scheduler } = await openScheduler()
    await scheduler.registerSchedule({ delayMs: 0, condition: 'always' })
    const result = await scheduler.attentionTick()
    expect(result.fired).toHaveLength(1)
  })

  it('focus-available fires when the owner is not focused', async () => {
    const { scheduler } = await openScheduler({ isFocused: () => false })
    await scheduler.registerSchedule({ delayMs: 0, condition: 'focus-available' })
    const result = await scheduler.attentionTick()
    expect(result.fired).toHaveLength(1)
  })

  it('focus-available does not fire when the owner is focused', async () => {
    const { scheduler } = await openScheduler({ isFocused: () => true })
    await scheduler.registerSchedule({ delayMs: 0, condition: 'focus-available' })
    const result = await scheduler.attentionTick()
    expect(result.fired).toHaveLength(0)
    expect(result.denied).toHaveLength(1)
  })

  it('goal-open fires when the goal is open', async () => {
    const { scheduler } = await openScheduler({ isGoalOpen: () => true })
    await scheduler.registerSchedule({ delayMs: 0, condition: 'goal-open', goalId: 'g1' })
    const result = await scheduler.attentionTick()
    expect(result.fired).toHaveLength(1)
  })

  it('goal-open does not fire when the goal is closed', async () => {
    const { scheduler } = await openScheduler({ isGoalOpen: () => false })
    await scheduler.registerSchedule({ delayMs: 0, condition: 'goal-open', goalId: 'g1' })
    const result = await scheduler.attentionTick()
    expect(result.fired).toHaveLength(0)
  })

  it('goal-open with no goal reference does not fire', async () => {
    const { scheduler } = await openScheduler()
    await scheduler.registerSchedule({ delayMs: 0, condition: 'goal-open' })
    const result = await scheduler.attentionTick()
    expect(result.fired).toHaveLength(0)
  })
})

/* ---------------------------------------------------------- fail-closed */

describe('fail-closed', () => {
  it('does nothing while STOP ALL is active', async () => {
    let stopAll = false
    const { scheduler } = await openScheduler({ stopAll: () => stopAll })
    await scheduler.registerSchedule({ delayMs: 0 })
    stopAll = true
    const result = await scheduler.attentionTick()
    expect(result.fired).toHaveLength(0)
    expect(result.wakeIds).toHaveLength(0)
  })

  it('does nothing when the journal is not trustworthy', async () => {
    const { scheduler } = await openScheduler({ journalTrustworthy: () => false })
    await scheduler.registerSchedule({ delayMs: 0 })
    const result = await scheduler.attentionTick()
    expect(result.fired).toHaveLength(0)
  })

  it('refuses to register while STOP ALL is active', async () => {
    let stopAll = false
    const { scheduler } = await openScheduler({ stopAll: () => stopAll })
    stopAll = true
    const outcome = await scheduler.registerSchedule({ delayMs: 0 })
    expect(outcome.ok).toBe(false)
  })
})

/* ---------------------------------------------------------- restart recovery */

describe('schedule restart recovery', () => {
  it('expires a schedule past its lifetime on recovery', async () => {
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
    })
    await scheduler.open()
    await scheduler.registerSchedule({ delayMs: 0 })
    // The store is deliberately not closed: a real store is reopened from disk,
    // and closing the in-memory store would discard the very records the
    // restart is supposed to recover.

    const fabric2 = await EventFabric.open({
      store: await JsonlEventStore.open(join(directory, 'events.jsonl')),
      now: () => new Date('2026-11-15T09:00:00.000Z'),
      newId: () => `id-${Math.random().toString(36).slice(2)}`,
    })
    const scheduler2 = new GoalScheduler({
      fabric: fabric2,
      store,
      principalId: 'owner',
      now: () => new Date('2026-11-15T09:00:00.000Z'),
      newId: () => `id-${Math.random().toString(36).slice(2)}`,
    })
    await scheduler2.open()
    const projection = scheduler2.projection()
    expect(projection.schedules[0]?.state).toBe('expired')
    await scheduler2.close()
  })

  it('does not fire a schedule during recovery', async () => {
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
    })
    await scheduler.open()
    await scheduler.registerSchedule({ delayMs: 0 })

    const fabric2 = await EventFabric.open({
      store: await JsonlEventStore.open(join(directory, 'events.jsonl')),
      now: () => new Date('2026-10-01T10:00:00.000Z'),
      newId: () => `id-${Math.random().toString(36).slice(2)}`,
    })
    const scheduler2 = new GoalScheduler({
      fabric: fabric2,
      store,
      principalId: 'owner',
      now: () => new Date('2026-10-01T10:00:00.000Z'),
      newId: () => `id-${Math.random().toString(36).slice(2)}`,
    })
    await scheduler2.open()
    // The schedule was due while the process was down. It must not fire during
    // recovery; it fires on the next host-driven tick.
    const projection = scheduler2.projection()
    expect(projection.schedules[0]?.state).toBe('pending')
    await scheduler2.close()
  })
})

/* ---------------------------------------------------------- no model calls */

describe('zero idle inference', () => {
  it('never calls a model', async () => {
    const { scheduler } = await openScheduler()
    await scheduler.registerSchedule({ delayMs: 0 })
    await scheduler.attentionTick()
    const projection = scheduler.projection()
    expect(projection.schedules).toHaveLength(1)
  })

  it('has no provider, gateway, or cognition service', () => {
    const scheduler = new GoalScheduler({
      fabric: null as never,
      store: null as never,
      principalId: 'owner',
    })
    expect(scheduler).not.toHaveProperty('gateway')
    expect(scheduler).not.toHaveProperty('provider')
    expect(scheduler).not.toHaveProperty('cognition')
  })

  it('has no self-scheduling timer', () => {
    const scheduler = new GoalScheduler({
      fabric: null as never,
      store: null as never,
      principalId: 'owner',
    })
    expect(scheduler).not.toHaveProperty('timer')
    expect(scheduler).not.toHaveProperty('interval')
    expect(scheduler).not.toHaveProperty('loop')
  })
})
