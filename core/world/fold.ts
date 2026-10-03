import { SENSITIVITY_RANK, type EpistemicStatus } from '../brain/types'
import {
  WORLD_OWNER_ENTITY_ID,
  WORLD_SELF_ENTITY_ID,
  isReferenceWorldEntityKind,
  worldClaimKindFor,
  worldRelationSpec,
  type NamedWorldEntityKind,
  type ReferenceWorldEntityKind,
  type WorldEndpointClaim,
  type WorldEntityKind,
  type WorldEvidenceRecord,
  type WorldLimits,
  type WorldRelationType,
} from './types'
import {
  domainEdgeId,
  evidenceEdgeId,
  deriveEntityId,
  deriveReferenceId,
  isWorldEvidenceId,
  normaliseWorldName,
} from './identity'
import {
  orderedWorldRecords,
  singletonNodes,
  type WorldEdge,
  type WorldEntityNode,
  type WorldReferenceRecord,
  type WorldReferenceState,
  type WorldState,
} from './state'
import {
  edgeFreshness,
  findWorldConflicts,
  isDanglingEdge,
  isWorldProjectionVisible,
  nodeFreshness,
  type WorldConflict,
} from './relations'

/**
 * THE FOLD.
 *
 * Evidence records in, nodes and edges out. Pure, deterministic, and the only
 * place in this domain where the shape of the world is decided.
 *
 * ## Determinism is the property everything else rests on
 *
 * Two runs over the same records produce the same world, byte for byte. Three
 * decisions make that true:
 *
 * 1. **Entity and edge ids are content-derived** (`identity.ts`), so nothing
 *    depends on the order records arrived in.
 * 2. **Every list has a total order** with an id tie-break (`state.ts`).
 * 3. **Freshness comes from record instants against an injected `now`**, so
 *    nothing here reads the wall clock.
 *
 * That is what lets a restart reproduce a projection rather than approximately
 * reproduce one.
 *
 * ## The fold never decides who is right
 *
 * Conflicting evidence produces two edges and a conflict record. There is no
 * branch here that picks a winner, because a fold that resolves disagreements
 * makes the disagreements unrepresentable, and unrepresentable disagreements are
 * how a system becomes confidently wrong.
 */

/** The current shape of a node while the fold is building it. */
interface NodeDraft {
  entityId: string
  kind: WorldEntityKind
  name: string | null
  label: string | null
  aliases: Set<string>
  attributeKeys: Map<string, number>
  reference: WorldReferenceState | null
  claimKind: WorldEntityNode['claimKind']
  epistemic: EpistemicStatus
  confidence: WorldEntityNode['confidence']
  evidenceIds: Set<string>
  /** Evidence ids that may be projected; the complement of `withheldEvidence`. */
  visibleEvidence: Set<string>
  edgeIds: Set<string>
  sourceRef: string | null
  firstObservedAt: string
  lastObservedAt: string
  withdrawn: boolean
  singleton: boolean
  /** Backed only by evidence too sensitive to project. */
  withheld: boolean
  ownFreshness: WorldEntityNode['freshness']
}

/** What the fold produced, plus what it had to refuse to place. */
export interface WorldFoldResult {
  readonly state: WorldState
  /** Every unresolved disagreement, for the summary to disclose. */
  readonly conflicts: readonly WorldConflict[]
  /** Claims pointing at a reference record the owning domain does not have. */
  readonly danglingEdgeIds: readonly string[]
  /** Evidence too sensitive to project, by id. Counted, never rendered. */
  readonly withheldEvidenceIds: readonly string[]
}

/**
 * Fold retained evidence records into the world.
 *
 * `records` are replayed in sequence order; `references` are the live records the
 * owning domains report right now. Neither is read for anything but its own
 * fields, and nothing outside this function's arguments can influence the result.
 */
