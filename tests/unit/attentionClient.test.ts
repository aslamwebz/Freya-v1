import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ABSENT_ATTENTION_PROJECTION,
  type AttentionProjection,
} from '../../core/protocol/attention'
import { initialAttentionState, projectAttention } from '../../core/attention'
import {
  attentionMirror,
  createAttentionMirror,
  resetAttentionMirror,
} from '../../src/platform/attentionClient'

/**
 * The renderer's Attention mirror.
 *
 * The boundary properties are the point:
 *
 *  1. It holds what Core pushed and cannot write any of it.
 *  2. Its one read takes **no arguments** — there is no parameter in which a
 *     source, an importance or an outcome could travel.
 *  3. It exposes no method that decides, spends a budget, bypasses a cooldown or
 *     drives the scheduler, so a caller asking for one gets a missing method
 *     rather than a refusal it could learn to phrase differently.
 *  4. Its ingest/schedule calls send only the named fields, never a source.
 */

function projection(sequence = 0): AttentionProjection {
  return {
    ...projectAttention({
      sequence,
      state: initialAttentionState(),
      focus: 'available',
      directive: null,
      inbox: [],
    }),
  }
}

let coreSubmit: ReturnType<typeof vi.fn>
let coreAttention: ReturnType<typeof vi.fn>
let handlers: Set<(projection: AttentionProjection) => void>

function push(next: AttentionProjection): void {
  for (const handler of [...handlers]) handler(next)
}

beforeEach(() => {
  resetAttentionMirror()
  handlers = new Set()
  coreSubmit = vi.fn(async () => ({ requestId: 'r1', ok: true, attention: { operation: 'ingested', ok: true } }))
  coreAttention = vi.fn(async () => projection())
  window.freyaHost = {
    isDesktop: true,
    coreSubmit: coreSubmit as never,
    coreAttention: coreAttention as never,
    onCoreAttention: ((next: (p: AttentionProjection) => void) => {
      handlers.add(next)
      return () => {
        handlers.delete(next)
      }
    }) as never,
  } as never
})

afterEach(() => {
  resetAttentionMirror()
  delete window.freyaHost
})

describe('a mirror that holds only what Core sent', () => {
  it('is absent before anything has reported', () => {
    const mirror = createAttentionMirror()
    expect(mirror.projection).toBeNull()
  })

  it('reads once and then follows pushes', async () => {
    const mirror = createAttentionMirror()
    await mirror.attach()
    expect(coreAttention).toHaveBeenCalledTimes(1)
    expect(mirror.projection?.health).toBe('ready')
    push({ ...projection(5), focus: 'focused' })
    expect(mirror.projection?.focus).toBe('focused')
  })

  it('publishes Core’s absent projection when the host has no Core yet', async () => {
    coreAttention.mockImplementation(async () => null)
    const mirror = createAttentionMirror()
    await mirror.attach()
    expect(mirror.projection?.health).toBe('unavailable')
    expect(mirror.projection?.reason).toBe(ABSENT_ATTENTION_PROJECTION.reason)
  })

  it('does not let a late pull overwrite a newer push', async () => {
    const mirror = createAttentionMirror()
    coreAttention.mockImplementation(async () => projection(99))
    await mirror.attach()
    push(projection(10))
    await mirror.read()
    expect(mirror.projection?.sequence).toBe(10)
  })

  it('stops publishing after reset', async () => {
    const mirror = attentionMirror()
    await mirror.attach()
    expect(mirror.projection).not.toBeNull()
    mirror.reset()
    expect(mirror.projection).toBeNull()
    expect(handlers.size).toBe(0)
  })
})

describe('the owner actions this lane may take', () => {
  it('submits an event without a source, and lets Core’s push be the update', async () => {
    const mirror = attentionMirror()
    const outcome = await mirror.ingest({ kind: 'reminder', text: 'hello' })
    expect(outcome.operation).toBe('ingested')
    expect(coreSubmit).toHaveBeenCalledTimes(1)
    const [command, payload] = coreSubmit.mock.calls[0] as [string, Record<string, unknown>]
    expect(command).toBe('attention.event.ingest')
    expect(payload).toEqual({ kind: 'reminder', text: 'hello' })
    expect('source' in payload).toBe(false)
  })

  it('registers and cancels a schedule through named fields only', async () => {
    const mirror = attentionMirror()
    await mirror.schedule({ kind: 'reminder', text: 'breathe', dueAt: '2026-10-02T09:00:00.000Z' })
    expect(coreSubmit.mock.calls[0]?.[0]).toBe('attention.schedule.register')
    await mirror.cancelSchedule('s1', 'changed my mind')
    expect(coreSubmit.mock.calls[1]?.[0]).toBe('attention.schedule.cancel')
    expect(coreSubmit.mock.calls[1]?.[1]).toEqual({ scheduleId: 's1', reason: 'changed my mind' })
  })

  it('reads one retained event back and nothing else', async () => {
    coreSubmit.mockImplementation(async () => ({
      requestId: 'r1',
      ok: true,
      attention: {
        operation: 'detail',
        ok: true,
        detail: {
          eventId: 'e1',
          source: 'owner',
          kind: 'reminder',
          goalRef: null,
          text: 'private',
          severityHint: 'none',
          observedAt: '2026-10-02T09:00:00.000Z',
          dueAt: null,
          outcome: 'remember',
        },
      },
    }))
    const detail = await attentionMirror().readEvent('e1')
    expect(detail?.text).toBe('private')
    expect(coreSubmit.mock.calls[0]?.[0]).toBe('attention.inbox.read')
  })

  it('resolves with a sentence when there is no bridge at all', async () => {
    delete window.freyaHost
    const outcome = await attentionMirror().ingest({ kind: 'reminder', text: 'x' })
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toMatch(/not available in this window/)
  })

  it('exposes no method that decides, budgets, cools down or ticks', () => {
    const mirror = attentionMirror()
    expect(Object.keys(mirror).some((key) => /decide|budget|cooldown|tick|escalate|bypass/i.test(key))).toBe(false)
    expect(mirror).not.toHaveProperty('tick')
    expect(mirror).not.toHaveProperty('decide')
    expect(mirror).not.toHaveProperty('setBudget')
  })

  it('makes the projection read with zero arguments', async () => {
    await attentionMirror().read()
    expect(coreAttention.mock.calls[0]).toEqual([])
  })
})
