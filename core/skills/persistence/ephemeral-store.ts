import type { SkillRecord } from '../types'
import { SKILL_SNAPSHOT_VERSION, type SkillPersistencePort, type SkillSnapshot, type SkillSnapshotLoad } from './port'
import { SkillPersistenceError } from './errors'
import { decodeSkillSnapshot, encodeSkillSnapshot } from './snapshot'

/**
 * THE EPHEMERAL SKILL STORE.
 *
 * Real skill records, no durability, reported as such.
 *
 * ## Why a Core with no key still has skills
 *
 * A missing key is a deployment fact, not a reason to lose the ability to reason
 * about procedures: a Core built without OS secure storage should still admit,
 * evaluate and plan skills in this process. What it must not do is *pretend* those
 * skills are safe across a restart, because a person planning on a procedure that
 * silently vanished would have no way to know.
 *
 * So the fallback is real records with `mode: 'ephemeral'`, `durable: false` and a
 * sentence saying why — exactly the bargain the Brain, Missions and Context make,
 * and the same reason: `durable: true` on a store that loses everything is a bug a
 * person can never detect.
 *
 * ## Writes are accepted and discarded
 *
 * `commit` validates the snapshot (so an illegal record is still refused, and a test
 * can rely on that) and then keeps it in memory. It never touches a filesystem, and
 * this file imports no `node:fs`.
 */
export class EphemeralSkillStore implements SkillPersistencePort {
  readonly mode = 'ephemeral' as const
  readonly durable = false
  readonly durabilityReason =
    'this Core has no secure skill key, so procedures are held in this process only and will not survive a restart'
  readonly faultReason = null as string | null

  private records: SkillRecord[] = []
  private closed = false

  async load(): Promise<SkillSnapshotLoad> {
    if (this.closed) {
      return { ok: false, code: 'closed', reason: 'the Skill store is closed' }
    }
    try {
      return { ok: true, snapshot: decodeSkillSnapshot({ v: SKILL_SNAPSHOT_VERSION, records: this.records }) }
    } catch (error) {
      return {
        ok: false,
        code: 'degraded',
        reason: error instanceof SkillPersistenceError ? error.message : 'the in-memory skill set could not be read',
      }
    }
  }

  async commit(snapshot: SkillSnapshot): Promise<void> {
    if (this.closed) throw new SkillPersistenceError('unavailable', 'the Skill store is closed')
    const validated = encodeSkillSnapshot(snapshot)
    this.records = [...validated.records]
  }

  async close(): Promise<void> {
    this.closed = true
    this.records = []
  }
}