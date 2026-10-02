/**
 * The Personality & Relationship protocol: everything a window may know about
 * who Freya is *as a temperament* and what she has actually recorded about the
 * person she talks to.
 *
 * This file is a **view**, not a channel. It carries three things and nothing
 * else: the read-only shapes a renderer is typed against, one frozen projection
 * for a Core that has no Personality domain, and the read-only seam a source
 * plugs into. Nothing here is writable, and there is deliberately no command in
 * this vocabulary — a window may *receive* personality and may *pull* the
 * projection Core last built, and it may not name an item, assert a provenance,
 * record a habit, file an inside joke, choose a cue, or tell Core how much it
 * trusts any of it.
 *
 * ## Why there is no command at all
 *
 * Workforce grew one payloadless read (`workforce.status.read`); Context grew
 * none. This lane follows Context, and the reason is sharper here than there:
 * a *write* verb is not what would make personality dangerous, a **claim**
 * verb is. Relationship truth is exactly the kind of fact a caller would most
 * like to supply — "the owner prefers this", "we have an inside joke about
 * that" — and the door that takes no payload cannot be tempted. The two
 * functions on the bridge are a pull and a subscription, both arguments-free,
 * so there is no field for a compromised window to reach for even in principle.
 *
 * ## What crosses, and what pointedly does not
 *
 * Crosses: temperament levels and their subordination claims, item *metadata*
 * (id, kind, code-owned key, status, cue kind, source class, confidence,
 * admitted instant), deterministic interpretation of safe dimensions,
 * expression-plan counts, anti-repetition ledger *counts*, and at most one
 * bounded cue for Presence to draw.
 *
 * Does not cross: `text` (what was recorded about the person stays in Core),
 * `tags`, `admissionReason`, any provenance sentence, the expression plan's
 * `guidance` (that is model-facing text), any ledger entry's instants en masse,
 * any key or storage path, and — because none exists in this vocabulary — any
 * permission, capability, grant, trust decision or mental state. A window reads
 * a report about a relationship; it cannot hold the relationship's content, and
 * it certainly cannot author one.
 *
 * ## The two absences, kept apart
 *
 * `'unavailable'` with `NO_PERSONALITY_DOMAIN_REASON` means *this build has no
 * Personality domain and none is simulated*. `null` from the host means *no
 * Core has started yet*. Rendering the first as an empty relationship would be
 * showing a person a social life Freya does not have; rendering the second as
 * the first would blame a build for a window that opened early.
 */

import type {
  CannotWeaken,
  ContinuityState,
  CueKind,
  FormalityPreference,
  RelationshipItemKind,
  RelationshipStatus,
  TemperamentDimension,
  TemperamentLevel,
} from '../personality/types'
import type { Confidence, SourceTrust } from '../brain/types'

/* ----------------------------------------------------------------- views */

/**
 * One temperament dimension, as Core reports it.
 *
 * Closed at both ends — the dimension name and the level are Slice A's frozen
 * vocabularies, not strings this lane invents — because a temperament row a
 * renderer could spell differently would be a second, quietly divergent
 * definition of who Freya is.
 */
export interface PersonalityTemperamentDimensionView {
  readonly dimension: TemperamentDimension
  readonly level: TemperamentLevel
}

/**
 * The standing style tendency, and the claim that it is subordinate.
 *
 * `constitutionFirst`, `identitySupersedesTemperament` and `cannotWeaken` are
 * carried on the projection rather than implied by documentation, so "style
 * cannot weaken safety" is an inspectable fact about what a window received —
 * the same device the expression plan uses for the same reason.
 */
export interface PersonalityTemperamentView {
  readonly schemaVersion: number
  readonly dimensions: readonly PersonalityTemperamentDimensionView[]
  readonly constitutionFirst: true
  readonly identitySupersedesTemperament: true
  readonly cannotWeaken: readonly CannotWeaken[]
}

/**
 * One recorded relationship item, as metadata.
 *
 * Note the absences, which are the point of this type. There is no `text` —
 * what was recorded about the person is Core's to hold and a standing feed of
 * it would put private history wherever a window caches. There is no
 * `admissionReason` and no `tags`, both of which are word-shaped and could
 * carry a sentence. There is no provenance *sentence*: `sourceType` is the
 * class Core assigned, printed verbatim, which is what a person needs in order
 * to weigh the record without the record arguing for itself.
 *
 * `confidence` is Core's word and this domain's ceiling means it can never be
 * `verified` — a relationship record is a note about an exchange, never a
 * settled truth about a person.
 */
