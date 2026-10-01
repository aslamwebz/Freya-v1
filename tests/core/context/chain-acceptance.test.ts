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
  toContextProjection,
} from '../../../electron/coreHost'
import { CORE_EVENT_SCHEMA_VERSION, CORE_EVENT_TYPES } from '../../../core/events/envelope'
import {
  CONTEXT_ADMISSION_REASONS,
  CONTEXT_REFUSAL_TEXT,
  type ContextScope,
} from '../../../core/context/types'
import { ContextIntegration } from '../../../core/context/coreIntegration'
import { createActiveWindowFacadeAdmitter } from '../../../core/context/sources/window'
import type { ContextProjection } from '../../../core/protocol/context'
import {
  explicitSelectionAdmission,
  type ExplicitSelectionInput,
} from '../../../core/context/adapters/explicit-selection'
import { T0, conversation, sessionScope } from './fixture'
import { FakeActiveWindowProvider } from './window/fakeProvider'
import {
  CHAIN_SECRET,
  admitVia,
  chainStore,
  sendContext,
  type ContextDoor,
} from './chain-harness'

/**
 * THE PHASE 9 INTEGRATED ACCEPTANCE, CORE SIDE.
 *
 * One chain, driven through production code, now that PR #27 has merged and
 * the Core facade exists:
 *
 *   source/admission → ContextStore → ContextIntegration (Core) →
 *     Core.context(): ContextProjectionView → toContextProjection /
 *     ElectronCoreHost → the window's ContextProjection
 *     (`tests/unit/contextChain.test.tsx` picks it up there).
 *
 * Every projection these tests read is built by production: `core.context()`
 * for Core's vocabulary and `toContextProjection(...)` for the window's —
 * the same function `ContextChannel` and `ElectronCoreHost.context()` use.
 * The only harness left is `chain-harness.ts`, which drives commands and keeps
 * the #26 source-adapter link of the chain.
 *
 * The claims are the ones issue #33 asks for, each written so that breaking
 * the property breaks the test:
 *
 *  - an explicit source reaches the store with the provenance its door fixed,
 *    and authority is refused before the store is asked;
 *  - an ambiguous reference is reported as ambiguity, with every candidate,
 *    and no command anywhere fetches a referent for it;
 *  - revoked and expired context is never presented as live, and a later
 *    revocation cannot rewrite an expiry;
 *  - provenance and scope survive every hop, and another conversation does
 *    not;
 *  - private content stays in the store — the view, the window's projection,
 *    the activity feed, the security status and the journal on disk are all
 *    scanned, with a control proving the scanner works;
 *  - the whole chain spends zero model calls;
 *  - restart and a degraded Core tell the truth about what context survived.
 *
 * Test-only: no production file is touched, and nothing here reaches into
 * #29, #30 or #32, none of which have merged.
 */

let dir = ''
let provider: FakeModelProvider
let cores: Core[] = []
let hosts: ElectronCoreHost[] = []

const CONV_A = conversation('conv-a')
const CONV_B = conversation('conv-b')
const CONV_9 = conversation('conv-9')

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

/** The window's vocabulary for Core's report — the host's own translation. */
function windowWords(view: ReturnType<Core['context']>): ReturnType<typeof toContextProjection> {
  return toContextProjection(view)
}

async function admitSelection(
  door: ContextDoor,
  scope: ContextScope,
  content: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const admitted = await sendContext(door, 'context.admit', {
    kind: 'explicit_selection',
    channel: 'owner_selection',
    scope,
    content,
    ...extra,
  })
  if (!admitted.outcome.ok) {
    throw new Error(`admission refused (${admitted.outcome.operation}): ${admitted.outcome.reason ?? ''}`)
  }
  const contextId = admitted.outcome.contextId
  if (contextId === undefined) throw new Error('admission returned no contextId')
  return contextId
}

/* ------------------------------------------------- the source and the door */

