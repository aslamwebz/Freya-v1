// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ContextChannel,
  ElectronCoreHost,
  isContextReportingCore,
  type ContextReportingCore,
} from '../../electron/coreHost'
import {
  ABSENT_CONTEXT_PROJECTION,
  NO_CONTEXT_DOMAIN_REASON,
  type ContextProjection,
} from '../../core/protocol/context'

/**
 * The Context lane across the host and the preload bridge.
 *
 * Three halves, and they answer different questions:
 *
 *  - The **host shell** is a transport that owns no authority: a window that
 *    attaches to a Core which does not report context receives *nothing*, and
 *    a host with no Core says so by answering `null`. The full production chain
 *    — a Core with `context()`/`onContext()` — is deferred to #15 (the domain)
 *    and #16 (Core's assembly), so the "a Core that reports" half is exercised
 *    through the channel against an object that satisfies the documented
 *    mirror contract. That is the same fake-as-a-seam the Workforce lane tests
 *    with, pinned to the host's door instead of Core's.
 *  - The **preload bridge** is the capability boundary, and its tests read the
 *    bridge's own source: the strongest claim here — there is no context
 *    *command* — is only provable by looking at what the file does *not* name.
 *  - The **main process** registers exactly one read channel for context and no
 *    write door of any spelling.
 */

let dir = ''
let host: ElectronCoreHost | null = null

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-context-host-'))
  host = new ElectronCoreHost(join(dir, 'core-events.jsonl'), {})
})

afterEach(async () => {
  await host?.stop('test-teardown')
  host = null
  await rm(dir, { recursive: true, force: true })
})

