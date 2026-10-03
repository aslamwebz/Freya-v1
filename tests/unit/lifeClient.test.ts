import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LifeProjection } from '../../core/protocol/life'
import { projectLife } from '../../core/life/projection'
import { emptyLifeState } from '../../core/life/store'
import { createLifeMirror, resetLifeMirror } from '../../src/platform/lifeClient'

/**
 * The renderer's Life History mirror.
 *
 * The boundary properties are the point:
 *
 *  1. It holds what Core pushed and cannot write any of it.
 *  2. Its status read takes **no arguments** — there is no parameter in which a
 *     confidence, a derivation class or a status could travel.
 *  3. Its timeline and entry reads send only a bounded limit, known kinds and one id.
 *  4. It exposes no method that records, consolidates, revises or withdraws, so a
 *     caller asking for one gets a missing method rather than a refusal it could
 *     learn to phrase differently.
 */

function projection(sequence = 0): LifeProjection {
  return projectLife({
    sequence,
    state: emptyLifeState(),
    persistence: { mode: 'encrypted', durable: true, reason: null },
  })
}

let coreSubmit: ReturnType<typeof vi.fn>
let coreLife: ReturnType<typeof vi.fn>
let handlers: Set<(projection: LifeProjection) => void>

function push(next: LifeProjection): void {
  for (const handler of [...handlers]) handler(next)
}

beforeEach(() => {
  resetLifeMirror()
  handlers = new Set()
  coreSubmit = vi.fn(async () => ({
    requestId: 'r1',
    ok: true,
    life: { operation: 'timeline', ok: true, timeline: { items: [], total: 0, returned: 0, truncated: false, omittedCount: 0, filters: { limit: 10, kinds: [], includeWithdrawn: false } } },
  }))
  coreLife = vi.fn(async () => projection())
  window.freyaHost = {
    isDesktop: true,
    coreSubmit: coreSubmit as never,
    coreLife: coreLife as never,
    onCoreLife: ((next: (p: LifeProjection) => void) => {
      handlers.add(next)
      return () => {
        handlers.delete(next)
      }
    }) as never,
  } as never
})

afterEach(() => {
  resetLifeMirror()
  delete window.freyaHost
})

describe('a life mirror that holds only what Core sent', () => {
  it('is absent before anything has reported', () => {
    expect(createLifeMirror().projection).toBeNull()
  })

  it('pushes Core projections to subscribers and stops on dispose', async () => {
    const mirror = createLifeMirror()
    await mirror.attach()
    const seen: (LifeProjection | null)[] = []
    const dispose = mirror.subscribe((next) => seen.push(next))
    push(projection(3))
    expect(seen.at(-1)?.sequence).toBe(3)
    dispose()
    push(projection(4))
    expect(seen.at(-1)?.sequence).toBe(3)
  })

  it('read sends no payload', async () => {
    const mirror = createLifeMirror()
    await mirror.read()
    expect(coreLife).toHaveBeenCalledWith()
  })

  it('timeline sends only a bounded limit, known kinds and a withdrawal flag', async () => {
    const mirror = createLifeMirror()
    await mirror.timeline({ limit: 5, kinds: ['episode'], includeWithdrawn: true })
    expect(coreSubmit).toHaveBeenCalledWith('life.timeline.read', {
      limit: 5,
      kinds: ['episode'],
      includeWithdrawn: true,
    })
  })

  it('readEntry sends only the entry id', async () => {
    const mirror = createLifeMirror()
    await mirror.readEntry('life:test:1')
    expect(coreSubmit).toHaveBeenCalledWith('life.entry.read', { entryId: 'life:test:1' })
  })

  it('exposes no method that records, revises, consolidates or withdraws', () => {
    const mirror = createLifeMirror() as unknown as Record<string, unknown>
    for (const forbidden of ['record', 'revise', 'consolidate', 'withdraw', 'setConfidence', 'promote']) {
      expect(typeof mirror[forbidden]).not.toBe('function')
    }
  })
})
