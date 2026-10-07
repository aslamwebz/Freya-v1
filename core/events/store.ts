import type { AnyCoreEvent } from './envelope'

/**
 * Ordered event storage.
 *
 * The interface is deliberately tiny: append, read in order, read from a
 * sequence. Everything else — ordering, recovery, durability guarantees — is a
 * property of an implementation. Core reports active durability separately.
 *
 * Implementations must guarantee that `append` either retains the event or
 * throws. There is no partial success: a caller may treat a resolved promise as
 * "this event is available for replay in the active store". Durable stores
 * additionally persist it across restart; ephemeral fallback does not.
 */
export interface EventStore {
  /**
   * Retain one event before publishing it. Rejects if the active store cannot.
   */
  append(event: AnyCoreEvent): Promise<void>

  /** Every retained event, in ascending sequence order. */
  readAll(): Promise<AnyCoreEvent[]>

  /** Retained events with `sequence > afterSequence`, ascending. */
  readAfter(afterSequence: number): Promise<AnyCoreEvent[]>

  /** The highest retained sequence, or 0 when the log is empty. */
  lastSequence(): Promise<number>

  /** A short description of the backing store, for the status projection. */
  describe(): string

  close(): Promise<void>
}

/**
 * Reduce a log to a value, for replay.
 *
 * A reducer is where the "replay has no side effects" rule is enforced
 * structurally: it is a pure function from events to a value, and a reducer
 * that appended an event or called out to a provider would be violating its own
 * type signature rather than merely being unwise.
 */
export type EventReducer<S> = (state: S, event: AnyCoreEvent) => S
