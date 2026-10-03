import {
  LifeStoreError,
  emptyLifeState,
  type LifeHealth,
  type LifeRecord,
  type LifeState,
  type LifeStore,
} from '../../life/store'
import { applyRecord, assertRecordSize, validateRecord } from '../../life/fold'
import type { Vault } from '../vault'

/**
 * A LIFE HISTORY STORE ON THE CANONICAL VAULT.
 *
 * Life entries and conflict edges move from the old bespoke AES-GCM hash-chain
 * file into the one encrypted SQLCipher database, under the generic `vault_kv`
 * table tagged `domain = 'life'`.
 *
 * ## What changed and what did not
 *
 * The `LifeStore` contract is unchanged, so the Life engine, the fold, the
 * projection and every privacy property are preserved. What changed is the
 * mechanism: records are now protected by the database's own page encryption
 * rather than a per-record AEAD line, and there is no second file to manage.
 * There is deliberately **no dual write**: a Core that opens this store writes
 * Life records only here.
 *
 * ## Storage shape
 *
 * Each entry is one row keyed by `entryId`; a revision upserts the same key, so
 * the latest revision is what folds. Each conflict edge is one row keyed by
 * `conflictId`; it is inserted once and never edited. On open, every `life` row
 * is read, validated and folded into the in-memory `LifeState` — the same fold
 * the old encrypted store used, so a state built here is indistinguishable from
 * one built there.
 *
 * ## No query language
 *
 * The store still exposes only `write`/`state`/`health`/`close`. The generic
 * table underneath is not reachable through this class.
 */

const DOMAIN = 'life'

/** A second, independent ceiling, matching the retired encrypted store's bound. */
export const MAX_VAULT_LIFE_RECORD_BYTES = 128 * 1024

interface LifeRow {
  readonly body: string
}

export class VaultLifeStore implements LifeStore {
  readonly mode = 'encrypted' as const
  readonly faultReason = null

  private readonly life: LifeState = emptyLifeState()
  private closed = false
  private degraded: string | null = null

  constructor(private readonly vault: Vault) {}

  get degradedReason(): string | null {
    return this.degraded
  }

  /**
   * Open the Vault-backed Life store: read every `life` row, validate and fold.
   *
   * A row that fails validation degrades the store rather than being silently
   * skipped — the same rule the old hash-chain store followed, so a damaged
   * record cannot be quietly dropped and the rest believed as though nothing
   * were wrong.
   */
  async open(): Promise<VaultLifeStore> {
    let rows: LifeRow[]
    try {
      rows = this.vault.all<LifeRow>('SELECT body FROM vault_kv WHERE domain = ? ORDER BY rowid', [DOMAIN])
    } catch (error) {
      throw new LifeStoreError('store-unavailable', `the Vault could not be read: ${describe(error)}`)
    }
    for (const row of rows) {
      let parsed: unknown
      try {
        parsed = JSON.parse(row.body)
      } catch {
        this.degrade('a Life record is not valid JSON')
        break
      }
      const checked = validateRecord(parsed)
      if (!checked.ok) {
        this.degrade(checked.reason)
        break
      }
      applyRecord(this.life, checked.record)
    }
    return this
  }

  async write(record: LifeRecord): Promise<LifeRecord> {
    if (this.closed) {
      throw new LifeStoreError('store-unavailable', 'the Life store is closed')
    }
    if (this.degraded !== null) {
      throw new LifeStoreError('read-only', 'the Life store is degraded and cannot safely accept writes')
    }
    const snapshot = JSON.parse(JSON.stringify(record)) as LifeRecord
    const checked = validateRecord(snapshot)
    if (!checked.ok) throw new LifeStoreError('invalid-record', checked.reason)
    assertRecordSize(snapshot)

    const key = recordKey(snapshot)
    const body = JSON.stringify(snapshot)
    if (Buffer.byteLength(body, 'utf8') > MAX_VAULT_LIFE_RECORD_BYTES) {
      throw new LifeStoreError('too-large', 'a Life record exceeds the per-record limit')
    }
    try {
      this.vault.transaction((tx) => {
        if (snapshot.kind === 'life-entry') {
          tx.run(
            `INSERT INTO vault_kv (domain, key, body, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(domain, key) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
            [DOMAIN, key, body, new Date().toISOString()],
          )
        } else {
          tx.run(
            `INSERT OR IGNORE INTO vault_kv (domain, key, body, updated_at)
             VALUES (?, ?, ?, ?)`,
            [DOMAIN, key, body, new Date().toISOString()],
          )
        }
      })
    } catch (error) {
      throw new LifeStoreError('write-failed', `a Life record could not be written: ${describe(error)}`)
    }
    applyRecord(this.life, snapshot)
    return snapshot
  }

  state(): LifeState {
    return this.life
  }

  health(): { health: LifeHealth; reason: string | null } {
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
 * The in-memory Life Store.
 *
 * Two jobs, both honest. Tests use it so a Life test does not need an encryption
 * round trip in the way. And it is the **ephemeral production mode**: when the
 * host has no secure key, Freya still has a working autobiographical layer for
 * the session and says plainly that nothing will be remembered across a restart.
 *
 * It is never a silent substitute for the encrypted store. The mode is reported,
 * the reason is reported, and the surface shows it.
 */
export class MemoryLifeStore implements LifeStore {
  readonly mode: 'ephemeral' | 'memory'
  readonly faultReason: string | null
  readonly degradedReason: string | null = null

  private readonly life: LifeState
  private closed = false

  constructor(options: { mode?: 'ephemeral' | 'memory'; faultReason?: string | null } = {}) {
    this.mode = options.mode ?? 'memory'
    this.faultReason = options.faultReason ?? null
    this.life = emptyLifeState()
  }

  async write(record: LifeRecord): Promise<LifeRecord> {
    if (this.closed) throw new LifeStoreError('store-unavailable', 'the Life store is closed')
    const checked = validateRecord(record)
    if (!checked.ok) throw new LifeStoreError('invalid-record', checked.reason)
    assertRecordSize(record)
    applyRecord(this.life, record)
    return record
  }

  state(): LifeState {
    return this.life
  }

  health(): { health: LifeHealth; reason: string | null } {
    return { health: 'healthy', reason: this.faultReason }
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

function recordKey(record: LifeRecord): string {
  if (record.kind === 'life-entry') return record.entry.entryId
  return record.conflict.conflictId
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}
