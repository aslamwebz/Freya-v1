import type {
  SelfStatusView,
  WorldConflictView,
  WorldEdgeView,
  WorldEntityDetailView,
  WorldEntityListView,
  WorldEntityNodeView,
  WorldProvenanceView,
  WorldRelationGraphView,
  WorldSummaryView,
  WorldViewHeader,
} from '../protocol/world'
import { buildWorldSelfModel, type WorldSelfModel, type WorldSelfSource } from './self'
import { orderedWorldEdges, orderedWorldNodes, type WorldEdge, type WorldEntityNode, type WorldState } from './state'
import type { WorldConflict } from './relations'
import type {
  WorldClaimKind,
  WorldEntityKind,
  WorldFreshness,
  WorldLimits,
} from './types'

/**
 * PROJECTION — the only route from world state to a window.
 *
 * Pure. It reads the folded state and the live domain references and produces views.
 * It holds no provider, no gateway, no authority object and no clock: every instant
 * it needs is passed in. That is why a projection cannot spend a model call, and it
 * is asserted by a red-team test with a counting provider rather than by a comment.
 *
 * ## What is deliberately dropped on the way out
 *
 * - **Attribute values.** Only keys and lengths survive.
 * - **Evidence summaries.** Only a length and a presence flag.
 * - **Untrusted literals.** Rendered verbatim only for the owner's and Core's own
 *   claims; everything else is a length, with `literalWithheld` saying so.
 * - **Withheld evidence.** Counted in the summary and present nowhere else.
 * - **Evidence ids on list and graph nodes.** They are on the detail view, where a
 *   person has deliberately opened one entity and asked where it came from.
 */

/**
 * Whether an edge may be drawn.
 *
 * Three exclusions, and the third is the one that matters most:
 *
 * 1. Withdrawn — evidence a person took back is not a stale truth, it is nothing.
 * 2. Withheld — too sensitive to project. Counted in the summary, present nowhere.
 * 3. **Dangling at either end.** An edge whose subject or object has been withdrawn
 *    is not shown, because the alternative is a line running to a node that is not on
 *    the graph — which reads as a fact about a thing the surface says does not exist.
 */
function isLiveEdge(state: WorldState, edge: WorldEdge): boolean {
  if (edge.freshness === 'withdrawn' || edge.withheld) return false
  if (state.nodes.get(edge.fromEntityId)?.withdrawn === true) return false
  if (edge.toEntityId !== null && state.nodes.get(edge.toEntityId)?.withdrawn === true) return false
  return true
}

/** Health and limits, as every view reports them. */
function headerFor(
  health: 'ready' | 'unavailable',
  reason: string | null,
  sequence: number,
  persistence: WorldViewHeader['persistence'],
  limits: WorldLimits,
): WorldViewHeader {
  return {
    health,
    reason,
    schemaVersion: 1,
    sequence,
    persistence,
    limits: {
      maxProjectionEntities: limits.maxProjectionEntities,
      maxProjectionEdges: limits.maxProjectionEdges,
      maxEntityDetailEdges: limits.maxEntityDetailEdges,
      maxGraphDepth: limits.maxGraphDepth,
      maxConflictsListed: limits.maxConflictsListed,
      maxBeliefsListed: limits.maxBeliefsListed,
      maxUncertaintiesListed: limits.maxUncertaintiesListed,
      maxEvidenceRecords: limits.maxEvidenceRecords,
      maxEntities: limits.maxEntities,
      maxEdges: limits.maxEdges,
      freshnessHorizonMs: limits.freshnessHorizonMs,
      staleAfterMs: limits.staleAfterMs,
    },
  }
}

/** Channels whose stated values may be rendered verbatim. */
const VERBATIM_LITERAL_SOURCES: readonly WorldClaimKind[] = Object.freeze([
  'domain_record',
  'owner_statement',
  'external_observation',
])

