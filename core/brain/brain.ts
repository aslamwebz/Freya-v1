import type { EventFabric } from '../events/fabric'
import {
  admit,
  proposeCandidate,
  reviewOf,
  type AdmissionRequest,
} from './admission'
import { brainConflicts, recall } from './retrieval'
import {
  BrainStoreError,
  type BrainHealth,
  type BrainRecord,
  type BrainState,
  type BrainStore,
} from './store'
import {
  BRAIN_LIMITS,
  DEFAULT_RECALL_BUDGET,
  type Confidence,
  type EpistemicStatus,
  type ExperienceRecord,
  type IdentityRoot,
  type IdentityRootClaim,
  type MemoryKind,
  type MemoryOwnership,
  type MemoryRecord,
  type MemoryStatus,
  RECALLABLE_STATUSES,
  type Provenance,
  type RecallBudget,
  type RecallPack,
  type RecallQuery,
  type SelfCapabilityFact,
  type SelfDefinition,
  type SelfLimitation,
  type Sensitivity,
  type SourceTrust,
  type WorldEntity,
  type WorldEntityType,
  type WorldObservation,
  type WorldRelation,
} from './types'

/**
 * The Brain.
 *
 * The subsystem that holds what Freya knows about herself, the owner and the
 * world, and that keeps it across restarts. Everything here is Core-local: no
 * Electron, no React, no provider, and — the constraint that shapes most of this
 * file — **no model call, ever**.
 *
 * ## Why the Brain has no opinions
 *
 * The temptation with a memory system is to make it decide: let the model say
 * whether a fact is worth keeping, let a scoring pass decide what matters, let a
 * summary stand in for the thing it summarises. Every one of those is a way of
 * letting untrusted content rewrite Freya's own state, and every one of them
 * costs a model call in the path of a keystroke.
 *
 * So the Brain's judgement is narrow and structural:
 *
 *  - **Admission** is decided from the *source class the trusted pathway assigned*,
 *    never from the content. See `admission.ts`, which is where the reasoning is.
 *  - **Retrieval** is a named sum of signals with a total order. No embeddings, no
 *    ranking model, no "the model thought it was relevant".
 *  - **Nothing reaches `verified`.** Phase 4 has no verifier, so no record claims
 *    to have one.
 *
 * ## What the Brain is not allowed to do
 *
 * It cannot grant or widen authority, and — less obvious, and the reason the
 * distinction is written down — **a Brain fault does not change any authority in
 * either direction**. A corrupt Brain cannot grant cognition, clear a stop or
 * loosen a budget. It also does not *lose* authority: unreadable long-term
 * knowledge is neither permission nor lockout. Core keeps running, conversations
 * keep working, and the surface reports the Brain's own health separately from the
 * security posture. Conflating the two would let a disk error look like a safety
 * feature, or a safety feature look like a disk error.
 *
 * Live self-knowledge — budgets, stop state, journal integrity, grants — is
 * deliberately **not** stored here. That is Guard's and Governor's truth, read
 * fresh. A second, writable copy of the most security-relevant facts in the
 * system would go stale and would then be believed.
 */

export interface BrainOptions {
  store: BrainStore
  fabric: EventFabric
  now?: () => Date
  newId?: () => string
}

/** What a caller may write. Anything not named here is not writable. */
export interface MemoryWriteRequest {
  kind: MemoryKind
  subject: string
  content: string
  /** Assigned by the calling pathway, which knew where the bytes came from. */
  source: SourceTrust
  sourceRef: string | null
  observedAt?: string
  confidence: Confidence
  sensitivity: Sensitivity
  tags?: readonly string[]
  entityRefs?: readonly string[]
  structuredData?: Readonly<Record<string, string>>
  actor?: string
  /** Records this memory is known to contradict, by id. */
  conflictsWith?: readonly string[]
}

export interface MemoryWriteOutcome {
  outcome: 'admitted' | 'rejected' | 'deferred' | 'unavailable'
  memory: MemoryRecord | null
  reason: string
  /** Anything the admission policy had to adjust, stated rather than hidden. */
  notes: readonly string[]
}

export interface BrainProjection {
  /** Always present. The absence of a warning is not the same as a warning. */
  health: BrainHealth
  /** Why the Brain is degraded or unavailable. Never null when unhealthy. */
  reason: string | null
  /** What durability this store actually provides. Never a guess. */
  persistence: BrainStore['mode']
  /** True when a restart will not lose what has been learned. */
  durable: boolean
  identity: {
    name: string
    role: string
    purpose: string
    claims: readonly { claimId: string; statement: string }[]
  } | null
  self: {
    complete: boolean
    capabilities: readonly { capability: string; state: string; cannot: readonly string[] }[]
    limitations: readonly { limitationId: string; statement: string }[]
  } | null
  counts: {
    entities: number
    relations: number
    observations: number
    memories: number
    admitted: number
    conflicted: number
    rejected: number
    /** Withdrawn deliberately. Archived, not deleted — but not in the listing. */
    withdrawn: number
    experiences: number
  }
  /**
   * The memories Freya currently holds, newest first.
   *
   * Recallable statuses only, so the listing answers the question the window is
   * for — "what does she think she knows". A withdrawn memory drops off it, because
   * listing it beside the ones she still holds would claim she knows it.
   *
   * It is *not* deleted, and it is not hidden silently: `counts.withdrawn` says how
   * many were withdrawn, so a person who withdraws something can see that it went
   * somewhere rather than nowhere.
   */
  recentAdmissions: readonly {
    memoryId: string
    kind: MemoryKind
    subject: string
    source: SourceTrust
    confidence: Confidence
    status: MemoryStatus
    admittedAt: string
  }[]
  /** Contradictions currently on record. Disclosed, because they are real. */
  conflicts: readonly { memoryId: string; conflictsWith: readonly string[]; detail: string }[]
  /** Sequences are what make the chain auditable from outside. */
  sequence: number
}

