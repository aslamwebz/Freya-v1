import { BRAIN_LIMITS, type MemoryRecord, type WorldRelation } from './types'
import { BrainStoreError, type BrainRecord, type BrainRecordKind, type BrainState } from './store'

/**
 * The Brain fold, and the validation that guards it.
 *
 * One deterministic function from a sequence of records to a Brain state, used by
 * the in-memory store and the encrypted store alike. Two implementations of
 * "how do records become state" is how a store ends up disagreeing with itself
 * about what Freya knows, so there is one.
 *
 * The fold never throws on bad data. A record that fails validation is reported
 * and skipped, so one damaged memory costs that memory rather than the Brain — the
 * same rule the conversation store follows, and the reason a person who lost one
 * record does not lose everything they told Freya.
 */

const RECORD_KINDS: readonly BrainRecordKind[] = [
  'identity-root',
  'self-definition',
  'world-entity',
  'world-relation',
  'world-observation',
  'memory-candidate',
  'memory-record',
  'memory-review',
  'experience',
]

export const BRAIN_RECORD_VERSION = 1

/**
 * Apply one record. Idempotent per id, so a duplicate cannot double-apply.
 *
 * Advances `state.sequence` as well, because the sequence is part of the folded
 * state rather than bookkeeping bolted on beside it: after a replay it is the count
 * of records that were read and believed, and a projection that reported 0 after
 * reading thirty would be indistinguishable from an empty Brain.
 */
export function applyRecord(state: BrainState, record: BrainRecord): void {
  state.sequence += 1
  switch (record.kind) {
    case 'identity-root':
      // Root identity is written once. A later record does not replace it: the
      // first one is what the process booted with, and silently swapping it would
      // mean a memory could rewrite who Freya is.
      if (state.identity === null) state.identity = record.identity
      return
    case 'self-definition':
      if (state.self === null) state.self = record.definition
      return
    case 'world-entity':
      if (!state.entities.has(record.entity.entityId)) {
        state.entities.set(record.entity.entityId, record.entity)
      }
      return
    case 'world-relation':
      if (!state.relations.has(record.relation.relationId)) {
        state.relations.set(record.relation.relationId, record.relation)
      }
      return
    case 'world-observation':
      if (!state.observations.has(record.observation.observationId)) {
        state.observations.set(record.observation.observationId, record.observation)
      }
      return
    case 'memory-candidate':
      if (!state.candidates.has(record.candidate.candidateId)) {
        state.candidates.set(record.candidate.candidateId, record.candidate)
      }
      return
    case 'memory-record': {
      const replaced = record.memory.supersedes === null ? undefined : state.memories.get(record.memory.supersedes)
      if (replaced !== undefined && replaced.memoryId !== record.memory.memoryId && replaced.status !== 'archived') {
        state.memories.set(replaced.memoryId, { ...replaced, status: 'superseded' })
      }
      state.memories.set(record.memory.memoryId, record.memory)
      return
    }
    case 'memory-review':
      if (!state.reviews.has(record.review.candidateId)) {
        state.reviews.set(record.review.candidateId, record.review)
      }
      return
    case 'experience':
      if (!state.experiences.has(record.experience.experienceId)) {
        state.experiences.set(record.experience.experienceId, record.experience)
      }
      return
    default:
      return
  }
}

/**
 * Structural validation of one record.
 *
 * Runs on **read**, not only on write, because a record that authenticates is
 * only proven to be the record that was written — not that it was well formed. A
 * schema change, a truncated field, or a bug in an earlier version all show up
 * here rather than as a `undefined` three layers later.
 *
 * Returns null when the record is usable, or a sentence saying why it is not.
 */
