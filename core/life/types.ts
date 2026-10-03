import { CONFIDENCE_RANK, type Confidence } from '../brain/types'

/**
 * THE LIFE HISTORY VOCABULARY.
 *
 * Life History is a **derived** autobiographical layer. It does not hold raw
 * memory: it holds bounded, Life-authored entries that *link* to authoritative
 * evidence by stable identifier. The Brain stays the raw-memory authority; a Life
 * entry that needed a memory's text would be a second truth, and this domain
 * refuses to become one.
 *
 * Everything here is a closed vocabulary. The admission pathway assigns each
 * class; nothing is read from content and nothing is accepted from a caller.
 */

/** The shape of one remembered thing. Structure, not free text. */
export const LIFE_ENTRY_KINDS = ['episode', 'milestone', 'period', 'theme'] as const
export type LifeEntryKind = (typeof LIFE_ENTRY_KINDS)[number]

/**
 * How an entry came to exist.
 *
 * These are epistemic classes, not labels a caller may choose. The admitting
 * pathway sets the class and `capConfidence` enforces its ceiling.
 */
export const LIFE_DERIVATIONS = [
  'observed',
  'owner-stated',
  'derived',
  'inferred',
  'uncertain',
  'conflicted',
] as const
export type LifeDerivation = (typeof LIFE_DERIVATIONS)[number]

/**
 * How much an entry matters to the autobiographical thread.
 *
 * Salience is a bounded, ordered label rather than a score, because a score would
 * be a number a caller could raise. Retention reads the rank.
 */
export const LIFE_SALIENCE = ['low', 'medium', 'high', 'defining'] as const
export type LifeSalience = (typeof LIFE_SALIENCE)[number]

export const SALIENCE_RANK: Record<LifeSalience, number> = {
  low: 0,
  medium: 1,
  high: 2,
  defining: 3,
}

/**
 * The stored status of an entry.
 *
 * `conflicted` is deliberately **not** a stored status: a conflict is an edge
 * between two entries, and computing the effective status from the edge is what
 * keeps a conflict from being "resolved" by rewriting one side. A withdrawal is a
 * stored status, because it is a deliberate act with its own revision.
 */
export const LIFE_STORED_STATUSES = ['live', 'withdrawn'] as const
export type LifeStoredStatus = (typeof LIFE_STORED_STATUSES)[number]

/** The status a consumer sees, including a conflict derived from the edge table. */
export const LIFE_EFFECTIVE_STATUSES = ['live', 'conflicted', 'withdrawn'] as const
export type LifeEffectiveStatus = (typeof LIFE_EFFECTIVE_STATUSES)[number]

/** Which authoritative domain an entry or reference points at. */
export const LIFE_SOURCE_DOMAINS = [
  'brain',
  'mission',
  'work',
  'workforce',
  'conversation',
  'life',
  'owner',
  'system',
] as const
export type LifeSourceDomain = (typeof LIFE_SOURCE_DOMAINS)[number]

/** What kind of record a reference names. Ids only; never content. */
export const LIFE_REF_KINDS = [
  'entity',
  'memory',
  'experience',
  'mission',
  'run',
  'worker',
  'entry',
  'unknown',
] as const
export type LifeRefKind = (typeof LIFE_REF_KINDS)[number]

/**
 * A link to an authoritative record.
 *
 * `refId` is the stable identifier in its own domain. `label` is an optional,
 * bounded display label (for example an entity's canonical name); it is never a
 * body and is never the authority — the reference is.
 */
export interface LifeReference {
  readonly domain: LifeSourceDomain
  readonly refKind: LifeRefKind
  readonly refId: string
  readonly label: string | null
}

/**
 * Where an entry came from, in the only terms that matter for trust.
 *
 * `sourceDomain` and `sourceId` name the authoritative record, `observedAt` is
 * when the remembered thing happened (which may be unknown), `recordedAt` is when
 * Life wrote it down, and `derivation` is the epistemic class. There is no field
 * here that content can occupy.
 */
