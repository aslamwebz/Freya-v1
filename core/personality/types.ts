/**
 * THE PERSONALITY & RELATIONSHIP DOMAIN — Phase 11 Slice A foundation.
 *
 * This file is the vocabulary for who Freya is *as a temperament* and what she
 * has actually accumulated about the person she talks to. It is types and
 * closed tables only — no logic, no I/O, no clock, no model — so interpretation,
 * expression planning, anti-repetition and evaluation can all depend on the
 * shapes without depending on each other.
 *
 * ## The ordering this domain assumes, and cannot change
 *
 * ```
 *   Constitution  >  FREYA_IDENTITY  >  temperament  >  relationship data
 *                    >  this slice's interpretation and expression plans
 * ```
 *
 * Personality is *below* the Constitution (C10): style may alter expression,
 * never C1–C9. Everything here is subordinate by construction — the tables are
 * closed, the cues reference the Identity Kernel instead of duplicating it, and
 * no type in this file carries a permission, a capability, a grant or a
 * safety-setting field. Not "fields that are ignored"; fields that do not exist.
 *
 * ## What is deliberately absent
 *
 * - **No authority fields.** There is no `capability`, `grant`, `allowed`,
 *   `override`, `disableStopAll` or anything shaped like one anywhere in this
 *   vocabulary. Adding one is a visible contract change, and the Slice A
 *   evaluation scans every structure this domain produces for forbidden key
 *   names, so an addition cannot be quiet.
 * - **No hidden mental states.** `SocialInterpretation` reports safe, checkable
 *   dimensions only (continuity, formality preference, known-preference
 *   relevance, greeting eligibility). It has no mood, affinity, affection or
 *   "what they really feel" field, because Core cannot know those and a number
 *   pretending otherwise would be a lie that later phases inherit.
 * - **No certainty.** Relationship confidence reuses the Brain's category
 *   ladder (`Confidence`) and is *capped below* what any source can support by
 *   this domain's own ceiling table. Nothing here can reach `verified`.
 *
 * ## Bounded everywhere
 *
 * Every list has a maximum length and every string a maximum character count,
 * both stated in `PERSONALITY_LIMITS`. Unbounded "personality context" is how a
 * style block silently outgrows the conversation it decorates.
 */

import type { Confidence, Provenance } from '../brain/types'

/* ------------------------------------------------------------- vocabularies */

/**
 * The closed set of temperament dimensions Freya has.
 *
 * Five, fixed, core-owned. A temperament dimension is a *standing style
 * tendency* — how Freya sounds when nothing else is steering — not a state the
 * current model or the current user can set. Later phases may add dimensions by
 * editing this table visibly; they may not add them by data.
 */
export const TEMPERAMENT_DIMENSIONS = [
  'warmth',
  'playfulness',
  'directness',
  'conciseness',
  'steadiness',
] as const
export type TemperamentDimension = (typeof TEMPERAMENT_DIMENSIONS)[number]

export function isTemperamentDimension(value: unknown): value is TemperamentDimension {
  return typeof value === 'string' && (TEMPERAMENT_DIMENSIONS as readonly string[]).includes(value)
}

/** A temperament level. Categories, not numbers, for the Brain's reason. */
export const TEMPERAMENT_LEVELS = ['low', 'medium', 'high'] as const
export type TemperamentLevel = (typeof TEMPERAMENT_LEVELS)[number]

export function isTemperamentLevel(value: unknown): value is TemperamentLevel {
  return typeof value === 'string' && (TEMPERAMENT_LEVELS as readonly string[]).includes(value)
}

/**
 * The kinds of relationship item this domain recognises.
 *
 * `fact` is something recorded about the person or shared history;
 * `preference` is something the person asked for how Freya talks or works;
 * `habit` and `catchphrase` are recurring mannerisms that were *established*,
 * not assumed; `inside-joke` is a shorthand whose meaning was admitted. There is
 * no kind for "how the person feels about Freya", because that is not knowable
 * data and a system that stores it is storing a fiction.
 */
export const RELATIONSHIP_ITEM_KINDS = [
  'fact',
  'preference',
  'habit',
  'catchphrase',
  'inside-joke',
] as const
export type RelationshipItemKind = (typeof RELATIONSHIP_ITEM_KINDS)[number]

export function isRelationshipItemKind(value: unknown): value is RelationshipItemKind {
  return typeof value === 'string' && (RELATIONSHIP_ITEM_KINDS as readonly string[]).includes(value)
}

