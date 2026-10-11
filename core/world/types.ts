import type { Confidence, EpistemicStatus, Sensitivity, SourceTrust } from '../brain/types'
import type { PrincipalId } from '../../shared/contracts/identity'

/**
 * THE SELF & WORLD MODEL — Phase 22's vocabulary.
 *
 * This file is types and closed tables only: no logic, no I/O, no clock, no
 * provider. Everything the world model believes has a shape here before it has
 * anywhere to be stored, which is what makes "a claim is not a fact" a property
 * of the type rather than a rule somebody has to remember.
 *
 * ## What is deliberately absent
 *
 * - **No authority, in any field.** There is no `authority`, `capability`,
 *   `permission`, `grant` or `trust` field anywhere in this file. A capability
 *   *name* cannot be expressed as a relation either: `RELATION_TYPES` has no
 *   `has_capability` and never will, and `normaliseWorldName` refuses a name that
 *   is a capability or looks like one. Guard never reads this module, so holding
 *   an entity or an edge says nothing about what may be done with it (C3).
 * - **No raw content.** Every field is an id, a closed label, an instant, a
 *   count or a measured length — except a canonical name, which a graph cannot be
 *   drawn without. Attribute *values* and provenance summaries are stored and are
 *   projected as lengths, never as text.
 * - **No clock.** Freshness is computed from a record's own instants against an
 *   instant the caller supplies. Nothing in this module reads the wall clock.
 * - **No copies of other domains' state.** A `mission` entity is a *reference*:
 *   an id and whatever the Mission domain says its status is, read fresh. Its
 *   title, intent and success criteria live in the Mission's own encrypted store
 *   and this module has no business touching them.
 */

/* ------------------------------------------------------------------ limits */

/**
 * Code-owned ceilings. Every one may be *lowered* by a caller and never raised.
 *
 * These are not tuning knobs. Each one is a promise about what a person can look
 * at: a graph of 256 entities is a map, a graph of 256,000 is a database, and
 * the difference is the difference between a window and a query language.
 */
export const WORLD_LIMITS = Object.freeze({
  /** Durable evidence records retained. Oldest-first eviction past this. */
  maxEvidenceRecords: 1024,
  /** Entities in the folded world, reference and evidence-backed together. */
  maxEntities: 256,
  /** Edges in the folded world. */
  maxEdges: 512,
  /** Edges one entity may carry. A hub must not become the whole model. */
  maxEdgesPerEntity: 32,
  maxAliasesPerEntity: 4,
  /** Attribute *keys* per entity. Values are stored and never projected. */
  maxAttributesPerEntity: 8,
  /** How long a canonical name may be. A label, not a document. */
  maxNameChars: 80,
  /** How long a literal relation value may be. */
  maxLiteralValueChars: 120,
  /** An id, never content. */
  maxSourceRefChars: 128,
  maxAttributeKeyChars: 48,
  maxAttributeValueChars: 200,
  /** A one-sentence evidence summary, stored and projected only as a length. */
  maxEvidenceSummaryChars: 200,
  maxReasonChars: 200,
  /** What a window actually draws in the node list. */
  maxProjectionEntities: 64,
  /** What a window actually draws in the graph. */
  maxProjectionEdges: 192,
  /** The inspector's own bound. */
  maxEntityDetailEdges: 48,
  /** How many hops of expansion from a selected entity a graph view may show. */
  maxGraphDepth: 2,
  maxConflictsListed: 32,
  maxBeliefsListed: 16,
  maxUncertaintiesListed: 32,
  maxClaimSourcesListed: 8,
  /** Past this, an unrefreshed claim stops being `current`. */
  freshnessHorizonMs: 14 * 24 * 60 * 60_000,
  /** Past this, a claim is `stale` rather than merely `aging`. */
  staleAfterMs: 90 * 24 * 60 * 60_000,
})

export type WorldLimits = { readonly [K in keyof typeof WORLD_LIMITS]: number }