describe('an explicit source reaches the store, and Core fixes the provenance', () => {
  it('admits a selection through the source adapter, with provenance already fixed', () => {
    const store = chainStore()
    store.setActiveScope(sessionScope())
    const item = admitVia(
      store,
      explicitSelectionAdmission({ scope: sessionScope(), content: CHAIN_SECRET }),
      T0,
    )
    expect(item.provenance.source).toBe('owner_selection')
    expect(item.provenance.originId).toBeNull()
    expect(item.kind).toBe('explicit_selection')
    expect(item.content).toBe(CHAIN_SECRET)
    expect(store.audit(T0)[0]).not.toHaveProperty('content')
  })

  it('refuses authority at the source adapter, before the store is asked', () => {
    const store = chainStore()
    store.setActiveScope(sessionScope())
    const smuggled = explicitSelectionAdmission({
      scope: sessionScope(),
      content: CHAIN_SECRET,
      permission: 'context.admin',
    } as unknown as ExplicitSelectionInput)
    if (smuggled.ok) throw new Error('expected the adapter to refuse an authority-shaped key')
    expect(smuggled.code).toBe('authority_not_admissible')
    expect(smuggled.reason).not.toContain('context.admin')
    expect(store.retained).toBe(0)
  })

  it('admits through Core’s own door and carries the same facts into the window’s words', async () => {
    const core = await bootCore()
    const activated = await sendContext(core, 'context.scope.activate', { scope: CONV_9 })
    expect(activated.outcome.operation).toBe('scope-activated')
    expect(activated.outcome.ok).toBe(true)

    const contextId = await admitSelection(core, CONV_9, CHAIN_SECRET, {
      label: 'the selected paragraph',
    })
    const view = core.context()
    const row = view.items[0]
    const item = windowWords(view).items[0]
    if (row === undefined || item === undefined) throw new Error('expected one row and one item')

    expect(row.source).toBe('owner_selection')
    expect(row.kind).toBe('explicit_selection')
    expect(row.scopeId).toBe('conv-9')
    expect(row.state).toBe('live')
    expect(row.contentLength).toBe(CHAIN_SECRET.length)
    expect(view.activeScope).toEqual(CONV_9)

    // Survival, field for field: the window's item is Core's row, renamed.
    expect(item).toEqual({
      itemId: contextId,
      kind: row.kind,
      label: null,
      state: 'live',
      provenance: {
        sourceClass: row.source,
        detail: row.originId,
        admittedAt: row.admittedAt,
      },
      scope: { label: row.scopeKind, detail: row.scopeId },
      expiresAt: row.expiresAt,
      ttlSeconds: null,
    })
    expect(Object.keys(item).sort()).toEqual([
      'expiresAt',
      'itemId',
      'kind',
      'label',
      'provenance',
      'scope',
      'state',
      'ttlSeconds',
    ])
    expect(windowWords(view).counts).toEqual({
      items: 1,
      current: 1,
      expired: 0,
      revoked: 0,
      references: 0,
      unresolvedReferences: 0,
    })
    expect(windowWords(view).health).toBe('ready')
  })

  it('refuses a payload that names a source Core owns, and one carrying authority', async () => {
    const core = await bootCore()
    await sendContext(core, 'context.scope.activate', { scope: CONV_9 })

    const claimed = await sendContext(core, 'context.admit', {
      kind: 'explicit_selection',
      channel: 'core_record',
      scope: CONV_9,
      content: CHAIN_SECRET,
    })
    expect(claimed.ok).toBe(false)
    expect(claimed.outcome.operation).toBe('refused')
    expect(claimed.outcome.refusal).toBe('channel_not_requestable')

    const withPermission = await sendContext(core, 'context.admit', {
      kind: 'explicit_selection',
      channel: 'owner_selection',
      scope: CONV_9,
      content: CHAIN_SECRET,
      permission: 'context.admin',
    })
    expect(withPermission.ok).toBe(false)
    expect(withPermission.outcome.refusal).toBe('authority_field_present')
    // The refusal names the offending field rather than the input's content.
    expect(withPermission.outcome.reason).toContain('permission')
    expect(withPermission.outcome.reason).not.toContain(CHAIN_SECRET)

    const withSource = await sendContext(core, 'context.admit', {
      kind: 'explicit_selection',
      channel: 'owner_selection',
      scope: CONV_9,
      content: CHAIN_SECRET,
      source: 'core_record',
    })
    expect(withSource.outcome.refusal).toBe('authority_field_present')
    expect(withSource.outcome.reason).toContain('source')

    // Nothing was held: both refusals happened before the store was asked.
    expect(core.context().items).toEqual([])
    expect(core.context().counts.retained).toBe(0)
  })

  it('fixes the same provenance through the adapter and through Core’s door', async () => {
    const store = chainStore()
    store.setActiveScope(sessionScope())
    const viaAdapter = admitVia(
      store,
      explicitSelectionAdmission({ scope: sessionScope(), content: CHAIN_SECRET }),
      T0,
    )

    const core = await bootCore()
    await sendContext(core, 'context.scope.activate', { scope: CONV_9 })
    await admitSelection(core, CONV_9, CHAIN_SECRET)
    const row = core.context().items[0]
    if (row === undefined) throw new Error('expected one row')

    // Two doors, one vocabulary: whatever fixes provenance for a selection,
    // the adapter and the facade agree, so neither can be used to launder the
    // other's answer into a different source class.
    expect(row.kind).toBe(viaAdapter.kind)
    expect(row.source).toBe(viaAdapter.provenance.source)
    expect(row.source).toBe('owner_selection')
    expect(row.contentLength).toBe(viaAdapter.content.length)
  })
})

/* ------------------------------------------------------------- ambiguity */

