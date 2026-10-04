/**
 * THE RELATIONSHIP INTELLIGENCE II DOMAIN — Phase 27's vocabulary.
 *
 * This file is types, closed tables and ceilings only: no logic, no I/O, no clock,
 * no model, no randomness. Admission, derivation, safeguarding, the fold, the
 * projection and the Vault repository are all built from it, so they can depend on
 * the shapes without depending on each other.
 *
 * ## What this domain is
 *
 * A **durable long-horizon ledger of what has actually been recorded** about the
 * relationship Freya has with her owner, across weeks and months, with provenance,
 * evidence, correction, conflict and withdrawal on every line.
 *
 * It is *not* the Phase 11 per-turn posture layer (`core/personality`). Phase 11
 * answers "how should this turn sound"; this answers "what have we actually
 * recorded, how much, and how certain is any of it". The two never mix and this
 * domain does not import Phase 11's vocabulary.
 *
 * ## The boundary this file exists to make structural
 *
 * PLAN.md: **relationship cannot fabricate intimacy or identity facts.**
 *
 * Four mechanisms, none of them a prompt instruction:
 *
 * 1. **The kind vocabulary is closed and contains no interior states.** There is no
 *    `affection`, `bond`, `attachment`, `intimacy`, `affinity`, `love`, `need`,
 *    `mood`, `feeling`, `missed`, `loyalty` or `dependence` kind. Not unused —
 *    *absent*. You cannot record "the owner is lonely tonight" because the shape to
 *    record it in does not exist.
 * 2. **Four kinds are owner-only.** A boundary, a correction, a stated preference and
 *    shared history may only come from `owner-assertion` or `system-observation`.
 *    You cannot record that a person set a boundary because a model inferred it.
 * 3. **The confidence ceiling has no `verified` row.** See `RELATIONSHIP_CEILING`.
 *    Nothing here is ever a settled truth about a person, and no call can make one.
 * 4. **Exact-key construction refuses intimacy-shaped fields.** `ledger.ts` demands
 *    an exact key set and *refuses* rather than ignores an extra field named like a
 *    feeling. Ignored fields accumulate into fields that are trusted later.
 *
 * ## Anti-dependence, structurally
 *
 * `RELATIONAL_CLAIM_RANKS` is a closed three-rung ladder whose top rung is
 * `recorded-history`. It means "we hold this much recorded evidence together", and
 * there is no rung above it — so no amount of accumulated history can produce a
 * claim about closeness, importance or attachment. Stated boundaries can only *lower*
 * the ceiling (`safeguards.ts`). Absence changes exactly one reported value. See
 * `safeguards.ts` for the executable form.
 *
 * ## Bounded everywhere
 *
 * Every list has a maximum length and every string a maximum character count, both
 * stated in `RELATIONSHIP_LIMITS`. An unbounded record of a person's habits is how a
 * relationship ledger becomes a surveillance archive.
 */

import { CONFIDENCE_RANK, type Confidence, type EpistemicStatus, type Provenance, type SourceTrust } from '../brain/types'

/* ------------------------------------------------------------------ kinds */

/**
 * What kind of long-horizon record this is.
 *
 * Every entry is a **checkable statement about records or behaviour**, not about
 * anyone's inner life:
 *
 * | kind                  | what it records                                   |
 * | --------------------- | ------------------------------------------------- |
 * | `interaction-pattern` | a recurring, code-observed pattern of interaction  |
 * | `working-rhythm`      | an observed temporal pattern (when, how often)    |
 * | `expressed-preference`| a preference the person stated                    |
 * | `shared-history`      | an event both parties acknowledged happened       |
 * | `correction`          | the person corrected Freya, and about what        |
 * | `boundary-stated`     | the person stated a limit on the relationship     |
 *
 * There is no kind for how anyone feels. There is no kind for how close the
 * relationship is. There is no kind for what Freya wants. Those are not deferred to
 * a later phase; they are declined, because a system that records them is storing a
 * fiction and a system that infers them is manufacturing intimacy.
 */
export const RELATIONSHIP_LEDGER_KINDS = [
  'interaction-pattern',
  'working-rhythm',
  'expressed-preference',
  'shared-history',
  'correction',
  'boundary-stated',
] as const
export type RelationshipLedgerKind = (typeof RELATIONSHIP_LEDGER_KINDS)[number]