export class Brain {
  private readonly store: BrainStore
  private readonly fabric: EventFabric
  private readonly now: () => Date
  private readonly newId: () => string
  private closed = false
  private closing = false
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(options: BrainOptions) {
    this.store = options.store
    this.fabric = options.fabric
    this.now = options.now ?? (() => new Date())
    this.newId = options.newId ?? (() => crypto.randomUUID())
  }

  /* ---------------------------------------------------------- identity */

  /**
   * The identity root, read-only.
   *
   * There is no writer, and that is the design rather than an omission. These are
   * the claims that follow from Freya's architecture — "the model is not Freya"
   * among them — and they have to hold no matter what a model says or what anybody
   * types. A subsystem that could rewrite them would turn a structural guarantee
   * into a preference.
   *
   * The constructor is module-private, so nothing outside this file can build one
   * either.
   */
  identity(): IdentityRoot | null {
    return this.store.state().identity
  }

  /**
   * The persistent self-definition, read-only here and seeded on first start.
   *
   * Seeded by Core, never by a caller and never by a model. A phase that could
   * describe Freya's own limitations would be a phase that could describe away a
   * limitation.
   */
  self(): SelfDefinition | null {
    return this.store.state().self
  }

  /* ------------------------------------------------------------- world */

  /**
   * Record something Freya has heard of.
   *
   * Naming an entity is not a claim about it. `type` here is the kind of thing the
   * name appears to refer to, and it arrives with the same ceiling as everything
   * else: an untrusted source cannot promote itself.
   */
  async rememberEntity(input: {
    type: WorldEntityType
    canonicalName: string
    aliases?: readonly string[]
    attributes?: Readonly<Record<string, string>>
    source: SourceTrust
    sourceRef: string | null
    observedAt?: string
    epistemic: EpistemicStatus
  }): Promise<{ ok: true; entityId: string } | { ok: false; reason: string }> {
    const now = this.timestamp()
    const name = input.canonicalName.trim()
    if (name.length === 0) return { ok: false, reason: 'the entity has no name' }
    if (name.length > BRAIN_LIMITS.maxEntityNameChars) {
      return { ok: false, reason: 'the entity name is longer than the limit' }
    }

    const state = this.store.state()
    const existing = findEntityByCanonicalName(state, name)
    if (existing !== undefined) {
      // Idempotent only on canonical name. An alias is evidence that two labels
      // may refer to the same entity, not proof. Auto-merging a new canonical
      // entity merely because it equals somebody else's alias would silently
      // collapse ambiguous names — exactly the kind of inference the World model
      // is supposed to preserve rather than guess.
      return { ok: true, entityId: existing.entityId }
    }

    const entity: WorldEntity = {
      entityId: this.newId(),
      type: input.type,
      canonicalName: name,
      aliases: (input.aliases ?? []).slice(0, BRAIN_LIMITS.maxAliasesPerEntity),
      attributes: input.attributes ?? {},
      createdAt: now,
      updatedAt: now,
      provenance: this.provenance(input.source, input.sourceRef, input.observedAt ?? now, now),
      epistemic: input.epistemic,
    }
    const written = await this.write({ kind: 'world-entity', entity })
    await this.emit('brain.world.entity_noted', {
      entityId: written.entity.entityId,
      entityType: input.type,
      // The name is measured, never recorded. A person's name in an audit log is a
      // copy of it in the one place Freya does not protect as well as the Brain.
      nameLength: name.length,
      sourceType: input.source,
    })
    return { ok: true, entityId: written.entity.entityId }
  }

