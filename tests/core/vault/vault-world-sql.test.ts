// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'

import { VAULT_MIGRATIONS, applyMigrations } from '../../../core/vault/schema'
import type { Vault, VaultTransaction } from '../../../core/vault'
import { VaultWorldStore } from '../../../core/vault'
import { WorldEngine, type WorldEvidenceRecord } from '../../../core/world'
import { T0, anaWorksOnProject } from '../world/fixture'
import { openMemoryConnection } from './sql-adapter'

/**
 * THE WORLD LEDGER'S SQL, EXERCISED FOR REAL WITHOUT A SQLCIPHER BINDING.
 *
 * Binding selection is blocked pending the permissive Windows audit, so `Vault.open`
 * refuses to run and every assertion about the ledger's SQL would be skipped. These
 * tests instead apply the **real** migrations to a real SQL engine and hand the
 * repository a `Vault`-shaped harness, so what runs is the production DDL, the
 * production inserts, the production transaction, the production reads and the
 * production codec — only the page encryption is absent.
 *
 * What this file proves:
 *
 *  1. Migration 2 really creates `world_evidence` and `world_meta` in the canonical
 *     schema, and the whole migration set still commits as one transaction.
 *  2. A record round-trips through typed columns and comes back re-validated.
 *  3. A commit is atomic: a rejected record leaves the previous ledger intact.
 *  4. Eviction and withdrawal leave no orphan row behind.
 *  5. A restart is deterministic, and a withdrawal stays withdrawn.
 *  6. The persisted high-water mark survives eviction, so an id is never reissued.
 *
 * What this file cannot prove, and does not claim: anything about bytes on disk. The
 * encryption proofs stay gated on `FREYA_VAULT_BINDING_MODULE`; see `sql-adapter.ts`.
 */

let connection: ReturnType<typeof openMemoryConnection>

beforeEach(() => {
  connection = openMemoryConnection()
})

/** The repository's real code path, over the real schema, on an in-memory database. */
function store(): VaultWorldStore {
  // The real migration set, applied by the real applier, to a real SQL engine.
  applyMigrations(connection as never, VAULT_MIGRATIONS, () => new Date(T0))
  return new VaultWorldStore(harnessVault())
}

/** The `Vault` surface the repository is written against, over the same database. */
function harnessVault(): Vault {
  const connection_ = connection
  const vault: VaultTransaction & Pick<Vault, 'transaction'> = {
    exec: (sql) => connection_.exec(sql),
    run: (sql, params) => connection_.prepare(sql).run(params) as { changes: number },
    get: <T>(sql: string, params?: readonly unknown[] | Readonly<Record<string, unknown>>): T | undefined =>
      connection_.prepare(sql).get(params) as T | undefined,
    all: <T>(sql: string, params?: readonly unknown[] | Readonly<Record<string, unknown>>): T[] =>
      connection_.prepare(sql).all(params) as T[],
    transaction: <T>(fn: (tx: VaultTransaction) => T): T => {
      connection_.exec('BEGIN IMMEDIATE')
      try {
        const result = fn(vault)
        connection_.exec('COMMIT')
        return result
      } catch (error) {
        try {
          connection_.exec('ROLLBACK')
        } catch {
          // The transaction is already gone; the original failure is what matters.
        }
        throw error
      }
    },
  }
  return vault as Vault
}

