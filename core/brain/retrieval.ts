import {
  CONFIDENCE_RANK,
  DEFAULT_RECALL_BUDGET,
  RECALLABLE_STATUSES,
  type MemoryRecord,
  type RecallBudget,
  type RecallEntity,
  type RecallItem,
  type RecallPack,
  type RecallQuery,
  type RecallReason,
  type WorldRelation,
} from './types'
import type { BrainState } from './store'
import { BRAIN_LIMITS } from './types'

/**
 * Deterministic retrieval.
 *
 * No model call, no embeddings, no vector index. Three reasons, and the third is
 * the one that decides it:
 *
 *  1. **Retrieval must never make a model call.** If recall needed inference,
 *     then every keystroke would cost money, send data out, and be able to fail in
 *     a way that changes what Freya knows. Recall is Core behaviour and it has to
 *     be free, offline and reproducible.
 *  2. **Reproducibility.** The same Brain and the same query must produce the same
 *     pack, always. A score that drifts with a model's mood is not auditable, and a
 *     Brain that cannot explain why it recalled something cannot be corrected.
 *  3. **Auditability.** Every item carries the terms and tags that selected it, so
 *     a surprising recall traces to a word rather than to a hunch.
 *
 * The scoring is a small, explicit sum of named signals — no weights learned
 * anywhere, no tuning that only exists in someone's head. Ties break on id, so the
 * output is a total order.
 */

const SIGNALS = Object.freeze({
  entityRef: 30,
  keyword: 8,
  subjectKeyword: 12,
  tag: 10,
  kind: 4,
  recency: 6,
  /** Confidence scales relevance rather than being added, so a weak match on a
   *  verified memory can outrank a strong match on an unverified one. */
  confidenceScale: 2,
})

/**
 * Characters per token.
 *
 * A rough, fixed divisor rather than a real tokenizer. It is deliberately not
 * improved: the budget has to be a number Core can compute without loading a
 * vocabulary, and it errs on the side of a smaller pack. Truncating recall is
 * safe; overflowing a context window is not.
 */
const CHARS_PER_TOKEN = 4

/** Terms shorter than this match too much to mean anything. */
const MIN_TERM_LENGTH = 3

export function recall(state: BrainState, query: RecallQuery, budget?: RecallBudget): RecallPack {
  const limits = clampBudget(budget ?? DEFAULT_RECALL_BUDGET)
  const terms = tokenize(query.text)
  const tags = new Set((query.tags ?? []).map((tag) => tag.toLowerCase()))
  const wantedEntities = new Set(query.entityRefs ?? [])
  const kinds = query.kinds && query.kinds.length > 0 ? new Set(query.kinds) : null
  const statuses = new Set(query.statuses ?? RECALLABLE_STATUSES)

  const candidates = [...state.memories.values()].filter((memory) => statuses.has(memory.status))
  const askedLimit = query.limit ?? limits.maxItems
  const itemLimit = Math.max(0, Math.min(askedLimit, limits.maxItems))

  const scored: { memory: MemoryRecord; score: number; reasons: RecallReason[] }[] = []
  for (const memory of candidates) {
    if (kinds !== null && !kinds.has(memory.kind)) continue

    // Sensitivity is a filter the caller sets by passing what it wants; the Brain
    // never decides on its own that something is too private to recall, and never
    // widens recall beyond the budget it was given.
    const score = scoreMemory(memory, { terms, tags, wantedEntities, now: latestTime(candidates) })
    if (score === null) continue
    scored.push(score)
  }

  // A total order: score, then recency, then id. The last key exists so two items
  // that tie completely still have a defined order.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (b.memory.updatedAt !== a.memory.updatedAt) return b.memory.updatedAt.localeCompare(a.memory.updatedAt)
    return a.memory.memoryId.localeCompare(b.memory.memoryId)
  })

  const selected: typeof scored = []
  let usedTokens = 0
  let omitted = 0
  for (const entry of scored) {
    if (selected.length >= itemLimit) {
      omitted += 1
      continue
    }
    const cost = estimateTokens(entry.memory)
    if (usedTokens + cost > limits.maxEstimatedTokens) {
      // Omitted, and counted. A pack that silently drops items looks complete.
      omitted += 1
      continue
    }
    usedTokens += cost
    selected.push(entry)
  }

  const memories: RecallItem[] = selected.map((entry) => ({
    memoryId: entry.memory.memoryId,
    kind: entry.memory.kind,
    subject: entry.memory.subject,
    content: entry.memory.content,
    status: entry.memory.status,
    confidence: entry.memory.confidence,
    sensitivity: entry.memory.sensitivity,
    source: entry.memory.source,
    score: entry.score,
    reasons: entry.reasons,
    updatedAt: entry.memory.updatedAt,
  }))

  return {
    query: query.text,
    memories,
    entities: collectEntities(state, memories),
    conflicts: collectConflicts(state, memories),
    provenanceSummaries: memories.map((item) => ({
      memoryId: item.memoryId,
      sourceType: item.source,
      confidence: item.confidence,
      verificationStatus: state.memories.get(item.memoryId)?.provenance.verificationStatus ?? 'unknown',
    })),
    candidatesConsidered: scored.length,
    omittedCount: omitted,
    budget: limits,
    estimatedTokens: usedTokens,
    empty: memories.length === 0,
  }
}