export function projectWorldSummary(
  state: WorldState,
  conflicts: readonly WorldConflict[],
  withheld: number,
  danglingEdgeIds: readonly string[],
  uncertainty: { listed: number; total: number; items: readonly WorldSelfModel['uncertainties']['items'][number][] },
  beliefs: number,
  persistence: WorldViewHeader['persistence'],
  limits: WorldLimits,
  sequence: number,
  health: 'ready' | 'unavailable' = 'ready',
  reason: string | null = null,
): WorldSummaryView {
  const nodes = [...state.nodes.values()].filter((node) => !node.withdrawn)
  const edges = [...state.edges.values()].filter((edge) => isLiveEdge(state, edge))

  const byClaimKind: Record<WorldClaimKind, number> = {
    domain_record: 0,
    owner_statement: 0,
    external_observation: 0,
    model_hypothesis: 0,
    third_party_claim: 0,
    unknown: 0,
  }
  for (const edge of edges) byClaimKind[edge.claimKind] += 1

  const byFreshness: Record<WorldFreshness, number> = {
    current: 0,
    aging: 0,
    stale: 0,
    historical: 0,
    conflicted: 0,
    withdrawn: 0,
  }
  for (const edge of edges) byFreshness[edge.freshness] += 1

  const withdrawnRecords = state.records.filter((record) => {
    return conflicts.length >= 0 && record.kind === 'withdrawal'
  }).length
  const supersededRecords = new Set(
    state.records.map((record) => record.supersedes).filter((id): id is string => id !== null),
  ).size

  return {
    ...headerFor(health, reason, sequence, persistence, limits),
    counts: {
      entities: nodes.length,
      referenceEntities: nodes.filter((node) => node.reference !== null).length,
      evidenceBackedEntities: nodes.filter((node) => node.reference === null && !node.singleton).length,
      edges: edges.length,
      derivedEdges: edges.filter((edge) => edge.origin === 'domain_record').length,
      claimedEdges: edges.filter((edge) => edge.origin === 'admitted_evidence').length,
      evidenceRecords: state.records.length,
      withdrawnRecords,
      supersededRecords,
      danglingEdges: danglingEdgeIds.length,
      withheld,
      conflicts: conflicts.length,
      beliefs,
    },
    byClaimKind,
    byFreshness,
    uncertainties: {
      listed: uncertainty.listed,
      total: uncertainty.total,
      items: uncertainty.items.map((item) => ({
        entityId: item.entityId,
        kind: item.kind,
        reason: item.reason,
      })),
    },
    conflicts: {
      listed: Math.min(conflicts.length, limits.maxConflictsListed),
      total: conflicts.length,
      items: conflicts
        .slice(0, limits.maxConflictsListed)
        .map((conflict) => projectConflict(conflict)),
    },
  }
}

export function projectWorldNode(node: WorldEntityNode): WorldEntityNodeView {
  return {
    entityId: node.entityId,
    kind: node.kind,
    name: node.name,
    label: node.label,
    aliases: [...node.aliases],
    attributeKeys: node.attributeKeys.map((entry) => ({ key: entry.key, valueLength: entry.valueLength })),
    reference:
      node.reference === null
        ? null
        : {
            domain: node.reference.domain,
            recordId: node.reference.recordId,
            status: node.reference.status,
            terminal: node.reference.terminal,
            observedAt: node.reference.observedAt,
          },
    claimKind: node.claimKind,
    epistemic: node.epistemic,
    confidence: node.confidence,
    freshness: node.freshness,
    contested: node.contested,
    withdrawn: node.withdrawn,
    singleton: node.singleton,
    sourceRef: node.sourceRef,
    firstObservedAt: node.firstObservedAt,
    lastObservedAt: node.lastObservedAt,
    edgeCount: node.edgeIds.length,
    evidenceCount: node.evidenceIds.length,
  }
}

export function projectWorldProvenance(edge: WorldEdge): WorldProvenanceView {
  return {
    claimKind: edge.claimKind,
    source: edge.source,
    epistemic: edge.epistemic,
    confidence: edge.confidence,
    actor: edge.actor,
    sourceRef: edge.sourceRef,
    observedAt: edge.observedAt,
    recordedAt: edge.recordedAt,
    evidenceSummaryLength: 0,
    evidenceSummaryPresent: false,
    sensitivity: null,
  }
}

export function projectWorldEdge(edge: WorldEdge, summaryLength: number, summaryPresent: boolean): WorldEdgeView {
  const verbatim = VERBATIM_LITERAL_SOURCES.includes(edge.claimKind)
  return {
    edgeId: edge.edgeId,
    relationType: edge.relationType,
    directed: edge.directed,
    fromEntityId: edge.fromEntityId,
    toEntityId: edge.toEntityId,
    literalValue: verbatim ? edge.literalValue : null,
    literalValueLength: edge.literalValueLength,
    literalWithheld: edge.literalValue !== null && !verbatim,
    origin: edge.origin,
    freshness: edge.freshness,
    contested: edge.conflictsWith.length > 1,
    conflictsWith: [...edge.conflictsWith],
    supersededBy: edge.supersededBy,
    dangling: edge.dangling,
    provenance: {
      claimKind: edge.claimKind,
      source: edge.source,
      epistemic: edge.epistemic,
      confidence: edge.confidence,
      actor: edge.actor,
      sourceRef: edge.sourceRef,
      observedAt: edge.observedAt,
      recordedAt: edge.recordedAt,
      evidenceSummaryLength: summaryLength,
      evidenceSummaryPresent: summaryPresent,
      // Always null, and that is the point rather than an omission: an edge whose
      // evidence is `sensitive` or `secret-reference` is never projected at all, so
      // there is no such edge available to label. The count of withheld evidence
      // lives in the summary, which is where a person learns that something exists
      // without learning what it says.
      sensitivity: null,
    },
    evidenceId: edge.evidenceId,
  }
}

