// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { EncryptedMissionStore } from '../../core/missions/encrypted-store'
import { MemoryMissionStore } from '../../core/missions/memory-store'
import { MissionStoreError, type MissionStore } from '../../core/missions/store'
import type { MissionContent } from '../../core/missions/types'

/**
 * The private Mission content store.
 *
 * Two properties, and the second is the one this file exists for.
 *
 * 1. **What a Mission is for is never on disk in the clear.** AES-256-GCM, a unique
 *    nonce per record, the record header authenticated as AAD so a record cannot be
 *    re-labelled, and a context binding so the store cannot be opened with another
 *    domain's key.
 * 2. **Domain separation.** The Mission key cannot open the Brain or the
 *    conversation store, and vice versa. A Mission is about somebody's plans, which
 *    is not the same class of data as anything else Freya stores, and a leaked Brain
 *    key must not yield the user's intentions.
 *
 * Content is also bounded: a Mission's text cannot become a way to write an
 * arbitrarily large file through the encrypted store.
 */

let dir = ''
const missionKey = key('freya-test-mission-key')
const brainKey = key('freya-test-brain-key')
const conversationKey = key('freya-test-conversation-key')

function key(seed: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(seed, 'utf8').digest())
}

const SECRET = 'FREYA_RED_TEAM_SECRET_7A91 handle my house move'

/**
 * A Mission's private content, as the store holds it.
 *
 * `intentShape` is Phase 47's structured half of the goal and it lives here, encrypted,
 * for the same reason the free text does — every one of its fields is a word. It is
 * defaulted rather than required so a fixture that does not care about it stays short, and
 * so that a test *about* it has to set it deliberately.
 */
