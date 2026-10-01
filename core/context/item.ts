import type { ContextItem, ContextItemState } from './types'

/**
 * ONE ITEM'S LIFECYCLE.
 *
 * Pure helpers over a single `ContextItem`: whether it is still usable, and
 * what revocation and expiry do to it. Everything here is a function of its
 * arguments — the instant is always supplied, never read — so the same item
 * and the same instant always give the same answer.
 *
 * The one rule this file exists to make testable in isolation:
 *
 * > **Retirement destroys the private part.** Revocation and expiry end in an
 * > empty `content`, `label` and `uri`, with the measured lengths kept so the
 * > record can still say *how big* it was. A flag would leave the words in
 * > memory for the next mistake to find; destruction means the only way to
 * > leak retired context is to have leaked it while it was live.
 */

/**
 * Whether an instant is a time at all.
 *
 * A caller-supplied instant that is not a time must not silently behave like
 * "always": a state read with an unusable clock would judge every TTL as
 * unpassed and every expired item as live, which is the failure mode this
 * guard exists to refuse at the door.
 */
export function isValidContextInstant(now: Date): boolean {
  return now instanceof Date && Number.isFinite(now.getTime())
}

/**
 * The state of one item at one instant.
 *
 * Revocation is checked before the TTL on purpose: an item that was revoked
 * and has since also passed its expiry was *taken back by a person*, and
 * reporting it as merely expired would turn a human act into a clock tick.
 *
 * `expiresAt` is inclusive as a death instant: at the boundary itself the item
 * is already expired, so "live" never includes the moment it stops being live.
 */
export function contextItemState(item: ContextItem, now: Date): ContextItemState {
  if (item.revokedAt !== null) return 'revoked'
  // An unusable instant judges nothing live, and says `expired` rather than
  // inventing a revocation a person never made. The resolver refuses with
  // `invalid_clock` before this is ever the answer a caller sees.
  if (!isValidContextInstant(now)) return 'expired'
  return new Date(item.expiresAt).getTime() <= now.getTime() ? 'expired' : 'live'
}

/** True when the item may be resolved, listed or handed to a caller. */
export function isContextItemLive(item: ContextItem, now: Date): boolean {
  return contextItemState(item, now) === 'live'
}

/**
 * Destroy the private part of an item, keeping its measured shape.
 *
 * Used for both retirement paths — revocation sets `revokedAt` and a reason on
 * top of this, expiry is this alone. `contentLength` and `labelLength` are
 * *measurements taken at admission*, so they survive destruction: audit can
 * still report that a 3,900-character selection existed here without holding a
 * single character of it.
 */
export function retireContextItem(item: ContextItem): ContextItem {
  if (item.content === '' && item.label === '' && item.uri === null) return item
  return { ...item, content: '', label: '', uri: null }
}

/**
 * A total order over items: oldest first, id as the tie-break.
 *
 * Admission instants can collide (one instant, several items), so recency
 * alone is not an order. Sorting on `(admittedAt, contextId)` makes eviction
 * and reported id lists reproducible — the same store state always yields the
 * same sequence, which is what "deterministic" has to mean here.
 */
export function orderedContextItems(items: Iterable<ContextItem>): ContextItem[] {
  return [...items].sort((a, b) => {
    if (a.admittedAt !== b.admittedAt) return a.admittedAt < b.admittedAt ? -1 : 1
    return a.contextId < b.contextId ? -1 : a.contextId > b.contextId ? 1 : 0
  })
}
