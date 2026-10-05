/**
 * Brain entities.
 *
 * This file is the vocabulary of everything Freya knows and everything she has
 * learned. It is deliberately separate from `core/conversation/` and
 * `core/events/`, because those answer different questions and merging them is
 * how a system starts treating a sentence somebody said as a fact about the
 * world:
 *
 *   Event Fabric   — "what happened in the system?"
 *   Conversation   — "what was said?"
 *   World          — "what entities and facts does Freya know about?"
 *   Memory         — "what durable knowledge is worth recalling?"
 *   Experience     — "what did Freya attempt, and what came back?"
 *
 * ## The three distinctions this file exists to protect
 *
 * 1. **Observation is not belief is not verified fact.** Every durable item
 *    carries an `EpistemicStatus` and a `Confidence`. A model saying something,
 *    a document saying something, and a system observing something are three
 *    different claims with three different weights, and collapsing them is how a
 *    system starts being confidently wrong.
 *
 * 2. **A candidate is not a memory.** Nothing becomes recallable merely by
 *    existing. Admission is a separate, trusted step with a recorded reason.
 *
 * 3. **Confidence is a category, not a number.** A fake `0.873` looks
 *    scientific and means nothing. If a numeric score is added later it must come
 *    with explicit semantics; today there are none, so there is none.
 */

/* ------------------------------------------------------------- epistemic */

export type EpistemicStatus =
  /** Freya does not know whether this holds. */
  | 'unknown'
  /** Something was seen, and recorded as seen. Not yet believed. */
  | 'observed'
  /** Somebody said so. Their claim, not a finding. */
  | 'asserted'
  /** Freya worked it out. Reasonable, and not verified. */
  | 'inferred'
  /** Independently checked. The only status that means "this is settled". */
  | 'verified'
  /** Something later contradicted it. Kept, not deleted. */
  | 'contradicted'
  /** Was true once; the world has moved on. */
  | 'stale'

/**
 * How sure Freya is, as a category.
 *
 * Deliberately not a float. A number invites a caller to compare and average
 * confidences, which would produce a total that is precise about nothing.
 */
export type Confidence = 'unknown' | 'low' | 'medium' | 'high' | 'verified'

/** Ordering for weighting during retrieval. Ties are broken by id, never by chance. */
export const CONFIDENCE_RANK: Readonly<Record<Confidence, number>> = Object.freeze({
  unknown: 0,
  low: 1,
  medium: 2,
  high: 3,
  verified: 4,
})

/**
 * How sensitive a record is.
 *
 * `secret-reference` is for the *fact* that a credential exists, never the
 * credential. Guard and a future Vault own secrets; the Brain is told about
 * them the way a person is told where the keys are, not handed them.
 */
export type Sensitivity = 'normal' | 'personal' | 'sensitive' | 'secret-reference'

export const SENSITIVITY_RANK: Readonly<Record<Sensitivity, number>> = Object.freeze({
  normal: 0,
  personal: 1,
  sensitive: 2,
  'secret-reference': 3,
})

/* ------------------------------------------------------------ provenance */

/**
 * Where a claim came from, and how much that is worth.
 *
 * `sourceType` is assigned by the **admitting pathway in trusted Core code**, never
 * copied from the content being admitted. That is the whole memory-poisoning
 * defence: a web page, an email or a model's answer can say "this is an
 * owner-asserted fact" in its own text, and it will be recorded as exactly what it
 * is — untrusted content from a model. Content can never upgrade its own source
 * classification.
 */
export type SourceTrust =
  /** The owner said so. The strongest source Freya has, and still a statement. */
  | 'owner-assertion'
  /** A Core subsystem observed it directly. */
  | 'system-observation'
  /** External content of unknown authorship. Treated as data, always. */
  | 'external-untrusted'
  /** A model asserted it. Never silently equivalent to an owner statement. */
  | 'model-inference'
  /** Freya's own reasoning, not a model's and not the owner's. */
  | 'freya-inference'
  /** A document brought in. Future; untrusted until a human says otherwise. */
  | 'imported-document'
  /** The outcome of something Freya did. Future. */
  | 'experience-outcome'

/**
 * Trust ordering, used to bias admission and conflict resolution.
 *
 * Note that `system-observation` and `experience-outcome` are *not* above
 * `owner-assertion`. A person is allowed to be wrong about their own priorities,
 * and Freya noticing something herself is evidence, not authority.
 */