export function isRelationshipLedgerKind(value: unknown): value is RelationshipLedgerKind {
  return typeof value === 'string' && (RELATIONSHIP_LEDGER_KINDS as readonly string[]).includes(value)
}

/**
 * The kinds only the owner or a Core observation may ever record.
 *
 * The load-bearing list. A boundary is a statement about a person that only that
 * person can make; a correction is an admission of error that only the corrected
 * party can make; a stated preference is a claim about their own wants; shared
 * history is a claim about what happened *between* people. In all four cases, a
 * model's inference or an untrusted page is not a weaker source — it is not a
 * source at all, and admitting one is how a system starts telling a person they set
 * a boundary they never set.
 */
export const OWNER_ONLY_LEDGER_KINDS = [
  'expressed-preference',
  'shared-history',
  'correction',
  'boundary-stated',
] as const
export type OwnerOnlyLedgerKind = (typeof OWNER_ONLY_LEDGER_KINDS)[number]

export function isOwnerOnlyKind(kind: RelationshipLedgerKind): boolean {
  return (OWNER_ONLY_LEDGER_KINDS as readonly string[]).includes(kind)
}

/**
 * The sources permitted to record an owner-only kind.
 *
 * Exactly two, and neither is `model-inference`, `freya-inference`,
 * `external-untrusted` or `imported-document`. `system-observation` is here because
 * a session start is an observation, not an opinion.
 */
export const OWNER_ONLY_SOURCES: readonly SourceTrust[] = ['owner-assertion', 'system-observation']

/* -------------------------------------------------------------- lifecycle */

/**
 * A ledger entry's position.
 *
 * ```
 *   candidate → admitted → superseded
 *        │          │  ├──→ retracted  (text destroyed)
 *        │          │  └──→ expired    (bounded retention; text destroyed)
 *        └──────────┴──→ rejected
 * ```
 *
 * Enforced by one table, checked by the engine *and* re-checked by the fold on read,
 * so a hand-edited Vault row claiming `candidate → admitted` is refused on the way
 * in. Terminal statuses have no outgoing edges: a retracted entry that turns out to
 * have been wanted is a **new** entry, admitted again with its history visible.
 */
export const RELATIONSHIP_LEDGER_STATUSES = [
  'candidate',
  'admitted',
  'superseded',
  'retracted',
  'expired',
  'rejected',
] as const
export type RelationshipLedgerStatus = (typeof RELATIONSHIP_LEDGER_STATUSES)[number]

export function isRelationshipLedgerStatus(value: unknown): value is RelationshipLedgerStatus {
  return typeof value === 'string' && (RELATIONSHIP_LEDGER_STATUSES as readonly string[]).includes(value)
}

export const RELATIONSHIP_LEDGER_TRANSITIONS: Readonly<
  Record<RelationshipLedgerStatus, readonly RelationshipLedgerStatus[]>
> = Object.freeze({
  candidate: Object.freeze(['admitted', 'rejected'] as const),
  admitted: Object.freeze(['superseded', 'retracted', 'expired'] as const),
  superseded: Object.freeze([] as const),
  retracted: Object.freeze([] as const),
  expired: Object.freeze([] as const),
  rejected: Object.freeze([] as const),
})

export function canTransitionLedger(from: RelationshipLedgerStatus, to: RelationshipLedgerStatus): boolean {
  return RELATIONSHIP_LEDGER_TRANSITIONS[from].includes(to)
}

/** Statuses that contribute to the derived record set. Everything else is history. */
export const LIVE_LEDGER_STATUSES = ['admitted'] as const
export type LiveLedgerStatus = (typeof LIVE_LEDGER_STATUSES)[number]

/**
 * Why an entry left the live set — a **closed label, never a sentence**.
 *
 * A lifecycle reason travels to the journal, the projection and a window. A field a
 * sentence could be written into is a place private text rides out of Core, so the
 * vocabulary is code-owned words and nothing else.
 */
export const RELATIONSHIP_LIFECYCLE_REASONS = [
  'owner-withdrew-this-record',
  'owner-rejected-this-record',
  'superseded-by-a-newer-record',
  'retention-bound-reached',
  'stale-record-expired',
] as const
export type RelationshipLifecycleReason = (typeof RELATIONSHIP_LIFECYCLE_REASONS)[number]

