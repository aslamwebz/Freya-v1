import {
  RELATIONSHIP_SCHEMA_VERSION,
  type RelationshipCountsView,
  type RelationshipEntriesOutcome,
  type RelationshipEntriesView,
  type RelationshipEntryDetailView,
  type RelationshipEntryReadOutcome,
  type RelationshipEntryView,
  type RelationshipPersistenceView,
  type RelationshipProjection,
} from '../protocol/relationship'
import { deriveRelationship } from './familiarity'
import { RELATIONSHIP_LIMITS, type RelationshipLedgerEntry, type RelationshipState } from './types'

export {
  ABSENT_RELATIONSHIP_PROJECTION,
  NO_RELATIONSHIP_DOMAIN_REASON,
  RELATIONSHIP_SCHEMA_VERSION,
} from '../protocol/relationship'

/**
 * THE RELATIONSHIP PROJECTION — Core's only route from relationship facts to a window.
 *
 * A pure function over the folded state, the store's health and one explicit
 * `observedAt`. It exists so the vocabulary a renderer receives is *derived* rather
 * than assembled: the domain supplies values, and this function decides — in one
 * place, testable without a Core — which fields may cross and which may not.
 *
 * ## The two rules it enforces
 *
 * 1. **No text in a broad read.** `projectRelationshipEntries` emits `textLength`, never
 *    `text`. The single-entry read is the only route to a record's own words, it is
 *    owner-only by construction, and it is separately bounded.
 * 2. **Nothing is invented and nothing is resolved.** `familiarity` is reported as
 *    derived. A conflicted key is disclosed as conflicted. A retracted record appears
 *    as `retracted` with `textLength: 0` and `textDestroyed: true`, which is the honest
 *    answer to "what does Freya still hold here" — not as absent, because absent would
 *    answer "there was never anything".
 */

export interface RelationshipProjectionInput {
  readonly state: RelationshipState
  readonly persistence: RelationshipPersistenceView
  readonly observedAt: string
}

/** Turn the derivation plus persistence health into the projection a window holds. */
export function projectRelationship(input: RelationshipProjectionInput): RelationshipProjection {
  const derivation = deriveRelationship(input.state, input.observedAt)
  return Object.freeze({
    schemaVersion: RELATIONSHIP_SCHEMA_VERSION,
    mode: 'available' as const,
    familiarity: derivation.familiarity,
    rhythm: Object.freeze({ ...derivation.rhythm }),
    claimCeiling: derivation.claimCeiling,
    claimCeilingReason: derivation.claimCeilingReason,
    conflictedKeys: [...derivation.conflictedKeys].slice(0, RELATIONSHIP_LIMITS.maxProjectedConflicts),
    counts: freezeCounts(derivation.counts),
    absence: Object.freeze({ ...derivation.absence }),
    authoredSentenceMode: derivation.authoredSentenceMode,
    persistence: Object.freeze({ ...input.persistence }),
  })
}

function freezeCounts(counts: {
  admitted: number
  candidates: number
  retracted: number
  superseded: number
  expired: number
  rejected: number
  byKind: Readonly<Record<string, number>>
  evidenced: number
}): RelationshipCountsView {
  return Object.freeze({
    admitted: counts.admitted,
    candidates: counts.candidates,
    retracted: counts.retracted,
    superseded: counts.superseded,
    expired: counts.expired,
    rejected: counts.rejected,
    evidenced: counts.evidenced,
    byKind: Object.freeze({ ...counts.byKind }) as RelationshipCountsView['byKind'],
  })
}

/**
 * A broad read of the ledger. Metadata only.
 *
 * Default order is newest-observed first, then id, so two windows cannot disagree
 * about which record is "current" because of insertion accidents. `statuses` filters
 * so a workspace can show withdrawn history without showing withdrawn text.
 */
export function projectRelationshipEntries(
  state: RelationshipState,
  options: { limit?: number; statuses?: readonly string[] } = {},
): RelationshipEntriesOutcome {
  const all = [...state.entries.values()]
  const statuses = options.statuses
  const filtered =
    statuses === undefined || statuses.length === 0
      ? all
      : all.filter((entry) => statuses.includes(entry.status))

  const ordered = filtered.sort(observedThenId)
  const requested = options.limit ?? RELATIONSHIP_LIMITS.maxProjectionEntries
  // A caller may lower the bound and never raise it above the domain limit.
  const limit = Math.max(0, Math.min(requested, RELATIONSHIP_LIMITS.maxProjectionEntries))
  const shown = ordered.slice(0, limit)

  const view: RelationshipEntriesView = {
    items: shown.map(projectEntry),
    truncated: shown.length < ordered.length,
    total: ordered.length,
    schemaVersion: RELATIONSHIP_SCHEMA_VERSION,
  }
  return { ok: true, entries: Object.freeze(view), reason: null }
}

/**
 * The one read that carries a record's own words.
 *
 * Owner-only by construction: the only route here is a Core command the owner
 * principal holds, and the renderer cannot invent one. Bounded by `entryId` and by the
 * entry limit, so it cannot become a bulk export through repetition.
 */
export function projectRelationshipEntryDetail(
  state: RelationshipState,
  entryId: unknown,
): RelationshipEntryReadOutcome {
  if (typeof entryId !== 'string' || entryId.length === 0 || entryId.length > RELATIONSHIP_LIMITS.maxEntryIdChars) {
    return { ok: false, code: 'invalid-id', reason: 'entryId must be a non-empty bounded string' }
  }
  const entry = state.entries.get(entryId)
  if (entry === undefined) {
    return { ok: false, code: 'no-such-entry', reason: 'that relationship ledger entry does not exist' }
  }
  const detail: RelationshipEntryDetailView = {
    entryId: entry.entryId,
    kind: entry.kind,
    key: entry.key,
    text: entry.text,
    status: entry.status,
    sourceType: entry.provenance.sourceType,
    confidence: entry.confidence,
    observedAt: entry.provenance.observedAt,
    recordedAt: entry.provenance.recordedAt,
    admittedAt: entry.admittedAt,
    lifecycleAt: entry.lifecycleAt,
    lifecycleReason: entry.lifecycleReason,
    tags: [...entry.tags],
    evidenceRefCount: entry.evidenceRefs.length,
    // A destroyed record reads as destroyed rather than as empty, because "there was
    // something and it was taken back" and "there was nothing" are different answers.
    textDestroyed: entry.text.length === 0 && entry.status !== 'rejected',
  }
  return { ok: true, entry: Object.freeze(detail), reason: null }
}

/** One entry as a broad read may hold it. `textLength` is the only trace of the text. */
export function projectEntry(entry: RelationshipLedgerEntry): RelationshipEntryView {
  return Object.freeze({
    entryId: entry.entryId,
    kind: entry.kind,
    key: entry.key,
    status: entry.status,
    sourceType: entry.provenance.sourceType,
    actor: entry.provenance.actor,
    confidence: entry.confidence,
    verificationStatus: entry.provenance.verificationStatus,
    observedAt: entry.provenance.observedAt,
    recordedAt: entry.provenance.recordedAt,
    admittedAt: entry.admittedAt,
    lifecycleAt: entry.lifecycleAt,
    lifecycleReason: entry.lifecycleReason,
    tags: Object.freeze([...entry.tags]),
    evidenceRefCount: entry.evidenceRefs.length,
    textLength: entry.text.length,
  })
}

function observedThenId(a: RelationshipLedgerEntry, b: RelationshipLedgerEntry): number {
  const byObserved = b.provenance.observedAt.localeCompare(a.provenance.observedAt)
  if (byObserved !== 0) return byObserved
  return a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0
}
