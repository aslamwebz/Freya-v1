import type { Confidence, EpistemicStatus, SourceTrust } from '../brain/types'
import type {
  WorldClaimKind,
  WorldEdgeOrigin,
  WorldEntityKind,
  WorldEvidenceRecord,
  WorldFreshness,
  WorldReferenceDomain,
  ReferenceWorldEntityKind,
  WorldRelationType,
} from './types'
import {
  WORLD_OWNER_ENTITY_ID,
  WORLD_SELF_ENTITY_ID,
  WORLD_SELF_ENTITY_NAME,
} from './types'

/**
 * THE FOLDED WORLD.
 *
 * What the model looks like once the evidence has been folded: nodes, edges and
 * the counts that make truncation visible.
 *
 * ## Two populations, and the line between them
 *
 * A node is either a **reference** — a live pointer into a domain that owns its
 * truth — or an **evidence-backed** entity that this domain stores. Reference
 * nodes are rebuilt from the owning domain on every projection and are never
 * persisted: a Mission cancelled ten seconds ago is cancelled in the graph now,
 * because there is no copy to go stale.
 *
 * Evidence-backed nodes are the only thing here that comes out of storage, and
 * the only thing an admission can create.
 *
 * ## Nothing here is a copy of anything
 *
 * `WorldReferenceState.status` is the owning domain's own closed label, read
 * through a narrow port. No title, no intent, no summary, no content: the Mission
 * domain's private store has nothing to do with this module, and neither does
 * Brain memory content, a Skill body or a journal line.
 */

/** An attribute key and the *length* of its value. The value is never stored here. */
export interface WorldAttributeKey {
  readonly key: string
  readonly valueLength: number
}

/** What the owning domain currently says about a referenced record. */
export interface WorldReferenceState {
  readonly domain: WorldReferenceDomain
  readonly recordId: string
  /** The owning domain's own closed label, in its own words. */
  readonly status: string
  /** Whether that domain considers this record finished. Drives `historical`. */
  readonly terminal: boolean
  /** When the owning domain last changed it, when it says. */
  readonly observedAt: string | null
}

/**
 * One node in the graph.
 *
 * Every field is an id, a closed label, an instant, a count or a measured length —
 * plus `name`, which a graph cannot be drawn without. `deferred` exists so a kind
 * with no evidence path can be named and refused rather than quietly missing.
 */
export interface WorldEntityNode {
  readonly entityId: string
  readonly kind: WorldEntityKind
  /** A canonical name for a named or singleton entity. Null for a reference id. */
  readonly name: string | null
  /** A label the owning domain gave it, for reference nodes only. */
  readonly label: string | null
  readonly aliases: readonly string[]
  /** Keys and lengths only. An attribute value is the owner's own words. */
  readonly attributeKeys: readonly WorldAttributeKey[]
  /** Live state from the owning domain. Null for an evidence-backed entity. */
  readonly reference: WorldReferenceState | null
  /** Which kind of claim this node rests on. `domain_record` for a reference. */
  readonly claimKind: WorldClaimKind
  readonly epistemic: EpistemicStatus
  readonly confidence: Confidence
  readonly freshness: WorldFreshness
  readonly evidenceIds: readonly string[]
  readonly edgeIds: readonly string[]
  /** The authoritative record this node was read from, for a reference node. */
  readonly sourceRef: string | null
  readonly firstObservedAt: string
  readonly lastObservedAt: string
  /** Whether anything about this node is disputed. */
  readonly contested: boolean
  readonly withdrawn: boolean
  /** A Core-owned singleton: `ent_freya` or `ent_owner`. */
  readonly singleton: boolean
  /**
   * Backed only by evidence too sensitive to project.
   *
   * Counted in the summary and present in no listing, exactly like a withheld edge.
   * Being told that a credential exists is a legitimate thing to know; being handed
   * the credential is not, and a graph is the worst possible place for one.
   */
  readonly withheld: boolean
}

/**
 * One typed edge.
 *
 * Exactly one of `toEntityId` and `literalValue` is set, so "the relation points
 * at nothing" is not expressible. `origin` separates the two populations that must
 * never be read alike: `domain_record` is something Core recorded, `admitted_evidence`
 * is something somebody said.
 */
export interface WorldEdge {
  readonly edgeId: string
  readonly relationType: WorldRelationType
  readonly directed: boolean
  readonly fromEntityId: string
  readonly toEntityId: string | null
  /** A stated value rather than a pointer. Never both, never neither. */
  readonly literalValue: string | null
  readonly literalValueLength: number
  readonly origin: WorldEdgeOrigin
  readonly claimKind: WorldClaimKind
  readonly epistemic: EpistemicStatus
  readonly confidence: Confidence
  readonly source: SourceTrust
  readonly actor: string
  /** An id. Never content. */
  readonly sourceRef: string | null
  /** When the thing was observed, which is not when it was written down. */
  readonly observedAt: string
  readonly recordedAt: string
  /** Bitemporal: null while still current. */
  readonly validFrom: string
  readonly validUntil: string | null
  readonly freshness: WorldFreshness
  /** The evidence record this edge was folded from. Null for a derived edge. */
  readonly evidenceId: string | null
  /** Edge ids this one disagrees with. Both sides list both ids. */
  readonly conflictsWith: readonly string[]
  /** The record that retired this edge, when something superseded it. */
  readonly supersededBy: string | null
  readonly superseded: readonly string[]
  /** The referenced record does not exist in the domain that should own it. */
  readonly dangling: boolean
  /**
   * Sensitive enough that it is counted and never projected.
   *
   * The fact that a credential exists is a legitimate thing to know; the
   * credential is not. The Brain says the same about `secret-reference`, and this
   * is that rule applied to the world graph.
   */
  readonly withheld: boolean
}