/**
 * Score one memory, or return null when it did not match at all.
 *
 * Null rather than zero, so "no evidence this is relevant" and "barely relevant"
 * stay distinguishable in the counts.
 */
function scoreMemory(
  memory: MemoryRecord,
  context: { terms: Set<string>; tags: Set<string>; wantedEntities: Set<string>; now: string },
): { memory: MemoryRecord; score: number; reasons: RecallReason[] } | null {
  const reasons: RecallReason[] = []
  let score = 0

  const shared = memory.entityRefs.filter((ref) => context.wantedEntities.has(ref))
  if (context.wantedEntities.size > 0 && shared.length > 0) {
    score += SIGNALS.entityRef * shared.length
    reasons.push({ reason: 'entity-ref', detail: `shares ${shared.length} referenced entity/entities` })
  }

  const haystack = `${memory.subject}\n${memory.content}`.toLowerCase()
  const matched = [...context.terms].filter((term) => haystack.includes(term))
  if (matched.length > 0) {
    const inSubject = matched.filter((term) => memory.subject.toLowerCase().includes(term)).length
    score += matched.length * SIGNALS.keyword + inSubject * SIGNALS.subjectKeyword
    reasons.push({
      reason: 'keyword',
      detail: `matched ${matched.slice(0, 6).join(', ')}${matched.length > 6 ? `, +${matched.length - 6} more` : ''}`,
    })
  }

  const tagHits = memory.tags.filter((tag) => context.tags.has(tag.toLowerCase()))
  if (tagHits.length > 0) {
    score += tagHits.length * SIGNALS.tag
    reasons.push({ reason: 'tag', detail: `tagged ${tagHits.join(', ')}` })
  }

  if (context.terms.size === 0 && context.tags.size === 0 && context.wantedEntities.size === 0) {
    // An empty query is legal and means "recent things". Recency is then the whole
    // signal, and it is admitted to the reasons so the pack still explains itself.
    const recency = recencyScore(memory.updatedAt, context.now)
    score += recency
    reasons.push({ reason: 'recency', detail: recency > 0 ? 'most recently updated' : 'updated earlier' })
  }

  if (score === 0) return null

  const confidenceWeight = 1 + CONFIDENCE_RANK[memory.confidence] / SIGNALS.confidenceScale
  score = Math.round(score * confidenceWeight * 100) / 100
  if (CONFIDENCE_RANK[memory.confidence] > 0) {
    reasons.push({
      reason: 'relationship',
      detail: `weighting applied for ${memory.confidence} confidence`,
    })
  }
  if (memory.status === 'conflicted') {
    reasons.push({ reason: 'kind', detail: 'admitted, but contradicted by another record' })
  }

  return { memory, score, reasons }
}