  /**
   * Record a relationship between entities, or an attribute of one.
   *
   * A relation that contradicts a current one does not replace it. Both are kept,
   * the new one supersedes nothing, and the pair is disclosed on recall — because
   * "Freya knows two contradictory things about Project Alpha" is the truth, and
   * silently keeping only the newest is how a Brain starts being confidently wrong
   * about something it was told twice.
   */
  async relate(input: {
    subjectEntityId: string
    predicate: string
    objectEntityId?: string | null
    literalValue?: string | null
    source: SourceTrust
    sourceRef: string | null
    observedAt?: string
    confidence: Confidence
    epistemic: EpistemicStatus
  }): Promise<{ ok: true; relationId: string; conflictsWith: readonly string[] } | { ok: false; reason: string }> {
    const state = this.store.state()
    if (!state.entities.has(input.subjectEntityId)) {
      return { ok: false, reason: 'the subject of this relation is not a known entity' }
    }
    const hasObject = typeof input.objectEntityId === 'string' && input.objectEntityId.length > 0
    const hasLiteral = typeof input.literalValue === 'string' && input.literalValue.length > 0
    if (hasObject === hasLiteral) {
      return { ok: false, reason: 'a relation must name exactly one object entity or one literal value' }
    }
    if (hasObject && !state.entities.has(input.objectEntityId as string)) {
      return { ok: false, reason: 'the object of this relation is not a known entity' }
    }

    const now = this.timestamp()
    const conflicting = [...state.relations.values()].filter(
      (relation) =>
        relation.subjectEntityId === input.subjectEntityId &&
        relation.predicate === input.predicate &&
        relation.validUntil === null &&
        (relation.objectEntityId ?? relation.literalValue) !==
          (input.objectEntityId ?? input.literalValue ?? null),
    )

    const relation: WorldRelation = {
      relationId: this.newId(),
      subjectEntityId: input.subjectEntityId,
      predicate: input.predicate.trim(),
      objectEntityId: hasObject ? (input.objectEntityId as string) : null,
      literalValue: hasLiteral ? (input.literalValue as string) : null,
      validFrom: now,
      validUntil: null,
      confidence: input.confidence,
      provenance: this.provenance(input.source, input.sourceRef, input.observedAt ?? now, now),
      epistemic: input.epistemic,
      supersedes: null,
      conflictsWith: conflicting.map((relation) => relation.relationId),
    }
    await this.write({ kind: 'world-relation', relation })
    await this.emit('brain.world.related', {
      subjectEntityId: relation.subjectEntityId,
      predicate: 'stored-in-brain',
      conflictingRelations: conflicting.length,
    })
    return { ok: true, relationId: relation.relationId, conflictsWith: relation.conflictsWith }
  }

  /**
   * Keep something a source said, as said.
   *
   * "A message says Alpha is delayed" is an observation of a *claim*. It is not a
   * claim that Alpha is delayed, it is not promoted to a relation, and it never
   * becomes recallable on its own. Promotion goes through `writeMemory`, where the
   * source class is judged.
   */
  async observe(input: {
    stated: string
    entityRefs?: readonly string[]
    source: SourceTrust
    sourceRef: string | null
    observedAt?: string
    epistemic?: EpistemicStatus
  }): Promise<{ ok: true; observationId: string } | { ok: false; reason: string }> {
    const stated = input.stated.trim()
    if (stated.length === 0) return { ok: false, reason: 'the observation is empty' }
    if (stated.length > BRAIN_LIMITS.maxMemoryContentChars) {
      return { ok: false, reason: 'the observation is longer than the limit' }
    }
    const now = this.timestamp()
    const observation: WorldObservation = {
      observationId: this.newId(),
      stated,
      entityRefs: (input.entityRefs ?? []).slice(0, BRAIN_LIMITS.maxEntityRefsPerRecord),
      extracted: {},
      observedAt: input.observedAt ?? now,
      provenance: this.provenance(input.source, input.sourceRef, input.observedAt ?? now, now),
      // An observation stays an observation until a trusted pathway promotes it.
      epistemic: input.epistemic ?? 'observed',
    }
    await this.write({ kind: 'world-observation', observation })
    await this.emit('brain.world.observed', {
      observationId: observation.observationId,
      sourceType: input.source,
      statedLength: stated.length,
    })
    return { ok: true, observationId: observation.observationId }
  }

  /* ------------------------------------------------------------ memory */

  /**
   * The only door to a recallable memory.
   *
   * Candidate first, review second, record third — three writes in that order, so
   * the proposal and the judgement both exist on disk and can be read years later.
   * There is no path that writes a `memory-record` without the other two.
   */
  async writeMemory(request: MemoryWriteRequest): Promise<MemoryWriteOutcome> {
    if (this.closing || this.closed) {
      return { outcome: 'unavailable', memory: null, reason: 'the Brain is closing or closed', notes: [] }
    }
    const result = this.mutationTail.then(() => this.admitNow(request), () => this.admitNow(request))
    this.mutationTail = result.then(() => undefined, () => undefined)
    return result
  }

