import type { VerifiedOutcome } from './types'
import type { KnowledgeRecord, LearningExperience, LearningState } from './types'

/**
 * THE LEARNING STORE.
 *
 * The counterpart to the Life and Relationship stores, and deliberately narrow: write one
 * record, report the folded state, report health, close. There is no query language — a
 * generic query surface reachable from a window would make "read what Freya learned" and
 * "read everything Core knows" the same capability.
 */

export type LearningPersistenceMode = 'encrypted' | 'ephemeral' | 'memory' | 'unavailable'

export type LearningFaultCode =
  | 'store-unavailable'
  | 'unauthenticated'
  | 'integrity-broken'
  | 'invalid-record'
  | 'write-failed'
  | 'too-large'
  | 'not-found'
  | 'read-only'

/**
 * A learning-store failure.
 *
 * **A learning fault is never a security event.** A damaged claim can neither grant
 * cognition nor clear a stop: nothing in this domain grants anything in the first place,
 * which is what makes that sentence true rather than reassuring. It is a statement about a
 * derived layer, so Core keeps running and the surface says Learning is degraded with a
 * reason.
 *
 * It is also, deliberately, not silently repaired. The safest thing Core can do with a set
 * of claims it cannot fully trust about its own competence is say so.
 */
export class LearningStoreError extends Error {
  constructor(
    readonly code: LearningFaultCode,
    message: string,
  ) {
    super(message)
    this.name = 'LearningStoreError'
  }
}

export type LearningHealth = 'healthy' | 'degraded' | 'unavailable'

export type LearningWrite = VerifiedOutcome | LearningExperience | KnowledgeRecord

export interface LearningStore {
  /** What durability this store actually provides. Never a guess. */
  readonly mode: LearningPersistenceMode
  /** Why, when it is not `encrypted`. Null when it is. */
  readonly faultReason: string | null
  /** True when something on disk could not be believed. Never a security fact. */
  readonly degradedReason: string | null

  write(record: LearningWrite): Promise<void>

  /**
   * Remove one record entirely — text, metadata, lifecycle, all of it.
   *
   * Distinct from `write`, which only ever *advances* a record. `LearningEngine.forget`
   * gates it: a live record must be withdrawn first, so a routine withdrawal can never
   * quietly delete the fact that Freya once claimed something.
   */
  forget(key: string): Promise<void>

  /** The folded state. A live view for the owning process, not a copy to hand out. */
  state(): LearningState

  health(): { health: LearningHealth; reason: string | null }

  close(): Promise<void>
}