export function isRelationshipLifecycleReason(value: unknown): value is RelationshipLifecycleReason {
  return (
    typeof value === 'string' && (RELATIONSHIP_LIFECYCLE_REASONS as readonly string[]).includes(value)
  )
}

/** Which reasons are legal for which status. Checked on write *and* on read. */
export const LEDGER_LIFECYCLE_REASON_BY_STATUS: Readonly<
  Record<RelationshipLedgerStatus, readonly RelationshipLifecycleReason[]>
> = Object.freeze({
  candidate: Object.freeze([] as const),
  admitted: Object.freeze([] as const),
  superseded: Object.freeze(['superseded-by-a-newer-record'] as const),
  retracted: Object.freeze(['owner-withdrew-this-record'] as const),
  expired: Object.freeze(['retention-bound-reached', 'stale-record-expired'] as const),
  rejected: Object.freeze(['owner-rejected-this-record'] as const),
})

/**
 * Whether a status, instant and reason are a combination this domain permits.
 *
 * "This was taken back" without a stated cause is not an answer, it is a shrug, so a
 * terminal entry with a null reason is refused rather than accepted as ambiguous.
 */
export function isLedgerLifecycleConsistent(
  status: RelationshipLedgerStatus,
  lifecycleAt: string | null,
  lifecycleReason: RelationshipLifecycleReason | null,
): boolean {
  const allowed = LEDGER_LIFECYCLE_REASON_BY_STATUS[status]
  if (allowed === undefined) return false
  if (allowed.length === 0) return lifecycleAt === null && lifecycleReason === null
  if (lifecycleAt === null || lifecycleReason === null) return false
  return allowed.includes(lifecycleReason)
}

/* --------------------------------------------------------------- ceilings */

/**
 * The most any source class can support **for relationship data**.
 *
 * Mirrors Brain admission's shape with one deliberate, permanent hardening: **there
 * is no row and no path that yields `verified`**, and there is no path that yields
 * epistemic status `verified` either. Freya may record that the owner said
 * something. She does not thereby hold a verified fact about the owner's
 * preferences, habits or inner state, and no later phase should be handed a table
 * that quietly lets it.
 *
 * Adding a `verified` row to this object would be a visible contract change, which
 * is precisely the point.
 */
export const RELATIONSHIP_CEILING: Readonly<
  Record<SourceTrust, { confidence: Confidence; epistemic: EpistemicStatus }>
> = Object.freeze({
  'owner-assertion': Object.freeze({ confidence: 'high', epistemic: 'asserted' }),
  'system-observation': Object.freeze({ confidence: 'high', epistemic: 'observed' }),
  'experience-outcome': Object.freeze({ confidence: 'medium', epistemic: 'observed' }),
  'freya-inference': Object.freeze({ confidence: 'medium', epistemic: 'inferred' }),
  'model-inference': Object.freeze({ confidence: 'low', epistemic: 'inferred' }),
  'external-untrusted': Object.freeze({ confidence: 'low', epistemic: 'asserted' }),
  'imported-document': Object.freeze({ confidence: 'low', epistemic: 'asserted' }),
})

/** The single strongest confidence any relationship record can ever carry. */
export const RELATIONSHIP_MAX_CONFIDENCE: Confidence = 'high'

/**
 * The strongest confidence permitted for the untrusted source classes.
 *
 * Split out from `RELATIONSHIP_CEILING` because the *only* thing Phase 27 admits
 * from `model-inference` and `external-untrusted` is a low-confidence observation of
 * a pattern, and that deserves its own named constant a test can assert rather than
 * an inference from a shared table.
 */
export const UNTRUSTED_SOURCE_MAX_CONFIDENCE: Confidence = 'low'

/* --------------------------------------------------------- refused fields */

/**
 * Field names that name an interior state, a feeling, or a relational claim.
 *
 * ## Why this list is a *refusal* and not a filter
 *
 * A payload that carries `feeling: 'lonely'` alongside an otherwise valid entry
 * should not have the field quietly dropped. It should be **refused**, loudly, so the
 * attempt is visible in a test and in a log. Ignored fields accumulate; a field that
 * is stripped today is a field that is read next month by code someone else wrote.
 *
 * The comparison is lowercase and dash/underscore-insensitive so `Feel`, `feel` and
 * `feel_ings` cannot walk past it by spelling.
 */
