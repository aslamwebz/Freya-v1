import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ABSENT_CONTEXT_PROJECTION,
  NO_CONTEXT_DOMAIN_REASON,
  type ContextProjection,
} from '../../core/protocol/context'
import {
  createContextMirror,
  contextMirror,
  resetContextMirror,
} from '../../src/platform/contextClient'

/**
 * The renderer's Context mirror.
 *
 * The properties worth a test are the boundary ones, and they are stricter than
 * the Workforce lane's for one reason: Workforce owns a payloadless read
 * command, and Context owns nothing. So the defining assertion here is the
 * *absence* of the submit call, not the shape of it:
 *
 *  1. It holds what Core sent and cannot write any of it.
 *  2. Its reads carry **no arguments at all** — there is no payload to inspect,
 *     because there is no parameter to put one in.
 *  3. `coreSubmit` is never called, for any command name, ever — a window in
 *     this lane cannot ask Core to do anything, only receive what Core said.
 *  4. It exposes no method that could name, revoke, resolve or capture a
 *     context item, so a caller reaching for one gets a missing method rather
 *     than a refusal it could learn to phrase differently.
 */

function projection(over: Partial<ContextProjection> = {}): ContextProjection {
  return {
    health: 'ready',
    reason: null,
    items: [
      {
        itemId: 'ctx-1',
        kind: 'explicit-selection',
        label: 'the paragraph',
        state: 'current',
        provenance: { sourceClass: 'owner', detail: null, admittedAt: null },
        scope: { label: 'session', detail: null },
        expiresAt: null,
        ttlSeconds: 900,
      },
    ],
    references: [],
    counts: {
      items: 1,
      current: 1,
      expired: 0,
      revoked: 0,
      references: 0,
      unresolvedReferences: 0,
    },
    sequence: 3,
    ...over,
  }
}

let coreSubmit: ReturnType<typeof vi.fn>
let coreContext: ReturnType<typeof vi.fn>
let handler: ((p: ContextProjection) => void) | null = null

beforeEach(() => {
  resetContextMirror()
  handler = null
  coreSubmit = vi.fn(async () => ({ requestId: 'r1', ok: false }))
  coreContext = vi.fn(async () => projection())
  window.freyaHost = {
    isDesktop: true,
    coreSubmit: coreSubmit as never,
    coreContext: coreContext as never,
    onCoreContext: ((next: (p: ContextProjection) => void) => {
      handler = next
      return () => {
        handler = null
      }
    }) as never,
  } as never
})

afterEach(() => {
  resetContextMirror()
  delete window.freyaHost
})

describe('a mirror that holds only what Core sent', () => {
  it('is absent before anything has reported', () => {
    const mirror = createContextMirror()
    expect(mirror.projection).toBeNull()
    const seen: (ContextProjection | null)[] = []
    mirror.subscribe((value) => seen.push(value))
    expect(seen).toEqual([null])
  })

  it('pulls once and then follows pushes', async () => {
    const mirror = createContextMirror()
    await mirror.attach()
    // The pull goes out with *zero arguments*: there is nothing to attach a
    // provenance, a scope or a claim to, structurally rather than by policy.
    expect(coreContext.mock.calls).toEqual([[]])
    expect(mirror.projection?.items[0]?.itemId).toBe('ctx-1')

    // A push overwrites wholesale — the renderer does not merge, because a
    // merged projection would be a second author of the same truth.
    handler?.(projection({ sequence: 4 }))
    expect(mirror.projection?.sequence).toBe(4)
  })

  it('stays absent when the bridge throws instead of inventing context', async () => {
    coreContext.mockImplementation(async () => {
      throw new Error('no core')
    })
    const mirror = createContextMirror()
    await mirror.attach()
    expect(mirror.projection).toBeNull()
  })

  it('keeps a push that arrived while an attaching pull failed', async () => {
    coreContext.mockImplementation(async () => {
      throw new Error('window reloaded')
    })
    const mirror = createContextMirror()
    const attaching = mirror.attach()
    handler?.(projection({ sequence: 11 }))
    await attaching
    expect(mirror.projection?.sequence).toBe(11)
  })

  it('publishes the honest absence when the host has nothing to report', async () => {
    coreContext.mockImplementation(async () => null)
    const mirror = createContextMirror()
    await mirror.attach()
    // The host's `null` (no Core reporting) becomes the protocol's stated
    // absence — `unavailable`, never `ready` with empty lists.
    expect(mirror.projection?.health).toBe('unavailable')
    expect(mirror.projection?.reason).toBe('Core has not reported a Context yet')
  })

  it('stops publishing after reset', async () => {
    const mirror = contextMirror()
    await mirror.attach()
    expect(mirror.projection).not.toBeNull()
    mirror.reset()
    expect(mirror.projection).toBeNull()
    expect(handler).toBeNull()
  })
})

