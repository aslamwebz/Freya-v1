import {
  LIFE_SCHEMA_VERSION,
  type LifeConflictView,
  type LifeCountsView,
  type LifeEntryDetailView,
  type LifeProjection,
  type LifePersistenceView,
  type LifeTimelineItemView,
  type LifeTimelineView,
} from '../protocol/life'
import { LIFE_LIMITS, type LifeEntry, type LifeEntryKind } from './types'
import { conflictPartners, effectiveStatus } from './fold'
import type { LifeState } from './store'

export { ABSENT_LIFE_PROJECTION, NO_LIFE_DOMAIN_REASON } from '../protocol/life'

/**
 * THE LIFE PROJECTION — Core's only route from Life facts to a window.
 *
 * A pure function over the folded state and the store's persistence health. It
 * exists so the vocabulary a renderer receives is *derived* rather than
 * assembled: the engine supplies domain values, and this function decides — in
 * one place, testable without a Core — which fields may cross and which may not.
 *
 * ## What never crosses a broad read
 *
 * A summary's text, a body's text and any evidence body. The timeline carries a
 * title and measured lengths; the detail view carries the text, for one entry,
 * on an explicit read.
 *
 * ## Nothing is invented
 *
 * `dateKnown` is false when `occurredAt` is null, and the timeline never
 * substitutes `recordedAt` for it. A conflict is disclosed from the edge table;
 * it is never resolved. A withdrawn entry is reported as withdrawn.
 */

export interface LifeProjectionInput {
  readonly sequence?: number
  readonly state: LifeState
  readonly persistence: LifePersistenceView
}

export interface LifeTimelineQuery {
  readonly limit?: number
  readonly kinds?: readonly LifeEntryKind[]
  readonly includeWithdrawn?: boolean
}

/** The chronological order: when it happened, then when it was recorded, then id. */
function chronological(left: LifeEntry, right: LifeEntry): number {
  const leftAt = left.occurredAt ?? left.recordedAt
  const rightAt = right.occurredAt ?? right.recordedAt
  const byTime = leftAt.localeCompare(rightAt)
  if (byTime !== 0) return byTime
  const byRecorded = left.recordedAt.localeCompare(right.recordedAt)
  if (byRecorded !== 0) return byRecorded
  return left.entryId.localeCompare(right.entryId)
}

export function timelineItem(entry: LifeEntry, state: LifeState): LifeTimelineItemView {
  const conflicts = conflictPartners(state, entry.entryId)
  return {
    entryId: entry.entryId,
    kind: entry.kind,
    title: entry.title,
    status: effectiveStatus(entry, state.conflicts.values()),
    salience: entry.salience,
    derivation: entry.derivation,
    confidence: entry.confidence,
    occurredAt: entry.occurredAt,
    dateKnown: entry.occurredAt !== null,
    recordedAt: entry.recordedAt,
    updatedAt: entry.updatedAt,
    revision: entry.revision,
    sourceDomain: entry.provenance.sourceDomain,
    sourceId: entry.provenance.sourceId,
    referenceCount: entry.references.length,
    summaryLength: entry.summary.length,
    bodyLength: entry.body.length,
    conflictCount: conflicts.length,
    tags: entry.tags,
  }
}

function countsOf(state: LifeState): LifeCountsView {
  let live = 0
  let conflicted = 0
  let withdrawn = 0
  let observed = 0
  let ownerStated = 0
  let derived = 0
  let inferred = 0
  let uncertain = 0
  let revisions = 0
  let references = 0
  let truncated = 0
  for (const entry of state.entries.values()) {
    const status = effectiveStatus(entry, state.conflicts.values())
    if (status === 'withdrawn') withdrawn += 1
    else if (status === 'conflicted') conflicted += 1
    else live += 1
    if (entry.derivation === 'observed') observed += 1
    else if (entry.derivation === 'owner-stated') ownerStated += 1
    else if (entry.derivation === 'derived') derived += 1
    else if (entry.derivation === 'inferred') inferred += 1
    else if (entry.derivation === 'uncertain') uncertain += 1
    if (entry.revision > 1) revisions += 1
    references += entry.references.length
  }
  const total = state.entries.size
  if (total > LIFE_LIMITS.maxEntries) truncated = total - LIFE_LIMITS.maxEntries
  return {
    total,
    live,
    conflicted,
    withdrawn,
    observed,
    ownerStated,
    derived,
    inferred,
    uncertain,
    revisions,
    references,
    conflicts: state.conflicts.size,
    truncated,
  }
}