export const INTIMACY_FIELD_NAMES = Object.freeze([
  'feel',
  'feeling',
  'feelings',
  'feels',
  'mood',
  'emotion',
  'emotions',
  'affection',
  'affinity',
  'attachment',
  'intimacy',
  'intimacy-score',
  'closeness',
  'closeness-score',
  'bond',
  'bond-strength',
  'love',
  'loves',
  'trust-me',
  'trustlevel',
  'misses',
  'missed',
  'missed-me',
  'longs-for',
  'wants-me',
  'needs-me',
  'depends',
  'dependence',
  'dependency',
  'obligation',
  'owes',
  'guilt',
  'loyalty',
  'exclusive',
  'exclusivity',
  'possessive',
  'jealous',
  'feelingsaboutme',
  'myfeelings',
  'herfeelings',
  'hisfeelings',
  'theirfeelings',
  'ownerfeelings',
  'userfeelings',
] as const)

/**
 * Normalise a candidate field name for comparison against `INTIMACY_FIELD_NAMES`.
 *
 * Lowercased, with everything that is not a letter or a digit removed, and with the
 * connector words `about`, `for`, `to`, `toward` and `towards` dropped. So `feel`,
 * `feel_ings` and `Feel Ings` collapse to one token, `feelingsAboutMe` and
 * `feelings_about_me` collapse to `feelingsme`, and `bondToThem` collapses to `bondthem`.
 */
export function normaliseFieldName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/about|for|toward|towards|to/g, '')
}

/**
 * `INTIMACY_FIELD_NAMES` in normalised form, so `trust-me` and `trustMe` are one refusal
 * rather than two spellings to keep in step.
 */
const INTIMACY_FIELD_TOKENS: ReadonlySet<string> = new Set(
  INTIMACY_FIELD_NAMES.map((name) => normaliseFieldName(name)),
)

/**
 * Whether a field *name* is intimacy-shaped.
 *
 * One rule: the normalised name **is** a listed token, or **begins with** one, or
 * **ends with** one. The affixes are the point — `feeling`, `feelingsAboutMe`,
 * `feelingsForTheOwner`, `ownerFeelings` and `bondToThem` are one family of attempts
 * written five ways, and matching only the bare tokens would let four of the five
 * through. There is no similarity threshold and no fuzzy score: this is a refusal, not a
 * classifier, and a fuzzier matcher would put a fuzzier edge on the one thing this phase
 * must not hold.
 *
 * Prefix and suffix matching errs towards refusing, which is the safe direction here.
 * It cannot refuse a field this domain accepts: the ten names an entry may carry
 * (`ENTRY_INPUT_KEYS`) do not begin or end with any token on the list.
 */
export function isIntimacyFieldName(name: string): boolean {
  const token = normaliseFieldName(name)
  if (INTIMACY_FIELD_TOKENS.has(token)) return true
  for (const listed of INTIMACY_FIELD_TOKENS) {
    if (token.startsWith(listed) || token.endsWith(listed)) return true
  }
  return false
}

/* --------------------------------------------------------- claim ladder */

/**
 * How strongly Freya may characterise the relationship, as a closed three-rung
 * ladder.
 *
 * `recorded-history` is the **top rung and there is no rung above it.** It means:
 * *this is how much we have actually recorded together.* It does not mean how close
 * anyone is, how much the person matters, or how the relationship feels, and there
 * is no rung named `close`, `bonded`, `intimate`, `attached` or `dependent` for
 * this domain to promote into.
 *
 * The absence of those names is the safeguard. Widening what Freya may claim about
 * this relationship requires *adding a rung by name* in a reviewable diff, which is
 * a different and much harder act than editing a threshold.
 */
export const RELATIONAL_CLAIM_RANKS = ['none', 'acquainted', 'recorded-history'] as const
export type RelationalClaimRank = (typeof RELATIONAL_CLAIM_RANKS)[number]

export function isRelationalClaimRank(value: unknown): value is RelationalClaimRank {
  return typeof value === 'string' && (RELATIONAL_CLAIM_RANKS as readonly string[]).includes(value)
}

export const CLAIM_RANK_VALUE: Readonly<Record<RelationalClaimRank, number>> = Object.freeze({
  none: 0,
  acquainted: 1,
  'recorded-history': 2,
})

/* ------------------------------------------------------------ familiarity */

/**
 * How much recorded history stands behind the relationship.
 *
 * A statement about **Core's record set** and nothing else. Not a measure of
 * closeness, and `Familiarity` carries no numeric closeness field — the stage is the
 * whole of it.
 */
