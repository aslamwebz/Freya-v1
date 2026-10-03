import type { AcquisitionRequest, CapabilityGap, GateVerdictRecord, ActivationDecision, AcquisitionState } from './types'

/**
 * THE ACQUISITION STORE.
 *
 * The counterpart to the Learning and Life stores, and deliberately narrow: write one record,
 * report the folded state, report health, close. There is no query language — a generic query
 * surface reachable from a window would make "read what Freya is trying to acquire" and "read
 * everything Core knows about building" the same capability.
 *
 * There is also **no delete**, and that is not an oversight to be tidied away later. A request
 * that failed is evidence that a build was attempted and refused; if a caller could remove the
 * row, the next run of the same proposal would look like a first attempt, and the ledger would
 * learn nothing from its own history. Retention moves records to a terminal status with a
 * lifecycle reason instead, which keeps the fact.
 */

export type AcquisitionPersistenceMode = 'encrypted' | 'ephemeral' | 'memory' | 'unavailable'

export type AcquisitionFaultCode =
  | 'store-unavailable'
  | 'unauthenticated'
  | 'integrity-broken'
  | 'invalid-record'
  | 'write-failed'
  | 'too-large'
  | 'read-only'

/**
 * An acquisition-store failure.
 *
 * **An acquisition fault is never a security event, but it is not nothing either.** A damaged
 * request cannot activate anything, because activation is a conjunction over gates read from
 * this store and a gate this store cannot vouch for is treated as unsatisfied. So a fault
 * degrades the domain rather than stopping Freya — and the engine refuses writes while it is
 * degraded, because a request written on top of an unreadable chain is a claim about a
 * capability nobody can verify.
 */
export class AcquisitionStoreError extends Error {
  constructor(
    readonly code: AcquisitionFaultCode,
    message: string,
  ) {
    super(message)
    this.name = 'AcquisitionStoreError'
  }
}

export type AcquisitionHealth = 'healthy' | 'degraded' | 'unavailable'

/** One request's whole gate ledger. Stored as a unit, never split across rows. */
export interface GateLedgerWrite {
  readonly requestId: string
  readonly verdicts: readonly GateVerdictRecord[]
}

export type AcquisitionWrite = CapabilityGap | AcquisitionRequest | GateLedgerWrite | ActivationDecision

export interface AcquisitionStore {
  /** What durability this store actually provides. Never a guess. */
  readonly mode: AcquisitionPersistenceMode
  /** Why, when it is not `encrypted`. Null when it is. */
  readonly faultReason: string | null
  /** True when something on disk could not be believed. */
  readonly degradedReason: string | null

  write(record: AcquisitionWrite): Promise<void>

  /** The folded state. A live view for the owning process, not a copy to hand out. */
  state(): AcquisitionState

  health(): { health: AcquisitionHealth; reason: string | null }

  close(): Promise<void>
}