import type { Confidence, EpistemicStatus, Sensitivity, SourceTrust } from '../brain/types'
import type {
  WorldClaimKind,
  WorldEntityKind,
  WorldEvidenceKind,
  WorldFreshness,
  WorldRelationType,
} from '../world/types'
import type { WorldSelfModel } from '../world/self'

/**
 * THE WORLD & SELF READ CONTRACT.
 *
 * Five bounded, read-only views. This file is what a future World surface is
 * allowed to see, and — more importantly — what it is *not*.
 *
 * ## Nothing here can write
 *
 * There is no command in this protocol that creates an entity, a relation, an
 * identity, a capability, a trust level or a confidence. The two mutating commands
 * that exist are owner-only, Guard-evaluated and Core-internal, and they are not in
 * the renderer command allowlist. A window may ask what Freya thinks she knows; it
 * may not tell her.
 *
 * ## Nothing here is private content
 *
 * Every field is an id, a closed label, an instant, a count, a measured length, or a
 * bounded canonical name a graph cannot be drawn without. Specifically absent:
 *
 * - **Attribute values.** Keys and `valueLength` only. There is no view that
 *   unlocks them, because a view that unlocks them is a view a bug unlocks them from.
 * - **Evidence summaries.** Stored, projected as `evidenceSummaryLength` and
 *   `evidenceSummaryPresent`. One sentence of the owner's prose is still the
 *   owner's prose.
 * - **Memory bodies, Skill bodies, Mission content, prompts, credentials, connector
 *   payloads and journal lines.** None of those has a field here to live in.
 * - **Sensitive claims.** Evidence recorded at `sensitive` or `secret-reference` is
 *   counted in `withheld` and never appears as a node or an edge.
 * - **Untrusted text, verbatim.** A literal from a worker, a model or imported
 *   content is rendered as a length only. Putting untrusted text in front of a
 *   person unchanged is how injected text becomes an instruction (C9).
 *
 * ## Truncation is always visible
 *
 * Every listing carries a `retained` / `total` / `hidden` triple. A viewer that
 * quietly stopped listing things would read as "they never existed", which is the
 * false impression a bounded viewer is most likely to create.
 */

/** How sure a claim is, as the Brain's own categories. Never a number. */
export type WorldConfidenceView = Confidence
export type WorldEpistemicView = EpistemicStatus
export type WorldClaimKindView = WorldClaimKind
export type WorldFreshnessView = WorldFreshness

/** What a node is, and whether a person or a subsystem said so. */
export interface WorldEntityNodeView {
  readonly entityId: string
  readonly kind: WorldEntityKind
  /** The canonical name. Null for a reference node, which has only an id. */
  readonly name: string | null
  /** The owning domain's own display label, where it has one. */
  readonly label: string | null
  readonly aliases: readonly string[]
  /** Keys and measured lengths. Never the value. */
  readonly attributeKeys: readonly { readonly key: string; readonly valueLength: number }[]
  /** Live state from the owning domain. Null for an evidence-backed entity. */
  readonly reference: {
    readonly domain: string
    readonly recordId: string
    /** The owning domain's own closed label, in its own words. */
    readonly status: string
    readonly terminal: boolean
    readonly observedAt: string | null
  } | null
  readonly claimKind: WorldClaimKind
  readonly epistemic: EpistemicStatus
  readonly confidence: Confidence
  readonly freshness: WorldFreshness
  readonly contested: boolean
  readonly withdrawn: boolean
  /** Freya or the owner. Nobody can create or redefine either. */
  readonly singleton: boolean
  readonly sourceRef: string | null
  readonly firstObservedAt: string
  readonly lastObservedAt: string
  readonly edgeCount: number
  readonly evidenceCount: number
}

