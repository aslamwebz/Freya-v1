import type { AnyCoreEvent } from './envelope'
import type { EventStore } from './store'

/**
 * The runtime fallback when durable storage cannot be opened.
 *
 * Lives in memory for one process only. A Core that is using it must never
 * claim a durable sequence, must never claim a recoverable history, and must
 * say so on the status projection: anything written here disappears when the
 * process exits. It never changes or clears the previous on-disk journal.
 *
 * The interface is the same `EventStore` the rest of the Core programs
 * against, so the fallback is invisible to the EventFabric and to the
 * subsystems: a Core that booted into ephemeral mode is running the same
 * code paths, with the same guards and the same STOP-ALL semantics, but
 * new event history is temporary. `describe()` returns a stable string the status
 * uses to tell the operator which store is in play.
 */
export class EphemeralEventStore implements EventStore {
  /** Appended by `append`, in ascending sequence order. */
  private readonly events: AnyCoreEvent[] = []
  /** Monotonic sequence, assigned here rather than by the fabric so the store is self-contained. */
  private nextSequence = 0
  /** Closed marker. Reads/writes after close throw; tests assert on it. */
  private closed = false

  /** Inspect-only accessor for tests and the diagnostics logger. */
  get size(): number {
    return this.events.length
  }

  async append(event: AnyCoreEvent): Promise<void> {
    if (this.closed) {
      throw new Error('EphemeralEventStore: append after close')
    }
    // The fabric normally assigns the sequence before calling append, but the
    // store is also reachable directly (e.g. from the diagnostics test seam),
    // so we accept either: a zero means \"assign me one\", anything else is
    // taken as the caller's choice and must be monotonic.
    const incoming = event.sequence
    const assigned = incoming === 0 ? this.nextSequence + 1 : incoming
    if (assigned <= this.nextSequence) {
      throw new Error(
        `EphemeralEventStore: sequence ${assigned} is not greater than the current tail ${this.nextSequence}`,
      )
    }
    this.nextSequence = assigned
    this.events.push({ ...structuredClone(event), sequence: assigned })
  }

  async readAll(): Promise<AnyCoreEvent[]> {
    if (this.closed) {
      throw new Error('EphemeralEventStore: readAll after close')
    }
    return structuredClone(this.events)
  }

  async readAfter(afterSequence: number): Promise<AnyCoreEvent[]> {
    if (this.closed) {
      throw new Error('EphemeralEventStore: readAfter after close')
    }
    return structuredClone(this.events.filter((event) => event.sequence > afterSequence))
  }

  async lastSequence(): Promise<number> {
    if (this.closed) {
      throw new Error('EphemeralEventStore: lastSequence after close')
    }
    return this.nextSequence
  }

  describe(): string {
    // A stable, human-readable string the status projection reports verbatim.
    // Includes the word `ephemeral` so a reader never confuses this with the
    // durable store, and the sequence so a debugging tool can see the size.
    return `ephemeral://memory (${String(this.events.length)} event(s))`
  }

  async close(): Promise<void> {
    this.closed = true
  }
}
