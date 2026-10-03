// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import {
  EphemeralWorldStore,
  NO_WORLD_KEY_REASON,
  WorldEngine,
  decodeWorldSnapshot,
  worldLimits,
  type WorldEvidenceRecord,
  type WorldPersistencePort,
} from '../../../core/world'
import { StaticVaultKeyProvider, Vault, VaultWorldStore } from '../../../core/vault'
import { testVaultKey } from '../testKey'
import { bindingAvailable, loadTestBinding } from '../vault/binding'
import { makeVaultTempDir, removeVaultTempDir } from '../vault/tmp'
import { T0, anaWorksOnProject, emptyHolder, harness, memoryStore } from './fixture'

/**
 * THE WORLD'S DURABILITY — Phase 22's persistence and its promises.
 *
 * The claims under test:
 *
 *  1. **One encrypted Vault, one table set.** World evidence is not a file of its own:
 *     it is rows in the canonical per-user SQLCipher database, and there is no second
 *     database, no JSONL file and no dual write anywhere on the path.
 *  2. **A restart reproduces the same world**, projection for projection, from the
 *     same durable evidence.
 *  3. **A wrong key fails closed at the Vault**, and a row that authenticates but is not
 *     a legal record fails closed at the codec. Never a partial read, never a silent
 *     fallback, never a second store standing in.
 *  4. **A withdrawn claim stays withdrawn across a restart**, because a withdrawal is a
 *     durable record rather than a deletion.
 *  5. **The codec re-checks the channel's ceiling**, so a rule tightened after a row was
 *     written is still enforced.
 *  6. **No Vault means ephemeral and honest**, never `durable: true` on a store that
 *     loses everything.
 *
 * The encryption proofs (1 and 3, first half) run only when
 * `FREYA_VAULT_BINDING_MODULE` names a selected binding, exactly like the rest of the
 * Vault suite: binding selection is blocked pending the permissive Windows audit, and
 * this lane stays binding-agnostic rather than naming one.
 */

let dir = ''

beforeEach(async () => {
  dir = await makeVaultTempDir()
})

afterEach(async () => {
  await removeVaultTempDir(dir)
})

function vaultPath(name = 'freya.db'): string {
  return join(dir, 'Freya', 'vault', name)
}

async function openVault(path = vaultPath()): Promise<Vault> {
  return Vault.open({
    path,
    keyProvider: new StaticVaultKeyProvider(testVaultKey()),
    binding: await loadTestBinding(),
  })
}

/** A Vault-backed world engine, seeded with the happy-path claim. */
async function seededEngine(vault: Vault, start: Date | null = null): Promise<WorldEngine> {
  const world = harness({ store: new VaultWorldStore(vault), ...(start === null ? {} : { start }) })
  for (const request of anaWorksOnProject()) world.owner(request)
  await world.engine.settled()
  return world.engine
}

