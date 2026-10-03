import {
  MissionStoreError,
  type MissionContentResult,
  type MissionStore,
  type MissionStoreHealth,
} from '../../missions/store'
import type { MissionContent } from '../../missions/types'
import type { Vault } from '../vault'

/**
 * A MISSION CONTENT STORE ON THE CANONICAL VAULT.
 *
 * The bounded first migration slice: Mission content — the private text a person
 * writes about what they asked Freya to accomplish — moves from its own bespoke
 * AES-GCM file into the one encrypted SQLCipher database, under the generic
 * `vault_kv` table tagged `domain = 'mission'`.
 *
 * ## What changed and what did not
 *
 * The `MissionStore` contract is unchanged, so the Mission engine, the journal split
 * (metadata in the journal, content in the store) and every privacy property are
 * preserved. What changed is the mechanism: the record is now protected by the
 * database's own page encryption rather than a per-record AEAD line, and there is no
 * second file to manage. There is deliberately **no dual write**: a Core that opens
 * this store writes Mission content only here.
 *
 * ## No query language
 *
 * The store still exposes only `write`/`read`/`remove` for a Mission id the caller
 * already has. The generic table underneath is not reachable through this class.
 */

const DOMAIN = 'mission'

/** A second, independent ceiling, matching the retired encrypted store's bound. */
export const MAX_VAULT_MISSION_BYTES = 256 * 1024

interface MissionRow {
  readonly body: string
}

export class VaultMissionStore implements MissionStore {
  readonly mode = 'encrypted' as const
  readonly durable = true

  private degraded: string | null = null
  private closed = false

  constructor(private readonly vault: Vault) {}

  get faultReason(): string | null {
    return this.degraded
  }

  async write(content: MissionContent): Promise<MissionContent> {
    this.ensureOpen()
    if (this.degraded !== null) {
      throw new MissionStoreError(
        'unavailable',
        `Mission content is not being written because this store is damaged: ${this.degraded}`,
      )
    }
    const validated = validate(content)
    if (!validated.ok) throw new MissionStoreError('invalid', validated.reason)
    const body = JSON.stringify(validated.value)
    if (Buffer.byteLength(body, 'utf8') > MAX_VAULT_MISSION_BYTES) {
      throw new MissionStoreError('too_large', 'Mission content exceeds the per-record limit')
    }
    try {
      this.vault.transaction((tx) => {
        tx.run(
          `INSERT INTO vault_kv (domain, key, body, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(domain, key) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
          [DOMAIN, validated.value.missionId, body, new Date().toISOString()],
        )
      })
    } catch {
      throw new MissionStoreError('write_failed', 'Mission content could not be written')
    }
    return validated.value
  }

  async read(missionId: string): Promise<MissionContentResult> {
    if (this.closed) {
      return { ok: false, code: 'unavailable', reason: 'the Mission store is closed' }
    }
    if (this.degraded !== null) {
      return { ok: false, code: 'degraded', reason: this.degraded }
    }
    let row: MissionRow | undefined
    try {
      row = this.vault.get<MissionRow>(
        'SELECT body FROM vault_kv WHERE domain = ? AND key = ?',
        [DOMAIN, missionId],
      )
    } catch {
      return { ok: false, code: 'unavailable', reason: 'the Vault could not be read' }
    }
    if (row === undefined) {
      return { ok: false, code: 'not_found', reason: 'no Mission content is stored for that Mission' }
    }
    try {
      const parsed = JSON.parse(row.body) as MissionContent
      if (parsed.missionId !== missionId) {
        this.degrade('a Mission record decrypted to a different Mission')
        return { ok: false, code: 'degraded', reason: this.degraded ?? 'a Mission record could not be trusted' }
      }
      return { ok: true, value: parsed }
    } catch {
      this.degrade('a Mission record could not be parsed')
      return { ok: false, code: 'degraded', reason: this.degraded ?? 'a Mission record could not be parsed' }
    }
  }

  async remove(missionId: string): Promise<boolean> {
    this.ensureOpen()
    try {
      const result = this.vault.transaction((tx) =>
        tx.run('DELETE FROM vault_kv WHERE domain = ? AND key = ?', [DOMAIN, missionId]),
      )
      return result.changes > 0
    } catch {
      throw new MissionStoreError('write_failed', 'Mission content could not be removed')
    }
  }

  health(): MissionStoreHealth {
    if (this.degraded !== null) return { health: 'degraded', reason: this.degraded }
    return { health: 'healthy', reason: null }
  }

  async close(): Promise<void> {
    this.closed = true
  }

  private ensureOpen(): void {
    if (this.closed) throw new MissionStoreError('unavailable', 'the Mission store is closed')
  }

  private degrade(reason: string): void {
    this.degraded ??= reason
  }
}

function validate(
  content: MissionContent,
): { ok: true; value: MissionContent } | { ok: false; reason: string } {
  if (typeof content !== 'object' || content === null) return { ok: false, reason: 'Mission content is malformed' }
  const c = content as unknown as Record<string, unknown>
  if (typeof c.missionId !== 'string' || c.missionId.length === 0 || c.missionId.length > 256) {
    return { ok: false, reason: 'Mission content has no usable id' }
  }
  if (typeof c.title !== 'string' || typeof c.intent !== 'string') {
    return { ok: false, reason: 'Mission content is missing its title or intent' }
  }
  if (!Array.isArray(c.successCriteria) || c.successCriteria.some((item) => typeof item !== 'string')) {
    return { ok: false, reason: 'Mission content has malformed criteria' }
  }
  if (typeof c.createdAt !== 'string' || !Number.isFinite(Date.parse(c.createdAt))) {
    return { ok: false, reason: 'Mission content has no usable creation time' }
  }
  return { ok: true, value: content }
}
