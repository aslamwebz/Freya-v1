import {
  GoalStoreError,
  type GoalContentResult,
  type GoalStore,
  type GoalStoreHealth,
} from '../../longhorizon/store'
import type { GoalContent } from '../../longhorizon/types'
import type { Vault } from '../vault'

/**
 * A GOAL CONTENT STORE ON THE CANONICAL VAULT.
 *
 * Persists private goal content (title, description, completion criteria)
 * into the encrypted SQLCipher database, under the generic `vault_kv` table
 * tagged `domain = 'goal'`.
 *
 * Metadata lives in the event journal (`longhorizon.*`); content lives encrypted
 * in the Vault. Neither can reconstruct the other without authorization.
 */

const DOMAIN = 'goal'

/** Ceiling matching the bounded encrypted store bound (256 KB). */
export const MAX_VAULT_GOAL_BYTES = 256 * 1024

interface GoalRow {
  readonly body: string
}

export class VaultGoalStore implements GoalStore {
  readonly mode = 'encrypted' as const
  readonly durable = true

  private degraded: string | null = null
  private closed = false

  constructor(private readonly vault: Vault) {}

  get faultReason(): string | null {
    return this.degraded
  }

  async write(content: GoalContent): Promise<GoalContent> {
    this.ensureOpen()
    if (this.degraded !== null) {
      throw new GoalStoreError(
        'unavailable',
        `Goal content is not being written because this store is damaged: ${this.degraded}`,
      )
    }
    const validated = validate(content)
    if (!validated.ok) throw new GoalStoreError('invalid', validated.reason)
    const body = JSON.stringify(validated.value)
    if (Buffer.byteLength(body, 'utf8') > MAX_VAULT_GOAL_BYTES) {
      throw new GoalStoreError('too_large', 'Goal content exceeds the per-record limit')
    }
    try {
      this.vault.transaction((tx) => {
        tx.run(
          `INSERT INTO vault_kv (domain, key, body, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(domain, key) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
          [DOMAIN, validated.value.goalId, body, new Date().toISOString()],
        )
      })
    } catch {
      throw new GoalStoreError('write_failed', 'Goal content could not be written')
    }
    return validated.value
  }

  async read(goalId: string): Promise<GoalContentResult> {
    if (this.closed) {
      return { ok: false, code: 'unavailable', reason: 'the goal store is closed' }
    }
    if (this.degraded !== null) {
      return { ok: false, code: 'degraded', reason: this.degraded }
    }
    let row: GoalRow | undefined
    try {
      row = this.vault.get<GoalRow>(
        'SELECT body FROM vault_kv WHERE domain = ? AND key = ?',
        [DOMAIN, goalId],
      )
    } catch {
      return { ok: false, code: 'unavailable', reason: 'the Vault could not be read' }
    }
    if (row === undefined) {
      return { ok: false, code: 'not_found', reason: 'no goal content is stored for that goal' }
    }
    try {
      const parsed = JSON.parse(row.body) as GoalContent
      if (parsed.goalId !== goalId) {
        this.degrade('a goal record decrypted to a different goal')
        return { ok: false, code: 'degraded', reason: this.degraded ?? 'a goal record could not be trusted' }
      }
      return { ok: true, value: parsed }
    } catch {
      this.degrade('a goal record could not be parsed')
      return { ok: false, code: 'degraded', reason: this.degraded ?? 'a goal record could not be parsed' }
    }
  }

  async remove(goalId: string): Promise<boolean> {
    this.ensureOpen()
    try {
      const result = this.vault.transaction((tx) =>
        tx.run('DELETE FROM vault_kv WHERE domain = ? AND key = ?', [DOMAIN, goalId]),
      )
      return result.changes > 0
    } catch {
      throw new GoalStoreError('write_failed', 'Goal content could not be removed')
    }
  }

  health(): GoalStoreHealth {
    if (this.degraded !== null) return { health: 'degraded', reason: this.degraded }
    return { health: this.closed ? 'unavailable' : 'healthy', reason: null }
  }

  async close(): Promise<void> {
    this.closed = true
  }

  private ensureOpen(): void {
    if (this.closed) throw new GoalStoreError('unavailable', 'the goal store is closed')
  }

  private degrade(reason: string): void {
    this.degraded ??= reason
  }
}

function validate(
  content: GoalContent,
): { ok: true; value: GoalContent } | { ok: false; reason: string } {
  if (typeof content !== 'object' || content === null) return { ok: false, reason: 'Goal content is malformed' }
  const c = content as unknown as Record<string, unknown>
  if (typeof c.goalId !== 'string' || c.goalId.length === 0 || c.goalId.length > 256) {
    return { ok: false, reason: 'Goal content has no usable id' }
  }
  if (typeof c.title !== 'string' || typeof c.description !== 'string') {
    return { ok: false, reason: 'Goal content is missing its title or description' }
  }
  if (!Array.isArray(c.completionCriteria) || c.completionCriteria.some((item) => typeof item !== 'string')) {
    return { ok: false, reason: 'Goal content has malformed criteria' }
  }
  if (typeof c.createdAt !== 'string' || !Number.isFinite(Date.parse(c.createdAt))) {
    return { ok: false, reason: 'Goal content has no usable creation time' }
  }
  return { ok: true, value: content }
}
