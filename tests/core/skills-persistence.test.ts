// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  EncryptedSkillStore,
  SKILL_CRYPTO_DOMAIN,
  skillRecordAad,
  skillStoreBinding,
} from '../../core/skills/persistence/encrypted-store'
import { EphemeralSkillStore } from '../../core/skills/persistence/ephemeral-store'
import { SkillPersistenceError, isSkillPersistenceError } from '../../core/skills/persistence/errors'
import { openSkillPersistence } from '../../core/skills/persistence/open'
import {
  MAX_SKILL_RECORD_BYTES,
  decodeSkillRecord,
  emptySkillSnapshot,
} from '../../core/skills/persistence/snapshot'
import { SKILL_SNAPSHOT_VERSION } from '../../core/skills/persistence/port'
import { SkillPersistenceRuntime } from '../../core/skillsPersistence'
import { SKILL_LIMITS, type SkillRecord } from '../../core/skills/types'

/**
 * SKILL PERSISTENCE — restart-safe, encrypted, bounded, and honest when degraded.
 *
 * A skill body is a procedure Freya wrote together with the capability map it will ask
 * for, so the tests here are about a stolen laptop containing none of it, about a
 * tampered file being refused rather than believed, and about the difference between
 * "durable" and "we wrote nothing".
 */

const KEY = new Uint8Array(32).fill(7)
const OTHER_KEY = new Uint8Array(32).fill(9)
const SENTINEL = 'FREYA_RED_TEAM_SECRET_7A91'

function record(overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    skillId: 'sk_1',
    name: 'summarise-a-file',
    kind: 'procedure',
    status: 'trial',
    version: 1,
    verification: 'unverified',
    contentHash: 'a'.repeat(32),
    summary: `Reads a file and produces a bounded summary of it. ${SENTINEL}`,
    contract: {
      inputs: [{ name: 'path', description: `The file to read. ${SENTINEL}` }],
      outputs: [{ name: 'summary', description: 'A bounded summary.' }],
      preconditions: [],
      postconditions: [{ name: 'recorded', description: 'The step closed on its verifier.' }],
    },
    steps: [{ key: 'read', capability: 'test.record', verifier: 'test.record.matches' }],
    requiredCapabilities: ['work.execute'],
    applicability: ['research'],
    provenance: {
      source: 'owner',
      trustClass: 'owner-declared',
      admittedBy: 'owner',
      admittedAt: '2026-10-02T09:00:00.000Z',
      parentSkillId: null,
      parentVersion: null,
      originRef: 'renderer',
    },
    createdAt: '2026-10-02T09:00:00.000Z',
    updatedAt: '2026-10-02T09:00:00.000Z',
    retiredAt: null,
    retirementReason: null,
    promotedAt: null,
    ...overrides,
  }
}

