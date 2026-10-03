/**
 * The internal vocabulary of the Unified Conscious Context.
 *
 * Everything here is Core-private: nothing in this file is imported by a window,
 * and nothing in `core/protocol/consciousness.ts` depends on it. The split is
 * deliberate — the protocol is what a consumer is typed against, and this is the
 * machinery that decides what goes into it.
 *
 * ## Why there is no state
 *
 * There is no store, no engine and no `CoreState` slice, and that is the whole
 * design. Every value in the snapshot is already held by a subsystem that owns
 * it, so a second copy could only ever disagree with the first. The cost is that
 * the snapshot has to be recomputed rather than cached, which is bounded work —
 * and the benefit is that it cannot go stale relative to the state it claims to
 * describe.
 *
 * ## Why the bounds are here and not inline
 *
 * Every list in the projection is capped, and the caps are published on the
 * projection itself so a surface can say what it is not seeing. A bound written
 * inline at the point of use is a bound nobody can audit.
 */

import type { ConsciousFreshness, ConsciousSectionState } from '../protocol/consciousness'

/**
 * The ceilings the snapshot is built under.
 *
 * Sized so a person can read all of it in one go and so a projection built from
 * a journal with a million events is the same size as one built from ten. None
 * of these bound the journal, a subsystem's own store, or anything durable —
 * they bound the *projection*, which is what a window holds.
 */
export const CONSCIOUS_CONTEXT_LIMITS = Object.freeze({
  /** Provenance rows. One per contributing source; the sources themselves are a closed set. */
  maxSources: 16,
  /** Recent durable events listed. Enough to see a pattern, not to be a transcript. */
  maxRecentChanges: 24,
  /** Uncertainties listed. */
  maxUncertainties: 24,
  /** Offered actions listed. */
  maxNextActions: 32,
  /** Attention inbox items listed. Metadata only. */
  maxAttentionInboxItems: 8,
  /** Approvals listed. */
  maxApprovalItems: 8,
  /** Workers listed. */
  maxAgents: 12,
  /** Procedures listed. Metadata only; a body is reachable one skill at a time. */
  maxSkills: 12,
  /** Recent admissions listed. Metadata only. */
  maxContinuityItems: 12,
  /** Brain contradictions listed. */
  maxConflictItems: 8,
  /** Waiting runs, blocked tasks, blocked agents and unfulfilled presence requests, each. */
  maxWaitItems: 8,
  /**
   * Life entries listed.
   *
   * Bounded on this baseline only by the port contract: Phase 21 has not landed,
   * so the number that matters today is the one asserted in the absence test. It
   * is declared here rather than at the point of use so that Phase 21's adapter
   * has a ceiling to read instead of choosing one.
   */
  maxLifeEntries: 12,
})

/**
 * The subsystems a snapshot is derived from.
 *
 * A closed set, and it is also the row set of `provenance.sources`. Phase 17's
 * Skills is in it because it landed before this phase and reads like any other
 * source — a subsystem that projects metadata Core already owns. A subsystem
 * added *after* this phase becomes another row, never another field: that is the
 * property worth protecting, and the reason `sources` is a list of a closed set
 * rather than a fixed set of typed fields.
 *
 * ## `'life'` is a row before it is a subsystem
 *
 * `life` is here because `PLAN.md` §6 makes Phase 21 Life a required contributor.
 * Its row was a **stated absence** while Phase 21 was outstanding — never a
 * missing row: the alternative is how a snapshot ends up silently complete while
 * missing a whole domain, which is the failure mode this file exists to prevent.
 * Phase 21 has since landed and the row is a real reading.
 *
 * `'self'` and `'world'` are rows for the same reason, and Phase 22 took those
 * ports over: each is now a row in its own right with its own producer, rather
 * than a fact folded into the `brain` row. `continuity` stays folded into
 * `brain`'s row because the Brain is still its producer — the world domain has
 * no memory-admission concept to answer it with.
 */
export const CONSCIOUS_SOURCES = Object.freeze([
  'core',
  'brain',
  'life',
  'self',
  'world',
  'work',
  'mission',
  'workforce',
  'skills',
  'personality',
  'attention',
  'context',
  'office',
  'relay',
] as const)

export type ConsciousSourceDomain = (typeof CONSCIOUS_SOURCES)[number]

/**
 * Freshness, ranked so a total can be reduced to its weakest member.
 *
 * Ordered from best to worst because the reduction takes a **maximum** and the
 * weakest is the maximum. `unknown` outranks `absent` deliberately: an unreadable
 * subsystem is a worse thing to report than a missing one, and collapsing them
 * would hide the difference between "Freya cannot remember" and "we cannot ask
 * her".
 */