/** Linear decay over a year, in whole points. Deterministic and cheap. */
function recencyScore(updatedAt: string, now: string): number {
  const updated = Date.parse(updatedAt)
  const reference = Date.parse(now)
  if (!Number.isFinite(updated) || !Number.isFinite(reference)) return 0
  const ageDays = Math.max(0, (reference - updated) / 86_400_000)
  const year = Math.min(1, ageDays / 365)
  return Math.round(SIGNALS.recency * (1 - year))
}

function latestTime(memories: readonly MemoryRecord[]): string {
  let latest = ''
  for (const memory of memories) {
    if (memory.updatedAt > latest) latest = memory.updatedAt
  }
  return latest
}

/**
 * Entities the selected memories point at, with the current relations that hold.
 *
 * Only current relations (`validUntil === null`) and only for referenced entities,
 * so this stays small. A superseded relation is history and belongs in a query for
 * history, not in a recall pack.
 */
function collectEntities(state: BrainState, memories: readonly RecallItem[]): RecallEntity[] {
  const referenced = new Set<string>()
  for (const item of memories) {
    for (const ref of state.memories.get(item.memoryId)?.entityRefs ?? []) referenced.add(ref)
  }

  const entities: RecallEntity[] = []
  for (const entityId of [...referenced].sort()) {
    const entity = state.entities.get(entityId)
    if (entity === undefined) continue

    const relations = [...state.relations.values()]
      .filter((relation) => relation.subjectEntityId === entityId && relation.validUntil === null)
      .filter((relation) => relation.objectEntityId === null || state.entities.has(relation.objectEntityId))
      .sort(byRecencyThenId)
      .slice(0, BRAIN_LIMITS.maxRelationsPerEntity)
      .map(projectRelation)

    entities.push({
      entityId: entity.entityId,
      canonicalName: entity.canonicalName,
      type: entity.type,
      relations,
    })
  }
  return entities
}

function projectRelation(relation: WorldRelation): RecallEntity['relations'][number] {
  return {
    relationId: relation.relationId,
    predicate: relation.predicate,
    objectEntityId: relation.objectEntityId,
    literalValue: relation.literalValue,
    confidence: relation.confidence,
  }
}

/**
 * Contradictions among the selected items, and memory-wide ones worth naming.
 *
 * Disclosed rather than resolved. Resolving would need a judgement about which
 * side is right, and in Phase 4 the honest answer is that Freya does not have one.
 */
function collectConflicts(
  state: BrainState,
  memories: readonly RecallItem[],
): RecallPack['conflicts'] {
  const selected = new Set(memories.map((item) => item.memoryId))
  const out: {
    memoryId: string
    conflictsWith: readonly string[]
    detail: string
  }[] = []
  for (const item of memories) {
    const memory = state.memories.get(item.memoryId)
    if (memory === undefined) continue
    const against = memory.conflictsWith.filter((id) => selected.has(id) || state.memories.has(id))
    if (against.length === 0) continue
    out.push({
      memoryId: item.memoryId,
      conflictsWith: against,
      detail:
        selected.has(item.memoryId) && against.some((id) => selected.has(id))
          ? 'this memory and another in this pack disagree; both are included'
          : 'this memory is contradicted by another stored record, which is not in this pack',
    })
  }
  // Relation conflicts belong in a recall pack only when the selected memories
  // actually reference the entity those relations describe. Otherwise a question
  // about one subject can leak an unrelated private contradiction into the model
  // context merely because it exists somewhere in the Brain.
  const selectedEntities = new Set<string>()
  for (const item of memories) {
    for (const entityId of state.memories.get(item.memoryId)?.entityRefs ?? []) {
      selectedEntities.add(entityId)
    }
  }
  for (const [relationId, group] of contradictedRelationGroups(state, selectedEntities)) {
    out.push({
      memoryId: relationId,
      conflictsWith: group.filter((id) => id !== relationId),
      detail: 'these stored facts about the same subject and predicate disagree, and all are current',
    })
  }
  return out
}

