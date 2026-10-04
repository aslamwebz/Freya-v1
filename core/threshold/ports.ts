import type {
  ThresholdEventType,
  ThresholdWakeActor,
  ThresholdWakeKind,
  ThresholdWakeSource,
} from './types'
import type { ThresholdJournalEntry } from './state'

/**
 * Everything the Mature Freya Threshold subsystem is allowed to ask the
 * rest of Core for.
 *
 * This file is the whole of the integration surface, and the omissions are
 * the design. There is no port that returns a gateway, a provider, a permit,
 * a capability, a principal or a grant store. There is **no port that can
 * spend** — not money and not a token.
 */

/** A payload the subsystem is allowed to write. */
export type ThresholdPayload = Readonly<Record<string, string | number | boolean | null>>

export interface ThresholdPorts {
  /** ISO instant, injected. */
  now(): string
  /** A fresh id. Injected so the subsystem cannot widen its own vocabulary. */
  newId(): string
  /**
   * Append one threshold event.
   *
   * Durable before it resolves.
   */
  append(type: ThresholdEventType, payload: ThresholdPayload): Promise<void>
  /** The whole durable journal, in sequence order. */
  replay(): Promise<readonly ThresholdJournalEntry[]>
  /** The STOP ALL latch, read fresh at every gate. */
  stopAllActive(): boolean
  /** Whether the journal can be believed. */
  journalTrustworthy(): boolean
  /** Whether the threshold subsystem is switched on. */
  enabled(): boolean
  /**
   * The Guard's verdict on the one capability this lane needs.
   *
   * Takes no argument on purpose: Core names the capability.
   */
  guardAllows(): boolean
  /**
   * The Governor's answer for threshold work.
   */
  governorAuthorized(): boolean
  /** Whether an owner approval has been given. */
  approvalSatisfied(target: string): boolean
  /**
   * Bounded units of threshold work still available this process.
   */
  budgetRemainingUnits(): number
  /** Something changed that a surface might be showing. */
  onChange(): void
}

/**
 * A wake, as Core raises one.
 */
export interface ThresholdWakeRequest {
  readonly source: ThresholdWakeSource
  readonly kind: ThresholdWakeKind
  readonly actor: ThresholdWakeActor
  readonly goalRef: string | null
  readonly sourceRef: string | null
  readonly occurredAt: string
}