export const FRESHNESS_RANK: Readonly<Record<ConsciousFreshness, number>> = Object.freeze({
  fresh: 0,
  stale: 1,
  unknown: 2,
  absent: 3,
})

/**
 * The weakest of two freshness readings. Never optimistic.
 *
 * Takes the **larger** rank, because the ranks run best-to-worst. Getting this
 * backwards is the single easiest mistake to make here and it fails silently: a
 * snapshot that reduces to `'fresh'` because one source was fresh and nine were
 * absent is exactly the confidently-incomplete picture this phase exists to
 * prevent, and it would read as correct.
 */
export function weakestFreshness(
  a: ConsciousFreshness,
  b: ConsciousFreshness,
): ConsciousFreshness {
  return FRESHNESS_RANK[a] >= FRESHNESS_RANK[b] ? a : b
}

/** Reduce a list of readings to one, `'fresh'` for an empty list. */
export function weakestOf(readings: readonly ConsciousFreshness[]): ConsciousFreshness {
  return readings.length === 0 ? 'fresh' : readings.reduce(weakestFreshness)
}

/** The section state a single source's reading warrants. */
export function sectionStateFor(
  freshness: ConsciousFreshness,
  health: 'ready' | 'unavailable',
  note: string | null,
): { state: ConsciousSectionState; note: string | null } {
  if (freshness === 'absent') return { state: 'absent', note }
  if (freshness === 'unknown') return { state: 'degraded', note }
  if (health === 'unavailable') return { state: 'absent', note }
  return { state: 'available', note }
}

/**
 * Take the newest `limit` of a list that is already ordered oldest-first.
 *
 * A shared helper because five of the sections need exactly this and a copy
 * pasted five times is five chances to write `slice(-limit)` over an array that
 * is newest-first, which is how an ordering bug gets in.
 */
export function newestOf<T>(ordered: readonly T[], limit: number): T[] {
  if (limit <= 0) return []
  return ordered.length <= limit ? [...ordered] : ordered.slice(ordered.length - limit)
}

/**
 * Compare two instants, tolerating a malformed one.
 *
 * A string that is not an instant sorts *last*, so a record with a broken
 * timestamp can never displace a well-formed one at the head of a listing — and
 * can never make the order depend on array position either, because every pair
 * is compared the same way.
 */
export function byInstant(a: string, b: string): number {
  const left = Date.parse(a)
  const right = Date.parse(b)
  const l = Number.isNaN(left) ? Number.POSITIVE_INFINITY : left
  const r = Number.isNaN(right) ? Number.POSITIVE_INFINITY : right
  if (l !== r) return l < r ? -1 : 1
  return 0
}

/**
 * A total order for a **newest-first** listing.
 *
 * Not the negation of {@link byInstant}, which is the tempting one-liner and is
 * wrong. `byInstant` sorts a malformed instant *last* so it cannot displace a
 * well-formed record at the head of an oldest-first list; negating that puts the
 * malformed record at the head of a newest-first list, where it reads as the most
 * recent thing that happened. An entry whose time is unknown has no position in
 * time at all, and the truthful place to show it is last, not first.
 *
 * The same reasoning rules out sorting-then-reversing: the reverse is what puts the
 * unknown instant at the front.
 *
 * Ties fall back to the id, so the order is total and two runs over one journal
 * cannot disagree.
 */
export function newestFirstByInstant(
  a: { readonly at: string; readonly id: string },
  b: { readonly at: string; readonly id: string },
): number {
  const left = Date.parse(a.at)
  const right = Date.parse(b.at)
  const leftBad = Number.isNaN(left)
  const rightBad = Number.isNaN(right)
  if (leftBad && rightBad) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  // An unknown instant is never the newest, whichever side it is on.
  if (leftBad) return 1
  if (rightBad) return -1
  if (left !== right) return right - left
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * A total order that cannot tie.
 *
 * Every list in the projection is sorted by one of these, and each falls back to
 * the id, because a comparator that can return `0` for two different records
 * leaves the order down to the sort implementation — which is how two runs over
 * the same journal end up producing different arrays.
 */
export function byInstantThenId(
  a: { readonly at: string; readonly id: string },
  b: { readonly at: string; readonly id: string },
): number {
  const order = byInstant(a.at, b.at)
  return order !== 0 ? order : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