/**
 * Clamp requested limits into the code-owned ceilings.
 *
 * Each override may only lower, and the result is made self-consistent at the
 * end: a caller cannot ask for 4 projection entities and 512 detail edges and get
 * a projection whose own bounds contradict it.
 */
export function worldLimits(overrides: Partial<WorldLimits> = {}): WorldLimits {
  const clamp = (key: keyof WorldLimits): number => {
    const requested = overrides[key]
    if (requested === undefined) return WORLD_LIMITS[key]
    if (typeof requested !== 'number' || !Number.isFinite(requested)) return WORLD_LIMITS[key]
    return Math.max(1, Math.min(Math.floor(requested), WORLD_LIMITS[key]))
  }

  const limits = {
    maxEvidenceRecords: clamp('maxEvidenceRecords'),
    maxEntities: clamp('maxEntities'),
    maxEdges: clamp('maxEdges'),
    maxEdgesPerEntity: clamp('maxEdgesPerEntity'),
    maxAliasesPerEntity: clamp('maxAliasesPerEntity'),
    maxAttributesPerEntity: clamp('maxAttributesPerEntity'),
    maxNameChars: clamp('maxNameChars'),
    maxLiteralValueChars: clamp('maxLiteralValueChars'),
    maxSourceRefChars: clamp('maxSourceRefChars'),
    maxAttributeKeyChars: clamp('maxAttributeKeyChars'),
    maxAttributeValueChars: clamp('maxAttributeValueChars'),
    maxEvidenceSummaryChars: clamp('maxEvidenceSummaryChars'),
    maxReasonChars: clamp('maxReasonChars'),
    maxProjectionEntities: clamp('maxProjectionEntities'),
    maxProjectionEdges: clamp('maxProjectionEdges'),
    maxEntityDetailEdges: clamp('maxEntityDetailEdges'),
    maxGraphDepth: clamp('maxGraphDepth'),
    maxConflictsListed: clamp('maxConflictsListed'),
    maxBeliefsListed: clamp('maxBeliefsListed'),
    maxUncertaintiesListed: clamp('maxUncertaintiesListed'),
    maxClaimSourcesListed: clamp('maxClaimSourcesListed'),
    freshnessHorizonMs: clamp('freshnessHorizonMs'),
    staleAfterMs: clamp('staleAfterMs'),
  }

  // A projection cannot draw more nodes than it is allowed to hold, and an entity
  // inspector cannot list more edges than a graph may carry.
  const maxProjectionEdges = Math.min(limits.maxProjectionEdges, limits.maxEdges)
  const maxEntityDetailEdges = Math.min(limits.maxEntityDetailEdges, limits.maxEdges)
  const maxProjectionEntities = Math.min(limits.maxProjectionEntities, limits.maxEntities)

  // `staleAfterMs` below `freshnessHorizonMs` would mean a claim is stale before
  // it is merely aging, which is not a bound a caller gets to express.
  const staleAfterMs = Math.max(limits.staleAfterMs, limits.freshnessHorizonMs)

  return { ...limits, maxProjectionEdges, maxEntityDetailEdges, maxProjectionEntities, staleAfterMs }
}

/* -------------------------------------------------------------- entity kinds */

/**
 * Kinds that exist because evidence can create them.
 *
 * Each is justified by something already in this system: `person` because
 * relationships exist and a relationship needs two people, `project` because the
 * owner has projects and Context already models one, `organisation` and `place`
 * because they are in the Brain's own known entity types and they are the natural
 * counterpart of `owns` and `located_in`.
 *
 * Deliberately absent: `account`, `file`, `service`, `product`, `system`,
 * `asset`, `device` and `unknown`. They are in `DEFERRED_WORLD_ENTITY_KINDS`,
 * which exists so a request for one is refused with an honest reason instead of
 * producing a node that means nothing.
 */
export const NAMED_WORLD_ENTITY_KINDS = ['person', 'project', 'organisation', 'place'] as const
export type NamedWorldEntityKind = (typeof NAMED_WORLD_ENTITY_KINDS)[number]