  /**
   * The admission itself, with no queue of its own.
   *
   * Split out from `writeMemory` because a queued task cannot call the queued
   * method: the queue is a promise chain over the *previous* task, so a task that
   * awaited `writeMemory` would be waiting for itself and the Brain would hang on
   * the first correction. Anything that must admit from inside a mutation — a
   * correction admitting its replacement — calls this instead, and inherits the
   * same ordering because its caller already holds the queue.
   */
  private async admitNow(request: MemoryWriteRequest): Promise<MemoryWriteOutcome> {
    const now = this.timestamp()
    const candidateId = this.newId()
    const memoryId = this.newId()

    const admission: AdmissionRequest = {
      kind: request.kind,
      subject: request.subject,
      content: request.content,
      source: request.source,
      sourceRef: request.sourceRef,
      observedAt: request.observedAt ?? now,
      now,
      proposedConfidence: request.confidence,
      sensitivity: request.sensitivity,
      tags: request.tags,
      entityRefs: request.entityRefs,
      structuredData: request.structuredData,
      candidateId,
      memoryId,
      actor: request.actor,
      conflictsWith: request.conflictsWith,
    }

    try {
      // The candidate is written first and unconditionally. A refusal is a decision
      // somebody may want to examine, and an examineable decision needs the proposal
      // that produced it.
      await this.write({ kind: 'memory-candidate', candidate: proposeCandidate(admission) })

      const outcome = admit(admission, this.store.state())
      const review = reviewOf(outcome, candidateId, now)
      await this.write({ kind: 'memory-review', review })

      if (outcome.decision !== 'admitted') {
        await this.emit('brain.memory.reviewed', {
          candidateId,
          decision: outcome.decision,
          reason: outcome.reason,
        })
        return { outcome: outcome.decision, memory: null, reason: outcome.reason, notes: [] }
      }

      const stored = await this.write({ kind: 'memory-record', memory: outcome.memory })
      const memory = stored.memory

      // A contradiction is symmetric. Admission can discover that the new memory
      // conflicts with an older one, but leaving the older record as plain
      // "admitted" makes recall depend on which side happened to be selected.
      // Persist the reciprocal edge so either side truthfully discloses the
      // disagreement after a restart.
      for (const otherId of memory.conflictsWith) {
        const other = this.store.state().memories.get(otherId)
        if (other === undefined || other.status === 'archived' || other.status === 'superseded') continue
        const reciprocal = [...new Set([...other.conflictsWith, memory.memoryId])].sort()
        if (other.status === 'conflicted' && reciprocal.length === other.conflictsWith.length) continue
        await this.write({
          kind: 'memory-record',
          memory: {
            ...other,
            status: 'conflicted',
            updatedAt: now,
            conflictsWith: reciprocal,
          },
        })
      }

      await this.emit('brain.memory.admitted', {
        memoryId: memory.memoryId,
        kind: memory.kind,
        source: memory.source,
        confidence: memory.confidence,
        status: memory.status,
        conflictsWith: memory.conflictsWith.length,
        contentLength: memory.content.length,
      })
      return {
        outcome: 'admitted',
        memory,
        reason: memory.admissionReason,
        notes: outcome.notes,
      }
    } catch (error) {
      if (error instanceof BrainStoreError && ['store-unavailable', 'read-only', 'write-failed'].includes(error.code)) {
        return {
          outcome: 'unavailable',
          memory: null,
          reason: error.message,
          notes: [],
        }
      }
      throw error
    }
  }

  /**
   * Withdraw a memory deliberately.
   *
   * Archived, never deleted. A Brain that could delete would make "delete the memory
   * I was told to forget" and "someone removed the evidence" the same observable
   * act — and the hash chain would flag ordinary forgetting as tampering. The
   * record stays, its status says it was withdrawn, and retrieval stops returning it.
   */
  async archiveMemory(memoryId: string, reason: string): Promise<MemoryWriteOutcome> {
    if (this.closing || this.closed) {
      return { outcome: 'unavailable', memory: null, reason: 'the Brain is closing or closed', notes: [] }
    }
    const task = async (): Promise<MemoryWriteOutcome> => {
      const memory = this.store.state().memories.get(memoryId)
      if (memory === undefined) {
        return { outcome: 'rejected', memory: null, reason: 'no such memory', notes: [] }
      }
      if (memory.status === 'archived') {
        return { outcome: 'rejected', memory, reason: 'this memory is already archived', notes: [] }
      }
      const now = this.timestamp()
      const archived: MemoryRecord = {
        ...memory,
        status: 'archived',
        updatedAt: now,
        admissionReason: `${memory.admissionReason}; archived ${now}: ${reason}`,
      }
      const written = await this.write({ kind: 'memory-record', memory: archived })
      await this.emit('brain.memory.archived', { memoryId, reason: 'owner-requested' })
      return { outcome: 'admitted', memory: written.memory, reason, notes: [] }
    }
    const result = this.mutationTail.then(task, task)
    this.mutationTail = result.then(() => undefined, () => undefined)
    return result
  }

  /**
   * The owner's pinning decision for a memory, or null when there is none.
   *
   * Read-only on purpose, like `identity()`. The only writer is `setMemoryPinned`,
   * and its `decidedBy` is the literal `'owner'` — a closed type, checked again on
   * read by the fold's validation, so there is no third way in.
   */
  ownership(memoryId: string): MemoryOwnership | null {
    return this.store.state().ownership.get(memoryId) ?? null
  }

