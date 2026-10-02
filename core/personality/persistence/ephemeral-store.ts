import type { PersonalityPersistencePort, PersonalitySnapshot, PersonalitySnapshotLoad } from './port'
import { PERSONALITY_SNAPSHOT_VERSION } from './port'
import { PersonalityPersistenceError } from './errors'

/**
 * THE EPHEMERAL PERSONALITY PORT.
 *
 * What Personality persistence looks like when there is no secure key, or when
 * the storage could not be opened. It holds nothing, recovers nothing, and
 * writes nothing — not a file, not a temp file, not an empty directory. There
 * is no code path from this object to a filesystem: it imports nothing that
 * can touch one.
 *
 * ## Why this exists rather than a fallback
 *
 * The tempting alternative when a machine has no OS secure storage is to write
 * the personality data to a plain file. That is exactly the outcome the
 * Constitution's private-by-default rule exists to prevent: a person's
 * relationship facts, preferences, habits and inside jokes, written where any
 * backup, any sync client and any support bundle can read them, with the
 * *appearance* of durability because a file did appear.
 *
 * So the choice is not "encrypted or plaintext". It is "durable, or explicitly
 * not" — and this port is the second one, loudly:
 *
 *  - `mode: 'ephemeral'`, never a guess;
 *  - `durable: false`, so a projection cannot report it as stored;
 *  - `durabilityReason` in words a person can act on.
 *
 * ## Recovery from here is genuinely empty
 *
 * `load()` returns an empty snapshot with `ok: true`, not a refusal. That is a
 * deliberate distinction: nothing was ever written, so there is nothing to have
 * lost, and reporting `degraded` would claim a fault that did not happen. The
 * cost is the owner's — their personality data does not survive the restart —
 * and it is stated rather than hidden.
 */
export interface EphemeralPersonalityStoreOptions {
  /** Why nothing survives a restart, in words. Never null: that is the point. */
  readonly durabilityReason: string
}

export class EphemeralPersonalityStore implements PersonalityPersistencePort {
  readonly mode = 'ephemeral' as const
  readonly durable = false
  readonly durabilityReason: string
  readonly faultReason = null

  private closed = false

  constructor(options: EphemeralPersonalityStoreOptions) {
    const reason = options.durabilityReason.trim()
    this.durabilityReason =
      reason.length === 0
        ? 'personality data is held in this process only: no reason was given, and nothing is written to disk'
        : reason
  }

  async load(): Promise<PersonalitySnapshotLoad> {
    if (this.closed) {
      return { ok: false, code: 'closed', reason: 'the Personality store is closed' }
    }
    return {
      ok: true,
      snapshot: {
        v: PERSONALITY_SNAPSHOT_VERSION,
        items: [],
        ledger: { schemaVersion: 1, maxEntries: 0, entries: [] },
      },
    }
  }

  async commit(_snapshot: PersonalitySnapshot): Promise<void> {
    if (this.closed) throw new PersonalityPersistenceError('unavailable', 'the Personality store is closed')
    throw new PersonalityPersistenceError(
      'unavailable',
      `personality data is not being written: ${this.durabilityReason} Nothing has been stored, and nothing will be.`,
    )
  }

  async close(): Promise<void> {
    this.closed = true
  }
}
