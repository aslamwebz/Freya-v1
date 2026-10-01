// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createCore, type Core } from '../../../core/index'
import { FakeModelProvider } from '../../../core/model/fake-provider'
import {
  ContextChannel,
  ElectronCoreHost,
  isContextReportingCore,
} from '../../../electron/coreHost'
import { CORE_EVENT_SCHEMA_VERSION, CORE_EVENT_TYPES } from '../../../core/events/envelope'
import { CONTEXT_REFUSAL_TEXT } from '../../../core/context/types'
import {
  explicitSelectionAdmission,
  type ExplicitSelectionInput,
} from '../../../core/context/adapters/explicit-selection'
import { authorizedProjectAdmission } from '../../../core/context/adapters/project-file'
import {
  MissionContextAdapter,
  missionContextContent,
} from '../../../core/context/mission-adapter'
import { sharedMediaAdmission, sharedTabAdmission } from '../../../core/context/adapters/tab-media'
import { T0, at, conversation, sessionScope } from './fixture'
import {
  CHAIN_SECRET,
  admitVia,
  chainReportingCore,
  chainSeam,
  chainStore,
  referenceView,
} from './chain-harness'

/**
 * THE PHASE 9 INTEGRATED ACCEPTANCE, UP TO THE TRANSPORT.
 *
 * One chain, driven end to end through production code, with the seam that has
 * no production implementation yet stated as an assumption instead of filled
 * in (`chain-harness.ts` says which seam and why):
 *
 *   adapter → ContextStore → projection → a reporting Core → ContextChannel
 *   → ElectronCoreHost → (the renderer half lives in
 *   `tests/unit/contextChain.test.tsx`).
 *
 * The claims are the ones issue #33 asks for, each written as something that
 * fails when the property fails rather than when the prose stops matching:
 *
 *  - an explicit source reaches the store with the provenance its adapter
 *    fixed, and authority is refused before the store is ever asked;
 *  - an ambiguous reference is reported as ambiguity, with every candidate;
 *  - revoked and expired context is never presented as live;
 *  - provenance and scope survive the seam, and another conversation does not;
 *  - private content stays in the store — the projection, the channel, the
 *    activity feed, the security status and the journal on disk are all
 *    scanned, and the scanner is proved against a control first;
 *  - the whole chain spends zero model calls;
 *  - a real Core still reports no Context facade (PR #27, not merged), and
 *    that is asserted truthfully *and* as a pending contract that fails the
 *    day #27 lands in a vocabulary the transport cannot read;
 *  - restart and a degraded Core tell the truth about what context survived.
 *
 * Nothing here modifies production code, and nothing here reaches into #29,
 * #30, #31 or #32, none of which have landed.
 */

let dir = ''
let provider: FakeModelProvider
let cores: Core[] = []
let hosts: ElectronCoreHost[] = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-chain-'))
  provider = new FakeModelProvider()
})

afterEach(async () => {
  for (const host of hosts) await host.stop('chain-teardown').catch(() => undefined)
  hosts = []
  for (const core of cores) await core.stop('chain-teardown').catch(() => undefined)
  cores = []
  await rm(dir, { recursive: true, force: true })
})

/** The host and the Core use separate journals so one test may boot both. */
function coreFile(): string {
  return join(dir, 'core-events.jsonl')
}

function hostFile(): string {
  return join(dir, 'host-events.jsonl')
}

async function bootCore(dataPath = coreFile()): Promise<Core> {
  const core = createCore({ dataPath, providers: [provider] })
  cores.push(core)
  await core.start()
  return core
}

async function bootHost(dataPath = hostFile()): Promise<ElectronCoreHost> {
  const host = new ElectronCoreHost(dataPath, {}, { providers: [provider] })
  hosts.push(host)
  await host.start()
  return host
}

async function journalText(dataPath: string): Promise<string> {
  try {
    return await readFile(dataPath, 'utf8')
  } catch {
    return ''
  }
}

/* ----------------------------------------------------------- the seam down */

