import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ABSENT_WORKFORCE_PROJECTION,
  NO_WORKFORCE_DOMAIN_REASON,
  type WorkforceProjection,
} from '../../core/protocol/workforce'
import {
  createWorkforceMirror,
  resetWorkforceMirror,
  workforceMirror,
} from '../../src/platform/workforceClient'

/**
 * The renderer's Workforce mirror.
 *
 * The properties worth a test are the boundary ones:
 *
 *  1. It holds what Core sent and cannot write any of it.
 *  2. Its single command is a read, submitted with **no payload** — there is no
 *     route from this client into the Workforce lane that carries anything at
 *     all.
 *  3. It exposes no method that creates, assigns, claims or grants, so a caller
 *     asking for one gets a missing method rather than a refused request it
 *     could learn to phrase differently.
 */

function projection(over: Partial<WorkforceProjection> = {}): WorkforceProjection {
  return {
    ...ABSENT_WORKFORCE_PROJECTION,
    health: 'ready',
    reason: null,
    counts: { workers: 1, working: 1, idle: 0, waiting: 0, teams: 0 },
    sequence: 3,
    workers: [
      {
        workerId: 'worker-alpha',
        name: 'Alpha',
        teamId: null,
        specialization: null,
        state: 'working',
        assignment: null,
        capabilities: [],
        claims: [],
        budget: null,
        concurrency: null,
        lastActiveAt: null,
      },
    ],
    ...over,
  }
}

let coreSubmit: ReturnType<typeof vi.fn>
let coreWorkforce: ReturnType<typeof vi.fn>
let handler: ((p: WorkforceProjection) => void) | null = null

beforeEach(() => {
  resetWorkforceMirror()
  handler = null
  coreSubmit = vi.fn(async () => ({
    requestId: 'r1',
    ok: true,
    workforce: { operation: 'status', ok: true },
  }))
  coreWorkforce = vi.fn(async () => projection())
  window.freyaHost = {
    isDesktop: true,
    coreSubmit: coreSubmit as never,
    coreWorkforce: coreWorkforce as never,
    onCoreWorkforce: ((next: (p: WorkforceProjection) => void) => {
      handler = next
      return () => {
        handler = null
      }
    }) as never,
  } as never
})

afterEach(() => {
  resetWorkforceMirror()
  delete window.freyaHost
})

describe('a mirror that holds only what Core sent', () => {
  it('is absent before anything has reported', () => {
    const mirror = createWorkforceMirror()
    expect(mirror.projection).toBeNull()
    const seen: (WorkforceProjection | null)[] = []
    mirror.subscribe((value) => seen.push(value))
    expect(seen).toEqual([null])
  })

  it('reads once and then follows pushes', async () => {
    const mirror = createWorkforceMirror()
    await mirror.attach()
    expect(coreWorkforce).toHaveBeenCalledTimes(1)
    expect(mirror.projection?.workers[0]?.name).toBe('Alpha')

    // A push overwrites wholesale — the renderer does not merge, because a
    // merged projection would be a second author of the same truth.
    handler?.(projection({ sequence: 4 }))
    expect(mirror.projection?.sequence).toBe(4)
  })

  it('stays absent when the bridge throws instead of inventing a workforce', async () => {
    coreWorkforce.mockImplementation(async () => {
      throw new Error('no core')
    })
    const mirror = createWorkforceMirror()
    await mirror.attach()
    expect(mirror.projection).toBeNull()
  })

  it('publishes Core’s absent projection when the host has no Core yet', async () => {
    coreWorkforce.mockImplementation(async () => null)
    const mirror = createWorkforceMirror()
    await mirror.attach()
    expect(mirror.projection?.health).toBe('unavailable')
    expect(mirror.projection?.reason).toBe('Core has not reported a Workforce yet')
  })

  it('stops publishing after reset', async () => {
    const mirror = workforceMirror()
    await mirror.attach()
    expect(mirror.projection).not.toBeNull()
    mirror.reset()
    expect(mirror.projection).toBeNull()
    expect(handler).toBeNull()
  })
})

describe('the one command this lane submits', () => {
  it('submits the read with no payload at all', async () => {
    const mirror = workforceMirror()
    const outcome = await mirror.read()

    expect(outcome).toEqual({ operation: 'status', ok: true })
    // Exactly one argument. There is no second argument carrying a principal, a
    // capability or a claim — there is no second argument carrying anything.
    expect(coreSubmit.mock.calls[0]).toEqual(['workforce.status.read'])
  })

  it('reports a refusal as a refusal, in Core’s own words', async () => {
    coreSubmit.mockImplementation(async () => ({
      requestId: 'r1',
      ok: false,
      refusal: { reason: 'a Workforce read carries no payload' },
    }))
    const outcome = await workforceMirror().read()
    expect(outcome.ok).toBe(false)
    expect(outcome.operation).toBe('refused')
    expect(outcome.reason).toBe('a Workforce read carries no payload')
  })

  it('resolves with a sentence when Core cannot be reached, rather than rejecting', async () => {
    coreSubmit.mockImplementation(async () => {
      throw new Error('window reloaded')
    })
    const outcome = await workforceMirror().read()
    expect(outcome.ok).toBe(false)
    expect(outcome.operation).toBe('refused')
    expect(outcome.reason).toContain('could not be reached')
  })

  it('resolves with a sentence when there is no bridge at all', async () => {
    delete window.freyaHost
    const outcome = await workforceMirror().read()
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toMatch(/not available in this window/)
  })

  it('exposes no method that could create, assign, claim or grant', () => {
    // The whole surface of the client, listed. Five keys, one of which is a
    // getter and three of which are subscription plumbing — there is no
    // `createWorker`, no `assign`, no `setTeam`, no `claim` and no `grant` to
    // be refused, because none exists to be called.
    expect(Object.keys(workforceMirror()).sort()).toEqual([
      'attach',
      'projection',
      'read',
      'reset',
      'subscribe',
    ])
  })

  it('carries no workforce roster of its own', async () => {
    const mirror = workforceMirror()
    await mirror.attach()
    // Whatever Core's absent projection says, the mirror repeats it: no local
    // worker is ever appended to make a view look populated.
    coreWorkforce.mockImplementation(async () => ({
      ...ABSENT_WORKFORCE_PROJECTION,
      reason: NO_WORKFORCE_DOMAIN_REASON,
    }))
    await mirror.attach()
    expect(mirror.projection?.workers).toEqual([])
    expect(mirror.projection?.health).toBe('unavailable')
  })
})
