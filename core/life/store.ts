import type { LifeConflict, LifeEntry } from './types'

/**
 * The Life History Store.
 *
 * The counterpart to the Brain Store, and deliberately a separate one. Where the
 * Brain is the raw-memory authority, Life is the derived autobiographical layer:
 * an append-only log of entries and conflict edges, folded deterministically on
 * open. It holds no memory content, and it has no query language — a generic
 * query surface reachable from a window would make "read the store" and "read
 * anything" the same capability.
 */

export type LifePersistenceMode = 'encrypted' | 'ephemeral' | 'memory' | 'unavailable'

export type LifeFaultCode =
  | 'store-unavailable'
  | 'unauthenticated'
  | 'integrity-broken'
  | 'invalid-record'
  | 'write-failed'
  | 'too-large'
  | 'not-found'
  | 'read-only'

/**
 * A Life-store failure.
 *
 * **A Life fault is never a security event.** A corrupt Life store can neither
 * grant cognition nor clear a stop, and it does not lose authority either. It is
 * a statement about a derived layer, so Core keeps running and the surface says
 * Life is degraded with a reason.
 */
export class LifeStoreError extends Error {
  constructor(
    readonly code: LifeFaultCode,
    message: string,
  ) {
    super(message)
    this.name = 'LifeStoreError'
  }
}

export type LifeHealth = 'healthy' | 'degraded' | 'unavailable'

/** One durable Life record. The union the log stores and the fold replays. */
export type LifeRecord =
  | { kind: 'life-entry'; entry: LifeEntry }
  | { kind: 'life-conflict'; conflict: LifeConflict }

export type LifeRecordKind = LifeRecord['kind']

/** The folded state a store keeps in memory, rebuilt deterministically on open. */
export interface LifeState {
  entries: Map<string, LifeEntry>
  conflicts: Map<string, LifeConflict>
  /** Count of records read and believed. Part of the state, not bookkeeping. */
  sequence: number
}

export function emptyLifeState(): LifeState {
  return { entries: new Map(), conflicts: new Map(), sequence: 0 }
}

export interface LifeStore {
  /** What durability this store actually provides. Never a guess. */
  readonly mode: LifePersistenceMode
  /** Why, when it is not `encrypted`. Null when it is. */
  readonly faultReason: string | null
  /** True when something on disk could not be believed. Never a security fact. */
  readonly degradedReason: string | null

  /** Append one record, apply it, and return the stored form. */
  write(record: LifeRecord): Promise<LifeRecord>

  /** The folded state. A live view for the owning process, not a copy to hand out. */
  state(): LifeState

  health(): { health: LifeHealth; reason: string | null }

  close(): Promise<void>
}
