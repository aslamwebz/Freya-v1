import type { EconomicEventType, EconomicWakeActor, EconomicWakeKind, EconomicWakeSource } from './types'
import type { EvidenceObservation } from './evidence'
import type { PricePoint } from './types'
import type { EconomicJournalEntry } from './state'

/**
 * Everything the Economic Intelligence subsystem is allowed to ask the rest of Core for.
 *
 * This file is the whole of the integration surface, and the omissions are the design.
 * There is no port that returns a gateway, a provider, a permit, a capability, a
 * principal or a grant store. There is **no port that can spend** — not money and not a
 * token — because Phase 32's central claim is that it spends neither, and the strongest
 * available form of that claim is that the code which decides what to do has no way to
 * do it.
 *
 * There is no brokerage, venue, exchange, custodian, wallet or settlement port either,
 * and that absence is not an oversight to be fixed by a later lane. A port named
 * `placeRealOrder` would be the single most dangerous line anyone could add to this file,
 * and the way to make sure it is conspicuous rather than convenient is for the rest of
 * the shape to make clear that Phase 32 has no money to place.
 *
 * Two ports are worth reading twice:
 *
 *   - {@link EconomicPorts.guardAllows} and {@link EconomicPorts.governorAuthorized}
 *     take no argument. They cannot be told which capability to ask about or which
 *     decision to consult, because a caller that could name either could describe an
 *     authority nobody granted. Core picks the capability and derives the origin, cause
 *     and background flag, exactly as it does for the life loop.
 *   - {@link EconomicPorts.observationsFor} and {@link EconomicPorts.priceSeriesFor} are
 *     the two places the outside world enters, and both are **reads**. Nothing in this
 *     file can place anything, and nothing in it can fetch anything that is not an
 *     observation or a price.
 */

/** A payload the subsystem is allowed to write. Closed vocabulary, enforced by the fold. */
export type EconomicPayload = Readonly<Record<string, string | number | boolean | null>>

export interface EconomicPorts {
  /** ISO instant, injected. The subsystem has no clock of its own and never reads one. */
  now(): string
  /** A fresh id. Injected so the subsystem cannot widen its own vocabulary. */
  newId(): string
  /**
   * Append one economic event.
   *
   * Durable before it resolves. The subsystem's state is derived from these and from
   * nothing else, so a refused append must fail loudly rather than be swallowed — there
   * is no in-memory copy that would not be lost anyway.
   */
  append(type: EconomicEventType, payload: EconomicPayload): Promise<void>
  /** The whole durable journal, in sequence order. Read once, when the subsystem opens. */
  replay(): Promise<readonly EconomicJournalEntry[]>
  /** The STOP ALL latch, read fresh at every gate. */
  stopAllActive(): boolean
  /** Whether the journal can be believed. False means nothing new is acted on. */
  journalTrustworthy(): boolean
  /** Whether economic intelligence is switched on. Off means every action is denied. */
  enabled(): boolean
  /**
   * The Guard's verdict on the one capability this lane needs.
   *
   * Takes no argument on purpose: Core names the capability, evaluates it against the
   * owner principal and returns the answer. A port that accepted a capability string
   * would let a caller ask about — and be granted — a different one.
   */
  guardAllows(): boolean
  /**
   * The Governor's answer for economic work.
   *
   * Also takes no argument, for the same reason. Phase 32 asks no question of the
   * Governor about *specific* text — it has no prompt, because it makes no model call —
   * so there is nothing for a caller to smuggle past it.
   */
  governorAuthorized(): boolean
  /** Whether an owner approval this experiment requires has been given. */
  approvalSatisfied(experimentId: string): boolean
  /**
   * Bounded units of economic work still available this process.
   *
   * Not money, and never convertible into any. See `ECONOMIC_GATE_CHECKS` for why the
   * wire shape deliberately does not call this a budget.
   */
  budgetRemainingUnits(): number
  /**
   * Observations about one experiment, from whatever already-authorized research Core
   * has. A read.
   *
   * Returned rather than pushed, so the subsystem decides *when* to look and Core never
   * wakes it. The `since` bound is the caller's, and a caller that passes a far-past
   * instant gets more evidence rather than an unbounded stream — the evidence cap in
   * `admitEvidence` is what actually stops it.
   */
  observationsFor(experimentId: string, since: string): Promise<readonly EvidenceObservation[]>
  /**
   * A price series for one symbol. A read, and the only way a number reaches the
   * simulator.
   *
   * Phase 32 fetches nothing itself. Somebody else decides whether a market is worth
   * reading, hands over a series, and the simulation is a pure function of it.
   */
  priceSeriesFor(experimentId: string, symbol: string): Promise<readonly PricePoint[]>
  /** Something changed that a surface might be showing. */
  onChange(): void
}

/**
 * A wake, as Core raises one.
 *
 * `actor` arrives rather than being inferred because attribution is Core's job and this
 * module's is to *check* it against `ECONOMIC_WAKE_SOURCE_ACTOR`. A renderer, a model,
 * an agent, a connector, an external webhook and a self-scheduling timer are unauthorized
 * for every source, so "no renderer may drive economic intelligence" is a table.
 */
export interface EconomicWakeRequest {
  readonly source: EconomicWakeSource
  readonly kind: EconomicWakeKind
  readonly actor: EconomicWakeActor
  readonly experimentId: string | null
  readonly goalRef: string | null
  readonly sourceRef: string | null
  /** ISO instant the thing happened. Supplied by Core, never by the event. */
  readonly occurredAt: string
}