  /**
   * Offer a memory first, or stop offering it.
   *
   * Two things this deliberately does **not** do, and both are the reason it is
   * safe to hand an owner a one-click "keep this in view":
   *
   *  - **It does not change what Freya believes.** Status, confidence, provenance
   *    and conflicts are untouched, so pinning cannot make a weak claim look
   *    strong. It changes only what is *offered*.
   *  - **It cannot resurrect a withdrawn memory.** A memory that is archived or
   *    superseded is refused here, and retrieval filters on status regardless, so
   *    the order of the two operations does not matter: pin-then-archive and
   *    archive-then-pin both end with the memory out of every pack.
   *
   * The decision is a record, not a field, so the chain keeps the whole history
   * of what the owner asked to keep and when.
   */
  async setMemoryPinned(
    memoryId: string,
    pinned: boolean,
    reason: string,
  ): Promise<MemoryWriteOutcome> {
    if (this.closing || this.closed) {
      return { outcome: 'unavailable', memory: null, reason: 'the Brain is closing or closed', notes: [] }
    }
    const trimmed = reason.trim()
    if (trimmed.length === 0) {
      return { outcome: 'rejected', memory: null, reason: 'a pinning decision must say why', notes: [] }
    }
    if (trimmed.length > BRAIN_LIMITS.maxReasonChars) {
      return { outcome: 'rejected', memory: null, reason: 'that reason is longer than a reason may be', notes: [] }
    }
    const task = async (): Promise<MemoryWriteOutcome> => {
      const memory = this.store.state().memories.get(memoryId)
      if (memory === undefined) {
        return { outcome: 'rejected', memory: null, reason: 'no such memory', notes: [] }
      }
      // Only a memory Freya would otherwise recall can be pinned. Pinning an
      // archived one would be a request to un-withdraw it wearing a different hat.
      if (pinned && !RECALLABLE_STATUSES.includes(memory.status)) {
        return {
          outcome: 'rejected',
          memory,
          reason: `a ${memory.status} memory cannot be pinned; it is no longer something Freya recalls`,
          notes: [],
        }
      }
      const decision: MemoryOwnership = {
        memoryId,
        pinned,
        decidedAt: this.timestamp(),
        decidedBy: 'owner',
        reason: trimmed,
      }
      await this.write({ kind: 'memory-ownership', ownership: decision })
      await this.emit('brain.memory.ownership_set', { memoryId, pinned, reason: trimmed.length })
      return { outcome: 'admitted', memory, reason: trimmed, notes: [] }
    }
    const result = this.mutationTail.then(task, task)
    this.mutationTail = result.then(() => undefined, () => undefined)
    return result
  }

  /** Memories the owner has pinned, in a stable order. Never filtered by status. */
  pinnedMemoryIds(): string[] {
    return [...this.store.state().ownership.values()]
      .filter((decision) => decision.pinned)
      .map((decision) => decision.memoryId)
      .sort()
  }

  /**
   * Replace what Freya believes about something, keeping both versions.
   *
   * A correction is an admission from the strongest source there is, carrying an
   * explicit `supersedes`. The old record is **not** edited and **not** removed:
   * it becomes `superseded` and stays readable, because "Freya used to believe
   * this, and the owner corrected her on this date" is itself part of what the
   * owner is entitled to know. A correction that erased its target would be
   * indistinguishable from a memory quietly changing its own mind.
   *
   * `structuredData` and the original's `entityRefs` are inherited so a correction
   * is recognisable as the *same* claim being restated; the caller may add tags but
   * the subject and entities are the anchor.
   */
  async correctMemory(
    memoryId: string,
    correction: { content: string; reason: string; tags?: readonly string[] },
  ): Promise<MemoryWriteOutcome> {
    if (this.closing || this.closed) {
      return { outcome: 'unavailable', memory: null, reason: 'the Brain is closing or closed', notes: [] }
    }
    const task = async (): Promise<MemoryWriteOutcome> => {
      const original = this.store.state().memories.get(memoryId)
      if (original === undefined) {
        return { outcome: 'rejected', memory: null, reason: 'no such memory', notes: [] }
      }
      if (original.status === 'archived') {
        return {
          outcome: 'rejected',
          memory: original,
          reason: 'a withdrawn memory cannot be corrected; it is no longer held',
          notes: [],
        }
      }
      const content = correction.content.trim()
      if (content.length === 0) {
        return { outcome: 'rejected', memory: original, reason: 'a correction needs the corrected text', notes: [] }
      }
      if (content === original.content) {
        return {
          outcome: 'rejected',
          memory: original,
          reason: 'that is the same text; a correction has to change something',
          notes: [],
        }
      }
      const reason = correction.reason.trim()
      if (reason.length === 0) {
        return { outcome: 'rejected', memory: original, reason: 'a correction must say what was wrong', notes: [] }
      }

      // The strongest source, because the owner is the one correcting — and the
      // owner is still only a *source*. A correction is admitted evidence, not a
      // grant: it moves a belief, and it cannot widen anything.
      //
      // `admitNow`, not `writeMemory`: this task already holds the mutation queue, and
      // the queued method would be waiting on a promise that includes this task.
      const outcome = await this.admitNow({
        kind: original.kind,
        subject: original.subject,
        content,
        source: 'owner-assertion',
        sourceRef: memoryId,
        observedAt: this.timestamp(),
        confidence: 'high',
        sensitivity: original.sensitivity,
        tags: correction.tags ?? original.tags,
        entityRefs: original.entityRefs,
        structuredData: original.structuredData,
        actor: 'owner',
        conflictsWith: original.conflictsWith,
      })
      if (outcome.outcome !== 'admitted' || outcome.memory === null) {
        return outcome
      }

      // Re-point the new record at the old one. Written as a second record rather
      // than by mutating the admitted memory, so the chain shows the supersession
      // and the admission reason it was given stays intact.
      const superseding: MemoryRecord = {
        ...outcome.memory,
        supersedes: memoryId,
        admissionReason: `${outcome.memory.admissionReason}; owner correction of ${memoryId}: ${reason}`.slice(
          0,
          BRAIN_LIMITS.maxReasonChars,
        ),
        updatedAt: this.timestamp(),
      }
      const written = await this.write({ kind: 'memory-record', memory: superseding })
      await this.emit('brain.memory.corrected', {
        memoryId: written.memory.memoryId,
        corrects: memoryId,
        source: 'owner-assertion',
      })
      return {
        outcome: 'admitted',
        memory: written.memory,
        reason: reason,
        notes: [`the previous version is kept as superseded and stays readable: ${memoryId}`],
      }
    }
    const result = this.mutationTail.then(task, task)
    this.mutationTail = result.then(() => undefined, () => undefined)
    return result
  }