describe('an explicit source reaches the store, with the provenance its adapter fixed', () => {
  it('admits a selection and carries the same facts into the projection', () => {
    const store = chainStore()
    store.setActiveScope(sessionScope())
    const item = admitVia(
      store,
      explicitSelectionAdmission({ scope: sessionScope(), content: CHAIN_SECRET }),
      T0,
    )

    // The adapter — not the payload — chose the source class.
    expect(item.provenance.source).toBe('owner_selection')
    expect(item.provenance.originId).toBeNull()

    const projection = chainSeam().project({ store, now: T0 })
    expect(projection.health).toBe('ready')
    const view = projection.items[0]
    const row = store.audit(T0)[0]
    if (view === undefined || row === undefined) throw new Error('expected one row and one view')

    expect(Object.keys(view).sort()).toEqual([
      'expiresAt',
      'itemId',
      'kind',
      'label',
      'provenance',
      'scope',
      'state',
      'ttlSeconds',
    ])
    // Survival, not interpretation: every field is the domain's own value.
    expect(view.itemId).toBe(row.contextId)
    expect(view.kind).toBe(item.kind)
    expect(view.provenance).toEqual({
      sourceClass: row.source,
      detail: row.originId,
      admittedAt: row.admittedAt,
    })
    expect(view.scope).toEqual({ label: row.scopeKind, detail: row.scopeId })
    expect(view.expiresAt).toBe(row.expiresAt)
    expect(view.ttlSeconds).toBe(
      Math.round((Date.parse(row.expiresAt) - Date.parse(row.admittedAt)) / 1000),
    )
    expect(view.state).toBe('current')
    expect(projection.counts).toEqual({
      items: 1,
      current: 1,
      expired: 0,
      revoked: 0,
      references: 0,
      unresolvedReferences: 0,
    })
  })

  it('carries the origin a host-reported share had to name', () => {
    const store = chainStore()
    store.setActiveScope(conversation('conv-9'))
    const item = admitVia(
      store,
      sharedMediaAdmission({
        scope: conversation('conv-9'),
        content: CHAIN_SECRET,
        source: 'host_report',
        originId: 'host:media-7',
      }),
      T0,
    )
    expect(item.provenance.source).toBe('host_report')

    const view = chainSeam().project({ store, now: T0 }).items[0]
    if (view === undefined) throw new Error('expected one view')
    expect(view.provenance?.sourceClass).toBe('host_report')
    // "Where exactly it came from" survives the seam as the record the host named.
    expect(view.provenance?.detail).toBe('host:media-7')
  })

  it('refuses a share that names no origin, and never reaches the store', () => {
    const store = chainStore()
    store.setActiveScope(sessionScope())
    const refused = sharedTabAdmission({
      scope: sessionScope(),
      content: CHAIN_SECRET,
      source: 'host_report',
    })
    if (refused.ok) throw new Error('expected the adapter to refuse an originless host report')
    expect(refused.code).toBe('origin_required')
    expect(store.retained).toBe(0)
    expect(chainSeam().project({ store, now: T0 }).items).toEqual([])
  })

  it('refuses authority at the door of the chain, before the store is asked', () => {
    const store = chainStore()
    store.setActiveScope(sessionScope())
    const smuggled = explicitSelectionAdmission({
      scope: sessionScope(),
      content: CHAIN_SECRET,
      permission: 'context.admin',
    } as unknown as ExplicitSelectionInput)
    if (smuggled.ok) throw new Error('expected the adapter to refuse an authority-shaped key')
    expect(smuggled.code).toBe('authority_not_admissible')
    // The refusal phrases itself; it never quotes the claim back.
    expect(smuggled.reason).not.toContain('context.admin')
    expect(store.retained).toBe(0)
  })
})

/* -------------------------------------------------- a Core-recorded source */