/** Where a claim came from, with the summary withheld. */
export interface WorldProvenanceView {
  readonly claimKind: WorldClaimKind
  readonly source: SourceTrust
  readonly epistemic: EpistemicStatus
  readonly confidence: Confidence
  readonly actor: string
  readonly sourceRef: string | null
  readonly observedAt: string
  readonly recordedAt: string
  /** A length and a flag, never the sentence. */
  readonly evidenceSummaryLength: number
  readonly evidenceSummaryPresent: boolean
  /** Set when this claim rests on sensitive evidence and is therefore not shown. */
  readonly sensitivity: Sensitivity | null
}

export interface WorldEdgeView {
  readonly edgeId: string
  readonly relationType: WorldRelationType
  readonly directed: boolean
  readonly fromEntityId: string
  readonly toEntityId: string | null
  /**
   * The stated value, rendered only for a claim the owner or a Core subsystem made.
   *
   * Null for an untrusted claim, and `literalWithheld` says so rather than the UI
   * having to guess: rendering untrusted text in front of a person unchanged is how
   * injected text becomes an instruction.
   */
  readonly literalValue: string | null
  readonly literalValueLength: number
  readonly literalWithheld: boolean
  readonly origin: 'domain_record' | 'admitted_evidence'
  readonly freshness: WorldFreshness
  readonly contested: boolean
  readonly conflictsWith: readonly string[]
  readonly supersededBy: string | null
  /** The referenced record does not exist in the domain that should own it. */
  readonly dangling: boolean
  readonly provenance: WorldProvenanceView
  /** The evidence record this edge was folded from. Null for a derived edge. */
  readonly evidenceId: string | null
}

/** One unresolved disagreement, with both sides named. */
export interface WorldConflictView {
  readonly subjectEntityId: string
  readonly relationType: string
  readonly objectKey: string
  readonly edgeIds: readonly string[]
  readonly evidenceIds: readonly string[]
  readonly reason: 'disagreeing_values' | 'disagreeing_objects'
}

/** The shared header every view carries. */
export interface WorldViewHeader {
  readonly health: 'ready' | 'unavailable'
  /** Why, in words a person can act on. Null when healthy. */
  readonly reason: string | null
  readonly schemaVersion: number
  /** Highest evidence sequence folded, so a window can prove it is current. */
  readonly sequence: number
  readonly persistence: {
    readonly mode: 'encrypted' | 'ephemeral'
    readonly durable: boolean
    readonly reason: string | null
    readonly faultReason: string | null
  }
  readonly limits: {
    readonly maxProjectionEntities: number
    readonly maxProjectionEdges: number
    readonly maxEntityDetailEdges: number
    readonly maxGraphDepth: number
    readonly maxConflictsListed: number
    readonly maxBeliefsListed: number
    readonly maxUncertaintiesListed: number
    readonly maxEvidenceRecords: number
    readonly maxEntities: number
    readonly maxEdges: number
    readonly freshnessHorizonMs: number
    readonly staleAfterMs: number
  }
}

/* ---------------------------------------------------------------- summary */

/** "What does she think she knows, and how sure is she?" */
export interface WorldSummaryView extends WorldViewHeader {
  readonly counts: {
    readonly entities: number
    readonly referenceEntities: number
    readonly evidenceBackedEntities: number
    readonly edges: number
    readonly derivedEdges: number
    readonly claimedEdges: number
    readonly evidenceRecords: number
    readonly withdrawnRecords: number
    readonly supersededRecords: number
    /** Claims pointing at a record the owning domain does not have. */
    readonly danglingEdges: number
    /** Evidence too sensitive to project. Counted here and nowhere else. */
    readonly withheld: number
    readonly conflicts: number
    readonly beliefs: number
  }
  readonly byClaimKind: Readonly<Record<WorldClaimKind, number>>
  readonly byFreshness: Readonly<Record<WorldFreshness, number>>
  /** What Freya knows she does not know. Disclosed, because it is real. */
  readonly uncertainties: {
    readonly listed: number
    readonly total: number
    readonly items: readonly {
      readonly entityId: string
      readonly kind: string
      readonly reason: 'unknown' | 'conflicted' | 'stale' | 'dangling' | 'withheld'
    }[]
  }
  /** Unresolved disagreements, both sides named. Never silently resolved. */
  readonly conflicts: {
    readonly listed: number
    readonly total: number
    readonly items: readonly WorldConflictView[]
  }
}