export function projectConflict(conflict: WorldConflict): WorldConflictView {
  return {
    subjectEntityId: conflict.subjectEntityId,
    relationType: conflict.relationType,
    objectKey: conflict.objectKey,
    edgeIds: [...conflict.edgeIds],
    evidenceIds: [...conflict.evidenceIds],
    reason: conflict.reason,
  }
}

export interface WorldEntityListOptions {
  readonly kind: WorldEntityKind | null
  readonly includeWithdrawn: boolean
}

export function projectWorldEntityList(
  state: WorldState,
  options: WorldEntityListOptions,
  persistence: WorldViewHeader['persistence'],
  limits: WorldLimits,
  sequence: number,
): WorldEntityListView {
  // A withheld node is excluded even from the "include withdrawn" listing: that flag is
  // about claims a person took back, which is a different question from a claim that
  // was too private to show.
  const all = orderedWorldNodes(state.nodes.values()).filter(
    (node) => !node.withheld && (options.includeWithdrawn || !node.withdrawn),
  )
  const filtered = options.kind === null ? all : all.filter((node) => node.kind === options.kind)
  const listed = filtered.slice(0, limits.maxProjectionEntities)

  return {
    ...headerFor('ready', null, sequence, persistence, limits),
    entities: listed.map(projectWorldNode),
    filter: { kind: options.kind, includeWithdrawn: options.includeWithdrawn },
    entitiesRetained: listed.length,
    entitiesTotal: filtered.length,
    entitiesHidden: filtered.length - listed.length,
  }
}

export function projectWorldEntityDetail(
  state: WorldState,
  entityId: string,
  conflicts: readonly WorldConflict[],
  summaries: ReadonlyMap<string, { readonly length: number; readonly present: boolean }>,
  persistence: WorldViewHeader['persistence'],
  limits: WorldLimits,
  sequence: number,
): WorldEntityDetailView {
  const node = state.nodes.get(entityId) ?? null
  if (node === null || node.withheld) {
    // A withheld node answers as if it were not there. Returning it with a flag set
    // would mean the flag is the only thing standing between a caller that forgot to
    // check and a name the owner never agreed to show.
    return {
      ...headerFor('ready', null, sequence, persistence, limits),
      entity: null,
      entityId,
      edges: [],
      evidenceIds: [],
      conflicts: [],
      edgesRetained: 0,
      edgesTotal: 0,
      edgesHidden: 0,
      neighbours: [],
    }
  }

  const all = orderedWorldEdges(state.edges.values()).filter(
    (edge) => edge.fromEntityId === entityId || edge.toEntityId === entityId,
  )
  const live = all.filter((edge) => isLiveEdge(state, edge))
  const listed = live.slice(0, limits.maxEntityDetailEdges)

  const neighbours = new Map<string, { relationType: string; directed: boolean; outgoing: boolean; incoming: boolean }>()
  for (const edge of listed) {
    const other = edge.fromEntityId === entityId ? edge.toEntityId : edge.fromEntityId
    if (other === null) continue
    const existing = neighbours.get(other)
    const outgoing = edge.fromEntityId === entityId
    const incoming = edge.toEntityId === entityId
    if (existing === undefined) {
      neighbours.set(other, { relationType: edge.relationType, directed: edge.directed, outgoing, incoming })
      continue
    }
    existing.outgoing ||= outgoing
    existing.incoming ||= incoming
  }

  return {
    ...headerFor('ready', null, sequence, persistence, limits),
    entity: projectWorldNode(node),
    entityId,
    edges: listed.map((edge) => {
      const summary = summaries.get(edge.edgeId)
      return projectWorldEdge(edge, summary?.length ?? 0, summary?.present ?? false)
    }),
    evidenceIds: [...node.evidenceIds],
    conflicts: conflicts.filter(
      (conflict) => conflict.subjectEntityId === entityId || conflict.edgeIds.some((id) => node.edgeIds.includes(id)),
    ).map(projectConflict),
    edgesRetained: listed.length,
    edgesTotal: live.length,
    edgesHidden: live.length - listed.length,
    neighbours: [...neighbours.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([id, value]) => ({
        entityId: id,
        relationType: value.relationType as WorldEdge['relationType'],
        directed: value.directed,
        direction: (value.outgoing && value.incoming
          ? 'both'
          : value.outgoing
            ? 'outgoing'
            : 'incoming') as 'outgoing' | 'incoming' | 'both',
        freshness: 'current' as WorldFreshness,
      })),
  }
}

