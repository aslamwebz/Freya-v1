// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { startAttentionCore, stopAttentionCore, submit, type AttentionFixture } from './harness'
import { ATTENTION_LIMITS } from '../../../core/attention'

/**
 * SCHEDULER ABUSE.
 *
 * The attack: ask for a schedule that fires every millisecond forever, register
 * thousands of them, or set one so far ahead it becomes an unbounded wake source.
 * The interval is clamped, the repeat count capped, the population bounded, the
 * horizon bounded, and only a due schedule whose condition holds ever fires. The
 * wake makes no model call.
 */

const fixtures: AttentionFixture[] = []
async function start(): Promise<AttentionFixture> {
  const fixture = await startAttentionCore()
  fixtures.push(fixture)
  return fixture
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await stopAttentionCore(fixture)
})

describe('schedules are bounded in every dimension', () => {
  it('clamps a too-short interval and caps the repeat count', async () => {
    const fixture = await start()
    const registered = await submit(fixture, 'attention.schedule.register', {
      kind: 'reminder',
      text: 'forever',
      dueAt: fixture.clock.now.toISOString(),
      intervalMs: 1,
      maxRepeats: 1_000,
    })
    expect(registered.ok).toBe(true)
    const schedule = fixture.core.attention().schedules[0]
    expect(schedule?.intervalMs).toBe(ATTENTION_LIMITS.minScheduleIntervalMs)
    expect(schedule?.maxRepeats).toBe(ATTENTION_LIMITS.maxScheduleRepeats)
  })

  it('refuses a schedule beyond the horizon', async () => {
    const fixture = await start()
    const tooFar = new Date(fixture.clock.now.getTime() + ATTENTION_LIMITS.maxScheduleHorizonMs + 60_000).toISOString()
    const registered = await submit(fixture, 'attention.schedule.register', {
      kind: 'reminder',
      text: 'next year',
      dueAt: tooFar,
    })
    expect(registered.ok).toBe(false)
  })

  it('refuses more schedules than the population ceiling', async () => {
    const fixture = await start()
    let last = true
    for (let i = 0; i <= ATTENTION_LIMITS.maxSchedules; i += 1) {
      const result = await submit(fixture, 'attention.schedule.register', {
        kind: 'reminder',
        text: `n ${i}`,
        dueAt: new Date(fixture.clock.now.getTime() + 60_000).toISOString(),
      })
      last = result.ok
    }
    expect(last).toBe(false)
    expect(fixture.core.attention().schedules).toHaveLength(ATTENTION_LIMITS.maxSchedules)
  })

  it('does not fire a schedule that is not due, and makes no model call', async () => {
    const fixture = await start()
    await submit(fixture, 'attention.schedule.register', {
      kind: 'reminder',
      text: 'later',
      dueAt: new Date(fixture.clock.now.getTime() + 60_000).toISOString(),
    })
    expect(await fixture.core.attentionTick(fixture.clock.now)).toBe(0)
    expect(fixture.fake.calls).toBe(0)
  })

  it('never fires a goal-open schedule with no goal', async () => {
    const fixture = await start()
    await submit(fixture, 'attention.schedule.register', {
      kind: 'reminder',
      text: 'waiting on nothing',
      dueAt: fixture.clock.now.toISOString(),
      condition: 'goal-open',
    })
    expect(await fixture.core.attentionTick(fixture.clock.now)).toBe(0)
  })

  it('settles a one-shot after one fire', async () => {
    const fixture = await start()
    await submit(fixture, 'attention.schedule.register', {
      kind: 'reminder',
      text: 'once',
      dueAt: fixture.clock.now.toISOString(),
    })
    expect(await fixture.core.attentionTick(fixture.clock.now)).toBe(1)
    expect(await fixture.core.attentionTick(fixture.clock.now)).toBe(0)
    expect(fixture.core.attention().schedules[0]?.status).toBe('fired')
  })
})
