// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EncryptedBrainStore } from '../../core/brain/encrypted-store'
import { MemoryBrainStore } from '../../core/brain/memory-store'
import { BrainStoreError, emptyBrainState, type BrainRecord } from '../../core/brain/store'
import { applyRecord, validateRecord } from '../../core/brain/fold'
import type { MemoryRecord, WorldEntity } from '../../core/brain/types'
import { testBrainKey, testConversationKey } from './testKey'

/**
 * Brain storage.
 *
 * Two properties are under test, and the second is the one that exists because of
 * the first.
 *
 * **1. What Freya learned is never on disk in the clear.** Encryption, unique
 * nonces, per-record authentication and header binding.
 *
 * **2. What Freya learned cannot be quietly removed.** A tag proves a record was
 * not edited; only the chain proves none was deleted, duplicated or reordered. So
 * the tests below do something a per-record authenticated log cannot defend against:
 * they edit the file directly, and they check that the Brain says so instead of
 * carrying on as though nothing happened.
 *
 * That second property is not paranoia about attackers. "Delete the memory I was
 * told to forget" and "someone removed the evidence" are otherwise the same
 * observable act, and a Brain that cannot tell them apart cannot claim its memory is
 * trustworthy.
 */

let dir = ''
const key = testBrainKey()

const SECRET = 'my github token is ghp_abcdefghijklmnop and my key is sk-abcdefghijklmnopqrst'

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-brain-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function openStore(name = 'brain.enc', withKey: Uint8Array = key): Promise<EncryptedBrainStore> {
  return EncryptedBrainStore.open({ path: join(dir, name), key: withKey })
}

function entity(entityId: string, name: string): WorldEntity {
  return {
    entityId,
    type: 'person',
    canonicalName: name,
    aliases: [],
    attributes: {},
    createdAt: '2026-04-01T09:00:00.000Z',
    updatedAt: '2026-04-01T09:00:00.000Z',
    provenance: provenance(),
    epistemic: 'observed',
  }
}

function memory(memoryId: string, content: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    memoryId,
    kind: 'semantic',
    subject: 'the owner',
    content,
    structuredData: {},
    createdAt: '2026-04-01T09:00:00.000Z',
    updatedAt: '2026-04-01T09:00:00.000Z',
    source: 'owner-assertion',
    provenance: provenance(),
    confidence: 'high',
    status: 'admitted',
    sensitivity: 'normal',
    tags: [],
    entityRefs: [],
    supersedes: null,
    conflictsWith: [],
    expiresAt: null,
    admittedAt: '2026-04-01T09:00:00.000Z',
    admissionReason: 'admitted because the owner asked for it to be remembered',
    ...overrides,
  }
}

function provenance() {
  return {
    sourceType: 'owner-assertion' as const,
    sourceRef: null,
    observedAt: '2026-04-01T09:00:00.000Z',
    recordedAt: '2026-04-01T09:00:00.000Z',
    actor: 'owner',
    verificationStatus: 'asserted' as const,
    confidence: 'high' as const,
    evidenceSummary: null,
  }
}

/** Rewrite one line of the on-disk log, by 1-indexed line number. */
async function editLine(index: number, transform: (line: string) => string): Promise<void> {
  const path = join(dir, 'brain.enc')
  const lines = (await readFile(path, 'utf8')).split('\n').filter((line) => line.length > 0)
  lines[index - 1] = transform(lines[index - 1] as string)
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8')
}

