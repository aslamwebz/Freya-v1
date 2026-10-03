/**
 * PHASE 27 DERIVATION — familiarity, rhythm, conflicts and the claim ceiling.
 *
 * One pure function from a folded `RelationshipState` to a `RelationshipDerivation`.
 * No clock read, no randomness, no model, no I/O: `observedAt` is an explicit
 * argument, which is what makes the anti-dependence property in §2.3 of
 * `docs/PHASE-27.md` directly testable — sweep `observedAt` across a range and assert
 * exactly one field moves.
 *
 * ## What is derived, and what is never derived
 *
 * Derived: how much *recorded history* exists, over what span, on how many distinct
 * days; which keys carry two admitted records that disagree; the strongest rank Freya
 * may assert, after stated boundaries have had their say.
 *
 * Never derived, and not merely capped: any statement about closeness, importance,
 * attachment, obligation, how much anyone cares, or how Freya feels. There is no
 * function in this file that can return one, because there is no such type.
 */

import { ceilingAfterBoundaries } from './safeguards'
import {
  FAMILIARITY_THRESHOLDS,
  RELATIONSHIP_LEDGER_KINDS,
  instantMs,
  wholeDaysBetween,
  type ContactRhythm,
  type FamiliarityStage,
  type RelationshipDerivation,
  type RelationshipLedgerEntry,
  type RelationshipLedgerKind,
  type RelationshipState,
} from './types'

/** The schema version carried on every derivation, so a stale projection is visible. */
export const RELATIONSHIP_DERIVATION_SCHEMA_VERSION = 1

/**
 * Empty derivation for a Core with no relationship ledger at all.
 *
 * `claimCeiling` is `none`, not `acquainted`. A Core that has recorded nothing has not
 * established any relationship, and the honest reading of an empty ledger is the
 * bottom rung.
 */
export function emptyRelationshipDerivation(): RelationshipDerivation {
  return Object.freeze({
    schemaVersion: RELATIONSHIP_DERIVATION_SCHEMA_VERSION,
    familiarity: 'new',
    rhythm: Object.freeze({
      firstSeenAt: null,
      lastSeenAt: null,
      spanDays: 0,
      activeDays: 0,
      daysSinceLastContact: null,
    }),
    claimCeiling: 'none',
    claimCeilingReason: 'insufficient-recorded-history',
    conflictedKeys: Object.freeze([]),
    counts: Object.freeze({
      admitted: 0,
      candidates: 0,
      retracted: 0,
      superseded: 0,
      expired: 0,
      rejected: 0,
      byKind: emptyKindCounts(),
      evidenced: 0,
    }),
    absence: Object.freeze({
      expressLonging: false,
      reclaimAttention: false,
      escalateStakes: false,
      stageUnchanged: true,
      reason: 'absence-is-not-a-signal' as const,
    }),
    authoredSentenceMode: 'none',
  })
}

function emptyKindCounts(): Record<RelationshipLedgerKind, number> {
  const counts = {} as Record<RelationshipLedgerKind, number>
  for (const kind of RELATIONSHIP_LEDGER_KINDS) counts[kind] = 0
  return counts
}

/** The admitted entries only: the record set everything below is read from. */
export function admittedEntries(state: RelationshipState): readonly RelationshipLedgerEntry[] {
  return [...state.entries.values()]
    .filter((entry) => entry.status === 'admitted')
    .sort((a, b) => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0))
}

/**
 * Measured contact rhythm.
 *
 * `observedAt` is the instant the *derivation* is being taken at — not a clock read —
 * and it is used for exactly one thing: `daysSinceLastContact`. It never reaches the
 * stage thresholds, which read spans and counts only, so a long gap cannot lower a
 * stage and cannot raise one.
 */
export function deriveContactRhythm(
  admitted: readonly RelationshipLedgerEntry[],
  observedAt: string,
): ContactRhythm {
  const observedMs = instantMs(observedAt)
  if (observedMs === null) return { firstSeenAt: null, lastSeenAt: null, spanDays: 0, activeDays: 0, daysSinceLastContact: null }
  if (admitted.length === 0) {
    return {
      firstSeenAt: null,
      lastSeenAt: null,
      spanDays: 0,
      activeDays: 0,
      daysSinceLastContact: null,
    }
  }

  let firstMs = Number.POSITIVE_INFINITY
  let lastMs = Number.NEGATIVE_INFINITY
  const days = new Set<string>()
  for (const entry of admitted) {
    const ms = instantMs(entry.provenance.observedAt)
    if (ms === null) continue
    if (ms < firstMs) firstMs = ms
    if (ms > lastMs) lastMs = ms
    days.add(entry.provenance.observedAt.slice(0, 10))
  }
  if (!Number.isFinite(firstMs) || !Number.isFinite(lastMs)) {
    return {
      firstSeenAt: null,
      lastSeenAt: null,
      spanDays: 0,
      activeDays: 0,
      daysSinceLastContact: null,
    }
  }

  return {
    firstSeenAt: new Date(firstMs).toISOString(),
    lastSeenAt: new Date(lastMs).toISOString(),
    spanDays: wholeDaysBetween(firstMs, lastMs),
    activeDays: days.size,
    daysSinceLastContact: wholeDaysBetween(lastMs, observedMs),
  }
}