/**
 * Kinds that are a live pointer into a domain that already owns the truth.
 *
 * Nothing about one of these is stored. The node's state is read from the owning
 * domain on every projection, which is why a cancelled Mission is cancelled in the
 * graph immediately and why there is no second copy to fall out of date.
 */
export const REFERENCE_WORLD_ENTITY_KINDS = [
  'mission',
  'run',
  'task',
  'worker',
  'team',
  'skill',
  'artifact',
] as const
export type ReferenceWorldEntityKind = (typeof REFERENCE_WORLD_ENTITY_KINDS)[number]

/** Which Core domain owns each reference kind. Used to group counts and edges. */
export const WORLD_REFERENCE_DOMAINS = Object.freeze({
  mission: 'mission',
  run: 'work',
  task: 'work',
  worker: 'workforce',
  team: 'workforce',
  skill: 'skills',
  artifact: 'foundry',
} as const)

export type WorldReferenceDomain = (typeof WORLD_REFERENCE_DOMAINS)[ReferenceWorldEntityKind]

/**
 * Freya herself, and the owner.
 *
 * Two Core-owned singletons, so no evidence can create, redefine or shadow them.
 * A statement that tries is refused with `name_reserved` — which is the mechanism
 * behind the identity-spoofing defence: `ent_freya`'s identity is not a record
 * anybody can write.
 */
export const WORLD_SELF_ENTITY_ID = 'ent_freya'
export const WORLD_OWNER_ENTITY_ID = 'ent_owner'
export const WORLD_SELF_ENTITY_NAME = 'Freya'

export type WorldEntityKind = NamedWorldEntityKind | ReferenceWorldEntityKind | 'self'

export const WORLD_ENTITY_KINDS = Object.freeze([
  ...NAMED_WORLD_ENTITY_KINDS,
  ...REFERENCE_WORLD_ENTITY_KINDS,
  'self',
] as const)

export function isNamedWorldEntityKind(value: unknown): value is NamedWorldEntityKind {
  return typeof value === 'string' && (NAMED_WORLD_ENTITY_KINDS as readonly string[]).includes(value)
}

export function isReferenceWorldEntityKind(value: unknown): value is ReferenceWorldEntityKind {
  return typeof value === 'string' && (REFERENCE_WORLD_ENTITY_KINDS as readonly string[]).includes(value)
}

export function isWorldEntityKind(value: unknown): value is WorldEntityKind {
  return typeof value === 'string' && (WORLD_ENTITY_KINDS as readonly string[]).includes(value)
}

/**
 * Declared, not sourced.
 *
 * `conversation` is the interesting one. The *existence* of a conversation is
 * private to the owner, is not evidence about the world, and listing conversation
 * ids in a broad graph would disclose that a conversation exists for no modelling
 * benefit whatsoever. So it is named here and refused there, rather than quietly
 * available.
 */
export const DEFERRED_WORLD_ENTITY_KINDS = [
  'account',
  'file',
  'service',
  'product',
  'system',
  'asset',
  'device',
  'unknown',
  'conversation',
] as const
export type DeferredWorldEntityKind = (typeof DEFERRED_WORLD_ENTITY_KINDS)[number]

export function isDeferredWorldEntityKind(value: unknown): value is DeferredWorldEntityKind {
  return typeof value === 'string' && (DEFERRED_WORLD_ENTITY_KINDS as readonly string[]).includes(value)
}

export type AnyWorldEntityKind = WorldEntityKind | DeferredWorldEntityKind

export function isAnyWorldEntityKind(value: unknown): value is AnyWorldEntityKind {
  return isWorldEntityKind(value) || isDeferredWorldEntityKind(value)
}

/* ------------------------------------------------------------ relation types */

/**
 * The closed relation vocabulary, with the endpoint kinds each accepts.
 *
 * The endpoint table is the load-bearing part, exactly as `CONTEXT_KIND_SOURCES`
 * is for the Context domain: an edge naming a pairing that is not here is
 * refused, so "a `works_on` from an artifact to a place" cannot enter the world
 * no matter who asks. The pairing has to be *expressible* so it can be *refused* —
 * a type that only permitted valid pairings would push the check into whatever
 * casts to it.
 *
 * The table describes **every** edge in the world, derived and admitted alike, so
 * `assigned_to` lists `worker` even though no claim may create a worker subject:
 * that edge is derived from Core's own Workforce record. Admission adds its own
 * narrower constraints on top of this table (a claim cannot have a reference
 * subject, and a literal cannot be a subject at all) — see `evidence.ts`.
 */