/**
 * Bounded conflict projection for the Brain surface.
 *
 * Unlike a RecallPack this is intentionally global: the Brain surface is where the
 * owner inspects known contradictions. It never includes memory contents, only ids
 * and a fixed diagnostic sentence.
 */
export function brainConflicts(
  state: BrainState,
  limit = BRAIN_LIMITS.maxItemsInProjection,
): RecallPack['conflicts'] {
  const out: RecallPack['conflicts'][number][] = []
  const memories = [...state.memories.values()]
    .filter((memory) => RECALLABLE_STATUSES.includes(memory.status))
    .sort((a, b) => a.memoryId.localeCompare(b.memoryId))

  for (const memory of memories) {
    const against = memory.conflictsWith.filter((id) => state.memories.has(id))
    if (against.length === 0) continue
    out.push({
      memoryId: memory.memoryId,
      conflictsWith: against,
      detail: 'this memory is contradicted by another stored record',
    })
    if (out.length >= Math.max(0, limit)) return out
  }

  for (const [relationId, group] of contradictedRelationGroups(state)) {
    out.push({
      memoryId: relationId,
      conflictsWith: group.filter((id) => id !== relationId),
      detail: 'these stored facts about the same subject and predicate disagree, and all are current',
    })
    if (out.length >= Math.max(0, limit)) break
  }
  return out
}

function contradictedRelationGroups(
  state: BrainState,
  entityFilter?: ReadonlySet<string>,
): [string, string[]][] {
  const slots = new Map<string, string[]>()
  for (const relation of state.relations.values()) {
    if (relation.validUntil !== null) continue
    if (entityFilter !== undefined && !entityFilter.has(relation.subjectEntityId)) continue
    const slot = `${relation.subjectEntityId} ${relation.predicate}`
    const list = slots.get(slot) ?? []
    list.push(relation.relationId)
    slots.set(slot, list)
  }
  const out: [string, string[]][] = []
  for (const group of slots.values()) {
    if (group.length < 2) continue
    const values = new Set(
      group.map((id) => {
        const relation = state.relations.get(id)
        return relation?.objectEntityId ?? relation?.literalValue ?? ''
      }),
    )
    if (values.size > 1) for (const id of group) out.push([id, group])
  }
  return out
}

function byRecencyThenId(a: WorldRelation, b: WorldRelation): number {
  if (a.validFrom !== b.validFrom) return b.validFrom.localeCompare(a.validFrom)
  return a.relationId.localeCompare(b.relationId)
}

/**
 * Lowercase word terms, deduplicated.
 *
 * No stemming and no stopword list, both on purpose. Stemming collapses
 * "preferences" into "prefer" and would quietly join unrelated memories; a stopword
 * list is a judgement about English embedded in a deterministic scorer. Short terms
 * are dropped because they match everything.
 */
export function tokenize(text: string): Set<string> {
  const terms = new Set<string>()
  for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length < MIN_TERM_LENGTH) continue
    terms.add(raw)
  }
  return terms
}

export function estimateTokens(memory: MemoryRecord): number {
  const chars = memory.subject.length + memory.content.length + memory.kind.length
  return Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN))
}

/**
 * Bound the budget from above as well as down.
 *
 * A caller asking for a million tokens does not get one, because the pack is going
 * into a model context that has a real size. Upper bounds live here so the ceiling
 * is one place, and so no caller can quietly turn recall into a context flood.
 */
export function clampBudget(budget: RecallBudget): RecallBudget {
  return {
    maxEstimatedTokens: Math.max(1, Math.min(budget.maxEstimatedTokens, 8_000)),
    maxItems: Math.max(0, Math.min(budget.maxItems, BRAIN_LIMITS.maxItemsInProjection)),
  }
}