/**
 * Build the projection a window may hold.
 *
 * Pure: same input, same output, no clock read and no randomness.
 */
export function projectLife(input: LifeProjectionInput): LifeProjection {
  const ordered = [...input.state.entries.values()].sort(chronological)
  const recent = ordered.slice(-LIFE_LIMITS.maxRecentInProjection).map((entry) => timelineItem(entry, input.state))
  return {
    health: 'ready',
    reason: null,
    schemaVersion: LIFE_SCHEMA_VERSION,
    sequence: input.sequence ?? input.state.sequence,
    counts: countsOf(input.state),
    persistence: { ...input.persistence },
    recent,
    limits: {
      maxEntries: LIFE_LIMITS.maxEntries,
      maxTimelineItems: LIFE_LIMITS.maxTimelineItems,
      maxReferencesPerEntry: LIFE_LIMITS.maxReferencesPerEntry,
      maxBodyChars: LIFE_LIMITS.maxBodyChars,
    },
  }
}

/**
 * Build a bounded chronological read.
 *
 * The limit is clamped to the code-owned ceiling, never widened. `truncated` and
 * `omittedCount` are always stated, so a caller can never mistake a clipped list
 * for the whole history.
 */
export function projectTimeline(state: LifeState, query: LifeTimelineQuery = {}): LifeTimelineView {
  const kinds = query.kinds ?? []
  const includeWithdrawn = query.includeWithdrawn === true
  const requested = query.limit ?? LIFE_LIMITS.maxTimelineItems
  const limit = Math.max(0, Math.min(Math.floor(requested), LIFE_LIMITS.maxTimelineItems))

  const filtered = [...state.entries.values()]
    .filter((entry) => (kinds.length === 0 ? true : kinds.includes(entry.kind)))
    .filter((entry) => (includeWithdrawn ? true : effectiveStatus(entry, state.conflicts.values()) !== 'withdrawn'))
    .sort(chronological)

  const total = filtered.length
  const returned = Math.min(limit, total)
  const items = filtered.slice(0, returned).map((entry) => timelineItem(entry, state))
  return {
    items,
    total,
    returned,
    truncated: total > returned,
    omittedCount: total - returned,
    filters: { limit, kinds, includeWithdrawn },
  }
}

/**
 * Build the owner's explicit detail read for one entry.
 *
 * The one place an entry's summary and body cross the bridge. It takes the entry
 * and its conflict edges rather than a state, so it cannot be assembled from
 * anything but a real folded record.
 */
export function lifeEntryDetail(entry: LifeEntry, state: LifeState): LifeEntryDetailView {
  const conflicts: LifeConflictView[] = conflictPartners(state, entry.entryId).map((conflict) => ({
    conflictId: conflict.conflictId,
    otherEntryId: conflict.entryA === entry.entryId ? conflict.entryB : conflict.entryA,
    reason: conflict.reason,
    detectedAt: conflict.detectedAt,
  }))
  return {
    entryId: entry.entryId,
    kind: entry.kind,
    title: entry.title,
    summary: entry.summary,
    body: entry.body,
    status: effectiveStatus(entry, state.conflicts.values()),
    salience: entry.salience,
    derivation: entry.derivation,
    confidence: entry.confidence,
    provenance: {
      sourceDomain: entry.provenance.sourceDomain,
      sourceId: entry.provenance.sourceId,
      observedAt: entry.provenance.observedAt,
      recordedAt: entry.provenance.recordedAt,
      actor: entry.provenance.actor,
    },
    references: entry.references.map((reference) => ({
      domain: reference.domain,
      refKind: reference.refKind,
      refId: reference.refId,
      label: reference.label,
    })),
    occurredAt: entry.occurredAt,
    dateKnown: entry.occurredAt !== null,
    recordedAt: entry.recordedAt,
    updatedAt: entry.updatedAt,
    revision: entry.revision,
    supersedes: entry.supersedes,
    lineage: entry.lineage,
    conflicts,
    tags: entry.tags,
    admissionReason: entry.admissionReason,
  }
}