function content(overrides: Partial<MissionContent> = {}): MissionContent {
  return {
    missionId: 'm1',
    title: 'Handle my house move',
    intent: SECRET,
    intentShape: null,
    successCriteria: ['All documents filed', 'Appointment attended'],
    createdAt: '2026-10-01T09:00:00.000Z',
    ...overrides,
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-mission-store-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function openStore(name = 'missions.enc', withKey: Uint8Array = missionKey): Promise<EncryptedMissionStore> {
  return EncryptedMissionStore.open({ path: join(dir, name), key: withKey })
}

describe('encrypted Mission content', () => {
  it('never writes Mission content in the clear', async () => {
    const store = await openStore()
    await store.write(content())

    const raw = await readFile(join(dir, 'missions.enc'), 'utf8')
    // The Red Team sentinel must be on disk only in ciphertext.
    expect(raw).not.toContain('FREYA_RED_TEAM_SECRET_7A91')
    expect(raw).not.toContain('house move')
    expect(raw).not.toContain('Handle my')
    expect(raw.length).toBeGreaterThan(0)
  })

  it('reads back exactly what it wrote', async () => {
    const store = await openStore()
    await store.write(content())
    await store.close()

    const reopened = await openStore()
    const read = await reopened.read('m1')
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.value.intent).toBe(SECRET)
    expect(read.value.successCriteria).toEqual(['All documents filed', 'Appointment attended'])
  })

  it('reports missing content rather than returning an empty Mission', async () => {
    const store = await openStore()
    // A Mission whose content is gone must not be presented as one with no intent,
    // which would read as "this Mission has no intent" rather than "we lost it".
    const result = await store.read('never-written')
    expect(result).toMatchObject({ ok: false, code: 'not_found' })
  })

  it('updates content in place rather than accumulating records', async () => {
    const store = await openStore()
    await store.write(content())
    await store.write(content({ intent: 'Revised intent.' }))
    await store.close()

    const reopened = await openStore()
    const read = await reopened.read('m1')
    expect(read.ok && read.value.intent).toBe('Revised intent.')
    // One record per Mission, so an edited Mission does not grow the file for ever.
    const raw = await readFile(join(dir, 'missions.enc'), 'utf8')
    expect(raw.trim().split('\n')).toHaveLength(1)
  })

  it('uses a different key from every other domain and cannot read their stores', async () => {
    const store = await openStore()
    await store.write(content())
    await store.close()

    // The independence of the domains is the property. If this read anything, a
    // leaked Brain key would yield the user's intentions.
    for (const foreign of [brainKey, conversationKey]) {
      const wrong = await openStore('missions.enc', foreign)
      expect(wrong.health()).toMatchObject({ health: 'degraded' })
      expect((await wrong.read('m1')).ok).toBe(false)
    }
  })

  it('refuses a key of the wrong length rather than padding it', async () => {
    await expect(
      EncryptedMissionStore.open({ path: join(dir, 'short.enc'), key: new Uint8Array(16) }),
    ).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it('bounds content so a Mission cannot write an unbounded file', async () => {
    const store = await openStore()
    await expect(store.write(content({ intent: 'x'.repeat(2_000_000) }))).rejects.toMatchObject({
      code: 'too_large',
    })
  })

  it('refuses a record whose shape is wrong rather than storing it', async () => {
    const store = await openStore()
    await expect(store.write({ missionId: 'm1' } as never)).rejects.toBeInstanceOf(MissionStoreError)
  })

  it('detects a tampered ciphertext through the authentication tag', async () => {
    const store = await openStore()
    await store.write(content())
    await store.close()

    const path = join(dir, 'missions.enc')
    const line = (await readFile(path, 'utf8')).trim()
    const parsed = JSON.parse(line) as { cipher: string }
    const bytes = Buffer.from(parsed.cipher, 'base64')
    bytes[0] = bytes[0] === 0 ? 1 : 0
    await writeFile(path, `${JSON.stringify({ ...parsed, cipher: bytes.toString('base64') })}\n`, 'utf8')

    const reopened = await openStore()
    expect(reopened.health()).toMatchObject({ health: 'degraded' })
    expect((await reopened.read('m1')).ok).toBe(false)
  })

  it('refuses a store written by a different domain key, and says so', async () => {
    const store = await openStore()
    await store.write(content())
    await store.close()

    // Same path, different key. Reported rather than thrown: a store that cannot
    // read itself must still let Freya answer, with the Mission marked degraded.
    const wrong = await openStore('missions.enc', brainKey)
    expect(wrong.health().health).toBe('degraded')
    expect(wrong.health().reason).toMatch(/different store|authentication/i)
  })

  it('reports degraded honestly rather than silently serving nothing', async () => {
    const store = await openStore()
    await store.write(content())
    await store.close()
    await writeFile(join(dir, 'missions.enc'), 'not json at all\n', 'utf8')

    const reopened = await openStore()
    expect(reopened.health().health).toBe('degraded')
    expect(reopened.health().reason).toMatch(/valid JSON/i)
  })
})

describe('a damaged store is read-only, and says so', () => {
  /**
   * Three Missions, with the middle record's ciphertext damaged.
   *
   * Corrupting the *middle* rather than the tail is the case that matters: replay
   * stops at the first record that fails authentication, so the readable prefix is
   * shorter than the file and anything after the break is invisible to the store.
   */
  async function damagedStore(): Promise<{ path: string; before: number }> {
    const path = join(dir, 'damaged.enc')
    const store = await EncryptedMissionStore.open({ path, key: missionKey })
    for (const id of ['m1', 'm2', 'm3']) {
      await store.write({
        missionId: id,
        title: `title ${id}`,
        intent: `intent ${id}`,
        intentShape: null,
        successCriteria: [],
        createdAt: '2026-10-01T09:00:00.000Z',
      })
    }
    await store.close()

    const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean)
    const target = lines[1]
    if (target === undefined) throw new Error('the fixture needs at least two records')
    const damaged = JSON.parse(target) as { cipher: string }
    lines[1] = JSON.stringify({
      ...damaged,
      cipher: `${damaged.cipher.slice(0, -4)}AAAA`,
    })
    await writeFile(path, `${lines.join('\n')}\n`)
    return { path, before: lines.length }
  }

  it('reports the fault instead of claiming to be durable', async () => {
    // `faultReason` was a hardcoded `null`, so the projection said `durable: true`
    // and the board said ENCRYPTED AT REST over content that could not be read. The
    // degradation was tracked; nothing a window could see was reading it.
    const { path } = await damagedStore()
    const store = await EncryptedMissionStore.open({ path, key: missionKey })
    expect(store.faultReason).toMatch(/failed authentication/)
    expect(store.health().health).toBe('degraded')
    await store.close()
  })

  it('refuses to write rather than destroying the records it cannot see', async () => {
    // The severe one. A write rewrites the whole file from the in-memory records, and
    // those records stop at the break — so writing here deleted every Mission after it,
    // permanently and invisibly, and the next open reported the store *healthy* because
    // the evidence had just been overwritten. Measured before the fix: 3 records in,
    // 2 out, holding m1 and m4.
    const { path, before } = await damagedStore()
    const store = await EncryptedMissionStore.open({ path, key: missionKey })

    await expect(
      store.write({
        missionId: 'm4',
        title: 'title m4',
        intent: 'intent m4',
        intentShape: null,
        successCriteria: [],
        createdAt: '2026-10-01T09:00:00.000Z',
      }),
    ).rejects.toThrow(MissionStoreError)

    // Nothing on disk changed.
    const after = (await readFile(path, 'utf8')).split('\n').filter(Boolean)
    expect(after).toHaveLength(before)
    expect(after.map((line) => (JSON.parse(line) as { missionId: string }).missionId)).toEqual([
      'm1',
      'm2',
      'm3',
    ])
    await store.close()
  })

  it('keeps reporting the fault after a refused write', async () => {
    // A refusal must not clear the diagnosis, or the next start would look clean.
    const { path } = await damagedStore()
    const store = await EncryptedMissionStore.open({ path, key: missionKey })
    await store
      .write({
        missionId: 'm4',
        title: 't',
        intent: 'i',
        intentShape: null,
        successCriteria: [],
        createdAt: '2026-10-01T09:00:00.000Z',
      })
      .catch(() => undefined)
    expect(store.faultReason).not.toBeNull()

    // And the fault survives the process entirely.
    await store.close()
    const reopened = await EncryptedMissionStore.open({ path, key: missionKey })
    expect(reopened.faultReason).not.toBeNull()
    await reopened.close()
  })
})

describe('the ephemeral store', () => {
  it('says plainly that it is not durable', () => {
    // A Mission somebody is told is durable and which is not is worse than no
    // Mission at all, so the honest label is the whole point.
    const store = new MemoryMissionStore({ faultReason: 'no secure key' })
    expect(store.mode).toBe('ephemeral')
    expect(store.durable).toBe(false)
    expect(store.faultReason).toMatch(/no secure key/)
  })

  it('behaves like a store for the life of the process', async () => {
    const store: MissionStore = new MemoryMissionStore()
    await store.write(content())
    const read = await store.read('m1')
    expect(read.ok && read.value.title).toBe('Handle my house move')
  })

  it('refuses writes after close', async () => {
    const store = new MemoryMissionStore()
    await store.close()
    await expect(store.write(content())).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('never writes anything to disk at all', async () => {
    const store = new MemoryMissionStore()
    await store.write(content())
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(dir)).toEqual([])
  })
})