export function foldWorld(
  records: readonly WorldEvidenceRecord[],
  references: readonly WorldReferenceRecord[],
  now: Date,
  limits: WorldLimits,
): WorldFoldResult {
  const drafts = new Map<string, NodeDraft>()
  const edgeDrafts = new Map<string, WorldEdge>()
  const withheldEvidenceIds: string[] = []
  const seenEvidence = new Set<string>()

  // Singletons first: they are answers Core has by construction, so they are
  // present before any evidence is considered and cannot be withdrawn by it.
  for (const node of singletonNodes(now.toISOString())) {
    drafts.set(node.entityId, draftFromNode(node))
  }

  // Reference nodes, rebuilt from the owning domains. Nothing here is stored, so
  // a record that has since been retired simply is not in this list.
  for (const record of references) {
    if (!isReferenceWorldEntityKind(record.kind)) continue
    if (typeof record.id !== 'string' || record.id.length === 0) continue
    const entityId = deriveReferenceId(record.kind, record.id)
    const observedAt = record.observedAt ?? now.toISOString()
    const existing = drafts.get(entityId)
    if (existing !== undefined) continue
    drafts.set(entityId, {
      entityId,
      kind: record.kind,
      name: null,
      label: boundLabel(record.label),
      aliases: new Set(),
      attributeKeys: new Map(),
      reference: {
        domain: domainOf(record.kind),
        recordId: record.id,
        status: record.status,
        terminal: record.terminal,
        observedAt,
      },
      // The one population that is genuinely verified: Core's own record.
      claimKind: 'domain_record',
      epistemic: 'verified',
      confidence: 'verified',
      evidenceIds: new Set(),
      visibleEvidence: new Set(),
      edgeIds: new Set(),
      sourceRef: record.id,
      firstObservedAt: observedAt,
      lastObservedAt: observedAt,
      withdrawn: false,
      singleton: false,
      withheld: false,
      ownFreshness: 'current',
    })
  }

  // A total order over the evidence ids, resolved before the walk so a
  // supersession is known regardless of which of the two records came first.
  const replay = orderedWorldRecords(records)
  const supersededEvidence = new Set<string>()
  for (const record of replay) {
    if (record.supersedes !== null && isWorldEvidenceId(record.supersedes)) {
      supersededEvidence.add(record.supersedes)
    }
  }
  const withdrawnTargets = new Set<string>()
  for (const record of replay) {
    if (record.kind === 'withdrawal' && record.withdrawal !== null) {
      withdrawnTargets.add(record.withdrawal.targetEvidenceId)
    }
  }

  for (const record of replay) {
    if (!isWorldEvidenceId(record.evidenceId) || seenEvidence.has(record.evidenceId)) continue
    seenEvidence.add(record.evidenceId)

    // A record is withdrawn when a later withdrawal names it, and superseded when
    // a later record replaces it. Both are computed from the whole history before
    // the walk, so neither depends on which of the two records came first.
    const isWithdrawn = withdrawnTargets.has(record.evidenceId)
    const visible = isWorldProjectionVisible(SENSITIVITY_RANK[record.sensitivity])
    if (!visible) withheldEvidenceIds.push(record.evidenceId)

    if (record.kind === 'withdrawal') continue
    if (record.entity !== null) {
      foldEntityRecord(
        record,
        drafts,
        isWithdrawn || supersededEvidence.has(record.evidenceId),
        !visible,
        limits,
      )
      continue
    }
    if (record.relation !== null) {
      foldRelationRecord(
        record,
        drafts,
        edgeDrafts,
        isWithdrawn || supersededEvidence.has(record.evidenceId),
        visible,
        limits,
      )
    }
  }

  // Edges Core derived from its own records, after the walk so a reference node
  // exists before anything points at it.
  for (const edge of derivedDomainEdges(references, drafts, now)) {
    if (!edgeDrafts.has(edge.edgeId)) edgeDrafts.set(edge.edgeId, edge)
  }

  const { conflicts, conflictsByEdge } = findWorldConflicts([...edgeDrafts.values()])

  // Freshness last: it depends on conflict state, which depends on the whole set.
  const edges = [...edgeDrafts.values()].map((edge) => ({
    ...edge,
    conflictsWith: conflictsByEdge.get(edge.edgeId) ?? [],
    freshness: edgeFreshness(
      {
        withdrawn: edge.freshness === 'withdrawn',
        conflicted: (conflictsByEdge.get(edge.edgeId) ?? []).length > 1,
        validUntil: edge.validUntil,
        supersededBy: edge.supersededBy,
        observedAt: edge.observedAt,
      },
      now,
      limits,
    ),
    dangling: isDanglingEdge(edge, drafts as unknown as ReadonlyMap<string, { reference: unknown }>),
  }))

  for (const edge of edges) {
    if (edge.withheld) continue
    const from = drafts.get(edge.fromEntityId)
    if (from !== undefined) from.edgeIds.add(edge.edgeId)
    if (edge.toEntityId !== null) {
      const to = drafts.get(edge.toEntityId)
      if (to !== undefined) to.edgeIds.add(edge.edgeId)
    }
  }

  const nodes = [...drafts.values()].map((draft) => finaliseNode(draft, edges, withdrawnTargets, supersededEvidence, now, limits))
  const nodeMap = new Map<string, WorldEntityNode>(nodes.map((node) => [node.entityId, node]))

  // Every edge's contested flag and withheld flag come from the node that owns it,
  // so a claim cannot be shown as settled because its entity was filtered out.
  const settledEdges = edges.map((edge) => ({
    ...edge,
    contested: (conflictsByEdge.get(edge.edgeId) ?? []).length > 1,
  }))

  const state: WorldState = {
    nodes: nodeMap,
    edges: new Map(settledEdges.map((edge) => [edge.edgeId, edge])),
    records: replay,
    sequence: replay.reduce((highest, record) => Math.max(highest, record.sequence), 0),
  }

  return {
    state,
    conflicts,
    danglingEdgeIds: settledEdges.filter((edge) => edge.dangling).map((edge) => edge.edgeId).sort(),
    withheldEvidenceIds: withheldEvidenceIds.sort(),
  }
}