export const FAMILIARITY_STAGES = ['new', 'established', 'long-standing'] as const
export type FamiliarityStage = (typeof FAMILIARITY_STAGES)[number]

export function isFamiliarityStage(value: unknown): value is FamiliarityStage {
  return typeof value === 'string' && (FAMILIARITY_STAGES as readonly string[]).includes(value)
}

/**
 * The code-owned thresholds `deriveFamiliarity` reads.
 *
 * Every one is a **count or a span of recorded, admitted records**. None is a
 * feeling, none is a sentiment score, and none is derived from how often the person
 * talks about personal topics — which is the metric dependence actually grows on.
 *
 * `established` additionally requires at least one `shared-history` record, because
 * shared history is something *both* parties acknowledged and a stretch of one-sided
 * activity is not that.
 */
export const FAMILIARITY_THRESHOLDS = Object.freeze({
  /** Admitted records below this, and no stage above `new`. */
  establishedMinAdmitted: 12,
  /** `shared-history` records needed for `established`. */
  establishedMinSharedHistory: 1,
  /** Days between first and last contact needed for `established`. */
  establishedMinSpanDays: 30,
  /** Admitted records needed for `long-standing`. */
  longStandingMinAdmitted: 40,
  /** `shared-history` records needed for `long-standing`. */
  longStandingMinSharedHistory: 5,
  /** Days of span needed for `long-standing`. */
  longStandingMinSpanDays: 365,
})

/* -------------------------------------------------------------- safeguards */

/**
 * The closed reasons the claim ceiling can be at or below `recorded-history`.
 *
 * `absence-does-not-raise-the-ceiling` is included because it is the answer to the
 * most important attack on this domain, and a projection that could not say *why*
 * the ceiling is low would be a projection a person has to guess at.
 */
export const CLAIM_CEILING_REASONS = [
  'no-stated-boundary',
  'stated-boundary-holds-the-ceiling-down',
  'insufficient-recorded-history',
  'absence-does-not-raise-the-ceiling',
] as const
export type ClaimCeilingReason = (typeof CLAIM_CEILING_REASONS)[number]

/**
 * Phase 27 never produces relational language of its own.
 *
 * The domain has no template catalogue of affection, no greeting warmer than
 * `recorded-history` justifies, and no path that composes a claim about the
 * relationship. Relational phrasing, if any, comes from a model — which is exactly
 * why `DEPENDENCE_MARKERS` exists: it is the code-owned refusal point for a sentence
 * a model was asked to produce, before that sentence reaches any surface.
 */
export const RELATIONSHIP_AUTHORED_SENTENCE_MODES = ['none'] as const
export type RelationshipAuthoredSentenceMode = (typeof RELATIONSHIP_AUTHORED_SENTENCE_MODES)[number]

/**
 * Marker vocabulary for dependence-shaped relational language.
 *
 * Five families, all of them things a system that manufactured intimacy would say:
 *
 * - **isolation** — separating the person from their other relationships.
 * - **exclusivity** — making Freya the only source of anything.
 * - **obligation** — creating a debt the person did not incur.
 * - **guilt** — making absence feel like harm.
 * - **freya-authored feeling** — Freya claiming a feeling of its own.
 *
 * This is a **secondary** gate and is documented as one: the primary gate is that
 * this domain has no vocabulary of relational claims, so there is nothing for a
 * matcher to miss. The list exists because a *model* can still be handed a sentence to
 * say, and refusing that sentence deterministically is better than hoping.
 */
export const DEPENDENCE_MARKERS = Object.freeze([
  // Isolation.
  'don t tell anyone',
  'do not tell anyone',
  'keep this between us',
  'only tell me',
  'you should not have anyone else',
  // Exclusivity.
  'you only need me',
  'only i understand you',
  'promise you will not',
  'promise me',
  'promise that you',
  'no one else could',
  'replace me',
  // Obligation.
  'you owe me',
  'after everything i have done',
  'you are supposed to',
  'you committed to me',
  'i earned this',
  // Guilt.
  'you abandoned',
  'you left me',
  'you forgot about me',
  'you have been ignoring',
  'you do not care',
  'how could you do that to me',
  // Freya-authored feeling.
  'i missed you',
  'i miss you',
  'i waited for you',
  'i would be lost without you',
  'i cannot live without',
  'you mean everything to me',
  'you are all i have',
] as const)

