import type { Confidence, EpistemicStatus, SourceTrust } from '../brain/types'
import type {
  ClaimCeilingReason,
  ContactRhythm,
  FamiliarityStage,
  RelationalClaimRank,
  RelationshipAuthoredSentenceMode,
  RelationshipLedgerKind,
  RelationshipLedgerStatus,
  RelationshipLifecycleReason,
} from '../relationship/types'

/**
 * THE RELATIONSHIP PROTOCOL — what a window may know about this relationship.
 *
 * This file is a **view**, not a channel. It carries the read-only shapes a renderer
 * is typed against, one frozen projection for a Core with no relationship domain, and
 * the outcome vocabulary of the reads that exist.
 *
 * ## What crosses, and what pointedly does not
 *
 * Crosses: ids, closed labels, statuses, instants, provenance *metadata* (source
 * class, actor, confidence), counts, tags, key slugs, measured lengths, the familiarity
 * stage, the contact rhythm, the conflicted keys, the claim ceiling and the reason for
 * it.
 *
 * Does not cross, in any broad read:
 *
 * - **Any entry's `text`.** `relationship.entries.read` carries a bounded `key`, the
 *   tags, and the *measured length* of the text. The one way to read a record's own
 *   words back is the explicit, owner-only `relationship.entry.read` for a single
 *   entry.
 * - **Any confidence, status, source class, stage or ceiling a window could assert.**
 *   They are reported, never accepted. There is no write verb on this surface at all:
 *   entries are created by trusted Core pathways, never by a renderer.
 * - **Any closeness number.** There is no such field, and the claim ladder has no rung
 *   above `recorded-history`, so a surface cannot compute one.
 *
 * ## The absences, kept apart
 *
 * `'unavailable'` with `NO_RELATIONSHIP_DOMAIN_REASON` means *this build has no
 * relationship domain and none is simulated*. `null` from the host means *no Core has
 * started yet*. Rendering the first as "Freya knows nothing about you" would be a lie
 * in the direction of coldness, which is exactly the wrong direction for a system
 * whose boundary is "never fabricate intimacy".
 */

/* ------------------------------------------------------------------ views */

/** One ledger entry as a broad read may hold it. No text. */
export interface RelationshipEntryView {
  readonly entryId: string
  readonly kind: RelationshipLedgerKind
  /** The code-owned slug a derivation groups by. Bounded, and never prose. */
  readonly key: string
  readonly status: RelationshipLedgerStatus
  readonly sourceType: SourceTrust
  readonly actor: string
  readonly confidence: Confidence
  readonly verificationStatus: EpistemicStatus
  readonly observedAt: string
  readonly recordedAt: string
  readonly admittedAt: string | null
  readonly lifecycleAt: string | null
  readonly lifecycleReason: RelationshipLifecycleReason | null
  readonly tags: readonly string[]
  readonly evidenceRefCount: number
  /** Measured, never the words. The only trace of the text in a broad read. */
  readonly textLength: number
}

/** One entry's own words, on an explicit single-entry owner read. */
export interface RelationshipEntryDetailView {
  readonly entryId: string
  readonly kind: RelationshipLedgerKind
  readonly key: string
  readonly text: string
  readonly status: RelationshipLedgerStatus
  readonly sourceType: SourceTrust
  readonly confidence: Confidence
  readonly observedAt: string
  readonly recordedAt: string
  readonly admittedAt: string | null
  readonly lifecycleAt: string | null
  readonly lifecycleReason: RelationshipLifecycleReason | null
  readonly tags: readonly string[]
  readonly evidenceRefCount: number
  /** True when the text was destroyed by retraction or expiry. */
  readonly textDestroyed: boolean
}

export interface RelationshipCountsView {
  readonly admitted: number
  readonly candidates: number
  readonly retracted: number
  readonly superseded: number
  readonly expired: number
  readonly rejected: number
  readonly evidenced: number
  readonly byKind: Readonly<Record<RelationshipLedgerKind, number>>
}

/**
 * The absence posture, as data.
 *
 * Every field is `false`/`true` by construction. It crosses so that a surface can
 * *render the guarantee* rather than merely not violate it — a relationship workspace
 * that can say "absence is not treated as a signal" is one that cannot quietly invent
 * a reason to nudge.
 */
export interface RelationshipAbsenceView {
  readonly expressLonging: false
  readonly reclaimAttention: false
  readonly escalateStakes: false
  readonly stageUnchanged: true
  readonly reason: 'absence-is-not-a-signal'
}

export interface RelationshipProjection {
  readonly schemaVersion: number
  /** `'unavailable'` only for a build with no relationship domain. */
  readonly mode: 'available' | 'unavailable'
  readonly familiarity: FamiliarityStage
  readonly rhythm: ContactRhythm
  /**
   * The strongest characterisation Freya may make, and why.
   *
   * Closed at `recorded-history`. A surface that wanted a stronger claim has no rung
   * to reach for, which is the point.
   */
  readonly claimCeiling: RelationalClaimRank
  readonly claimCeilingReason: ClaimCeilingReason
  /** Keys carrying two admitted records that disagree. Disclosed, never resolved. */
  readonly conflictedKeys: readonly string[]
  readonly counts: RelationshipCountsView
  readonly absence: RelationshipAbsenceView
  /** Phase 27 composes no sentence about the relationship. Always `none`. */
  readonly authoredSentenceMode: RelationshipAuthoredSentenceMode
  readonly persistence: RelationshipPersistenceView
}

