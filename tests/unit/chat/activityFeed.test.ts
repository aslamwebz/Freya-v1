import { describe, expect, it } from 'vitest'
import { projectActivityRail } from '../../../src/app/chat/ActivityFeed'
import type { CoreActivityEvent } from '../../../core/protocol/activity'

/**
 * The Activity rail is the one place a window may show machine-derived status
 * during a turn. The projector is the load-bearing half of the contract:
 *
 *   - it must drop events Core did not classify for the rail (`conversation.turn.*`
 *     belong on the turn itself, not on the rail);
 *   - it must respect the time window so a stale row from a previous turn cannot
 *     appear under the next;
 *   - it must cap the row count and report the truncation, so a long turn does
 *     not overflow the rail silently;
 *   - it must order newest-first — Core writes events in sequence, but the rail
 *     reads from top to bottom, and the newest event is the one the user wants.
 */

function event(partial: Partial<CoreActivityEvent> & { kind: CoreActivityEvent['kind']; at: number; id: string; tone?: CoreActivityEvent['tone']; sequence?: number; text?: string; type?: CoreActivityEvent['type'] }): CoreActivityEvent {
  return {
    id: partial.id,
    kind: partial.kind,
    type: partial.type ?? 'core.started',
    sequence: partial.sequence ?? 0,
    at: partial.at,
    text: partial.text ?? `${partial.kind} did a thing.`,
    tone: partial.tone ?? 'neutral',
  }
}

describe('Activity rail projector', () => {
  const NOW = 1_700_000_000_000
  const WINDOW = 60_000

  it('keeps only kinds that have been declared for the rail', () => {
    const rows = [
      event({ id: '1', kind: 'provider.started', at: NOW - 1_000, text: 'started' }),
      // `conversation.turn.completed` belongs on the turn itself, not the rail.
      event({ id: '2', kind: 'conversation.turn.completed', at: NOW - 500, text: 'finished' }),
      event({ id: '3', kind: 'mission.completed', at: NOW - 200, text: 'done' }),
    ]
    const { rows: visible } = projectActivityRail(rows, NOW, WINDOW, 6)
    const kinds = visible.map((r) => r.kind)
    expect(kinds).toContain('provider.started')
    expect(kinds).toContain('mission.completed')
    expect(kinds).not.toContain('conversation.turn.completed')
  })

  it('drops rows older than the time window', () => {
    const rows = [
      event({ id: 'old', kind: 'provider.started', at: NOW - 120_000, text: 'too old' }),
      event({ id: 'new', kind: 'provider.started', at: NOW - 5_000, text: 'recent' }),
    ]
    const { rows: visible } = projectActivityRail(rows, NOW, WINDOW, 6)
    expect(visible.map((r) => r.id)).toEqual(['new'])
  })

  it('orders newest first so the rail reads top-down by recency', () => {
    const rows = [
      event({ id: 'a', kind: 'provider.started', at: NOW - 5_000 }),
      event({ id: 'b', kind: 'provider.completed', at: NOW - 1_000 }),
      event({ id: 'c', kind: 'provider.failed', at: NOW - 3_000 }),
    ]
    const { rows: visible } = projectActivityRail(rows, NOW, WINDOW, 6)
    expect(visible.map((r) => r.id)).toEqual(['b', 'c', 'a'])
  })

  it('caps at maxRows and reports the truncation honestly', () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      event({ id: String(i), kind: 'provider.started', at: NOW - i * 1_000 }),
    )
    const { rows: visible, hidden } = projectActivityRail(rows, NOW, WINDOW, 4)
    expect(visible).toHaveLength(4)
    expect(hidden).toBe(6)
  })

  it('never invents text. The row text is whatever Core wrote, unchanged.', () => {
    const rows = [
      event({ id: 'x', kind: 'provider.completed', at: NOW - 1_000, text: 'Model request completed (gpt-x).' }),
    ]
    const { rows: visible } = projectActivityRail(rows, NOW, WINDOW, 6)
    const rendered = visible[0]?.text ?? ''
    expect(rendered).toBe('Model request completed (gpt-x).')
    // A renderer that faked model-authored status would replace this with
    // "Freya is thinking". The contract says: the row text is Core's word.
    expect(rendered).not.toMatch(/thinking/i)
  })

  it('renders nothing when there are no eligible rows', () => {
    const { rows, hidden } = projectActivityRail([], NOW, WINDOW, 6)
    expect(rows).toHaveLength(0)
    expect(hidden).toBe(0)
  })
})