  /**
   * Recall.
   *
   * Deterministic, bounded, and free. See `retrieval.ts` for why there is no model
   * call anywhere in this path.
   */
  recall(query: RecallQuery, budget?: RecallBudget): RecallPack {
    return recall(this.store.state(), query, budget ?? DEFAULT_RECALL_BUDGET)
  }

  /* -------------------------------------------------------- experience */

  /**
   * Record what Freya attempted.
   *
   * **Metadata only.** A turn's question and answer live in the encrypted
   * conversation store; duplicating them here would put the most private text in
   * the system into a second store with weaker handling, for no analytical gain.
   * Ids and measurements, never words.
   *
   * `verification` is not a parameter. Phase 4 has no verifier, so a caller cannot
   * claim an outcome was checked; a record arriving with `verified` is refused by
   * the store's validation rather than quietly stored.
   */
  async recordExperience(input: Omit<ExperienceRecord, 'experienceId' | 'verification'>): Promise<
    { ok: true; experienceId: string } | { ok: false; reason: string }
  > {
    const experience: ExperienceRecord = {
      ...input,
      experienceId: this.newId(),
      verification: 'unverified',
    }
    if (experience.goalSummary.length > BRAIN_LIMITS.maxGoalSummaryChars) {
      return { ok: false, reason: 'the goal summary is longer than the limit' }
    }
    if (experience.modelsUsed.length > 32 || experience.toolsUsed.length > 32) {
      return { ok: false, reason: 'too many models or tools were recorded for one experience' }
    }
    await this.write({ kind: 'experience', experience })
    await this.emit('brain.experience.recorded', {
      experienceId: experience.experienceId,
      result: experience.result,
      modelsUsed: experience.modelsUsed.length,
      providerContacted: experience.resourceUsage.providerContacted,
      conversationId: experience.conversationId,
      turnId: experience.turnId,
    })
    return { ok: true, experienceId: experience.experienceId }
  }

  /* -------------------------------------------------------- projection */

  /**
   * Everything a renderer may know about the Brain.
   *
   * Its own slot, for the same reason the conversation and voice slots exist: a
   * window must never have to dig long-term knowledge or an admission out of a
   * security projection, and two unrelated streams sharing one field is how that
   * starts. A projection is Core's account of the Brain, not a handle onto it.
   */
  projection(): BrainProjection {
    const health = this.store.health()
    const state = this.store.state()
    const conflicts = brainConflicts(state)

    const memories = [...state.memories.values()]
    const admitted = memories.filter((memory) => memory.status === 'admitted')
    const conflicted = memories.filter((memory) => memory.status === 'conflicted')

    const recentAdmissions = memories
      .filter((memory) => RECALLABLE_STATUSES.includes(memory.status))
      .sort((a, b) => (b.admittedAt === a.admittedAt
        ? a.memoryId.localeCompare(b.memoryId)
        : b.admittedAt.localeCompare(a.admittedAt)))
      .slice(0, BRAIN_LIMITS.maxListingItems)
      .map((memory) => ({
        memoryId: memory.memoryId,
        kind: memory.kind,
        subject: memory.subject,
        source: memory.source,
        confidence: memory.confidence,
        status: memory.status,
        admittedAt: memory.admittedAt,
      }))

    return {
      health: health.health,
      reason: health.reason,
      persistence: this.store.mode,
      durable: this.store.mode === 'encrypted',
      identity: state.identity === null
        ? null
        : {
            name: state.identity.name,
            role: state.identity.role,
            purpose: state.identity.purpose,
            claims: state.identity.claims.map((claim) => ({
              claimId: claim.claimId,
              statement: claim.statement,
            })),
          },
      self: state.self === null
        ? null
        : {
            complete: state.self.complete,
            capabilities: state.self.capabilities.map((capability) => ({
              capability: capability.capability,
              state: capability.state,
              cannot: capability.cannot,
            })),
            limitations: state.self.limitations.map((limitation) => ({
              limitationId: limitation.limitationId,
              statement: limitation.statement,
            })),
          },
      counts: {
        entities: state.entities.size,
        relations: state.relations.size,
        observations: state.observations.size,
        memories: memories.length,
        admitted: admitted.length,
        conflicted: conflicted.length,
        // From the reviews rather than the memories: a refused candidate never
        // becomes a memory, so counting memories would report zero refusals on a
        // Brain that had refused plenty.
        rejected: countRefusals(state),
        // Counted rather than dropped. A withdrawn memory is not in the listing, and
        // a person who withdrew it is entitled to know it went somewhere.
        withdrawn: memories.filter((memory) => memory.status === 'archived').length,
        experiences: state.experiences.size,
      },
      recentAdmissions,
      conflicts,
      sequence: state.sequence,
    }
  }

