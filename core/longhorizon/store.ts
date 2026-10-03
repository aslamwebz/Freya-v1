import type { GoalContent } from './types'

/**
 * THE GOAL CONTENT STORE.
 *
 * A goal's *content* — its title, its description, its completion criteria — is
 * as private as a Mission's intent. People write things here like "find me
 * another job" and "help me handle my house move". So it is stored apart
 * from everything else, under its own key, and it is the only part of a goal that
 * is encrypted.
 *
 * ## Why this exists when the journal already holds the metadata
 *
 * The `longhorizon.*` journal records ids, states, counts, timestamps and closed
 * reason codes. That is enough to reconstruct *that* a goal existed and how it
 * ended, and not one byte of what it was for. That split is the property: the
 * journal can be backed up, copied to another machine, and read while debugging
 * without any of it being anybody's business.
 *
 * So this store holds content and the journal holds history, and neither can
 * reconstruct the other.
 *
 * ## No query language
 *
 * There is no `query(sql)` and no way to reach content other than by a goal id
 * the caller was already given. A generic read surface over the most private text
 * in the system would make "read the store" and "read everything" the same
 * capability.
 */

export type GoalContentResult =
  | { readonly ok: true; readonly value: GoalContent }
  | { readonly ok: false; readonly code: GoalStoreErrorCode; readonly reason: string }

export type GoalStoreErrorCode =
  | 'unavailable'
  | 'unauthenticated'
  | 'degraded'
  | 'not_found'
  | 'too_large'
  | 'invalid'
  | 'write_failed'

/**
 * A goal-store failure.
 *
 * A goal-content fault is **not** a security event: it cannot grant cognition,
 * clear a stop or widen a budget, and it does not lock Freya out either. The goal
 * is reported as degraded and everything else carries on — losing a goal is
 * recoverable, refusing to answer is not something a disk error gets to decide.
 */
export class GoalStoreError extends Error {
  constructor(
    readonly code: GoalStoreErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'GoalStoreError'
  }
}

export interface GoalStoreHealth {
  readonly health: 'healthy' | 'degraded' | 'unavailable'
  readonly reason: string | null
}

export interface GoalStore {
  /** What durability this store actually provides. Never a guess. */
  readonly mode: 'encrypted' | 'ephemeral'
  /** False whenever the content cannot survive a restart. */
  readonly durable: boolean
  /** Null when there is no fault. */
  readonly faultReason: string | null

  write(content: GoalContent): Promise<GoalContent>
  read(goalId: string): Promise<GoalContentResult>
  remove(goalId: string): Promise<boolean>
  health(): GoalStoreHealth
  close(): Promise<void>
}