/** Write a row straight into the table, past the codec, as a tampered store would. */
function insertRow(record: WorldEvidenceRecord): void {
  connection
    .prepare(
      `INSERT INTO world_evidence (
         evidence_id, sequence, kind, channel, recorded_at, observed_at, source, actor,
         source_ref, sensitivity, epistemic, confidence, evidence_summary, supersedes,
         entity, relation, withdrawal
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run([
      record.evidenceId,
      record.sequence,
      record.kind,
      record.channel,
      record.recordedAt,
      record.observedAt,
      record.source,
      record.actor,
      record.sourceRef,
      record.sensitivity,
      record.epistemic,
      record.confidence,
      record.evidenceSummary,
      record.supersedes,
      record.entity === null ? null : JSON.stringify(record.entity),
      record.relation === null ? null : JSON.stringify(record.relation),
      record.withdrawal === null ? null : JSON.stringify(record.withdrawal),
    ])
}

function rowCount(table: string): number {
  const row = connection.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number } | undefined
  return row?.n ?? 0
}

async function seeded(store_: VaultWorldStore, requests = anaWorksOnProject()): Promise<WorldEngine> {
  const engine = new WorldEngine({ persistence: store_, now: () => new Date(T0) })
  await engine.open()
  for (const request of requests) {
    const admitted = engine.admit({
      request,
      channel: 'owner_statement',
      actor: 'owner',
      sensitivity: 'personal',
    })
    expect(admitted.ok).toBe(true)
  }
  await engine.settled()
  return engine
}

describe('migration 2 creates the world ledger in the canonical schema', () => {
  it('creates the table, its indexes and the non-secret bookkeeping', () => {
    store()
    const tables = connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name)
    expect(tables).toEqual(expect.arrayContaining(['vault_meta', 'vault_kv', 'world_evidence', 'world_meta']))
    const indexes = connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'world_evidence'")
      .all()
      .map((row) => (row as { name: string }).name)
    expect(indexes).toEqual(expect.arrayContaining(['world_evidence_sequence', 'world_evidence_supersedes']))
  })

  it('seeds the high-water mark rather than trusting the rows to imply it', () => {
    store()
    const row = connection
      .prepare("SELECT value FROM world_meta WHERE key = 'evidence_sequence'")
      .get() as { value: string } | undefined
    expect(row?.value).toBe('0')
  })

  it('is idempotent, because migrations run on every open', () => {
    store()
    expect(() => store()).not.toThrow()
    expect(rowCount('world_evidence')).toBe(0)
  })
})

describe('a record round-trips through typed columns', () => {
  it('stores one row per record and reads it back identically', async () => {
    const world = await seeded(store())
    await world.close()
    expect(rowCount('world_evidence')).toBe(3)

    const reloaded = await new VaultWorldStore(harnessVault()).load()
    expect(reloaded.ok).toBe(true)
    if (!reloaded.ok) return
    expect(reloaded.snapshot.records).toHaveLength(3)
    expect(reloaded.snapshot.records.map((record) => record.evidenceId)).toEqual([
      'wev-000001',
      'wev-000002',
      'wev-000003',
    ])
    // The nested claim came back out of its JSON column and was re-validated into the
    // same shape, not adopted because it parsed.
    const first = reloaded.snapshot.records[0]
    expect(first?.entity).toEqual({ entityType: 'person', name: 'Ana', aliases: [], attributes: {} })
    expect(first?.source).toBe('owner-assertion')
    expect(first?.sensitivity).toBe('personal')
    expect(reloaded.snapshot.sequence).toBe(3)
  })

  it('orders by replay sequence, not by insertion accident', async () => {
    const world = await seeded(store(), [
      { kind: 'entity', entityType: 'person', name: 'Ana' },
      { kind: 'entity', entityType: 'project', name: 'Atlas' },
      { kind: 'entity', entityType: 'person', name: 'Bo' },
    ])
    await world.close()
    const ids = connection
      .prepare('SELECT evidence_id FROM world_evidence ORDER BY sequence ASC')
      .all()
      .map((row) => (row as { evidence_id: string }).evidence_id)
    expect(ids).toEqual(['wev-000001', 'wev-000002', 'wev-000003'])
  })
})

describe('a commit is one transaction', () => {
  it('leaves the previous ledger intact when a record in the new one is refused', async () => {
    const world = await seeded(store())
    await world.close()
    expect(rowCount('world_evidence')).toBe(3)

    const port = new VaultWorldStore(harnessVault())
    await expect(
      port.commit({
        v: 1,
        // The second record names a principal that is not one. The cast is deliberate:
        // this is the shape a tampered row has, and the codec is what has to notice.
        records: [
          validRecord(),
          {
            ...validRecord(),
            evidenceId: 'wev-000002',
            actor: 'superuser' as WorldEvidenceRecord['actor'],
          },
        ],
        sequence: 2,
      }),
    ).rejects.toThrow()
    // Not one row deleted, not one row added: the whole replacement rolled back.
    expect(rowCount('world_evidence')).toBe(3)
    const reloaded = await port.load()
    expect(reloaded.ok).toBe(true)
    if (!reloaded.ok) return
    expect(reloaded.snapshot.records).toHaveLength(3)
  })

  it('replaces rather than merges, so eviction leaves no orphan row', async () => {
    const port = store()
    await port.commit({ v: 1, records: [validRecord()], sequence: 1 })
    expect(rowCount('world_evidence')).toBe(1)
    await port.commit({ v: 1, records: [], sequence: 1 })
    expect(rowCount('world_evidence')).toBe(0)
  })
})

describe('withdrawal and revision are durable, not deletions', () => {
  it('keeps the withdrawn row and stays withdrawn across a restart', async () => {
    const world = await seeded(store())
    const target = world.evidenceIds()[0]
    expect(target).toBeDefined()
    const withdrawn = world.withdraw(target ?? '', 'the owner withdrew this claim', {
      channel: 'owner_statement',
      actor: 'owner',
      sensitivity: 'personal',
    })
    expect(withdrawn.ok).toBe(true)
    await world.settled()
    await world.close()

    const reopened = new WorldEngine({ persistence: new VaultWorldStore(harnessVault()), now: () => new Date(T0) })
    await reopened.open()
    // Four rows now: the original three plus the withdrawal. The target was not deleted.
    expect(rowCount('world_evidence')).toBe(4)
    expect(reopened.evidenceIds()).toContain(target)
    await reopened.close()
  })

  it('keeps a revision and the record it supersedes', async () => {
    const port = store()
    await port.commit({
      v: 1,
      records: [
        validRecord(),
        {
          ...validRecord(),
          evidenceId: 'wev-000002',
          sequence: 2,
          supersedes: 'wev-000001',
          entity: {
            entityType: 'person',
            name: 'Ana',
            aliases: [],
            attributes: { city: 'Oporto' },
          },
        },
      ],
      sequence: 2,
    })
    const reloaded = await port.load()
    expect(reloaded.ok).toBe(true)
    if (!reloaded.ok) return
    expect(reloaded.snapshot.records[1]?.supersedes).toBe('wev-000001')
    expect(reloaded.snapshot.records[0]?.supersedes).toBeNull()
  })
})

describe('the high-water mark survives eviction', () => {
  it('does not reissue an id whose record the retention bound already dropped', async () => {
    const port = store()
    const engine = new WorldEngine({
      persistence: port,
      now: () => new Date(T0),
      limits: { maxEvidenceRecords: 2 },
    })
    await engine.open()
    for (let index = 0; index < 6; index += 1) {
      engine.admit({
        request: { kind: 'entity', entityType: 'person', name: `Person ${index}` },
        channel: 'owner_statement',
        actor: 'owner',
        sensitivity: 'personal',
      })
    }
    await engine.settled()
    await engine.close()

    // Two rows survive, but six ids were issued.
    expect(rowCount('world_evidence')).toBe(2)
    const mark = connection
      .prepare("SELECT value FROM world_meta WHERE key = 'evidence_sequence'")
      .get() as { value: string }
    expect(Number(mark.value)).toBe(6)

    const reopened = new WorldEngine({ persistence: new VaultWorldStore(harnessVault()), now: () => new Date(T0) })
    await reopened.open()
    const added = reopened.admit({
      request: { kind: 'entity', entityType: 'person', name: 'Later' },
      channel: 'owner_statement',
      actor: 'owner',
      sensitivity: 'personal',
    })
    expect(added.ok).toBe(true)
    if (added.ok) expect(added.evidenceId).toBe('wev-000007')
    await reopened.close()
  })
})

describe('a ledger this build will not believe is refused whole', () => {
  it('refuses a row whose confidence its channel cannot support, and then stops trusting the store', async () => {
    const port = store()
    await port.commit({ v: 1, records: [validRecord()], sequence: 1 })

    // A row that is intact inside the database and is nonetheless a claim its channel
    // cannot support. Written past the codec, because admission would never produce it.
    insertRow({
      ...validRecord(),
      evidenceId: 'wev-000002',
      sequence: 2,
      channel: 'worker_claim',
      source: 'external-untrusted',
      actor: 'agent:alpha',
      confidence: 'high',
      entity: { entityType: 'person', name: 'Forged', aliases: [], attributes: {} },
    })

    const loaded = await port.load()
    expect(loaded.ok).toBe(false)
    expect(port.faultReason).not.toBeNull()
    // Nothing is written from a store it has stopped trusting.
    await expect(port.commit({ v: 1, records: [], sequence: 0 })).rejects.toThrow(/damaged/)
    expect(rowCount('world_evidence')).toBe(2)
  })

  it('refuses a row whose nested claim is not parseable', async () => {
    const port = store()
    await port.commit({ v: 1, records: [validRecord()], sequence: 1 })
    connection
      .prepare(
        `INSERT INTO world_evidence (
           evidence_id, sequence, kind, channel, recorded_at, observed_at, source, actor,
           source_ref, sensitivity, epistemic, confidence, evidence_summary, supersedes,
           entity, relation, withdrawal
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run([
        'wev-000002',
        2,
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
      ])
    expect((await port.load()).ok).toBe(false)
    expect(port.faultReason).not.toBeNull()
  })

  it('refuses a stored relation whose endpoints its type does not accept', async () => {
    // Relationship forgery at rest. Admission refuses the pairing, so it has to be
    // written past admission to exist at all; the pairing table is then re-checked on
    // read, which is what stops a row from a tightened rule being adopted later.
    const illegal: WorldEvidenceRecord = {
      ...validRecord(),
      kind: 'relation',
      entity: null,
      relation: {
        relationType: 'works_on',
        subject: { form: 'named', entityType: 'person', name: 'Ana' },
        object: { form: 'named', entityType: 'place', name: 'Lisbon' },
        validUntil: null,
      },
    }
    // Refused on the way in...
    const port = store()
    await expect(port.commit({ v: 1, records: [illegal], sequence: 1 })).rejects.toThrow(
      /does not apply to those kinds/,
    )
    // ...and refused on the way out even when the row is already in the table.
    insertRow(illegal)
    const engine = new WorldEngine({ persistence: new VaultWorldStore(harnessVault()), now: () => new Date(T0) })
    expect((await engine.open()).ok).toBe(false)
    expect(engine.summary().counts.evidenceRecords).toBe(0)
    await engine.close()
  })

  it('refuses a row naming a principal that is not one, and refuses it on the way in too', async () => {
    const port = store()
    // Admission refuses this, and so does the write path: the codec runs in both
    // directions, so an illegal record cannot be committed in the first place.
    await expect(
      port.commit({
        v: 1,
        // Deliberately not a principal. The cast is the point: this is the shape a
        // tampered row would have, and the codec is what has to notice.
        records: [{ ...validRecord(), actor: 'superuser' as WorldEvidenceRecord['actor'] }],
        sequence: 1,
      }),
    ).rejects.toThrow(/usable actor/)
    expect(rowCount('world_evidence')).toBe(0)
  })
})

describe('deterministic replay', () => {
  it('reproduces an identical projection from the same durable rows', async () => {
    const first = await seeded(store())
    const summary = JSON.stringify(first.summary())
    const graph = JSON.stringify(first.relations({ focusEntityId: null, kinds: null, maxDepth: 1 }))
    await first.close()

    const reopened = new WorldEngine({ persistence: new VaultWorldStore(harnessVault()), now: () => new Date(T0) })
    const opened = await reopened.open()
    expect(opened.ok).toBe(true)
    expect(opened.recovered).toBe(3)
    expect(JSON.stringify(reopened.summary())).toBe(summary)
    expect(JSON.stringify(reopened.relations({ focusEntityId: null, kinds: null, maxDepth: 1 }))).toBe(graph)
    await reopened.close()
  })
})

/** A minimal legal record, for tests that are about storage rather than content. */
function validRecord(): WorldEvidenceRecord {
  return {
    evidenceId: 'wev-000001',
    sequence: 1,
    kind: 'entity',
    channel: 'owner_statement',
    recordedAt: T0.toISOString(),
    observedAt: T0.toISOString(),
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