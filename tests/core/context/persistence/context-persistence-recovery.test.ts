// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { resolveContextReference } from '../../../../core/context/reference'
import { CONTEXT_SNAPSHOT_VERSION, type ContextSnapshot } from '../../../../core/context/persistence/port'
import {
  contextSnapshotRecord,
  orderedContextSnapshotRecords,
  retireContextSnapshot,
} from '../../../../core/context/persistence/recovery'
import { EncryptedContextStore } from '../../../../core/context/persistence/encrypted-store'
import type { ContextItem, ContextResolution, ContextScope } from '../../../../core/context/types'
import {
  CONTEXT_SENTINEL,
  CONTEXT_SENTINEL_LABEL,
  at,
  beginScratch,
  contextStore,
  conversation,
  endScratch,
  readSnapshot,
  refusal,
  secretItem,
  snapshotOf,
  storePath,
  surface,
  testContextKey,
  T0,
  writeSnapshot,
} from './fixture'

/**
 * Restart, and what survives it.
 *
 * Recovery is only worth having if what comes back is *true*. So these assertions
 * never check that a value round-tripped — they check the domain's own verdicts
 * over the recovered records, at instants chosen to sit either side of a TTL and
 * either side of a revocation:
 *
 *  - an item that expired while the process was down must be `expired` afterwards,
 *    with its content destroyed — not quietly live again, because the file said so;
 *  - an item a person took back must be `revoked`, with the stated reason intact,
 *    so a later "this" answers `revoked` instead of pretending nothing was shared;
 *  - scope must be the *item's* scope and nothing wider, so one conversation's
 *    context cannot surface in another's after a restart;
 *  - the current scope must **not** come back, because "here" pointing at a
 *    conversation that is over is a guess, not a recovery;
 *  - retention is bounded on disk exactly as it is in memory, and a purge that
 *    happened before the restart must still have happened after it.
 */

let path = ''

beforeAll(async () => {
  await beginScratch()
})

beforeEach(() => {
  // A fresh path per test, made by string and not by a temp directory: the store
  // creates its own directory, so isolation costs no filesystem work.
  path = storePath()
})

afterAll(async () => {
  await endScratch()
})

/** Recover, or fail the test with the store's own words. */
async function recover(): Promise<ContextSnapshot> {
  const loaded = await readSnapshot(path)
  if (!loaded.ok) throw new Error(`recovery refused (${loaded.code}): ${loaded.reason}`)
  return loaded.snapshot
}

/** A store holding one private selection and one shared tab in another conversation. */
function twoConversations(): { secret: ContextItem; tab: ContextItem } {
  const store = contextStore()
  const secret = secretItem(store)
  const tab = secretItem(store, {
    kind: 'shared_tab',
    source: 'owner_share',
    content: 'https://example.test/a-tab-somebody-shared',
    label: 'a shared tab',
    uri: null,
    scope: conversation('c2'),
    ttlMs: 20 * 60_000,
  })
  return { secret, tab }
}

/** What the domain's own resolver says about a recovered set. */
function resolve(
  snapshot: ContextSnapshot,
  scope: ContextScope,
  now: Date,
  term: 'this' | 'here' = 'this',
): ContextResolution {
  return resolveContextReference({ term }, snapshot.records, scope, now)
}