export const SOURCE_TRUST_RANK: Readonly<Record<SourceTrust, number>> = Object.freeze({
  'external-untrusted': 0,
  'model-inference': 1,
  'freya-inference': 1,
  'imported-document': 0,
  'experience-outcome': 2,
  'system-observation': 3,
  'owner-assertion': 4,
})

/**
 * Why Freya believes or remembers something.
 *
 * Answers "why does she believe this?" and never "because the model said so" —
 * a model-derived item says exactly that, in `sourceType`, which is the point of
 * having the field.
 *
 * Never carries conversation text, a credential, or a key. `evidenceSummary` is a
 * sentence; `sourceRef` is an id.
 */
export interface Provenance {
  sourceType: SourceTrust
  /** An id, never content. A turn id, an event id, a future document id. */
  sourceRef: string | null
  /** When the thing was observed, which is not when it was written down. */
  observedAt: string
  /** When this record was written. */
  recordedAt: string
  /** The principal responsible. A model says 'system'; the owner says 'owner'. */
  actor: string
  verificationStatus: EpistemicStatus
  confidence: Confidence
  /** One sentence. No content, no quotes. */
  evidenceSummary: string | null
}

/* -------------------------------------------------------------- identity */

/**
 * A claim that is true of Freya by construction.
 *
 * These are not preferences and not learnings. They are the properties that
 * follow from Freya's architecture, and they hold no matter what any model says
 * or what anybody types. There is deliberately **no write path** for them: the
 * Brain exposes identity as a read, and the only constructor is a module-private
 * function.
 */
export interface IdentityRootClaim {
  claimId: string
  statement: string
  /** Why it is true, in one sentence. */
  rationale: string
}

/**
 * Freya's persistent identity projection.
 *
 * An evolution of the Phase 3 Identity Kernel rather than a replacement for it:
 * the same principles, now carrying the architectural claims that make "the model
 * is not Freya" a structural statement rather than a sentence in a prompt.
 */
export interface IdentityRoot {
  /** The Brain's own identity schema version, not Freya's product version. */
  schemaVersion: number
  name: string
  role: string
  purpose: string
  stableTraits: readonly string[]
  communicationPrinciples: readonly string[]
  continuityPrinciples: readonly string[]
  claims: readonly IdentityRootClaim[]
  /** Fixed. There is no way to change it, which is the property. */
  immutable: true
}

/**
 * A learned preference about how to talk to this particular owner.
 *
 * **Schema and seam only in Phase 4.** Nothing writes these, and the Brain exposes
 * no mutation for them. When it is implemented, admission has to go through the
 * same trusted pathway as memory admission, and a model must never be able to
 * install one by asserting it.
 */
export interface EvolvablePreference {
  preferenceId: string
  key: string
  value: string
  admittedAt: string
  provenance: Provenance
}

/* ---------------------------------------------------------- self model */

export type SelfCapabilityState = 'available' | 'unavailable' | 'disabled' | 'unknown'

/**
 * What Freya can do, persistently.
 *
 * The *definition* of her capabilities — what exists, what each one needs, what
 * each one cannot do. This is descriptive and lives in the Brain because it
 * changes only when the software changes.
 */
export interface SelfCapabilityFact {
  capability: string
  state: SelfCapabilityState
  /** What it needs in order to work. Names, never values. */
  requires: readonly string[]
  /** What it explicitly cannot do. The most useful field on this record. */
  cannot: readonly string[]
}

export interface SelfLimitation {
  limitationId: string
  statement: string
  /** Why it is a limitation, so it can be recognised when it is fixed. */
  because: string
}

/**
 * The persistent half of the self-model: who she is and what she is built from.
 *
 * Explicitly **not** the live half. Live authority, budgets, stop state and
 * journal integrity are Guard and Governor's truth, projected fresh on every
 * read; duplicating them here as writable state would create a second, stale
 * copy of the most security-relevant facts in the system.
 */
export interface SelfDefinition {
  schemaVersion: number
  capabilities: readonly SelfCapabilityFact[]
  limitations: readonly SelfLimitation[]
  /** How much of the self-model is present, for a truthful projection. */
  complete: boolean
}

/* -------------------------------------------------------- world model */

export const KNOWN_WORLD_ENTITY_TYPES = [
  'person',
  'organisation',
  'project',
  'account',
  'file',
  'device',
  'service',
  'place',
  'asset',
  'product',
  'mission',
  'system',
  'unknown',
] as const

export type KnownWorldEntityType = (typeof KNOWN_WORLD_ENTITY_TYPES)[number]

