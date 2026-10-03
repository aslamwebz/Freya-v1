import { WorldPersistenceError } from '../../world/persistence/errors'
import {
  WORLD_SNAPSHOT_VERSION,
  type WorldPersistencePort,
  type WorldSnapshot,
  type WorldSnapshotLoad,
} from '../../world/persistence/port'
import {
  decodeWorldSnapshot,
  encodeWorldSnapshot,
  MAX_WORLD_RECORD_BYTES,
} from '../../world/persistence/snapshot'
import { WORLD_LIMITS, type WorldEvidenceRecord } from '../../world/types'
import type { Vault } from '../vault'

/**
 * THE WORLD MODEL'S EVIDENCE LEDGER, ON THE CANONICAL VAULT.
 *
 * Phase 22's durable state is one append-and-replace ledger of admitted evidence.
 * Before this repository it was a bespoke AES-256-GCM file per domain, which
 * `PLAN.md` §4.3 retires: there is now one per-user SQLCipher `freya.db` and every
 * structured durable record lives in it. This class is the whole of that change, and
 * the change is deliberately small because **this repository is the only thing in
 * Phase 22 that knows how bytes are stored**. The ontology, the identity rules, the
 * admission rules, the fold, the self model and the projection contract are written
 * against the five-member `WorldPersistencePort`, so they are untouched.
 *
 * ## What did not change
 *
 * The port. A snapshot of evidence records goes in, a snapshot comes out, and the
 * port states in words whether that snapshot will still be there tomorrow. The engine
 * still folds in memory, still recomputes freshness against a supplied instant, and
 * still holds no authority object. Nothing about what the world model *believes*
 * moved into storage, which is the only way to be sure the storage change did not
 * quietly become a semantics change.
 *
 * ## What did
 *
 * The protection moved from a per-record AEAD line to the database's own page
 * encryption. That is strictly better for this domain: the entire ledger is covered
 * by one key, so there is no per-record authentication tag to strip, forge or swap,
 * and a record cannot be re-labelled by editing anything outside the encrypted page.
 * There is deliberately **no dual write** — a Core with a Vault open writes world
 * evidence only here, and the bespoke file is not opened at all.
 *
 * ## The port's contract, kept literally
 *
 * The retained set is small, bounded (at most `WORLD_LIMITS.maxEvidenceRecords`, 1024
 * records by default) and *replaced* on every commit, so a commit rewrites the ledger
 * inside one transaction. Full replacement is not an optimisation mistake: it is what
 * makes eviction, withdrawal and revision leave no orphan row behind, and the bound is
 * small enough that the rewrite is invisible. A crash mid-commit leaves the previous
 * ledger exactly as it was, because SQLite makes the whole transaction atomic.
 *
 * ## What this repository cannot express
 *
 * - **No authority.** There is no column here a caller could read as a capability. The
 *   `source` column records *evidential* provenance — who asserted a claim and how
 *   they can be believed — and is assigned by Core from the admission channel, never
 *   read from the content. A claim that survived a restart is still a claim.
 * - **No query language.** A snapshot in, a snapshot out: no `getByEntity`, no
 *   `findConflicts`, no `query(sql)`. A caller cannot reach a record except by asking
 *   the engine, which is the only component that knows the folding rules.
 * - **No append and no delete of history.** A withdrawal is a *new row naming an older
 *   row*, so "the evidence was taken back" is still in the durable history after a
 *   restart. A store that deleted the target would turn a withdrawal into "there is
 *   nothing here", which is exactly the silent resurrection this lane exists to prevent.
 * - **No clock.** Every instant is a field of a record the domain already stamped.
 */

const TABLE = 'world_evidence'

/**
 * One row, as the table holds it.
 *
 * The three nested claims arrive as canonical JSON because they are optional
 * sub-documents of a record rather than fields of a row. They are re-validated on
 * read by the same codec that validates every scalar, so a stored sub-document is
 * never trusted merely because it parsed.
 */
