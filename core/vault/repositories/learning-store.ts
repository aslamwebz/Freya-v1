import { applyRecord, emptyLearningState, recordKey, validateRecord } from '../../learning/fold'
import {
  LearningStoreError,
  type LearningHealth,
  type LearningPersistenceMode,
  type LearningStore,
  type LearningWrite,
} from '../../learning/store'
import {
  LEARNING_LIMITS,
  type KnowledgeRecord,
  type LearningExperience,
  type LearningState,
  type VerifiedOutcome,
} from '../../learning/types'
import type { Vault } from '../vault'

/**
 * THE LEARNING PIPELINE ON THE CANONICAL VAULT.
 *
 * Phase 28's outcomes, lessons and claims move onto the one encrypted SQLCipher database,
 * under the generic `vault_kv` table tagged `domain = 'learning'`.
 *
 * ## What this store will not do
 *
 * - **No plaintext fallback.** A key that cannot be produced, or a Vault that cannot be
 *   opened, means the caller gets `mode: 'ephemeral'` with a `faultReason` — and the host
 *   is expected to *say so*. There is no second store quietly standing in with a better
 *   availability story.
 * - **No degraded writes.** A store that could not fully believe what it read becomes
 *   read-only rather than accepting new records on top of a chain it does not trust. A
 *   learned claim is the one thing in this system a later phase might act on, so a claim
 *   written onto an unreadable chain is worse than no claim.
 * - **No dual write.** A Core that opens this store writes learning records only here.
 *
 * ## Storage shape
 *
 * One row per record, keyed `outcome:<id>` / `experience:<id>` / `knowledge:<id>` — one
 * keyspace for the whole pipeline, so a cross-kind id collision cannot be mistaken for a
 * conflict. A status change upserts the same key, because a status change *is* the advance
 * of a record. On open every row is read, validated and folded by the *same*
 * `validateRecord`/`applyRecord` the memory store uses, so a state built here is
 * indistinguishable from one built there. A row that fails validation **degrades** the
 * store rather than being skipped.
 */

const DOMAIN = 'learning'

/** A second, independent ceiling, matching the retired bespoke store's bound. */
export const MAX_VAULT_LEARNING_RECORD_BYTES = 32 * 1024

interface LearningRow {
  readonly body: string
}

/**
 * Which pipeline stage a bare record belongs to.
 *
 * Discriminated on the **id field each shape owns**, in a fixed order, rather than by
 * probing for the presence of an optional field. The first version of this probed
 * `outcomeId`, which a distilled experience also carries — so every lesson was filed as a
 * check, and a claim citing it found no verification behind it. A discriminator that can
 * match two shapes is not a discriminator.
 */
function wrap(record: LearningWrite): LearningRecordOf {
  if (isExperience(record)) return { version: 1, kind: 'experience', experience: record }
  if (isKnowledge(record)) return { version: 1, kind: 'knowledge', knowledge: record }
  return { version: 1, kind: 'outcome', outcome: record }
}

type LearningRecordOf =
  | { readonly version: 1; readonly kind: 'outcome'; readonly outcome: VerifiedOutcome }
  | { readonly version: 1; readonly kind: 'experience'; readonly experience: LearningExperience }
  | { readonly version: 1; readonly kind: 'knowledge'; readonly knowledge: KnowledgeRecord }

function isExperience(value: LearningWrite): value is LearningExperience {
  return typeof (value as LearningExperience).experienceId === 'string'
}

function isKnowledge(value: LearningWrite): value is KnowledgeRecord {
  return typeof (value as KnowledgeRecord).knowledgeId === 'string'
}

export class VaultLearningStore implements LearningStore {
  readonly mode: LearningPersistenceMode = 'encrypted'
  readonly faultReason: string | null = null

  private readonly learning: LearningState = emptyLearningState()
  private closed = false
  private degraded: string | null = null

  constructor(private readonly vault: Vault) {}

  get degradedReason(): string | null {
    return this.degraded
  }

  /**
   * Open: read every `learning` row, validate and fold.
   *
   * A row that fails validation degrades the store rather than being silently skipped —
   * the same rule the Life and Relationship stores follow, so a damaged claim cannot be
   * quietly dropped and the rest believed as though nothing were wrong.
   */
  async open(): Promise<VaultLearningStore> {
    let rows: LearningRow[]
    try {
      rows = this.vault.all<LearningRow>(
        'SELECT body FROM vault_kv WHERE domain = ? ORDER BY rowid',
        [DOMAIN],
      )
    } catch (error) {
      throw new LearningStoreError('store-unavailable', `the Vault could not be read: ${describe(error)}`)
    }
    for (const row of rows) {
      let parsed: unknown
      try {
        parsed = JSON.parse(row.body)
      } catch {
        this.degrade('a learning record is not valid JSON')
        break
      }
      const checked = validateRecord(parsed)
      if (!checked.ok) {
        this.degrade(checked.reason)
        break
      }
      applyRecord(this.learning, checked.record)
    }
    return this
  }

