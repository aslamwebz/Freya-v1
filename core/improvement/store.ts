import type {
  ImprovementGateRecord,
  ImprovementProposal,
  ImprovementState,
  MergeDecision,
} from './types'

/**
 * THE IMPROVEMENT STORE.
 *
 * The counterpart to the Learning and Acquisition stores, and deliberately narrow: write one
 * record, report the folded state, report health, close. There is no query language — a generic
 * query surface reachable from a window would make "read what Freya wants to change about
 * herself" and "read everything Core knows about her own architecture" the same capability.
 *
 * There is also **no delete**, and that is not an oversight. A rolled-back change is evidence that
 * a change landed and was undone; if a caller could remove the row, the next proposal for the same
 * problem would look like a first attempt, and the ledger would learn nothing from its own history.
 * Retention moves records to a terminal status with a closure reason instead, which keeps the fact.
 */

export type ImprovementPersistenceMode = 'encrypted' | 'ephemeral' | 'memory' | 'unavailable'

export type ImprovementFaultCode =
  | 'store-unavailable'
  | 'unauthenticated'
  | 'integrity-broken'
  | 'invalid-record'
  | 'write-failed'
  | 'too-large'
  | 'read-only'

/**
 * An improvement-store failure.
 *
 * **A store fault is never a security event, but it is not nothing either.** A damaged ledger
 * cannot merge anything, because a merge is a conjunction over gates read from this store and a
 * gate this store cannot vouch for is treated as unsatisfied. So a fault degrades the domain
 * rather than stopping Freya — and the engine refuses writes while it is degraded, because a
 * merge decision written on top of an unreadable chain is a record of an approval nobody can
 * verify.
 */
export class ImprovementStoreError extends Error {
  constructor(
    readonly code: ImprovementFaultCode,
    message: string,
  ) {
    super(message)
    this.name = 'ImprovementStoreError'
  }
}

export type ImprovementHealth = 'healthy' | 'degraded' | 'unavailable'

/** One proposal's whole gate ledger. Stored as a unit, never split across rows. */
export interface GateLedgerWrite {
  readonly proposalId: string
  readonly verdicts: readonly ImprovementGateRecord[]
}

export type ImprovementWrite = ImprovementProposal | GateLedgerWrite | MergeDecision

export interface ImprovementStore {
  /** What durability this store actually provides. Never a guess. */
  readonly mode: ImprovementPersistenceMode
  /** Why, when it is not `encrypted`. Null when it is. */
  readonly faultReason: string | null
  /** True when something on disk could not be believed. */
  readonly degradedReason: string | null

  write(record: ImprovementWrite): Promise<void>

  /** The folded state. A live view for the owning process, not a copy to hand out. */
  state(): ImprovementState

  health(): { health: ImprovementHealth; reason: string | null }

  close(): Promise<void>
}