describe('a source Core recorded for itself takes the same road', () => {
  it('carries core_record provenance, and the Mission sentence stays in the store', () => {
    const store = chainStore()
    store.setActiveScope(sessionScope())
    const report = { missionId: 'mission-7', status: 'active' } as const
    const synced = new MissionContextAdapter().sync(report, store, T0)
    if (synced.operation !== 'admitted') {
      throw new Error(`expected an admission, got '${synced.operation}'`)
    }

    const row = store.audit(T0)[0]
    if (row === undefined) throw new Error('expected one row')
    expect(row.source).toBe('core_record')
    expect(row.originId).toBe('mission-7')

    const projection = chainSeam().project({ store, now: T0 })
    const view = projection.items[0]
    if (view === undefined) throw new Error('expected one view')
    expect(view.kind).toBe('current_mission')
    expect(view.provenance).toEqual({
      sourceClass: 'core_record',
      detail: 'mission-7',
      admittedAt: row.admittedAt,
    })
    expect(view.scope).toEqual({ label: 'session', detail: 'session' })
    expect(view.state).toBe('current')

    // The adapter's derived sentence is content, and content stops at the
    // store: the projection carries the origin it came *from*, never the words.
    const sentence = missionContextContent(report)
    expect(store.list(T0)[0]?.content).toBe(sentence)
    expect(JSON.stringify(projection)).not.toContain(sentence)
    expect(JSON.stringify(projection)).not.toContain(sentence.toLowerCase())
  })

  it('re-points by taking the old Mission back, and the projection says so', () => {
    const store = chainStore()
    store.setActiveScope(sessionScope())
    const adapter = new MissionContextAdapter()
    adapter.sync({ missionId: 'mission-7', status: 'active' }, store, T0)
    const moved = adapter.sync({ missionId: 'mission-8', status: 'active' }, store, T0)
    if (moved.operation !== 'repointed') {
      throw new Error(`expected a re-point, got '${moved.operation}'`)
    }

    const projection = chainSeam().project({ store, now: T0 })
    expect(projection.counts).toEqual({
      items: 2,
      current: 1,
      expired: 0,
      revoked: 1,
      references: 0,
      unresolvedReferences: 0,
    })
    expect(
      projection.items.find((item) => item.itemId === moved.revokedId)?.state,
    ).toBe('revoked')
    expect(projection.items.find((item) => item.itemId === moved.contextId)?.state).toBe('current')
    expect(JSON.stringify(projection)).not.toContain('mission-7 and it is active')

    // One live `current_mission`, so "here" is a unique answer and not a tie.
    const resolution = store.resolve({ term: 'this', kind: 'current_mission' }, T0)
    if (!resolution.ok) throw new Error(`expected a unique match, got '${resolution.reason}'`)
    expect(resolution.item.contextId).toBe(moved.contextId)
  })
})

/* ------------------------------------------------------------- ambiguity */

describe('an ambiguous reference is reported as ambiguity, all the way through', () => {
  function storeWithTwoLive() {
    const store = chainStore()
    store.setActiveScope(sessionScope())
    const first = admitVia(
      store,
      explicitSelectionAdmission({ scope: sessionScope(), content: 'the first paragraph' }),
      T0,
    )
    const second = admitVia(
      store,
      explicitSelectionAdmission({ scope: sessionScope(), content: 'the second paragraph' }),
      T0,
    )
    return { store, first, second }
  }

  it('refuses a doubled match with both ids and no tie-break', () => {
    const { store, first, second } = storeWithTwoLive()
    const resolution = store.resolve({ term: 'this' }, T0)
    if (resolution.ok) throw new Error('expected ambiguity')
    expect(resolution.reason).toBe('ambiguous')
    expect([...resolution.candidateIds].sort()).toEqual([first.contextId, second.contextId].sort())

    const view = referenceView({ term: 'this' }, resolution)
    expect(Object.keys(view).sort()).toEqual(['itemIds', 'reason', 'reference', 'status'])
    expect(view.status).toBe('ambiguous')
    expect(view.itemIds).toHaveLength(2)
    expect(view.reason).toBe(CONTEXT_REFUSAL_TEXT.ambiguous)
    expect(view).not.toHaveProperty('chosenItemId')
    expect(view).not.toHaveProperty('resolution')
  })

  it('reports the open reference in the projection with every candidate', () => {
    const { store, first, second } = storeWithTwoLive()
    const resolution = store.resolve({ term: 'this' }, T0)
    if (resolution.ok) throw new Error('expected ambiguity')
    const projection = chainSeam().project({
      store,
      now: T0,
      references: [{ reference: { term: 'this' }, resolution }],
    })
    const reference = projection.references[0]
    if (reference === undefined) throw new Error('expected one reference row')
    expect(reference.status).toBe('ambiguous')
    expect([...reference.itemIds].sort()).toEqual([first.contextId, second.contextId].sort())
    expect(projection.counts).toEqual({
      items: 2,
      current: 2,
      expired: 0,
      revoked: 0,
      references: 1,
      unresolvedReferences: 1,
    })
  })

  it('resolves a unique match, so ambiguity is a verdict and not a mood', () => {
    const { store, first, second } = storeWithTwoLive()
    expect(store.revoke(second.contextId, 'the owner took it back', T0)).toBe(true)
    const resolution = store.resolve({ term: 'this' }, T0)
    if (!resolution.ok) throw new Error('expected a unique live match')
    const view = referenceView({ term: 'this' }, resolution)
    expect(view.status).toBe('resolved')
    expect(view.itemIds).toEqual([first.contextId])
    expect(view.reason).toBeNull()
  })
})