export interface PersonalityRelationshipItemView {
  /** Core's identifier. Never minted by a window. */
  readonly itemId: string
  readonly kind: RelationshipItemKind
  /** A validated code-owned slug. Display only; never parsed, never executed. */
  readonly key: string
  readonly status: RelationshipStatus
  readonly cueKind: CueKind | null
  /** Where Core says the record came from. Shown, never filed. */
  readonly sourceType: SourceTrust
  readonly confidence: Confidence
  readonly admittedAt: string | null
}

/**
 * The safe, checkable dimensions of the current moment, as Core computed them.
 *
 * Five fields, none of them a claim about anyone's inner state — this is
 * Slice A's `SocialInterpretation` minus the *evidence detail strings* and the
 * candidate lists, which are Core's debugging vocabulary rather than a
 * window's. A renderer displays these; it does not derive them, and there is
 * no field here it could derive them from.
 */
export interface PersonalityInterpretationView {
  readonly schemaVersion: number
  readonly continuity: ContinuityState
  readonly formality: FormalityPreference
  readonly greetingEligible: boolean
  readonly admittedItems: number
  readonly factsConsidered: number
  readonly preferenceHits: number
}

/**
 * What the expression plan was, in counts.
 *
 * The plan's `guidance` lines deliberately do not cross: they are bounded
 * style text addressed to a model, and a renderer that held them would be one
 * step from re-authoring them. What crosses is the plan's *shape* — how many
 * cues it offered, how many anti-repetition suppressed, its token estimate —
 * plus the `cannotWeaken` claim it carries as data.
 */
export interface PersonalityExpressionView {
  readonly cuesOffered: number
  readonly cuesHeld: number
  readonly suppressedCueCount: number
  readonly estimatedTokens: number
  readonly cannotWeaken: readonly CannotWeaken[]
}

/**
 * The one cue Presence may express right now.
 *
 * Bounded to a single object by construction: `PersonalityProjection` has one
 * `presenceCue` slot, so there is no list of gestures for a renderer to grow,
 * reorder or synthesise. `cueId` is a hash — a stable identifier Core chose —
 * and never the words of the cue, so drawing this is drawing a *label* rather
 * than reproducing recorded content. `mode` arrives from Core and a held cue
 * is never offered as expression, because suppressing a gesture and then
 * showing it anyway would defeat the anti-repetition ledger it was held for.
 */
export interface PersonalityCueView {
  readonly cueId: string
  readonly kind: CueKind
  readonly mode: 'offer' | 'hold'
}

/**
 * Counts derived by the domain that owns the records, not by whoever renders.
 *
 * `dropped` is the honest remainder: records this projection refused to shape
 * (an impossible status, a `verified` confidence, a key that is not a slug).
 * They are counted rather than hidden, because a projection that silently
 * swallowed a malformed record would be a projection whose numbers could not
 * be checked against the store they came from.
 */
export interface PersonalityCounts {
  readonly items: number
  readonly admitted: number
  readonly candidate: number
  readonly rejected: number
  readonly superseded: number
  readonly cuesAdmitted: number
  readonly dropped: number
}

/** The ceilings this projection was built under, so a window can show them. */
export interface PersonalityLimits {
  readonly maxRelationshipItems: number
  readonly maxCueOffersPerTurn: number
  readonly maxLedgerEntries: number
}

/**
 * Everything a window may know about personality and relationship, in one
 * read-only object.
 *
 * A mirror, in the same sense as Workforce's and Context's: Core builds it, a
 * window holds what Core last sent, and nothing a window can do writes a field
 * of it. `sequence` exists so a window can prove *which* Core state it is
 * looking at instead of trusting that the push it received was the newest, and
 * `health` is the first thing to read for the reason every other subsystem
 * gives: `'unavailable'` is not `'ready'` with an empty list.
 */
