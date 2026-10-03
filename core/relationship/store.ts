import type { RelationshipLedgerEntry, RelationshipState } from './types'

/**
 * THE RELATIONSHIP STORE.
 *
 * The counterpart to the Life Store, and deliberately separate. Relationship data is
 * the only durable record of a person over time, so the store's contract is narrow:
 * write one entry, report the folded state, report health, close. There is no query
 * language — a generic query surface reachable from a window would make "read the
 * relationship" and "read anything about this person" the same capability.
 */

export type RelationshipPersistenceMode = 'encrypted' | 'ephemeral' | 'memory' | 'unavailable'

export type RelationshipFaultCode =
  | 'store-unavailable'
  | 'unauthenticated'
  | 'integrity-broken'
  | 'invalid-record'
  | 'write-failed'
  | 'too-large'
  | 'not-found'
  | 'read-only'

/**
 * A relationship-store failure.
 *
 * **A relationship fault is never a security event.** A damaged ledger can neither
 * grant cognition nor clear a stop. It is a statement about a derived layer, so Core
 * keeps running and the surface says Relationship is degraded with a reason.
 *
 * It is also, deliberately, not silently repaired. The safest thing Core can do with a
 * record set it cannot fully trust about a person is say so.
 */
export class RelationshipStoreError extends Error {
  constructor(
    readonly code: RelationshipFaultCode,
    message: string,
  ) {
    super(message)
    this.name = 'RelationshipStoreError'
  }
}

export type RelationshipHealth = 'healthy' | 'degraded' | 'unavailable'

export interface RelationshipStore {
  /** What durability this store actually provides. Never a guess. */
  readonly mode: RelationshipPersistenceMode
  /** Why, when it is not `encrypted`. Null when it is. */
  readonly faultReason: string | null
  /** True when something on disk could not be believed. Never a security fact. */
  readonly degradedReason: string | null

  /** Write one entry, apply it, and return the stored form. */
  write(entry: RelationshipLedgerEntry): Promise<RelationshipLedgerEntry>

  /**
   * Remove one entry entirely — text, metadata, lifecycle, all of it.
   *
   * Distinct from `write`, because `write` only ever *advances* a record and this one
   * erases it. `RelationshipEngine.forget` gates it: a live record must be withdrawn
   * first, so a routine retraction can never quietly delete the record of what Freya
   * once held. Refusing `not-found` for an id that is not there keeps a forget
   * idempotent rather than turning it into a way to test what exists.
   */
  forget(entryId: string): Promise<void>

  /** The folded state. A live view for the owning process, not a copy to hand out. */
  state(): RelationshipState

  health(): { health: RelationshipHealth; reason: string | null }

  close(): Promise<void>
}