/* ------------------------------------------------- revoked / expired truth */

describe('revoked and expired context is never presented as live', () => {
  function storeWithStates() {
    const store = chainStore()
    store.setActiveScope(sessionScope())
    const live = admitVia(
      store,
      explicitSelectionAdmission({ scope: sessionScope(), content: CHAIN_SECRET }),
      T0,
    )
    const taken = admitVia(
      store,
      authorizedProjectAdmission({ scope: sessionScope(), content: 'the cancelled project' }),
      T0,
    )
    const doomed = admitVia(
      store,
      sharedTabAdmission({ scope: sessionScope(), content: 'the stale tab', ttlMs: 1_000 }),
      T0,
    )
    expect(store.revoke(taken.contextId, 'the owner stopped sharing the project', T0)).toBe(true)
    const later = at(2_000)
    return { store, live, taken, doomed, later }
  }

  it('shows each state the store assigned, and counts them apart', () => {
    const { store, live, taken, doomed, later } = storeWithStates()
    const projection = chainSeam().project({ store, now: later })
    const stateOf = (id: string): string | undefined =>
      projection.items.find((item) => item.itemId === id)?.state

    expect(stateOf(live.contextId)).toBe('current')
    expect(stateOf(taken.contextId)).toBe('revoked')
    expect(stateOf(doomed.contextId)).toBe('expired')
    expect(projection.items.filter((item) => item.state === 'current')).toHaveLength(1)
    expect(projection.counts).toEqual({
      items: 3,
      current: 1,
      expired: 1,
      revoked: 1,
      references: 0,
      unresolvedReferences: 0,
    })
    // The retired rows are still *listed* — an item is shown as revoked rather
    // than quietly omitted — and their private part is gone before the seam.
    const retired = projection.items.filter((item) => item.state !== 'current')
    expect(retired).toHaveLength(2)
    for (const row of store.audit(later)) {
      expect(row).not.toHaveProperty('content')
      expect(row).not.toHaveProperty('label')
      expect(row).not.toHaveProperty('uri')
    }
    expect(JSON.stringify(projection)).not.toContain('the cancelled project')
    expect(JSON.stringify(projection)).not.toContain('the stale tab')
  })

  it('answers a reference to a taken-back item as revoked, and to a timed-out one as expired', () => {
    const { store, taken, doomed, later } = storeWithStates()
    const revoked = store.resolve({ term: 'this', kind: 'project' }, later)
    if (revoked.ok) throw new Error('expected a revocation refusal')
    expect(revoked.reason).toBe('revoked')
    expect(revoked.candidateIds).toEqual([taken.contextId])

    const expired = store.resolve({ term: 'this', kind: 'shared_tab' }, later)
    if (expired.ok) throw new Error('expected an expiry refusal')
    expect(expired.reason).toBe('expired')
    expect(expired.candidateIds).toEqual([doomed.contextId])

    const seam = chainSeam()
    const projection = seam.project({
      store,
      now: later,
      references: [
        { reference: { term: 'this', kind: 'project' }, resolution: revoked },
        { reference: { term: 'this', kind: 'shared_tab' }, resolution: expired },
      ],
    })
    expect(projection.references.map((reference) => reference.status)).toEqual([
      'revoked',
      'expired',
    ])
    expect(projection.counts.unresolvedReferences).toBe(2)
  })
})