export interface WorldRelationSpec {
  readonly directed: boolean
  readonly subjects: readonly WorldEntityKind[]
  readonly objects: readonly WorldEntityKind[]
  /** Relations where one subject can only have one object. Drives conflict detection. */
  readonly singleValued: boolean
}

/** Every kind, for the relations that genuinely accept any of them. */
const ANY_KIND = Object.freeze([
  'person',
  'self',
  'project',
  'organisation',
  'place',
  'mission',
  'run',
  'task',
  'worker',
  'team',
  'skill',
  'artifact',
] as const)

/** A participant that is a person, or Freya herself. */
const PERSON_KINDS = Object.freeze(['person', 'self'] as const)

export const WORLD_RELATION_SPECS = Object.freeze({
  works_on: Object.freeze({
    directed: true,
    subjects: PERSON_KINDS,
    objects: Object.freeze(['project', 'mission', 'run', 'team'] as const),
    singleValued: false,
  }),
  assigned_to: Object.freeze({
    directed: true,
    // A worker or a run does not get assigned by a claim; Core knows who it
    // assigned, and that edge is derived from Core's own record instead.
    subjects: Object.freeze(['person', 'self', 'worker', 'run'] as const),
    objects: Object.freeze(['mission', 'run', 'task', 'team', 'worker'] as const),
    singleValued: false,
  }),
  member_of: Object.freeze({
    directed: true,
    subjects: Object.freeze(['person', 'self', 'worker', 'team'] as const),
    objects: Object.freeze(['team'] as const),
    // One team per worker and per person. Two answers to "which team" is a
    // disagreement, and it is reported as one rather than resolved.
    singleValued: true,
  }),
  owns: Object.freeze({
    directed: true,
    subjects: PERSON_KINDS,
    objects: Object.freeze(['project', 'organisation'] as const),
    singleValued: false,
  }),
  part_of: Object.freeze({
    directed: true,
    subjects: Object.freeze(['project', 'self', 'run', 'task', 'team', 'worker'] as const),
    objects: Object.freeze(['organisation', 'project', 'task', 'team'] as const),
    singleValued: false,
  }),
  depends_on: Object.freeze({
    directed: true,
    subjects: Object.freeze(['project', 'self', 'run', 'mission'] as const),
    objects: Object.freeze(['project', 'artifact', 'skill', 'mission'] as const),
    singleValued: false,
  }),
  created: Object.freeze({
    directed: true,
    subjects: Object.freeze(['person', 'self', 'worker', 'run'] as const),
    objects: Object.freeze(['artifact'] as const),
    singleValued: false,
  }),
  uses: Object.freeze({
    directed: true,
    subjects: Object.freeze(['person', 'self', 'worker', 'run'] as const),
    objects: Object.freeze(['skill'] as const),
    singleValued: false,
  }),
  located_in: Object.freeze({
    directed: true,
    subjects: Object.freeze(['person', 'self', 'project'] as const),
    objects: Object.freeze(['place'] as const),
    singleValued: true,
  }),
  works_at: Object.freeze({
    directed: true,
    subjects: PERSON_KINDS,
    objects: Object.freeze(['organisation'] as const),
    singleValued: true,
  }),
  /**
   * Undirected on purpose: "Ana knows Bo" and "Bo knows Ana" are not the same
   * claim, and a directed edge would let a one-sided statement render as a mutual
   * one. It exists because a world model with no person-to-person edge cannot draw
   * a room.
   */
  acquainted_with: Object.freeze({
    directed: false,
    subjects: PERSON_KINDS,
    objects: PERSON_KINDS,
    singleValued: false,
  }),
  /**
   * The honest weak edge: "these two were mentioned together and nothing stronger
   * is supported."
   *
   * It is capped at `low` confidence for every non-owner channel, because without
   * that cap it becomes the universal escape hatch that every uncertain claim
   * hides behind and the graph stops being a model of anything.
   */
  related_to: Object.freeze({
    directed: false,
    subjects: ANY_KIND,
    objects: ANY_KIND,
    singleValued: false,
  }),
} as const)

