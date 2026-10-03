import { applyEntry, emptyRelationshipState, validateRecord } from '../../relationship/fold'
import {
  RelationshipStoreError,
  type RelationshipHealth,
  type RelationshipPersistenceMode,
  type RelationshipStore,
} from '../../relationship/store'
import {
  RELATIONSHIP_LIMITS,
  type RelationshipLedgerEntry,
  type RelationshipState,
} from '../../relationship/types'
import type { Vault } from '../vault'

/**
 * THE RELATIONSHIP LEDGER ON THE CANONICAL VAULT.
 *
 * Phase 27's entries move onto the one encrypted SQLCipher database, under the generic
 * `vault_kv` table tagged `domain = 'relationship'`.
 *
 * ## What this store will not do
 *
 * - **No plaintext fallback.** A key that cannot be produced, or a Vault that cannot be
 *   opened, means the caller gets `mode: 'ephemeral'` with a `faultReason` — and the
 *   host is expected to *say so*. There is no second store quietly standing in with a
 *   better availability story.
 * - **No degraded writes.** A store that could not fully believe what it read becomes
 *   read-only rather than accepting new records on top of a chain it does not trust.
 * - **No dual write.** A Core that opens this store writes relationship entries only
 *   here.
 *
 * ## Storage shape
 *
 * One row per `entryId`. A status change upserts the same key, because a status change
 * *is* the advance of a record; on open every row is read, validated and folded by the
 * *same* `validateRecord`/`applyEntry` the memory store uses, so a state built here is
 * indistinguishable from one built there.
 */

const DOMAIN = 'relationship'

/** A second, independent ceiling, matching the retired bespoke store's bound. */
export const MAX_VAULT_RELATIONSHIP_ENTRY_BYTES = 16 * 1024

interface RelationshipRow {
  readonly body: string
}

export class VaultRelationshipStore implements RelationshipStore {
  readonly mode: RelationshipPersistenceMode = 'encrypted'
  readonly faultReason: string | null = null

  private readonly relationship: RelationshipState = emptyRelationshipState()
  private closed = false
  private degraded: string | null = null

  constructor(private readonly vault: Vault) {}

  get degradedReason(): string | null {
    return this.degraded
  }

  /**
   * Open: read every `relationship` row, validate and fold.
   *
   * A row that fails validation degrades the store rather than being silently skipped —
   * the same rule the Life store follows, so a damaged record cannot be quietly
   * dropped and the rest believed as though nothing were wrong.
   */
  async open(): Promise<VaultRelationshipStore> {
    let rows: RelationshipRow[]
    try {
      rows = this.vault.all<RelationshipRow>(
        'SELECT body FROM vault_kv WHERE domain = ? ORDER BY rowid',
        [DOMAIN],
      )
    } catch (error) {
      throw new RelationshipStoreError(
        'store-unavailable',
        `the Vault could not be read: ${describe(error)}`,
      )
    }
    for (const row of rows) {
      let parsed: unknown
      try {
        parsed = JSON.parse(row.body)
      } catch {
        this.degrade('a relationship ledger record is not valid JSON')
        break
      }
      const checked = validateRecord(parsed)
      if (!checked.ok) {
        this.degrade(checked.reason)
        break
      }
      applyEntry(this.relationship, checked.record.entry)
    }
    return this
  }

