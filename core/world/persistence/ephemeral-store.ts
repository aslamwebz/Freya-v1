import type { WorldEvidenceRecord } from '../types'
import {
  WORLD_SNAPSHOT_VERSION,
  type WorldPersistencePort,
  type WorldSnapshot,
  type WorldSnapshotLoad,
} from './port'
import { WorldPersistenceError } from './errors'
import { decodeWorldSnapshot, encodeWorldSnapshot } from './snapshot'

/**
 * The sentence every surface is told when world evidence is not durable.
 *
 * One copy, exported, so a projection, a test and a status line cannot drift into
 * saying three different things about the same fact.
 */
export const NO_WORLD_KEY_REASON =
  'this Core has no secure world store, so evidence about the world is held in this process only and will not survive a restart'

/**
 * THE EPHEMERAL WORLD STORE.
 *
 * Real evidence records, no durability, reported as such.
 *
 * ## Why a Core with no Vault still has a world
 *
 * An unopenable Vault is a deployment fact, not a reason to lose the ability to reason
 * about the world: a Core built without a selected SQLCipher binding should still
 * admit the owner's own statements and draw a graph in this process. What it must not
 * do is *pretend* those claims are safe across a restart, because a person planning on
 * a relationship the graph will forget has no way to know.
 *
 * So the fallback is real records with `mode: 'ephemeral'`, `durable: false` and a
 * sentence saying why — exactly the bargain the Vault-backed Mission store makes, and
 * for the same reason: `durable: true` on a store that loses everything is a bug a
 * person can never detect.
 *
 * ## This is not a plaintext fallback
 *
 * Nothing here touches a filesystem. There is no second database, no JSONL file and no
 * unencrypted store on disk for a world claim to land in; the records simply do not
 * outlive the process, and the projection says so in words. The alternative — writing
 * the ledger somewhere readable because the encrypted one would not open — is exactly
 * the failure `PLAN.md` §5 forbids.
 *
 * ## Writes are accepted and discarded
 *
 * `commit` validates the snapshot (so an illegal record is still refused, and a test
 * can rely on that) and then keeps it in memory. It never touches a filesystem, and
 * this file imports no `node:fs`.
 */
export class EphemeralWorldStore implements WorldPersistencePort {
  readonly mode = 'ephemeral' as const
  readonly durable = false
  readonly durabilityReason = NO_WORLD_KEY_REASON
  readonly faultReason = null as string | null

  private records: WorldEvidenceRecord[] = []
  private sequence = 0
  private closed = false

  async load(): Promise<WorldSnapshotLoad> {
    if (this.closed) {
      return { ok: false, code: 'closed', reason: 'the world store is closed' }
    }
    try {
      return {
        ok: true,
        snapshot: decodeWorldSnapshot({
          v: WORLD_SNAPSHOT_VERSION,
          records: this.records,
          sequence: this.sequence,
        }),
      }
    } catch (error) {
      return {
        ok: false,
        code: 'degraded',
        reason:
          error instanceof WorldPersistenceError
            ? error.message
            : 'the in-memory world could not be read',
      }
    }
  }

  async commit(snapshot: WorldSnapshot): Promise<void> {
    if (this.closed) throw new WorldPersistenceError('unavailable', 'the world store is closed')
    const validated = encodeWorldSnapshot(snapshot)
    this.records = [...validated.records]
    this.sequence = validated.sequence
  }

  async close(): Promise<void> {
    this.closed = true
    this.records = []
  }
}