export type WorldRelationType = keyof typeof WORLD_RELATION_SPECS

export const WORLD_RELATION_TYPES = Object.freeze(
  Object.keys(WORLD_RELATION_SPECS) as readonly WorldRelationType[],
)

export function isWorldRelationType(value: unknown): value is WorldRelationType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(WORLD_RELATION_SPECS, value)
}

export function worldRelationSpec(type: WorldRelationType): WorldRelationSpec {
  const spec = WORLD_RELATION_SPECS[type]
  return {
    directed: spec.directed,
    subjects: [...spec.subjects] as readonly WorldEntityKind[],
    objects: [...spec.objects] as readonly WorldEntityKind[],
    singleValued: spec.singleValued,
  }
}

/* ---------------------------------------------------------------- admission */

/**
 * The channels an admission can arrive on.
 *
 * This table *is* the memory-poisoning defence, so it is worth being blunt about
 * it: an admission never names its own source. It names a channel, and Core
 * assigns the `SourceTrust` from the channel. A web page, an email, a worker's
 * message or a model's answer can put the words "the owner said so" in its own
 * text and it will be recorded as exactly what it is — untrusted content from a
 * worker. Content can never upgrade its own source classification.
 */
export const WORLD_ADMISSION_CHANNELS = [
  /** The owner stating something in their own hand, through Core's owner scope. */
  'owner_statement',
  /** A Core subsystem that observed it directly. */
  'system_observation',
  /** A worker or another agent asserting something about itself or the world. */
  'worker_claim',
  /** A model asserting something. A hypothesis, and always marked as one. */
  'model_hypothesis',
  /** Content brought in from outside: a document, a page, a pasted block. */
  'imported_content',
] as const
export type WorldAdmissionChannel = (typeof WORLD_ADMISSION_CHANNELS)[number]

export function isWorldAdmissionChannel(value: unknown): value is WorldAdmissionChannel {
  return typeof value === 'string' && (WORLD_ADMISSION_CHANNELS as readonly string[]).includes(value)
}

/** What each channel is worth. Frozen, so a caller cannot widen its own row. */
export const WORLD_CHANNEL_PROFILE = Object.freeze({
  owner_statement: Object.freeze({
    source: 'owner-assertion' as SourceTrust,
    epistemicCap: 'asserted' as EpistemicStatus,
    confidenceCap: 'high' as Confidence,
  }),
  system_observation: Object.freeze({
    source: 'system-observation' as SourceTrust,
    epistemicCap: 'observed' as EpistemicStatus,
    confidenceCap: 'medium' as Confidence,
  }),
  worker_claim: Object.freeze({
    source: 'external-untrusted' as SourceTrust,
    epistemicCap: 'asserted' as EpistemicStatus,
    confidenceCap: 'low' as Confidence,
  }),
  model_hypothesis: Object.freeze({
    source: 'model-inference' as SourceTrust,
    epistemicCap: 'inferred' as EpistemicStatus,
    confidenceCap: 'low' as Confidence,
  }),
  imported_content: Object.freeze({
    source: 'imported-document' as SourceTrust,
    epistemicCap: 'asserted' as EpistemicStatus,
    confidenceCap: 'low' as Confidence,
  }),
})

/**
 * How sure a claim is, as an ordering.
 *
 * Deliberately not exported as a general comparator for arbitrating between two
 * conflicting claims. It exists to apply a *channel's* cap, and using it to pick
 * a winner between an owner statement and a system observation would let one
 * observation silently overwrite the person.
 */
export const WORLD_CONFIDENCE_RANK: Readonly<Record<Confidence, number>> = Object.freeze({
  unknown: 0,
  low: 1,
  medium: 2,
  high: 3,
  verified: 4,
})

