import type { Confidence } from '../brain/types'
import type {
  LifeDerivation,
  LifeEffectiveStatus,
  LifeEntryKind,
  LifeRefKind,
  LifeRevisionRef,
  LifeSalience,
  LifeSourceDomain,
} from '../life/types'

/**
 * THE LIFE HISTORY PROTOCOL — what a window may know about Freya's life.
 *
 * This file is a **view**, not a channel. It carries the read-only shapes a
 * renderer is typed against, one frozen projection for a Core with no Life
 * domain, and the outcome vocabulary of the three reads that exist.
 *
 * ## What crosses, and what pointedly does not
 *
 * Crosses: ids, closed labels, statuses, dates, salience, derivation class,
 * confidence, provenance metadata, reference ids, bounded titles, the *measured
 * length* of a summary and a body, revision lineage and conflict edges.
 *
 * Does not cross, in any broad read:
 *
 * - **Any evidence body.** A memory's content, a conversation turn, a connector
 *   payload and a prompt are not fields of any view here. The only link to
 *   evidence is a reference id.
 * - **Any entry body or summary text.** `life.timeline.read` carries a title and a
 *   measured `summaryLength`/`bodyLength`. The one way to read an entry's own text
 *   back is the explicit, owner-only `life.entry.read` for a single entry.
 * - **Any confidence, derivation class, source class or status a window could
 *   assert.** They are reported, never accepted.
 *
 * ## The absences, kept apart
 *
 * `'unavailable'` with `NO_LIFE_DOMAIN_REASON` means *this build has no Life
 * domain and none is simulated*. `null` from the host means *no Core has started
 * yet*. Rendering the first as "Freya has no history" would tell a person she
 * remembers nothing when nothing is watching.
 */

/* ------------------------------------------------------------------ views */

/** One entry as a broad read may hold it. No body, no summary text. */
export interface LifeTimelineItemView {
  readonly entryId: string
  readonly kind: LifeEntryKind
  readonly title: string
  readonly status: LifeEffectiveStatus
  readonly salience: LifeSalience
  readonly derivation: LifeDerivation
  readonly confidence: Confidence
  /** When the remembered thing happened, or null when evidence does not say. */
  readonly occurredAt: string | null
  /** False when `occurredAt` is null. The timeline never invents a date. */
  readonly dateKnown: boolean
  readonly recordedAt: string
  readonly updatedAt: string
  readonly revision: number
  readonly sourceDomain: LifeSourceDomain
  readonly sourceId: string | null
  readonly referenceCount: number
  readonly summaryLength: number
  readonly bodyLength: number
  readonly conflictCount: number
  readonly tags: readonly string[]
}

/** One reference, as the explicit detail read may show it. */
export interface LifeReferenceView {
  readonly domain: LifeSourceDomain
  readonly refKind: LifeRefKind
  readonly refId: string
  readonly label: string | null
}

/** A conflict edge, disclosed rather than resolved. */
export interface LifeConflictView {
  readonly conflictId: string
  readonly otherEntryId: string
  readonly reason: string
  readonly detectedAt: string
}

/**
 * One entry's explicit detail read.
 *
 * The only shape in this file that carries `summary` and `body`, and it is
 * returned for exactly one entry on request.
 */
export interface LifeEntryDetailView {
  readonly entryId: string
  readonly kind: LifeEntryKind
  readonly title: string
  readonly summary: string
  readonly body: string
  readonly status: LifeEffectiveStatus
  readonly salience: LifeSalience
  readonly derivation: LifeDerivation
  readonly confidence: Confidence
  readonly provenance: {
    readonly sourceDomain: LifeSourceDomain
    readonly sourceId: string | null
    readonly observedAt: string
    readonly recordedAt: string
    readonly actor: string
  }
  readonly references: readonly LifeReferenceView[]
  readonly occurredAt: string | null
  readonly dateKnown: boolean
  readonly recordedAt: string
  readonly updatedAt: string
  readonly revision: number
  readonly supersedes: string | null
  readonly lineage: readonly LifeRevisionRef[]
  readonly conflicts: readonly LifeConflictView[]
  readonly tags: readonly string[]
  readonly admissionReason: string
}

