import type { SkillRecord } from './skills/types'
import { openSkillPersistence } from './skills/persistence/open'
import { SKILL_SNAPSHOT_VERSION, type SkillPersistencePort, type SkillSnapshot } from './skills/persistence/port'

/**
 * Core's Skill persistence lifecycle. No journal, provider, or renderer access.
 *
 * ## The rule it holds
 *
 * The encrypted store is a **cache of the engine's live body set**, and the journal is
 * the authority for status. So a body recovered from disk can only be used when the
 * journal says that skill exists at that version — and a body the journal does not
 * vouch for is *discarded on recovery* rather than adopted.
 *
 * That ordering is what makes a rewritten file harmless. An attacker who deletes the
 * encrypted store loses procedures, not permissions: the fold still reports the skills,
 * their statuses and their evidence, and every attempt to plan one says "its body is
 * not readable". The reverse ordering would be the dangerous one — a body on disk
 * would then be able to reintroduce a skill the journal never recorded.
 *
 * The mirror image is also refused: a journal entry with no body is reported rather
 * than quietly ignored, because "Freya has a promoted skill she cannot read" is a
 * fact a person needs to see, not a gap to paper over with a placeholder.
 */
export class SkillPersistenceRuntime {
  private tail: Promise<void> = Promise.resolve()
  private fault: string | null = null
  private closed = false

  private constructor(
    private readonly port: SkillPersistencePort,
    private readonly onHealthChange: () => void,
  ) {}

  static async open(options: {
    path: string
    key: Uint8Array | null
    onHealthChange?: () => void
  }): Promise<{ runtime: SkillPersistenceRuntime; bodies: readonly SkillRecord[] }> {
    const port = await openSkillPersistence(options)
    const runtime = new SkillPersistenceRuntime(port, options.onHealthChange ?? (() => {}))
    let bodies: readonly SkillRecord[] = []
    const loaded = await port.load()
    if (!loaded.ok) runtime.degrade()
    else {
      try {
        bodies = loaded.snapshot.records
      } catch {
        runtime.degrade()
      }
    }
    return { runtime, bodies }
  }

  health(): { mode: 'encrypted' | 'ephemeral'; durable: boolean; reason: string | null } {
    const reason = this.fault ?? this.port.faultReason ?? this.port.durabilityReason
    return { mode: this.port.mode, durable: this.port.durable && reason === null, reason }
  }

  commit(records: readonly SkillRecord[]): void {
    if (this.closed || this.fault !== null || this.port.faultReason !== null || !this.port.durable) return
    const snapshot: SkillSnapshot = { v: SKILL_SNAPSHOT_VERSION, records }
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

  async close(): Promise<void> {
    this.closed = true
    await this.flush()
    await this.port.close()
  }

  private degrade(): void {
    // Fixed words: a decoder or filesystem error must never reflect private input.
    if (this.fault !== null) return
    this.fault =
      'encrypted skill storage is unavailable; procedures are held in this process only and no skill can be planned into work'
    this.onHealthChange()
  }
}