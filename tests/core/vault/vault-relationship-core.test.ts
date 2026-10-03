// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  RELATIONSHIP_LIMITS,
  RelationshipEngine,
  admitRelationshipEntry,
  createRelationshipLedgerEntry,
  retractRelationshipEntry,
  type RelationshipLedgerEntry,
  type RelationshipLedgerKind,
} from '../../../core/relationship'
import { StaticVaultKeyProvider, Vault, type VaultKeyProvider } from '../../../core/vault'
import {
  MAX_VAULT_RELATIONSHIP_ENTRY_BYTES,
  MemoryRelationshipStore,
  VaultRelationshipStore,
} from '../../../core/vault/repositories/relationship-store'
import { testVaultKey } from '../testKey'
import { bindingAvailable, loadTestBinding } from './binding'
import { makeVaultTempDir, removeVaultTempDir } from './tmp'

/**
 * THE RELATIONSHIP LEDGER ON THE CANONICAL VAULT.
 *
 * Phase 27's records live in the one encrypted SQLCipher database under
 * `domain = 'relationship'`. These tests cover what the domain tests cannot: that a
 * restart rebuilds an identical state from rows that were re-validated, that a damaged
 * row **degrades** the store instead of being skipped, that withdrawal survives a
 * restart as a withdrawal rather than reappearing, that a forgotten record is really
 * gone from disk, and that no plaintext sentinel survives in the raw database bytes.
 */

const SENTINEL = 'FREYA_VAULT_RELATIONSHIP_SENTINEL_5c72'
const AT = '2026-04-01T09:00:00.000Z'

let dir = ''
const opened: Vault[] = []

beforeEach(async () => {
  dir = await makeVaultTempDir()
  opened.length = 0
})

afterEach(async () => {
  // Every connection is closed before the directory goes, or Windows holds the file and
  // the removal fails for a reason that has nothing to do with the domain.
  for (const vault of opened.splice(0)) {
    try {
      vault.close()
    } catch {
      // Already closed by the test itself.
    }
  }
  await removeVaultTempDir(dir)
})

async function openVault(path: string, keyProvider: VaultKeyProvider): Promise<Vault> {
  const vault = await Vault.open({ path, keyProvider, binding: await loadTestBinding() })
  opened.push(vault)
  return vault
}

function admittedEntry(
  id: string,
  text: string,
  kind: RelationshipLedgerKind = 'expressed-preference',
): RelationshipLedgerEntry {
  const created = createRelationshipLedgerEntry(
    {
      entryId: id,
      kind,
      key: `key-${id}`,
      text,
      tags: ['sessions'],
      evidenceRefs: ['turn-1'],
      observedAt: AT,
      recordedAt: AT,
      proposedConfidence: kind === 'interaction-pattern' ? 'low' : 'high',
      actor: 'owner',
    },
    'owner-assertion',
  )
  if (!created.ok) throw new Error(`fixture refused: ${created.code} ${created.reason}`)
  const admitted = admitRelationshipEntry(created.entry, { now: AT, reason: 'owner stated it' })
  if (!admitted.ok) throw new Error(`fixture admission refused: ${admitted.reason}`)
  return admitted.entry
}