describe('the world store is one Vault, not a store of its own', () => {
  it.skipIf(!bindingAvailable)('writes no file of its own and leaves no plaintext claim', async () => {
    const path = vaultPath()
    const vault = await openVault(path)
    const engine = await seededEngine(vault, T0)
    await engine.close()
    // The engine closed; the Vault is Core's to close, exactly like the Mission store.
    vault.close()

    // No second database, no JSONL, no per-domain encrypted file beside the Vault.
    expect(existsSync(path)).toBe(true)
    expect(existsSync(join(dir, 'events.jsonl.world'))).toBe(false)
    expect(existsSync(join(dir, 'world.enc'))).toBe(false)

    const raw = readFileSync(path)
    for (const leak of ['Ana', 'Atlas', 'works_on', 'owner-assertion', 'wev-000001']) {
      expect(raw.includes(Buffer.from(leak, 'utf8'))).toBe(false)
    }
  })

  it.skipIf(!bindingAvailable)('keeps Mission content and world evidence in the same database', async () => {
    const path = vaultPath()
    const vault = await openVault(path)
    expect(vault.schemaVersion()).toBeGreaterThanOrEqual(2)
    const engine = await seededEngine(vault, T0)
    await engine.close()

    // Both domains, one file, one key. The world tables are the Vault's, not a
    // separate database's.
    const tables = vault
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((row) => row.name)
    expect(tables).toContain('world_evidence')
    expect(tables).toContain('world_meta')
    expect(tables).toContain('vault_kv')
    vault.close()
  })

  it.skipIf(!bindingAvailable)('refuses a wrong key at the Vault rather than opening anything', async () => {
    const path = vaultPath()
    const first = await openVault(path)
    await seededEngine(first, T0)
    first.close()

    await expect(
      Vault.open({
        path,
        keyProvider: new StaticVaultKeyProvider(testVaultKey('a different key entirely')),
        binding: await loadTestBinding(),
      }),
    ).rejects.toThrow()
  })

  it.skipIf(!bindingAvailable)('reports a missing key as fail-closed, with no database created', async () => {
    const path = vaultPath()
    await expect(
      Vault.open({
        path,
        keyProvider: new StaticVaultKeyProvider(null, 'no Vault key is available on this machine'),
        binding: await loadTestBinding(),
      }),
    ).rejects.toThrow()
    expect(existsSync(path)).toBe(false)
  })

  it('reports its own durability, and never the Vault path or a key', () => {
    // No Vault is needed to be asked what it *would* say: durability is a property of
    // the mechanism this class chose, and it must be readable without opening anything.
    const port = new VaultWorldStore({} as Vault)
    expect(port.mode).toBe('encrypted')
    expect(port.durable).toBe(true)
    expect(port.durabilityReason).toBeNull()
    expect(port.faultReason).toBeNull()
    // Nothing this class exposes names a database, a path or key material.
    const exposed = [port.mode, port.durabilityReason, port.faultReason]
      .filter((value): value is string => typeof value === 'string')
      .join(' ')
    expect(exposed).not.toMatch(/freya\.db|[A-Za-z0-9]{32,}|\\/)
  })
})

