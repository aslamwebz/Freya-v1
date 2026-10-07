import type { AnyCoreEvent } from './envelope'
import type { EventStore } from './store'
import { EphemeralEventStore } from './ephemeral-store'

/** Switch once on storage failure, retaining the history Core already recovered. */
export class FallbackEventStore implements EventStore {
  private fallback: EphemeralEventStore | null = null
  private recovered: AnyCoreEvent[] = []
  private historyRecovered = false
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly durable: EventStore,
    private readonly onFailure: (error: unknown, operation: 'read' | 'write') => void,
    private readonly onCloseFailure: (error: unknown) => void) {}

  async append(event: AnyCoreEvent): Promise<void> {
    return this.serial(async () => {
      if (this.fallback) return this.fallback.append(event)
      try {
        await this.durable.append(event)
        this.recovered.push(structuredClone(event))
      } catch (error) {
        await (await this.switchToFallback(error, 'write')).append(event)
      }
    })
  }

  async readAll(): Promise<AnyCoreEvent[]> {
    return this.serial(async () => {
      if (this.fallback) return this.fallback.readAll()
      try {
        const events = await this.durable.readAll()
        this.recovered = structuredClone(events)
        this.historyRecovered = true
        return events
      } catch (error) {
        // Initial recovery must be handled by Core; no security history is known.
        if (!this.historyRecovered) throw error
        return (await this.switchToFallback(error, 'read')).readAll()
      }
    })
  }

  async readAfter(sequence: number): Promise<AnyCoreEvent[]> {
    return (await this.readAll()).filter(event => event.sequence > sequence)
  }

  async lastSequence(): Promise<number> {
    return this.serial(async () => {
      if (this.fallback) return this.fallback.lastSequence()
      try { return await this.durable.lastSequence() } catch (error) {
        if (!this.historyRecovered) throw error
        return (await this.switchToFallback(error, 'read')).lastSequence()
      }
    })
  }

  describe(): string { return (this.fallback ?? this.durable).describe() }
  async close(): Promise<void> { await this.serial(() => (this.fallback ?? this.durable).close()) }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(operation)
    this.queue = pending.catch(() => undefined)
    return pending
  }

  private async switchToFallback(error: unknown, operation: 'read' | 'write'): Promise<EphemeralEventStore> {
    const fallback = new EphemeralEventStore()
    for (const previous of this.recovered) await fallback.append(previous)
    this.fallback = fallback
    this.onFailure(error, operation)
    // Never retry an uncertain operation on disk. New events are temporary.
    try { await this.durable.close() } catch (closeError) { this.onCloseFailure(closeError) }
    return fallback
  }
}
