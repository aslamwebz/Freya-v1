import {
  applyRecord,
  emptyImprovementState,
  recordKey,
  validateRecord,
  type ImprovementRecord,
  type RequestLookup,
} from '../../improvement/fold'
import {
  ImprovementStoreError,
  type GateLedgerWrite,
  type ImprovementHealth,
  type ImprovementPersistenceMode,
  type ImprovementStore,
  type ImprovementWrite,
} from '../../improvement/store'
import {
  IMPROVEMENT_LIMITS,
  type ImprovementProposal,
  type ImprovementState,
  type MergeDecision,
} from '../../improvement/types'
import type { Vault } from '../vault'

/**
 * THE IMPROVEMENT LEDGER ON THE CANONICAL VAULT.
 *
 * Phase 30's proposals, gate ledgers and merge decisions move onto the one encrypted SQLCipher
 * database, under the generic `vault_kv` table tagged `domain = 'improvement'`.
 *
 * ## What this store will not do
 *
 * - **No plaintext fallback.** A key that cannot be produced, or a Vault that cannot be opened,
 *   means the caller gets `mode: 'ephemeral'` with a `faultReason` — and the host is expected to
 *   *say so*. There is no second store quietly standing in with a better availability story.
 * - **No degraded writes.** A store that could not fully believe what it read becomes read-only
 *   rather than accepting new records on top of a chain it does not trust. A merge decision
 *   written onto an unreadable chain is a chain that says the owner approved a change.
 * - **No dual write.** A Core that opens this store writes improvement records only here.
 *
 * ## Storage shape
 *
 * One row per record, keyed `proposal:<id>` / `ledger:<id>` / `decision:<id>`. A status change
 * upserts the same key, because a status change *is* the advance of a proposal.
 *
 * On open every row is read, validated and folded by the *same* `validateRecord`/`applyRecord` the
 * memory store uses, so a state built here is indistinguishable from one built there. Two details
 * matter and both are in the code below:
 *
 * - **Rows are folded in two passes.** A decision is validated *against its own proposal*, so
 *   proposals fold first and ledgers and decisions second. A single `ORDER BY rowid` pass would
 *   validate a decision before the proposal it talks about existed.
 * - **A row that fails validation degrades the store** rather than being skipped — the same rule
 *   the Life, Relationship, Learning and Acquisition stores follow.
 */

const DOMAIN = 'improvement'

/** A second, independent ceiling, matching the retired bespoke store's bound. */
export const MAX_VAULT_IMPROVEMENT_RECORD_BYTES = 32 * 1024

interface ImprovementRow {
  readonly body: string
}

/**
 * Which kind a bare payload belongs to.
 *
 * Discriminated on the **field each shape owns**, in a fixed order: `verdicts` is a ledger and
 * nothing else has it, `approved` belongs only to a decision, and `subject` only to a proposal.
 */
export function wrapImprovementWrite(write: ImprovementWrite): ImprovementRecord {
  if (isLedgerWrite(write)) {
    return { version: 1, kind: 'ledger', proposalId: write.proposalId, verdicts: write.verdicts }
  }
  if (isMergeDecision(write)) return { version: 1, kind: 'decision', decision: write }
  return { version: 1, kind: 'proposal', proposal: write as ImprovementProposal }
}

function isLedgerWrite(value: ImprovementWrite): value is GateLedgerWrite {
  return Array.isArray((value as GateLedgerWrite).verdicts)
}

function isMergeDecision(value: ImprovementWrite): value is MergeDecision {
  return 'approved' in (value as unknown as Record<string, unknown>)
}

export class VaultImprovementStore implements ImprovementStore {
  readonly mode: ImprovementPersistenceMode = 'encrypted'
  readonly faultReason: string | null = null

  private readonly improvement: ImprovementState = emptyImprovementState()
  private closed = false
  private degraded: string | null = null

  constructor(private readonly vault: Vault) {}

  get degradedReason(): string | null {
    return this.degraded
  }