  async write(record: LearningWrite): Promise<void> {
    if (this.closed) {
      throw new LearningStoreError('store-unavailable', 'the learning store is closed')
    }
    if (this.degraded !== null) {
      throw new LearningStoreError('read-only', 'the learning store is degraded and cannot safely accept writes')
    }
    const wrapped = wrap(record)
    const body = JSON.stringify(wrapped)
    if (Buffer.byteLength(body, 'utf8') > MAX_VAULT_LEARNING_RECORD_BYTES) {
      throw new LearningStoreError('too-large', 'a learning record exceeds the per-record limit')
    }
    try {
      this.vault.transaction((tx) => {
        tx.run(
          `INSERT INTO vault_kv (domain, key, body, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(domain, key) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
          [DOMAIN, recordKey(wrapped), body, new Date().toISOString()],
        )
      })
    } catch (error) {
      throw new LearningStoreError('write-failed', `a learning record could not be written: ${describe(error)}`)
    }
    applyRecord(this.learning, wrapped)
  }

  async forget(key: string): Promise<void> {
    if (this.closed) {
      throw new LearningStoreError('store-unavailable', 'the learning store is closed')
    }
    if (this.degraded !== null) {
      throw new LearningStoreError('read-only', 'the learning store is degraded and cannot safely remove records')
    }
    if (!this.hasKey(key)) {
      throw new LearningStoreError('not-found', 'no such learning record')
    }
    try {
      this.vault.transaction((tx) => {
        tx.run(`DELETE FROM vault_kv WHERE domain = ? AND key = ?`, [DOMAIN, key])
      })
    } catch (error) {
      throw new LearningStoreError('write-failed', `the learning record could not be removed: ${describe(error)}`)
    }
    // Only removed from the folded state once the row is actually gone. A forget that
    // failed on disk but succeeded in memory would be a claim Freya has lost without the
    // owner having lost it.
    this.removeByKey(key)
  }

  state(): LearningState {
    return this.learning
  }

  health(): { health: LearningHealth; reason: string | null } {
    if (this.degraded !== null) return { health: 'degraded', reason: this.degraded }
    return { health: 'healthy', reason: null }
  }

  async close(): Promise<void> {
    this.closed = true
  }

  private degrade(reason: string): void {
    this.degraded ??= reason
  }

  private removeByKey(key: string): void {
    if (key.startsWith('outcome:')) this.learning.outcomes.delete(key.slice('outcome:'.length))
    else if (key.startsWith('experience:')) this.learning.experiences.delete(key.slice('experience:'.length))
    else if (key.startsWith('knowledge:')) this.learning.knowledge.delete(key.slice('knowledge:'.length))
  }

  private hasKey(key: string): boolean {
    if (key.startsWith('outcome:')) return this.learning.outcomes.has(key.slice('outcome:'.length))
    if (key.startsWith('experience:')) return this.learning.experiences.has(key.slice('experience:'.length))
    if (key.startsWith('knowledge:')) return this.learning.knowledge.has(key.slice('knowledge:'.length))
    return false
  }
}

/**
 * The in-memory learning store.
 *
 * Two jobs, both honest. Tests use it so a learning test does not need an encryption round
 * trip in the way. And it is the **ephemeral production mode**: when the host has no
 * secure key, Freya still has a working learning layer for the session and says plainly
 * that nothing will be remembered across a restart.
 *
 * It is never a silent substitute for the encrypted store. The mode is reported, the reason
 * is reported, and the surface shows it.
 */
export class MemoryLearningStore implements LearningStore {
  readonly mode: LearningPersistenceMode
  readonly faultReason: string | null
  readonly degradedReason: string | null = null

  private readonly learning: LearningState
  private closed = false

  constructor(options: { mode?: 'ephemeral' | 'memory'; faultReason?: string | null } = {}) {
    this.mode = options.mode ?? 'memory'
    this.faultReason = options.faultReason ?? null
    this.learning = emptyLearningState()
  }

  async write(record: LearningWrite): Promise<void> {
    if (this.closed) {
      throw new LearningStoreError('store-unavailable', 'the learning store is closed')
    }
    const wrapped = wrap(record)
    const body = JSON.stringify(wrapped)
    if (Buffer.byteLength(body, 'utf8') > Math.min(LEARNING_LIMITS.maxRecordBodyBytes, MAX_VAULT_LEARNING_RECORD_BYTES)) {
      throw new LearningStoreError('too-large', 'a learning record exceeds the per-record limit')
    }
    applyRecord(this.learning, wrapped)
  }

  async forget(key: string): Promise<void> {
    if (this.closed) {
      throw new LearningStoreError('store-unavailable', 'the learning store is closed')
    }
    const present =
      key.startsWith('outcome:') && this.learning.outcomes.has(key.slice(8)) ||
      key.startsWith('experience:') && this.learning.experiences.has(key.slice(11)) ||
      key.startsWith('knowledge:') && this.learning.knowledge.has(key.slice(10))
    if (!present) throw new LearningStoreError('not-found', 'no such learning record')
    if (key.startsWith('outcome:')) this.learning.outcomes.delete(key.slice(8))
    else if (key.startsWith('experience:')) this.learning.experiences.delete(key.slice(11))
    else if (key.startsWith('knowledge:')) this.learning.knowledge.delete(key.slice(10))
  }

  state(): LearningState {
    return this.learning
  }

  health(): { health: LearningHealth; reason: string | null } {
    return { health: 'healthy', reason: this.faultReason }
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}