/**
 * Claim kinds, derived from the channel rather than chosen by a caller.
 *
 * Exposed because "distinguish facts from owner statements, external
 * observations, model-derived hypotheses, claims and unknowns" has to be visible
 * to whoever is drawing the graph, and a caller-supplied epistemic field would
 * not be that.
 */
export type WorldClaimKind =
  /** Core's own record of an authoritative domain. Not a claim at all. */
  | 'domain_record'
  /** The owner said so. */
  | 'owner_statement'
  /** A Core subsystem saw it. */
  | 'external_observation'
  /** A model worked it out. */
  | 'model_hypothesis'
  /** Untrusted content asserted it. */
  | 'third_party_claim'
  /** Nobody knows. Recorded as not knowing, on purpose. */
  | 'unknown'

export const WORLD_CLAIM_KINDS = Object.freeze([
  'domain_record',
  'owner_statement',
  'external_observation',
  'model_hypothesis',
  'third_party_claim',
  'unknown',
] as const)

export function worldClaimKindFor(channel: WorldAdmissionChannel): WorldClaimKind {
  switch (channel) {
    case 'owner_statement':
      return 'owner_statement'
    case 'system_observation':
      return 'external_observation'
    case 'model_hypothesis':
      return 'model_hypothesis'
    default:
      return 'third_party_claim'
  }
}

/** Evidence kinds. `unknown` and `withdrawal` are first-class, not exceptions. */
export const WORLD_EVIDENCE_KINDS = ['entity', 'relation', 'unknown', 'withdrawal'] as const
export type WorldEvidenceKind = (typeof WORLD_EVIDENCE_KINDS)[number]

export function isWorldEvidenceKind(value: unknown): value is WorldEvidenceKind {
  return typeof value === 'string' && (WORLD_EVIDENCE_KINDS as readonly string[]).includes(value)
}

/* -------------------------------------------------------------- evidence */

/** Where an endpoint of an admitted relation points. */
export type WorldEndpointClaim =
  /** An entity that evidence is creating or referring to, by name. */
  | { readonly form: 'named'; readonly entityType: NamedWorldEntityKind; readonly name: string }
  /** A live record in a domain that owns its truth. Resolved at projection time. */
  | { readonly form: 'reference'; readonly refKind: ReferenceWorldEntityKind; readonly refId: string }
  /** A stated value rather than a pointer. Never both, never neither. */
  | { readonly form: 'literal'; readonly value: string }

/** An entity somebody said exists. */
export interface WorldEntityClaim {
  readonly entityType: NamedWorldEntityKind
  readonly name: string
  readonly aliases: readonly string[]
  /** Stored. Projected as keys and lengths only — values are the owner's words. */
  readonly attributes: Readonly<Record<string, string>>
}

/** A relation somebody said holds. */
export interface WorldRelationClaim {
  readonly relationType: WorldRelationType
  readonly subject: WorldEndpointClaim
  /** A literal, a reference or another named entity — never `null`. */
  readonly object: WorldEndpointClaim
  /** Bitemporal end. Null while still current. */
  readonly validUntil: string | null
}

/**
 * One durable piece of evidence, and the only thing this domain stores.
 *
 * Immutable once written. A withdrawal is a *new record* naming an older one
 * rather than an edit, so "the evidence was taken back" is something the durable
 * history can still show — which is what makes the withdrawal path auditable
 * instead of a silent deletion.
 */
