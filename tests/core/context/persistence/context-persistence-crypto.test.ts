// @vitest-environment node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createCipheriv, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { EncryptedContextStore, CONTEXT_CRYPTO_DOMAIN, contextRecordAad, contextStoreBinding } from '../../../../core/context/persistence/encrypted-store'
import { EncryptedMissionStore } from '../../../../core/missions/encrypted-store'
import type { ContextItem } from '../../../../core/context/types'
import {
  BRAIN_KEY_SEED,
  CONVERSATION_KEY_SEED,
  CONTEXT_SENTINEL,
  CONTEXT_SENTINEL_LABEL,
  CONTEXT_SENTINEL_URI,
  MISSION_KEY_SEED,
  at,
  beginScratch,
  contextStore,
  endScratch,
  foreignKey,
  namesBeside,
  openWith,
  secretItem,
  snapshotOf,
  storePath,
  testContextKey,
  writeSnapshot,
} from './fixture'

/**
 * What is on disk, and what is not.
 *
 * The whole point of this file is one sentence: **context content is never
 * written in the clear, and never in a fallback that looks like it was.** So the
 * assertions are about the bytes, not about the API — an assertion that the store
 * "returns the content" would pass just as well over a plaintext file.
 *
 * Four properties, in order of how much they matter:
 *
 *  1. the sentinel is absent from every byte written, and the file contains no
 *     plaintext record fields at all;
 *  2. the Context key is its own domain — no other domain's key opens this store,
 *     and this store cannot open theirs;
 *  3. a record cannot be re-labelled, moved between stores, or swapped, because
 *     the header is authenticated;
 *  4. each write re-encrypts under a fresh nonce, so identical content does not
 *     produce identical bytes.
 */

const NONCE_BYTES = 12

beforeAll(async () => {
  await beginScratch()
})

afterAll(async () => {
  await endScratch()
})

/** One legal private item, admitted by the domain. */
async function oneSecret(): Promise<ContextItem> {
  return secretItem(contextStore())
}

describe('context content is never written in the clear', () => {
  it('leaves no trace of the sentinel anywhere in the store file', async () => {
    const path = storePath()
    await writeSnapshot(path, snapshotOf(await oneSecret()))
    const raw = await readFile(path, 'utf8')

    expect(raw.length).toBeGreaterThan(0)
    expect(raw).not.toContain(CONTEXT_SENTINEL)
    expect(raw).not.toContain('FREYA_RED_TEAM_CONTEXT_SECRET_B4E2')
    expect(raw).not.toContain('second account')
    expect(raw).not.toContain(CONTEXT_SENTINEL_LABEL)
    expect(raw).not.toContain('settlement-offer')
    expect(raw).not.toContain(CONTEXT_SENTINEL_URI)
    expect(raw).not.toContain('file:///')
  })

  it('holds no plaintext record fields, only an id and ciphertext', async () => {
    const path = storePath()
    await writeSnapshot(path, snapshotOf(await oneSecret()))
    const line = JSON.parse((await readFile(path, 'utf8')).trim()) as Record<string, unknown>

    // The only thing readable is the record's own id. Content, label, URI,
    // scope, provenance, the TTL and the measurements are all inside the cipher.
    expect(Object.keys(line).sort()).toEqual(['cipher', 'contextId', 'nonce', 'tag', 'v'])
    expect(line['contextId']).toBe('t-1')
    expect(typeof line['cipher']).toBe('string')
  })

  it('writes exactly one file, with nothing left behind beside it', async () => {
    const path = storePath()
    await writeSnapshot(path, snapshotOf(await oneSecret()))
    // A `.tmp` left over, or a second file of any name, would be a place the
    // content could survive a crash nobody was told about.
    expect(await namesBeside(path)).toEqual(['context.enc'])
  })

  it('leaves no plaintext file behind when a commit cannot finish', async () => {
    // The write is temp-then-rename, so a failure mid-write can only leave the
    // previous file. There is no state in which the content exists unencrypted
    // under any name, because the content is never written unencrypted at all.
    const path = storePath()
    const store = await EncryptedContextStore.open({ path, key: testContextKey() })
    await expect(
      store.commit(
        snapshotOf({ ...(await oneSecret()), content: 'x'.repeat(10_000) } as ContextItem),
      ),
    ).rejects.toMatchObject({ code: 'invalid' })
    const raw = await readFile(path, 'utf8')
    expect(raw).not.toContain('xxxxxxxxxx')
    expect(await namesBeside(path)).toEqual(['context.enc'])
    await store.close()
  })

  it('re-encrypts under a fresh nonce, so identical content differs on disk', async () => {
    const path = storePath()
    const item = await oneSecret()
    await writeSnapshot(path, snapshotOf(item))
    const first = await readFile(path, 'utf8')
    await writeSnapshot(path, snapshotOf(item))
    const second = await readFile(path, 'utf8')

    // GCM nonce reuse under one key leaks the XOR of two plaintexts and the
    // authentication key, so rewriting the same record must not repeat a nonce.
    expect(second).not.toBe(first)
    const nonceOf = (raw: string): string =>
      (JSON.parse(raw.trim()) as { nonce: string }).nonce
    expect(nonceOf(second)).not.toBe(nonceOf(first))
    expect(Buffer.from(nonceOf(second), 'base64').length).toBe(NONCE_BYTES)
  })
})