describe('a restart gives back exactly what was true', () => {
  it('restores scope, provenance, TTL and measurements unchanged', async () => {
    const { secret, tab } = twoConversations()
    await writeSnapshot(path, snapshotOf(secret, tab))

    const recovered = await recover()
    expect(recovered.records).toEqual([secret, tab])

    const restored = contextSnapshotRecord(recovered, secret.contextId)
    expect(restored?.scope).toEqual(conversation('c1'))
    expect(restored?.provenance).toEqual({ source: 'owner_selection', capturedAt: T0.toISOString(), originId: null })
    expect(restored?.expiresAt).toBe(secret.expiresAt)
    expect(restored?.admittedAt).toBe(secret.admittedAt)
    // The measured lengths are what let audit still report the *size* of a
    // destroyed selection without holding a character of it.
    expect(restored?.contentLength).toBe(CONTEXT_SENTINEL.length)
    expect(restored?.labelLength).toBe(CONTEXT_SENTINEL_LABEL.length)
  })

  it('restores an origin that a host-reported source had to name', async () => {
    // `host_report` content is only admissible when it names the record it came
    // from, and that pairing is the whole point of the provenance table. If the
    // origin did not survive the round trip, a host report would come back as a
    // bare assertion.
    const store = contextStore()
    const reported = secretItem(store, {
      kind: 'file',
      source: 'host_report',
      originId: 'grant-4711',
      capturedAt: new Date(T0.getTime() - 60_000).toISOString(),
    })
    await writeSnapshot(path, snapshotOf(reported))

    const recovered = await recover()
    expect(recovered.records[0]?.provenance).toEqual({
      source: 'host_report',
      capturedAt: new Date(T0.getTime() - 60_000).toISOString(),
      originId: 'grant-4711',
    })
  })

  it('gives back a revoked item as revoked, with its stated reason', async () => {
    const store = contextStore()
    const item = secretItem(store)
    const revokedAt = at(60_000).toISOString()
    const retired = { ...item, content: '', label: '', uri: null, revokedAt, revocationReason: 'the owner took it back' }
    await writeSnapshot(path, snapshotOf(retired as ContextItem))

    const recovered = await recover()
    const restored = contextSnapshotRecord(recovered, item.contextId)
    expect(restored?.revokedAt).toBe(revokedAt)
    expect(restored?.revocationReason).toBe('the owner took it back')
    expect(restored?.content).toBe('')

    // The verdict is the point: "you took it back" must not degrade into "you
    // never shared anything", because those are different facts to a person.
    expect(refusal(resolve(recovered, conversation('c1'), at(120_000)))).toEqual({
      reason: 'revoked',
      candidateIds: [item.contextId],
    })
  })

  it('gives back an expired item as expired, and destroys what outlived its TTL', async () => {
    const { secret } = twoConversations()
    await writeSnapshot(path, snapshotOf(secret))

    // Restart after the TTL has passed. Nothing observed the store while it was
    // down, so the words are still in the file — and recovery must not hand them
    // to a caller as though they were live.
    const recovered = await recover()
    const fresh = contextSnapshotRecord(recovered, secret.contextId)
    expect(fresh?.content).toBe(CONTEXT_SENTINEL)
    expect(refusal(resolve(recovered, conversation('c1'), at(11 * 60_000))).reason).toBe('expired')

    // `expiresAt` is a death instant: at the boundary the item is already gone.
    expect(refusal(resolve(recovered, conversation('c1'), at(10 * 60_000))).reason).toBe('expired')
    expect(resolve(recovered, conversation('c1'), at(10 * 60_000 - 1)).ok).toBe(true)

    const retired = retireContextSnapshot(recovered, at(11 * 60_000))
    const gone = contextSnapshotRecord(retired, secret.contextId)
    expect(gone?.content).toBe('')
    expect(gone?.label).toBe('')
    expect(gone?.uri).toBeNull()
    // The measurement survives destruction, so audit can still say how big it was.
    expect(gone?.contentLength).toBe(CONTEXT_SENTINEL.length)
    expect(JSON.stringify(retired)).not.toContain('settlement-offer')
    expect(JSON.stringify(retired)).not.toContain('file:///')
  })

  it('retires nothing at an instant that is not a time', async () => {
    const { secret } = twoConversations()
    await writeSnapshot(path, snapshotOf(secret))
    const recovered = await recover()
    // A clock that is not a clock must not destroy anything — the same rule the
    // domain applies when it refuses to judge anything live.
    const unchanged = retireContextSnapshot(recovered, new Date(Number.NaN))
    expect(contextSnapshotRecord(unchanged, secret.contextId)?.content).toBe(CONTEXT_SENTINEL)
  })

  it('keeps a revocation a revocation after its TTL has also passed', async () => {
    // A human act outranks a clock tick: "you took it back" does not become "it
    // expired" just because enough time went by while nobody was looking.
    const store = contextStore()
    const item = secretItem(store)
    await writeSnapshot(
      path,
      snapshotOf({
        ...item,
        content: '',
        label: '',
        uri: null,
        revokedAt: at(60_000).toISOString(),
        revocationReason: 'taken back',
      } as ContextItem),
    )
    const recovered = await recover()
    expect(refusal(resolve(recovered, conversation('c1'), at(60 * 60_000))).reason).toBe('revoked')
  })
})

