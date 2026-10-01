// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ContextChannel,
  ElectronCoreHost,
  isContextReportingCore,
  toContextProjection,
  type ContextReportingCore,
} from '../../electron/coreHost'
import {
  ABSENT_CONTEXT_PROJECTION,
  NO_CONTEXT_DOMAIN_REASON,
  type ContextProjection,
  type ContextProjectionView,
} from '../../core/protocol/context'

/**
 * The Context lane across the host and the preload bridge.
 *
 * Three halves, and they answer different questions:
 *
 *  - The **host shell** is a transport that owns no authority: a window that
 *    attaches to a Core which does not report context receives *nothing*, and a
 *    host with no Core says so by answering `null`. Core now reports context in
 *    its own vocabulary, and the channel translates that into the window's, so
 *    the "a Core that reports" half is driven two ways: against a real Core,
 *    and against an object that satisfies the documented mirror contract for
 *    the shape-level claims — the same fake-as-a-seam the Workforce lane tests
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

/**
 * A projection in *Core's* vocabulary — what `core.context()` answers.
 *
 * The other half of this boundary, built here rather than borrowed so that the
 * file sees both shapes the channel has to carry and the translation between
 * them is asserted rather than assumed.
 */
function coreView(over: Partial<ContextProjectionView> = {}): ContextProjectionView {
  return {
    persistence: {
      mode: 'ephemeral',
      durable: false,
      reason: 'context is held in this process only',
    },
    activeScope: { scopeKind: 'conversation', scopeId: 'c1' },
    declaredScopes: [{ scopeKind: 'conversation', scopeId: 'c1' }],
    agentContext: { wired: false, available: false, reason: 'no active agent context' },
    items: [
      {
        contextId: 'ctx-1',
        kind: 'explicit-selection',
        source: 'owner_selection',
        scopeKind: 'conversation',
        scopeId: 'c1',
        originId: 'share-1',
        capturedAt: '2026-10-01T09:00:00.000Z',
        admittedAt: '2026-10-01T09:00:00.000Z',
        expiresAt: '2026-10-01T09:15:00.000Z',
        revokedAt: null,
        state: 'live',
        contentLength: 42,
        labelLength: 9,
      },
    ],
    counts: { live: 1, revoked: 0, expired: 0, retained: 1, declaredScopes: 1 },
    limits: { maxItems: 64, maxLivePerScope: 16, maxScopes: 8 },
    sequence: 4,
    ...over,
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

  it('answers a real Core with Core\'s own context truth, in the window\'s words', async () => {
    await host!.start()
    // The seam is filled: a started Core has built its Context integration, so
    // the host no longer answers `null`. What crosses is Core's projection
    // translated into the window's vocabulary — `ready` because Core built the
    // integration, and not one field of content, because Core's audit row does
    // not carry any.
    const reported = host!.context()
    expect(reported).not.toBeNull()
    expect(reported?.health).toBe('ready')
    expect(reported?.reason).toBeNull()
    // Nothing admitted, and a projection of "nothing admitted" says so with
    // zeroes rather than with an absent frame.
    expect(reported?.items).toEqual([])
    expect(reported?.counts).toEqual({
      items: 0,
      current: 0,
      expired: 0,
      revoked: 0,
      references: 0,
      unresolvedReferences: 0,
    })

    // A window attaching now is pushed that projection immediately, like every
    // other channel: a reloaded window knows where it stands without asking.
    const seen: ContextProjection[] = []
    const dispose = host!.onContext((projection) => seen.push(projection))
    expect(seen).toHaveLength(1)
    expect(seen[0]?.health).toBe('ready')
    dispose()
  })

  it('refuses the context names Core deliberately does not own', async () => {
    await host!.start()
    // Core owns a context vocabulary now: `context.status.read`, `context.admit`
    // and the rest are Core's own commands, and the window door carries none of
    // them (asserted against `CORE_COMMANDS` below). What this door must still
    // refuse are the names that were never going to exist — a resolve, an item
    // read, a write — because "a window asks Core to hand over the thing this
    // refers to" is the exact answer `core-protocol.ts` keeps out of the
    // vocabulary on purpose. Refused, not ignored: code that guessed a command
    // shape is told its guess does not exist.
    for (const command of ['context.resolve', 'context.item.read', 'context.item.write']) {
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

describe("the host translates Core's context vocabulary into the window's", () => {
  it('reports one audit row as one item, in the window keys and no more', () => {
    const projection = toContextProjection(coreView())

    expect(projection.health).toBe('ready')
    expect(projection.reason).toBeNull()
    expect(projection.sequence).toBe(4)
    expect(Object.keys(projection.items[0] ?? {}).sort()).toEqual([
      'expiresAt',
      'itemId',
      'kind',
      'label',
      'provenance',
      'scope',
      'state',
      'ttlSeconds',
    ])
    expect(projection.items[0]).toEqual({
      itemId: 'ctx-1',
      kind: 'explicit-selection',
      // Core's audit row carries the *length* of a label and never the label:
      // a file name is private in exactly the way the content is, so the
      // surface heads the row with Core's `kind` instead.
      label: null,
      state: 'live',
      provenance: {
        sourceClass: 'owner_selection',
        detail: 'share-1',
        admittedAt: '2026-10-01T09:00:00.000Z',
      },
      scope: { label: 'conversation', detail: 'c1' },
      expiresAt: '2026-10-01T09:15:00.000Z',
      // Core reports the instant an item stops being valid, not a granted
      // lifetime — arithmetic on two instants would be this file inventing one.
      ttlSeconds: null,
    })
    expect(projection.counts).toEqual({
      items: 1,
      current: 1,
      expired: 0,
      revoked: 0,
      references: 0,
      unresolvedReferences: 0,
    })
    // Core holds no standing references: `context.reference.read` resolves a
    // term inside Core and is consumed there, so "no open references" is the
    // truth about the projection rather than a gap in it.
    expect(projection.references).toEqual([])
  })

  it("keeps a Core whose Context is not built unavailable, in Core's own words", () => {
    // What `core.context()` answers before `start()` finishes: zeroed limits,
    // because there is no integration to hold any. Reported as `unavailable`
    // with Core's sentence — never `ready` with an empty list, which would read
    // as "Freya is looking at nothing" rather than "Core is not up yet".
    const projection = toContextProjection(
      coreView({
        persistence: {
          mode: 'ephemeral',
          durable: false,
          reason: 'context is not available until Core has started',
        },
        activeScope: null,
        declaredScopes: [],
        items: [],
        counts: { live: 0, revoked: 0, expired: 0, retained: 0, declaredScopes: 0 },
        limits: { maxItems: 0, maxLivePerScope: 0, maxScopes: 0 },
        sequence: 0,
      }),
    )
    expect(projection.health).toBe('unavailable')
    expect(projection.reason).toBe('context is not available until Core has started')
    expect(projection.items).toEqual([])
  })

  it('forwards a projection already in the window vocabulary verbatim', () => {
    // #24's own seam, still honoured: a far side that already speaks the
    // window's shape is the answer, and rewording it would be this file
    // disagreeing with what Core sent.
    const already = readyProjection()
    expect(toContextProjection(already)).toBe(already)
  })

  it('translates a push as well as a pull, so a window never sees both shapes', () => {
    const pushed: { report: (projection: ContextProjectionView) => void } = {
      report: () => {},
    }
    const channel = new ContextChannel()
    channel.bind({
      context: () => coreView(),
      onContext: (listener: (projection: ContextProjectionView) => void) => {
        pushed.report = listener
        return () => {
          pushed.report = () => {}
        }
      },
    })

    const seen: ContextProjection[] = []
    const dispose = channel.on((projection) => seen.push(projection))
    expect(seen[0]?.items[0]?.itemId).toBe('ctx-1')

    pushed.report(coreView({ sequence: 9 }))
    expect(seen.at(-1)?.sequence).toBe(9)
    expect(seen.at(-1)?.items[0]?.label).toBeNull()
    dispose()
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
