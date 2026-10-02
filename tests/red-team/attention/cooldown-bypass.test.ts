// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { sourceScope, startAttentionCore, stopAttentionCore, type AttentionFixture } from './harness'
import { outcomeRank } from '../../../core/attention'

/**
 * COOLDOWN BYPASS.
 *
 * The attack: after an interruption, immediately send an "urgent" event and hope
 * the cooldown is skipped because of the urgency. The cooldown is absolute: an
 * urgent event during it is still remembered, never allowed to shout again.
 */

const fixtures: AttentionFixture[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await stopAttentionCore(fixture)
})

describe('an interruption cooldown cannot be jumped', () => {
  it('demotes a second urgent event from the same source to a memory', async () => {
    const fixture = await startAttentionCore()
    fixtures.push(fixture)
    const work = sourceScope(fixture, 'work')
    const urgent = new Date(fixture.clock.now.getTime() + 1_000).toISOString()

    const first = await work.ingestInternal({ kind: 'work-failed', text: 'first', dueAt: urgent, sourceRef: 'r1' })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.decision.outcome).toBe('interrupt')

    const second = await work.ingestInternal({
      kind: 'work-failed',
      text: 'second',
      dueAt: urgent,
      severityHint: 'high',
      sourceRef: 'r2',
    })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.decision.reason).toBe('cooldown')
    expect(outcomeRank(second.decision.outcome)).toBeLessThanOrEqual(outcomeRank('remember'))
  })

  it('does not apply one source’s cooldown to another', async () => {
    const fixture = await startAttentionCore()
    fixtures.push(fixture)
    const work = sourceScope(fixture, 'work')
    const mission = sourceScope(fixture, 'mission')
    const urgent = new Date(fixture.clock.now.getTime() + 1_000).toISOString()

    await work.ingestInternal({ kind: 'work-failed', text: 'first', dueAt: urgent, sourceRef: 'r1' })
    const other = await mission.ingestInternal({
      kind: 'mission-failed',
      text: 'other source',
      dueAt: urgent,
      sourceRef: 'm1',
    })
    expect(other.ok).toBe(true)
    if (!other.ok) return
    // A different source is governed by the global budget, not this source's cooldown.
    expect(other.decision.reason).not.toBe('cooldown')
  })
})
