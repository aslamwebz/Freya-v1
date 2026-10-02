// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { ingest, startAttentionCore, stopAttentionCore, type AttentionFixture } from './harness'
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
})
