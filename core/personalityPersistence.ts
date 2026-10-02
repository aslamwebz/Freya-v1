import type { CueUsageLedger, RelationshipItem } from './personality/types'
import { openPersonalityPersistence } from './personality/persistence/open'
import { decodePersonalitySnapshot } from './personality/persistence/snapshot'
import { emptyPersonalitySnapshot, retirePersonalityItem } from './personality/persistence/recovery'
import { PERSONALITY_SNAPSHOT_VERSION, type PersonalityPersistencePort, type PersonalitySnapshot } from './personality/persistence/port'

/** Core's persistence lifecycle. No journal, provider, or renderer access. */
export class PersonalityPersistenceRuntime {
  private tail: Promise<void> = Promise.resolve()
  private fault: string | null = null
  private closed = false
  private constructor(private readonly port: PersonalityPersistencePort,
    private readonly onHealthChange: () => void) {}

  static async open(options: { path: string; key: Uint8Array | null; now: Date; onHealthChange?: () => void }): Promise<{
    runtime: PersonalityPersistenceRuntime; items: readonly RelationshipItem[]; ledger: CueUsageLedger
  }> {
    const port = await openPersonalityPersistence(options)
    const runtime = new PersonalityPersistenceRuntime(port, options.onHealthChange ?? (() => {}))
    let snapshot = emptyPersonalitySnapshot()
    const loaded = await port.load()
    if (!loaded.ok) {
      runtime.degrade()
    } else {
      try {
        const decoded = decodePersonalitySnapshot(loaded.snapshot)
        snapshot = {
          v: PERSONALITY_SNAPSHOT_VERSION,
          items: decoded.items.map((item) =>
            item.status === 'retired' && item.text !== ''
              ? retirePersonalityItem(item)
              : item),
          ledger: decoded.ledger,
        }
        if (snapshot !== decoded && snapshot.items.length > 0) {
          runtime.commit(snapshot.items, snapshot.ledger)
          await runtime.flush()
        }
      } catch {
        runtime.degrade()
      }
    }
    return { runtime, items: snapshot.items, ledger: snapshot.ledger }
  }

  health(): { mode: 'encrypted' | 'ephemeral'; durable: boolean; reason: string | null; faultReason: string | null; retained: number } {
    const reason = this.fault ?? this.port.faultReason ?? this.port.durabilityReason
    return { mode: this.port.mode, durable: this.port.durable && reason === null, reason, faultReason: this.port.faultReason, retained: 0 }
  }

  commit(items: readonly RelationshipItem[], ledger: CueUsageLedger): void {
    if (this.closed || this.fault !== null || this.port.faultReason !== null || !this.port.durable) return
    const snapshot: PersonalitySnapshot = { v: PERSONALITY_SNAPSHOT_VERSION, items, ledger }
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
    if (this.fault !== null) return
    this.fault = 'encrypted Personality storage is unavailable; current Personality data is held in this process only'
    this.onHealthChange()
  }
}