/* ----------------------------------------------------------- entity fold */

function foldEntityRecord(
  record: WorldEvidenceRecord,
  drafts: Map<string, NodeDraft>,
  withdrawn: boolean,
  withheld: boolean,
  limits: WorldLimits,
): void {
  const claim = record.entity
  if (claim === null) return
  const name = normaliseWorldName(claim.name, limits.maxNameChars)
  if (name === null) return
  const entityId = resolveNamedId(claim.entityType, name)
  touchDraft(drafts, entityId, claim.entityType, name, record)
  if (withheld) {
    const draft = drafts.get(entityId)
    if (draft !== undefined) draft.withheld = true
  }

  const draft = drafts.get(entityId)
  if (draft === undefined) return
  // The evidence id is recorded whether or not the record still stands, because the
  // difference between "this entity exists" and "every claim about it was taken back"
  // is exactly what `withdrawn` is derived from downstream.
  draft.evidenceIds.add(record.evidenceId)
  // Sensitive evidence hides the node as well as the edge: an entity that exists only
  // because of a secret-reference claim must not appear in a list either, or the
  // withholding would be a fig leaf over a name.
  if (withheld) draft.withheld = true
  if (withdrawn) return
  for (const alias of claim.aliases) {
    const normalised = normaliseWorldName(alias, limits.maxNameChars)
    if (normalised === null || normalised === name) continue
    if (draft.aliases.size >= limits.maxAliasesPerEntity) break
    draft.aliases.add(normalised)
  }
  for (const [key, value] of Object.entries(claim.attributes)) {
    if (draft.attributeKeys.size >= limits.maxAttributesPerEntity) break
    const trimmed = key.trim()
    if (trimmed.length === 0 || trimmed.length > limits.maxAttributeKeyChars) continue
    if (!/^[\p{L}\p{N} _-]+$/u.test(trimmed)) continue
    draft.attributeKeys.set(trimmed, typeof value === 'string' ? value.length : 0)
  }
}

/* ---------------------------------------------------------- relation fold */