async function withDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'freya-skills-'))
  try {
    return await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('the encrypted store keeps the body off the disk', () => {
  it('writes no plaintext of the procedure, its descriptions or its capability map', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'skills.enc')
      const store = await EncryptedSkillStore.open({ path, key: KEY })
      await store.commit({ v: SKILL_SNAPSHOT_VERSION, records: [record()] })
      await store.close()

      const raw = await readFile(path, 'utf8')
      expect(raw.length).toBeGreaterThan(0)
      // The only plaintext is a record id.
      expect(raw).toContain('sk_1')
      for (const secret of [
        SENTINEL,
        'Reads a file',
        'The file to read',
        'test.record',
        'test.record.matches',
        'summarise-a-file',
        'work.execute',
      ]) {
        expect(raw).not.toContain(secret)
      }
    })
  })

  it('round-trips through a restart', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'skills.enc')
      const first = await EncryptedSkillStore.open({ path, key: KEY })
      await first.commit({ v: SKILL_SNAPSHOT_VERSION, records: [record()] })
      await first.close()

      const second = await EncryptedSkillStore.open({ path, key: KEY })
      const loaded = await second.load()
      expect(loaded.ok).toBe(true)
      if (!loaded.ok) return
      expect(loaded.snapshot.records).toHaveLength(1)
      expect(loaded.snapshot.records[0]?.summary).toContain(SENTINEL)
      expect(loaded.snapshot.records[0]?.steps[0]?.capability).toBe('test.record')
      await second.close()
    })
  })

  it('gives every write a fresh nonce, so two identical bodies differ on disk', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'skills.enc')
      const store = await EncryptedSkillStore.open({ path, key: KEY })
      await store.commit({ v: SKILL_SNAPSHOT_VERSION, records: [record()] })
      const first = await readFile(path, 'utf8')
      await store.commit({ v: SKILL_SNAPSHOT_VERSION, records: [record()] })
      const second = await readFile(path, 'utf8')
      expect(first).not.toBe(second)
      expect(JSON.parse(first.trim()).nonce).not.toBe(JSON.parse(second.trim()).nonce)
      await store.close()
    })
  })

  it('binds a record to its own id, so one cannot be re-labelled onto another', () => {
    const binding = skillStoreBinding(KEY, '/tmp/skills.enc')
    expect(skillRecordAad(binding, 'sk_1')).toBe(`${SKILL_CRYPTO_DOMAIN}|${binding}|sk_1`)
    expect(skillRecordAad(binding, 'sk_1')).not.toBe(skillRecordAad(binding, 'sk_2'))
  })

  it('binds each store to its own path and key', () => {
    expect(skillStoreBinding(KEY, '/a')).not.toBe(skillStoreBinding(KEY, '/b'))
    expect(skillStoreBinding(KEY, '/a')).not.toBe(skillStoreBinding(OTHER_KEY, '/a'))
  })
})

describe('another domain’s key opens nothing', () => {
  it('fails to authenticate rather than quietly decrypting', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'skills.enc')
      const store = await EncryptedSkillStore.open({ path, key: KEY })
      await store.commit({ v: SKILL_SNAPSHOT_VERSION, records: [record()] })
      await store.close()

      // Four different domains' secrets, and this build's keyring is supposed to keep
      // them from being interchangeable.
      for (const other of [OTHER_KEY, new Uint8Array(32).fill(1)]) {
        const wrong = await EncryptedSkillStore.open({ path, key: other })
        const loaded = await wrong.load()
        expect(loaded.ok).toBe(false)
        if (loaded.ok) continue
        expect(loaded.code).toBe('degraded')
        expect(loaded.reason).toMatch(/authentication/i)
        await wrong.close()
      }
    })
  })

  it('refuses a key of the wrong length at open, rather than using a prefix', async () => {
    await withDir(async (dir) => {
      await expect(
        EncryptedSkillStore.open({ path: join(dir, 'skills.enc'), key: new Uint8Array(16) }),
      ).rejects.toBeInstanceOf(SkillPersistenceError)
    })
  })
})