describe('the read this lane submits, which is none', () => {
  it('pulls with no arguments and answers in outcomes, not exceptions', async () => {
    const mirror = contextMirror()
    const outcome = await mirror.read()
    expect(outcome).toEqual({ operation: 'status', ok: true })
    expect(coreContext.mock.calls).toEqual([[]])
    // The defining property of this lane, asserted rather than assumed: no
    // command of any name leaves this client. Not one payloadless read, like
    // Workforce — zero submits.
    expect(coreSubmit).not.toHaveBeenCalled()
  })

  it('takes no parameters, so there is nowhere to smuggle a provenance', () => {
    // The arity is the boundary: a caller cannot attach a trust class, a scope
    // or an authority to a function that reads no arguments, and a future
    // change that adds one shows up as a failing test before it can show up as
    // a route into Core's Context lane.
    expect(contextMirror().read.length).toBe(0)
  })

  it('does not overwrite a live mirror with an older pull', async () => {
    const mirror = contextMirror()
    await mirror.attach()
    handler?.(projection({ sequence: 9 }))
    coreContext.mockImplementation(async () => projection({ sequence: 2 }))

    const outcome = await mirror.read()
    expect(outcome.ok).toBe(true)
    // The pull succeeded, but the newer Core truth stays on screen: a mirror
    // that silently regressed would be the failure this client exists to
    // prevent, and a read is no licence to write an older answer over a newer
    // one.
    expect(mirror.projection?.sequence).toBe(9)
  })

  it('reports a refusal as a refusal when Core cannot be reached', async () => {
    coreContext.mockImplementation(async () => {
      throw new Error('window reloaded')
    })
    const outcome = await contextMirror().read()
    expect(outcome.ok).toBe(false)
    expect(outcome.operation).toBe('refused')
    expect(outcome.reason).toContain('could not be reached')
    expect(coreSubmit).not.toHaveBeenCalled()
  })

  it('resolves with a sentence when there is no bridge at all', async () => {
    delete window.freyaHost
    const outcome = await contextMirror().read()
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toMatch(/not available in this window/)
  })

  it('exposes no method that could name, revoke, resolve or capture', () => {
    // The whole surface of the client, listed. One is a getter, three are
    // subscription plumbing, and `read` pulls a projection — there is no
    // `select`, no `revoke`, no `resolve` and no `capture` to be refused,
    // because none exists to be called.
    expect(Object.keys(contextMirror()).sort()).toEqual([
      'attach',
      'projection',
      'read',
      'reset',
      'subscribe',
    ])
  })
})

describe('a mirror that never becomes an author', () => {
  it('carries no context of its own', async () => {
    const mirror = contextMirror()
    await mirror.attach()
    coreContext.mockImplementation(async () => ({
      ...ABSENT_CONTEXT_PROJECTION,
      reason: NO_CONTEXT_DOMAIN_REASON,
    }))
    await mirror.attach()
    expect(mirror.projection?.items).toEqual([])
    expect(mirror.projection?.health).toBe('unavailable')
    // No local item was appended to make the view look populated, and the
    // sequence is Core's, not a count of what this window received.
    expect(mirror.projection?.sequence).toBe(0)
  })
})