  async write(entry: RelationshipLedgerEntry): Promise<RelationshipLedgerEntry> {
    if (this.closed) {
      throw new RelationshipStoreError('store-unavailable', 'the relationship store is closed')
    }
    if (this.degraded !== null) {
      throw new RelationshipStoreError(
        'read-only',
        'the relationship store is degraded and cannot safely accept writes',
      )
    }
    const body = JSON.stringify({ version: 1, entry })
    if (Buffer.byteLength(body, 'utf8') > MAX_VAULT_RELATIONSHIP_ENTRY_BYTES) {
      throw new RelationshipStoreError('too-large', 'a relationship ledger entry exceeds the per-entry limit')
    }
    try {
      this.vault.transaction((tx) => {
        tx.run(
          `INSERT INTO vault_kv (domain, key, body, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(domain, key) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
          [DOMAIN, entry.entryId, body, new Date().toISOString()],
        )
      })
    } catch (error) {
      throw new RelationshipStoreError(
        'write-failed',
        `a relationship ledger entry could not be written: ${describe(error)}`,
      )
    }
    applyEntry(this.relationship, entry)
    return entry
  }

  async forget(entryId: string): Promise<void> {
    if (this.closed) {
      throw new RelationshipStoreError('store-unavailable', 'the relationship store is closed')
    }
    if (this.degraded !== null) {
      throw new RelationshipStoreError(
        'read-only',
        'the relationship store is degraded and cannot safely remove records',
      )
    }
    if (!this.relationship.entries.has(entryId)) {
      throw new RelationshipStoreError('not-found', 'no such relationship ledger entry')
    }
    try {
      this.vault.transaction((tx) => {
        tx.run(`DELETE FROM vault_kv WHERE domain = ? AND key = ?`, [DOMAIN, entryId])
      })
    } catch (error) {
      throw new RelationshipStoreError(
        'write-failed',
        `the relationship ledger entry could not be removed: ${describe(error)}`,
      )
    }
    // Only removed from the folded state once the row is actually gone. A forget that
    // failed on disk but succeeded in memory would be a record Freya has lost without
    // the owner having lost it.
    this.relationship.entries.delete(entryId)
  }

  state(): RelationshipState {
    return this.relationship
  }

  health(): { health: RelationshipHealth; reason: string | null } {
    if (this.degraded !== null) return { health: 'degraded', reason: this.degraded }
    return { health: 'healthy', reason: null }
  }

  async close(): Promise<void> {
    this.closed = true
  }

  private degrade(reason: string): void {
    this.degraded ??= reason
  }
}

/**
 * The in-memory relationship store.
 *
 * Two jobs, both honest. Tests use it so a relationship test does not need an
 * encryption round trip in the way. And it is the **ephemeral production mode**: when
 * the host has no secure key, Freya still has a working record set for the session and
 * says plainly that nothing will be remembered across a restart.
 *
 * It is never a silent substitute for the encrypted store. The mode is reported, the
 * reason is reported, and the surface shows it.
 */
export class MemoryRelationshipStore implements RelationshipStore {
  readonly mode: RelationshipPersistenceMode
  readonly faultReason: string | null
  readonly degradedReason: string | null = null

  private readonly relationship: RelationshipState
  private closed = false

  constructor(options: { mode?: 'ephemeral' | 'memory'; faultReason?: string | null } = {}) {
    this.mode = options.mode ?? 'memory'
    this.faultReason = options.faultReason ?? null
    this.relationship = emptyRelationshipState()
  }

  async write(entry: RelationshipLedgerEntry): Promise<RelationshipLedgerEntry> {
    if (this.closed) {
      throw new RelationshipStoreError('store-unavailable', 'the relationship store is closed')
    }
    const body = JSON.stringify(entry)
    if (Buffer.byteLength(body, 'utf8') > RELATIONSHIP_LIMITS.maxEntryBodyBytes) {
      throw new RelationshipStoreError('too-large', 'a relationship ledger entry exceeds the per-entry limit')
    }
    applyEntry(this.relationship, entry)
    return entry
  }

  async forget(entryId: string): Promise<void> {
    if (this.closed) {
      throw new RelationshipStoreError('store-unavailable', 'the relationship store is closed')
    }
    if (!this.relationship.entries.has(entryId)) {
      throw new RelationshipStoreError('not-found', 'no such relationship ledger entry')
    }
    this.relationship.entries.delete(entryId)
  }

  state(): RelationshipState {
    return this.relationship
  }

  health(): { health: RelationshipHealth; reason: string | null } {
    return { health: 'healthy', reason: this.faultReason }
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}
