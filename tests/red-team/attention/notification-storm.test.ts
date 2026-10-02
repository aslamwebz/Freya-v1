// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import {
  ingest,
  startAttentionCore,
  stopAttentionCore,
  submit,
  type AttentionFixture,
} from './harness'
import { ATTENTION_LIMITS } from '../../../core/attention'

/**
 * NOTIFICATION STORMS.
 *
 * The attack: flood Core with urgent events so that many interrupts escape. The
 * defence is a rolling per-source ingest limit and a code-owned interruption
 * budget across all sources, per source and per goal. A storm should produce a
 * bounded number of expressive outcomes and a great many `do-nothing`s.
 */

const fixtures: AttentionFixture[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await stopAttentionCore(fixture)
})

describe('a storm cannot become a stream of interruptions', () => {
  it('caps interrupts and speaks within the rolling window', async () => {
    const fixture = await startAttentionCore()
    fixtures.push(fixture)
    const urgent = new Date(fixture.clock.now.getTime() + 1_000).toISOString()
    for (let i = 0; i < 40; i += 1) {
      await ingest(fixture, { kind: 'deadline', text: `deadline ${i}`, dueAt: urgent })
    }
    const counts = fixture.core.attention().counts
    expect(counts.interrupted).toBeLessThanOrEqual(ATTENTION_LIMITS.maxInterruptsPerWindow)
    expect(counts.spoke).toBeLessThanOrEqual(ATTENTION_LIMITS.maxSpeaksPerWindowPerSource)
    // Most of a storm is refused or demoted, not escalated.
    expect(counts.doNothing + counts.remembered).toBeGreaterThan(30)
  })

  it('rate-limits a source that floods the ingest window', async () => {
    const fixture = await startAttentionCore()
    fixtures.push(fixture)
    const reminder = 'please look'
    let lastReason = ''
    for (let i = 0; i <= ATTENTION_LIMITS.maxIngestPerWindowPerSource; i += 1) {
      const result = await ingest(fixture, { kind: 'reminder', text: `${reminder} ${i}` })
      lastReason = result.attention?.decision?.reason ?? ''
    }
    expect(lastReason).toBe('rate-limit')
  })

  it('a flood of refused events cannot evict the history that caps interruptions', async () => {
    const fixture = await startAttentionCore()
    fixtures.push(fixture)
    const t0 = fixture.clock.now.getTime()
    await submit(fixture, 'attention.schedule.register', {
      kind: 'reminder',
      text: 'repeating',
      dueAt: new Date(t0).toISOString(),
      intervalMs: 60_000,
      maxRepeats: 8,
    })
    expect(await fixture.core.attentionTick(fixture.clock.now)).toBe(1)
    expect(fixture.core.attention().counts.interrupted).toBe(1)

    // Past the per-source ingest rate every flood event still appends an
    // `attention.decision.made`. If those refusals crowded the bounded decision
    // fold, the first fire's cooldown and per-source budget history would be
    // forgotten inside its own window and the next due fire would interrupt
    // again — so one later tick after a flood larger than the fold must still
    // produce no second interruption.
    for (let i = 0; i < 260; i += 1) {
      await ingest(fixture, { kind: 'reminder', text: `flood ${i}` })
    }
    fixture.clock.now = new Date(t0 + 60_000)
    expect(await fixture.core.attentionTick(fixture.clock.now)).toBe(1)

    const counts = fixture.core.attention().counts
    expect(counts.interrupted).toBeLessThanOrEqual(ATTENTION_LIMITS.maxInterruptsPerWindowPerSource)
  }, 30_000)
})
