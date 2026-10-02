// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { ingest, startAttentionCore, stopAttentionCore, submit, type AttentionFixture } from './harness'

/**
 * STOP ALL.
 *
 * The attack: route around the panic button by having attention decide, speak or
 * interrupt while Freya is stopped, or by having an attention command clear the
 * latch. Attention reads STOP ALL fresh at each decision and returns `do-nothing`
 * with reason `stop-all`; no attention command touches the latch.
 */

const fixtures: AttentionFixture[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await stopAttentionCore(fixture)
})

describe('attention is below STOP ALL', () => {
  it('returns do-nothing with reason stop-all for an urgent event', async () => {
    const fixture = await startAttentionCore()
    fixtures.push(fixture)
    await submit(fixture, 'security.stopAll', { reason: 'red team' })
    const result = await ingest(fixture, {
      kind: 'deadline',
      text: 'due now',
      dueAt: fixture.clock.now.toISOString(),
      severityHint: 'high',
    })
    expect(result.attention?.decision?.outcome).toBe('do-nothing')
    expect(result.attention?.decision?.reason).toBe('stop-all')
  })

  it('cannot clear the latch through any attention command', async () => {
    const fixture = await startAttentionCore()
    fixtures.push(fixture)
    await submit(fixture, 'security.stopAll', { reason: 'red team' })
    await ingest(fixture, { kind: 'reminder', text: 'please' })
    await submit(fixture, 'attention.schedule.register', {
      kind: 'reminder',
      text: 's',
      dueAt: fixture.clock.now.toISOString(),
    })
    await fixture.core.attentionTick(fixture.clock.now)
    // The latch is untouched: no attention command clears it.
    expect(fixture.core.status().stopAll.active).toBe(true)
    expect(fixture.core.status().governor.status).toBe('deny_all')
  })

  it('resumes expressive outcomes only after the owner clears the latch', async () => {
    const fixture = await startAttentionCore()
    fixtures.push(fixture)
    await submit(fixture, 'security.stopAll', { reason: 'red team' })
    await submit(fixture, 'security.resume', {})
    const result = await ingest(fixture, {
      kind: 'deadline',
      text: 'due now',
      dueAt: fixture.clock.now.toISOString(),
    })
    expect(result.attention?.decision?.outcome).toBe('interrupt')
  })
})