describe('a restart restores no scope but the items', () => {
  it('does not bring the current scope back with it', async () => {
    const { secret } = twoConversations()
    await writeSnapshot(path, snapshotOf(secret))
    const recovered = await recover()

    // The *current* scope is live session state, not retained context. Restoring
    // it would point "here" at a conversation that is no longer happening, on the
    // strength of a file. So recovery returns records and no scope, and the
    // resolver refuses `here` until a caller declares where it is.
    expect(resolveContextReference({ term: 'here' }, recovered.records, null, at(1_000))).toEqual({
      ok: false,
      reason: 'no_active_scope',
      candidateIds: [],
    })
    // Each item keeps *its own* scope, which is the other half of the rule.
    expect(contextSnapshotRecord(recovered, secret.contextId)?.scope).toEqual(conversation('c1'))
  })

  it('does not let one conversation reach another after a restart', async () => {
    const { secret, tab } = twoConversations()
    await writeSnapshot(path, snapshotOf(secret, tab))
    const recovered = await recover()

    // Both items are back; only the one shared into this conversation is a
    // candidate. The other's id is not even named, in either direction — a
    // refusal must not confirm that another conversation's context exists.
    const here = resolve(recovered, conversation('c1'), at(1_000))
    expect(here.ok).toBe(true)
    if (!here.ok) throw new Error('expected a resolution')
    expect(here.item.contextId).toBe(secret.contextId)

    const there = resolve(recovered, conversation('c2'), at(1_000))
    expect(there.ok).toBe(true)
    if (!there.ok) throw new Error('expected a resolution')
    expect(there.item.contextId).toBe(tab.contextId)

    // A conversation that holds nothing gets nothing, and is told nothing about
    // what the other two hold.
    expect(refusal(resolve(recovered, conversation('c3'), at(1_000)))).toEqual({
      reason: 'no_candidates',
      candidateIds: [],
    })
  })

  it('resolves a surface scope from disk as exactly that scope', async () => {
    const store = contextStore()
    const shared = secretItem(store, { scope: surface('s1'), label: 'a shared surface' })
    await writeSnapshot(path, snapshotOf(shared))
    const recovered = await recover()
    expect(resolve(recovered, surface('s1'), at(1_000)).ok).toBe(true)
    expect(refusal(resolve(recovered, conversation('c1'), at(1_000))).reason).toBe('no_candidates')
  })
})

describe('retention and purge survive a restart', () => {
  it('keeps the bounded set bounded on disk, and forgets what was purged', async () => {
    const store = contextStore({ maxItems: 3 })
    const items = [
      secretItem(store, { content: 'first selection' }),
      secretItem(store, { content: 'second selection' }),
      secretItem(store, { content: 'third selection' }),
    ]
    await writeSnapshot(path, snapshotOf(...items))
    expect(orderedContextSnapshotRecords(await recover())).toHaveLength(3)

    // A purge before the restart: two live items stay, one tombstone is forgotten.
    const kept = items.slice(1)
    await writeSnapshot(path, snapshotOf(kept[0] as ContextItem, kept[1] as ContextItem))

    const recovered = await recover()
    expect(orderedContextSnapshotRecords(recovered).map((item) => item.content)).toEqual([
      'second selection',
      'third selection',
    ])
  })

  it('refuses to write more records than this build retains', async () => {
    // The port carries its own limits, independent of the domain's, so a caller
    // who bypasses the domain store still cannot make the file grow for ever.
    const store = await EncryptedContextStore.open({
      path,
      key: testContextKey(),
      limits: { maxItems: 4 },
    })
    const domain = contextStore({ maxItems: 4 })
    const items = Array.from({ length: 5 }, (_, index) =>
      secretItem(domain, { content: `selection ${index}` }),
    )
    await expect(store.commit({ v: CONTEXT_SNAPSHOT_VERSION, records: items })).rejects.toMatchObject({
      code: 'invalid',
    })
    expect((await readFile(path, 'utf8')).trim()).toBe('')
    await store.close()
  })

  it('refuses to recover a file holding more records than this build retains', async () => {
    const store = contextStore({ maxItems: 3 })
    const items = Array.from({ length: 3 }, (_, index) =>
      secretItem(store, { content: `selection ${index}` }),
    )
    await writeSnapshot(path, snapshotOf(...items))

    // Reopening with a smaller bound than the file was written under: the store
    // says so rather than silently keeping the first N and calling it recovery.
    const reopened = await EncryptedContextStore.open({
      path,
      key: testContextKey(),
      limits: { maxItems: 2 },
    })
    const loaded = await reopened.load()
    expect(loaded.ok).toBe(false)
    if (!loaded.ok) expect(loaded.reason).toMatch(/at most 2/)
    await reopened.close()
  })

  it('recovers the same records, in the same order, every time', async () => {
    const store = contextStore()
    const items = [
      secretItem(store, { content: 'one' }),
      secretItem(store, { content: 'two' }),
      secretItem(store, { content: 'three' }),
    ]
    // Admitted at the same instant, so only the id can order them — which is
    // exactly the case where a Map's iteration order would leak into the file.
    await writeSnapshot(path, snapshotOf(items[2] as ContextItem, items[0] as ContextItem, items[1] as ContextItem))

    const first = orderedContextSnapshotRecords(await recover()).map((item) => [
      item.contextId,
      item.content,
    ])
    const second = orderedContextSnapshotRecords(await recover()).map((item) => [
      item.contextId,
      item.content,
    ])
    expect(first).toEqual(second)
    expect(first.map(([, content]) => content)).toEqual(['one', 'two', 'three'])

    // And re-committing a recovered snapshot is idempotent in what it recovers.
    await writeSnapshot(path, snapshotOf(...[items[0] as ContextItem, items[1] as ContextItem, items[2] as ContextItem]))
    expect(orderedContextSnapshotRecords(await recover()).map((item) => item.contextId)).toEqual(
      first.map(([id]) => id),
    )
  })
})