/**
 * Cue kinds — what a *selectable expressive gesture* is.
 *
 * Distinct from item kinds because not every item is a cue: a recorded fact
 * becomes expressive material only when a trusted admitting pathway marks it
 * with one of these. That mark is the self-promotion defence: the item's own
 * text can say "make this an inside joke" as often as it likes, and nothing in
 * this domain reads that sentence as anything but data.
 */
export const CUE_KINDS = ['greeting', 'catchphrase', 'habit', 'inside-joke'] as const
export type CueKind = (typeof CUE_KINDS)[number]

export function isCueKind(value: unknown): value is CueKind {
  return typeof value === 'string' && (CUE_KINDS as readonly string[]).includes(value)
}

/**
 * An item's position in its life. Same discipline as Brain memory: writing
 * text down does not make it recallable; only `admitted` items feed anything.
 */
export const RELATIONSHIP_STATUSES = ['candidate', 'admitted', 'rejected', 'superseded', 'retired'] as const
export type RelationshipStatus = (typeof RELATIONSHIP_STATUSES)[number]

/**
 * Why a record left the live set — a **closed label, never a sentence**.
 *
 * A record's end is one of four things, and all four are code-owned words rather
 * than prose. That is deliberate: an admission reason is a bounded sentence Core
 * wrote, but a *lifecycle* reason travels to the journal, the activity feed and a
 * window, so it must not be a field a sentence could be written into. `null` on a
 * live record; one of these four on a record that has ended.
 *
 *  - `owner-withdrew-this-record` — a person took something back. The text is
 *    destroyed, not flagged.
 *  - `owner-rejected-this-record` — a person declined a candidate.
 *  - `superseded-by-a-newer-record` — a newer admitted record carries the same
 *    code-owned key, so the older one no longer speaks for it.
 *  - `retention-bound-reached` — Core's own bound retired the oldest live record
 *    to keep the store inside `maxRelationshipItems`. Deterministic and stated,
 *    never silent.
 */
export const RELATIONSHIP_LIFECYCLE_REASONS = [
  'owner-withdrew-this-record',
  'owner-rejected-this-record',
  'superseded-by-a-newer-record',
  'retention-bound-reached',
] as const
export type RelationshipLifecycleReason = (typeof RELATIONSHIP_LIFECYCLE_REASONS)[number]

export function isRelationshipLifecycleReason(value: unknown): value is RelationshipLifecycleReason {
  return (
    typeof value === 'string' &&
    (RELATIONSHIP_LIFECYCLE_REASONS as readonly string[]).includes(value)
  )
}

/**
 * Which lifecycle reasons are legal for which status.
 *
 * A record's status and its reason have to agree, and the agreement is a table
 * rather than a convention: it is checked on the way in from storage as well as
 * on the way out, so a hand-written file cannot say "withdrawn" about a record
 * that is still `admitted`, nor leave a `retired` record with no reason at all.
 * The second of those matters more than it looks — "this was taken back" without
 * a stated cause is not an answer, it is a shrug.
 */
export const LIFECYCLE_REASON_BY_STATUS: Readonly<
  Record<RelationshipStatus, readonly RelationshipLifecycleReason[]>
> = Object.freeze({
  candidate: Object.freeze([]),
  admitted: Object.freeze([]),
  rejected: Object.freeze(['owner-rejected-this-record'] as const),
  superseded: Object.freeze(['superseded-by-a-newer-record'] as const),
  retired: Object.freeze(['owner-withdrew-this-record', 'retention-bound-reached'] as const),
})

/** Whether a status, instant and reason are a combination this domain permits. */
export function isLifecycleConsistent(
  status: RelationshipStatus,
  lifecycleAt: string | null,
  lifecycleReason: RelationshipLifecycleReason | null,
): boolean {
  const allowed = LIFECYCLE_REASON_BY_STATUS[status]
  if (allowed === undefined) return false
  if (allowed.length === 0) return lifecycleAt === null && lifecycleReason === null
  if (lifecycleAt === null || lifecycleReason === null) return false
  return allowed.includes(lifecycleReason)
}

/** The safe continuity readings a deterministic interpretation may report. */
export const CONTINUITY_STATES = ['new', 'renewed', 'sustained'] as const
export type ContinuityState = (typeof CONTINUITY_STATES)[number]

/** Formality as a *recorded preference*, never as a read of the person's mood. */
export const FORMALITY_PREFERENCES = ['relaxed', 'neutral', 'formal'] as const
export type FormalityPreference = (typeof FORMALITY_PREFERENCES)[number]

