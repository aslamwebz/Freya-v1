import {
  PERSONALITY_LIMITS,
  type RelationshipItem,
  type RelationshipLifecycleReason,
} from '../types'
import { retireRelationshipItem } from '../relationship'
import { PERSONALITY_SNAPSHOT_VERSION, type PersonalitySnapshot } from './port'

/**
 * READING A RECOVERED SNAPSHOT.
 *
 * Three small functions for the moment a process comes back up, and one rule
 * they all exist to keep:
 *
 * > **Retired items stay retired, and their text stays destroyed.**
 *
 * A retirement is a human act — the owner took something back. A restart must
 * not undo it: a retired item's text is destroyed at retirement time, and
 * recovery must not resurrect it. The tombstone (metadata without text) is
 * what lets the domain still say "this existed and was withdrawn" after a
 * restart.
 *
 * Every judgement here is made with the domain's own primitives at an instant
 * the *caller* supplies. This module reads no clock, so "what survived the
 * restart" is a question with a stated instant rather than a fact this lane
 * invented, and a test can ask it about a fixed moment.
 */

/** A snapshot with nothing in it, for a store that never held anything. */
export function emptyPersonalitySnapshot(): PersonalitySnapshot {
  return {
    v: PERSONALITY_SNAPSHOT_VERSION,
    items: [],
    ledger: { schemaVersion: 1, maxEntries: PERSONALITY_LIMITS.maxLedgerEntries, entries: [] },
  }
}

/**
 * The items, in a deterministic order: oldest first, id as the tie-break.
 *
 * Deterministic on purpose. A recovered store is written back by whoever holds
 * it, and a rewrite whose order depended on Map iteration would make two runs
 * over the same state produce two different files.
 */
export function orderedPersonalityItems(snapshot: PersonalitySnapshot): readonly RelationshipItem[] {
  return [...snapshot.items].sort((a, b) => {
    const aTime = a.admittedAt ?? a.provenance.recordedAt
    const bTime = b.admittedAt ?? b.provenance.recordedAt
    if (aTime !== bTime) return aTime < bTime ? -1 : 1
    return a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0
  })
}

/**
 * One item, by an id the caller already holds.
 *
 * The only way to reach content out of a snapshot, and the reason this file
 * has no `byKind`, no `byTag` and no `query(sql)`: a generic read surface over
 * private personality data would make "read the store" and "read everything
 * this person ever told Freya" the same operation.
 */
export function personalitySnapshotItem(
  snapshot: PersonalitySnapshot,
  itemId: string,
): RelationshipItem | null {
  if (typeof itemId !== 'string') return null
  for (const item of snapshot.items) {
    if (item.itemId === itemId) return item
  }
  return null
}

/**
 * Whether an item's text is live (not retired).
 *
 * A retired item has its text destroyed. This is the check that enforces it:
 * a retired item is a tombstone, and its text is gone forever.
 */
export function isPersonalityItemLive(item: RelationshipItem): boolean {
  return item.status !== 'retired'
}

/**
 * Destroy the text of an item, keeping its metadata as a tombstone.
 *
 * A **delegation**, not a second implementation, and that is the point: "a retired
 * item has no text" has to be one rule in this codebase, or the recovery path and
 * the write path will eventually disagree about what a tombstone is and a
 * withdrawn sentence will survive whichever of them is checked less often.
 *
 * The item's `text` is set to `''` and its status becomes `retired`. All other
 * metadata — id, kind, key, tags, provenance, confidence, admitted instant, and the
 * lifecycle instant and closed reason — is preserved, so the domain can still report
 * that the item existed and why it ended.
 *
 * This is the same pattern as `retireContextItem` in the Context domain:
 * destruction, not a flag. A flag would leave the words in memory for the next
 * mistake to find; destruction means the only way to leak retired personality data
 * is to have leaked it while it was live.
 */
export function retirePersonalityItem(
  item: RelationshipItem,
  decision: { now: string; reason: RelationshipLifecycleReason },
): RelationshipItem {
  if (item.status === 'retired' && item.text === '') return item
  const retired = retireRelationshipItem(item, decision)
  if (!retired.ok) {
    // A record that cannot legally be retired — already rejected, superseded, or
    // never admitted — is not repaired here. Recovery normalises records that
    // already claim to be retired; it does not invent a retirement.
    return item
  }
  return retired.item
}