/* ----------------------------------------------------------- entity lists */

export interface WorldEntityListView extends WorldViewHeader {
  readonly entities: readonly WorldEntityNodeView[]
  /** A filter that was applied, echoed so a window can show it. */
  readonly filter: { readonly kind: WorldEntityKind | null; readonly includeWithdrawn: boolean }
  readonly entitiesRetained: number
  readonly entitiesTotal: number
  readonly entitiesHidden: number
}

/* --------------------------------------------------------- entity detail */

/** Everything a selected-entity inspector needs, and nothing it cannot have. */
export interface WorldEntityDetailView extends WorldViewHeader {
  readonly entity: WorldEntityNodeView | null
  readonly entityId: string
  readonly edges: readonly WorldEdgeView[]
  /** Evidence ids backing this node. Ids only — never the claims themselves. */
  readonly evidenceIds: readonly string[]
  readonly conflicts: readonly WorldConflictView[]
  readonly edgesRetained: number
  readonly edgesTotal: number
  readonly edgesHidden: number
  readonly neighbours: readonly {
    readonly entityId: string
    readonly relationType: WorldRelationType
    readonly directed: boolean
    readonly direction: 'outgoing' | 'incoming' | 'both'
    readonly freshness: WorldFreshness
  }[]
}

/* ------------------------------------------------------------------ graph */

export interface WorldRelationGraphView extends WorldViewHeader {
  readonly nodes: readonly WorldEntityNodeView[]
  readonly edges: readonly WorldEdgeView[]
  /** A node the filter named, expanded one hop. Null when none was named. */
  readonly focusEntityId: string | null
  readonly nodesRetained: number
  readonly nodesTotal: number
  readonly nodesHidden: number
  readonly edgesRetained: number
  readonly edgesTotal: number
  readonly edgesHidden: number
  /** A note when the graph is a neighbourhood rather than the whole world. */
  readonly scope: 'whole_world' | 'neighbourhood' | 'empty'
}

/* ------------------------------------------------------------------- self */

/**
 * The self model as a surface sees it.
 *
 * Seven compartments, each naming its own source, plus a `separation` block that
 * states in machine-readable form that none of them is authority.
 */
export type SelfStatusView = WorldSelfModel

/* --------------------------------------------------------------- sentinels */

/** The summary Core reports before it has a world, and on a store it cannot read. */
export const ABSENT_WORLD_HEADER = Object.freeze({
  health: 'unavailable' as const,
  reason: 'Core has not reported a world model yet',
  schemaVersion: 1,
  sequence: 0,
  persistence: Object.freeze({
    mode: 'ephemeral' as const,
    durable: false,
    reason: 'no world model is reporting',
    faultReason: null,
  }),
  limits: Object.freeze({
    maxProjectionEntities: 64,
    maxProjectionEdges: 192,
    maxEntityDetailEdges: 48,
    maxGraphDepth: 2,
    maxConflictsListed: 32,
    maxBeliefsListed: 16,
    maxUncertaintiesListed: 32,
    maxEvidenceRecords: 1024,
    maxEntities: 256,
    maxEdges: 512,
    freshnessHorizonMs: 14 * 24 * 60 * 60_000,
    staleAfterMs: 90 * 24 * 60 * 60_000,
  }),
})

export const NO_WORLD_DOMAIN_REASON = 'Core has not reported a world model yet'

export const WORLD_NO_PAYLOAD = 'this world command takes no payload'