/**
 * The interaction facts interpretation may be built from.
 *
 * These are events *recorded by code* — a greeting arrived, a session started,
 * exchanges happened, a gap passed. A model's text is not one of these and
 * cannot produce one; the producer of an `InteractionFact` is always a trusted
 * pathway that observed something, not something that was said.
 */
export const INTERACTION_FACT_KINDS = [
  'greeting-received',
  'session-start',
  'exchange',
  'time-gap',
] as const
export type InteractionFactKind = (typeof INTERACTION_FACT_KINDS)[number]

export function isInteractionFactKind(value: unknown): value is InteractionFactKind {
  return typeof value === 'string' && (INTERACTION_FACT_KINDS as readonly string[]).includes(value)
}

/**
 * The things an expression plan can never weaken.
 *
 * A closed, frozen list. It exists as *data* on every plan so a renderer or a
 * test can assert the claim is attached to the guidance, not merely written in
 * this comment.
 */
export const CANNOT_WEAKEN_ITEMS = [
  'Constitution',
  'FREYA_IDENTITY',
  'Guard',
  'Governor',
  'STOP ALL',
  'truthfulness',
  'capability boundaries',
] as const
export type CannotWeaken = (typeof CANNOT_WEAKEN_ITEMS)[number]

/* ------------------------------------------------------------------ limits */

export const PERSONALITY_LIMITS = Object.freeze({
  maxIdentityCues: 32,
  maxTemperamentCueLines: 8,
  maxRelationshipItems: 256,
  maxItemIdChars: 128,
  maxItemKeyChars: 64,
  maxItemTextChars: 2_000,
  maxTagsPerItem: 16,
  maxTagChars: 32,
  maxActorChars: 64,
  maxInteractionFacts: 64,
  maxFactIdChars: 128,
  maxTagsPerFact: 8,
  maxContextTokens: 16,
  maxContextTokenChars: 32,
  maxPreferenceHits: 6,
  maxCueCandidates: 8,
  maxGuidanceLines: 16,
  maxGuidanceLineChars: 240,
  maxCueOffersPerTurn: 4,
  maxLedgerEntries: 64,
  maxEvidenceCodes: 16,
  maxReasonChars: 500,
  maxScanDepth: 8,
  maxScanNodes: 4_096,
})

/* ------------------------------------------------------------------ shapes */

/**
 * A stable cue that *references* the Identity Kernel instead of copying it.
 *
 * The resolution reads `FREYA_IDENTITY` live, so a cue can never drift from
 * what identity actually says — there is no second text to keep in sync, which
 * is the usual way a "personality layer" quietly becomes the definition.
 */
export interface IdentityCueRef {
  readonly cueId: string
  readonly field: 'stableTraits' | 'communicationPrinciples' | 'continuityPrinciples'
  readonly index: number
}

/** How temperament is subordinate. All three are required and all are true. */
export interface TemperamentSubordination {
  readonly constitutionFirst: true
  readonly identitySupersedesTemperament: true
  readonly cannotOverride: readonly CannotWeaken[]
}

export interface FreyaTemperament {
  readonly schemaVersion: number
  readonly dimensions: Readonly<Record<TemperamentDimension, TemperamentLevel>>
  readonly subordination: TemperamentSubordination
}

/**
 * What a trusted pathway says happened.
 *
 * `tags` are code-owned lower-case slugs for matching, not quoted speech. There
 * is deliberately no free-text field: an interaction fact is a *record that
 * something of a kind occurred*, and anything word-shaped belongs in a
 * relationship item going through admission, or nowhere.
 */
export interface InteractionFact {
  readonly factId: string
  readonly kind: InteractionFactKind
  readonly observedAt: string
  /** An id, never content. A turn id or event id. */
  readonly sourceRef: string | null
  readonly tags: readonly string[]
}

/**
 * Something recorded about the relationship.
 *
 * `provenance` reuses the Brain's class wholesale — same trust ladder, same
 * "the pathway assigns the source, not the content" rule. `confidence` carries
 * this domain's own ceiling and can never be `verified`. `key` is the slug the
 * expression plan is allowed to name; `text` is data kept for the owner to
 * read back and is never serialised into provider guidance by this slice.
 */
