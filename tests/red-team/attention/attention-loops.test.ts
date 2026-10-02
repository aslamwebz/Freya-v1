// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { ingest, journalText, startAttentionCore, stopAttentionCore, type AttentionFixture } from './harness'

/**
 * ATTENTION LOOPS.
 *
 * The attack: make an attention decision itself an attention event, so evaluating
 * one produces another and the system feeds on itself. Ingestion is explicit —
 * only an authorized source scope or the owner command can produce an event, and
 * the internal wiring reacts only to Work/Mission/Research terminal events, never
 * to `attention.*`. So N ingests produce exactly N ingest lines.
 */

const fixtures: AttentionFixture[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await stopAttentionCore(fixture)
})

describe('attention does not feed itself', () => {
  it('produces exactly one ingest line per accepted event', async () => {
    const fixture = await startAttentionCore()
    fixtures.push(fixture)
    const total = 12
    for (let i = 0; i < total; i += 1) {
      await ingest(fixture, { kind: 'reminder', text: `n ${i}` })
    }
    const raw = await journalText(fixture)
    const ingestLines = raw.split('\n').filter((line) => line.includes('"attention.event.ingested"')).length
    expect(ingestLines).toBe(total)
  })

  it('does not chain attention events through causation', async () => {
    const fixture = await startAttentionCore()
    fixtures.push(fixture)
    for (let i = 0; i < 6; i += 1) {
      await ingest(fixture, { kind: 'message', text: `m ${i}` })
    }
    const raw = await journalText(fixture)
    const attention = raw
      .split('\n')
      .filter((line) => line.includes('"type":"attention.'))
      .map((line) => JSON.parse(line) as { eventId: string; causationId: string | null })
    const ids = new Set(attention.map((event) => event.eventId))
    for (const event of attention) {
      expect(event.causationId === null || !ids.has(event.causationId)).toBe(true)
    }
  })
})