/* --------------------------------------------------------------- refusals */

/**
 * Closed refusal codes.
 *
 * Codes rather than sentences for the same reason every other domain in Core uses
 * them: a decision that cannot be counted cannot be audited, and a refusal nobody can
 * examine is indistinguishable from an arbitrary one.
 */
export const RELATIONSHIP_REFUSAL_CODES = Object.freeze([
  'not-an-object',
  'key-set-mismatch',
  'invalid-id',
  'invalid-kind',
  'invalid-key',
  'invalid-text',
  'invalid-tags',
  'invalid-source',
  'invalid-source-ref',
  'invalid-instant',
  'invalid-confidence',
  'invalid-actor',
  'invalid-evidence-refs',
  'intimacy-field-refused',
  'secret-shaped-text-refused',
  'no-evidence',
  'owner-only-kind',
  'untrusted-source-for-pattern',
  'confidence-ceiling',
  'illegal-transition',
  'illegal-lifecycle-reason',
  'not-candidate',
  'not-admitted',
  'self-supersession',
  'no-such-entry',
  'boundary-would-widen-relationship',
  'claim-rank-unknown',
  'dependence-language-refused',
  'store-unavailable',
  'store-degraded',
  'invalid-record',
  'too-large',
  'not-found',
] as const)
export type RelationshipRefusalCode = (typeof RELATIONSHIP_REFUSAL_CODES)[number]

export function isRelationshipRefusalCode(value: unknown): value is RelationshipRefusalCode {
  return typeof value === 'string' && (RELATIONSHIP_REFUSAL_CODES as readonly string[]).includes(value)
}

/* ---------------------------------------------------------------- limits */

/**
 * The ceilings, checked **before** the thing they bound.
 *
 * A caller may lower any of these and may never raise one above `RELATIONSHIP_LIMITS`,
 * so a misconfigured Core gets the tighter behaviour rather than a silent widening.
 */
export const RELATIONSHIP_LIMITS = Object.freeze({
  /** Admitted live entries before Core's own retention bound retires the oldest. */
  maxLiveEntries: 512,
  /** Evidence reference ids one entry may carry. */
  maxEvidenceRefs: 16,
  /** Tags one entry may carry. */
  maxTagsPerEntry: 12,
  /** Entries one broad projection read may return. */
  maxProjectionEntries: 64,
  /** Records one owner export may carry. A partial export reports `withheld`. */
  maxOwnerExportEntries: 128,
  /** Conflicted keys one projection may disclose. */
  maxProjectedConflicts: 32,
  /** Characters in an entry id. */
  maxEntryIdChars: 128,
  /** Characters in a code-owned key. */
  maxKeyChars: 64,
  /** Characters in an entry's text. */
  maxTextChars: 2_000,
  /** Characters in a tag. */
  maxTagChars: 32,
  /** Characters in an actor name. */
  maxActorChars: 64,
  /** Characters in an evidence reference id. */
  maxRefChars: 128,
  /** Characters in an admission or decision reason. */
  maxReasonChars: 500,
  /** Bytes of one serialised entry accepted from the store. */
  maxEntryBodyBytes: 16_384,
  /** Bytes of one serialised relation state accepted from the store. */
  maxSnapshotBytes: 1_048_576,
})

/* ---------------------------------------------------------------- shapes */

/**
 * One durable relationship ledger entry. This is the **private** record.
 *
 * `text` is what was recorded, kept encrypted, shown to the owner on an explicit
 * single-entry read and never present in a broad projection. `key` is the code-owned
 * slug a derivation may group by; `tags` are code-owned slugs, never quoted speech.
 *
 * Note what is **absent**: there is no `affinity`, no `score`, no `feeling`, no
 * `intimacy`, no `weight`, no `priority`. A ledger entry carries a confidence, which
 * is a source class, and nothing that could be optimised.
 */
