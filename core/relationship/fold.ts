import { rebuildRelationshipEntry } from './ledger'
import type { RelationshipLedgerEntry, RelationshipState } from './types'

/**
 * THE RELATIONSHIP FOLD, and the validation that guards it.
 *
 * One deterministic function from a sequence of entries to a `RelationshipState`, used
 * by the memory store and the Vault store alike. Two implementations of "how do
 * records become state" is how a store ends up disagreeing with itself about what
 * Freya records, so there is one.
 *
 * Validation runs on **read** as well as on write: a row that parsed is only proven to
 * be the row that was written, not that it is well formed. A row that fails validation
 * is reported and the read stops — the store treats it as a broken chain — rather than
 * being silently skipped. Skipping would let a damaged record be dropped and the rest
 * believed as though nothing were wrong.
 */

export const RELATIONSHIP_RECORD_VERSION = 1

/**
 * The wrapper a store persists.
 *
 * A version and one entry, rather than a bare entry, so a future record-shape change
 * is detectable on read instead of being inferred from a field that happens to be
 * absent.
 */
export interface RelationshipRecord {
  readonly version: number
  readonly entry: RelationshipLedgerEntry
}

export function emptyRelationshipState(): RelationshipState {
  return { entries: new Map(), sequence: 0 }
}

/**
 * Apply one entry. Idempotent per `entryId`.
 *
 * A later write for the same id replaces the earlier one: a status change *is* the
 * advance of a record, and the entry carries its own lifecycle, so keeping both would
 * be a second source of truth about one record.
 */
export function applyEntry(state: RelationshipState, entry: RelationshipLedgerEntry): void {
  state.sequence += 1
  state.entries.set(entry.entryId, entry)
}

/**
 * Validate a stored value.
 *
 * Rebuilds through `rebuildRelationshipEntry`, so every construction rule — the
 * confidence ceiling, the owner-only kinds, the evidence rule, the secret-shape
 * refusal — is re-applied to a row that arrived from storage.
 */
export function validateRecord(
  value: unknown,
): { ok: true; record: RelationshipRecord } | { ok: false; reason: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'a relationship record is not an object' }
  }
  const wrapper = value as Record<string, unknown>
  if (wrapper.version !== RELATIONSHIP_RECORD_VERSION) {
    return { ok: false, reason: 'a relationship record carried an unknown wrapper version' }
  }
  const rebuilt = rebuildRelationshipEntry(wrapper.entry)
  if (!rebuilt.ok) return { ok: false, reason: rebuilt.reason }
  return { ok: true, record: { version: RELATIONSHIP_RECORD_VERSION, entry: rebuilt.entry } }
}