describe('a restart reproduces the same world', () => {
  it.skipIf(!bindingAvailable)('produces an identical projection for the same durable evidence', async () => {
    const path = vaultPath()
    const first = await openVault(path)
    const seeded = await seededEngine(first, T0)
    const before = JSON.stringify(seeded.summary())
    const beforeGraph = JSON.stringify(seeded.relations({ focusEntityId: null, kinds: null, maxDepth: 1 }))
    await seeded.close()
    first.close()

    // The same injected instant. Freshness is computed against a supplied clock, which
    // is what makes "the same evidence gives the same projection" a claim about the
    // evidence rather than about the day the test happened to run.
    const second = await openVault(path)
    const reopened = new WorldEngine({
      persistence: new VaultWorldStore(second),
      now: () => new Date(T0),
    })
    const opened = await reopened.open()
    expect(opened.ok).toBe(true)
    expect(opened.recovered).toBe(3)

    expect(JSON.stringify(reopened.summary())).toBe(before)
    expect(JSON.stringify(reopened.relations({ focusEntityId: null, kinds: null, maxDepth: 1 }))).toBe(beforeGraph)
    await reopened.close()
    second.close()
  })

  it.skipIf(!bindingAvailable)('re-seeds the evidence counter so a restart cannot mint an id twice', async () => {
    const path = vaultPath()
    const first = await openVault(path)
    const seeded = await seededEngine(first, T0)
    const ids = seeded.evidenceIds()
    await seeded.close()
    first.close()

    const second = await openVault(path)
    const reopened = new WorldEngine({
      persistence: new VaultWorldStore(second),
      now: () => new Date(T0),
    })
    await reopened.open()
    const added = reopened.admit({
      request: { kind: 'entity', entityType: 'person', name: 'Bo' },
      channel: 'owner_statement',
      actor: 'owner',
      sensitivity: 'personal',
    })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    expect(ids).not.toContain(added.evidenceId)
    await reopened.close()
    second.close()
  })

  it.skipIf(!bindingAvailable)('keeps a withdrawal withdrawn after a restart', async () => {
    const path = vaultPath()
    const first = await openVault(path)
    const world = harness({ store: new VaultWorldStore(first), start: T0 })
    for (const request of anaWorksOnProject()) world.owner(request)
    await world.engine.settled()
    const target = world.engine.evidenceIds()[0]
    expect(target).toBeDefined()
    const withdrawn = world.engine.withdraw(target ?? '', 'the owner withdrew this claim', {
      channel: 'owner_statement',
      actor: 'owner',
      sensitivity: 'personal',
    })
    expect(withdrawn.ok).toBe(true)
    await world.engine.settled()
    await world.engine.close()
    first.close()

    const second = await openVault(path)
    const reopened = new WorldEngine({
      persistence: new VaultWorldStore(second),
      now: () => new Date(T0),
    })
    await reopened.open()
    // The withdrawn claim is still there, still withdrawn. A restart must not be the
    // thing that resurrects it.
    expect(reopened.evidenceIds()).toContain(target)
    const detail = reopened.entity(entityIdFor(world, 'Ana'), (fold) => fold.conflicts)
    expect(detail.entity?.freshness).toBe('withdrawn')
    await reopened.close()
    second.close()
  })

  it('re-seeds the counter from the durable high-water mark, not only the surviving rows', async () => {
    // Eviction by the retention bound is the case reading only the retained ids would
    // get wrong: the oldest rows are gone, and re-seeding from the survivors would hand
    // back an id that was already issued and retired.
    const holder = emptyHolder()
    const first = harness({ store: memoryStore(holder), limits: { maxEvidenceRecords: 2 } })
    for (let index = 0; index < 5; index += 1) {
      first.owner({ kind: 'entity', entityType: 'person', name: `Person${index}` })
    }
    await first.engine.settled()
    const minted = first.engine.evidenceIds()
    await first.engine.close()

    const second = harness({ store: memoryStore(holder) })
    await second.engine.open()
    const added = second.owner({ kind: 'entity', entityType: 'person', name: 'Later' })
    expect(added.ok).toBe(true)
    for (const id of minted) {
      if (added.ok) expect(added.evidenceId).not.toBe(id)
    }
    await second.engine.close()
  })

  it('reports an empty world and a reason when the ledger cannot be believed', async () => {
    const holder = emptyHolder()
    holder.snapshot = { v: 99, records: [], sequence: 0 } as never
    const engine = new WorldEngine({ persistence: memoryStore(holder) })
    const opened = await engine.open()
    expect(opened.ok).toBe(false)
    expect(opened.recovered).toBe(0)
    expect(opened.degradedReason).not.toBeNull()
    // The whole world, not part of it: a world rebuilt from half a history would be a
    // world whose shape depends on what was damaged.
    expect(engine.summary().counts.evidenceRecords).toBe(0)
    await engine.close()
  })

  it('refuses a snapshot whose version this build does not read', () => {
    expect(() => decodeWorldSnapshot({ v: 99, records: [], sequence: 0 })).toThrow(/version 99/)
  })

  it('refuses a snapshot holding the same evidence id twice', () => {
    const record = validRecord()
    expect(() => decodeWorldSnapshot({ v: 1, records: [record, record], sequence: 1 })).toThrow(
      /two records with the id/,
    )
  })

  it('refuses a snapshot with more records than this build retains', () => {
    const records = Array.from({ length: 5 }, (_unused, index) => ({
      ...validRecord(),
      evidenceId: `wev-${String(index + 1).padStart(6, '0')}`,
      sequence: index + 1,
    }))
    const tight = worldLimits({ maxEvidenceRecords: 3 })
    expect(() => decodeWorldSnapshot({ v: 1, records, sequence: 5 }, tight)).toThrow(
      /more records than this build retains/,
    )
  })
})