interface WorldEvidenceRow {
  readonly evidence_id: string
  readonly sequence: number
  readonly kind: string
  readonly channel: string
  readonly recorded_at: string
  readonly observed_at: string
  readonly source: string
  readonly actor: string
  readonly source_ref: string | null
  readonly sensitivity: string
  readonly epistemic: string
  readonly confidence: string
  readonly evidence_summary: string | null
  readonly supersedes: string | null
  readonly entity: string | null
  readonly relation: string | null
  readonly withdrawal: string | null
}

const SELECT_COLUMNS =
  'evidence_id, sequence, kind, channel, recorded_at, observed_at, source, actor, source_ref, ' +
  'sensitivity, epistemic, confidence, evidence_summary, supersedes, entity, relation, withdrawal'

export class VaultWorldStore implements WorldPersistencePort {
  readonly mode = 'encrypted' as const
  readonly durable = true
  readonly durabilityReason = null as string | null

  /**
   * Latched on the first fault and never cleared.
   *
   * A fault is a *state*, not an event: once a row has failed to be believed, this
   * store is trusted with nothing until it is closed. That is what stops a partially
   * readable ledger from being rewritten as if it were the whole one.
   */
  private fault: string | null = null

  private closed = false

  constructor(private readonly vault: Vault) {}

  get faultReason(): string | null {
    return this.fault
  }

  /**
   * Read the retained evidence back, in replay order, or refuse all of it.
   *
   * There is no partial answer, and there is no answer at all that depends on which
   * rows happened to be damaged: a world rebuilt from half a history is a world whose
   * shape is a view of the damage. So one bad row refuses the whole ledger and latches
   * a fault the projection then reports, which leaves the world *empty and saying so*
   * rather than quietly rebuilt from nothing.
   */
  async load(): Promise<WorldSnapshotLoad> {
    if (this.closed) {
      return { ok: false, code: 'closed', reason: 'the world store is closed' }
    }
    if (this.fault !== null) {
      return { ok: false, code: 'degraded', reason: this.fault }
    }

    let rows: WorldEvidenceRow[]
    try {
      rows = this.vault.all<WorldEvidenceRow>(
        `SELECT ${SELECT_COLUMNS} FROM ${TABLE} ORDER BY sequence ASC, evidence_id ASC`,
      )
    } catch {
      this.fault ??= 'the encrypted Vault could not be read'
      return { ok: false, code: 'degraded', reason: this.fault }
    }

    // The highest counter Core had issued. Read separately from the rows so a ledger
    // whose oldest records were evicted by the retention bound still re-seeds exactly,
    // instead of from whatever the surviving rows happen to imply.
    let sequence = 0
    try {
      const meta = this.vault.get<{ value: string }>(
        "SELECT value FROM world_meta WHERE key = 'evidence_sequence'",
      )
      const parsed = meta === undefined ? 0 : Number(meta.value)
      if (Number.isSafeInteger(parsed) && parsed >= 0) sequence = parsed
    } catch {
      this.fault ??= 'the encrypted Vault could not be read'
      return { ok: false, code: 'degraded', reason: this.fault }
    }

    const records: unknown[] = []
    for (const row of rows) {
      const assembled = assemble(row)
      if (assembled === null) {
        this.fault ??= 'a world evidence record in the Vault could not be read'
        return { ok: false, code: 'degraded', reason: this.fault }
      }
      records.push(assembled)
    }

    try {
      return {
        ok: true,
        snapshot: decodeWorldSnapshot(
          { v: WORLD_SNAPSHOT_VERSION, records, sequence },
          WORLD_LIMITS,
        ),
      }
    } catch (error) {
      // The codec re-checks the channel's ceilings, the closed vocabularies, replay
      // order and the retention bound. A row that authenticates inside SQLCipher's
      // pages but is not a record this build is willing to believe is refused here, so
      // a rule tightened after the row was written cannot be bypassed by that row.
      this.fault ??=
        error instanceof WorldPersistenceError
          ? error.message
          : 'the world evidence in the Vault could not be believed'
      return { ok: false, code: 'degraded', reason: this.fault }
    }
  }