describe('an ambiguous reference stays unresolved inside Core', () => {
  async function coreWithTwoLive(): Promise<{ core: Core; ids: string[] }> {
    const core = await bootCore()
    await sendContext(core, 'context.scope.activate', { scope: CONV_9 })
    const ids = [
      await admitSelection(core, CONV_9, 'the first paragraph'),
      await admitSelection(core, CONV_9, 'the second paragraph'),
    ]
    return { core, ids }
  }

  it('names every candidate and no choice', async () => {
    const { core, ids } = await coreWithTwoLive()
    const answered = await sendContext(core, 'context.reference.read', { term: 'this' })
    expect(answered.outcome.ok).toBe(false)
    expect(answered.outcome.operation).toBe('unresolved-ambiguous')
    expect([...(answered.outcome.candidateIds ?? [])].sort()).toEqual([...ids].sort())
    expect(answered.outcome.reason).toBe(CONTEXT_REFUSAL_TEXT.ambiguous)
    // No field that picks: the outcome is ids, words and the verdict.
    expect(Object.keys(answered.outcome).sort()).toEqual([
      'candidateIds',
      'ok',
      'operation',
      'reason',
    ])
    expect(answered.outcome).not.toHaveProperty('contextId')
    expect(answered.outcome).not.toHaveProperty('item')
    expect(answered.outcome).not.toHaveProperty('content')
  })

  it('resolves only once one live match remains', async () => {
    const { core, ids } = await coreWithTwoLive()
    const revoked = await sendContext(core, 'context.revoke', {
      contextId: ids[1],
      reason: 'the owner took one back',
    })
    expect(revoked.outcome.operation).toBe('revoked')

    const answered = await sendContext(core, 'context.reference.read', { term: 'this' })
    expect(answered.outcome.operation).toBe('resolved')
    expect(answered.outcome.ok).toBe(true)
    expect(answered.outcome.contextId).toBe(ids[0])
    // Even a resolution hands over an id, never the item.
    expect(Object.keys(answered.outcome).sort()).toEqual(['contextId', 'ok', 'operation'])
  })

  it('holds no standing reference, so nothing downstream can pick for a window', async () => {
    const { core } = await coreWithTwoLive()
    await sendContext(core, 'context.reference.read', { term: 'this' })
    const projection = windowWords(core.context())
    expect(projection.references).toEqual([])
    expect(projection.counts.references).toBe(0)
    expect(projection.counts.unresolvedReferences).toBe(0)
  })

  it('keeps the answer inside Core: no command fetches a referent', async () => {
    // The two items are created through the *host* door, which is the door
    // `electron/main.ts` puts behind the renderer's command channel.
    const host = await bootHost()
    await sendContext(host, 'context.scope.activate', { scope: CONV_9 })
    await admitSelection(host, CONV_9, 'the first paragraph')
    await admitSelection(host, CONV_9, 'the second paragraph')

    // The names a guessed command shape would use do not exist at this door:
    // a resolution is consumed by the code that asked, and a window can only
    // ever read the projection.
    for (const command of ['context.resolve', 'context.item.read', 'context.item.write']) {
      const result = await host.submit({ command: command as never, requestId: 'c-1' })
      expect(result.ok).toBe(false)
      expect(result.refusal?.reason).toMatch(/unknown command/)
    }
    // While the door Core does own answers, with ids only.
    const read = await sendContext(host, 'context.reference.read', { term: 'this' })
    expect(read.outcome.operation).toBe('unresolved-ambiguous')
    expect(read.outcome).not.toHaveProperty('item')
    expect(read.outcome.candidateIds).toHaveLength(2)
  })
})

/* ------------------------------------------------- revoked and expired */