export interface PersonalityProjection {
  readonly health: 'ready' | 'unavailable'
  /** Why, in words a person can act on. Null when healthy. */
  readonly reason: string | null
  readonly schemaVersion: number
  /** Highest sequence folded in, so a window can prove it is current. */
  readonly sequence: number
  /** Null when Core reports no temperament table, never a synthesised one. */
  readonly temperament: PersonalityTemperamentView | null
  readonly items: readonly PersonalityRelationshipItemView[]
  readonly counts: PersonalityCounts
  /** Null when Core has not interpreted this moment — never a default mood. */
  readonly interpretation: PersonalityInterpretationView | null
  readonly expression: PersonalityExpressionView | null
  /** Ledger *counts* only. Entries are metadata about gestures, not content. */
  readonly repetition: { readonly entries: number; readonly maxEntries: number } | null
  readonly presenceCue: PersonalityCueView | null
  readonly limits: PersonalityLimits
}

/* ------------------------------------------------------------- read-back */

/**
 * Whether a Personality pull got an answer, in this vocabulary.
 *
 * Two operations because there are two facts: Core answered, or the answer
 * could not be had. The pull itself is argument-free by construction — there is
 * no field this outcome could have been *asked* with — so the only thing it
 * reports is whether the projection arrived, and if not, why in words.
 */
export type PersonalityOperation = 'status' | 'refused'

export interface PersonalityReadOutcome {
  readonly operation: PersonalityOperation
  readonly ok: boolean
  /** Why the answer could not be had, in words. Never evidence, never a stack. */
  readonly reason?: string
}

/* ------------------------------------------------------------------ seam */

/**
 * A seam for reading a `PersonalityProjection` that Core itself did not build.
 *
 * A source can be *read*, and that is the entire interface: no mutable state,
 * no store handle, no admission function, no authority object, and no method
 * that takes an instruction. It mirrors `WorkforceSource` and `ContextSource`
 * so all three domains plug into a reader the same way.
 *
 * Nothing outside Core can reach a source. The renderer has no function that
 * names one, and the host merely forwards a source *into* Core at construction
 * the same way it forwards a provider set or a workforce reader — authority is
 * not something a construction argument can carry, and relationship rules would
 * not live in the host if they existed anywhere.
 */
export interface PersonalitySource {
  /** The current view. Called by Core; never by a renderer. */
  projection(): PersonalityProjection
  /** Follow changes. Returns a disposer. Absent means "read again later". */
  subscribe?(listener: (projection: PersonalityProjection) => void): () => void
}

/* --------------------------------------------------------------- absent */

/**
 * A valid projection for a Core that has no Personality domain.
 *
 * `unavailable`, never `ready` with an empty list: "Freya has recorded nothing
 * about you" and "this build records nothing about anyone" are different facts,
 * and a surface that rendered the second as the first would be showing a
 * person an intimacy that does not exist. Every list is empty, every count is
 * zero because nobody counted, and `reason` says so in words.
 */
export const ABSENT_PERSONALITY_PROJECTION: PersonalityProjection = Object.freeze({
  health: 'unavailable' as const,
  reason: 'Core has not reported a Personality yet',
  schemaVersion: 1,
  sequence: 0,
  temperament: null,
  items: Object.freeze([]) as readonly PersonalityRelationshipItemView[],
  counts: Object.freeze({
    items: 0,
    admitted: 0,
    candidate: 0,
    rejected: 0,
    superseded: 0,
    cuesAdmitted: 0,
    dropped: 0,
  }),
  interpretation: null,
  expression: null,
  repetition: null,
  presenceCue: null,
  limits: Object.freeze({
    maxRelationshipItems: 0,
    maxCueOffersPerTurn: 0,
    maxLedgerEntries: 0,
  }),
})

/**
 * The sentence Core reports when nothing has filled the seam.
 *
 * Exported so the host, the surface and the tests quote the same words instead
 * of paraphrasing the absence into four slightly different claims about a
 * domain this build does not have.
 */
export const NO_PERSONALITY_DOMAIN_REASON =
  'this Core has no Personality domain: no relationship record exists, and none is simulated'

/**
 * The projection schema this lane speaks.
 *
 * Stated once here so Core's builder, the absent projection and any test that
 * builds a fixture all agree on the version a window is reading.
 */
export const PERSONALITY_SCHEMA_VERSION = 1