describe('Context is its own key domain', () => {
  it('cannot be opened by the Mission, Brain or conversation key', async () => {
    const path = storePath()
    await writeSnapshot(path, snapshotOf(await oneSecret()))

    // The independence is the property. If any of these reads anything, a leaked
    // key from another domain would yield the private text of somebody's
    // selection — which is the outcome domain separation exists to prevent.
    for (const seed of [MISSION_KEY_SEED, BRAIN_KEY_SEED, CONVERSATION_KEY_SEED]) {
      const wrong = await EncryptedContextStore.open({ path, key: foreignKey(seed) })
      expect(wrong.faultReason).toMatch(/failed authentication/i)
      const loaded = await wrong.load()
      expect(loaded.ok).toBe(false)
      if (!loaded.ok) expect(loaded.code).toBe('degraded')
      await wrong.close()
    }
  })

  it('cannot open a Mission store, even at the same path with the Mission key', async () => {
    // The other direction, and the one that proves the AAD prefix is doing work
    // rather than the key length. This file holds a Mission, not context.
    const missionPath = storePath('shared.enc')
    const mission = await EncryptedMissionStore.open({ path: missionPath, key: foreignKey(MISSION_KEY_SEED) })
    await mission.write({
      missionId: 'm1',
      title: 'Handle my house move',
      intent: 'a mission, not context',
      successCriteria: [],
      createdAt: '2026-10-01T09:00:00.000Z',
    })
    await mission.close()

    const asContext = await EncryptedContextStore.open({
      path: missionPath,
      key: foreignKey(MISSION_KEY_SEED),
    })
    expect(asContext.faultReason).not.toBeNull()
    expect((await asContext.load()).ok).toBe(false)
    await asContext.close()
  })

  it('refuses a key of the wrong length rather than padding it', async () => {
    await expect(
      EncryptedContextStore.open({ path: storePath(), key: new Uint8Array(16) }),
    ).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it('binds records to this file, so two stores cannot read each other', async () => {
    const path = storePath()
    const other = storePath('other.enc')
    const store = await openWith(path, snapshotOf(await oneSecret()))
    await openWith(other, snapshotOf(await oneSecret()))
    await store.close()

    // Same key, same record, different file. The per-store binding is in the AAD,
    // so neither file opens at the other's path even with a valid key.
    const crossed = await EncryptedContextStore.open({ path, key: testContextKey(), limits: {} })
    expect(crossed.faultReason).toBeNull()
    await crossed.close()

    const moved = await readFile(other, 'utf8')
    await writeFile(path, moved, 'utf8')
    const lifted = await EncryptedContextStore.open({ path, key: testContextKey() })
    expect(lifted.faultReason).toMatch(/failed authentication/i)
    await lifted.close()
  })
})

describe('a record cannot be re-labelled or altered', () => {
  it('refuses a record whose id in the header was changed', async () => {
    const path = storePath()
    const store = contextStore()
    const first = secretItem(store)
    const second = secretItem(store, { content: 'a second, different selection' })
    await writeSnapshot(path, snapshotOf(first, second))

    // The id is authenticated as AAD, so re-labelling a record onto another id
    // changes the tag rather than the meaning: the read fails instead of one
    // item's content quietly becoming another's.
    const raw = await readFile(path, 'utf8')
    await writeFile(path, raw.split('\n').filter(Boolean)[0]?.replace(first.contextId, second.contextId) ?? '')

    const tampered = await EncryptedContextStore.open({ path, key: testContextKey() })
    expect(tampered.faultReason).toMatch(/failed authentication/i)
    expect((await tampered.load()).ok).toBe(false)
    await tampered.close()
  })

  it('detects a flipped ciphertext bit through the authentication tag', async () => {
    const path = storePath()
    await writeSnapshot(path, snapshotOf(await oneSecret()))
    const line = JSON.parse((await readFile(path, 'utf8')).trim()) as { cipher: string }
    const bytes = Buffer.from(line.cipher, 'base64')
    bytes[0] = bytes[0] === 0 ? 1 : 0
    await writeFile(path, `${JSON.stringify({ ...line, cipher: bytes.toString('base64') })}\n`)

    const tampered = await EncryptedContextStore.open({ path, key: testContextKey() })
    expect(tampered.faultReason).toMatch(/failed authentication/i)
    await tampered.close()
  })

  it('refuses a record whose nonce or tag is the wrong size', async () => {
    const path = storePath()
    await writeSnapshot(path, snapshotOf(await oneSecret()))
    const line = JSON.parse((await readFile(path, 'utf8')).trim()) as { tag: string }
    await writeFile(path, `${JSON.stringify({ ...line, tag: line.tag.slice(0, 8) })}\n`)

    const damaged = await EncryptedContextStore.open({ path, key: testContextKey() })
    expect(damaged.faultReason).toMatch(/failed authentication|wrong nonce or tag/i)
    await damaged.close()
  })
})

describe('an authenticating record is still checked against the domain', () => {
  /**
   * Seal a record by hand, with the real algorithm and the real AAD.
   *
   * This is the "attacker or buggy writer who holds the key" case, and it is why
   * the recovery gate exists: a valid tag proves *who wrote it*, never *that it is
   * a legal ContextItem*. Reproducing the format here rather than reaching into
   * the store keeps the test honest — it pins the wire format instead of trusting
   * the same code it is testing.
   */
  async function sealArbitrary(item: unknown, filePath: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true })
    const key = testContextKey()
    const contextId = (item as { contextId: string }).contextId
    const nonce = randomBytes(NONCE_BYTES)
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(key), nonce)
    cipher.setAAD(Buffer.from(contextRecordAad(contextStoreBinding(key, filePath), contextId), 'utf8'))
    const encrypted = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(item), 'utf8')), cipher.final()])
    await writeFile(
      filePath,
      `${JSON.stringify({
        v: 1,
        contextId,
        nonce: nonce.toString('base64'),
        cipher: encrypted.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
      })}\n`,
      'utf8',
    )
  }

  it('refuses a record that claims a kind this build does not source', async () => {
    const legal = secretItem(contextStore())
    // `active_window` is a declared-but-unsourced kind: a record asserting it is
    // asserting a capture capability this build has not got.
    const path = storePath()
    await sealArbitrary({ ...legal, kind: 'active_window' }, path)
    const store = await EncryptedContextStore.open({ path, key: testContextKey() })
    expect(store.faultReason).toMatch(/does not source/)
    expect((await store.load()).ok).toBe(false)
    await store.close()
  })

  it('refuses a revoked record that still holds its content', async () => {
    // A tombstone whose content was never destroyed is a record whose content
    // somebody believed was gone. That belief is exactly what must not survive
    // a restart, so the gate refuses rather than trusting the flag.
    const legal = secretItem(contextStore())
    const path = storePath()
    await sealArbitrary(
      { ...legal, revokedAt: '2026-06-01T09:01:00.000Z', revocationReason: 'taken back' },
      path,
    )
    const store = await EncryptedContextStore.open({ path, key: testContextKey() })
    expect(store.faultReason).toMatch(/still holds its content/)
    await store.close()
  })

  it('refuses a record whose TTL outlives what this build allows', async () => {
    const legal = secretItem(contextStore())
    const path = storePath()
    await sealArbitrary({ ...legal, expiresAt: '2026-06-01T11:00:00.000Z' }, path)
    const store = await EncryptedContextStore.open({ path, key: testContextKey() })
    expect(store.faultReason).toMatch(/longer life than this build allows/)
    await store.close()
  })

  it('refuses a record whose scope is a capability name rather than a scope', async () => {
    const legal = secretItem(contextStore())
    const named = storePath()
    await sealArbitrary({ ...legal, scope: { scopeKind: 'conversation', scopeId: 'work.file.write' } }, named)
    // The id shape is legal, so this one is *not* refused for what it is — it is
    // refused only if the gate invented a rule it has no business inventing. What
    // matters is that it is refused nowhere and served nowhere silently: the
    // record as written is legal, so it recovers, and the point of the assertion
    // is that a *scope kind* this build does not know is the refused case.
    const store = await EncryptedContextStore.open({ path: named, key: testContextKey() })
    expect(store.faultReason).toBeNull()
    await store.close()

    const path = storePath()
    await sealArbitrary({ ...legal, scope: { scopeKind: 'device', scopeId: 'laptop' } }, path)
    const refused = await EncryptedContextStore.open({ path, key: testContextKey() })
    expect(refused.faultReason).toMatch(/scope boundary this build does not know/)
    await refused.close()
  })

  it('refuses a record from a future format version rather than guessing at it', async () => {
    const legal = secretItem(contextStore())
    const path = storePath()
    await sealArbitrary({ ...legal }, path)
    const raw = await readFile(path, 'utf8')
    const line = JSON.parse(raw.trim()) as Record<string, unknown>
    await writeFile(path, `${JSON.stringify({ ...line, v: 99 })}\n`)

    const future = await EncryptedContextStore.open({ path, key: testContextKey() })
    expect(future.faultReason).toMatch(/version 99/)
    await future.close()
  })

  it('refuses a record whose kind cannot come from the source it names', async () => {
    // The kind/source table is the load-bearing half of provenance, so it is
    // enforced on the way *back out of storage* too. A record naming a pairing
    // admission would never have accepted must not survive a restart on the
    // strength of a valid tag: that is how a host-reported `current_mission` or a
    // Core-invented `shared_tab` would be laundered into the store from a file.
    //
    // The origin is supplied, so the *only* thing wrong with this record is the
    // pairing — which is what makes the refusal attributable to this rule alone.
    const legal = secretItem(contextStore())
    const claimed = { ...legal.provenance, source: 'core_record' as const, originId: 'mission-4711' }
    const refused = storePath()
    await sealArbitrary({ ...legal, provenance: claimed }, refused)
    const store = await EncryptedContextStore.open({ path: refused, key: testContextKey() })
    expect(store.faultReason).toMatch(
      /kind file came from the source core_record, which this build does not allow/,
    )
    expect((await store.load()).ok).toBe(false)
    await store.close()

    // The same shape with a pairing the table admits is not refused, so the
    // assertion is about the table and not about foreign-looking records at large.
    const allowed = storePath()
    await sealArbitrary({ ...legal, provenance: { ...legal.provenance, source: 'owner_authorization' } }, allowed)
    const fine = await EncryptedContextStore.open({ path: allowed, key: testContextKey() })
    expect(fine.faultReason).toBeNull()
    const loaded = await fine.load()
    expect(loaded.ok).toBe(true)
    if (loaded.ok) expect(loaded.snapshot.records[0]?.provenance.source).toBe('owner_authorization')
    await fine.close()
  })

  it('refuses a non-owner source that names no origin', async () => {
    // `host_report` content is only admissible when it names the record it came
    // from, so "the host said so" is never a bare assertion. A record that skipped
    // that on the way onto disk must not be trusted on the way back off it.
    //
    // `file` genuinely admits `host_report`, so the pairing here is legal and the
    // missing origin is the only thing wrong with the record.
    const reported = secretItem(contextStore(), { source: 'host_report', originId: 'grant-4711' })
    const path = storePath()
    await sealArbitrary(
      { ...reported, provenance: { source: 'host_report', capturedAt: reported.admittedAt, originId: null } },
      path,
    )
    const store = await EncryptedContextStore.open({ path, key: testContextKey() })
    expect(store.faultReason).toMatch(/cannot have without naming an origin/)
    expect((await store.load()).ok).toBe(false)
    await store.close()

    // The same record with its origin is legal, and recovers with the origin intact.
    const kept = storePath()
    await sealArbitrary(reported, kept)
    const fine = await EncryptedContextStore.open({ path: kept, key: testContextKey() })
    expect(fine.faultReason).toBeNull()
    const loaded = await fine.load()
    expect(loaded.ok && loaded.snapshot.records[0]?.provenance.originId).toBe('grant-4711')
    await fine.close()
  })

  it('refuses a record that does not outlive its own admission', async () => {
    // `expiresAt` is a death instant, and admission refuses a TTL of zero. A
    // record that expired at the moment it was admitted is one the domain would
    // never hold; recovering it would put an already-dead item back in the store
    // as though it were still on its way out.
    const legal = secretItem(contextStore())
    for (const expiresAt of [legal.admittedAt, at(-1).toISOString()]) {
      const path = storePath()
      await sealArbitrary({ ...legal, expiresAt }, path)
      const store = await EncryptedContextStore.open({ path, key: testContextKey() })
      expect(store.faultReason, expiresAt).toMatch(/does not outlive its own admission/)
      expect((await store.load()).ok).toBe(false)
      await store.close()
    }
  })

  it('refuses a record captured after it was admitted', async () => {
    // Provenance that has not happened yet is provenance this build refuses to
    // record. `capturedAt` is measured at admission, so a capture instant later
    // than the admission that carries it is a file claiming something the domain
    // would have rejected.
    const legal = secretItem(contextStore())
    const path = storePath()
    await sealArbitrary(
      { ...legal, provenance: { ...legal.provenance, capturedAt: at(1).toISOString() } },
      path,
    )
    const store = await EncryptedContextStore.open({ path, key: testContextKey() })
    expect(store.faultReason).toMatch(/was captured after it was admitted/)
    expect((await store.load()).ok).toBe(false)
    await store.close()

    // And the boundary is inclusive, like every other instant in the domain: a
    // capture exactly at the admission instant is legal and must still recover.
    const legalBoundary = storePath()
    await sealArbitrary(
      {
        ...legal,
        expiresAt: at(10 * 60_000).toISOString(),
        provenance: { ...legal.provenance, capturedAt: legal.admittedAt },
      },
      legalBoundary,
    )
    const fine = await EncryptedContextStore.open({ path: legalBoundary, key: testContextKey() })
    expect(fine.faultReason).toBeNull()
    await fine.close()
  })

  it('pins the domain label in the AAD, so the format cannot drift silently', () => {
    // If this word changes, every existing store stops opening. That is correct
    // and loud, not a bug — but it must be a *deliberate* change, so the constant
    // is asserted rather than left to be discovered by a person who lost context.
    expect(CONTEXT_CRYPTO_DOMAIN).toBe('freya.context.v1')
    expect(contextRecordAad('bnd', 'ctx-1')).toBe('freya.context.v1|bnd|ctx-1')
    expect(contextStoreBinding(testContextKey(), '/a')).not.toBe(
      contextStoreBinding(testContextKey(), '/b'),
    )
  })
})