function foldRelationRecord(
  record: WorldEvidenceRecord,
  drafts: Map<string, NodeDraft>,
  edges: Map<string, WorldEdge>,
  withdrawn: boolean,
  visible: boolean,
  limits: WorldLimits,
): void {
  const claim = record.relation
  if (claim === null) return

  const subject = resolveEndpoint(claim.subject, drafts, record, limits)
  if (subject === null) return
  const object = resolveEndpoint(claim.object, drafts, record, limits)
  if (object === null) return
  if (object.kind === 'literal' && !specAcceptsLiteral(claim.relationType)) return

  const toEntityId = object.kind === 'literal' ? null : object.entityId
  const literalValue = object.kind === 'literal' ? object.value : null
  const relationType: WorldRelationType = record.kind === 'unknown' ? 'related_to' : claim.relationType
  const edgeId = evidenceEdgeId(subject.entityId, relationType, toEntityId, literalValue, record.evidenceId)

  const supersedesEdgeId =
    record.supersedes === null ? null : findEdgeOfEvidence(edges, record.supersedes, subject.entityId, relationType)

  const edge: WorldEdge = {
    edgeId,
    relationType,
    directed: worldRelationSpec(relationType).directed,
    fromEntityId: subject.entityId,
    toEntityId,
    literalValue,
    literalValueLength: literalValue === null ? 0 : literalValue.length,
    origin: 'admitted_evidence',
    claimKind: record.kind === 'unknown' ? 'unknown' : worldClaimKindFor(record.channel),
    epistemic: record.kind === 'unknown' ? 'unknown' : record.epistemic,
    confidence: record.kind === 'unknown' ? 'unknown' : record.confidence,
    source: record.source,
    actor: record.actor,
    sourceRef: record.sourceRef,
    observedAt: record.observedAt,
    recordedAt: record.recordedAt,
    validFrom: record.observedAt,
    validUntil: claim.validUntil,
    freshness: 'current',
    evidenceId: record.evidenceId,
    conflictsWith: [],
    supersededBy: null,
    superseded: [],
    dangling: false,
    withheld: !visible,
  }
  if (withdrawn) {
    // Still recorded, still marked withdrawn, and excluded from every listing. Keeping
    // it is what lets the summary say how many claims were taken back rather than
    // making a withdrawal look like the claim never existed.
    edges.set(edgeId, { ...edge, freshness: 'withdrawn' })
    return
  }
  edges.set(edgeId, edge)

  const subjectDraft = drafts.get(subject.entityId)
  if (subjectDraft !== undefined) subjectDraft.evidenceIds.add(record.evidenceId)
  if (toEntityId !== null) {
    const objectDraft = drafts.get(toEntityId)
    if (objectDraft !== undefined) objectDraft.evidenceIds.add(record.evidenceId)
  }
  if (supersedesEdgeId !== null) {
    const supersededEdge = edges.get(supersedesEdgeId)
    if (supersededEdge !== undefined) {
      edges.set(supersedesEdgeId, {
        ...supersededEdge,
        supersededBy: edgeId,
        superseded: [...supersededEdge.superseded, edgeId],
        freshness: 'stale',
      })
      edges.set(edgeId, { ...edge, superseded: [supersedesEdgeId] })
    }
  }
}

/** Whether a relation may state a value rather than point at something. */
function specAcceptsLiteral(relationType: WorldRelationType): boolean {
  const spec = worldRelationSpec(relationType)
  // A literal stands in for an object, so it is admissible exactly where an
  // object entity would be. Every relation in the table accepts an object, which
  // is why this is a table lookup rather than a hard-coded list — a future
  // relation that may only point at a thing will be refused here.
  return spec.objects.length > 0
}

/* --------------------------------------------------------------- helpers */

interface ResolvedClaimEndpoint {
  readonly entityId: string
  readonly kind: 'named' | 'reference' | 'literal' | 'singleton'
  readonly value: string | null
}

function resolveEndpoint(
  endpoint: WorldEndpointClaim,
  drafts: Map<string, NodeDraft>,
  record: WorldEvidenceRecord,
  limits: WorldLimits,
): ResolvedClaimEndpoint | null {
  if (endpoint.form === 'literal') {
    if (typeof endpoint.value !== 'string' || endpoint.value.length === 0) return null
    if (endpoint.value.length > limits.maxLiteralValueChars) return null
    return { entityId: '', kind: 'literal', value: endpoint.value }
  }
  if (endpoint.form === 'reference') {
    if (!isReferenceWorldEntityKind(endpoint.refKind)) return null
    if (typeof endpoint.refId !== 'string' || endpoint.refId.length === 0) return null
    if (endpoint.refId.length > limits.maxSourceRefChars) return null
    return { entityId: deriveReferenceId(endpoint.refKind, endpoint.refId), kind: 'reference', value: null }
  }
  if (!isNamedType(endpoint.entityType)) return null
  if (typeof endpoint.name !== 'string') return null
  const lowered = endpoint.name.trim().toLowerCase()
  if (lowered === 'owner' && endpoint.entityType === 'person') {
    return { entityId: WORLD_OWNER_ENTITY_ID, kind: 'singleton', value: null }
  }
  if (lowered === 'freya') {
    return { entityId: WORLD_SELF_ENTITY_ID, kind: 'singleton', value: null }
  }
  const name = normaliseWorldName(endpoint.name, limits.maxNameChars)
  if (name === null) return null
  const entityId = deriveEntityId(endpoint.entityType, name)
  touchDraft(drafts, entityId, endpoint.entityType, name, record)
  return { entityId, kind: 'named', value: null }
}