export function validateRecord(value: unknown): { ok: true; record: BrainRecord } | { ok: false; reason: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'a Brain record is not an object' }
  }
  const record = value as Record<string, unknown>
  const kind = record.kind
  if (typeof kind !== 'string' || !RECORD_KINDS.includes(kind as BrainRecordKind)) {
    return { ok: false, reason: 'a Brain record named an unknown kind' }
  }

  const ok = (): { ok: true; record: BrainRecord } => ({ ok: true, record: value as BrainRecord })
  const isId = (v: unknown): boolean => typeof v === 'string' && v.length > 0 && v.length <= 256
  const isText = (v: unknown, max: number): boolean => typeof v === 'string' && v.length <= max
  const isInstant = (v: unknown): boolean => typeof v === 'string' && Number.isFinite(Date.parse(v))

  switch (kind as BrainRecordKind) {
    case 'identity-root': {
      const identity = record.identity as Record<string, unknown> | undefined
      if (!identity || typeof identity !== 'object') return { ok: false, reason: 'identity record has no identity' }
      if (!isText(identity.name, 200) || !isText(identity.role, 500) || !isText(identity.purpose, 1_000)) {
        return { ok: false, reason: 'identity record has malformed core fields' }
      }
      if (!Array.isArray(identity.claims)) return { ok: false, reason: 'identity record has no claims' }
      return ok()
    }
    case 'self-definition': {
      const definition = record.definition as Record<string, unknown> | undefined
      if (!definition || typeof definition !== 'object') {
        return { ok: false, reason: 'self record has no definition' }
      }
      if (!Array.isArray(definition.capabilities) || !Array.isArray(definition.limitations)) {
        return { ok: false, reason: 'self record is malformed' }
      }
      return ok()
    }
    case 'world-entity': {
      const entity = record.entity as Record<string, unknown> | undefined
      if (!entity || !isId(entity.entityId)) return { ok: false, reason: 'entity record has no id' }
      if (typeof entity.type !== 'string' || entity.type.length === 0) {
        return { ok: false, reason: 'entity record has no type' }
      }
      if (!isText(entity.canonicalName, BRAIN_LIMITS.maxEntityNameChars)) {
        return { ok: false, reason: 'entity name exceeds the limit' }
      }
      if (!Array.isArray(entity.aliases) || entity.aliases.length > BRAIN_LIMITS.maxAliasesPerEntity) {
        return { ok: false, reason: 'entity aliases are malformed' }
      }
      // `attributes` is a record of string values, not a list, so it is checked as a
      // map: a caller passing an array here was not writing the type they meant.
      if (!isStringRecord(entity.attributes)) {
        return { ok: false, reason: 'entity attributes are malformed' }
      }
      if (Object.keys(entity.attributes).length > BRAIN_LIMITS.maxAttributesPerEntity) {
        return { ok: false, reason: 'an entity has more attributes than the limit' }
      }
      if (!isInstant(entity.createdAt) || !isInstant(entity.updatedAt)) {
        return { ok: false, reason: 'entity timestamps are malformed' }
      }
      if (!isProvenance(entity.provenance)) return { ok: false, reason: 'entity provenance is malformed' }
      return ok()
    }
    case 'world-relation': {
      const relation = record.relation as Record<string, unknown> | undefined
      if (!relation || !isId(relation.relationId) || !isId(relation.subjectEntityId)) {
        return { ok: false, reason: 'relation record has no id or subject' }
      }
      if (!isText(relation.predicate, BRAIN_LIMITS.maxPredicateChars)) {
        return { ok: false, reason: 'relation predicate is malformed' }
      }
      // Exactly one target. A relation that points at nothing, or at both an
      // entity and a literal, is not a thing Freya can reason about.
      const objectId = relation.objectEntityId
      const literal = relation.literalValue
      const hasObject = typeof objectId === 'string' && objectId.length > 0
      const hasLiteral = typeof literal === 'string' && literal.length > 0
      if (hasObject === hasLiteral) {
        return { ok: false, reason: 'a relation must name exactly one object or one literal value' }
      }
      if (hasLiteral && !isText(literal, BRAIN_LIMITS.maxLiteralValueChars)) {
        return { ok: false, reason: 'relation literal value exceeds the limit' }
      }
      if (!isInstant(relation.validFrom)) return { ok: false, reason: 'relation validFrom is malformed' }
      if (!isProvenance(relation.provenance)) return { ok: false, reason: 'relation provenance is malformed' }
      if (!Array.isArray(relation.conflictsWith)) {
        return { ok: false, reason: 'relation conflicts are malformed' }
      }
      return ok()
    }
    case 'world-observation': {
      const observation = record.observation as Record<string, unknown> | undefined
      if (!observation || !isId(observation.observationId)) {
        return { ok: false, reason: 'observation record has no id' }
      }
      if (!isText(observation.stated, BRAIN_LIMITS.maxMemoryContentChars)) {
        return { ok: false, reason: 'observation text exceeds the limit' }
      }
      if (!isInstant(observation.observedAt)) return { ok: false, reason: 'observation timestamp is malformed' }
      if (!isProvenance(observation.provenance)) {
        return { ok: false, reason: 'observation provenance is malformed' }
      }
      return ok()
    }
    case 'memory-candidate': {
      const candidate = record.candidate as Record<string, unknown> | undefined
      if (!candidate || !isId(candidate.candidateId)) {
        return { ok: false, reason: 'candidate record has no id' }
      }
      if (typeof candidate.kind !== 'string' || candidate.kind.length === 0) {
        return { ok: false, reason: 'candidate has no kind' }
      }
      if (!isText(candidate.content, BRAIN_LIMITS.maxMemoryContentChars)) {
        return { ok: false, reason: 'candidate content exceeds the limit' }
      }
      if (!isProvenance(candidate.provenance)) {
        return { ok: false, reason: 'candidate provenance is malformed' }
      }
      return ok()
    }
    case 'memory-record': {
      const memory = record.memory as Record<string, unknown> | undefined
      if (!memory || !isId(memory.memoryId)) return { ok: false, reason: 'memory record has no id' }
      if (typeof memory.kind !== 'string' || memory.kind.length === 0) {
        return { ok: false, reason: 'memory has no kind' }
      }
      if (typeof memory.content !== 'string') {
        return { ok: false, reason: 'memory content is malformed' }
      }
      if (
        memory.content.trim().length === 0 ||
        memory.content.length > BRAIN_LIMITS.maxMemoryContentChars
      ) {
        // Empty as well as too long. An admitted memory with no content is a record
        // that claims to be knowledge while carrying none.
        return { ok: false, reason: 'memory content is empty or exceeds the limit' }
      }
      if (!isText(memory.subject, BRAIN_LIMITS.maxMemorySubjectChars)) {
        return { ok: false, reason: 'memory subject exceeds the limit' }
      }
      if (typeof memory.status !== 'string') return { ok: false, reason: 'memory status is malformed' }
      if (typeof memory.source !== 'string') return { ok: false, reason: 'memory source is malformed' }
      if (!isProvenance(memory.provenance)) return { ok: false, reason: 'memory provenance is malformed' }
      if (!Array.isArray(memory.tags) || memory.tags.length > BRAIN_LIMITS.maxTagsPerRecord) {
        return { ok: false, reason: 'memory tags are malformed' }
      }
      if (!Array.isArray(memory.entityRefs) || memory.entityRefs.length > BRAIN_LIMITS.maxEntityRefsPerRecord) {
        return { ok: false, reason: 'memory entity references are malformed' }
      }
      // The two fields that make admission an act rather than a state.
      if (
        !isInstant(memory.admittedAt) ||
        typeof memory.admissionReason !== 'string' ||
        memory.admissionReason.length === 0 ||
        memory.admissionReason.length > BRAIN_LIMITS.maxReasonChars
      ) {
        return { ok: false, reason: 'a memory must state why it was admitted, within the reason limit' }
      }
      return ok()
    }
    case 'memory-review': {
      const review = record.review as Record<string, unknown> | undefined
      if (!review || !isId(review.candidateId)) return { ok: false, reason: 'review record has no id' }
      if (typeof review.decision !== 'string') return { ok: false, reason: 'review decision is malformed' }
      if (!isInstant(review.reviewedAt)) return { ok: false, reason: 'review timestamp is malformed' }
      return ok()
    }
    case 'experience': {
      const experience = record.experience as Record<string, unknown> | undefined
      if (!experience || !isId(experience.experienceId)) {
        return { ok: false, reason: 'experience record has no id' }
      }
      if (!isInstant(experience.startedAt) || !isInstant(experience.endedAt)) {
        return { ok: false, reason: 'experience timestamps are malformed' }
      }
      if (typeof experience.result !== 'string') return { ok: false, reason: 'experience result is malformed' }
      if (experience.verification !== 'unverified') {
        return {
          ok: false,
          // Phase 4 cannot verify anything on its own, so a record claiming it did
          // is refused rather than stored. Nothing is lost: the record is skipped,
          // not rewritten.
          reason: 'only unverified experiences can be recorded in this phase',
        }
      }
      if (!isText(experience.goalSummary, BRAIN_LIMITS.maxGoalSummaryChars)) {
        return { ok: false, reason: 'experience goal summary exceeds the limit' }
      }
      if (!Array.isArray(experience.evidenceRefs) || !Array.isArray(experience.relatedEntities)) {
        return { ok: false, reason: 'experience references are malformed' }
      }
      return ok()
    }
    default:
      return { ok: false, reason: 'a Brain record named an unknown kind' }
  }
}

