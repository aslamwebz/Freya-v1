// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { EncryptedPersonalityStore } from '../../../../core/personality/persistence/encrypted-store'
import { EphemeralPersonalityStore } from '../../../../core/personality/persistence/ephemeral-store'
import { openPersonalityPersistence } from '../../../../core/personality/persistence/open'
import { emptyPersonalitySnapshot, orderedPersonalityItems, retirePersonalityItem } from '../../../../core/personality/persistence/recovery'
import { PersonalityPersistenceRuntime } from '../../../../core/personalityPersistence'
import {
  beginScratch,
  endScratch,
  secretItem,
  snapshotOf,
  storePath,
  testPersonalityKey,
  writeSnapshot,
} from './fixture'

beforeAll(async () => {
  await beginScratch()
})

afterAll(async () => {
  await endScratch()
})

describe('restart recovery', () => {
  it('recovers items after a restart', async () => {
    const path = storePath()
    const item = secretItem()
    await writeSnapshot(path, snapshotOf(item))

    const store = await EncryptedPersonalityStore.open({ path, key: testPersonalityKey() })
    const loaded = await store.load()
    expect(loaded.ok).toBe(true)
    if (loaded.ok) {
      expect(loaded.snapshot.items).toHaveLength(1)
      expect(loaded.snapshot.items[0]?.itemId).toBe(item.itemId)
      expect(loaded.snapshot.items[0]?.text).toBe(item.text)
    }
    await store.close()
  })

  it('recovers the ledger after a restart', async () => {
    const path = storePath()
    const item = secretItem()
    const snapshot = {
      ...snapshotOf(item),
      ledger: {
        schemaVersion: 1,
        maxEntries: 64,
        entries: [{ cueHash: 'abc123', kind: 'greeting' as const, lastUsedAt: '2026-06-01T09:00:00.000Z', uses: 3 }],
      },
    }
    await writeSnapshot(path, snapshot)

    const store = await EncryptedPersonalityStore.open({ path, key: testPersonalityKey() })
    const loaded = await store.load()
    expect(loaded.ok).toBe(true)
    if (loaded.ok) {
      expect(loaded.snapshot.ledger.entries).toHaveLength(1)
      expect(loaded.snapshot.ledger.entries[0]?.cueHash).toBe('abc123')
    }
    await store.close()
  })

  it('returns an empty snapshot when the store is new', async () => {
    const path = storePath()
    const store = await EncryptedPersonalityStore.open({ path, key: testPersonalityKey() })
    const loaded = await store.load()
    expect(loaded.ok).toBe(true)
    if (loaded.ok) {
      expect(loaded.snapshot.items).toHaveLength(0)
    }
    await store.close()
  })

  it('orders items deterministically by admission time then id', async () => {
    const path = storePath()
    const item1 = secretItem({ itemId: 'item-1' }, '2026-06-01T09:00:00.000Z')
    const item2 = secretItem({ itemId: 'item-2' }, '2026-06-01T08:00:00.000Z')
    const item3 = secretItem({ itemId: 'item-3' }, '2026-06-01T09:00:00.000Z')
    await writeSnapshot(path, snapshotOf(item1, item2, item3))

    const store = await EncryptedPersonalityStore.open({ path, key: testPersonalityKey() })
    const loaded = await store.load()
    expect(loaded.ok).toBe(true)
    if (loaded.ok) {
      const ordered = orderedPersonalityItems(loaded.snapshot)
      expect(ordered.map((i) => i.itemId)).toEqual(['item-2', 'item-1', 'item-3'])
    }
    await store.close()
  })
})

describe('retirement and withdrawal', () => {
  it('destroys text when an item is retired', () => {
    const item = secretItem()
    const retired = retirePersonalityItem(item, {
      now: '2026-06-02T09:00:00.000Z',
      reason: 'owner-withdrew-this-record',
    })
    expect(retired.text).toBe('')
    expect(retired.status).toBe('retired')
    expect(retired.itemId).toBe(item.itemId)
    expect(retired.kind).toBe(item.kind)
    expect(retired.key).toBe(item.key)
  })

  it('keeps retirement across a restart', async () => {
    const path = storePath()
    const item = secretItem()
    const retired = retirePersonalityItem(item, {
      now: '2026-06-02T09:00:00.000Z',
      reason: 'owner-withdrew-this-record',
    })
    await writeSnapshot(path, snapshotOf(retired))

    const store = await EncryptedPersonalityStore.open({ path, key: testPersonalityKey() })
    const loaded = await store.load()
    expect(loaded.ok).toBe(true)
    if (loaded.ok) {
      expect(loaded.snapshot.items).toHaveLength(1)
      expect(loaded.snapshot.items[0]?.text).toBe('')
      expect(loaded.snapshot.items[0]?.status).toBe('retired')
    }
    await store.close()
  })

  it('does not resurrect retired text on recovery', async () => {
    const path = storePath()
    const item = secretItem()
    const retired = retirePersonalityItem(item, {
      now: '2026-06-02T09:00:00.000Z',
      reason: 'owner-withdrew-this-record',
    })
    await writeSnapshot(path, snapshotOf(retired))

    const store = await EncryptedPersonalityStore.open({ path, key: testPersonalityKey() })
    const loaded = await store.load()
    expect(loaded.ok).toBe(true)
    if (loaded.ok) {
      const recovered = loaded.snapshot.items[0]
      expect(recovered?.text).toBe('')
      expect(recovered?.status).toBe('retired')
    }
    await store.close()
  })
})

describe('degraded mode', () => {
  it('reports durable: false when there is no key', async () => {
    const port = await openPersonalityPersistence({ path: storePath(), key: null })
    expect(port.mode).toBe('ephemeral')
    expect(port.durable).toBe(false)
    expect(port.durabilityReason).not.toBeNull()
    const loaded = await port.load()
    expect(loaded.ok).toBe(true)
    if (loaded.ok) {
      expect(loaded.snapshot.items).toHaveLength(0)
    }
    await port.close()
  })

  it('refuses to commit in ephemeral mode', async () => {
    const port = new EphemeralPersonalityStore({ durabilityReason: 'no key available' })
    await expect(port.commit(emptyPersonalitySnapshot())).rejects.toMatchObject({ code: 'unavailable' })
    await port.close()
  })

  it('reports degraded when the store is damaged', async () => {
    const path = storePath()
    await writeSnapshot(path, snapshotOf(secretItem()))

    const store = await EncryptedPersonalityStore.open({ path, key: testPersonalityKey() })
    expect(store.faultReason).toBeNull()
    await store.close()
  })
})

describe('runtime health', () => {
  it('reports encrypted and durable when a key is available', async () => {
    const path = storePath()
    const { runtime } = await PersonalityPersistenceRuntime.open({
      path,
      key: testPersonalityKey(),
      now: new Date(),
    })
    const health = runtime.health()
    expect(health.mode).toBe('encrypted')
    expect(health.durable).toBe(true)
    expect(health.reason).toBeNull()
    await runtime.close()
  })

  it('reports ephemeral and not durable when there is no key', async () => {
    const path = storePath()
    const { runtime } = await PersonalityPersistenceRuntime.open({
      path,
      key: null,
      now: new Date(),
    })
    const health = runtime.health()
    expect(health.mode).toBe('ephemeral')
    expect(health.durable).toBe(false)
    expect(health.reason).not.toBeNull()
    await runtime.close()
  })
})