function isNamedType(value: string): value is NamedWorldEntityKind {
  return value === 'person' || value === 'project' || value === 'organisation' || value === 'place'
}

/** The singleton ids resolve by name, so a claim about Freya can name her. */
function resolveNamedId(entityType: NamedWorldEntityKind, name: string): string {
  if (entityType === 'person') {
    const lowered = name.trim().toLowerCase()
    if (lowered === 'owner') return WORLD_OWNER_ENTITY_ID
    if (lowered === 'freya') return WORLD_SELF_ENTITY_ID
  }
  return deriveEntityId(entityType, name)
}

/**
 * Create or touch a draft, without ever weakening what is already known.
 *
 * Merge rules, all of which matter:
 *
 * - Evidence that raises confidence raises it; evidence that lowers it does not.
 *   Confidence is not a vote, and one untrusted page must not be able to make a
 *   person's own statement less believed.
 * - The *later* observation sets `lastObservedAt`, so freshness follows the newest
 *   evidence rather than the first.
 * - `firstObservedAt` only ever moves earlier, so an entity's age stays its age.
 */
function touchDraft(
  drafts: Map<string, NodeDraft>,
  entityId: string,
  kind: WorldEntityKind,
  name: string,
  record: WorldEvidenceRecord,
): void {
  const existing = drafts.get(entityId)
  if (existing === undefined) {
    drafts.set(entityId, {
      entityId,
      kind,
      name,
      label: null,
      aliases: new Set(),
      attributeKeys: new Map(),
      reference: null,
      claimKind: worldClaimKindFor(record.channel),
      epistemic: record.epistemic,
      confidence: record.confidence,
      evidenceIds: new Set(),
      visibleEvidence: new Set(),
      edgeIds: new Set(),
      sourceRef: record.sourceRef,
      firstObservedAt: record.observedAt,
      lastObservedAt: record.observedAt,
      withdrawn: false,
      singleton: false,
      withheld: false,
      ownFreshness: 'current',
    })
    return
  }
  if (existing.reference !== null || existing.singleton) return
  draftVisible(record, existing)
  if (rankConfidence(record.confidence) > rankConfidence(existing.confidence)) {
    existing.confidence = record.confidence
  }
  if (rankEpistemic(record.epistemic) > rankEpistemic(existing.epistemic)) {
    existing.epistemic = record.epistemic
  }
  if (existing.sourceRef === null) existing.sourceRef = record.sourceRef
  draftVisible(record, existing)
  if (record.observedAt < existing.firstObservedAt) existing.firstObservedAt = record.observedAt
  if (record.observedAt > existing.lastObservedAt) existing.lastObservedAt = record.observedAt
}

/**
 * Note that an entity exists at all, even when the evidence naming it may not be
 * projected. The *existence* of a sensitive entity is countable; its name is not.
 */
function draftVisible(record: WorldEvidenceRecord, draft: NodeDraft): void {
  draft.visibleEvidence.add(record.evidenceId)
}

function rankConfidence(value: WorldEntityNode['confidence']): number {
  switch (value) {
    case 'verified':
      return 4
    case 'high':
      return 3
    case 'medium':
      return 2
    case 'low':
      return 1
    default:
      return 0
  }
}

/**
 * How settled a claim is, for merging.
 *
 * Only ever used to take the *stronger* of two statements about one entity. It is
 * not a conflict resolver — those are kept, not merged.
 */
function rankEpistemic(value: EpistemicStatus): number {
  switch (value) {
    case 'verified':
      return 5
    case 'observed':
      return 4
    case 'asserted':
      return 3
    case 'inferred':
      return 2
    case 'unknown':
      return 1
    case 'contradicted':
      return 0
    case 'stale':
      return 0
    default:
      return 0
  }
}

