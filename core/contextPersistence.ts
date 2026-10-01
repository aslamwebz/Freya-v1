import { contextItemState, retireContextItem } from './context/item'
import type { ContextItem } from './context/types'
import type { ContextProjectionView } from './protocol/context'
import { openContextPersistence } from './context/persistence/open'
import { decodeContextSnapshot } from './context/persistence/snapshot'
import { emptyContextSnapshot, retireContextSnapshot } from './context/persistence/recovery'
import { CONTEXT_SNAPSHOT_VERSION, type ContextPersistencePort, type ContextSnapshot } from './context/persistence/port'

/** Core's persistence lifecycle. No journal, provider, or renderer access. */
export class ContextPersistenceRuntime {
  private tail: Promise<void> = Promise.resolve()
  private fault: string | null = null
  private closed = false
  private constructor(private readonly port: ContextPersistencePort,
    private readonly onHealthChange: () => void) {}

  static async open(options: { path: string; key: Uint8Array | null; now: Date; onHealthChange?: () => void }): Promise<{
    runtime: ContextPersistenceRuntime; records: readonly ContextItem[]
  }> {
    const port = await openContextPersistence(options)
    const runtime = new ContextPersistenceRuntime(port, options.onHealthChange ?? (() => {}))
    let snapshot = emptyContextSnapshot()
    const loaded = await port.load()
    if (!loaded.ok) {
      runtime.degrade()
    } else {
      try {
        const decoded = decodeContextSnapshot(loaded.snapshot)
        snapshot = retireContextSnapshot(decoded, options.now)
        // Observation belongs to the old process, even if its TTL has not elapsed.
        // Retain only a tombstone until the opted-in host reports a fresh observation.
        if (snapshot.records.some((item) => item.kind === 'active_window' && contextItemState(item, options.now) === 'live')) {
          snapshot = { v: CONTEXT_SNAPSHOT_VERSION, records: snapshot.records.map((item) =>
            item.kind === 'active_window' && contextItemState(item, options.now) === 'live'
              ? { ...retireContextItem(item), revokedAt: options.now.toISOString(),
                  revocationReason: 'window observation ended on restart' }
              : item) }
        }
        // Retired content must also be gone from durable storage before readers start.
        if (snapshot !== decoded && snapshot.records.length > 0) {
          runtime.commit(snapshot.records)
          await runtime.flush()
        }
      } catch {
        runtime.degrade()
      }
    }
    return { runtime, records: snapshot.records }
  }

  health(): ContextProjectionView['persistence'] {
    const reason = this.fault ?? this.port.faultReason ?? this.port.durabilityReason
    return { mode: this.port.mode, durable: this.port.durable && reason === null, reason }
  }

  commit(records: readonly ContextItem[]): void {
    if (this.closed || this.fault !== null || this.port.faultReason !== null || !this.port.durable) return
    const snapshot: ContextSnapshot = { v: CONTEXT_SNAPSHOT_VERSION, records }
    this.tail = this.tail.then(async () => {
      if (this.fault !== null) return
      try {
        await this.port.commit(snapshot)
      } catch {
        this.degrade()
      }
    })
  }

  flush(): Promise<void> { return this.tail }

  async close(): Promise<void> {
    this.closed = true
    await this.flush()
    await this.port.close()
  }

  private degrade(): void {
    // Fixed words: filesystem/decoder errors must never reflect private input.
    if (this.fault !== null) return
    this.fault = 'encrypted Context storage is unavailable; current Context is held in this process only'
    this.onHealthChange()
  }
}