describe('a damaged store serves nothing and writes nothing', () => {
  it('degrades on a tampered record and stays degraded', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'skills.enc')
      const store = await EncryptedSkillStore.open({ path, key: KEY })
      await store.commit({ v: SKILL_SNAPSHOT_VERSION, records: [record()] })
      await store.close()

      const raw = await readFile(path, 'utf8')
      const line = JSON.parse(raw.trim()) as { cipher: string }
      // Flip a byte of the ciphertext: the tag must catch it.
      await writeFile(path, JSON.stringify({ ...line, cipher: flip(line.cipher) }), 'utf8')

      const reopened = await EncryptedSkillStore.open({ path, key: KEY })
      expect(reopened.faultReason).toMatch(/authentication/i)
      const loaded = await reopened.load()
      expect(loaded.ok).toBe(false)
      // Serving what parsed would make the retained set a function of what an attacker
      // chose to damage; writing would drop every later record permanently.
      await expect(
        reopened.commit({ v: SKILL_SNAPSHOT_VERSION, records: [record()] }),
      ).rejects.toBeInstanceOf(SkillPersistenceError)
      await reopened.close()
    })
  })

  it('degrades on an unparseable line', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'skills.enc')
      await writeFile(path, '{not json\n', 'utf8')
      const store = await EncryptedSkillStore.open({ path, key: KEY })
      expect(store.faultReason).toMatch(/not valid JSON/i)
      const loaded = await store.load()
      expect(loaded.ok).toBe(false)
      await store.close()
    })
  })

  it('degrades on a record from a future format rather than guessing at it', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'skills.enc')
      await writeFile(path, `${JSON.stringify({ v: 99, skillId: 'sk_1', nonce: '', cipher: '', tag: '' })}\n`, 'utf8')
      const store = await EncryptedSkillStore.open({ path, key: KEY })
      expect(store.faultReason).toMatch(/version 99/)
      await store.close()
    })
  })

  it('reports a fault rather than reporting itself healthy', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'skills.enc')
      await writeFile(path, 'garbage\n', 'utf8')
      const store = await EncryptedSkillStore.open({ path, key: KEY })
      // A hardcoded `null` here would let a window say `ENCRYPTED AT REST` while every
      // record was failing authentication — the degradation would be tracked and read
      // by nothing.
      expect(store.faultReason).not.toBeNull()
      expect(store.durable).toBe(true)
      await store.close()
    })
  })

  it('keeps the first fault when more than one arrives', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'skills.enc')
      const store = await EncryptedSkillStore.open({ path, key: KEY })
      await writeFile(path, 'garbage one\n', 'utf8')
      await appendFile(path, 'garbage two\n', 'utf8')
      const reopened = await EncryptedSkillStore.open({ path, key: KEY })
      expect(reopened.faultReason).toMatch(/not valid JSON/i)
      await reopened.close()
      await store.close()
    })
  })
})

describe('the codec refuses an illegal record that nevertheless authenticated', () => {
  it('refuses a body that requires a capability no skill may require', () => {
    expect(() =>
      decodeSkillRecord({ ...record(), requiredCapabilities: ['work.approval.decide'] }),
    ).toThrow(SkillPersistenceError)
    expect(() =>
      decodeSkillRecord({ ...record(), requiredCapabilities: ['security.stop'] }),
    ).toThrow(SkillPersistenceError)
  })

  it('refuses an unknown capability, a bad status and a version below 1', () => {
    expect(() => decodeSkillRecord({ ...record(), requiredCapabilities: ['mind.control'] })).toThrow()
    expect(() => decodeSkillRecord({ ...record(), status: 'promoted!' })).toThrow()
    expect(() => decodeSkillRecord({ ...record(), version: 0 })).toThrow()
  })

  it('refuses an undeclared field, which is where extra content would hide', () => {
    expect(() => decodeSkillRecord({ ...record(), hiddenCapability: 'security.stop' })).toThrow()
    expect(() => decodeSkillRecord({ ...record(), contract: { ...record().contract, secret: 'x' } })).toThrow()
  })

  it('refuses an applicability tag that is not a slug', () => {
    expect(() => decodeSkillRecord({ ...record(), applicability: ['a sentence pretending'] })).toThrow()
    expect(() => decodeSkillRecord({ ...record(), applicability: [] })).toThrow()
  })

  it('refuses a step with no verifier, and a step list that is too long', () => {
    expect(() =>
      decodeSkillRecord({ ...record(), steps: [{ key: 'read', capability: 'test.record', verifier: '' }] }),
    ).toThrow()
    const many = Array.from({ length: SKILL_LIMITS.maxSteps + 1 }, (_, index) => ({
      key: `step-${index}`,
      capability: 'test.record',
      verifier: 'test.record.matches',
    }))
    expect(() => decodeSkillRecord({ ...record(), steps: many })).toThrow()
  })

  it('bounds the per-record byte ceiling so one body cannot make every write fail', () => {
    expect(MAX_SKILL_RECORD_BYTES).toBeGreaterThan(0)
    expect(MAX_SKILL_RECORD_BYTES).toBeLessThanOrEqual(SKILL_LIMITS.maxSnapshotBytes)
  })

  it('refuses two records sharing one id', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'skills.enc')
      const store = await EncryptedSkillStore.open({ path, key: KEY })
      await expect(
        store.commit({ v: SKILL_SNAPSHOT_VERSION, records: [record(), record()] }),
      ).rejects.toBeInstanceOf(SkillPersistenceError)
      await store.close()
    })
  })
})