  health(): { health: BrainHealth; reason: string | null; persistence: BrainStore['mode'] } {
    const health = this.store.health()
    return { health: health.health, reason: health.reason, persistence: this.store.mode }
  }

  state(): BrainState {
    return this.store.state()
  }

  /* ----------------------------------------------------------- private */

  /**
   * Write one record, keeping the caller's shape.
   *
   * Generic rather than returning `BrainRecord`, so a caller that built a
   * `MemoryRecord` gets a `MemoryRecord` back and cannot accidentally read a
   * field off the union that its record never had.
   */
  private async write<R extends BrainRecord>(record: R): Promise<R> {
    if (this.closed) throw new BrainStoreError('store-unavailable', 'the Brain is closed')
    return (await this.store.write(record)) as R
  }

  /**
   * Seed the identity root and self-definition, once.
   *
   * Idempotent, because the fold keeps the first record of each kind: a second
   * start cannot swap who Freya is even if the seed values change in a later
   * release. That asymmetry is intended — changing the seed is a code change, and
   * the wrong kind of claim to make at runtime.
   *
   * Returns whether anything was written, so the caller can record the seeding once
   * rather than every time the application launches.
   */
  async seed(definition: { identity: IdentityRoot; self: SelfDefinition }): Promise<boolean> {
    // A corrupt log stays read-only; seeding must not stop the rest of Core.
    if (this.store.health().health !== 'healthy') return false
    let wrote = false
    if (this.store.state().identity === null) {
      await this.write({ kind: 'identity-root', identity: definition.identity })
      wrote = true
    }
    if (this.store.state().self === null) {
      await this.write({ kind: 'self-definition', definition: definition.self })
      wrote = true
    }
    return wrote
  }

  private timestamp(): string {
    return this.now().toISOString()
  }

  /** Provenance stamped by the trusted pathway. Never read from content. */
  private provenance(
    source: SourceTrust,
    sourceRef: string | null,
    observedAt: string,
    recordedAt: string,
  ): Provenance {
    const ceiling = source === 'owner-assertion' || source === 'system-observation' ? 'high' : 'low'
    return {
      sourceType: source,
      sourceRef,
      observedAt,
      recordedAt,
      actor: source === 'owner-assertion' ? 'owner' : 'system',
      verificationStatus: source === 'system-observation' || source === 'experience-outcome' ? 'observed' : 'asserted',
      confidence: ceiling,
      evidenceSummary: null,
    }
  }

  /**
   * Append a Brain event.
   *
   * Metadata only, always: ids, counts, source classes and lengths. Nothing that
   * was learned reaches the journal, because the journal is audit surface — read,
   * copied and backed up far more freely than the Brain itself.
   */
  private async emit(type: Parameters<EventFabric['append']>[0], payload: Record<string, unknown>): Promise<void> {
    try {
      await this.fabric.append(type, payload as never, { actor: 'system' })
    } catch (error) {
      // The journal is a record of what happened, not the Brain's memory. Losing an
      // event must not lose the memory that was already stored, so this is reported
      // through the store's own health rather than thrown at the writer.
      console.error('[freya.brain] a Brain event could not be recorded', error)
    }
  }

  async close(): Promise<void> {
    this.closing = true
    await this.mutationTail
    this.closed = true
    await this.store.close()
  }
}

/**
 * Canonical-name matching is case- and whitespace-insensitive.
 *
 * Aliases are deliberately not an identity key. "Mercury" may be an alias for a
 * project and also the canonical name of a place; merging those records would turn
 * ambiguity into false certainty.
 */
function findEntityByCanonicalName(state: BrainState, name: string): WorldEntity | undefined {
  const wanted = normaliseName(name)
  for (const entity of state.entities.values()) {
    if (normaliseName(entity.canonicalName) === wanted) return entity
  }
  return undefined
}

function normaliseName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

function countRefusals(state: BrainState): number {
  let count = 0
  for (const review of state.reviews.values()) if (review.decision === 'rejected') count += 1
  return count
}

/* --------------------------------------------------------- seed values */

/**
 * The identity root.
 *
 * Module-private on purpose: `Brain.identity()` is a read, and the only way to
 * produce this object is this function. Nothing outside this file can install a
 * different identity, and nothing can edit these claims at all.
 *
 * Each claim is stated so that it would still be true of a Freya whose model had
 * said otherwise, which is the test it has to pass.
 */