describe('revoked and expired context is never presented as live', () => {
  it('shows a revocation as revoked, with the content already gone', async () => {
    const core = await bootCore()
    await sendContext(core, 'context.scope.activate', { scope: CONV_9 })
    const taken = await admitSelection(core, CONV_9, CHAIN_SECRET, { label: 'a private name' })
    const kept = await admitSelection(core, CONV_9, 'something still shared')

    const revoked = await sendContext(core, 'context.revoke', {
      contextId: taken,
      reason: 'the owner stopped sharing it',
    })
    expect(revoked.outcome.operation).toBe('revoked')
    expect(revoked.outcome.ok).toBe(true)

    const view = core.context()
    const row = view.items.find((item) => item.contextId === taken)
    if (row === undefined) throw new Error('expected the revoked row to still be listed')
    expect(row.state).toBe('revoked')
    expect(row.revokedAt).not.toBeNull()
    // Retirement destroyed the private part before anything was reported.
    expect(view.items[0]).not.toHaveProperty('content')
    expect(view.items[0]).not.toHaveProperty('label')

    const projection = windowWords(view)
    const item = projection.items.find((entry) => entry.itemId === taken)
    expect(item?.state).toBe('revoked')
    expect(item?.label).toBeNull()
    expect(projection.counts).toEqual({
      items: 2,
      current: 1,
      expired: 0,
      revoked: 1,
      references: 0,
      unresolvedReferences: 0,
    })
    expect(JSON.stringify(projection)).not.toContain(CHAIN_SECRET)
    expect(JSON.stringify(projection)).not.toContain('a private name')
    expect(projection.items.find((entry) => entry.itemId === kept)?.state).toBe('live')
  })

  it('says revoked — not expired — when a person took back the only match', async () => {
    const core = await bootCore()
    await sendContext(core, 'context.scope.activate', { scope: CONV_9 })
    await sendContext(core, 'context.admit', {
      kind: 'shared_media',
      channel: 'owner_share',
      scope: CONV_9,
      content: 'the shared image',
    })
    const media = core.context().items[0]
    if (media === undefined) throw new Error('expected one media item')

    const revoked = await sendContext(core, 'context.revoke', {
      contextId: media.contextId,
      reason: 'the share was withdrawn',
    })
    expect(revoked.outcome.operation).toBe('revoked')

    const answered = await sendContext(core, 'context.reference.read', {
      term: 'this',
      kind: 'shared_media',
    })
    expect(answered.outcome.operation).toBe('unresolved-revoked')
    expect(answered.outcome.candidateIds).toEqual([media.contextId])
    expect(answered.outcome.reason).toBe(CONTEXT_REFUSAL_TEXT.revoked)
  })

  it('says expired at the deadline, and a later revoke cannot rewrite the clock', async () => {
    const core = await bootCore()
    await sendContext(core, 'context.scope.activate', { scope: CONV_9 })
    const shortLived = await admitSelection(core, CONV_9, 'shortlived words', { ttlMs: 1 })
    await new Promise((resolve) => setTimeout(resolve, 25))

    const view = core.context()
    const row = view.items[0]
    if (row === undefined) throw new Error('expected the expired row to still be listed')
    expect(row.state).toBe('expired')
    const projection = windowWords(view)
    expect(projection.items[0]?.state).toBe('expired')
    expect(projection.counts).toEqual({
      items: 1,
      current: 0,
      expired: 1,
      revoked: 0,
      references: 0,
      unresolvedReferences: 0,
    })
    expect(JSON.stringify(projection)).not.toContain('shortlived words')

    const answered = await sendContext(core, 'context.reference.read', {
      term: 'this',
      kind: 'explicit_selection',
    })
    expect(answered.outcome.operation).toBe('unresolved-expired')
    expect(answered.outcome.candidateIds).toEqual([shortLived])
    expect(answered.outcome.reason).toBe(CONTEXT_REFUSAL_TEXT.expired)

    // A person's later revoke must not convert a truthful `expired` into a
    // `revoked`: the words ran out, and that is the fact worth keeping. The
    // operation says so on its own — it is an outcome, not an envelope-level
    // refusal, because Core understood exactly what was asked.
    const late = await sendContext(core, 'context.revoke', {
      contextId: shortLived,
      reason: 'too late to matter',
    })
    expect(late.outcome.operation).toBe('revoke-already-settled')
    expect(late.outcome.ok).toBe(false)
    expect(late.outcome.reason).toMatch(/already expired/)
    expect(core.context().items[0]?.state).toBe('expired')
  })
})

/* ------------------------------------------------- provenance and scope */