  /**
   * Open: read every `improvement` row, validate and fold, in two passes.
   *
   * Proposals first, because a decision is a claim about one proposal's gates and cannot be checked
   * without that proposal. Then ledgers and decisions, each validated against the folded state.
   */
  async open(): Promise<VaultImprovementStore> {
    let rows: ImprovementRow[]
    try {
      rows = this.vault.all<ImprovementRow>(
        'SELECT body FROM vault_kv WHERE domain = ? ORDER BY rowid',
        [DOMAIN],
      )
    } catch (error) {
      throw new ImprovementStoreError(
        'store-unavailable',
        `the Vault could not be read: ${describe(error)}`,
      )
    }
    const deferred: unknown[] = []
    for (const row of rows) {
      const parsed = parseRow(row)
      if (parsed === null) {
        this.degrade('an improvement record is not valid JSON')
        break
      }
      const wrapper = wrapperKindOf(parsed)
      if (wrapper === null) {
        this.degrade('an improvement record names an unknown kind')
        break
      }
      if (wrapper === 'deferred') {
        deferred.push(parsed)
        continue
      }
      const checked = validateRecord(parsed)
      if (!checked.ok) {
        this.degrade(checked.reason)
        break
      }
      applyRecord(this.improvement, checked.record)
    }
    if (this.degraded === null) {
      for (const parsed of deferred) {
        const checked = validateRecord(parsed, this.lookup)
        if (!checked.ok) {
          this.degrade(checked.reason)
          break
        }
        applyRecord(this.improvement, checked.record)
      }
    }
    return this
  }

  async write(write: ImprovementWrite): Promise<void> {
    if (this.closed) {
      throw new ImprovementStoreError('store-unavailable', 'the improvement store is closed')
    }
    if (this.degraded !== null) {
      throw new ImprovementStoreError(
        'read-only',
        'the improvement store is degraded and cannot safely accept writes',
      )
    }
    const wrapped = wrapImprovementWrite(write)
    const body = JSON.stringify(wrapped)
    if (Buffer.byteLength(body, 'utf8') > MAX_VAULT_IMPROVEMENT_RECORD_BYTES) {
      throw new ImprovementStoreError('too-large', 'an improvement record exceeds the per-record limit')
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
      throw new ImprovementStoreError(
        'write-failed',
        `an improvement record could not be written: ${describe(error)}`,
      )
    }
    applyRecord(this.improvement, wrapped)
  }

  state(): ImprovementState {
    return this.improvement
  }

  health(): { health: ImprovementHealth; reason: string | null } {
    if (this.degraded !== null) return { health: 'degraded', reason: this.degraded }
    return { health: 'healthy', reason: null }
  }

  async close(): Promise<void> {
    this.closed = true
  }

  private lookup: RequestLookup = (proposalId: string) => this.improvement.proposals.get(proposalId)

  private degrade(reason: string): void {
    this.degraded ??= reason
  }
}

/**
 * The in-memory improvement store.
 *
 * Two jobs, both honest. Tests use it so an improvement test does not need an encryption round
 * trip in the way. And it is the **ephemeral production mode**: when the host has no secure key,
 * Freya still has a working ledger for the session and says plainly that nothing will be
 * remembered across a restart — including which changes are standing, which for this phase is the
 * most important sentence a surface can show.
 *
 * It is never a silent substitute for the encrypted store. The mode is reported, the reason is
 * reported, and the surface shows it.
 */
export class MemoryImprovementStore implements ImprovementStore {
  readonly mode: ImprovementPersistenceMode
  readonly faultReason: string | null
  readonly degradedReason: string | null = null

  private readonly improvement: ImprovementState
  private closed = false

  constructor(options: { mode?: 'ephemeral' | 'memory'; faultReason?: string | null } = {}) {
    this.mode = options.mode ?? 'memory'
    this.faultReason = options.faultReason ?? null
    this.improvement = emptyImprovementState()
  }

  async write(write: ImprovementWrite): Promise<void> {
    if (this.closed) {
      throw new ImprovementStoreError('store-unavailable', 'the improvement store is closed')
    }
    const wrapped = wrapImprovementWrite(write)
    const body = JSON.stringify(wrapped)
    if (
      Buffer.byteLength(body, 'utf8') >
      Math.min(IMPROVEMENT_LIMITS.maxRecordBodyBytes, MAX_VAULT_IMPROVEMENT_RECORD_BYTES)
    ) {
      throw new ImprovementStoreError('too-large', 'an improvement record exceeds the per-record limit')
    }
    applyRecord(this.improvement, wrapped)
  }

  state(): ImprovementState {
    return this.improvement
  }

  health(): { health: ImprovementHealth; reason: string | null } {
    return { health: 'healthy', reason: this.faultReason }
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

function parseRow(row: ImprovementRow): unknown {
  try {
    return JSON.parse(row.body)
  } catch {
    return null
  }
}

/**
 * Whether a row can be validated without the rest of the state.
 *
 * `deferred` covers ledgers and decisions: a ledger is valid on its own, but a decision is a claim
 * about a proposal, and the proposal it names may not have been folded yet.
 */
function wrapperKindOf(value: unknown): 'entity' | 'deferred' | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const wrapper = value as Record<string, unknown>
  if (wrapper.kind === 'proposal') return 'entity'
  if (wrapper.kind === 'ledger') return 'deferred'
  if (wrapper.kind === 'decision') return 'deferred'
  return null
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}