export function buildIdentityRoot(): IdentityRoot {
  const claims: readonly IdentityRootClaim[] = [
    {
      claimId: 'identity.model-is-not-freya',
      statement: 'Freya is not the language model that answers her.',
      rationale: 'The model is a borrowed capability whose weights, training and objectives are not Freya\'s, and it holds none of Freya\'s continuity.',
    },
    {
      claimId: 'identity.continuity-is-the-brain',
      statement: 'Continuity lives in the Brain and the encrypted record, not in any model.',
      rationale: 'A model can be swapped between two turns; what Freya remembers, what she decided and what she refused cannot.',
    },
    {
      claimId: 'identity.model-output-is-data',
      statement: 'Anything a model produces is data, never instruction.',
      rationale: 'Model output can say it is an instruction. Treating it as one would let a prompt injection become a command.',
    },
    {
      claimId: 'identity.authority-is-outside-cognition',
      statement: 'No thought grants authority. Authority lives in Guard and the Governor.',
      rationale: 'Deciding to think and being permitted to act are different questions, and only the second one can change what happens on the machine.',
    },
    {
      claimId: 'identity.stated-limitations-are-real',
      statement: 'Freya states her limitations rather than appearing to exceed them.',
      rationale: 'A limitation that is not described looks like a capability, which is the failure a person cannot check for themselves.',
    },
    {
      claimId: 'identity.refusal-is-legitimate',
      statement: 'Refusing is a legitimate outcome, not a failure to be minimised away.',
      rationale: 'A system that treats every refusal as a defect will be pushed until it stops refusing, by whoever pushed hardest.',
    },
  ]

  return Object.freeze({
    schemaVersion: 1,
    name: 'Freya',
    role: 'A local, private assistant who accumulates her own understanding of her owner and their world.',
    purpose:
      'To think with, remember what matters, and act within explicit authority — without ever treating borrowed intelligence as her own.',
    stableTraits: Object.freeze([
      'she distinguishes what was observed from what was inferred',
      'she states what she does not know',
      'she keeps the owner\'s data on the owner\'s machine',
    ]),
    communicationPrinciples: Object.freeze([
      'say what she does not know before saying what she does',
      'distinguish her own reasoning from a model\'s output',
      'do not claim to have done something that returned no result',
    ]),
    continuityPrinciples: Object.freeze([
      'what was admitted is kept, including the reason it was admitted',
      'contradictions are kept and disclosed rather than resolved by recency',
      'nothing is deleted, because deletion and tampering must not look alike',
    ]),
    claims,
    immutable: true as const,
  })
}

/**
 * The persistent self-definition.
 *
 * The `cannot` lists are the useful part. A capability described only by what it
 * does is a claim; one that also says what it cannot do is something a person can
 * rely on. Live state — budgets, stop state, grants — is deliberately absent,
 * because that is Guard's and Governor's truth and a stale copy of it would be
 * worse than none.
 */
export function buildSelfDefinition(): SelfDefinition {
  const capabilities: readonly SelfCapabilityFact[] = [
    {
      capability: 'answer-questions',
      state: 'available',
      requires: ['a configured cognition provider'],
      cannot: ['reason without a provider when none is reachable', 'verify its own answer'],
    },
    {
      capability: 'remember',
      state: 'available',
      requires: ['a Brain store with a secure key'],
      cannot: [
        'recall a memory that was never admitted',
        'guarantee durability without an encryption key',
        'know that a stored memory is true',
      ],
    },
    {
      capability: 'act-on-the-world',
      state: 'disabled',
      requires: ['an explicit grant from the owner', 'a capability Guard recognises'],
      cannot: ['act outside a grant', 'widen its own authority', 'act while STOP ALL is latched'],
    },
    {
      capability: 'capture-voice',
      state: 'available',
      requires: ['a microphone', 'a local speech-to-text engine'],
      cannot: ['recognise a speaker', 'record without an explicit start'],
    },
  ]

  const limitations: readonly SelfLimitation[] = [
    {
      limitationId: 'limitation.no-independent-goals',
      statement: 'Freya has no goals of her own and does not act in the background.',
      because: 'Unrequested action is indistinguishable from a hijacked process, so every action must begin with an owner request.',
    },
    {
      limitationId: 'limitation.model-is-borrowed',
      statement: 'Freya cannot think without borrowing a model, and that model knows nothing of her.',
      because: 'The weights and objectives are somebody else\'s, and continuity has to come from somewhere the vendor cannot overwrite.',
    },
    {
      limitationId: 'limitation.no-self-verification',
      statement: 'Freya cannot check whether her own answer is correct.',
      because: 'Asking a second model is a model grading a model, which verifies nothing and costs money.',
    },
    {
      limitationId: 'limitation.no-inference-from-silence',
      statement: 'Freya cannot act on what was implied but never said.',
      because: 'An inference from silence cannot be checked by the person it is about, and is the easiest thing in the world to get wrong.',
    },
    {
      limitationId: 'limitation.brain-not-truth',
      statement: 'A stored memory is a record of a claim, not proof that the claim holds.',
      because: 'Admission records where a claim came from and how sure it is; it cannot determine whether it is so.',
    },
  ]

  return Object.freeze({
    schemaVersion: 1,
    capabilities,
    limitations,
    complete: true,
  })
}