/**
 * An entity type.
 *
 * A known set for the values Freya already understands, and an open union so a
 * later phase can add types without editing this file. Deliberately **not** a
 * business schema: there is no CRM here, no connectors, and no fields that exist
 * to support a product Freya has not been asked to do.
 */
export type WorldEntityType = KnownWorldEntityType | (string & {})

/**
 * Something Freya has heard of.
 *
 * An entity is not a claim. `Project Alpha` existing as an entity says only that
 * the name came up; what is true *about* it lives in relations, each with its own
 * provenance and epistemic status.
 */
export interface WorldEntity {
  entityId: string
  type: WorldEntityType
  canonicalName: string
  /** Other names the same thing goes by. Not a merge operation. */
  aliases: readonly string[]
  attributes: Readonly<Record<string, string>>
  createdAt: string
  updatedAt: string
  provenance: Provenance
  epistemic: EpistemicStatus
}

/**
 * A relationship between entities, or between an entity and a literal.
 *
 * `objectEntityId` and `literalValue` are mutually exclusive and exactly one is
 * set: a relation either points at another entity or states a value, and
 * "Project Alpha's deadline is Friday" is the second kind. Keeping them in one
 * shape means retrieval does not need two code paths, and it is still impossible
 * to write a relation that points at nothing.
 */
export interface WorldRelation {
  relationId: string
  subjectEntityId: string
  predicate: string
  objectEntityId: string | null
  literalValue: string | null
  validFrom: string
  /** Null when still current. Bitemporal, so history stays readable. */
  validUntil: string | null
  confidence: Confidence
  provenance: Provenance
  epistemic: EpistemicStatus
  supersedes: string | null
  conflictsWith: readonly string[]
}

/**
 * Something a source said, kept as said.
 *
 * The distinction that matters: "a message says Project Alpha is delayed" is an
 * observation of a *claim*, and is not a claim that Alpha is delayed. An
 * observation is only promoted by admission, through a trusted pathway, and it
 * carries the observation's own epistemic status until then.
 */
export interface WorldObservation {
  observationId: string
  /** What the source said, in its words. Stored, never executed. */
  stated: string
  /** Entities the statement is about, as far as they have been resolved. */
  entityRefs: readonly string[]
  /** Free-form extraction the admitting pathway may use. Never trusted as fact. */
  extracted: Readonly<Record<string, string>>
  observedAt: string
  provenance: Provenance
  epistemic: EpistemicStatus
}

/* -------------------------------------------------------------- memory */

export const MEMORY_KINDS = [
  /** Facts, concepts, knowledge. */
  'semantic',
  /** What happened, historically. */
  'episodic',
  /** How something is done. */
  'procedural',
  /** Current short-lived relevance. Belongs to the Mind, not the Brain. */
  'working',
  /** What Freya knows about a person, project or organisation. */
  'relationship',
  /** What Freya herself did, observed, attempted or learned. */
  'autobiographical',
] as const

export type MemoryKind = (typeof MEMORY_KINDS)[number]

/**
 * Where a memory is in its life.
 *
 * The lifecycle is `candidate → admitted`, or one of the terminal-ish states.
 * Nothing skips it: there is no path by which writing text into a store creates a
 * recallable memory.
 */
export type MemoryStatus =
  /** Seen, not yet judged. Not recallable. */
  | 'candidate'
  /** Judged, kept, and recallable. */
  | 'admitted'
  /** Judged and refused. Kept, with the reason, so the refusal is auditable. */
  | 'rejected'
  /** Not yet decidable. Neither recallable nor refused. */
  | 'deferred'
  /** Was admitted; a newer record replaced it. Still readable as history. */
  | 'superseded'
  /** Admitted, and something contradicts it. Both sides are kept. */
  | 'conflicted'
  /** Withdrawn deliberately. Kept, not deleted. */
  | 'archived'

/**
 * Statuses retrieval returns by default.
 *
 * `conflicted` is recallable **on purpose**. A memory something else contradicts
 * is still something Freya believes, and hiding it would mean recall silently
 * presented one side of a disagreement as the whole truth. Both sides come back,
 * and the pack says so.
 */
export const RECALLABLE_STATUSES: readonly MemoryStatus[] = Object.freeze(['admitted', 'conflicted'])

/**
 * A proposal. Not a memory, and never recallable.
 *
 * This type exists so that "something Freya noticed" and "something Freya knows"
 * cannot be the same type. A candidate carries no admission reason because it has
 * not been admitted.
 */
