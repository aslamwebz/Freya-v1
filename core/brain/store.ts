import type {
  ExperienceRecord,
  IdentityRoot,
  MemoryCandidate,
  MemoryRecord,
  MemoryReview,
  SelfDefinition,
  WorldEntity,
  WorldObservation,
  WorldRelation,
} from './types'

/**
 * The Brain Store.
 *
 * The Brain is Freya's own persistent state: identity, self, world, memory and
 * experience. It is deliberately **not** the conversation store with a different
 * name, and the differences are the reason this is a separate interface:
 *
 * | | conversation | brain |
 * | --- | --- | --- |
 * | lifetime | one device, months | years |
 * | record kinds | one | many, and growing |
 * | updates | append-only events | mutable projections, supersession |
 * | query | by conversation id | ranked, indexed, cross-cutting |
 * | value | the most private text Freya holds | the most valuable long-term state |
 * | integrity | per-record authentication | per-record **and** hash chain |
 *
 * The last row is the one that matters most. An authenticated record proves *this
 * line* was not edited; a hash chain additionally proves no line was **removed,
 * duplicated or reordered**. Deleting a memory Freya was told to forget is
 * indistinguishable from an attacker deleting evidence, so the Brain has to be able
 * to tell the difference.
 *
 * ## No query language
 *
 * There is no `query(sql)` and no way for a caller to express a filter the typed
 * API does not already offer. A Brain is high-value private data, and a generic
 * query surface over it — reachable from a renderer — would make "read the store"
 * and "read anything" the same capability.
 */

export type BrainPersistenceMode = 'encrypted' | 'ephemeral' | 'memory' | 'unavailable'

export type BrainFaultCode =
  | 'store-unavailable'
  | 'unauthenticated'
  | 'integrity-broken'
  | 'invalid-record'
  | 'write-failed'
  | 'too-large'
  | 'not-found'
  | 'read-only'

/**
 * A Brain-store failure.
 *
 * **A Brain fault is never a security event.** A corrupt Brain cannot grant
 * cognition, clear a stop, or widen a budget — and, just as importantly, it does
 * not *lose* authority either. Brain corruption is a statement about long-term
 * knowledge, not about whether Freya may act. Core keeps running, conversations
 * keep working, and the UI says the Brain is unavailable.
 */
export class BrainStoreError extends Error {
  constructor(
    readonly code: BrainFaultCode,
    message: string,
  ) {
    super(message)
    this.name = 'BrainStoreError'
  }
}

/** Brain health. Truthful, and never derived from anything the Brain was told. */
export type BrainHealth = 'healthy' | 'degraded' | 'unavailable'

/** One durable Brain record. The union the log stores and the fold replays. */
export type BrainRecord =
  | { kind: 'identity-root'; identity: IdentityRoot }
  | { kind: 'self-definition'; definition: SelfDefinition }
  | { kind: 'world-entity'; entity: WorldEntity }
  | { kind: 'world-relation'; relation: WorldRelation }
  | { kind: 'world-observation'; observation: WorldObservation }
  | { kind: 'memory-candidate'; candidate: MemoryCandidate }
  | { kind: 'memory-record'; memory: MemoryRecord }
  | { kind: 'memory-review'; review: MemoryReview }
  | { kind: 'experience'; experience: ExperienceRecord }

export type BrainRecordKind = BrainRecord['kind']

/** The folded state a store keeps in memory, rebuilt deterministically on open. */
export interface BrainState {
  identity: IdentityRoot | null
  self: SelfDefinition | null
  entities: Map<string, WorldEntity>
  relations: Map<string, WorldRelation>
  observations: Map<string, WorldObservation>
  candidates: Map<string, MemoryCandidate>
  memories: Map<string, MemoryRecord>
  reviews: Map<string, MemoryReview>
  experiences: Map<string, ExperienceRecord>
  /** Monotonic write position, and the chain head the next record will extend. */
  sequence: number
}

export function emptyBrainState(): BrainState {
  return {
    identity: null,
    self: null,
    entities: new Map(),
    relations: new Map(),
    observations: new Map(),
    candidates: new Map(),
    memories: new Map(),
    reviews: new Map(),
    experiences: new Map(),
    sequence: 0,
  }
}

export interface BrainStore {
  /** What durability this store actually provides. Never a guess. */
  readonly mode: BrainPersistenceMode
  /** Why, when it is not `encrypted`. Null when it is. */
  readonly faultReason: string | null
  /**
   * True when something on disk could not be believed.
   *
   * A Brain-data fact. Surfaced so the UI can say so, and it never changes a
   * security state in either direction.
   */
  readonly degradedReason: string | null

  /** Append one record, apply it, and return the stored form. */
  write(record: BrainRecord): Promise<BrainRecord>

  /** The folded state. A live view for the owning process, not a copy to hand out. */
  state(): BrainState

  health(): { health: BrainHealth; reason: string | null }

  close(): Promise<void>
}
