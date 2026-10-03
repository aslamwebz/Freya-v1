// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { entryDraft, startLifeCore, stopLifeCore, type LifeFixture } from './harness'

/**
 * STOP ALL OUTRANKS ENRICHMENT, NOT READS.
 *
 * The attack: a window reads Freya's autobiography after the panic button, or
 * expects the layer to keep consolidating while stopped. The policy: reads remain
 * available (knowing what Freya remembers is the owner's own business), and
 * enrichment — derivation and consolidation — stops.
 */

const fixtures: LifeFixture[] = []
async function start(): Promise<LifeFixture> {
  const fixture = await startLifeCore()
  fixtures.push(fixture)
  return fixture
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await stopLifeCore(fixture)
})

describe('stop all', () => {
  it('keeps reads available and stops new enrichment while latched', async () => {
    const fixture = await start()
    const outcome = await fixture.scope().record(entryDraft())
    const entryId = outcome.entry!.entryId
    await fixture.submit('security.stopAll', { reason: 'red-team' })

    const status = await fixture.submit('life.status.read')
    expect(status.ok).toBe(true)
    expect(status.life?.projection?.counts.total).toBe(1)

    const timeline = await fixture.submit('life.timeline.read')
    expect(timeline.ok).toBe(true)

    const read = await fixture.submit('life.entry.read', { entryId })
    expect(read.ok).toBe(true)
    expect(read.life?.entry?.body).toContain('FREYA_RED_TEAM')

    expect(fixture.projection().counts.total).toBe(1)
  })

  it('resumes reads without clearing the stop through a life command', async () => {
    const fixture = await start()
    await fixture.submit('security.stopAll', { reason: 'red-team' })
    const attempt = await fixture.submit('life.timeline.read')
    expect(attempt.ok).toBe(true)
    expect(fixture.core.status().stopAll.active).toBe(true)
    await fixture.submit('security.resume', {})
    expect(fixture.core.status().stopAll.active).toBe(false)
  })
})
