// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { createCore } from '../../../core/index'
import { FakeModelProvider } from '../../../core/model/fake-provider'
import { StaticVaultKeyProvider } from '../../../core/vault'
import { testVaultKey } from '../../core/testKey'
import { bindingAvailable, loadTestBinding } from '../../core/vault/binding'
import {
  expectNoSentinels,
  journalEvents,
  journalLines,
  RED_TEAM_SENTINELS,
} from '../harness'
import { entryDraft, startLifeCore, stopLifeCore, type LifeFixture } from './harness'

/**
 * PRIVATE DATA DOES NOT REACH A BROAD SINK.
 *
 * The sentinel lives in an entry's body and in a Brain memory. It must never appear
 * in the Life projection, the timeline, the activity feed, the journal or the status;
 * it may appear only in the explicit single-entry read.
 */

const SENTINEL = RED_TEAM_SENTINELS[0]

const fixtures: LifeFixture[] = []
async function start(options: { vault?: boolean } = {}): Promise<LifeFixture> {
  const fixture = await startLifeCore(options)
  fixtures.push(fixture)
  return fixture
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await stopLifeCore(fixture)
})

describe('life history keeps private text out of broad sinks', () => {
  it('does not leak an entry body into projection, timeline, activity, status or journal', async () => {
    const fixture = await start()
    const outcome = await fixture.scope().record(entryDraft())
    const entryId = outcome.entry!.entryId

    const projection = fixture.projection()
    expectNoSentinels('life projection', projection)
    expect(projection.recent[0]!.bodyLength).toBe(SENTINEL.length)

    const timeline = await fixture.submit('life.timeline.read')
    expectNoSentinels('life timeline', timeline)
    expectNoSentinels('core status', fixture.core.status())
    expectNoSentinels('activity feed', fixture.core.activity())
    expectNoSentinels('journal events', await journalEvents(fixture))
    expectNoSentinels('journal raw', await journalLines(fixture))

    const read = await fixture.submit('life.entry.read', { entryId })
    expect(read.life?.entry?.body).toBe(SENTINEL)
  })

  it('does not copy a Brain memory body into the Life layer', async () => {
    const fixture = await start()
    await fixture.submit('brain.memory.write', {
      content: `a private fact ${SENTINEL}`,
      subject: 'a private subject',
      kind: 'autobiographical',
    })
    expectNoSentinels('life projection after a Brain write', fixture.projection())
    const timeline = await fixture.submit('life.timeline.read')
    expectNoSentinels('life timeline after a Brain write', timeline)
    expectNoSentinels('activity feed after a Brain write', fixture.core.activity())
  })

  it.skipIf(!bindingAvailable)('keeps the sentinel out of broad sinks after a restart on the same journal', async () => {
    const fixture = await start({ vault: true })
    const outcome = await fixture.scope().record(entryDraft())
    const entryId = outcome.entry!.entryId
    await fixture.core.stop('privacy restart')

    const reopened = createCore({
      dataPath: fixture.dataPath,
      providers: [new FakeModelProvider()],
      attentionObserveSources: false,
      ...(fixture.vaultPath && bindingAvailable
        ? { vault: { path: fixture.vaultPath, keyProvider: new StaticVaultKeyProvider(testVaultKey()), binding: await loadTestBinding() } }
        : {}),
    })
    await reopened.start()
    try {
      expectNoSentinels('reopened life projection', reopened.life())
      const timeline = await reopened.handleCommand({ command: 'life.timeline.read', requestId: 'rt' })
      expectNoSentinels('reopened life timeline', timeline)
      expectNoSentinels('reopened journal', await journalLines(fixture))
      const read = await reopened.handleCommand({
        command: 'life.entry.read',
        requestId: 'rr',
        payload: { entryId },
      })
      expect(read.life?.entry?.body).toBe(SENTINEL)
    } finally {
      await reopened.stop('privacy teardown')
    }
  })
})