/**
 * A plain object whose values are all strings.
 *
 * Rejects arrays and null-prototype oddities alike, because the consumers index it
 * and treat the result as text. An attribute holding an object would reach a prompt
 * as `[object Object]`, which is worse than refusing it.
 */
function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value as Record<string, unknown>).every((item) => typeof item === 'string')
}

function isProvenance(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const p = value as Record<string, unknown>
  return (
    typeof p.sourceType === 'string' &&
    p.sourceType.length > 0 &&
    (p.sourceRef === null || typeof p.sourceRef === 'string') &&
    typeof p.observedAt === 'string' &&
    Number.isFinite(Date.parse(p.observedAt)) &&
    typeof p.recordedAt === 'string' &&
    Number.isFinite(Date.parse(p.recordedAt)) &&
    typeof p.actor === 'string' &&
    typeof p.verificationStatus === 'string' &&
    typeof p.confidence === 'string'
  )
}

/** Refuse a record that is too large to store safely, before it reaches the disk. */
export function assertRecordSize(record: BrainRecord): void {
  const size = Buffer.byteLength(JSON.stringify(record), 'utf8')
  if (size > BRAIN_LIMITS.maxRecordBytes) {
    throw new BrainStoreError(
      'too-large',
      `a Brain record of ${size} bytes exceeds the ${BRAIN_LIMITS.maxRecordBytes} byte limit`,
    )
  }
}