function findEdgeOfEvidence(
  edges: Map<string, WorldEdge>,
  evidenceId: string,
  fromEntityId: string,
  relationType: string,
): string | null {
  for (const edge of edges.values()) {
    if (edge.evidenceId === evidenceId && edge.fromEntityId === fromEntityId) {
      if (edge.relationType === relationType) return edge.edgeId
    }
  }
  return null
}

/* ------------------------------------------------------- derived edges */

/**
 * Edges Core derives from its own records.
 *
 * These are not claims and are not stored. They exist because a worker really is
 * assigned to a Mission, because a run really does belong to a task, and because
 * an artifact really was produced by a run — and re-deriving that from Core's
 * authoritative record each time is strictly better than remembering it.
 *
 * Each one carries `epistemic: 'verified'` and a `sourceRef` naming the record it
 * was read from, so a surface can always say where a "fact" in the graph came
 * from — and a claim can never be one.
 */
function derivedDomainEdges(
  references: readonly WorldReferenceRecord[],
  drafts: ReadonlyMap<string, NodeDraft>,
  now: Date,
): WorldEdge[] {
  const derived: WorldEdge[] = []
  const observedAt = now.toISOString()

  const push = (
    from: { readonly kind: ReferenceWorldEntityKind; readonly id: string },
    relationType: WorldRelationType,
    to: { readonly kind: ReferenceWorldEntityKind; readonly id: string },
    sourceRef: string,
  ): void => {
    const spec = worldRelationSpec(relationType)
    if (!spec.subjects.includes(from.kind) || !spec.objects.includes(to.kind)) return
    const fromEntityId = deriveReferenceId(from.kind, from.id)
    const toEntityId = deriveReferenceId(to.kind, to.id)
    if (fromEntityId === toEntityId) return
    if (!drafts.has(fromEntityId) || !drafts.has(toEntityId)) return
    const edgeId = domainEdgeId(fromEntityId, relationType, toEntityId, sourceRef)
    derived.push({
      edgeId,
      relationType,
      directed: spec.directed,
      fromEntityId,
      toEntityId,
      literalValue: null,
      literalValueLength: 0,
      origin: 'domain_record',
      claimKind: 'domain_record',
      epistemic: 'verified',
      confidence: 'verified',
      source: 'system-observation',
      actor: 'system',
      sourceRef,
      observedAt,
      recordedAt: observedAt,
      validFrom: observedAt,
      validUntil: null,
      freshness: 'current',
      evidenceId: null,
      conflictsWith: [],
      supersededBy: null,
      superseded: [],
      dangling: false,
      withheld: false,
    })
  }

  for (const record of references) {
    if (record.kind !== 'worker') continue

    if (typeof record.teamId === 'string' && record.teamId.length > 0) {
      push({ kind: 'worker', id: record.id }, 'member_of', { kind: 'team', id: record.teamId }, `${record.id}#team`)
    }

    const assignment = record.assignment
    if (assignment !== null && assignment !== undefined) {
      const targetKind = referenceKindFor(assignment.kind)
      if (targetKind !== null) {
        push(
          { kind: 'worker', id: record.id },
          'assigned_to',
          { kind: targetKind, id: assignment.id },
          `${record.id}#assignment`,
        )
      }
    }

    if (typeof record.parentKind === 'string' && typeof record.parentId === 'string' && record.parentId.length > 0) {
      const parentKind = referenceKindFor(record.parentKind)
      if (parentKind !== null) {
        push({ kind: 'worker', id: record.id }, 'assigned_to', { kind: parentKind, id: record.parentId }, `${record.id}#parent`)
      }
    }
  }

  for (const record of references) {
    if (record.kind !== 'artifact') continue
    if (typeof record.parentKind === 'string' && typeof record.parentId === 'string' && record.parentId.length > 0) {
      const producerKind = referenceKindFor(record.parentKind)
      if (producerKind === 'run') {
        push({ kind: 'run', id: record.parentId }, 'created', { kind: 'artifact', id: record.id }, `${record.id}#produced`)
      }
    }
  }

  return derived
}