describe('encrypted Brain store', () => {
  it('keeps storage paths out of directory and read failure messages', async () => {
    const parentFile = join(dir, 'parent-file')
    await writeFile(parentFile, '', 'utf8')
    for (const path of [join(parentFile, 'brain.enc'), dir]) {
      const result = await EncryptedBrainStore.open({ path, key }).catch((error: unknown) => error)
      expect(result).toBeInstanceOf(BrainStoreError)
      expect(String(result)).not.toContain(dir)
    }
  })

  it('drains accepted writes on close and persists the validated snapshot', async () => {
    const store = await openStore()
    const record: BrainRecord = { kind: 'memory-record', memory: memory('snapshot', 'original') }
    const pending = store.write(record)
    record.memory.content = ''
    const closing = store.close()
    await expect(pending).resolves.toMatchObject({ memory: { content: 'original' } })
    await closing
    const reopened = await openStore()
    expect(reopened.health().health).toBe('healthy')
    expect(reopened.state().memories.get('snapshot')?.content).toBe('original')
    await reopened.close()
  })

  it('reports an append failure and refuses queued writes after it', async () => {
    const store = await openStore()
    const path = join(dir, 'brain.enc')
    await rename(path, join(dir, 'saved.enc'))
    await mkdir(path)
    const first = store.write({ kind: 'memory-record', memory: memory('lost', 'first') })
    const second = store.write({ kind: 'memory-record', memory: memory('queued', 'second') })
    const settled = await Promise.allSettled([first, second])
    expect(settled.map((result) => result.status)).toEqual(['rejected', 'rejected'])
    for (const result of settled) {
      if (result.status === 'rejected') expect(String(result.reason)).not.toContain(dir)
    }
    expect(store.health().health).toBe('degraded')
    expect(store.state().sequence).toBe(0)
    await store.close()
  })

  it('never writes memory content in the clear', async () => {
    const store = await openStore()
    await store.write({ kind: 'memory-record', memory: memory('m1', SECRET) })

    const raw = await readFile(join(dir, 'brain.enc'), 'utf8')
    expect(raw).not.toContain('ghp_abcdefghijklmnop')
    expect(raw).not.toContain('sk-abcdefghijklmnopqrst')
    expect(raw).not.toContain('the owner')
    expect(raw.length).toBeGreaterThan(0)
  })

  it('replays every record it wrote, in order', async () => {
    const store = await openStore()
    await store.write({ kind: 'world-entity', entity: entity('e1', 'Project Alpha') })
    await store.write({ kind: 'memory-record', memory: memory('m1', 'ships on Friday') })
    await store.write({ kind: 'world-entity', entity: entity('e2', 'Ada') })
    await store.close()

    const reopened = await openStore()
    const state = reopened.state()
    expect(state.entities.size).toBe(2)
    expect(state.memories.get('m1')?.content).toBe('ships on Friday')
    expect(state.sequence).toBe(3)
  })

  it('uses a different key from the conversation domain and cannot read its log', async () => {
    const store = await openStore()
    await store.write({ kind: 'memory-record', memory: memory('m1', 'something private') })
    await store.close()

    // The independence of the two domains is the property. If this ever read the
    // memories, the keyring had quietly collapsed back to one secret for
    // everything.
    //
    // Reported rather than thrown: a Brain that cannot read itself still opens, so
    // Freya keeps answering and says her memory is degraded. Refusing to open would
    // have let a wrong key take the whole application down instead.
    const wrongDomain = await openStore('brain.enc', testConversationKey())
    expect(wrongDomain.health().health).toBe('degraded')
    expect(wrongDomain.state().memories.size).toBe(0)
  })

  it('refuses a key of the wrong length rather than padding it', async () => {
    await expect(
      EncryptedBrainStore.open({ path: join(dir, 'short.enc'), key: new Uint8Array(16) }),
    ).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it('rejects a malformed record instead of folding it', async () => {
    const store = await openStore()
    await expect(
      store.write({ kind: 'memory-record', memory: memory('m1', '') }),
    ).rejects.toMatchObject({ code: 'invalid-record' })
  })

  it('refuses a record larger than the limit rather than writing it', async () => {
    const store = await openStore()
    await expect(
      store.write({ kind: 'memory-record', memory: memory('m1', 'x'.repeat(300_000)) }),
    ).rejects.toBeInstanceOf(BrainStoreError)
  })

  it('assigns strictly increasing sequence numbers under concurrent writes', async () => {
    const store = await openStore()
    // Deliberately unordered. Serialised appends are the only reason these cannot
    // interleave and leave seq 4 on disk before seq 3.
    await Promise.all(
      Array.from({ length: 25 }, (_unused, index) =>
        store.write({ kind: 'memory-record', memory: memory(`m${index}`, `memory ${index}`) }),
      ),
    )
    await store.close()

    const lines = (await readFile(join(dir, 'brain.enc'), 'utf8'))
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { seq: number })
    expect(lines.map((line) => line.seq)).toEqual(Array.from({ length: 25 }, (_u, i) => i + 1))
  })
})

describe('chain integrity', () => {
  it('preserves authenticated records but refuses appends after a truncated final newline', async () => {
    const store = await openStore()
    await store.write({ kind: 'world-entity', entity: entity('before', 'Before') })
    await store.close()
    const path = join(dir, 'brain.enc')
    const truncated = (await readFile(path, 'utf8')).slice(0, -1)
    await writeFile(path, truncated, 'utf8')

    const reopened = await openStore()
    expect(reopened.state().entities.has('before')).toBe(true)
    expect(reopened.health()).toMatchObject({ health: 'degraded' })
    expect(reopened.health().reason).toMatch(/unterminated/)
    await expect(
      reopened.write({ kind: 'world-entity', entity: entity('after', 'After') }),
    ).rejects.toMatchObject({ code: 'read-only' })
    await reopened.close()
    expect(await readFile(path, 'utf8')).toBe(truncated)
    const again = await openStore()
    expect(again.state().entities.has('before')).toBe(true)
    await again.close()
  })

  it('detects an edited record and refuses to read past the break', async () => {
    const store = await openStore()
    await store.write({ kind: 'world-entity', entity: entity('e1', 'Project Alpha') })
    await store.write({ kind: 'memory-record', memory: memory('m1', 'ships on Friday') })
    await store.write({ kind: 'world-entity', entity: entity('e2', 'Ada') })
    await store.close()

    // Re-encrypt the middle record's plaintext under a fresh nonce so the tag is
    // valid. Without the chain this would be undetectable, and it is exactly the
    // attacker who has the key but should not be able to rewrite history.
    await editLine(2, () => forgeLine(2, { kind: 'memory-record', memory: memory('m1', 'ships NEXT month') }))

    const reopened = await openStore()
    const health = reopened.health()
    expect(health.health).toBe('degraded')
    expect(health.reason).toMatch(/chain is broken|altered, moved or removed/)
    // The record before the break is read; the one after it is not, because the
    // chain cannot vouch for anything following a break.
    expect(reopened.state().entities.has('e1')).toBe(true)
    expect(reopened.state().entities.has('e2')).toBe(false)
  })

  it('detects a deleted record as a sequence gap', async () => {
    const store = await openStore()
    await store.write({ kind: 'world-entity', entity: entity('e1', 'Project Alpha') })
    await store.write({ kind: 'memory-record', memory: memory('m1', 'ships on Friday') })
    await store.write({ kind: 'memory-record', memory: memory('m2', 'the deadline is Friday') })
    await store.close()

    const path = join(dir, 'brain.enc')
    const lines = (await readFile(path, 'utf8')).split('\n').filter((line) => line.length > 0)
    lines.splice(1, 1)
    await writeFile(path, `${lines.join('\n')}\n`, 'utf8')

    const reopened = await openStore()
    expect(reopened.health().health).toBe('degraded')
    expect(reopened.health().reason).toMatch(/out of order/)
    expect(reopened.state().memories.size).toBe(0)
  })

  it('detects a reordered record as a broken link', async () => {
    const store = await openStore()
    await store.write({ kind: 'memory-record', memory: memory('m1', 'first') })
    await store.write({ kind: 'memory-record', memory: memory('m2', 'second') })
    await store.close()

    const path = join(dir, 'brain.enc')
    const lines = (await readFile(path, 'utf8')).split('\n').filter((line) => line.length > 0)
    lines.reverse()
    await writeFile(path, `${lines.join('\n')}\n`, 'utf8')

    const reopened = await openStore()
    expect(reopened.health().health).toBe('degraded')
  })

  it('detects a tampered ciphertext through the authentication tag', async () => {
    const store = await openStore()
    await store.write({ kind: 'memory-record', memory: memory('m1', 'something private') })
    await store.close()

    await editLine(1, (line) => {
      const parsed = JSON.parse(line) as { cipher: string }
      const bytes = Buffer.from(parsed.cipher, 'base64')
      bytes[0] = bytes[0] === 0 ? 1 : bytes[0] === 1 ? 2 : 0
      return JSON.stringify({ ...parsed, cipher: bytes.toString('base64') })
    })

    const reopened = await openStore()
    expect(reopened.health()).toMatchObject({ health: 'degraded' })
    expect(reopened.health().reason).toMatch(/failed authentication/)
  })

  it('refuses a log written by a different store', async () => {
    const store = await openStore()
    await store.write({ kind: 'memory-record', memory: memory('m1', 'something private') })
    await store.close()

    // Same key, different path. The context binding stops one store's log being
    // read as another's, which is what keeps "one key per domain" from being a
    // single large blast radius.
    const otherPath = join(dir, 'other.enc')
    await writeFile(otherPath, await readFile(join(dir, 'brain.enc'), 'utf8'), 'utf8')
    const moved = await EncryptedBrainStore.open({ path: otherPath, key })
    expect(moved.health().health).toBe('degraded')
    expect(moved.health().reason).toMatch(/different store/)
  })

  it('preserves a corrupt log and refuses appends that cannot survive replay', async () => {
    const store = await openStore()
    await store.write({ kind: 'memory-record', memory: memory('m1', 'first') })
    await store.close()
    await editLine(1, () => '{"version":1,"kind":"memory-record","nope":true}')

    const reopened = await openStore()
    expect(reopened.health().health).toBe('degraded')
    const damaged = await readFile(join(dir, 'brain.enc'), 'utf8')
    // Core can still answer, but appending beyond this break would acknowledge a
    // durable memory that replay can never reach.
    await expect(
      reopened.write({ kind: 'world-entity', entity: entity('e9', 'Later') }),
    ).rejects.toMatchObject({ code: 'read-only' })
    await reopened.close()
    expect(await readFile(join(dir, 'brain.enc'), 'utf8')).toBe(damaged)
  })
})

describe('validation', () => {
  it('refuses a memory with no admission reason', () => {
    const record = { kind: 'memory-record', memory: memory('m1', 'something') } as unknown
    const broken = { kind: 'memory-record', memory: { ...memory('m1', 'something'), admissionReason: '' } }
    expect(validateRecord(record).ok).toBe(true)
    expect(validateRecord(broken)).toMatchObject({ ok: false })
  })

  it('refuses an experience claiming it was verified', () => {
    const record = {
      kind: 'experience',
      experience: {
        experienceId: 'x1',
        goalSummary: 'answered a question',
        startedAt: '2026-04-01T09:00:00.000Z',
        endedAt: '2026-04-01T09:00:01.000Z',
        modelsUsed: ['fake'],
        toolsUsed: [],
        actions: [],
        observations: [],
        evidenceRefs: [],
        result: 'completed',
        verification: 'verified',
        humanCorrection: null,
        relatedEntities: [],
        relatedMemories: [],
        resourceUsage: {
          providerId: 'fake',
          model: 'fake',
          providerContacted: true,
          inputTokens: null,
          outputTokens: null,
          usageUnknown: true,
        },
        answerPersisted: true,
        conversationId: null,
        turnId: null,
      },
    }
    // Phase 4 has no verifier, so a record claiming one did is refused rather than
    // stored. Nothing is lost — the record is skipped, not rewritten.
    expect(validateRecord(record)).toMatchObject({ ok: false })
  })

  it('refuses an unknown record kind', () => {
    expect(validateRecord({ kind: 'something-else' })).toMatchObject({ ok: false })
  })
})

describe('the fold', () => {
  it('keeps the first identity root and ignores a later one', () => {
    const state = emptyBrainState()
    const first = { kind: 'identity-root' as const, identity: { schemaVersion: 1, name: 'Freya', role: 'r', purpose: 'p', stableTraits: [], communicationPrinciples: [], continuityPrinciples: [], claims: [], immutable: true as const } }
    const second = { ...first, identity: { ...first.identity, name: 'Someone Else' } }
    applyRecord(state, first)
    applyRecord(state, second)
    // Root identity is written once. A later record does not replace it: a memory
    // must never be able to rewrite who Freya is.
    expect(state.identity?.name).toBe('Freya')
  })

  it('is idempotent per id, so a duplicate cannot double-apply', () => {
    const state = emptyBrainState()
    const record: BrainRecord = { kind: 'world-entity', entity: entity('e1', 'Ada') }
    applyRecord(state, record)
    applyRecord(state, record)
    expect(state.entities.size).toBe(1)
  })

  it('lets a later record supersede a memory rather than dropping the old one', () => {
    const state = emptyBrainState()
    applyRecord(state, { kind: 'memory-record', memory: memory('m1', 'ships Friday') })
    applyRecord(state, {
      kind: 'memory-record',
      memory: memory('m2', 'ships Monday', { supersedes: 'm1' }),
    })
    expect(state.memories.size).toBe(2)
    expect(state.memories.get('m2')?.supersedes).toBe('m1')
  })
})

describe('the in-memory store', () => {
  it('reports its own mode, and never pretends to be durable', () => {
    const store = new MemoryBrainStore({ mode: 'ephemeral', faultReason: 'no key' })
    expect(store.mode).toBe('ephemeral')
    expect(store.faultReason).toBe('no key')
  })

  it('refuses writes after close', async () => {
    const store = new MemoryBrainStore()
    await store.close()
    await expect(store.write({ kind: 'world-entity', entity: entity('e1', 'Ada') })).rejects.toMatchObject({
      code: 'store-unavailable',
    })
  })
})

/**
 * Build a well-formed encrypted line for a given sequence.
 *
 * Uses the *real* store to derive the context and the format, then re-encrypts
 * under the same key with a valid tag. That is the only honest way to build the
 * strongest attack in this file: everything a legitimate writer checks, it checks.
 */
function forgeLine(seq: number, record: BrainRecord): string {
  const context = createHash('sha256')
    .update(Buffer.from(key))
    .update(Buffer.from([0]))
    .update(join(dir, 'brain.enc'))
    .digest('base64')
    .slice(0, 32)
  const prev = seq === 1 ? 'genesis' : 'x'.repeat(43)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key), nonce)
  cipher.setAAD(Buffer.from(`freya.brain.v1|${context}|${record.kind}|${seq}|${prev}`, 'utf8'))
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(record), 'utf8')),
    cipher.final(),
  ])
  return JSON.stringify({
    version: 1,
    kind: record.kind,
    seq,
    prev,
    context,
    nonce: nonce.toString('base64'),
    cipher: encrypted.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  })
}