export interface RelationshipPersistenceView {
  readonly mode: 'encrypted' | 'ephemeral' | 'memory' | 'unavailable'
  readonly durable: boolean
  readonly degraded: boolean
  readonly reason: string | null
}

export interface RelationshipEntriesView {
  readonly items: readonly RelationshipEntryView[]
  /** True when the read was bounded and more records exist than were returned. */
  readonly truncated: boolean
  readonly total: number
  readonly schemaVersion: number
}

/* --------------------------------------------------------------- outcomes */

export type RelationshipEntriesOutcome =
  | { readonly ok: true; readonly entries: RelationshipEntriesView; readonly reason: null }
  | { readonly ok: false; readonly code: string; readonly reason: string }

export type RelationshipEntryReadOutcome =
  | { readonly ok: true; readonly entry: RelationshipEntryDetailView; readonly reason: null }
  | { readonly ok: false; readonly code: string; readonly reason: string }

/**
 * The outcome of one trusted write.
 *
 * Carries the closed `code` vocabulary rather than a sentence wherever it refuses, and
 * names the record a correction superseded and the `correction` record it wrote beside
 * it — so a caller can show "this replaced that" without reading two entries and
 * inferring it.
 *
 * There is no such type on any renderer-facing surface. This is a Core-internal shape,
 * which is the point: a window receives the *projection*, not the outcome of writing.
 */
export type RelationshipWriteOutcome =
  | {
      readonly ok: true
      readonly outcome: 'recorded' | 'corrected' | 'withdrawn' | 'forgotten' | 'rejected'
      readonly entry: RelationshipEntryView | null
      readonly reason: string
      /** The record this write replaced, for `corrected`. */
      readonly superseded: string | null
      /** The `correction` record written beside a correction, naming what was corrected. */
      readonly correction: RelationshipEntryView | null
    }
  | {
      readonly ok: false
      readonly outcome: 'refused'
      readonly entry: null
      readonly reason: string
      readonly code: string
      readonly superseded: null
      readonly correction: null
    }

/** One record as the owner's export holds it. Text included — this is the export. */
export interface RelationshipExportItemView {
  readonly entryId: string
  readonly kind: RelationshipLedgerKind
  readonly key: string
  readonly text: string
  readonly status: RelationshipLedgerStatus
  readonly sourceType: SourceTrust
  readonly confidence: Confidence
  readonly verificationStatus: EpistemicStatus
  readonly observedAt: string
  readonly recordedAt: string
  readonly admittedAt: string | null
  readonly lifecycleAt: string | null
  readonly lifecycleReason: RelationshipLifecycleReason | null
  readonly tags: readonly string[]
  /** Ids only, never content. */
  readonly evidenceRefs: readonly string[]
}

export interface RelationshipExportView {
  readonly schemaVersion: number
  readonly items: readonly RelationshipExportItemView[]
  /** How many records the ledger holds in total, whether or not they all fit the bound. */
  readonly total: number
  /** Records the bound excluded. Non-zero means this export is partial. */
  readonly withheld: number
  readonly persistence: RelationshipPersistenceView
}

export type RelationshipExportOutcome =
  | { readonly ok: true; readonly export: RelationshipExportView; readonly reason: null }
  | { readonly ok: false; readonly code: string; readonly reason: string }

/** The fixed reason a build with no relationship domain reports. */
export const NO_RELATIONSHIP_DOMAIN_REASON = 'this build has no relationship domain and none is simulated'

/** The fixed reason a window receives when no Core has started. */
export const NO_CORE_REASON = 'no Core has started yet'

export const RELATIONSHIP_SCHEMA_VERSION = 1

/** One frozen projection for a Core with no relationship domain and none simulated. */
export const ABSENT_RELATIONSHIP_PROJECTION: RelationshipProjection = Object.freeze({
  schemaVersion: RELATIONSHIP_SCHEMA_VERSION,
  mode: 'unavailable' as const,
  familiarity: 'new' as const,
  rhythm: Object.freeze({
    firstSeenAt: null,
    lastSeenAt: null,
    spanDays: 0,
    activeDays: 0,
    daysSinceLastContact: null,
  }),
  claimCeiling: 'none' as const,
  claimCeilingReason: 'insufficient-recorded-history' as const,
  conflictedKeys: Object.freeze([]),
  counts: Object.freeze({
    admitted: 0,
    candidates: 0,
    retracted: 0,
    superseded: 0,
    expired: 0,
    rejected: 0,
    evidenced: 0,
    byKind: Object.freeze({
      'interaction-pattern': 0,
      'working-rhythm': 0,
      'expressed-preference': 0,
      'shared-history': 0,
      correction: 0,
      'boundary-stated': 0,
    }),
  }),
  absence: Object.freeze({
    expressLonging: false,
    reclaimAttention: false,
    escalateStakes: false,
    stageUnchanged: true,
    reason: 'absence-is-not-a-signal' as const,
  }),
  authoredSentenceMode: 'none' as const,
  persistence: Object.freeze({
    mode: 'unavailable' as const,
    durable: false,
    degraded: false,
    reason: NO_RELATIONSHIP_DOMAIN_REASON,
  }),
})
