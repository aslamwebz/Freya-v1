import { contextItemState, orderedContextItems, retireContextItem } from '../item'
import type { ContextItem } from '../types'
import { CONTEXT_SNAPSHOT_VERSION, type ContextSnapshot } from './port'

/**
 * READING A RECOVERED SNAPSHOT.
 *
 * Three small functions for the moment a process comes back up, and one rule
 * they all exist to keep:
 *
 * > **Content that outlived its TTL stops existing when the process was down.**
 *
 * Expiry in the domain is not a filter applied at read time — it is destruction,
 * performed the first time anybody looks after the deadline (`item.ts`). A
 * shutdown is just a very long gap between two looks, so a snapshot that sat on
 * disk overnight arrives holding ciphertext for a selection whose TTL ended
 * hours ago. Recovery must apply the same destruction before that content is
 * handed anywhere, rather than letting it sit in a live-looking record until
 * somebody happens to read.
 *
 * Every judgement here is made with the domain's own primitives —
 * `contextItemState`, `retireContextItem`, `orderedContextItems` — at an instant
 * the *caller* supplies. This module reads no clock, so "what survived the
 * restart" is a question with a stated instant rather than a fact this lane
 * invented, and a test can ask it about a fixed moment.
 */

/** A snapshot with nothing in it, for a store that never held anything. */
export function emptyContextSnapshot(): ContextSnapshot {
  return { v: CONTEXT_SNAPSHOT_VERSION, records: [] }
}

/**
 * Destroy the content of everything that outlived its TTL, as of `now`.
 *
 * Uses the domain's own state function rather than a second opinion about what
 * "expired" means: a record is retired when the domain would say it is not live,
 * and it is retired *the same way*, by `retireContextItem`. Revoked records were
 * already destroyed when they were taken back, so they come back unchanged — a
 * tombstone's measured lengths survive, which is what lets audit still report
 * that a 3,900-character selection used to be here.
 *
 * An unusable instant retires nothing. A clock that is not a clock must not
 * destroy anything, in the same way it must not declare anything live.
 */
export function retireContextSnapshot(snapshot: ContextSnapshot, now: Date): ContextSnapshot {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return snapshot
  let changed = false
  const records = snapshot.records.map((item) => {
    if (contextItemState(item, now) === 'live') return item
    const retired = retireContextItem(item)
    if (retired === item) return item
    changed = true
    return retired
  })
  return changed ? { v: snapshot.v, records } : snapshot
}

/**
 * The records, in the domain's own order: oldest first, id as the tie-break.
 *
 * Deterministic on purpose. A recovered store is written back by whoever holds
 * it, and a rewrite whose order depended on Map iteration would make two runs
 * over the same state produce two different files.
 */
export function orderedContextSnapshotRecords(snapshot: ContextSnapshot): readonly ContextItem[] {
  return orderedContextItems(snapshot.records)
}

/**
 * One record, by an id the caller already holds.
 *
 * The only way to reach content out of a snapshot, and the reason this file has
 * no `byScope`, no `byProvenance` and no `query(sql)`: a generic read surface
 * over private context would make "read the store" and "read everything in this
 * person's session" the same operation. A caller that has an id — because the
 * domain resolved a reference, or because it minted one — gets that record and
 * nothing else.
 *
 * Null when the id is not held. Not a refusal, not an error: an id that is not
 * there is an answer, and inventing a record for it would be worse.
 */
export function contextSnapshotRecord(
  snapshot: ContextSnapshot,
  contextId: string,
): ContextItem | null {
  if (typeof contextId !== 'string') return null
  for (const item of snapshot.records) {
    if (item.contextId === contextId) return item
  }
  return null
}