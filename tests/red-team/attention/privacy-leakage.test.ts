// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCore, type Core } from '../../../core/index'
import { attentionSource } from '../../../core/testing'
import { FakeModelProvider } from '../../../core/model/fake-provider'
import {
  ATTENTION_SENTINEL,
  ingest,
  journalText,
  startAttentionCore,
  stopAttentionCore,
  submit,
  type AttentionFixture,
} from './harness'

/**
 * PRIVACY LEAKAGE.
 *
 * The attack: put a secret in the event text and find it in the journal, a
 * projection, the activity feed or a status. The text is process-local; the
 * journal carries a measured length, the projection a measured length, and the one
 * way to read it is an explicit per-event owner read. After a restart the text is
 * gone, and Core says so by returning nothing rather than a stale copy.
 */

const fixtures: AttentionFixture[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await stopAttentionCore(fixture)
})

describe('private event text does not leak', () => {
  it('keeps a sentinel out of the journal, projection, activity and status', async () => {
    const fixture = await startAttentionCore()
    fixtures.push(fixture)
    await ingest(fixture, { kind: 'reminder', text: ATTENTION_SENTINEL })
    expect(await journalText(fixture)).not.toContain(ATTENTION_SENTINEL)
    expect(JSON.stringify(fixture.core.attention())).not.toContain(ATTENTION_SENTINEL)
    expect(JSON.stringify(fixture.core.activity())).not.toContain(ATTENTION_SENTINEL)
    expect(JSON.stringify(fixture.core.status())).not.toContain(ATTENTION_SENTINEL)
  })

  it('returns the text only from an explicit per-event read', async () => {
    const fixture = await startAttentionCore()
    fixtures.push(fixture)
    const result = await ingest(fixture, { kind: 'reminder', text: ATTENTION_SENTINEL })
    const eventId = result.attention?.decision?.eventId
    const detail = await submit(fixture, 'attention.inbox.read', { eventId })
    expect(detail.attention?.detail?.text).toBe(ATTENTION_SENTINEL)
  })

  it('does not resurrect retained text after a restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'freya-attention-privacy-'))
    const path = join(dir, 'events.jsonl')
    const first: Core = createCore({ dataPath: path, providers: [new FakeModelProvider()] })
    await first.start()
    const result = await first.handleCommand({
      command: 'attention.event.ingest',
      requestId: 'r1',
      payload: { kind: 'reminder', text: ATTENTION_SENTINEL },
    })
    const eventId = result.attention?.decision?.eventId
    await first.stop('restart')
    const second = createCore({ dataPath: path, providers: [new FakeModelProvider()] })
    await second.start()
    try {
      const detail = await second.handleCommand({
        command: 'attention.inbox.read',
        requestId: 'r2',
        payload: { eventId },
      })
      // The metadata survived; the text did not, and Core refuses rather than
      // inventing an empty one.
      expect(detail.ok).toBe(false)
      expect(second.attention().counts.ingested).toBe(1)
    } finally {
      await second.stop('done')
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not leak a subsystem source’s text either', async () => {
    const fixture = await startAttentionCore()
    fixtures.push(fixture)
    const work = attentionSource(fixture.core, 'work')
    await work.ingestInternal({ kind: 'work-failed', text: ATTENTION_SENTINEL, sourceRef: 'run-x' })
    expect(await journalText(fixture)).not.toContain(ATTENTION_SENTINEL)
  })
})
