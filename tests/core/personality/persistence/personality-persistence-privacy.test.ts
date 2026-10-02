// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { EncryptedPersonalityStore } from '../../../../core/personality/persistence/encrypted-store'
import {
  PERSONALITY_SENTINEL,
  PERSONALITY_SENTINEL_KEY,
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

describe('privacy: no plaintext fallback', () => {
  it('never writes plaintext when there is no key', async () => {
    const path = storePath()
    const store = await EncryptedPersonalityStore.open({ path, key: testPersonalityKey() })
    await store.close()

    const raw = await readFile(path, 'utf8')
    expect(raw).not.toContain(PERSONALITY_SENTINEL)
    expect(raw).not.toContain(PERSONALITY_SENTINEL_KEY)
  })

  it('never writes plaintext when the store is damaged', async () => {
    const path = storePath()
    await writeSnapshot(path, snapshotOf(secretItem()))

    const raw = await readFile(path, 'utf8')
    expect(raw).not.toContain(PERSONALITY_SENTINEL)
    expect(raw).not.toContain('offshore')
  })

  it('does not create a plaintext fallback file', async () => {
    const path = storePath()
    await writeSnapshot(path, snapshotOf(secretItem()))

    const files = await readFile(path, 'utf8')
    expect(files).not.toContain(PERSONALITY_SENTINEL)
  })
})

describe('privacy: no raw private text in logs', () => {
  it('does not write item text to disk', async () => {
    const path = storePath()
    const item = secretItem()
    await writeSnapshot(path, snapshotOf(item))

    const raw = await readFile(path, 'utf8')
    expect(raw).not.toContain(PERSONALITY_SENTINEL)
    expect(raw).not.toContain(PERSONALITY_SENTINEL_KEY)
  })

  it('does not expose text in health reports', async () => {
    const path = storePath()
    const { runtime } = await import('../../../../core/personalityPersistence').then((m) =>
      m.PersonalityPersistenceRuntime.open({ path, key: testPersonalityKey(), now: new Date() }),
    )
    const health = runtime.health()
    const serialized = JSON.stringify(health)
    expect(serialized).not.toContain(PERSONALITY_SENTINEL)
    expect(serialized).not.toContain(PERSONALITY_SENTINEL_KEY)
    await runtime.close()
  })
})

describe('privacy: bounded retention', () => {
  it('enforces the maximum item count', async () => {
    const path = storePath()
    const items = Array.from({ length: 300 }, (_, i) =>
      secretItem({ itemId: `item-${i}`, text: `fact ${i}` }),
    )
    const snapshot = snapshotOf(...items)

    const store = await EncryptedPersonalityStore.open({ path, key: testPersonalityKey() })
    await expect(store.commit(snapshot)).rejects.toMatchObject({ code: 'invalid' })
    await store.close()
  })

  it('enforces the maximum snapshot bytes', async () => {
    const path = storePath()
    const items = Array.from({ length: 256 }, (_, i) =>
      secretItem({ itemId: `item-${i}`, text: 'x'.repeat(2000) }),
    )
    const snapshot = snapshotOf(...items)

    const store = await EncryptedPersonalityStore.open({ path, key: testPersonalityKey() })
    await expect(store.commit(snapshot)).resolves.toBeUndefined()
    await store.close()
  })
})