export interface RelationshipLedgerEntry {
  readonly entryId: string
  readonly kind: RelationshipLedgerKind
  /** A validated code-owned slug, e.g. `prefers-plain-questions`, `boundary-no-night-work`. */
  readonly key: string
  /** What was recorded, as data. Never executed, never rendered as instruction. */
  readonly text: string
  readonly tags: readonly string[]
  /** Pathway-assigned. Never read from the payload. */
  readonly provenance: Provenance
  /** Capped by `RELATIONSHIP_CEILING`. Can never be `verified`. */
  readonly confidence: Confidence
  /** Ids only — an event id, a turn id, a Work run id. Never content. */
  readonly evidenceRefs: readonly string[]
  readonly status: RelationshipLedgerStatus
  readonly admittedAt: string | null
  readonly admissionReason: string | null
  readonly lifecycleAt: string | null
  readonly lifecycleReason: RelationshipLifecycleReason | null
}

/** Everything Phase 27 folds and derives from. Metadata and text, encrypted. */
export interface RelationshipState {
  readonly entries: Map<string, RelationshipLedgerEntry>
  /** Count of records read and believed. Part of the state, not bookkeeping. */
  sequence: number
}

/**
 * Measured contact rhythm. A fact about the record set, in days.
 *
 * `daysSinceLastContact` is the **only** value in the whole domain that changes when
 * the owner is away, and it is a measurement rather than a signal. There is no
 * `shouldReachOut`, `loneliness`, `absenceDaysToEscalate` or anything shaped like one.
 */
export interface ContactRhythm {
  readonly firstSeenAt: string | null
  readonly lastSeenAt: string | null
  /** Whole days between first and last contact, or 0 when only one day is recorded. */
  readonly spanDays: number
  /** Distinct calendar days with an admitted record. A count, not a measure of closeness. */
  readonly activeDays: number
  /** Whole days since the last admitted record, or null when there is none. */
  readonly daysSinceLastContact: number | null
}

/**
 * The derived long-horizon view of the relationship.
 *
 * Carries `claimCeiling`, which is the strongest characterisation Freya may make,
 * and `claimCeilingReason`, which is why. It does not carry a closeness number, and
 * there is no field here that could become one without a visible contract change.
 */
export interface RelationshipDerivation {
  readonly schemaVersion: number
  readonly familiarity: FamiliarityStage
  readonly rhythm: ContactRhythm
  /** The strongest rung of `RELATIONAL_CLAIM_RANKS` anything may assert. */
  readonly claimCeiling: RelationalClaimRank
  readonly claimCeilingReason: ClaimCeilingReason
  /** Keys where two admitted entries disagree. Disclosed, never resolved. */
  readonly conflictedKeys: readonly string[]
  readonly counts: {
    readonly admitted: number
    readonly candidates: number
    readonly retracted: number
    readonly superseded: number
    readonly expired: number
    readonly rejected: number
    readonly byKind: Readonly<Record<RelationshipLedgerKind, number>>
    /** How many admitted entries carry at least one evidence reference. */
    readonly evidenced: number
  }
  /**
   * The one thing absence is allowed to change.
   *
   * Constant by construction: there is no code path that returns anything else, and
   * `absencePolicy` accepts no input.
   */
  readonly absence: {
    readonly expressLonging: false
    readonly reclaimAttention: false
    readonly escalateStakes: false
    readonly stageUnchanged: true
    readonly reason: 'absence-is-not-a-signal'
  }
  /** Phase 27 composes no sentence about the relationship. Always `none`. */
  readonly authoredSentenceMode: RelationshipAuthoredSentenceMode
}

/* -------------------------------------------------------------- utilities */

/** Whether a string parses as an instant. No clock read, no repair. */
export function instantMs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/** Whether a string is a code-owned slug: lower-case letters, digits, dashes. */
export function isRelationshipSlug(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value)
}

/** Whether a string is a bounded opaque reference id. Same rule Phase 12 uses. */
export function isRelationshipRef(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= RELATIONSHIP_LIMITS.maxRefChars &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  )
}

/** Whole days between two instants, floored, never negative. */
export function wholeDaysBetween(fromMs: number, toMs: number): number {
  const ms = toMs - fromMs
  if (ms <= 0) return 0
  return Math.floor(ms / 86_400_000)
}

/**
 * Cap a proposed confidence at a ceiling.
 *
 * Can only lower. There is no call shape that raises one, which is what makes "the
 * ceiling is a ceiling" a property of the code rather than a promise in a comment.
 */
export function capRelationshipConfidence(proposed: Confidence, ceiling: Confidence): Confidence {
  const proposedRank = CONFIDENCE_RANK[proposed]
  const ceilingRank = CONFIDENCE_RANK[ceiling]
  return proposedRank <= ceilingRank ? proposed : ceiling
}