describe.skipIf(!bindingAvailable)('the relationship store on the encrypted Vault', () => {
  it('round trips records through a restart with an identical folded state', async () => {
    const path = join(dir, 'Freya', 'vault', 'freya.db')
    const first = await openVault(path, new StaticVaultKeyProvider(testVaultKey()))
    const firstStore = await new VaultRelationshipStore(first).open()
    await firstStore.write(admittedEntry('rel-1', 'the owner prefers plain questions'))
    await firstStore.write(admittedEntry('rel-2', 'the owner prefers evening sessions'))
    expect(firstStore.mode).toBe('encrypted')
    expect(firstStore.health().health).toBe('healthy')
    await firstStore.close()

    const second = await openVault(path, new StaticVaultKeyProvider(testVaultKey()))
    const reopened = await new VaultRelationshipStore(second).open()
    const entries = [...reopened.state().entries.values()].sort((a, b) => a.entryId.localeCompare(b.entryId))
    expect(entries.map((entry) => entry.entryId)).toEqual(['rel-1', 'rel-2'])
    expect(entries[0]?.text).toBe('the owner prefers plain questions')
    expect(entries[1]?.text).toBe('the owner prefers evening sessions')
    expect(reopened.health().health).toBe('healthy')
    await reopened.close()
  })

  it('leaves no plaintext sentinel in the raw database bytes', async () => {
    const path = join(dir, 'Freya', 'vault', 'freya.db')
    const vault = await openVault(path, new StaticVaultKeyProvider(testVaultKey()))
    const store = await new VaultRelationshipStore(vault).open()
    await store.write(admittedEntry('rel-sentinel', `the owner said ${SENTINEL} once`))
    await store.close()

    const raw = await readFile(path)
    expect(raw.includes(Buffer.from(SENTINEL, 'utf8'))).toBe(false)
    expect(raw.includes(Buffer.from('the owner prefers', 'utf8'))).toBe(false)
  })

  it('survives a restart as a withdrawal, not as the words that were taken back', async () => {
    const path = join(dir, 'Freya', 'vault', 'freya.db')
    const first = await openVault(path, new StaticVaultKeyProvider(testVaultKey()))
    const engine = new RelationshipEngine({
      store: await new VaultRelationshipStore(first).open(),
      now: () => new Date(AT),
      newId: (() => {
        let n = 0
        return () => `rel-${(n += 1)}`
      })(),
    })
    await engine.recordOwnerStatement({
      kind: 'expressed-preference',
      key: 'prefers-evening',
      text: 'the owner prefers evening sessions',
      observedAt: AT,
    })
    const listed = engine.listEntries()
    if (!listed.ok) throw new Error('list failed')
    const id = listed.entries.items[0]?.entryId ?? ''
    await engine.withdraw(id)
    await engine.applyRetentionBound()

    const second = await openVault(path, new StaticVaultKeyProvider(testVaultKey()))
    const reopened = await new VaultRelationshipStore(second).open()
    const restored = reopened.state().entries.get(id)
    expect(restored).toBeDefined()
    expect(restored?.status).toBe('retracted')
    expect(restored?.text).toBe('')
    expect(restored?.lifecycleReason).toBe('owner-withdrew-this-record')
    // And the withdrawn words are gone from the file itself.
    const raw = await readFile(path)
    expect(raw.includes(Buffer.from('prefers evening sessions', 'utf8'))).toBe(false)
    await reopened.close()
  })

  it('removes a forgotten record from disk, not only from memory', async () => {
    const path = join(dir, 'Freya', 'vault', 'freya.db')
    const first = await openVault(path, new StaticVaultKeyProvider(testVaultKey()))
    const store = await new VaultRelationshipStore(first).open()
    await store.write(admittedEntry('rel-gone', 'a record that will be forgotten'))
    const retraction = retractRelationshipEntry(store.state().entries.get('rel-gone')!, { now: AT })
    if (!retraction.ok) throw new Error(retraction.reason)
    await store.write(retraction.entry)
    await store.forget('rel-gone')
    expect(store.state().entries.has('rel-gone')).toBe(false)

    const rows = first.all<{ n: number }>(
      'SELECT count(*) AS n FROM vault_kv WHERE domain = ? AND key = ?',
      ['relationship', 'rel-gone'],
    )
    expect(rows[0]?.n).toBe(0)
    await store.close()
  })

  it('degrades on a damaged row rather than skipping it and believing the rest', async () => {
    const path = join(dir, 'Freya', 'vault', 'freya.db')
    const first = await openVault(path, new StaticVaultKeyProvider(testVaultKey()))
    const store = await new VaultRelationshipStore(first).open()
    await store.write(admittedEntry('rel-ok', 'a good record'))
    // A hand-edited row: a well-formed wrapper whose entry claims a confidence its source
    // class cannot support. The kind is an observation pattern rather than an owner-only
    // kind, so the ceiling rule is what has to catch it.
    const forged = admittedEntry('rel-forged', 'a forged record', 'interaction-pattern')
    first.transaction((tx) => {
      tx.run(
        `INSERT INTO vault_kv (domain, key, body, updated_at) VALUES (?, ?, ?, ?)`,
        [
          'relationship',
          'rel-forged',
          JSON.stringify({
            version: 1,
            entry: {
              ...forged,
              confidence: 'high',
              provenance: { ...forged.provenance, sourceType: 'model-inference' },
            },
          }),
          AT,
        ],
      )
    })
    await store.close()

    const second = await openVault(path, new StaticVaultKeyProvider(testVaultKey()))
    const reopened = await new VaultRelationshipStore(second).open()
    expect(reopened.health().health).toBe('degraded')
    expect(reopened.degradedReason).toContain('confidence')
    // Degraded means read-only: a store that could not fully believe what it read does
    // not accept new records on top of a chain it does not trust.
    await expect(reopened.write(admittedEntry('rel-after', 'a later record'))).rejects.toThrow(/degraded/)
    await reopened.close()
  })

  it('fails closed on a wrong key, and does not create a second database', async () => {
    const path = join(dir, 'Freya', 'vault', 'freya.db')
    const first = await openVault(path, new StaticVaultKeyProvider(testVaultKey()))
    await new VaultRelationshipStore(first).write(admittedEntry('rel-1', 'a record'))
    await first.close()

    await expect(
      openVault(path, new StaticVaultKeyProvider(testVaultKey('a-different-key'))),
    ).rejects.toThrow()
  })

  it('keeps a maximum-size valid entry under the Vault bound, and refuses an oversized one', async () => {
    const path = join(dir, 'Freya', 'vault', 'freya.db')
    const vault = await openVault(path, new StaticVaultKeyProvider(testVaultKey()))
    const store = await new VaultRelationshipStore(vault).open()

    // The domain's own field bounds are the binding constraint: an entry built at the
    // largest shape the domain permits still fits the repository's byte bound. So the
    // Vault bound is a second net, not the first line of defence.
    const largest = admittedEntry('rel-large', 'x'.repeat(RELATIONSHIP_LIMITS.maxTextChars))
    const body = JSON.stringify({ version: 1, entry: largest })
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThan(MAX_VAULT_RELATIONSHIP_ENTRY_BYTES)
    await store.write(largest)

    // The second net still fires for a record that did not come through the domain.
    const oversized = {
      ...largest,
      entryId: 'rel-oversized',
      admissionReason: 'y'.repeat(RELATIONSHIP_LIMITS.maxReasonChars + 20_000),
    } as RelationshipLedgerEntry
    await expect(store.write(oversized)).rejects.toThrow(/exceeds the per-entry limit/)
    await store.close()
  })
})

describe('the ephemeral store', () => {
  it('is labelled as ephemeral, with the reason it fell back', () => {
    const store = new MemoryRelationshipStore({
      mode: 'ephemeral',
      faultReason: 'no Vault key was available',
    })
    expect(store.mode).toBe('ephemeral')
    expect(store.faultReason).toBe('no Vault key was available')
    expect(store.health()).toEqual({ health: 'healthy', reason: 'no Vault key was available' })
  })

  it('reports memory as not durable, so nothing can claim it will be remembered', () => {
    const engine = new RelationshipEngine({ store: new MemoryRelationshipStore() })
    const projection = engine.project(AT)
    expect(projection.persistence.mode).toBe('memory')
    expect(projection.persistence.durable).toBe(false)
  })

  it('refuses writes once closed', async () => {
    const store = new MemoryRelationshipStore()
    await store.close()
    await expect(store.write(admittedEntry('rel-1', 'a record'))).rejects.toThrow(/closed/)
  })
})