  /**
   * Replace the retained ledger, atomically.
   *
   * Validation runs *before* the transaction, so an illegal snapshot cannot open one.
   * Then the whole set is written or none of it is: a reader either sees the previous
   * ledger or the new one, never a half-applied withdrawal.
   */
  async commit(snapshot: WorldSnapshot): Promise<void> {
    if (this.closed) {
      throw new WorldPersistenceError('unavailable', 'the world store is closed')
    }
    if (this.fault !== null) {
      throw new WorldPersistenceError(
        'degraded',
        `the world ledger is not written because this store is damaged: ${this.fault}`,
      )
    }

    const validated = encodeWorldSnapshot(snapshot, WORLD_LIMITS)
    for (const record of validated.records) {
      if (Buffer.byteLength(JSON.stringify(record), 'utf8') > MAX_WORLD_RECORD_BYTES) {
        throw new WorldPersistenceError(
          'too_large',
          'a world evidence record is longer than this store will hold',
        )
      }
    }

    try {
      this.vault.transaction((tx) => {
        // Full replacement, so eviction and withdrawal cannot leave an orphan row that
        // a later fold would still see.
        tx.run(`DELETE FROM ${TABLE}`)
        for (const record of validated.records) insert(tx, record)
        tx.run(
          "INSERT INTO world_meta (key, value) VALUES ('evidence_sequence', ?) " +
            'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          [String(validated.sequence)],
        )
      })
    } catch (error) {
      if (error instanceof WorldPersistenceError) throw error
      throw new WorldPersistenceError('write_failed', 'the world evidence could not be written')
    }
  }

  /**
   * Close this repository, not the Vault.
   *
   * The connection belongs to Core, which opened it and may still be holding the
   * Mission store on it. Closing the database from here would take that away.
   */
  async close(): Promise<void> {
    this.closed = true
  }
}

const INSERT_SQL =
  `INSERT INTO ${TABLE} (
     evidence_id, sequence, kind, channel, recorded_at, observed_at, source, actor,
     source_ref, sensitivity, epistemic, confidence, evidence_summary, supersedes,
     entity, relation, withdrawal
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

function insert(tx: { run(sql: string, params?: readonly unknown[]): unknown }, record: WorldEvidenceRecord): void {
  tx.run(INSERT_SQL, [
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

/**
 * Rebuild one record's shape from its row, or return null when it cannot be.
 *
 * The row's own scalars are copied across untouched and the nested claims are parsed;
 * whether the result is a *legal* record is the codec's decision, not this function's.
 * Splitting it that way keeps "this row is unreadable" (a storage fault) distinct from
 * "this row is a record I will not believe" (a domain refusal), which are different
 * things for a person to be told.
 */
function assemble(row: WorldEvidenceRow): unknown {
  const entity = parse(row.entity)
  const relation = parse(row.relation)
  const withdrawal = parse(row.withdrawal)
  if (entity === FAILED || relation === FAILED || withdrawal === FAILED) return null
  return {
    evidenceId: row.evidence_id,
    sequence: row.sequence,
    kind: row.kind,
    channel: row.channel,
    recordedAt: row.recorded_at,
    observedAt: row.observed_at,
    source: row.source,
    actor: row.actor,
    sourceRef: row.source_ref,
    sensitivity: row.sensitivity,
    epistemic: row.epistemic,
    confidence: row.confidence,
    evidenceSummary: row.evidence_summary,
    supersedes: row.supersedes,
    entity,
    relation,
    withdrawal,
  }
}

const FAILED = Symbol('world-row-unreadable')

function parse(value: string | null): unknown | typeof FAILED | null {
  if (value === null) return null
  try {
    return JSON.parse(value) as unknown
  } catch {
    return FAILED
  }
}