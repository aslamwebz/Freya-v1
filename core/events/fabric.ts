import { randomUUID } from 'node:crypto'
import { CORE_EVENT_SCHEMA_VERSION, type AnyCoreEvent, type CoreEventType } from './envelope'
import type { EventStore } from './store'
import type { PrincipalId } from '../protocol/core-protocol'

/**
 * The event fabric.
 *
 * One rule holds everything together: **an event becomes visible to subscribers
 * only after its append has succeeded.** The store is awaited first; there is
 * no code path that publishes first and persists later, because that is the
 * failure mode where a crash loses an event somebody already reacted to.
 *
 * Replay is deliberately separate from publication. `replay` reduces history
 * into a value and returns it; it never publishes, never appends, and never
 * invokes a subscriber. A reducer is a pure function of its input, so "replay
 * has no side effects" is enforced by the type of the thing rather than by
 * everyone remembering.
 */

export interface AppendOptions {
  source?: AnyCoreEvent['source']
  actor?: PrincipalId
  correlationId?: string
  causationId?: string | null
}

export type FabricListener = (event: AnyCoreEvent) => void

export interface FabricOptions {
  store: EventStore
  /** Injectable for deterministic tests. */
  now?: () => Date
  newId?: () => string
}

export class EventFabric {
  private readonly store: EventStore
  private readonly now: () => Date
  private readonly newId: () => string
  private readonly listeners = new Set<FabricListener>()
  private sequence: number

  private constructor(options: FabricOptions, recoveredSequence: number) {
    this.store = options.store
    this.now = options.now ?? (() => new Date())
    this.newId = options.newId ?? (() => randomUUID())
    this.sequence = recoveredSequence
  }

  static async open(options: FabricOptions): Promise<EventFabric> {
    const recovered = await options.store.lastSequence()
    return new EventFabric(options, recovered)
  }

  /** The highest sequence this fabric has assigned. */
  get lastSequence(): number {
    return this.sequence
  }

  get lastEventId(): string | null {
    return this.lastId
  }
  private lastId: string | null = null

  /**
   * Persist an event, then publish it.
   *
   * The store is awaited before a single subscriber is called. If the append
   * throws, nothing is published and the caller's promise rejects — the
   * sequence number is not consumed either, so the next event takes it.
   */
  async append<T extends CoreEventType>(
    type: T,
    payload: Extract<AnyCoreEvent, { type: T }>['payload'],
    options: AppendOptions = {},
  ): Promise<AnyCoreEvent> {
    const sequence = this.sequence + 1
    const event = {
      eventId: this.newId(),
      sequence,
      type,
      schemaVersion: CORE_EVENT_SCHEMA_VERSION,
      occurredAt: this.now().toISOString(),
      source: options.source ?? 'core',
      actor: options.actor ?? 'system',
      correlationId: options.correlationId ?? this.newId(),
      causationId: options.causationId ?? null,
      payload,
    } as AnyCoreEvent

    // Durable first.
    await this.store.append(event)
    this.sequence = sequence
    this.lastId = event.eventId

    // Visible second.
    this.publish(event)
    return event
  }

  private publish(event: AnyCoreEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch (error) {
        // A broken subscriber must not break the fabric, and must not cause a
        // retry that would append a duplicate event.
        console.error('[freya.core] event subscriber threw', error)
      }
    }
  }

  /**
   * Subscribe to events appended from now on.
   *
   * Returns a disposer. Long-lived subscriptions must be able to detach; a
   * subscribe-without-unsubscribe API is how a reloading renderer grows an
   * unbounded set of listeners.
   */
  subscribe(listener: FabricListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  get subscriberCount(): number {
    return this.listeners.size
  }

  /** Every persisted event, ascending. Reading history is not replaying it. */
  async readAll(): Promise<AnyCoreEvent[]> {
    return this.store.readAll()
  }

  /**
   * Fold history into a value.
   *
   * This function has no way to publish, append, or call out. A reducer that
   * tried would have to smuggle in a reference it was not given, which is a
   * much larger act than writing the side effect by hand.
   */
  async replay<S>(initial: S, reducer: (state: S, event: AnyCoreEvent) => S): Promise<S> {
    const events = await this.store.readAll()
    let state = initial
    for (const event of events) {
      state = reducer(state, event)
    }
    return state
  }

  describe(): string {
    return this.store.describe()
  }

  async close(): Promise<void> {
    this.listeners.clear()
    await this.store.close()
  }
}
