import type { ContextPersistencePort, ContextSnapshot, ContextSnapshotLoad } from './port'
import { CONTEXT_SNAPSHOT_VERSION } from './port'
import { ContextPersistenceError } from './errors'

/**
 * THE EPHEMERAL CONTEXT PORT.
 *
 * What Context persistence looks like when there is no secure key, or when the
 * storage could not be opened. It holds nothing, recovers nothing, and writes
 * nothing — not a file, not a temp file, not an empty directory. There is no code
 * path from this object to a filesystem: it imports nothing that can touch one.
 *
 * ## Why this exists rather than a fallback
 *
 * The tempting alternative when a machine has no OS secure storage is to write
 * the context to a plain file. That is exactly the outcome the Constitution's
 * private-by-default rule exists to prevent: a person's selected paragraphs,
 * file titles and tab URLs, written where any backup, any sync client and any
 * support bundle can read them, with the *appearance* of durability because a
 * file did appear.
 *
 * So the choice is not "encrypted or plaintext". It is "durable, or explicitly
 * not" — and this port is the second one, loudly:
 *
 *  - `mode: 'ephemeral'`, never a guess;
 *  - `durable: false`, so a projection cannot report it as stored;
 *  - `durabilityReason` in words a person can act on, which is what a surface
 *    shows instead of a bare boolean.
 *
 * ## Recovery from here is genuinely empty
 *
 * `load()` returns an empty snapshot with `ok: true`, not a refusal. That is a
 * deliberate distinction: nothing was ever written, so there is nothing to have
 * lost, and reporting `degraded` would claim a fault that did not happen. The
 * cost is the owner's — their context does not survive a restart — and it is
 * stated rather than hidden.
 */
export interface EphemeralContextStoreOptions {
  /** Why nothing survives a restart, in words. Never null: that is the point. */
  readonly durabilityReason: string
}

export class EphemeralContextStore implements ContextPersistencePort {
  readonly mode = 'ephemeral' as const
  readonly durable = false
  readonly durabilityReason: string
  /** Never a fault: this port is working exactly as designed. */
  readonly faultReason = null

  private closed = false

  constructor(options: EphemeralContextStoreOptions) {
    const reason = options.durabilityReason.trim()
    this.durabilityReason =
      reason.length === 0
        ? 'context is held in this process only: no reason was given, and nothing is written to disk'
        : reason
  }

  async load(): Promise<ContextSnapshotLoad> {
    if (this.closed) {
      return { ok: false, code: 'closed', reason: 'the Context store is closed' }
    }
    // True, and empty: no Context has ever been written through this port, so
    // there is no evidence to distrust and nothing to recover.
    return { ok: true, snapshot: { v: CONTEXT_SNAPSHOT_VERSION, records: [] } }
  }

  async commit(_snapshot: ContextSnapshot): Promise<void> {
    if (this.closed) throw new ContextPersistenceError('unavailable', 'the Context store is closed')
    // Refused, not silently ignored. A caller that believes a commit landed has
    // been told a lie by a method that returns `Promise<void>`, and the only way
    // to refuse without lying is to say so.
    throw new ContextPersistenceError(
      'unavailable',
      `context is not being written: ${this.durabilityReason} Nothing has been stored, and nothing will be.`,
    )
  }

  async close(): Promise<void> {
    this.closed = true
  }
}