export interface WorldEvidenceRecord {
  readonly evidenceId: string
  /** Replay order. Monotonic per durable history. */
  readonly sequence: number
  readonly kind: WorldEvidenceKind
  readonly channel: WorldAdmissionChannel
  /** When the claim was recorded. Never when it happened. */
  readonly recordedAt: string
  /** When the thing was observed, which is not when it was written down. */
  readonly observedAt: string
  /** Core-assigned, from the channel. Never read from the content. */
  readonly source: SourceTrust
  /** The principal responsible. A model says 'system'; a worker says its own id. */
  readonly actor: PrincipalId
  /** An id — a turn, an event, a worker. Never content. */
  readonly sourceRef: string | null
  /** Assigned by the admitting pathway, which knew how private this was. */
  readonly sensitivity: Sensitivity
  readonly epistemic: EpistemicStatus
  readonly confidence: Confidence
  /** One sentence. Stored; projected as a length and a presence flag. */
  readonly evidenceSummary: string | null
  /** An earlier record this one replaces. Retires it as `stale`, on the record. */
  readonly supersedes: string | null
  readonly entity: WorldEntityClaim | null
  readonly relation: WorldRelationClaim | null
  readonly withdrawal: { readonly targetEvidenceId: string; readonly reason: string } | null
}

/**
 * What an admission asks for.
 *
 * Note the absences, because they are the design:
 *
 * - **No `source`, no `epistemic`.** Trust is assigned from the channel; a caller
 *   that could name its own source could upgrade itself, which is the entire
 *   memory-poisoning problem.
 * - **No `actor`.** The principal comes from the pathway that assembled the
 *   request, so a record of who asserted something cannot be forged by asserting
 *   something.
 * - **No `evidenceId`, no `sequence`.** Identity and order are Core's.
 * - **`confidence` is allowed only on the owner's and the system's own channels**,
 *   and only up to that channel's cap — see `evidence.ts`. A worker or a model may
 *   not state how sure it is, because a self-assessed confidence is a way of
 *   asking to be believed.
 */
export type WorldEvidenceRequest =
  | {
      readonly kind: 'entity'
      readonly entityType: NamedWorldEntityKind
      readonly name: string
      readonly aliases?: readonly string[]
      readonly attributes?: Readonly<Record<string, string>>
      readonly observedAt?: string | null
      readonly sourceRef?: string | null
      readonly confidence?: Confidence
      readonly evidenceSummary?: string | null
      readonly supersedes?: string | null
    }
  | {
      readonly kind: 'relation' | 'unknown'
      readonly relationType: WorldRelationType
      readonly subject: WorldEndpointClaim
      readonly object: WorldEndpointClaim
      readonly observedAt?: string | null
      readonly validUntil?: string | null
      readonly sourceRef?: string | null
      readonly confidence?: Confidence
      readonly evidenceSummary?: string | null
      readonly supersedes?: string | null
    }
  | {
      readonly kind: 'withdrawal'
      readonly targetEvidenceId: string
      readonly reason: string
    }

/* ---------------------------------------------------------------- refusals */

export const WORLD_REFUSAL_CODES = [
  'kind_unknown',
  'kind_deferred',
  'kind_invalid',
  'channel_unknown',
  'name_unusable',
  'name_reserved',
  'name_is_capability',
  'alias_unusable',
  'attribute_key_unusable',
  'attribute_value_too_large',
  'too_many_attributes',
  'too_many_aliases',
  'relation_type_unknown',
  'relation_endpoints_invalid',
  'literal_required',
  'literal_too_large',
  'reference_kind_unknown',
  'reference_id_unusable',
  'endpoint_conflict',
  'confidence_above_channel',
  'epistemic_above_channel',
  'source_ref_too_large',
  'summary_too_large',
  'supersedes_unusable',
  'supersedes_self',
  'supersedes_unknown',
  'invalid_instant',
  'instant_in_future',
  'invalid_valid_until',
  'valid_until_before_observed',
  'entity_unknown',
  'entity_deferred',
  'entity_not_found',
  'invalid_entity_id',
  'store_unavailable',
  'store_degraded',
  'store_closed',
  'withdrawal_unknown',
  'withdrawal_self',
  'claim_fields_not_admissible',
  'stop_all_active',
  'world_overflow',
] as const
export type WorldRefusalCode = (typeof WORLD_REFUSAL_CODES)[number]