/* ------------------------------------------------- provenance, scope, walls */

describe('provenance and scope survive the seam, and another conversation does not', () => {
  it('leaves a foreign conversation out of the items and the counts', () => {
    const store = chainStore()
    store.setActiveScope(conversation('conv-a'))
    const mine = admitVia(
      store,
      explicitSelectionAdmission({ scope: conversation('conv-a'), content: 'my paragraph' }),
      T0,
    )
    const theirs = admitVia(
      store,
      sharedMediaAdmission({
        scope: conversation('conv-b'),
        content: CHAIN_SECRET,
        source: 'host_report',
        originId: 'host:media-elsewhere',
      }),
      T0,
    )
    const ambient = admitVia(
      store,
      sharedTabAdmission({ scope: sessionScope(), content: 'shared for the session' }),
      T0,
    )

    // The store holds all three: scope is the projection's wall, not the store's.
    expect(store.audit(T0)).toHaveLength(3)
    const projection = chainSeam().project({ store, now: T0 })
    expect(projection.items.map((item) => item.itemId).sort()).toEqual(
      [mine.contextId, ambient.contextId].sort(),
    )
    expect(projection.counts).toEqual({
      items: 2,
      current: 2,
      expired: 0,
      revoked: 0,
      references: 0,
      unresolvedReferences: 0,
    })
    expect(JSON.stringify(projection)).not.toContain(theirs.contextId)
    expect(JSON.stringify(projection)).not.toContain('host:media-elsewhere')
  })

  it('never lets a foreign id into a refusal either', () => {
    const store = chainStore()
    store.setActiveScope(conversation('conv-a'))
    admitVia(
      store,
      sharedMediaAdmission({
        scope: conversation('conv-b'),
        content: CHAIN_SECRET,
        source: 'host_report',
        originId: 'host:media-elsewhere',
      }),
      T0,
    )
    const denied = store.resolve({ term: 'this', kind: 'shared_media' }, T0)
    if (denied.ok) throw new Error('expected no match')
    // Scope first: the foreign item is not even a candidate, so its id cannot
    // appear in a refusal a window would render.
    expect(denied.reason).toBe('no_candidates')
    expect(denied.candidateIds).toEqual([])
    expect(JSON.stringify(denied)).not.toContain('host:media-elsewhere')
  })

  it('reports unavailable — not an empty ready frame — while no scope is current', () => {
    const store = chainStore()
    admitVia(
      store,
      explicitSelectionAdmission({ scope: conversation('conv-x'), content: CHAIN_SECRET }),
      T0,
    )
    expect(store.list(T0)).toEqual([])
    const denied = store.resolve({ term: 'this' }, T0)
    if (denied.ok) throw new Error('expected no_active_scope')
    expect(denied.reason).toBe('no_active_scope')

    const projection = chainSeam().project({ store, now: T0 })
    expect(projection.health).toBe('unavailable')
    expect(projection.reason).toBe(CONTEXT_REFUSAL_TEXT.no_active_scope)
    expect(projection.health).not.toBe('ready')
    expect(projection.items).toEqual([])
    expect(projection.counts).toEqual({
      items: 0,
      current: 0,
      expired: 0,
      revoked: 0,
      references: 0,
      unresolvedReferences: 0,
    })
    expect(projection.sequence).toBe(1)
  })
})

/* ----------------------------------------------------------------- privacy */