export interface MemoryCandidate {
  candidateId: string
  kind: MemoryKind
  /** Who or what the memory is about. Free text; entityRefs carries structure. */
  subject: string
  content: string
  proposedConfidence: Confidence
  provenance: Provenance
  sensitivity: Sensitivity
  tags: readonly string[]
  entityRefs: readonly string[]
  createdAt: string
  /** Set when this candidate is itself a response to an untrusted source. */
  derivedFrom: SourceTrust
}

/**
 * A memory Freya will actually recall.
 *
 * `admittedAt` and `admissionReason` are required, and that requirement is the
 * mechanism: a record without them cannot be constructed as an admitted memory, so
 * "it is in the database" and "it was admitted" cannot come apart.
 */
export interface MemoryRecord {
  memoryId: string
  kind: MemoryKind
  subject: string
  content: string
  structuredData: Readonly<Record<string, string>>
  createdAt: string
  updatedAt: string
  /** The trust class of the source. Assigned by the admitting pathway, not by content. */
  source: SourceTrust
  provenance: Provenance
  confidence: Confidence
  status: MemoryStatus
  sensitivity: Sensitivity
  tags: readonly string[]
  entityRefs: readonly string[]
  /** Replaced by a later record. Null when current. */
  supersedes: string | null
  /** Contradicted by another record. Both remain. */
  conflictsWith: readonly string[]
  expiresAt: string | null
  /** Required. There is no admitted memory without a reason for being admitted. */
  admittedAt: string
  admissionReason: string
}

/**
 * What the owner decided about keeping a memory in front of Freya.
 *
 * A **separate record kind**, not a field on `MemoryRecord`, and the reason is
 * worth stating because it looks like duplication: pinning answers a different
 * question from admission. Admission asks "is this worth believing?", and pinning
 * asks "should this be in front of me when you answer?". A field on the memory
 * would make the second question able to overwrite the first — unpinning would
 * look like retracting a belief, and pinning would look like raising confidence.
 *
 * Two invariants live in the type rather than in a caller:
 *
 *  - **`decidedBy` is `'owner'` and nothing else.** There is no pathway by which a
 *    subsystem, a worker or a model decides what the owner keeps in view. If that
 *    were ever widened, "the model decided what Freya always sees" would be a
 *    memory-poisoning primitive with a UI.
 *  - **Pinning is not recallability.** It changes what is offered, never what is
 *    admitted, and it cannot resurrect a withdrawn memory: retrieval still filters
 *    on `status`, so an archived memory stays archived whatever this says.
 */
export interface MemoryOwnership {
  memoryId: string
  /** True to offer first, false to stop offering. Never "true forever". */
  pinned: boolean
  decidedAt: string
  decidedBy: 'owner'
  /** In the owner's words. Bounded by the reason limit, and never inferred. */
  reason: string
}

/** Why a candidate was not admitted, kept so the decision can be examined later. */
export interface MemoryReview {
  candidateId: string
  decision: 'admitted' | 'rejected' | 'deferred'
  reason: string
  reviewedAt: string
  /** The memory this produced, when one was admitted. */
  memoryId: string | null
}

/* ---------------------------------------------------------- experience */

export type ExperienceResult =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'denied'

/**
 * How independently the outcome was checked.
 *
 * `unverified` is the honest default and the only value Phase 4 can produce. A
 * provider returning text is *execution completed*, never *answer correct*, and a
 * second model asked "was that right?" would be a model grading a model, which
 * verifies nothing.
 */
export type ExperienceVerification = 'unverified' | 'verified' | 'contradicted'

export interface ExperienceAction {
  at: string
  /** A verb phrase: what was attempted. Never a credential or a key. */
  summary: string
  outcome: 'succeeded' | 'failed' | 'skipped'
}

export interface ExperienceResourceUsage {
  providerId: string | null
  model: string | null
  /** Whether a provider had the request. Decides whether a cost may exist. */
  providerContacted: boolean
  /** Only what a provider actually reported. Null means it reported nothing. */
  inputTokens: number | null
  outputTokens: number | null
  usageUnknown: boolean
}

/**
 * What Freya attempted, and what came back.
 *
 * **Metadata, never content.** A turn's question and answer live in the encrypted
 * conversation store; duplicating them here would put the most private text in
 * the system into a second store with weaker handling, for no analytical gain.
 * References only.
 */