/** Why a code is a refusal, in words a person can act on. */
export const WORLD_REFUSAL_REASONS: Readonly<Record<WorldRefusalCode, string>> = Object.freeze({
  kind_unknown: 'that is not a kind of evidence this Core knows',
  kind_deferred: 'this Core build does not source that entity kind yet',
  kind_invalid: 'an entity kind is not usable here',
  channel_unknown: 'that is not an admission channel this Core knows',
  name_unusable: 'that name cannot be used for an entity',
  name_reserved: 'that name belongs to Freya or to the owner and cannot be claimed',
  name_is_capability:
    'a capability name is not a thing in the world and cannot be an entity',
  alias_unusable: 'that alias cannot be used for an entity',
  attribute_key_unusable: 'that attribute key cannot be stored',
  attribute_value_too_large: 'that attribute value is longer than an attribute may be',
  too_many_attributes: 'an entity may not carry that many attributes',
  too_many_aliases: 'an entity may not carry that many aliases',
  relation_type_unknown: 'that is not a relation this Core knows',
  relation_endpoints_invalid: 'that relation does not apply to those kinds of thing',
  literal_required: 'that relation needs a stated value rather than a pointer',
  literal_too_large: 'that value is longer than a relation value may be',
  reference_kind_unknown: 'that is not a domain reference this Core knows',
  reference_id_unusable: 'that is not a usable id in that domain',
  endpoint_conflict: 'a relation either points at something or states a value, not both',
  confidence_above_channel: 'that claim is more certain than its source can be',
  epistemic_above_channel: 'that claim is more settled than its source can be',
  source_ref_too_large: 'that source reference is longer than an id may be',
  summary_too_large: 'that evidence summary is longer than one sentence may be',
  supersedes_unusable: 'that is not a usable evidence id to supersede',
  supersedes_self: 'a piece of evidence cannot supersede itself',
  supersedes_unknown: 'there is no evidence here to supersede',
  invalid_instant: 'that is not a valid time',
  instant_in_future: 'nothing was observed at a time that has not happened yet',
  invalid_valid_until: 'that is not a valid end time',
  valid_until_before_observed: 'a claim cannot end before it was observed',
  entity_unknown: 'that is not an entity kind this Core knows',
  entity_deferred: 'this Core build does not source that entity kind yet',
  entity_not_found: 'there is no such entity in the world',
  invalid_entity_id: 'that is not a usable entity id',
  store_unavailable: 'the world model cannot be read or written right now',
  store_degraded: 'the world model store is damaged and is being trusted with nothing',
  store_closed: 'the world model is closed',
  withdrawal_unknown: 'there is no evidence here to withdraw',
  withdrawal_self: 'a piece of evidence cannot withdraw itself',
  claim_fields_not_admissible:
    'a claim cannot state its own source, status, actor or certainty',
  stop_all_active:
    'Freya is stopped, so nothing new is coming to be believed while she cannot act on it',
  world_overflow: 'the world model is full and cannot take another claim',
})

/* ---------------------------------------------------------------- freshness */

/**
 * How current a fact is, computed from its own instants.
 *
 * Never stored as a mutable field, because a stored freshness is a freshness that
 * can drift from the evidence it claims to describe.
 */
export const WORLD_FRESHNESS = [
  'current',
  'aging',
  'stale',
  'historical',
  'conflicted',
  'withdrawn',
] as const
export type WorldFreshness = (typeof WORLD_FRESHNESS)[number]

export function isWorldFreshness(value: unknown): value is WorldFreshness {
  return typeof value === 'string' && (WORLD_FRESHNESS as readonly string[]).includes(value)
}

/** Where an edge came from, which is not the same as how sure it is. */
export const WORLD_EDGE_ORIGINS = ['domain_record', 'admitted_evidence'] as const
export type WorldEdgeOrigin = (typeof WORLD_EDGE_ORIGINS)[number]

export function isWorldEdgeOrigin(value: unknown): value is WorldEdgeOrigin {
  return typeof value === 'string' && (WORLD_EDGE_ORIGINS as readonly string[]).includes(value)
}

/* ------------------------------------------------------------------ schema */

/** The projection schema version. Bumped when a view's shape changes. */
export const WORLD_SCHEMA_VERSION = 1