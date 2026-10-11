export const BRAIN_EVENT_TYPES = [
// Brain — metadata only.
  //
  // The Brain holds the most valuable long-term state in the system and the
  // journal is the least protected place it could go: audit logs get read, copied,
  // exported into backups and forwarded to people debugging things. So these carry
  // ids, counts, source classes and lengths. Never what was learned, never a
  // memory's text, never a subject a person typed.
  //
  // Note what is absent too: there is no `brain.memory.recalled`. Recall happens
  // constantly and putting it in the durable log would turn the journal into a
  // record of Freya's private associations.
  'brain.seeded',
'brain.memory.admitted',
'brain.memory.reviewed',
'brain.memory.archived',
'brain.memory.ownership_set',
'brain.memory.corrected',
'brain.world.entity_noted',
'brain.world.related',
'brain.world.observed',
'brain.experience.recorded',
'brain.degraded',
] as const
export interface BrainEventPayloads {
/* --------------------------------------------------------------- brain */

  /** The identity root and self-definition were written, once. */
  'brain.seeded': {
    identityName: string
    identityClaimCount: number
    capabilityCount: number
    limitationCount: number
  }

/**
   * A memory passed admission.
   *
   * `contentLength` is the only measurement of what was learned that leaves the
   * Brain, and it is measured for the same reason the conversation turn event
   * measures a message: so an operator can see that something substantial was
   * learned without the journal becoming a transcript of Freya's memory.
   */
  'brain.memory.admitted': {
    memoryId: string
    kind: string
    /** The trust class the trusted pathway assigned. Never the content's claim. */
    source: string
    confidence: string
    status: string
    /** How many stored records contradict this one. */
    conflictsWith: number
    contentLength: number
  }

/**
   * A candidate was refused or deferred.
   *
   * The reason is recorded because a refusal somebody cannot examine is
   * indistinguishable from a refusal that was arbitrary. It states the *policy*
   * that decided, not the text that was refused.
   */
  'brain.memory.reviewed': {
    candidateId: string
    decision: 'rejected' | 'deferred'
    reason: string
  }

/** A memory was withdrawn deliberately. Archived, never deleted. */
  'brain.memory.archived': { memoryId: string; reason: string }

/**
   * The owner changed what Freya keeps in view.
   *
   * Metadata only, and the shape is the defence: `reasonLength` rather than
   * `reason`, because the journal is audit surface that gets read, copied and
   * backed up far more freely than the Brain itself, and an owner's explanation of
   * why they pinned something is exactly the kind of private aside that has no
   * business in it. The words stay in the encrypted record; only the fact, the
   * target and the size of the explanation are journalled.
   */
  'brain.memory.ownership_set': { memoryId: string; pinned: boolean; reasonLength: number }

/**
   * The owner corrected a memory.
   *
   * `corrects` names the superseded record rather than replacing it. A correction
   * that erased its target would be indistinguishable, from the outside, from a
   * memory quietly changing its own mind — so both ids are here, and the old one
   * stays readable in the Brain.
   */
  'brain.memory.corrected': { memoryId: string; corrects: string; source: string }

/** Something was noted. The name itself is not here, only its length. */
  'brain.world.entity_noted': {
    entityId: string
    entityType: string
    nameLength: number
    sourceType: string
  }

/**
   * A relation was recorded.
   *
   * `conflictingRelations` above zero means the Brain now holds two current claims
   * that disagree. That is a fact about the Brain's honesty and it is exactly what
   * a reader of the journal needs to see — it is the difference between "Freya
   * learned this" and "Freya learned two contradictory things".
   */
  'brain.world.related': {
    subjectEntityId: string
    predicate: string
    conflictingRelations: number
  }

/**
   * A source said something, kept as said.
   *
   * `statedLength` measures it; the statement stays in the Brain. An observation is
   * a record of a claim, not a claim, and promoting one is a separate decision that
   * produces a different event.
   */
  'brain.world.observed': {
    observationId: string
    sourceType: string
    statedLength: number
  }

/**
   * What Freya attempted, as metadata.
   *
   * `providerContacted` is the field that matters for cost, and `conversationId` /
   * `turnId` point at the encrypted conversation that holds the actual words — the
   * Brain never duplicated them.
   */
  'brain.experience.recorded': {
    experienceId: string
    result: string
    modelsUsed: number
    providerContacted: boolean
    conversationId: string | null
    turnId: string | null
  }

/**
   * The Brain's own integrity changed.
   *
   * A Brain-data fact, and emphatically **not** a security event. It is not in
   * `SECURITY_EVENT_TYPES`, and it must never be: a corrupt Brain cannot grant
   * cognition or clear a stop, and it does not lose authority either. Reporting it
   * in the security stream would let a disk error masquerade as a safety posture.
   */
  'brain.degraded': { reason: string }
}