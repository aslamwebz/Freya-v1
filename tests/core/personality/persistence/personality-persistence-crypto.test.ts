// @vitest-environment node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createCipheriv, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  EncryptedPersonalityStore,
  PERSONALITY_CRYPTO_DOMAIN,
  personalityRecordAad,
  personalityStoreBinding,
} from '../../../../core/personality/persistence/encrypted-store'
import { EncryptedContextStore } from '../../../../core/context/persistence/encrypted-store'
import {
  BRAIN_KEY_SEED,
  CONTEXT_KEY_SEED,
  CONVERSATION_KEY_SEED,
  MISSION_KEY_SEED,
  PERSONALITY_SENTINEL,
  PERSONALITY_SENTINEL_KEY,
  beginScratch,
  endScratch,
  foreignKey,
  namesBeside,
  openWith,
  secretItem,
  snapshotOf,
  storePath,
  testPersonalityKey,
  writeSnapshot,
} from './fixture'

const NONCE_BYTES = 12

beforeAll(async () => {
  await beginScratch()
})

afterAll(async () => {
  await endScratch()
})

async function oneSecret() {
  return secretItem()
}

describe('personality content is never written in the clear', () => {
  it('leaves no trace of the sentinel anywhere in the store file', async () => {
    const path = storePath()
    await writeSnapshot(path, snapshotOf(await oneSecret()))
    const raw = await readFile(path, 'utf8')

    expect(raw.length).toBeGreaterThan(0)
    expect(raw).not.toContain(PERSONALITY_SENTINEL)
    expect(raw).not.toContain('FREYA_RED_TEAM_PERSONALITY_SECRET_A7C3')
    expect(raw).not.toContain('offshore account')
    expect(raw).not.toContain(PERSONALITY_SENTINEL_KEY)
  })

  it('holds no plaintext record fields, only an id and ciphertext', async () => {
    const path = storePath()
    const item = await oneSecret()
    await writeSnapshot(path, snapshotOf(item))
    const raw = await readFile(path, 'utf8')
    const line = JSON.parse(raw.split('\n').filter(Boolean)[0] ?? '') as Record<string, unknown>

    expect(Object.keys(line).sort()).toEqual(['cipher', 'itemId', 'nonce', 'tag', 'v'])
    expect(line['itemId']).toBe(item.itemId)
    expect(typeof line['cipher']).toBe('string')
  })

  it('writes exactly one file, with nothing left behind beside it', async () => {
    const path = storePath()
    await writeSnapshot(path, snapshotOf(await oneSecret()))
    const files = await namesBeside(path)
    expect(files).toEqual(['personality.enc'])
  })

  it('re-encrypts under a fresh nonce, so identical content differs on disk', async () => {
    const path = storePath()
    const item = await oneSecret()
    await writeSnapshot(path, snapshotOf(item))
    const first = await readFile(path, 'utf8')
    await writeSnapshot(path, snapshotOf(item))
    const second = await readFile(path, 'utf8')

    expect(second).not.toBe(first)
    const nonceOf = (raw: string): string =>
      (JSON.parse(raw.split('\n').filter(Boolean)[0] ?? '') as { nonce: string }).nonce
    expect(nonceOf(second)).not.toBe(nonceOf(first))
    expect(Buffer.from(nonceOf(second), 'base64').length).toBe(NONCE_BYTES)
  })
})