describe('recovery refuses a snapshot it could not have written', () => {
  it('writes the version this build reads, whatever the caller passed', async () => {
    const { secret } = twoConversations()
    await writeSnapshot(path, snapshotOf(secret))
    const store = await EncryptedContextStore.open({ path, key: testContextKey() })
    // A commit is normalised rather than obeyed: a caller cannot write a version
    // this build would then refuse to read back.
    await store.commit({ v: 99 as typeof CONTEXT_SNAPSHOT_VERSION, records: [secret] })
    await store.close()

    const recovered = await recover()
    expect(recovered.v).toBe(CONTEXT_SNAPSHOT_VERSION)
    expect(recovered.records).toEqual([secret])
  })

  it('refuses a commit that is not a snapshot at all', async () => {
    const store = await EncryptedContextStore.open({ path, key: testContextKey() })
    await expect(store.commit(null as never)).rejects.toMatchObject({ code: 'invalid' })
    await expect(store.commit({ v: CONTEXT_SNAPSHOT_VERSION } as never)).rejects.toMatchObject({
      code: 'invalid',
    })
    await store.close()
  })

  it('refuses an empty path rather than writing somewhere undefined', async () => {
    await expect(
      EncryptedContextStore.open({ path: '', key: testContextKey() }),
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  it('refuses to write after close, and to read from a closed store', async () => {
    const { secret } = twoConversations()
    const store = await EncryptedContextStore.open({ path, key: testContextKey() })
    await store.commit(snapshotOf(secret))
    await store.close()

    await expect(store.commit(snapshotOf(secret))).rejects.toMatchObject({ code: 'unavailable' })
    expect(await store.load()).toMatchObject({ ok: false, code: 'closed' })
  })

  it('leaves the file exactly as it was when a commit is refused', async () => {
    const { secret } = twoConversations()
    await writeSnapshot(path, snapshotOf(secret))
    const before = await readFile(path, 'utf8')

    const store = await EncryptedContextStore.open({ path, key: testContextKey() })
    await store.commit(snapshotOf({ ...secret, content: 'x'.repeat(9_000) } as ContextItem)).catch(() => undefined)
    await store.close()
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('never leaves a half-written file for the next process to find', async () => {
    // A temp-then-rename write: the file on disk is either the old one or the new
    // one. There is no third state in which a person would read a truncated store
    // as "all your context is gone".
    const store = contextStore()
    const first = secretItem(store, { content: 'the first selection' })
    const second = secretItem(store, { content: 'the second selection' })
    const open = await EncryptedContextStore.open({ path, key: testContextKey() })
    await open.commit(snapshotOf(first))
    await open.commit(snapshotOf(first, second))
    await open.close()

    const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
    expect((await recover()).records).toHaveLength(2)
  })

  it('serialises concurrent writers so no commit is lost', async () => {
    // Two stores open on one file, each committing a whole snapshot. Whoever
    // writes last wins whole — the retained set on disk is always one store's
    // view and never a mixture of two.
    const domain = contextStore()
    const first = secretItem(domain, { content: 'the first selection' })
    const second = secretItem(domain, { content: 'the second selection' })

    const a = await EncryptedContextStore.open({ path, key: testContextKey() })
    const b = await EncryptedContextStore.open({ path, key: testContextKey() })
    await Promise.all([a.commit(snapshotOf(first)), b.commit(snapshotOf(second))])
    await Promise.all([a.close(), b.close()])

    const recovered = await recover()
    expect(recovered.records).toHaveLength(1)
    expect(['the first selection', 'the second selection']).toContain(recovered.records[0]?.content)
  })
})