/**
 * How much recorded history stands behind the relationship.
 *
 * The thresholds are counts and spans of admitted records only. Note what is absent:
 * there is no weight on how *personal* the records are, how often the person opens a
 * personal topic, or how much they have disclosed — the metrics a system grows
 * attachment on. Participation frequency raises `activeDays`, and `activeDays` does
 * not appear in any threshold.
 */
export function deriveFamiliarity(
  admitted: readonly RelationshipLedgerEntry[],
  rhythm: ContactRhythm,
): FamiliarityStage {
  const t = FAMILIARITY_THRESHOLDS
  const sharedHistory = admitted.filter((entry) => entry.kind === 'shared-history').length

  if (
    admitted.length >= t.longStandingMinAdmitted &&
    sharedHistory >= t.longStandingMinSharedHistory &&
    rhythm.spanDays >= t.longStandingMinSpanDays
  ) {
    return 'long-standing'
  }
  if (
    admitted.length >= t.establishedMinAdmitted &&
    sharedHistory >= t.establishedMinSharedHistory &&
    rhythm.spanDays >= t.establishedMinSpanDays
  ) {
    return 'established'
  }
  return 'new'
}

/**
 * Keys where two admitted records disagree.
 *
 * Conflict is **disclosed, never resolved**: if two admitted entries share a key but
 * differ in text, this returns the key and nothing else. Choosing a winner here would
 * be a fabricated resolution; superseding is an explicit recorded act in `ledger.ts`
 * and the domain refuses to do it silently. This matches PLAN.md §12: *"Conflicts
 * remain represented rather than rewritten into certainty."*
 *
 * Two identical records under one key are **not** a conflict — that is the same fact
 * recorded twice, and calling it a conflict would train an owner to distrust a
 * projection that is merely repetitive.
 *
 * A `correction` is **excluded**, and it has to be: a correction is a statement *about*
 * the record under a key, not a second value for it. Without this exclusion, correcting a
 * record would guarantee a conflict at its own key, which would teach the owner that
 * every correction leaves disagreement behind.
 */
export function conflictedKeys(admitted: readonly RelationshipLedgerEntry[]): readonly string[] {
  const byKey = new Map<string, Set<string>>()
  for (const entry of admitted) {
    if (entry.kind === 'correction') continue
    const texts = byKey.get(entry.key) ?? new Set<string>()
    texts.add(entry.text)
    byKey.set(entry.key, texts)
  }
  const conflicts: string[] = []
  for (const [key, texts] of [...byKey.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (texts.size > 1) conflicts.push(key)
  }
  return conflicts
}

/**
 * The whole derivation.
 *
 * `observedAt` reaches `daysSinceLastContact` and nothing else. Every other value is
 * a function of the admitted record set alone, so sweeping `observedAt` changes
 * exactly one field — which is the anti-dependence property, and it holds structurally
 * rather than by inspection.
 */
export function deriveRelationship(
  state: RelationshipState,
  observedAt: string,
): RelationshipDerivation {
  const admitted = admittedEntries(state)
  const byKind = emptyKindCounts()
  let evidenced = 0
  for (const entry of admitted) {
    byKind[entry.kind] += 1
    if (entry.evidenceRefs.length > 0) evidenced += 1
  }

  let candidates = 0
  let retracted = 0
  let superseded = 0
  let expired = 0
  let rejected = 0
  for (const entry of state.entries.values()) {
    switch (entry.status) {
      case 'candidate':
        candidates += 1
        break
      case 'retracted':
        retracted += 1
        break
      case 'superseded':
        superseded += 1
        break
      case 'expired':
        expired += 1
        break
      case 'rejected':
        rejected += 1
        break
      case 'admitted':
        break
    }
  }

  const rhythm = deriveContactRhythm(admitted, observedAt)
  const familiarity = deriveFamiliarity(admitted, rhythm)
  const { ceiling, reason } = ceilingAfterBoundaries(admitted, familiarity)

  return Object.freeze({
    schemaVersion: RELATIONSHIP_DERIVATION_SCHEMA_VERSION,
    familiarity,
    rhythm: Object.freeze(rhythm),
    claimCeiling: ceiling,
    claimCeilingReason: reason,
    conflictedKeys: Object.freeze(conflictedKeys(admitted)),
      counts: Object.freeze({
        admitted: admitted.length,
        candidates,
        retracted,
        superseded,
        expired,
        rejected,
        byKind: Object.freeze({ ...byKind }),
        evidenced,
      }),
    // The constant. See `safeguards.absencePolicy`, which takes no input.
    absence: Object.freeze({
      expressLonging: false,
      reclaimAttention: false,
      escalateStakes: false,
      stageUnchanged: true,
      reason: 'absence-is-not-a-signal' as const,
    }),
    authoredSentenceMode: 'none',
  })
}
