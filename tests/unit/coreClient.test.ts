// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCoreMirror } from '../../src/platform/coreClient'
import type { CoreCommandName, CoreStatus } from '../../core/protocol/core-protocol'

/**
 * The renderer must never be a second source of truth.
 *
 * Two rules are worth a test each: with no bridge the panel says so instead of
 * showing a healthy-looking zero, and a command reply replaces local state
 * rather than being merged into it.
 */

function status(over: Partial<CoreStatus> = {}): CoreStatus {
  return {
    lifecycle: 'ready',
    eventSequence: 7,
    coreStartedAt: '2026-03-01T12:00:00.000Z',
    stopAll: { active: false, activatedAt: null, activatedBy: null },
    guard: { defaultOutcome: 'deny', approvalWorkflow: 'unavailable' },
    governor: { status: 'ready', grantsActive: 0 },
    providers: [],
    sessionUsage: { calls: 0, inputTokens: null, outputTokens: null },
    durableUsage: { calls: 0, inputTokens: null, outputTokens: null },
    faults: [],
    ...over,
  }
}

afterEach(() => {
  delete window.freyaHost
  vi.restoreAllMocks()
})

describe('core mirror with no bridge', () => {
  it('reports that Core is absent instead of an empty-but-healthy status', async () => {
    const mirror = createCoreMirror()
    const seen: (CoreStatus | null)[] = []
    mirror.subscribe((s) => seen.push(s))

    await mirror.attach()

    expect(seen[0]).toBeNull()
    expect(mirror.status).not.toBeNull()
    expect(mirror.status?.faults).toEqual(['core is not reachable from this window'])
    // Unknown is not zero: the counters say nothing, they do not say "none".
    expect(mirror.status?.lifecycle).toBe('booting')
  })

  it('refuses a command rather than throwing when there is no bridge', async () => {
    const mirror = createCoreMirror()
    const result = await mirror.submit('core.status.read')
    expect(result.ok).toBe(false)
    expect(result.refusal?.reason).toContain('unavailable')
  })
})

describe('core mirror over the bridge', () => {
  function installBridge(over: Partial<Record<string, unknown>> = {}) {
    const listeners: ((s: CoreStatus) => void)[] = []
    const coreSubmit = vi.fn(async (_command: CoreCommandName, _payload?: unknown) => ({
      requestId: 'r1',
      ok: true,
      status: status({ eventSequence: 8 }),
    }))
    window.freyaHost = {
      isDesktop: true,
      getRuntimeInfo: vi.fn(),
      loadWorkspace: vi.fn(),
      saveWorkspace: vi.fn(),
      onCollect: vi.fn(),
      coreSubmit,
      coreStatus: vi.fn(async () => status()),
      onCoreStatus: vi.fn((handler: (s: CoreStatus) => void) => {
        listeners.push(handler)
        return () => {
          const i = listeners.indexOf(handler)
          if (i >= 0) listeners.splice(i, 1)
        }
      }),
      ...over,
    } as unknown as Window['freyaHost']
    return { coreSubmit, listeners }
  }

  it('adopts the first status and every push after it', async () => {
    const { listeners } = installBridge()
    const mirror = createCoreMirror()
    const seen: (CoreStatus | null)[] = []
    mirror.subscribe((s) => seen.push(s))

    await mirror.attach()
    expect(mirror.status?.eventSequence).toBe(7)

    listeners[0]?.(status({ eventSequence: 9, stopAll: { active: true, activatedAt: 'x', activatedBy: 'owner' } }))
    expect(mirror.status?.eventSequence).toBe(9)
    expect(mirror.status?.stopAll.active).toBe(true)
    // null on subscribe, then the first read, then the push.
    expect(seen).toHaveLength(3)
    expect(seen[0]).toBeNull()
  })

  it('replaces state with the reply to a command rather than merging it', async () => {
    const { coreSubmit } = installBridge()
    const mirror = createCoreMirror()
    await mirror.attach()

    const result = await mirror.submit('security.stopAll', { reason: 'test' })

    expect(coreSubmit).toHaveBeenCalledWith('security.stopAll', { reason: 'test' })
    expect(result.ok).toBe(true)
    // The reply carried sequence 8, and that is what the mirror now holds.
    expect(mirror.status?.eventSequence).toBe(8)
  })

  it('leaves state alone when a command is refused', async () => {
    installBridge({
      coreSubmit: vi.fn(async () => ({ requestId: 'r1', ok: false, refusal: { reason: 'denied' } })),
    })
    const mirror = createCoreMirror()
    await mirror.attach()

    const result = await mirror.submit('security.resume')

    expect(result.ok).toBe(false)
    // No status in the reply means Core sent nothing new, so nothing is invented.
    expect(mirror.status?.eventSequence).toBe(7)
  })

  it('stops delivering to a disposed subscription', async () => {
    const { listeners } = installBridge()
    const mirror = createCoreMirror()
    const seen: (CoreStatus | null)[] = []
    const dispose = mirror.subscribe((s) => seen.push(s))
    await mirror.attach()

    const before = seen.length
    dispose()
    listeners[0]?.(status({ eventSequence: 42 }))

    expect(seen).toHaveLength(before)
    expect(mirror.status?.eventSequence).toBe(42)
  })

  it('replaces an earlier bridge subscription instead of stacking a second', async () => {
    const { listeners } = installBridge()
    const mirror = createCoreMirror()
    await mirror.attach()
    await mirror.attach()
    expect(listeners).toHaveLength(1)
  })
})