function readyProjection(over: Partial<ContextProjection> = {}): ContextProjection {
  return {
    health: 'ready',
    reason: null,
    items: [
      {
        itemId: 'ctx-1',
        kind: 'explicit-selection',
        label: 'the paragraph in the editor',
        state: 'current',
        provenance: {
          sourceClass: 'owner',
          detail: 'selected deliberately',
          admittedAt: '2026-10-01T09:00:00.000Z',
        },
        scope: { label: 'session', detail: null },
        expiresAt: '2026-10-01T09:15:00.000Z',
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
    sequence: 4,
    ...over,
  }
}

/** A Core-shaped object that reports context, for the channel's far half. */
function fakeReportingCore(initial: ContextProjection): {
  core: ContextReportingCore
  emit: (projection: ContextProjection) => void
  subscribeCalls: () => number
  disposeCalls: () => number
} {
  let current = initial
  const listeners = new Set<(projection: ContextProjection) => void>()
  let subscribeCalls = 0
  let disposeCalls = 0
  return {
    core: {
      context: () => current,
      onContext: (listener) => {
        subscribeCalls += 1
        listeners.add(listener)
        return () => {
          disposeCalls += 1
          listeners.delete(listener)
        }
      },
    },
    emit: (projection) => {
      current = projection
      for (const listener of [...listeners]) listener(projection)
    },
    subscribeCalls: () => subscribeCalls,
    disposeCalls: () => disposeCalls,
  }
}

describe('the host owns no Context authority and says so structurally', () => {
  it('answers null before Core has started', () => {
    // Not an absent *projection*: a host with no Core has nothing Core reported,
    // and manufacturing `ABSENT_CONTEXT_PROJECTION` here would put words in a
    // Core's mouth that never spoke them.
    expect(host!.context()).toBeNull()
    const seen: ContextProjection[] = []
    host!.onContext((projection) => seen.push(projection))
    expect(seen).toHaveLength(0)
  })

  it('still answers null after a real Core starts, because nothing has filled the seam yet', async () => {
    await host!.start()
    // The deferred hookup, tested as a *presence of absence*: Core's Context
    // mirror is #15's domain in #16's assembly, and until that day the honest
    // host answer stays `null` rather than an empty-but-ready projection or —
    // worse — a frame invented to fill the window.
    expect(host!.context()).toBeNull()
    const seen: ContextProjection[] = []
    const dispose = host!.onContext((projection) => seen.push(projection))
    expect(seen).toHaveLength(0)
    dispose()
  })

  it('has no Context command to submit, in either door', async () => {
    await host!.start()
    // `context.status.read` does not exist in `CoreCommandName` yet — that
    // vocabulary is #15/#16's to widen — so a window that names any context
    // command is refused before anything else happens. Refused, not ignored:
    // code that guessed a command shape is told its guess does not exist.
    for (const command of ['context.status.read', 'context.item.write', 'context.revoke']) {
      const result = await host!.submit({ command: command as never, requestId: 'c-1' })
      expect(result.ok).toBe(false)
      expect(result.refusal?.reason).toMatch(/unknown command/)
    }
  })
})

describe('the ContextChannel forwards, and only forwards', () => {
  it('binds nothing to a Core that does not report context', () => {
    const channel = new ContextChannel()
    channel.bind({ status: () => ABSENT_CONTEXT_PROJECTION })
    expect(channel.pull()).toBeNull()
    const seen: ContextProjection[] = []
    channel.on((projection) => seen.push(projection))
    expect(seen).toHaveLength(0)
    channel.close()
  })

  it('pulls and pushes what a reporting Core says, verbatim', () => {
    const { core, emit } = fakeReportingCore(readyProjection())
    const channel = new ContextChannel()
    channel.bind(core)

    const seen: ContextProjection[] = []
    const dispose = channel.on((projection) => seen.push(projection))
    // Immediate push on attach, like every other channel: a reloaded window
    // knows where it stands without asking.
    expect(seen).toHaveLength(1)
    expect(seen[0]?.items[0]?.itemId).toBe('ctx-1')

    emit(readyProjection({ sequence: 5 }))
    expect(seen).toHaveLength(2)
    expect(seen[1]?.sequence).toBe(5)
    expect(channel.pull()?.sequence).toBe(5)
    dispose()

    emit(readyProjection({ sequence: 6 }))
    expect(seen).toHaveLength(2)
    channel.close()
  })

  it('drops a window that throws rather than taking the channel down', () => {
    const { core, emit } = fakeReportingCore(readyProjection())
    const channel = new ContextChannel()
    channel.bind(core)
    channel.on(() => {
      throw new Error('this window is broken')
    })
    const healthy: ContextProjection[] = []
    channel.on((projection) => healthy.push(projection))

    emit(readyProjection({ sequence: 7 }))
    expect(healthy.length).toBeGreaterThan(1)
    expect(healthy.at(-1)?.sequence).toBe(7)
    channel.close()
  })

  it('unsubscribes and forgets on close, and then has nothing to report', () => {
    const { core, emit, disposeCalls } = fakeReportingCore(readyProjection())
    const channel = new ContextChannel()
    channel.bind(core)
    const seen: ContextProjection[] = []
    channel.on((projection) => seen.push(projection))

    channel.close()
    expect(disposeCalls()).toBe(1)
    expect(channel.pull()).toBeNull()
    emit(readyProjection({ sequence: 8 }))
    expect(seen).toHaveLength(1)

    const after: ContextProjection[] = []
    channel.on((projection) => after.push(projection))
    expect(after).toHaveLength(0)
    channel.close()
  })

  it('accepts the honest absence a Core reports before any domain plugs in', () => {
    const core: ContextReportingCore = {
      context: () => ({ ...ABSENT_CONTEXT_PROJECTION, reason: NO_CONTEXT_DOMAIN_REASON }),
      onContext: () => () => {},
    }
    const channel = new ContextChannel()
    channel.bind(core)
    const seen: ContextProjection[] = []
    channel.on((projection) => seen.push(projection))
    expect(seen[0]?.health).toBe('unavailable')
    expect(seen[0]?.reason).toBe(NO_CONTEXT_DOMAIN_REASON)
    channel.close()
  })
})

describe('the structural bind refuses anything that is not a context reporter', () => {
  it('checks both halves of the mirror contract by shape', () => {
    expect(isContextReportingCore(null)).toBe(false)
    expect(isContextReportingCore(undefined)).toBe(false)
    expect(isContextReportingCore({})).toBe(false)
    expect(isContextReportingCore('context')).toBe(false)
    // A `context()` without an `onContext()` is a pollable stranger, not the
    // documented mirror: binding to half a contract would let the host believe
    // it follows Core when it only ever sees the moment it looked.
    expect(isContextReportingCore({ context: () => ABSENT_CONTEXT_PROJECTION })).toBe(false)
    expect(isContextReportingCore({ onContext: () => () => {} })).toBe(false)
    expect(
      isContextReportingCore({ context: () => ABSENT_CONTEXT_PROJECTION, onContext: 42 }),
    ).toBe(false)
    const { core } = fakeReportingCore(readyProjection())
    expect(isContextReportingCore(core)).toBe(true)
  })
})

/**
 * The preload bridge is a capability boundary, and "no context command exists"
 * is a claim about what the file does *not* contain. Comments are stripped
 * before matching because several arms explain in prose exactly which verbs
 * they refuse, and a comment must not be allowed to satisfy — or fail — an
 * assertion about the code.
 */
async function preloadSource(): Promise<string> {
  return readFile(new URL('../../electron/preload.ts', import.meta.url), 'utf8')
}

function stripCommentLines(source: string): string {
  return source
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => {
      const t = line.trimStart()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
}

describe('the preload bridge gives a window two Context reads and no verb', () => {
  it('names no context command in the reachable command set', async () => {
    const source = await preloadSource()
    const listed = stripCommentLines(
      source.slice(source.indexOf('const CORE_COMMANDS'), source.indexOf('function readString')),
    )
    expect(listed.toLowerCase()).not.toMatch(/context/)
  })

  it('exposes the projection pull and the subscription, and nothing that writes', async () => {
    const source = await preloadSource()
    const api = stripCommentLines(
      source.slice(source.indexOf('const api = {'), source.indexOf('contextBridge.exposeInMainWorld')),
    )
    const contextKeys = [...api.matchAll(/^\s{2}(\w*[Cc]ontext\w*):\s/gm)].map((m) => m[1])
    // Two, both reads: `coreContext()` takes no parameters — there is nothing a
    // window could attach — and `onCoreContext` only ever delivers what main
    // sends. `contextBridge` itself is excluded by the region's end marker and
    // by the required `:` after the key, so what remains is exactly the surface
    // a window can reach for context.
    expect([...contextKeys].sort()).toEqual(['coreContext', 'onCoreContext'])
    expect(api).not.toMatch(/context\w*(Submit|Write|Create|Revoke|Capture|Resolve|Select)/i)
  })

  it('pulls the context projection with no arguments at all', async () => {
    const source = await preloadSource()
    // The renderer cannot even accidentally serialise a payload toward the
    // context channel: the bridge function has no parameter slot to fill.
    expect(source).toMatch(/coreContext: \(\): Promise<ContextProjection \| null> =>\s*\n?\s*ipcRenderer\.invoke\('freya:core:context'\)/)
  })
})

describe('the main process registers one context channel and no write door', () => {
  it('handles exactly the read, and pushes exactly the projection', async () => {
    const source = await readFile(new URL('../../electron/main.ts', import.meta.url), 'utf8')
    const code = stripCommentLines(source)
    expect([...code.matchAll(/'freya:core:context'/g)]).toHaveLength(2)
    expect(code).toMatch(/ipcMain\.handle\('freya:core:context', \(\) => requireCore\(\)\.context\(\)\)/)
    expect(code).toMatch(/webContents\.send\('freya:core:context', projection\)/)
    expect(code.toLowerCase()).not.toMatch(/context:(write|submit|update|revoke)/)
  })
})