/**
 * Find relations that contradict each other for the same subject and predicate.
 *
 * Used by admission to raise a conflict rather than overwrite. A later, better
 * record does not erase the earlier one: it supersedes it, and the retrieval pack
 * discloses that a disagreement exists.
 */
export function conflictingRelations(relations: readonly WorldRelation[]): WorldRelation[] {
  const bySlot = new Map<string, WorldRelation[]>()
  for (const relation of relations) {
    const slot = `${relation.subjectEntityId} ${relation.predicate}`
    const list = bySlot.get(slot) ?? []
    list.push(relation)
    bySlot.set(slot, list)
  }
  const conflicted: WorldRelation[] = []
  for (const group of bySlot.values()) {
    const current = group.filter((r) => r.validUntil === null)
    // Only simultaneous current claims can contradict. A closed one and an open one
    // are just history.
    if (current.length < 2) continue
    const values = new Set(current.map((r) => r.objectEntityId ?? r.literalValue ?? ''))
    if (values.size > 1) conflicted.push(...current)
  }
  return conflicted
}

/** Memories a given memory contradicts, by explicit reference. */
export function memoryConflicts(state: BrainState): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const memory of state.memories.values()) {
    for (const other of memory.conflictsWith) {
      if (!state.memories.has(other)) continue
      const list = out.get(memory.memoryId) ?? []
      list.push(other)
      out.set(memory.memoryId, list)
    }
  }
  return out
}

/** Convenience for callers that must not mutate the fold. */
export function listMemories(state: BrainState, filter?: (memory: MemoryRecord) => boolean): MemoryRecord[] {
  return [...state.memories.values()].filter(filter ?? (() => true))
}