describe('provenance and scope survive, and another conversation does not', () => {
  it('carries source, origin, admittedAt and scope through every hop', async () => {
    const core = await bootCore()
    await sendContext(core, 'context.scope.activate', { scope: CONV_A })
    const admitted = await sendContext(core, 'context.admit', {
      kind: 'shared_tab',
      channel: 'owner_share',
      scope: CONV_A,
      content: 'the shared tab',
      originId: 'share-1',
    })
    expect(admitted.outcome.ok).toBe(true)

    const row = core.context().items[0]
    const item = windowWords(core.context()).items[0]
    if (row === undefined || item === undefined) throw new Error('expected one row and one item')
    expect(row.source).toBe('owner_share')
    expect(row.originId).toBe('share-1')

    expect(item.provenance).toEqual({
      sourceClass: row.source,
      detail: row.originId,
      admittedAt: row.admittedAt,
    })
    expect(item.scope).toEqual({ label: row.scopeKind, detail: row.scopeId })
    expect(item.scope).toEqual({ label: 'conversation', detail: 'conv-a' })
    expect(item.expiresAt).toBe(row.expiresAt)
  })

  it('carries a Core-recorded Mission into the window’s words, in the session scope', async () => {
    const core = await bootCore()
    await sendContext(core, 'context.scope.activate', { scope: CONV_9 })

    // A Mission becoming active is Core recording something about itself: the
    // only lane allowed to place content in the `session` scope, and a source
    // no payload can ever claim.
    const created = await core.handleCommand({
      command: 'mission.create',
      requestId: 'm-1',
      payload: { title: 'Land the lease renewal', intent: 'get it signed before Friday' },
    })
    const missionId = (created as { mission?: { missionId?: string } }).mission?.missionId
    if (typeof missionId !== 'string') {
      throw new Error(`mission.create failed: ${JSON.stringify(created)}`)
    }
    const activated = await core.handleCommand({
      command: 'mission.activate',
      requestId: 'm-2',
      payload: { missionId },
    })
    expect(activated.ok).toBe(true)

    const view = core.context()
    const row = view.items.find((item) => item.kind === 'current_mission')
    if (row === undefined) throw new Error('Core did not sync the Mission into context')
    expect(row.source).toBe('core_record')
    expect(row.originId).toBe(missionId)
    expect(row.scopeKind).toBe('session')
    expect(row.state).toBe('live')

    const projection = windowWords(view)
    const item = projection.items.find((entry) => entry.itemId === row.contextId)
    if (item === undefined) throw new Error('the Mission item did not reach the window')
    expect(item.provenance).toEqual({
      sourceClass: 'core_record',
      detail: missionId,
      admittedAt: row.admittedAt,
    })
    // Session is ambient: it is visible from the conversation Core is pointed
    // at, because that is what "for the whole session" means.
    expect(item.scope).toEqual({ label: 'session', detail: 'session' })
    expect(projection.counts.current).toBe(1)

    // The Mission's private wording lives in an encrypted store this lane has
    // no business reading: only the id and the closed status crossed.
    expect(JSON.stringify(view)).not.toContain('Land the lease renewal')
    expect(JSON.stringify(view)).not.toContain('get it signed before Friday')
    expect(JSON.stringify(projection)).not.toContain('Land the lease renewal')
    expect(JSON.stringify(projection)).not.toContain('get it signed before Friday')
  })

  it('never lets another conversation’s item or count into the projection', async () => {
    const core = await bootCore()
    await sendContext(core, 'context.scope.activate', { scope: CONV_A })
    const mine = await admitSelection(core, CONV_A, 'my paragraph')

    await sendContext(core, 'context.scope.activate', { scope: CONV_B })
    const theirs = await sendContext(core, 'context.admit', {
      kind: 'shared_media',
      channel: 'owner_share',
      scope: CONV_B,
      content: CHAIN_SECRET,
      originId: 'host:media-elsewhere',
    })
    expect(theirs.outcome.ok).toBe(true)
    const foreignId = theirs.outcome.contextId
    if (foreignId === undefined) throw new Error('expected a foreign contextId')

    // Back in my conversation: Core still holds theirs, and reports none of it.
    await sendContext(core, 'context.scope.activate', { scope: CONV_A })
    expect(core.context().counts.retained).toBe(1)
    const projection = windowWords(core.context())
    expect(projection.items.map((item) => item.itemId)).toEqual([mine])
    expect(projection.counts.items).toBe(1)
    expect(JSON.stringify(projection)).not.toContain(foreignId)
    expect(JSON.stringify(projection)).not.toContain('host:media-elsewhere')
  })

  it('never lets another conversation’s id into a refusal either', async () => {
    const core = await bootCore()
    await sendContext(core, 'context.scope.activate', { scope: CONV_B })
    const theirs = await sendContext(core, 'context.admit', {
      kind: 'shared_media',
      channel: 'owner_share',
      scope: CONV_B,
      content: CHAIN_SECRET,
      originId: 'host:media-elsewhere',
    })
    const foreignId = theirs.outcome.contextId

    await sendContext(core, 'context.scope.activate', { scope: CONV_A })
    const answered = await sendContext(core, 'context.reference.read', {
      term: 'this',
      kind: 'shared_media',
    })
    // Scope first: their item is not even a candidate, so its id cannot appear
    // in an answer a window would render.
    expect(answered.outcome.operation).toBe('unresolved-no-candidates')
    expect(answered.outcome.candidateIds).toEqual([])
    expect(JSON.stringify(answered.outcome)).not.toContain(foreignId ?? 'missing')
    expect(JSON.stringify(answered.outcome)).not.toContain('host:media-elsewhere')
  })

  it('fails closed before any scope is current, rather than guessing', async () => {
    const core = await bootCore()
    const answered = await sendContext(core, 'context.reference.read', { term: 'this' })
    expect(answered.outcome.operation).toBe('unresolved-no-active-scope')
    expect(answered.outcome.reason).toBe(CONTEXT_REFUSAL_TEXT.no_active_scope)
    expect(answered.outcome.candidateIds).toEqual([])
    // And the projection of "nothing is current" is zeroes, not a frame of
    // quiet awareness: no scope, no items, no invented readiness.
    expect(core.context().activeScope).toBeNull()
    expect(core.context().items).toEqual([])
    expect(windowWords(core.context()).items).toEqual([])
  })
})

/* ------------------------------------------------- the observed window lane */

/**
 * The opt-in observation lane (#30, PR #42), as a chain.
 *
 * `active_window` is a sourced kind now: `host_report` alone, admitted only
 * through the facade's host door via the composable bridge `#42` shipped.
 * Issue #30 is explicitly read-only and opt-in — no transport file wires it,
 * and nothing here asks for ambient default observation. What this lane proves
 * is the chain an opt-in caller gets, using only merged production code:
 *
 *   observation → activeWindowCandidate / activeWindowHostReport
 *     → ContextIntegration.admitHostReport (the host door)
 *     → read() → toContextProjection → the window's ContextProjection
 *
 * plus the two boundary claims the window cares about: the owner door cannot
 * launder an observation into an owner provenance, and the observation's
 * private words never reach anything a window reads.
 */