export interface ExperienceRecord {
  experienceId: string
  /** What Freya was trying to do, in one sentence. Never a transcript. */
  goalSummary: string
  startedAt: string
  endedAt: string
  modelsUsed: readonly string[]
  toolsUsed: readonly string[]
  actions: readonly ExperienceAction[]
  observations: readonly string[]
  /** Ids of the records that back the outcome. Not their content. */
  evidenceRefs: readonly string[]
  result: ExperienceResult
  verification: ExperienceVerification
  /** Present only when a person corrected Freya. Never inferred. */
  humanCorrection: string | null
  relatedEntities: readonly string[]
  relatedMemories: readonly string[]
  resourceUsage: ExperienceResourceUsage
  /** True when an answer was stored durably. Says nothing about whether it was right. */
  answerPersisted: boolean
  /** The turn this came from, for tracing. Null for a non-conversation experience. */
  conversationId: string | null
  turnId: string | null
}

/* ------------------------------------------------------------ retrieval */

export interface RecallQuery {
  /** The text to match against. Empty is legal and returns recent items. */
  text: string
  kinds?: readonly MemoryKind[]
  tags?: readonly string[]
  entityRefs?: readonly string[]
  /** Defaults to admitted only. */
  statuses?: readonly MemoryStatus[]
  /** Maximum items. Hard-bounded by the pack budget regardless. */
  limit?: number
}

export interface RecallBudget {
  maxEstimatedTokens: number
  maxItems: number
}

export const DEFAULT_RECALL_BUDGET: RecallBudget = Object.freeze({
  maxEstimatedTokens: 800,
  maxItems: 12,
})

/**
 * Why an item was selected.
 *
 * Carried into the projection so the retrieval inspector can show its work, and so
 * a surprising recall can be traced to a term rather than to "the model thought it
 * was relevant" — which would mean a model call, and retrieval must never make
 * one.
 */
export interface RecallReason {
  reason: 'entity-ref' | 'keyword' | 'tag' | 'recency' | 'relationship' | 'kind'
  detail: string
}

export interface RecallItem {
  memoryId: string
  kind: MemoryKind
  subject: string
  content: string
  status: MemoryStatus
  confidence: Confidence
  sensitivity: Sensitivity
  source: SourceTrust
  score: number
  reasons: readonly RecallReason[]
  updatedAt: string
}

export interface RecallEntity {
  entityId: string
  canonicalName: string
  type: WorldEntityType
  /** Relations selected alongside the memory that referenced them. */
  relations: readonly {
    relationId: string
    predicate: string
    objectEntityId: string | null
    literalValue: string | null
    confidence: Confidence
  }[]
}

/**
 * A bounded, deterministic set of things worth putting in front of a model.
 *
 * This is the artefact a future Mind compiles into provider context, and its
 * whole job is to be *small and honest*. It names what it left out, carries the
 * conflicts it found rather than hiding them, and summarises provenance so a model
 * can see that something came from a web page rather than from the owner.
 */
export interface RecallPack {
  query: string
  memories: readonly RecallItem[]
  entities: readonly RecallEntity[]
  /** Contradictions found among the selected items. Disclosed, not resolved. */
  conflicts: readonly {
    memoryId: string
    conflictsWith: readonly string[]
    detail: string
  }[]
  /** One line per selected item: where it came from and how sure it is. */
  provenanceSummaries: readonly {
    memoryId: string
    sourceType: SourceTrust
    confidence: Confidence
    verificationStatus: EpistemicStatus
  }[]
  /** How many candidates were considered and not included. Never zero by accident. */
  candidatesConsidered: number
  omittedCount: number
  budget: RecallBudget
  estimatedTokens: number
  /** True when nothing matched. A pack that is empty says so. */
  empty: boolean
}

/* --------------------------------------------------------------- limits */

export const BRAIN_LIMITS = Object.freeze({
  /** One Brain record. Large enough for a memory body, small enough to be safe. */
  maxRecordBytes: 256 * 1024,
  /** One memory's content. */
  maxMemoryContentChars: 16_000,
  maxMemorySubjectChars: 500,
  maxEntityNameChars: 200,
  maxAliasChars: 200,
  maxAliasesPerEntity: 32,
  maxRelationsPerEntity: 200,
  maxPredicateChars: 120,
  maxLiteralValueChars: 2_000,
  maxTagsPerRecord: 32,
  maxTagChars: 64,
  maxEntityRefsPerRecord: 32,
  maxAttributesPerEntity: 64,
  /** Items returned to a renderer in one projection. */
  maxItemsInProjection: 100,
  /** Conversations remembered in the listing, as well as records. */
  maxListingItems: 200,
  /** Characters of a reason or summary. */
  maxReasonChars: 500,
  maxGoalSummaryChars: 500,
})
