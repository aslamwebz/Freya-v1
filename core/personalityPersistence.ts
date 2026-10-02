import type { CueUsageLedger, RelationshipItem } from './personality/types'
import { openPersonalityPersistence } from './personality/persistence/open'
import { decodePersonalitySnapshot } from './personality/persistence/snapshot'
import { emptyPersonalitySnapshot, retirePersonalityItem } from './personality/persistence/recovery'
import {
  PERSONALITY_SNAPSHOT_VERSION,
  type PersonalityPersistencePort,
  type PersonalityPersistenceHealth,
  type PersonalitySnapshot,
} from './personality/persistence/port'

/**
 * Core's Personality persistence lifecycle.
 *
 * The same three responsibilities the Context runtime has, and no more: open a
 * port that cannot throw for anything a machine can do to it, recover the retained
 * snapshot before any reader is served, and hand the whole snapshot back on every
 * change. No journal, no provider, no renderer, no clock of its own — `now` is
 * supplied by the caller because the store is not allowed to decide when "now" is.
 *
 * ## Degrade, never refuse to start
 *
 * A missing key, an unreadable file, a directory that is not a directory, a full
 * disk: every one of them ends with an *empty, explicitly degraded* store and the
 * reason in words. Personality data holds no authority, no budget, no stop and no
 * decision, so letting a disk error take Core down with it would hand a storage
 * fault more power than it deserves. What degrades is real and is stated: the
 * relationship does not survive the restart, the anti-repetition ledger is refused
 * rather than trusted, and no plaintext is written in its place.
 *
 * ## Destroy before serving
 *
 * A recovered record that claims to be retired but still carries text is
 * re-tombstoned and the file is rewritten *before* the store is handed to any
 * reader. A flag-only retirement left by an earlier build would otherwise still be
 * readable for the length of this process, which is exactly as long as it takes
 * for somebody to ask for it.
 */
export class PersonalityPersistenceRuntime {
  private tail: Promise<void> = Promise.resolve()
  private fault: string | null = null
  private closed = false

  private constructor(
    private readonly port: PersonalityPersistencePort,
    private readonly onHealthChange: () => void,
  ) {}

  static async open(options: {
    path: string
    key: Uint8Array | null
    now: Date
    onHealthChange?: () => void
  }): Promise<{
    runtime: PersonalityPersistenceRuntime
    items: readonly RelationshipItem[]
    ledger: CueUsageLedger
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
        const items = decoded.items.map((item) =>
          item.status === 'retired' && item.text !== ''
            ? retirePersonalityItem(item, { now: options.now.toISOString(), reason: 'retention-bound-reached' })
            : item,
        )
        const rewrote = items.some((item, index) => item !== decoded.items[index])
        snapshot = { v: PERSONALITY_SNAPSHOT_VERSION, items, ledger: decoded.ledger }
        if (rewrote && items.length > 0) {
          runtime.commit(items, decoded.ledger)
          await runtime.flush()
        }
      } catch {
        runtime.degrade()
      }
    }

    return { runtime, items: snapshot.items, ledger: snapshot.ledger }
  }

  /**
   * What a surface may be told.
   *
   * Read fresh on every call rather than cached, because durability is a property
   * of the bytes on the disk *now* and a cached answer is how a surface ends up
   * claiming encrypted storage through a failure that has already happened.
   */
  health(retained = 0): PersonalityPersistenceHealth {
    const reason = this.fault ?? this.port.faultReason ?? this.port.durabilityReason
    return {
      mode: this.port.mode,
      durable: this.port.durable && reason === null,
      reason,
      faultReason: this.port.faultReason,
      retained,
    }
  }

  /**
   * Hand the whole retained snapshot over.
   *
   * Whole-set and last-write-wins, deliberately: a partial write is a record of
   * what the caller happened to know, and the store is the only component that can
   * say what is retained. Refuses while degraded, so a damaged store is never
   * rewritten from a partial read — that would drop every record after the break,
   * permanently and invisibly.
   */
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

  flush(): Promise<void> {
    return this.tail
  }

  /**
   * Close in the only order that leaves an honest file: flush what was committed,
   * *then* release the port. Closing first would drop the last write of a session
   * on the floor, and a relationship record that exists in Core and not on disk is
   * the exact durability lie this phase refuses to tell.
   */
  async close(): Promise<void> {
    this.closed = true
    await this.flush()
    await this.port.close()
  }

  private degrade(): void {
    // Fixed words: a filesystem or decoder error must never reflect private input.
    if (this.fault !== null) return
    this.fault =
      'encrypted Personality storage is unavailable; current Personality data is held in this process only'
    this.onHealthChange()
  }
}