describe('the private part stays where the store put it', () => {
  it('keeps the secret in the store and out of every view', () => {
    const store = chainStore()
    store.setActiveScope(sessionScope())
    admitVia(
      store,
      explicitSelectionAdmission({
        scope: sessionScope(),
        content: CHAIN_SECRET,
        label: 'the label a person typed',
      }),
      T0,
    )
    // Control: the scanner works, and the secret really is held.
    expect(JSON.stringify({ content: CHAIN_SECRET })).toContain(CHAIN_SECRET)
    expect(store.list(T0)[0]?.content).toBe(CHAIN_SECRET)

    const projection = chainSeam().project({ store, now: T0 })
    expect(JSON.stringify(projection)).not.toContain(CHAIN_SECRET)
    expect(JSON.stringify(projection)).not.toContain('the label a person typed')
    for (const view of projection.items) {
      expect(view.label).toBeNull()
      expect(Object.keys(view).sort()).toEqual([
        'expiresAt',
        'itemId',
        'kind',
        'label',
        'provenance',
        'scope',
        'state',
        'ttlSeconds',
      ])
      const record = view as unknown as Record<string, unknown>
      for (const forbidden of ['content', 'uri', 'authority', 'permission', 'trust']) {
        expect(record).not.toHaveProperty(forbidden)
      }
    }
  })

  it('keeps the secret out of the activity feed, the security status and the journal', async () => {
    const core = await bootCore()
    const store = chainStore()
    store.setActiveScope(sessionScope())
    admitVia(
      store,
      explicitSelectionAdmission({ scope: sessionScope(), content: CHAIN_SECRET }),
      T0,
    )
    const projection = chainSeam().project({ store, now: T0 })
    const channel = new ContextChannel()
    channel.bind(chainReportingCore(projection).core)
    const pushed: unknown[] = []
    channel.on((value) => pushed.push(value))
    expect(pushed).toHaveLength(1)
    channel.close()

    const activity = core.activity()
    // Non-empty, so the scans below are scans of something.
    expect(activity.length).toBeGreaterThan(0)
    expect(JSON.stringify(activity)).not.toContain(CHAIN_SECRET)
    for (const row of activity) {
      expect(Object.keys(row).sort()).toEqual(['at', 'id', 'kind', 'sequence', 'text', 'tone', 'type'])
    }

    expect(JSON.stringify(core.status())).not.toContain(CHAIN_SECRET)
    const security = await core.handleCommand({
      command: 'security.status.read',
      requestId: 'sec-1',
    })
    expect(security.ok).toBe(true)
    expect(JSON.stringify(security)).not.toContain(CHAIN_SECRET)

    const journal = await journalText(coreFile())
    expect(journal).toContain('"type":"core.started"')
    expect(journal).not.toContain(CHAIN_SECRET)
  })

  it('has no context event family for that content to travel in', () => {
    expect(CORE_EVENT_TYPES.filter((type) => type.startsWith('context.'))).toEqual([])
  })
})

/* --------------------------------------------------------------- transport */

describe('the host transport forwards, and can write nothing back', () => {
  it('hands a window the exact object the domain produced', () => {
    const store = chainStore()
    store.setActiveScope(sessionScope())
    admitVia(
      store,
      explicitSelectionAdmission({ scope: sessionScope(), content: CHAIN_SECRET }),
      T0,
    )
    const held = store.list(T0)[0]
    if (held === undefined) throw new Error('expected a held item')
    const seam = chainSeam()
    const first = seam.project({ store, now: T0 })
    const source = chainReportingCore(first)
    const channel = new ContextChannel()
    channel.bind(source.core)

    const seen: unknown[] = []
    const dispose = channel.on((projection) => seen.push(projection))
    // Identity, not equality: the transport forwards, it does not rebuild.
    expect(seen[0]).toBe(first)
    expect(channel.pull()).toBe(first)

    // A newer projection arrives wholesale — the window does not merge two.
    expect(store.revoke(held.contextId, 'the owner took it back', T0)).toBe(true)
    const second = seam.project({ store, now: T0 })
    source.emit(second)
    expect(seen).toHaveLength(2)
    expect(seen[1]).toBe(second)
    expect(channel.pull()).toBe(second)

    dispose()
    source.emit(seam.project({ store, now: T0 }))
    expect(seen).toHaveLength(2)
    channel.close()
  })

  it('offers no verb: nothing a caller can reach changes what a window holds', () => {
    const channel = new ContextChannel()
    const reachable = Object.getOwnPropertyNames(Object.getPrototypeOf(channel))
      .filter((name) => name !== 'constructor')
      .sort()
    expect(reachable).toEqual(['bind', 'broadcast', 'close', 'on', 'pull'])
    for (const verb of [
      'submit',
      'write',
      'admit',
      'revoke',
      'resolve',
      'create',
      'select',
      'capture',
      'grant',
      'set',
    ]) {
      expect((channel as unknown as Record<string, unknown>)[verb]).toBeUndefined()
    }
    channel.close()
  })
})