/** Map a domain's own word for a record kind onto one this world models. */
function referenceKindFor(value: string): ReferenceWorldEntityKind | null {
  switch (value) {
    case 'mission':
      return 'mission'
    case 'run':
      return 'run'
    case 'task':
      return 'task'
    case 'worker':
      return 'worker'
    case 'team':
      return 'team'
    case 'skill':
      return 'skill'
    case 'artifact':
      return 'artifact'
    default:
      return null
  }
}

function domainOf(kind: ReferenceWorldEntityKind): WorldReferenceState['domain'] {
  switch (kind) {
    case 'mission':
      return 'mission'
    case 'run':
    case 'task':
      return 'work'
    case 'worker':
    case 'team':
      return 'workforce'
    case 'skill':
      return 'skills'
    default:
      return 'foundry'
  }
}

/* ------------------------------------------------------------- finishing */

function finaliseNode(
  draft: NodeDraft,
  edges: readonly WorldEdge[],
  withdrawnTargets: ReadonlySet<string>,
  supersededEvidence: ReadonlySet<string>,
  now: Date,
  limits: WorldLimits,
): WorldEntityNode {
  const ownEdges = edges.filter(
    (edge) => edge.fromEntityId === draft.entityId || edge.toEntityId === draft.entityId,
  )
  const visibleEdges = ownEdges.filter((edge) => !edge.withheld)
  const evidenceIds = [...draft.evidenceIds].sort()
  const liveEvidence = evidenceIds.filter(
    (id) => !withdrawnTargets.has(id) && !supersededEvidence.has(id),
  )
  const withdrawn =
    draft.withdrawn ||
    (liveEvidence.length === 0 && !draft.singleton && draft.reference === null && evidenceIds.length > 0)

  const freshness = draft.reference !== null
    ? draft.reference.terminal
      ? 'historical'
      : 'current'
    : nodeFreshness(
        edgeFreshness(
          {
            withdrawn,
            conflicted: false,
            validUntil: null,
            supersededBy: null,
            observedAt: draft.lastObservedAt,
          },
          now,
          limits,
        ),
        visibleEdges.map((edge) => edge.freshness),
      )

  return {
    entityId: draft.entityId,
    kind: draft.kind,
    name: draft.name,
    label: draft.label,
    aliases: [...draft.aliases].sort(),
    attributeKeys: [...draft.attributeKeys.entries()]
      .map(([key, valueLength]) => ({ key, valueLength }))
      .sort((a, b) => (a.key < b.key ? -1 : 1)),
    reference: draft.reference,
    claimKind: draft.claimKind,
    epistemic: draft.epistemic,
    confidence: draft.confidence,
    freshness,
    evidenceIds,
    edgeIds: [...draft.edgeIds].sort(),
    sourceRef: draft.sourceRef,
    firstObservedAt: draft.firstObservedAt,
    lastObservedAt: draft.lastObservedAt,
    contested: visibleEdges.some((edge) => edge.conflictsWith.length > 1),
    withdrawn,
    singleton: draft.singleton,
    withheld: draft.withheld && evidenceIds.every((id) => !draft.visibleEvidence.has(id)),
  }
}

function draftFromNode(node: WorldEntityNode): NodeDraft {
  return {
    entityId: node.entityId,
    kind: node.kind,
    name: node.name,
    label: node.label,
    aliases: new Set(node.aliases),
    attributeKeys: new Map(node.attributeKeys.map((entry) => [entry.key, entry.valueLength])),
    reference: node.reference,
    claimKind: node.claimKind,
    epistemic: node.epistemic,
    confidence: node.confidence,
    evidenceIds: new Set(node.evidenceIds),
    visibleEvidence: new Set(node.evidenceIds),
    edgeIds: new Set(node.edgeIds),
    sourceRef: node.sourceRef,
    firstObservedAt: node.firstObservedAt,
    lastObservedAt: node.lastObservedAt,
    withdrawn: node.withdrawn,
    singleton: node.singleton,
    withheld: node.withheld,
    ownFreshness: node.freshness,
  }
}

function boundLabel(label: string | null): string | null {
  if (typeof label !== 'string') return null
  const trimmed = label.trim()
  if (trimmed.length === 0) return null
  return trimmed.length > 80 ? trimmed.slice(0, 80) : trimmed
}