/** The summary Core reports when no world model is plugged in. */
export const ABSENT_WORLD_SUMMARY: WorldSummaryView = Object.freeze({
  ...ABSENT_WORLD_HEADER,
  counts: Object.freeze({
    entities: 0,
    referenceEntities: 0,
    evidenceBackedEntities: 0,
    edges: 0,
    derivedEdges: 0,
    claimedEdges: 0,
    evidenceRecords: 0,
    withdrawnRecords: 0,
    supersededRecords: 0,
    danglingEdges: 0,
    withheld: 0,
    conflicts: 0,
    beliefs: 0,
  }),
  byClaimKind: Object.freeze({
    domain_record: 0,
    owner_statement: 0,
    external_observation: 0,
    model_hypothesis: 0,
    third_party_claim: 0,
    unknown: 0,
  }),
  byFreshness: Object.freeze({
    current: 0,
    aging: 0,
    stale: 0,
    historical: 0,
    conflicted: 0,
    withdrawn: 0,
  }),
  uncertainties: Object.freeze({ listed: 0, total: 0, items: Object.freeze([]) }),
  conflicts: Object.freeze({ listed: 0, total: 0, items: Object.freeze([]) }),
})

export const ABSENT_WORLD_ENTITY_LIST: WorldEntityListView = Object.freeze({
  ...ABSENT_WORLD_HEADER,
  entities: Object.freeze([]) as readonly WorldEntityNodeView[],
  filter: Object.freeze({ kind: null, includeWithdrawn: false }),
  entitiesRetained: 0,
  entitiesTotal: 0,
  entitiesHidden: 0,
})

export const ABSENT_WORLD_ENTITY_DETAIL: WorldEntityDetailView = Object.freeze({
  ...ABSENT_WORLD_HEADER,
  entity: null,
  entityId: '',
  edges: Object.freeze([]) as readonly WorldEdgeView[],
  evidenceIds: Object.freeze([]) as readonly string[],
  conflicts: Object.freeze([]) as readonly WorldConflictView[],
  edgesRetained: 0,
  edgesTotal: 0,
  edgesHidden: 0,
  neighbours: Object.freeze([]) as WorldEntityDetailView['neighbours'],
})

export const ABSENT_WORLD_GRAPH: WorldRelationGraphView = Object.freeze({
  ...ABSENT_WORLD_HEADER,
  nodes: Object.freeze([]) as readonly WorldEntityNodeView[],
  edges: Object.freeze([]) as readonly WorldEdgeView[],
  focusEntityId: null,
  nodesRetained: 0,
  nodesTotal: 0,
  nodesHidden: 0,
  edgesRetained: 0,
  edgesTotal: 0,
  edgesHidden: 0,
  scope: 'empty' as const,
})

/* ---------------------------------------------------------------- command */

export type WorldCommandOperation =
  | 'summary'
  | 'entities'
  | 'entity'
  | 'relations'
  | 'self'
  | 'submitted'
  | 'withdrawn'
  | 'refused'

export type WorldRefusalCodeView = string

/**
 * One world command's answer.
 *
 * A refusal is an outcome rather than an exception, and `ok: false` is set on the
 * envelope as well as here — a window that read only the envelope would otherwise
 * render a refusal as a success, which is the failure this slot exists to prevent.
 */
export type WorldCommandOutcome =
  | { readonly operation: 'summary'; readonly ok: true; readonly summary: WorldSummaryView }
  | { readonly operation: 'entities'; readonly ok: true; readonly entities: WorldEntityListView }
  | {
      readonly operation: 'entity'
      readonly ok: true
      readonly entity: WorldEntityDetailView
      readonly found: boolean
    }
  | { readonly operation: 'relations'; readonly ok: true; readonly relations: WorldRelationGraphView }
  | { readonly operation: 'self'; readonly ok: true; readonly self: SelfStatusView }
  | {
      readonly operation: 'submitted' | 'withdrawn'
      readonly ok: true
      readonly evidenceId: string
      readonly summary: WorldSummaryView
    }
  | {
      readonly operation: 'refused'
      readonly ok: false
      readonly code: WorldRefusalCodeView
      readonly reason: string
    }

/** The evidence kinds an owner submission may carry. A closed answer, not a type. */
export const OWNER_SUBMITTABLE_EVIDENCE_KINDS: readonly WorldEvidenceKind[] = Object.freeze([
  'entity',
  'relation',
  'unknown',
  'withdrawal',
])