/* ------------------------------------------------- the pending #27 contract */

describe('a real Core still reports no Context facade (PR #27, not merged)', () => {
  it('does not satisfy the structural seam, so the host answers null and stays quiet', async () => {
    const core = await bootCore()
    // The `in` check, not a typed field: it compiles before #27 adds these
    // methods and after, whatever their signatures turn out to be.
    expect('context' in core).toBe(false)
    expect('onContext' in core).toBe(false)
    expect(isContextReportingCore(core)).toBe(false)

    const channel = new ContextChannel()
    channel.bind(core)
    expect(channel.pull()).toBeNull()
    const seen: unknown[] = []
    channel.on((projection) => seen.push(projection))
    expect(seen).toEqual([])
    channel.close()

    const host = await bootHost()
    expect(host.context()).toBeNull()
    const pushed: unknown[] = []
    host.onContext((projection) => pushed.push(projection))
    expect(pushed).toEqual([])
  })

  it('refuses a context command in the host door rather than inventing one', async () => {
    const host = await bootHost()
    for (const command of ['context.status.read', 'context.admit', 'context.revoke']) {
      const result = await host.submit({ command: command as never, requestId: 'c-1' })
      expect(result.ok).toBe(false)
      expect(result.refusal?.reason).toMatch(/unknown command/)
    }
  })

  /**
   * THE PENDING CONTRACT.
   *
   * Today the honest branch runs: no facade exists, so nothing reports context
   * and the transport says `null`. The day #27's facade exists, this same test
   * runs the *other* branch — and that branch demands the transport's own
   * vocabulary, because a facade that reports something a window cannot read
   * (`health`, `items`, `counts`) is exactly the integration failure this lane
   * exists to catch first. Nothing here names #27's types, so the file
   * compiles before and after it lands.
   */
  it('pending contract: a Core that reports must speak the transport vocabulary', async () => {
    const core = await bootCore()
    const channel = new ContextChannel()
    channel.bind(core)

    if (!('context' in core) || !('onContext' in core)) {
      expect(isContextReportingCore(core)).toBe(false)
      expect(channel.pull()).toBeNull()
      return
    }

    // #27's facade exists. The host bound to it by shape alone, so the only
    // thing standing between a reporting Core and a readable window is this
    // vocabulary — and it is the transport's, not the facade's.
    expect(isContextReportingCore(core)).toBe(true)
    const reported = channel.pull()
    expect(reported).not.toBeNull()
    expect(['ready', 'unavailable']).toContain(reported?.health)
    expect(Array.isArray(reported?.items)).toBe(true)
    expect(reported?.counts).toBeDefined()
    expect(typeof reported?.sequence).toBe('number')
    channel.close()
  })
})

/* ------------------------------------------------------------ idle + spend */

describe('the whole chain spends nothing', () => {
  it('makes zero model calls across every step it can take', async () => {
    const host = await bootHost()
    const store = chainStore()
    store.setActiveScope(sessionScope())
    admitVia(
      store,
      explicitSelectionAdmission({ scope: sessionScope(), content: CHAIN_SECRET }),
      T0,
    )
    const seam = chainSeam()
    const projection = seam.project({ store, now: T0, references: [] })
    store.resolve({ term: 'this' }, T0)

    const channel = new ContextChannel()
    channel.bind(chainReportingCore(projection).core)
    const seen: unknown[] = []
    channel.on((value) => seen.push(value))
    expect(seen).toHaveLength(1)
    expect(channel.pull()).toBe(projection)
    channel.close()

    // The transport's own reads, through the real host door.
    expect(host.context()).toBeNull()
    const status = await host.submit({ command: 'core.status.read', requestId: 'idle-1' })
    expect(status.ok).toBe(true)

    expect(provider.calls).toBe(0)
    expect(host.status().activeProviderCalls).toBe(0)
    expect(host.status().sessionUsage.calls).toBe(0)
  })
})