export interface WorldGraphOptions {
  readonly focusEntityId: string | null
  readonly kinds: readonly WorldEntityKind[] | null
  readonly maxDepth: number
}

export function projectWorldGraph(
  state: WorldState,
  options: WorldGraphOptions,
  summaries: ReadonlyMap<string, { readonly length: number; readonly present: boolean }>,
  persistence: WorldViewHeader['persistence'],
  limits: WorldLimits,
  sequence: number,
): WorldRelationGraphView {
  const allNodes = orderedWorldNodes(state.nodes.values()).filter(
    (node) => !node.withdrawn && !node.withheld,
  )
  const kinds = options.kinds
  const totalNodes =
    kinds === null ? allNodes.length : allNodes.filter((node) => kinds.includes(node.kind)).length
  const allEdges = orderedWorldEdges(state.edges.values()).filter((edge) => isLiveEdge(state, edge))

  let scopedNodes = allNodes
  let scopedEdges = allEdges
  let scope: WorldRelationGraphView['scope'] = 'whole_world'

  if (options.focusEntityId !== null && state.nodes.has(options.focusEntityId)) {
    // A neighbourhood, bounded by `maxDepth` hops, so opening one entity in a large
    // world cannot return the whole world by accident.
    const keep = new Set<string>([options.focusEntityId])
    let frontier = new Set<string>([options.focusEntityId])
    for (let hop = 0; hop < options.maxDepth; hop += 1) {
      const next = new Set<string>()
      for (const edge of allEdges) {
        if (!edge.directed && !frontier.has(edge.fromEntityId) && !frontier.has(edge.toEntityId ?? '')) continue
        if (frontier.has(edge.fromEntityId) && edge.toEntityId !== null) next.add(edge.toEntityId)
        if (frontier.has(edge.toEntityId ?? '')) next.add(edge.fromEntityId)
      }
      for (const id of next) {
        if (keep.size >= limits.maxProjectionEntities) break
        keep.add(id)
      }
      frontier = next
      if (keep.size >= limits.maxProjectionEntities) break
    }
    scopedNodes = allNodes.filter((node) => keep.has(node.entityId))
    scopedEdges = allEdges.filter(
      (edge) => keep.has(edge.fromEntityId) && (edge.toEntityId === null || keep.has(edge.toEntityId)),
    )
    scope = 'neighbourhood'
  }

  if (kinds !== null) {
    const allowed = new Set(kinds)
    scopedNodes = scopedNodes.filter((node) => allowed.has(node.kind))
    const ids = new Set(scopedNodes.map((node) => node.entityId))
    scopedEdges = scopedEdges.filter(
      (edge) => ids.has(edge.fromEntityId) && (edge.toEntityId === null || ids.has(edge.toEntityId)),
    )
  }

  if (scopedNodes.length === 0) scope = 'empty'

  const listedNodes = scopedNodes.slice(0, limits.maxProjectionEntities)
  const listedNodeIds = new Set(listedNodes.map((node) => node.entityId))
  const boundedEdges = scopedEdges
    .filter((edge) => listedNodeIds.has(edge.fromEntityId) && (edge.toEntityId === null || listedNodeIds.has(edge.toEntityId)))
    .slice(0, limits.maxProjectionEdges)

  return {
    ...headerFor('ready', null, sequence, persistence, limits),
    nodes: listedNodes.map(projectWorldNode),
    edges: boundedEdges.map((edge) => {
      const summary = summaries.get(edge.edgeId)
      return projectWorldEdge(edge, summary?.length ?? 0, summary?.present ?? false)
    }),
    focusEntityId: options.focusEntityId,
    nodesRetained: listedNodes.length,
    nodesTotal: totalNodes,
    nodesHidden: totalNodes - listedNodes.length,
    edgesRetained: boundedEdges.length,
    edgesTotal: scopedEdges.length,
    edgesHidden: scopedEdges.length - boundedEdges.length,
    scope,
  }
}

/** The self model, as a surface sees it. */
export function projectWorldSelf(
  state: WorldState,
  source: WorldSelfSource,
  limits: WorldLimits,
  sequence: number,
): SelfStatusView {
  return buildWorldSelfModel(state, source, limits, sequence)
}