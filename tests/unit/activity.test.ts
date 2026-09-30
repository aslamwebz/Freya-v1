import { describe, expect, it } from 'vitest'
import { describeActivity, mergeActivity, type CoreActivityEvent } from '../../core/protocol/activity'
import type { AnyCoreEvent } from '../../core/events/envelope'

/**
 * Activity: what a window may know about the journal.
 *
 * The renderer is not trusted with the event fabric. It gets rows, and a row has
 * no payload field. These tests hold that line, because the failure it prevents
 * is quiet: a command, a prompt or a model response would appear in a window
 * with nothing marking it as sensitive.
 */

const AT = 1_800_000_000_000

function event(type: AnyCoreEvent['type'], payload: Record<string, unknown>, sequence = 4): Parameters<typeof describeActivity>[0] {
  return { type, sequence, at: AT, payload }
}

describe('command text never reaches the feed', () => {
  it('reports a command as a length and nothing else', () => {
    const row = describeActivity(
      event('command.received', {
        commandId: 'c-9',
        contentLength: 42,
        source: 'command-bar',
      }),
    )
    expect(row?.kind).toBe('command.received')
    expect(row?.text).toBe('Command received (42 characters). Recorded, not yet acted on.')
    expect(row?.text).not.toMatch(/c-9/)
    expect(row?.text).not.toMatch(/command-bar/)
  })

  it('cannot leak text through any field it is given', () => {
    // Even a hostile payload that puts text where a number belongs must not end
    // up in the row, because the row is built from named fields only.
    const row = describeActivity(
      event('command.received', {
        commandId: 'the actual secret prompt',
        contentLength: 7,
        source: 'the actual secret source',
        extra: 'the actual secret extra',
      }),
    )
    expect(row?.text).toBe('Command received (7 characters). Recorded, not yet acted on.')
    expect(JSON.stringify(row)).not.toMatch(/secret/)
  })

  it('survives a malformed content length without inventing one', () => {
    const row = describeActivity(event('command.received', { contentLength: 'many' }))
    expect(row?.text).toMatch(/empty/i)
  })
})

describe('mapping real events', () => {
  it('maps the lifecycle', () => {
    expect(describeActivity(event('core.started', {}))?.kind).toBe('core.started')
    expect(describeActivity(event('core.ready', {}))?.tone).toBe('good')
    expect(describeActivity(event('core.degraded', { reason: 'journal corrupt' }))?.tone).toBe('bad')
  })

  it('makes an integrity fault impossible to scroll past', () => {
    const row = describeActivity(
      event('core.integrity_fault', { reason: 'corrupt', line: 3, quarantinePath: '/tmp/q' }),
    )
    expect(row?.kind).toBe('integrity.fault')
    expect(row?.tone).toBe('bad')
    expect(row?.text).toContain('line 3')
  })

  it('maps both STOP ALL directions', () => {
    expect(describeActivity(event('security.stop_all.activated', { by: 'owner', reason: 'test' }))?.tone).toBe('bad')
    expect(describeActivity(event('security.stop_all.cleared', { by: 'owner' }))?.tone).toBe('good')
  })

  it('does not make an explicit user turn look like an ungranted problem', () => {
    const row = describeActivity(event('cognition.allowed', { requestId: 'r1', grantId: null }))
    expect(row?.text).toMatch(/explicit user turn/i)
    expect(row?.text).not.toMatch(/no grant/i)
  })

  it('shows the refusal reason when cognition is denied', () => {
    const row = describeActivity(event('cognition.denied', { requestId: 'r1', reason: 'journal-not-trustworthy', grantId: null }))
    expect(row?.tone).toBe('bad')
    expect(row?.text).toContain('journal-not-trustworthy')
  })

  it('tracks the provider lifecycle so a failure is visible', () => {
    expect(describeActivity(event('model.request.started', { model: 'gpt' }))?.kind).toBe('provider.started')
    expect(describeActivity(event('model.request.completed', { model: 'gpt' }))?.tone).toBe('good')
    expect(describeActivity(event('model.request.failed', { reason: 'timeout' }))?.tone).toBe('bad')
  })

  it('keeps an unrecognised event visible rather than silently dropping it', () => {
    const row = describeActivity(event('core.stopped', { durationMs: 12 }))
    expect(row?.kind).toBe('other')
    expect(row?.text).toBe('core.stopped')
  })

  it('is stable: the same event always produces the same id', () => {
    const a = describeActivity(event('core.ready', {}, 7))
    const b = describeActivity(event('core.ready', {}, 7))
    expect(a?.id).toBe(b?.id)
    expect(a?.id).toBe('core.ready:7')
  })
})

describe('merging', () => {
  it('sorts by sequence rather than by arrival', () => {
    const first = describeActivity(event('core.started', {}, 1))
    const second = describeActivity(event('core.ready', {}, 2))
    expect(mergeActivity([second!], [first!]).map((r) => r.sequence)).toEqual([1, 2])
  })

  it('drops a replayed overlap instead of showing it twice', () => {
    const ready = describeActivity(event('core.ready', {}, 2))!
    const merged = mergeActivity([ready], [ready])
    expect(merged).toHaveLength(1)
  })

  it('returns the same array when there is nothing to add', () => {
    const rows = [describeActivity(event('core.ready', {}, 2))!]
    expect(mergeActivity(rows, [])).toBe(rows)
  })

  it('caps the feed', () => {
    let rows: CoreActivityEvent[] = []
    for (let n = 1; n <= 90; n += 1) {
      const row = describeActivity(event('core.ready', {}, n))
      if (row !== null) rows = mergeActivity(rows, [row])
    }
    expect(rows.length).toBeLessThanOrEqual(60)
    // Keeps the newest, because the old end of a long session is not news.
    expect(rows[rows.length - 1]?.sequence).toBe(90)
  })
})