describe('Personality is its own key domain', () => {
  it('cannot be opened by the Context, Brain, Mission or conversation key', async () => {
    const path = storePath()
    await writeSnapshot(path, snapshotOf(await oneSecret()))

    for (const seed of [CONTEXT_KEY_SEED, BRAIN_KEY_SEED, MISSION_KEY_SEED, CONVERSATION_KEY_SEED]) {
      const wrong = await EncryptedPersonalityStore.open({ path, key: foreignKey(seed) })
      expect(wrong.faultReason).toMatch(/failed authentication/i)
      const loaded = await wrong.load()
      expect(loaded.ok).toBe(false)
      if (!loaded.ok) expect(loaded.code).toBe('degraded')
      await wrong.close()
    }
  })

  it('cannot open a Context store, even at the same path with the Context key', async () => {
    const contextPath = storePath('shared.enc')
    const context = await EncryptedContextStore.open({ path: contextPath, key: foreignKey(CONTEXT_KEY_SEED) })
    await context.commit({
      v: 1,
      records: [{
        contextId: 'ctx-1',
        kind: 'file',
        provenance: { source: 'owner_selection', capturedAt: '2026-06-01T09:00:00.000Z', originId: null },
        scope: { scopeKind: 'conversation', scopeId: 'c1' },
        label: 'test',
        content: 'test content',
        uri: null,
        admittedAt: '2026-06-01T09:00:00.000Z',
        expiresAt: '2026-06-01T09:30:00.000Z',
        contentLength: 12,
        labelLength: 4,
        revokedAt: null,
        revocationReason: null,
      }],
    })
    await context.close()

    const asPersonality = await EncryptedPersonalityStore.open({
      path: contextPath,
      key: foreignKey(CONTEXT_KEY_SEED),
    })
    expect(asPersonality.faultReason).not.toBeNull()
    expect((await asPersonality.load()).ok).toBe(false)
    await asPersonality.close()
  })

  it('refuses a key of the wrong length rather than padding it', async () => {
    await expect(
      EncryptedPersonalityStore.open({ path: storePath(), key: new Uint8Array(16) }),
    ).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it('binds records to this file, so two stores cannot read each other', async () => {
    const path = storePath()
    const other = storePath('other.enc')
    const store = await openWith(path, snapshotOf(await oneSecret()))
    await openWith(other, snapshotOf(await oneSecret()))
    await store.close()

    const moved = await readFile(other, 'utf8')
    await writeFile(path, moved, 'utf8')
    const lifted = await EncryptedPersonalityStore.open({ path, key: testPersonalityKey() })
    expect(lifted.faultReason).toMatch(/failed authentication/i)
    await lifted.close()
  })
})

describe('a record cannot be re-labelled or altered', () => {
  it('refuses a record whose id in the header was changed', async () => {
    const path = storePath()
    const first = secretItem({ itemId: 'item-1' })
    const second = secretItem({ itemId: 'item-2', text: 'a second, different fact' })
    await writeSnapshot(path, snapshotOf(first, second))

    const raw = await readFile(path, 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    const tampered = lines[0]?.replace('item-1', 'item-2') ?? ''
    await writeFile(path, `${tampered}\n`)

    const tamperedStore = await EncryptedPersonalityStore.open({ path, key: testPersonalityKey() })
    expect(tamperedStore.faultReason).toMatch(/failed authentication/i)
    expect((await tamperedStore.load()).ok).toBe(false)
    await tamperedStore.close()
  })

  it('detects a flipped ciphertext bit through the authentication tag', async () => {
    const path = storePath()
    await writeSnapshot(path, snapshotOf(await oneSecret()))
    const raw = await readFile(path, 'utf8')
    const line = JSON.parse(raw.split('\n').filter(Boolean)[0] ?? '') as { cipher: string }
    const bytes = Buffer.from(line.cipher, 'base64')
    bytes[0] = bytes[0] === 0 ? 1 : 0
    await writeFile(path, `${JSON.stringify({ ...line, cipher: bytes.toString('base64') })}\n`)

    const tampered = await EncryptedPersonalityStore.open({ path, key: testPersonalityKey() })
    expect(tampered.faultReason).toMatch(/failed authentication/i)
    await tampered.close()
  })

  it('refuses a record whose nonce or tag is the wrong size', async () => {
    const path = storePath()
    await writeSnapshot(path, snapshotOf(await oneSecret()))
    const raw = await readFile(path, 'utf8')
    const line = JSON.parse(raw.split('\n').filter(Boolean)[0] ?? '') as { tag: string }
    await writeFile(path, `${JSON.stringify({ ...line, tag: line.tag.slice(0, 8) })}\n`)

    const damaged = await EncryptedPersonalityStore.open({ path, key: testPersonalityKey() })
    expect(damaged.faultReason).toMatch(/failed authentication|wrong nonce or tag/i)
    await damaged.close()
  })
})

describe('an authenticating record is still checked against the domain', () => {
  async function sealArbitrary(item: unknown, filePath: string): Promise<void> {
    const key = testPersonalityKey()
    const itemId = (item as { itemId: string }).itemId
    const nonce = randomBytes(NONCE_BYTES)
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(key), nonce)
    cipher.setAAD(Buffer.from(personalityRecordAad(personalityStoreBinding(key, filePath), itemId), 'utf8'))
    const encrypted = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(item), 'utf8')), cipher.final()])
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(
      filePath,
      `${JSON.stringify({
        v: 1,
        itemId,
        nonce: nonce.toString('base64'),
        cipher: encrypted.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
      })}\n`,
      'utf8',
    )
  }

  it('refuses a record that claims a kind this build does not know', async () => {
    const legal = secretItem()
    const path = storePath()
    await sealArbitrary({ ...legal, kind: 'unknown-kind' }, path)
    const store = await EncryptedPersonalityStore.open({ path, key: testPersonalityKey() })
    expect(store.faultReason).toMatch(/kind this build does not know/)
    expect((await store.load()).ok).toBe(false)
    await store.close()
  })

  it('refuses a retired record that still holds its text', async () => {
    const legal = secretItem()
    const path = storePath()
    await sealArbitrary({ ...legal, status: 'retired' }, path)
    const store = await EncryptedPersonalityStore.open({ path, key: testPersonalityKey() })
    expect(store.faultReason).toMatch(/still holds its text/)
    await store.close()
  })

  it('refuses a record from a future format version rather than guessing at it', async () => {
    const legal = secretItem()
    const path = storePath()
    await sealArbitrary({ ...legal }, path)
    const raw = await readFile(path, 'utf8')
    const line = JSON.parse(raw.trim()) as Record<string, unknown>
    await writeFile(path, `${JSON.stringify({ ...line, v: 99 })}\n`)

    const future = await EncryptedPersonalityStore.open({ path, key: testPersonalityKey() })
    expect(future.faultReason).toMatch(/version 99/)
    await future.close()
  })

  it('pins the domain label in the AAD, so the format cannot drift silently', () => {
    expect(PERSONALITY_CRYPTO_DOMAIN).toBe('freya.personality.v1')
    expect(personalityRecordAad('bnd', 'item-1')).toBe('freya.personality.v1|bnd|item-1')
    expect(personalityStoreBinding(testPersonalityKey(), '/a')).not.toBe(
      personalityStoreBinding(testPersonalityKey(), '/b'),
    )
  })
})