/** The narrow read port an authoritative domain fills. One shape, all domains. */
export interface WorldReferenceRecord {
  readonly kind: ReferenceWorldEntityKind
  readonly id: string
  /** The domain's own display label, when it has one that is safe to show. */
  readonly label: string | null
  /** The domain's own closed status label, in its own words. */
  readonly status: string
  readonly terminal: boolean
  readonly observedAt: string | null
  /** A parent pointer, when the domain records one (`run.parentKind/parentId`). */
  readonly parentKind?: string | null
  readonly parentId?: string | null
  /** A team pointer, for a Workforce worker. */
  readonly teamId?: string | null
  /** An assignment pointer, for a Workforce worker. */
  readonly assignment?: { readonly kind: string; readonly id: string } | null
}

/** Everything the world is folded into, plus the counts that expose truncation. */
export interface WorldState {
  readonly nodes: ReadonlyMap<string, WorldEntityNode>
  readonly edges: ReadonlyMap<string, WorldEdge>
  /** Every retained evidence record, in replay order. */
  readonly records: readonly WorldEvidenceRecord[]
  /** Highest sequence folded, so a window can prove it is looking at current state. */
  readonly sequence: number
}

export function emptyWorldState(): WorldState {
  return { nodes: new Map(), edges: new Map(), records: [], sequence: 0 }
}

/**
 * The two Core-owned singletons.
 *
 * Present from the first projection whether or not any evidence exists, because
 * "who is Freya" and "who is the owner" are answers Core has by construction
 * rather than by observation. They are built here, from module constants, and
 * there is no admission path that can reach them — which is the whole identity
 * spoofing defence in one function.
 */
export function singletonNodes(now: string): readonly WorldEntityNode[] {
  return [
    {
      entityId: WORLD_SELF_ENTITY_ID,
      kind: 'self',
      name: WORLD_SELF_ENTITY_NAME,
      label: null,
      aliases: [],
      attributeKeys: [],
      reference: null,
      claimKind: 'domain_record',
      // Freya's existence is not a claim she made and not something she inferred.
      // It is a property of this build, so it is as verified as anything gets.
      epistemic: 'verified',
      confidence: 'verified',
      freshness: 'current',
      evidenceIds: [],
      edgeIds: [],
      sourceRef: null,
      firstObservedAt: now,
      lastObservedAt: now,
      contested: false,
      withdrawn: false,
      singleton: true,
      withheld: false,
    },
    {
      entityId: WORLD_OWNER_ENTITY_ID,
      kind: 'person',
      name: 'owner',
      label: null,
      aliases: [],
      attributeKeys: [],
      reference: null,
      claimKind: 'owner_statement',
      epistemic: 'asserted',
      confidence: 'high',
      freshness: 'current',
      evidenceIds: [],
      edgeIds: [],
      sourceRef: null,
      firstObservedAt: now,
      lastObservedAt: now,
      contested: false,
      withdrawn: false,
      singleton: true,
      withheld: false,
    },
  ]
}

/* ------------------------------------------------------------- ordering */

/**
 * A total order over nodes, so every listing is reproducible.
 *
 * By kind, then by name, then by id. The id tie-break is not decoration: without
 * it two nodes with the same kind and the same name would order by whatever the
 * map happened to yield, and a projection that reorders between reads is a
 * projection nobody can diff.
 */
export function orderedWorldNodes(nodes: Iterable<WorldEntityNode>): WorldEntityNode[] {
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1
    const aName = a.name ?? a.label ?? ''
    const bName = b.name ?? b.label ?? ''
    if (aName !== bName) return aName < bName ? -1 : 1
    return a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0
  })
}

/** A total order over edges: subject, relation, object, then id. */
export function orderedWorldEdges(edges: Iterable<WorldEdge>): WorldEdge[] {
  return [...edges].sort((a, b) => {
    if (a.fromEntityId !== b.fromEntityId) return a.fromEntityId < b.fromEntityId ? -1 : 1
    if (a.relationType !== b.relationType) return a.relationType < b.relationType ? -1 : 1
    const aObject = a.toEntityId ?? a.literalValue ?? ''
    const bObject = b.toEntityId ?? b.literalValue ?? ''
    if (aObject !== bObject) return aObject < bObject ? -1 : 1
    return a.edgeId < b.edgeId ? -1 : a.edgeId > b.edgeId ? 1 : 0
  })
}

/**
 * A total order over evidence records: replay order, then id.
 *
 * Sequence is unique in practice, so the id tie-break is belt and braces — but a
 * fold that depends on a uniqueness the caller did not promise is a fold that can
 * disagree with itself.
 */
export function orderedWorldRecords(
  records: readonly WorldEvidenceRecord[],
): readonly WorldEvidenceRecord[] {
  return [...records].sort((a, b) => {
    if (a.sequence !== b.sequence) return a.sequence - b.sequence
    return a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : 0
  })
}