describe('an observed window reaches the window’s words through the host door', () => {
  function observationLane(scope: ContextScope): {
    integration: ContextIntegration
    observe: (observation: ReturnType<FakeActiveWindowProvider['info']>) => ReturnType<
      ReturnType<typeof createActiveWindowFacadeAdmitter>
    >
    provider: FakeActiveWindowProvider
  } {
    const integration = new ContextIntegration({ now: () => T0 })
    expect(integration.activateScope(scope).operation).toBe('scope-activated')
    const provider = new FakeActiveWindowProvider()
    return {
      integration,
      provider,
      observe: createActiveWindowFacadeAdmitter({ lane: integration, scope }),
    }
  }

  it('admits an observation as host_report and carries it into the window’s words', () => {
    const { integration, observe, provider } = observationLane(CONV_A)
    const observation = provider.info('Code Editor', 'notes.md', T0.toISOString())
    const outcome = observe(observation)
    expect(outcome.operation).toBe('admitted')

    const view = integration.read()
    const row = view.items[0]
    if (row === undefined) throw new Error('the observation was not held')
    expect(row.kind).toBe('active_window')
    // The door fixed provenance: a report cannot express a source at all, and
    // the foundation table admits this kind from exactly this one.
    expect(row.source).toBe('host_report')
    expect(row.scopeKind).toBe('conversation')
    expect(row.scopeId).toBe('conv-a')
    expect(row.originId).toBe(`${provider.providerId}:${observation.observationId}`)
    expect(row.state).toBe('live')
    // The label and the sentence exist, are measured, and are not carried.
    expect(row.labelLength).toBeGreaterThan(0)
    expect(row.contentLength).toBeGreaterThan(0)

    const projection = toContextProjection(view)
    expect(projection.health).toBe('ready')
    expect(projection.items[0]).toEqual({
      itemId: row.contextId,
      kind: 'active_window',
      label: null,
      state: 'live',
      provenance: {
        sourceClass: 'host_report',
        detail: row.originId,
        admittedAt: row.admittedAt,
      },
      scope: { label: 'conversation', detail: 'conv-a' },
      expiresAt: row.expiresAt,
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

    // The observation's private words — the app name, the window title, and
    // the sentence the candidate built from them — stay in the store.
    for (const secret of ['Code Editor', 'notes.md', 'Host observation']) {
      expect(JSON.stringify(view)).not.toContain(secret)
      expect(JSON.stringify(projection)).not.toContain(secret)
    }
    expect(view.items[0]).not.toHaveProperty('label')
    expect(view.items[0]).not.toHaveProperty('content')
  })

  it('supersedes an older observation, and the window is told which row is which', () => {
    const { integration, observe, provider } = observationLane(CONV_A)
    const first = provider.info('Code Editor', 'notes.md', T0.toISOString())
    const second = provider.info('Terminal', 'build log', T0.toISOString())
    expect(observe(first).operation).toBe('admitted')
    expect(observe(second).operation).toBe('admitted')

    const projection = toContextProjection(integration.read())
    expect(projection.counts).toEqual({
      items: 2,
      current: 1,
      expired: 0,
      revoked: 1,
      references: 0,
      unresolvedReferences: 0,
    })
    const superseded = projection.items.find((item) => item.state === 'revoked')
    const current = projection.items.find((item) => item.state === 'live')
    if (superseded === undefined || current === undefined) {
      throw new Error('expected one revoked and one live observation')
    }
    // Both rows keep the observation they came from, so a window can tell
    // "the host saw this before" from "the host sees this now".
    expect(superseded.provenance?.sourceClass).toBe('host_report')
    expect(superseded.provenance?.detail).toBe(
      `${provider.providerId}:${first.observationId}`,
    )
    expect(current.provenance?.detail).toBe(`${provider.providerId}:${second.observationId}`)
    expect(current.kind).toBe('active_window')

    // Neither observation's private words reach anything shared.
    for (const secret of ['Code Editor', 'notes.md', 'Terminal', 'build log']) {
      expect(JSON.stringify(projection)).not.toContain(secret)
      expect(JSON.stringify(integration.read())).not.toContain(secret)
    }
  })

  it('refuses the same observation through the owner door, so provenance cannot be laundered', async () => {
    const core = await bootCore()
    await sendContext(core, 'context.scope.activate', { scope: CONV_A })

    // A payload claiming an observed window as the owner's own selection is
    // refused by the kind/source table — the pairing `active_window` +
    // `owner_selection` does not exist — before the store holds anything.
    const claimed = await sendContext(core, 'context.admit', {
      kind: 'active_window',
      channel: 'owner_selection',
      scope: CONV_A,
      content: 'the frontmost app is Code Editor',
      originId: 'fake-window:obs-0001',
    })
    expect(claimed.outcome.operation).toBe('refused')
    expect(claimed.outcome.ok).toBe(false)
    expect(claimed.outcome.reason).toBe(CONTEXT_ADMISSION_REASONS.source_not_permitted)
    expect(core.context().items).toEqual([])
    expect(core.context().counts.retained).toBe(0)
    expect(JSON.stringify(core.context())).not.toContain('Code Editor')
  })
})

/* ----------------------------------------------------------------- privacy */

describe('the private part stays where the store put it', () => {
  it('keeps the secret out of the view, the window’s words, the feeds and the journal', async () => {
    const core = await bootCore()
    await sendContext(core, 'context.scope.activate', { scope: CONV_9 })
    await admitSelection(core, CONV_9, CHAIN_SECRET, { label: 'the label a person typed' })

    const view = core.context()
    const row = view.items[0]
    if (row === undefined) throw new Error('expected one row')

    // Controls: the scanner works, and the secret really is held by Core.
    expect(JSON.stringify({ probe: CHAIN_SECRET })).toContain(CHAIN_SECRET)
    expect(row.contentLength).toBe(CHAIN_SECRET.length)
    expect(row.labelLength).toBe('the label a person typed'.length)

    expect(
      Object.keys(row).sort(),
    ).toEqual([
      'admittedAt',
      'capturedAt',
      'contentLength',
      'contextId',
      'expiresAt',
      'kind',
      'labelLength',
      'originId',
      'revokedAt',
      'scopeId',
      'scopeKind',
      'source',
      'state',
    ])
    const projection = windowWords(view)
    expect(JSON.stringify(view)).not.toContain(CHAIN_SECRET)
    expect(JSON.stringify(view)).not.toContain('the label a person typed')
    expect(JSON.stringify(projection)).not.toContain(CHAIN_SECRET)
    expect(JSON.stringify(projection)).not.toContain('the label a person typed')

    const activity = core.activity()
    expect(activity.length).toBeGreaterThan(0)
    expect(JSON.stringify(activity)).not.toContain(CHAIN_SECRET)
    for (const line of activity) {
      expect(Object.keys(line).sort()).toEqual([
        'at',
        'id',
        'kind',
        'sequence',
        'text',
        'tone',
        'type',
      ])
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
    expect(journal).not.toContain('the label a person typed')
  })

  it('has no context event family for that content to travel in', () => {
    expect(CORE_EVENT_TYPES.filter((type) => type.startsWith('context.'))).toEqual([])
  })
})

/* --------------------------------------------------------------- transport */

describe('the transport binds to the real facade and forwards, and writes nothing back', () => {
  it('binds a started Core by shape, in the vocabulary the window reads', async () => {
    const core = await bootCore()
    // The claim this lane used to encode as pending is now the plain truth.
    expect('context' in core).toBe(true)
    expect('onContext' in core).toBe(true)
    expect(isContextReportingCore(core)).toBe(true)

    const channel = new ContextChannel()
    channel.bind(core)
    const reported = channel.pull()
    expect(reported).not.toBeNull()
    expect(reported?.health).toBe('ready')
    expect(reported?.items).toEqual([])
    channel.close()

    const host = await bootHost()
    expect(host.context()).not.toBeNull()
    expect(host.context()?.health).toBe('ready')
  })

  it('reports one report per change, and the report is what a pull answers', async () => {
    const host = await bootHost()
    const seen: ContextProjection[] = []
    const dispose = host.onContext((projection) => seen.push(projection))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual(host.context())

    await sendContext(host, 'context.scope.activate', { scope: CONV_9 })
    await admitSelection(host, CONV_9, CHAIN_SECRET)
    expect(seen).toHaveLength(3)
    expect(seen.at(-1)?.counts.current).toBe(1)
    expect(seen.at(-1)).toEqual(host.context())

    await sendContext(host, 'context.revoke', {
      contextId: seen.at(-1)?.items[0]?.itemId ?? '',
      reason: 'the owner took it back',
    })
    expect(seen).toHaveLength(4)
    expect(seen.at(-1)?.items[0]?.state).toBe('revoked')
    expect(seen.at(-1)).toEqual(host.context())
    // Sequence moves with every report, so a window can prove which state it
    // is looking at.
    expect(seen.at(-1)?.sequence).toBeGreaterThan(seen[0]?.sequence ?? 0)

    dispose()
    await sendContext(host, 'context.scope.activate', { scope: CONV_B })
    expect(seen).toHaveLength(4)
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

/* ------------------------------------------------------------ idle + spend */

describe('the whole chain spends nothing', () => {
  it('makes zero model calls across every step it can take', async () => {
    const host = await bootHost()
    const windowProvider = new FakeActiveWindowProvider()
    await sendContext(host, 'context.status.read')
    await sendContext(host, 'context.scope.activate', { scope: CONV_9 })
    const admitted = await admitSelection(host, CONV_9, CHAIN_SECRET)
    await sendContext(host, 'context.reference.read', { term: 'this' })
    await sendContext(host, 'context.revoke', { contextId: admitted, reason: 'done with it' })
    await sendContext(host, 'context.revokeScope', {
      scope: CONV_9,
      reason: 'the conversation ended',
    })
    // The opt-in observation lane (#30/#42) joins the chain here: its composable
    // seam goes through the facade's host door, and it reaches no provider
    // either.
    const observed = new ContextIntegration({ now: () => new Date() })
    expect(observed.activateScope(CONV_A).operation).toBe('scope-activated')
    const observe = createActiveWindowFacadeAdmitter({ lane: observed, scope: CONV_A })
    expect(observe(windowProvider.info('Code Editor', null, new Date().toISOString())).operation).toBe(
      'admitted',
    )
    expect(toContextProjection(observed.read()).counts.current).toBe(1)
    // The window's vocabulary for all of that: the tombstone of what was
    // revoked is still listed — as revoked — and nothing is presented live.
    const projection = host.context()
    expect(projection).not.toBeNull()
    expect(projection?.items.every((item) => item.state !== 'live')).toBe(true)
    expect(projection?.counts).toEqual({
      items: 1,
      current: 0,
      expired: 0,
      revoked: 1,
      references: 0,
      unresolvedReferences: 0,
    })
    // The host already answers the window's vocabulary, so translating again
    // must be the identity — two translations would be two places deciding
    // what a window reads.
    expect(toContextProjection(projection as ContextProjection)).toBe(projection)

    expect(provider.calls).toBe(0)
    expect(host.status().activeProviderCalls).toBe(0)
    expect(host.status().sessionUsage.calls).toBe(0)
  })
})

/* -------------------------------------------------------- restart/degraded */

/** A journal that fails validation at line 1, as `integrity.test.ts` seeds it. */
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
  it('reports an ephemeral store as ephemeral and never durable', async () => {
    const core = await bootCore()
    expect(core.context().persistence.mode).toBe('ephemeral')
    expect(core.context().persistence.durable).toBe(false)
    expect(core.context().persistence.reason).toMatch(/no encrypted context store/)

    await sendContext(core, 'context.scope.activate', { scope: CONV_9 })
    await admitSelection(core, CONV_9, CHAIN_SECRET)
    expect(core.context().persistence.durable).toBe(false)
    expect(core.context().counts.retained).toBe(1)
  })

  it('loses the chain across a restart, and writes nothing to replay', async () => {
    const first = await bootCore()
    await sendContext(first, 'context.scope.activate', { scope: CONV_9 })
    await admitSelection(first, CONV_9, CHAIN_SECRET)
    await first.stop('chain-restart')

    const journal = await journalText(coreFile())
    expect(journal).toContain('"type":"core.started"')
    // Nothing about context was ever durable, so there is nothing to replay —
    // and nothing about context that could be replayed wrongly.
    expect(journal).not.toContain(CHAIN_SECRET)
    expect(journal).not.toMatch(/"type":"context\./)

    const second = await bootCore()
    expect(isContextReportingCore(second)).toBe(true)
    const view = second.context()
    expect(view.items).toEqual([])
    expect(view.counts.retained).toBe(0)
    expect(view.activeScope).toBeNull()
    expect(JSON.stringify(view)).not.toContain(CHAIN_SECRET)
    expect(JSON.stringify(second.activity())).not.toContain(CHAIN_SECRET)

    // A restart's context is a new, empty one: the reference refuses rather
    // than remembering what the previous process held.
    const answered = await sendContext(second, 'context.reference.read', { term: 'this' })
    expect(answered.outcome.operation).toBe('unresolved-no-active-scope')
    expect(answered.outcome.candidateIds).toEqual([])
  })

  it('a degraded Core fabricates nothing and refuses every command with its own sentence', async () => {
    const path = join(dir, 'degraded.jsonl')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      journalLine(1, 'core.started', {
        version: '0.1.0',
        storeKind: 'jsonl',
        recoveredSequence: 0,
      }) + '{"eventId":"evt-bad","sequence":2,"type":"core.ready","schemaVersion":1}\n',
    )

    const degraded = await bootCore(path)
    expect(degraded.status().lifecycle).toBe('degraded')

    // The Context domain is in-memory state the journal never held: what a
    // degraded Core reports is *nothing held*, not a restored or invented
    // frame, and no context outcome at all accompanies the refusal.
    const view = degraded.context()
    expect(view.items).toEqual([])
    expect(view.counts.retained).toBe(0)
    expect(view.persistence.durable).toBe(false)
    expect(JSON.stringify(view)).not.toContain(CHAIN_SECRET)

    const attempted = await degraded.handleCommand({
      command: 'context.admit',
      requestId: 'd-1',
      payload: { kind: 'explicit_selection', channel: 'owner_selection', scope: CONV_9, content: CHAIN_SECRET },
    })
    expect(attempted.ok).toBe(false)
    expect(attempted.refusal?.reason).toMatch(/degraded/)
    expect(attempted.context).toBeUndefined()
    expect(degraded.context().items).toEqual([])

    const host = await bootHost(path)
    expect(host.status().lifecycle).toBe('degraded')
    const reported = host.context()
    expect(reported).not.toBeNull()
    expect(reported?.items).toEqual([])
    expect(reported?.counts).toEqual({
      items: 0,
      current: 0,
      expired: 0,
      revoked: 0,
      references: 0,
      unresolvedReferences: 0,
    })
    const pushed: ContextProjection[] = []
    host.onContext((projection) => pushed.push(projection))
    expect(pushed).toHaveLength(1)
    expect(pushed[0]?.items).toEqual([])
  })
})