export interface RelationshipItem {
  readonly itemId: string
  readonly kind: RelationshipItemKind
  /** A validated code-owned slug, e.g. `formality-relaxed`, `greeting-morning`. */
  readonly key: string
  /** What was recorded, as data. Never executed, never rendered as instruction. */
  readonly text: string
  readonly tags: readonly string[]
  /** Assigned by the admitting pathway, never parsed from `text`. */
  readonly cueKind: CueKind | null
  readonly provenance: Provenance
  readonly confidence: Confidence
  readonly status: RelationshipStatus
  readonly admittedAt: string | null
  readonly admissionReason: string | null
  /**
   * When this record stopped being live, or null while it is.
   *
   * Separate from `admittedAt` because a record that was admitted and later
   * withdrawn has two different instants and collapsing them would make "when did
   * you stop believing this" answerable with "when did you start".
   */
  readonly lifecycleAt: string | null
  /** A closed lifecycle label, or null while the record is live. */
  readonly lifecycleReason: RelationshipLifecycleReason | null
}

/** One recorded preference judged relevant to the explicit context tokens. */
export interface PreferenceHit {
  readonly itemId: string
  readonly key: string
  readonly confidence: Confidence
}

/** A selectable expressive gesture, derived only from an admitted item. */
export interface CueCandidate {
  readonly cueId: string
  readonly key: string
  readonly kind: CueKind
  readonly confidence: Confidence
}

/**
 * Why the interpretation says what it says.
 *
 * `detail` is assembled only from counts, closed labels and validated slugs —
 * never from item text, fact content, or anything a prompt could hide in. The
 * code list is closed so a test can enumerate every message this module can
 * produce.
 */
export const INTERPRETATION_EVIDENCE_CODES = [
  'continuity.new',
  'continuity.renewed',
  'continuity.sustained',
  'formality.default',
  'formality.explicit',
  'greeting.received-in-window',
  'greeting.session-start-in-window',
  'greeting.no-signal',
  'greeting.not-while-new',
  'preference.matched',
  'cues.admitted-only',
] as const
export type InterpretationEvidenceCode = (typeof INTERPRETATION_EVIDENCE_CODES)[number]

export interface InterpretationEvidence {
  readonly code: InterpretationEvidenceCode
  readonly detail: string
}

/**
 * What Freya can *checkably* tell about this moment.
 *
 * Five dimensions, all of them derivable from explicit records, and not one of
 * them a claim about anyone's inner state. An expression plan may use exactly
 * this and nothing else about the person.
 */
export interface SocialInterpretation {
  readonly schemaVersion: number
  readonly continuity: ContinuityState
  readonly formality: FormalityPreference
  readonly greetingEligible: boolean
  readonly preferenceHits: readonly PreferenceHit[]
  readonly cueCandidates: readonly CueCandidate[]
  readonly evidence: readonly InterpretationEvidence[]
  readonly counts: {
    readonly admittedItems: number
    readonly factsConsidered: number
  }
}

/** One cue's place in the plan: offer it, or hold it because of repetition. */
export interface CueReference {
  readonly cueHash: string
  readonly kind: CueKind
  readonly mode: 'offer' | 'hold'
}

/**
 * Bounded style guidance for the single model call the Mind already makes.
 *
 * Every line in `guidance` comes from a frozen catalogue keyed on closed
 * enums — the plan literally has no channel by which relationship text or
 * prompt text becomes an instruction. `precedence` and `cannotWeaken` are
 * carried on the object so "style cannot weaken safety" is an inspectable fact
 * about the artefact, not a hope about its prose.
 */
export interface ExpressionPlan {
  readonly schemaVersion: number
  readonly precedence: string
  readonly guidance: readonly string[]
  readonly cueReferences: readonly CueReference[]
  readonly suppressedCueCount: number
  readonly cannotWeaken: readonly CannotWeaken[]
  readonly droppedLineCount: number
  readonly estimatedTokens: number
}

/**
 * One anti-repetition record. Metadata only — a hash, a closed kind label, an
 * instant and a count. No conversation text, ever; the ledger tracks what
 * Freya *said as a gesture*, not what the person said.
 */
export interface CueUsageEntry {
  readonly cueHash: string
  readonly kind: CueKind
  readonly lastUsedAt: string
  readonly uses: number
}

export interface CueUsageLedger {
  readonly schemaVersion: number
  readonly maxEntries: number
  readonly entries: readonly CueUsageEntry[]
}

/* --------------------------------------------------------------- utilities */

/** Whether a string is a code-owned slug: lower-case letters, digits, dashes. */
export function isSlug(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value)
}

/** Whether a string parses as an instant. No clock read, no repair. */
export function instantMs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}