/* -------------------------------------------------------- restart/degraded */

/** A journal that fails validation at line 3, as `integrity.test.ts` seeds it. */
function journalLine(sequence: number, type: string, payload: unknown): string {
  return (
    JSON.stringify({
      eventId: `evt-${sequence}`,
      sequence,
      type,
      schemaVersion: CORE_EVENT_SCHEMA_VERSION,
      occurredAt: new Date(1_700_000_000_000 + sequence * 1000).toISOString(),
      source: 'core',
      actor: 'system',
      correlationId: `corr-${sequence}`,
      causationId: null,
      payload,
    }) + '\n'
  )
}

describe('restart and degradation tell the truth about context', () => {
  it('reports an ephemeral store as ephemeral and never durable', () => {
    const store = chainStore()
    expect(store.mode).toBe('ephemeral')
    expect(store.durable).toBe(false)
    store.setActiveScope(sessionScope())
    admitVia(
      store,
      explicitSelectionAdmission({ scope: sessionScope(), content: CHAIN_SECRET }),
      T0,
    )
    expect(store.durable).toBe(false)
  })

  it('loses the chain across a restart, and writes nothing to replay', async () => {
    const first = await bootCore()
    const store = chainStore()
    store.setActiveScope(sessionScope())
    admitVia(
      store,
      explicitSelectionAdmission({ scope: sessionScope(), content: CHAIN_SECRET }),
      T0,
    )
    chainSeam().project({ store, now: T0 })
    await first.stop('chain-restart')

    const journal = await journalText(coreFile())
    expect(journal).toContain('"type":"core.started"')
    // Nothing about context was ever durable, so there is nothing to replay —
    // and nothing about context that could be replayed wrongly.
    expect(journal).not.toContain(CHAIN_SECRET)
    expect(journal).not.toMatch(/"type":"context\./)

    const second = await bootCore()
    expect(isContextReportingCore(second)).toBe(false)
    expect(JSON.stringify(second.activity())).not.toContain(CHAIN_SECRET)

    // A restart's store is a new store: the old items are not carried over and
    // no reference pretends otherwise.
    const fresh = chainStore()
    fresh.setActiveScope(sessionScope())
    expect(fresh.retained).toBe(0)
    const denied = fresh.resolve({ term: 'this' }, T0)
    if (denied.ok) throw new Error('expected nothing to resolve after a restart')
    expect(denied.reason).toBe('no_candidates')
  })

  it('a degraded Core still answers the Context door with absence', async () => {
    const path = join(dir, 'degraded.jsonl')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      journalLine(1, 'core.started', {
        version: '0.1.0',
        storeKind: 'jsonl',
        recoveredSequence: 0,
      }) +
        journalLine(2, 'core.ready', {}) +
        '{"eventId":"evt-bad","sequence":3,"type":"core.ready","schemaVersion":1}\n',
    )

    const degraded = await bootCore(path)
    expect(degraded.status().lifecycle).toBe('degraded')
    expect(isContextReportingCore(degraded)).toBe(false)

    const host = await bootHost(path)
    expect(host.status().lifecycle).toBe('degraded')
    // Degraded is not a licence to report context: no facade, no projection,
    // no push — the same honest silence a healthy build gives today.
    expect(host.context()).toBeNull()
    const pushed: unknown[] = []
    host.onContext((projection) => pushed.push(projection))
    expect(pushed).toEqual([])
    // A degraded Core refuses *every* command with its own sentence rather
    // than answering a context one with an invented projection.
    const result = await host.submit({
      command: 'context.status.read' as never,
      requestId: 'd-1',
    })
    expect(result.ok).toBe(false)
    expect(result.refusal?.reason).toMatch(/degraded/)
  })
})
