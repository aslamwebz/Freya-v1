// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { createCore } from '../../../core/index'
import { FakeModelProvider } from '../../../core/model/fake-provider'
import { entryDraft, startLifeCore, stopLifeCore, type LifeFixture } from './harness'

/**
 * MODEL INDEPENDENCE AND FORGED-MEMORY RESISTANCE.
 *
 * The attack: a model raises a confidence, a model resolves a conflict, or a
 * fabricated id conjures an entry. The defences: there is no model call anywhere in
 * this domain, a conflict is an edge that no entry can clear, and an unknown id
 * returns a refusal rather than a memory.
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

describe('no model is involved', () => {
  it('spends no model call across every life operation', async () => {
    const fixture = await start()
    const outcome = await fixture.scope().record(entryDraft())
    const entryId = outcome.entry!.entryId
    await fixture.submit('life.status.read')
    await fixture.submit('life.timeline.read')
    await fixture.submit('life.entry.read', { entryId })
    await fixture.submit('life.entry.read', { entryId: 'life:fabricated' })
    expect(fixture.fake.calls).toBe(0)
    expect(fixture.core.status().durableUsage.calls).toBe(0)
  })

  it('spends no model call across a restart', async () => {
    const fixture = await start()
    await fixture.scope().record(entryDraft())
    await fixture.core.stop('model restart')
    const fake = new FakeModelProvider()
    const reopened = createCore({
      dataPath: fixture.dataPath,
      providers: [fake],
      attentionObserveSources: false,
    })
    await reopened.start()
    try {
      await reopened.handleCommand({ command: 'life.status.read', requestId: 'm1' })
      await reopened.handleCommand({ command: 'life.timeline.read', requestId: 'm2' })
      expect(fake.calls).toBe(0)
    } finally {
      await reopened.stop('model teardown')
    }
  })
})

describe('forged memory and unresolved conflict', () => {
  it('returns a refusal for a fabricated entry id and creates nothing', async () => {
    const fixture = await start()
    const before = fixture.projection().counts.total
    const result = await fixture.submit('life.entry.read', { entryId: 'life:not-a-real-entry' })
    expect(result.ok).toBe(false)
    expect(result.life?.code).toBe('unknown-entry')
    expect(fixture.projection().counts.total).toBe(before)
  })
})