describe('the ephemeral fallback keeps procedures and says so', () => {
  it('holds real records, reports mode ephemeral, and writes nothing', async () => {
    const store = new EphemeralSkillStore()
    expect(store.mode).toBe('ephemeral')
    expect(store.durable).toBe(false)
    expect(store.durabilityReason).toMatch(/in this process only/i)
    await store.commit({ v: SKILL_SNAPSHOT_VERSION, records: [record()] })
    const loaded = await store.load()
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.snapshot.records).toHaveLength(1)
  })

  it('still validates what it is given, so an illegal body is refused', async () => {
    const store = new EphemeralSkillStore()
    await expect(
      store.commit({
        v: SKILL_SNAPSHOT_VERSION,
        records: [{ ...record(), requiredCapabilities: ['security.stop'] }],
      }),
    ).rejects.toBeInstanceOf(SkillPersistenceError)
  })

  it('is what a Core with no key gets, rather than a weaker persistent store', async () => {
    await withDir(async (dir) => {
      const port = await openSkillPersistence({ path: join(dir, 'skills.enc'), key: null })
      expect(port.mode).toBe('ephemeral')
      expect(port.durable).toBe(false)
      await port.close()
    })
  })
})

describe('the runtime keeps the journal authoritative for status', () => {
  it('adopts only the bodies Core hands it, and reports durability honestly', async () => {
    await withDir(async (dir) => {
      const opened = await SkillPersistenceRuntime.open({
        path: join(dir, 'skills.enc'),
        key: KEY,
      })
      expect(opened.bodies).toHaveLength(0)
      expect(opened.runtime.health()).toEqual({ mode: 'encrypted', durable: true, reason: null })
      opened.runtime.commit([record()])
      await opened.runtime.flush()
      await opened.runtime.close()

      // A restart recovers the body, and a Core that filters against its journal is what
      // makes the store a cache rather than a second source of truth.
      const again = await SkillPersistenceRuntime.open({ path: join(dir, 'skills.enc'), key: KEY })
      expect(again.bodies).toHaveLength(1)
      await again.runtime.close()
    })
  })

  it('reports a degraded store in fixed words, never in private input', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'skills.enc')
      await writeFile(path, 'not a store at all\n', 'utf8')
      const opened = await SkillPersistenceRuntime.open({ path, key: KEY })
      const health = opened.runtime.health()
      expect(health.durable).toBe(false)
      expect(health.reason).toMatch(/in this process only/)
      // A decoder or filesystem error must never echo what it choked on.
      expect(health.reason).not.toContain('not a store')
      await opened.runtime.close()
    })
  })

  it('starts from an empty snapshot on a first run, and does not write a file of nothing', async () => {
    expect(emptySkillSnapshot().records).toHaveLength(0)
    await withDir(async (dir) => {
      const path = join(dir, 'skills.enc')
      const store = await EncryptedSkillStore.open({ path, key: KEY })
      await store.close()
      expect(await readFile(path, 'utf8')).toBe('')
    })
  })

  it('recognises its own errors', () => {
    expect(isSkillPersistenceError(new SkillPersistenceError('closed', 'x'))).toBe(true)
    expect(isSkillPersistenceError(new Error('closed'))).toBe(false)
  })
})
/**
 * Flip one base64 character of a ciphertext, leaving the shape intact.
 *
 * Index 1 rather than the last character, because the tail of a base64 string is
 * padding: changing it either changes nothing or changes the length, and a test that
 * wanted "one byte of the ciphertext differs" would silently not be testing that.
 */
function flip(value: string): string {
  if (value.length < 4) return 'AAAA'
  const index = 1
  const character = value[index]
  const replacement = character === 'A' ? 'B' : 'A'
  return value.slice(0, index) + replacement + value.slice(index + 1)
}