export interface LifeProvenance {
  readonly sourceDomain: LifeSourceDomain
  readonly sourceId: string | null
  readonly observedAt: string
  readonly recordedAt: string
  readonly actor: string
  readonly derivation: LifeDerivation
  readonly confidence: Confidence
}

/** One superseded revision, kept so re-consolidation is traceable. */
export interface LifeRevisionRef {
  readonly revision: number
  readonly at: string
  readonly reason: string
  /** sha256 of the superseded revision's content, so a change is provable. */
  readonly supersededContentHash: string
}

/**
 * One Life History entry.
 *
 * `title` is a bounded label, `summary` and `body` are Life-authored text, and
 * `references` are the only link to evidence. `occurredAt` is nullable on
 * purpose: when the evidence does not say when something happened, the honest
 * value is "unknown", not a fabricated date.
 */
export interface LifeEntry {
  readonly entryId: string
  readonly kind: LifeEntryKind
  readonly title: string
  readonly summary: string
  readonly body: string
  readonly status: LifeStoredStatus
  readonly salience: LifeSalience
  readonly derivation: LifeDerivation
  readonly confidence: Confidence
  readonly provenance: LifeProvenance
  readonly references: readonly LifeReference[]
  readonly occurredAt: string | null
  readonly recordedAt: string
  readonly updatedAt: string
  readonly revision: number
  readonly supersedes: string | null
  readonly lineage: readonly LifeRevisionRef[]
  readonly tags: readonly string[]
  readonly admissionReason: string
}

/**
 * A disclosed contradiction between two entries.
 *
 * An edge, not a status on either entry, so neither side can be rewritten to
 * "win". Both entries remain and both are shown as conflicted.
 */
export interface LifeConflict {
  readonly conflictId: string
  readonly entryA: string
  readonly entryB: string
  readonly reason: string
  readonly detectedAt: string
}

/** The code-owned ceilings. A host may narrow them; nothing may widen them. */
export const LIFE_LIMITS = {
  maxRecordBytes: 128 * 1024,
  maxTitleChars: 200,
  maxSummaryChars: 2_000,
  maxBodyChars: 8_000,
  maxReasonChars: 500,
  maxReferencesPerEntry: 16,
  maxReferenceLabelChars: 200,
  maxTagsPerEntry: 16,
  maxTagChars: 64,
  maxLineagePerEntry: 32,
  maxEntries: 2_000,
  maxTimelineItems: 200,
  maxConflicts: 200,
  maxRecentInProjection: 50,
} as const

/**
 * The confidence ceiling of each derivation class.
 *
 * `capConfidence` never raises a value to its ceiling, only lowers it. This table
 * is the whole of "a model may not raise confidence": a derived or inferred entry
 * can never carry more than `medium` or `low`, whatever it claims.
 */
export const DERIVATION_CEILING: Record<LifeDerivation, Confidence> = {
  observed: 'high',
  'owner-stated': 'high',
  derived: 'medium',
  inferred: 'low',
  uncertain: 'low',
  conflicted: 'low',
}

export function isLifeEntryKind(value: unknown): value is LifeEntryKind {
  return typeof value === 'string' && (LIFE_ENTRY_KINDS as readonly string[]).includes(value)
}

export function isLifeDerivation(value: unknown): value is LifeDerivation {
  return typeof value === 'string' && (LIFE_DERIVATIONS as readonly string[]).includes(value)
}

export function isLifeSalience(value: unknown): value is LifeSalience {
  return typeof value === 'string' && (LIFE_SALIENCE as readonly string[]).includes(value)
}

export function isLifeStoredStatus(value: unknown): value is LifeStoredStatus {
  return typeof value === 'string' && (LIFE_STORED_STATUSES as readonly string[]).includes(value)
}

export function isLifeSourceDomain(value: unknown): value is LifeSourceDomain {
  return typeof value === 'string' && (LIFE_SOURCE_DOMAINS as readonly string[]).includes(value)
}

export function isLifeRefKind(value: unknown): value is LifeRefKind {
  return typeof value === 'string' && (LIFE_REF_KINDS as readonly string[]).includes(value)
}

export function isConfidence(value: unknown): value is Confidence {
  return typeof value === 'string' && value in CONFIDENCE_RANK
}
