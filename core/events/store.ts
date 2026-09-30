import type { AnyCoreEvent } from './envelope'

/**
 * Durable event storage.
 *
 * The interface is deliberately tiny: append, read in order, read from a
 * sequence. Everything else — ordering, recovery, durability guarantees — is a
 * property of an implementation, and Phase 1 has one.
 *
 * Implementations must guarantee that `append` either persists the event or
 * throws. There is no partial success: a caller may treat a resolved promise as
 * "this event will be seen by anybody who replays the log".
 */
export interface EventStore {
  /**
   * Persist one event. Resolves only once the event is durable.
   * Rejects if it is not.
   */
  append(event: AnyCoreEvent): Promise<void>

  /** Every persisted event, in ascending sequence order. */
  readAll(): Promise<AnyCoreEvent[]>

  /** Persisted events with `sequence > afterSequence`, ascending. */
  readAfter(afterSequence: number): Promise<AnyCoreEvent[]>

  /** The highest persisted sequence, or 0 when the log is empty. */
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