/** Totals across the autobiographical layer. Counts, never scores. */
export interface LifeCountsView {
  readonly total: number
  readonly live: number
  readonly conflicted: number
  readonly withdrawn: number
  readonly observed: number
  readonly ownerStated: number
  readonly derived: number
  readonly inferred: number
  readonly uncertain: number
  readonly revisions: number
  readonly references: number
  readonly conflicts: number
  readonly truncated: number
}

/** Whether entries survive a restart, and why not when they do not. */
export interface LifePersistenceView {
  readonly mode: 'encrypted' | 'ephemeral' | 'memory' | 'unavailable'
  readonly durable: boolean
  readonly reason: string | null
}

/**
 * Everything a window may know about Life History, in one read-only object.
 *
 * A mirror like every other subsystem's. `recent` is a bounded, chronological
 * slice of metadata-only timeline items; the full timeline is a separate,
 * explicitly bounded read.
 */
export interface LifeProjection {
  readonly health: 'ready' | 'unavailable'
  readonly reason: string | null
  readonly schemaVersion: number
  readonly sequence: number
  readonly counts: LifeCountsView
  readonly persistence: LifePersistenceView
  readonly recent: readonly LifeTimelineItemView[]
  readonly limits: {
    readonly maxEntries: number
    readonly maxTimelineItems: number
    readonly maxReferencesPerEntry: number
    readonly maxBodyChars: number
  }
}

/** A bounded chronological read. `truncated` and `omittedCount` are stated. */
export interface LifeTimelineView {
  readonly items: readonly LifeTimelineItemView[]
  readonly total: number
  readonly returned: number
  readonly truncated: boolean
  readonly omittedCount: number
  readonly filters: {
    readonly limit: number
    readonly kinds: readonly LifeEntryKind[]
    readonly includeWithdrawn: boolean
  }
}

/* ------------------------------------------------------------- read-back */

export type LifeOperation = 'status' | 'timeline' | 'entry' | 'refused'

export type LifeRefusalCode =
  | 'no-life-domain'
  | 'not-ready'
  | 'malformed-payload'
  | 'unknown-entry'
  | 'guard-refused'

/**
 * What a Life command produced.
 *
 * `refused` is an outcome rather than an exception everywhere: an unknown entry,
 * a bad payload, a Guard refusal and a Core that is not up all answer in words.
 */
export interface LifeCommandOutcome {
  readonly operation: LifeOperation
  readonly ok: boolean
  readonly code?: LifeRefusalCode
  readonly reason?: string
  readonly projection?: LifeProjection
  readonly timeline?: LifeTimelineView
  readonly entry?: LifeEntryDetailView
}

/* --------------------------------------------------------------- absent */

/**
 * A valid projection for a Core that has no Life domain.
 *
 * `unavailable`, never `ready` with zero counts: "Freya has no recorded history"
 * and "nothing is watching for one" are different facts.
 */
export const ABSENT_LIFE_PROJECTION: LifeProjection = Object.freeze({
  health: 'unavailable' as const,
  reason: 'Core has not reported a Life History domain yet',
  schemaVersion: 1,
  sequence: 0,
  counts: Object.freeze({
    total: 0,
    live: 0,
    conflicted: 0,
    withdrawn: 0,
    observed: 0,
    ownerStated: 0,
    derived: 0,
    inferred: 0,
    uncertain: 0,
    revisions: 0,
    references: 0,
    conflicts: 0,
    truncated: 0,
  }),
  persistence: Object.freeze({ mode: 'ephemeral' as const, durable: false, reason: null }),
  recent: Object.freeze([]) as readonly LifeTimelineItemView[],
  limits: Object.freeze({
    maxEntries: 0,
    maxTimelineItems: 0,
    maxReferencesPerEntry: 0,
    maxBodyChars: 0,
  }),
})

/**
 * The sentence Core reports when nothing has built a Life History domain.
 *
 * Exported so the host, the surface and the tests quote the same words.
 */
export const NO_LIFE_DOMAIN_REASON =
  'this Core has no Life History domain: no episode, milestone, period or theme is recorded, and none is simulated'

/** The projection schema this lane speaks. */
export const LIFE_SCHEMA_VERSION = 1

/** The sentence a window gets when a payloadless read carried something. */
export const LIFE_NO_PAYLOAD =
  'life.status.read carries no payload: a window may ask what Core remembers of its life and may not supply a status, a derivation class, a confidence or a date'
