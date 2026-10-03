import { applyRecord, emptyAcquisitionState, recordKey, validateRecord, type AcquisitionRecord } from '../../acquisition/fold'
import {
  AcquisitionStoreError,
  type AcquisitionHealth,
  type AcquisitionPersistenceMode,
  type AcquisitionStore,
  type AcquisitionWrite,
  type GateLedgerWrite,
} from '../../acquisition/store'
import {
  ACQUISITION_LIMITS,
  type AcquisitionRequest,
  type AcquisitionState,
  type ActivationDecision,
  type CapabilityGap,
} from '../../acquisition/types'
import type { Vault } from '../vault'

/**
 * THE ACQUISITION LEDGER ON THE CANONICAL VAULT.
 *
 * Phase 29's gaps, requests, gate ledgers and activation decisions move onto the one encrypted
 * SQLCipher database, under the generic `vault_kv` table tagged `domain = 'acquisition'`.
 *
 * ## What this store will not do
 *
 * - **No plaintext fallback.** A key that cannot be produced, or a Vault that cannot be opened,
 *   means the caller gets `mode: 'ephemeral'` with a `faultReason` — and the host is expected to
 *   *say so*. There is no second store quietly standing in with a better availability story.
 * - **No degraded writes.** A store that could not fully believe what it read becomes read-only
 *   rather than accepting new records on top of a chain it does not trust. A gate ledger written
 *   onto an unreadable chain is a chain that says a capability was verified by somebody.
 * - **No dual write.** A Core that opens this store writes acquisition records only here.
 *
 * ## Storage shape
 *
 * One row per record, keyed `gap:<id>` / `request:<id>` / `ledger:<id>` / `decision:<id>`. A
 * status change upserts the same key, because a status change *is* the advance of a request.
 *
 * On open every row is read, validated and folded by the *same* `validateRecord`/`applyRecord` the
 * memory store uses, so a state built here is indistinguishable from one built there. Two details
 * matter and both are in the code below:
 *
 * - **Rows are folded in two passes.** A decision is validated *against its own request*, so gaps
 *   and requests are folded before ledgers and decisions. A single `ORDER BY rowid` pass would
 *   validate a decision before the request it talks about existed.
 * - **A row that fails validation degrades the store** rather than being skipped — the same rule
 *   the Life, Relationship and Learning stores follow. Skipping would let a damaged request be
 *   dropped and the rest believed as though nothing were wrong.
 */

const DOMAIN = 'acquisition'

/** A second, independent ceiling, matching the retired bespoke store's bound. */
export const MAX_VAULT_ACQUISITION_RECORD_BYTES = 32 * 1024

interface AcquisitionRow {
  readonly body: string
}

/**
 * Which kind a bare payload belongs to.
 *
 * Discriminated on the **field each shape owns**, in a fixed order: `verdicts` is a ledger and
 * nothing else has it, `approved` belongs only to a decision, `wanted` only to a gap, and
 * `steps` only to a request. The order is fixed rather than probed for optional fields for the
 * reason the Learning store documents: a discriminator that can match two shapes is not a
 * discriminator.
 */
export function wrapAcquisitionWrite(write: AcquisitionWrite): AcquisitionRecord {
  if (isLedgerWrite(write)) {
    return { version: 1, kind: 'ledger', requestId: write.requestId, verdicts: write.verdicts }
  }
  if (isActivationDecision(write)) return { version: 1, kind: 'decision', decision: write }
  if (isCapabilityGap(write)) return { version: 1, kind: 'gap', gap: write }
  return { version: 1, kind: 'request', request: write as AcquisitionRequest }
}

function isLedgerWrite(value: AcquisitionWrite): value is GateLedgerWrite {
  return Array.isArray((value as GateLedgerWrite).verdicts)
}

function isActivationDecision(value: AcquisitionWrite): value is ActivationDecision {
  return 'approved' in (value as unknown as Record<string, unknown>)
}

function isCapabilityGap(value: AcquisitionWrite): value is CapabilityGap {
  return typeof (value as CapabilityGap).wanted === 'string'
}

export class VaultAcquisitionStore implements AcquisitionStore {
  readonly mode: AcquisitionPersistenceMode = 'encrypted'
  readonly faultReason: string | null = null

  private readonly acquisition: AcquisitionState = emptyAcquisitionState()
  private closed = false
  private degraded: string | null = null

  constructor(private readonly vault: Vault) {}

  get degradedReason(): string | null {
    return this.degraded
  }