describe('a ledger this build will not believe fails closed', () => {
  it.skipIf(!bindingAvailable)('refuses the whole ledger when one row is not a legal record', async () => {
    const path = vaultPath()
    const vault = await openVault(path)
    const seeded = await seededEngine(vault, T0)
    await seeded.close()

    // A row that lives inside SQLCipher's authenticated pages, so the database opens
    // and authenticates perfectly, and is nonetheless a claim its channel cannot
    // support: `verified` from a `worker_claim`. The codec is what refuses it, and it
    // refuses all of it rather than serving the rows that happened to be legal.
    vault.run(
      `INSERT INTO world_evidence (
         evidence_id, sequence, kind, channel, recorded_at, observed_at, source, actor,
         source_ref, sensitivity, epistemic, confidence, evidence_summary, supersedes,
         entity, relation, withdrawal
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'wev-000099',
        99,
        'entity',
        'worker_claim',
        T0.toISOString(),
        T0.toISOString(),
        'external-untrusted',
        'agent:alpha',
        null,
        'personal',
        'verified',
        'verified',
        null,
        null,
        JSON.stringify({ entityType: 'person', name: 'Forged', aliases: [], attributes: {} }),
        null,
        null,
      ],
    )

    const store = new VaultWorldStore(vault)
    expect(store.faultReason).toBeNull()
    const loaded = await store.load()
    expect(loaded.ok).toBe(false)
    if (loaded.ok) return
    expect(loaded.code).toBe('degraded')
    expect(store.faultReason).not.toBeNull()

    // And nothing is written from a store it has stopped trusting: writing from a
    // partial read is how the rest of the ledger would be lost.
    await expect(store.commit({ v: 1, records: [], sequence: 0 })).rejects.toThrow(/damaged/)
    await store.close()
    vault.close()
  })

  it.skipIf(!bindingAvailable)('reports the fault through the projection rather than pretending to be healthy', async () => {
    const path = vaultPath()
    const vault = await openVault(path)
    await seededEngine(vault, T0)

    vault.run(
      `INSERT INTO world_evidence (
         evidence_id, sequence, kind, channel, recorded_at, observed_at, source, actor,
         source_ref, sensitivity, epistemic, confidence, evidence_summary, supersedes,
         entity, relation, withdrawal
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'wev-000098',
        98,
        'entity',
        'model_hypothesis',
        T0.toISOString(),
        T0.toISOString(),
        'model-inference',
        'superuser',
        null,
        'personal',
        'inferred',
        'verified',
        null,
        null,
        JSON.stringify({ entityType: 'person', name: 'Impostor', aliases: [], attributes: {} }),
        null,
        null,
      ],
    )

    const engine = new WorldEngine({ persistence: new VaultWorldStore(vault), now: () => new Date(T0) })
    await engine.open()
    const summary = engine.summary()
    expect(summary.health).toBe('unavailable')
    expect(summary.persistence.faultReason).not.toBeNull()
    expect(summary.counts.evidenceRecords).toBe(0)
    await engine.close()
    vault.close()
  })

  it.skipIf(!bindingAvailable)('refuses a row whose nested claim is not parseable', async () => {
    const path = vaultPath()
    const vault = await openVault(path)
    await seededEngine(vault, T0)
    vault.run(
      `INSERT INTO world_evidence (
         evidence_id, sequence, kind, channel, recorded_at, observed_at, source, actor,
         source_ref, sensitivity, epistemic, confidence, evidence_summary, supersedes,
         entity, relation, withdrawal
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'wev-000097',
        97,
        'entity',
        'owner_statement',
        T0.toISOString(),
        T0.toISOString(),
        'owner-assertion',
        'owner',
        null,
        'personal',
        'asserted',
        'high',
        null,
        null,
        '{"entityType":"person","name":',
        null,
        null,
      ],
    )
    const loaded = await new VaultWorldStore(vault).load()
    expect(loaded.ok).toBe(false)
    vault.close()
  })
})

describe('the codec re-checks what the writer already checked', () => {
  it('refuses a stored claim whose confidence outranks its channel', () => {
    const record = validRecord()
    expect(() =>
      decodeWorldSnapshot({
        v: 1,
        records: [{ ...record, channel: 'worker_claim', confidence: 'high' }],
        sequence: 1,
      }),
    ).toThrow(/cannot support/)
  })

  it('refuses a stored claim recorded as verified from any evidence channel', () => {
    const record = validRecord()
    for (const channel of ['owner_statement', 'system_observation', 'worker_claim', 'model_hypothesis', 'imported_content']) {
      expect(() =>
        decodeWorldSnapshot({
          v: 1,
          records: [{ ...record, channel, epistemic: 'verified' }],
          sequence: 1,
        }),
      ).toThrow(/cannot be stored as verified|which its channel/)
    }
  })

  it('accepts a withdrawal as settled, because it asserts nothing about the world', () => {
    const record = validRecord()
    const withdrawal: WorldEvidenceRecord = {
      ...record,
      evidenceId: 'wev-000002',
      sequence: 2,
      kind: 'withdrawal',
      epistemic: 'verified',
      confidence: 'verified',
      entity: null,
      relation: null,
      withdrawal: { targetEvidenceId: 'wev-000001', reason: 'the owner withdrew this claim' },
    }
    const decoded = decodeWorldSnapshot({ v: 1, records: [withdrawal], sequence: 2 })
    expect(decoded.records[0]?.withdrawal?.targetEvidenceId).toBe('wev-000001')
    expect(decoded.records[0]?.epistemic).toBe('verified')
  })

  it('refuses a record with an unrecognised shape rather than adopting the fields it recognises', () => {
    const record = validRecord() as unknown as Record<string, unknown>
    expect(() => decodeWorldSnapshot({ v: 1, records: [{ ...record, capability: 'security.stop' }], sequence: 1 })).toThrow(
      /unrecognised shape/,
    )
  })

  it('refuses an entity claim whose name no longer matches what it was stored as', () => {
    const record = validRecord()
    expect(() =>
      decodeWorldSnapshot({
        v: 1,
        records: [
          {
            ...record,
            entity: { entityType: 'person', name: '  ana  ', aliases: [], attributes: {} },
          },
        ],
        sequence: 1,
      }),
    ).toThrow(/not normalisable/)
  })

  it('refuses a stored entity that claims a name reserved to Freya or the owner', () => {
    // Identity spoofing at rest. `ent_freya` and `ent_owner` are Core-owned singletons
    // whose identity is not a record anybody can write, and the invariant is that it
    // stops being true on the *way back in* as well as on the way out: a row that
    // names Freya must not survive a restart as a claim about a person called Freya.
    for (const name of ['Freya', 'freya', 'FREYA', 'Owner']) {
      expect(() =>
        decodeWorldSnapshot({
          v: 1,
          records: [{ ...validRecord(), entity: { entityType: 'person', name, aliases: [], attributes: {} } }],
          sequence: 1,
        }),
      ).toThrow()
    }
  })

  it('refuses a stored relation whose endpoints its type does not accept', () => {
    // Relationship forgery at rest: the pairing has to be expressible in order to be
    // refusable, and this is the pairing check running on a row rather than on a
    // request.
    expect(() =>
      decodeWorldSnapshot({
        v: 1,
        records: [
          {
            ...validRecord(),
            kind: 'relation',
            entity: null,
            relation: {
              relationType: 'works_on',
              subject: { form: 'named', entityType: 'person', name: 'Ana' },
              object: { form: 'named', entityType: 'place', name: 'Lisbon' },
              validUntil: null,
            },
          },
        ],
        sequence: 1,
      }),
    ).toThrow()
  })

  it('refuses a record naming an actor that is not a principal', () => {
    const record = validRecord()
    expect(() =>
      decodeWorldSnapshot({ v: 1, records: [{ ...record, actor: 'superuser' }], sequence: 1 }),
    ).toThrow(/usable actor/)
  })
})

describe('a Core with no Vault is honest rather than silently lossy', () => {
  it('reports ephemeral with a sentence saying why', () => {
    const port = new EphemeralWorldStore()
    expect(port.mode).toBe('ephemeral')
    expect(port.durable).toBe(false)
    expect(port.durabilityReason).toBe(NO_WORLD_KEY_REASON)
    expect(port.durabilityReason).toContain('will not survive a restart')
  })

  it('keeps real records in memory and still refuses an illegal one', async () => {
    const port: WorldPersistencePort = new EphemeralWorldStore()
    const engine = new WorldEngine({ persistence: port })
    await engine.open()
    expect(engine.admit({
      request: { kind: 'entity', entityType: 'person', name: 'Ana' },
      channel: 'owner_statement',
      actor: 'owner',
      sensitivity: 'personal',
    }).ok).toBe(true)
    await engine.settled()
    expect(engine.summary().counts.evidenceRecords).toBe(1)
    await expect(port.commit({ v: 99, records: [], sequence: 0 } as never)).rejects.toThrow()
  })

  it('writes no file at all when there is no Vault', async () => {
    const path = join(dir, 'world.enc')
    const port = new EphemeralWorldStore()
    const engine = new WorldEngine({ persistence: port })
    await engine.open()
    engine.admit({
      request: { kind: 'entity', entityType: 'person', name: 'Ana' },
      channel: 'owner_statement',
      actor: 'owner',
      sensitivity: 'personal',
    })
    await engine.settled()
    await engine.close()
    expect(existsSync(path)).toBe(false)
  })
})

/** The entity id Core derived for `Ana`, from the fold the harness already built. */
function entityIdFor(world: ReturnType<typeof harness>, name: string): string {
  const node = world.engine.entities({}).entities.find((entry) => entry.name === name)
  if (node === undefined) throw new Error(`no entity named ${name} was folded`)
  return node.entityId
}

describe('the ledger schema itself cannot express authority', () => {
  it('has no authority, permission or capability column to write into', () => {
    // Capability escalation at rest. The admission path already refuses those fields,
    // and the *schema* refusing to hold them is the second line: a row written by any
    // other code, any future build or any mistake has nowhere to put a permission.
    const migration = readFileSync(
      join(fileURLToPath(new URL('../../../core/vault/schema.ts', import.meta.url))),
      'utf8',
    )
    const table = migration.slice(
      migration.indexOf('CREATE TABLE IF NOT EXISTS world_evidence'),
      migration.indexOf('CREATE INDEX IF NOT EXISTS world_evidence_sequence'),
    )
    const body = table.slice(table.indexOf('(') + 1, table.lastIndexOf(')'))
    const columns = body
      .split(',')
      .map((line) => line.trim().split(/\s+/)[0] ?? '')
      .filter((column) => column.length > 0)
    expect(columns).toEqual([
      'evidence_id',
      'sequence',
      'kind',
      'channel',
      'recorded_at',
      'observed_at',
      'source',
      'actor',
      'source_ref',
      'sensitivity',
      'epistemic',
      'confidence',
      'evidence_summary',
      'supersedes',
      'entity',
      'relation',
      'withdrawal',
    ])
    for (const forbidden of ['authority', 'capability', 'permission', 'grant', 'allowed', 'role']) {
      expect(columns).not.toContain(forbidden)
    }
  })
})

/** A minimal legal record, for codec tests that are not about the record's content. */
function validRecord(): WorldEvidenceRecord {
  return {
    evidenceId: 'wev-000001',
    sequence: 1,
    kind: 'entity',
    channel: 'owner_statement',
    recordedAt: '2026-06-01T09:00:00.000Z',
    observedAt: '2026-06-01T09:00:00.000Z',
    source: 'owner-assertion',
    actor: 'owner',
    sourceRef: null,
    sensitivity: 'personal',
    epistemic: 'asserted',
    confidence: 'high',
    evidenceSummary: null,
    supersedes: null,
    entity: { entityType: 'person', name: 'Ana', aliases: [], attributes: {} },
    relation: null,
    withdrawal: null,
  }
}