  /**
   * Open: read every `acquisition` row, validate and fold, in two passes.
   *
   * Gaps and requests first, because a decision is a claim about one request's gates and cannot
   * be checked without that request. Then ledgers and decisions, each validated against the
   * folded state.
   */
  async open(): Promise<VaultAcquisitionStore> {
    let rows: AcquisitionRow[]
    try {
      rows = this.vault.all<AcquisitionRow>(
        'SELECT body FROM vault_kv WHERE domain = ? ORDER BY rowid',
        [DOMAIN],
      )
    } catch (error) {
      throw new AcquisitionStoreError('store-unavailable', `the Vault could not be read: ${describe(error)}`)
    }
    const deferred: unknown[] = []
    for (const row of rows) {
      const parsed = parseRow(row)
      if (parsed === null) {
        this.degrade('an acquisition record is not valid JSON')
        break
      }
      const wrapper = wrapperKindOf(parsed)
      if (wrapper === null) {
        this.degrade('an acquisition record names an unknown kind')
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
      applyRecord(this.acquisition, checked.record)
    }
    if (this.degraded === null) {
      for (const parsed of deferred) {
        const checked = validateRecord(parsed, (requestId) => this.acquisition.requests.get(requestId))
        if (!checked.ok) {
          this.degrade(checked.reason)
          break
        }
        applyRecord(this.acquisition, checked.record)
      }
    }
    return this
  }

  async write(write: AcquisitionWrite): Promise<void> {
    if (this.closed) {
      throw new AcquisitionStoreError('store-unavailable', 'the acquisition store is closed')
    }
    if (this.degraded !== null) {
      throw new AcquisitionStoreError(
        'read-only',
        'the acquisition store is degraded and cannot safely accept writes',
      )
    }
    const wrapped = wrapAcquisitionWrite(write)
    const body = JSON.stringify(wrapped)
    if (Buffer.byteLength(body, 'utf8') > MAX_VAULT_ACQUISITION_RECORD_BYTES) {
      throw new AcquisitionStoreError('too-large', 'an acquisition record exceeds the per-record limit')
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
      throw new AcquisitionStoreError(
        'write-failed',
        `an acquisition record could not be written: ${describe(error)}`,
      )
    }
    applyRecord(this.acquisition, wrapped)
  }

  state(): AcquisitionState {
    return this.acquisition
  }

  health(): { health: AcquisitionHealth; reason: string | null } {
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
 * The in-memory acquisition store.
 *
 * Two jobs, both honest. Tests use it so an acquisition test does not need an encryption round
 * trip in the way. And it is the **ephemeral production mode**: when the host has no secure key,
 * Freya still has a working ledger for the session and says plainly that nothing will be
 * remembered across a restart — including that an activation approved in that session will not
 * survive it, which for this domain is the most important sentence a surface can show.
 *
 * It is never a silent substitute for the encrypted store. The mode is reported, the reason is
 * reported, and the surface shows it.
 */
export class MemoryAcquisitionStore implements AcquisitionStore {
  readonly mode: AcquisitionPersistenceMode
  readonly faultReason: string | null
  readonly degradedReason: string | null = null

  private readonly acquisition: AcquisitionState
  private closed = false

  constructor(options: { mode?: 'ephemeral' | 'memory'; faultReason?: string | null } = {}) {
    this.mode = options.mode ?? 'memory'
    this.faultReason = options.faultReason ?? null
    this.acquisition = emptyAcquisitionState()
  }

  async write(write: AcquisitionWrite): Promise<void> {
    if (this.closed) {
      throw new AcquisitionStoreError('store-unavailable', 'the acquisition store is closed')
    }
    const wrapped = wrapAcquisitionWrite(write)
    const body = JSON.stringify(wrapped)
    if (
      Buffer.byteLength(body, 'utf8') > Math.min(ACQUISITION_LIMITS.maxRecordBodyBytes, MAX_VAULT_ACQUISITION_RECORD_BYTES)
    ) {
      throw new AcquisitionStoreError('too-large', 'an acquisition record exceeds the per-record limit')
    }
    applyRecord(this.acquisition, wrapped)
  }

  state(): AcquisitionState {
    return this.acquisition
  }

  health(): { health: AcquisitionHealth; reason: string | null } {
    return { health: 'healthy', reason: this.faultReason }
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

function parseRow(row: AcquisitionRow): unknown {
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
 * about a request, and the request it names may not have been folded yet.
 */
function wrapperKindOf(value: unknown): 'entity' | 'deferred' | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const wrapper = value as Record<string, unknown>
  if (wrapper.kind === 'gap' || wrapper.kind === 'request') return 'entity'
  if (wrapper.kind === 'ledger') return 'deferred'
  if (wrapper.kind === 'decision') return 'deferred'
  return null
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}