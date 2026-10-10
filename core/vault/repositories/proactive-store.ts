import type { ProactiveStore } from '../../proactive/store'
import type { ObservationSubscription } from '../../proactive/types'
import type { Vault } from '../vault'

const DOMAIN = 'proactive'

interface VaultRow {
  readonly key: string
  readonly body: string
}

export class VaultProactiveStore implements ProactiveStore {
  readonly mode = 'encrypted' as const
  readonly durable = true

  private degraded: string | null = null
  private closed = false

  constructor(private readonly vault: Vault) {}

  get faultReason(): string | null {
    return this.degraded
  }

  async readSubscriptions(): Promise<readonly ObservationSubscription[]> {
    this.ensureOpen()
    try {
      const rows = this.vault.all<VaultRow>(
        `SELECT key, body FROM vault_kv WHERE domain = ? AND key LIKE 'sub:%'`,
        [DOMAIN],
      )
      const subs: ObservationSubscription[] = []
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.body) as ObservationSubscription
          subs.push(parsed)
        } catch {
          // ignore corrupted row
        }
      }
      return subs
    } catch {
      return []
    }
  }

  async writeSubscription(subscription: ObservationSubscription): Promise<void> {
    this.ensureOpen()
    const key = `sub:${subscription.subscriptionId}`
    const body = JSON.stringify(subscription)
    try {
      this.vault.transaction((tx) => {
        tx.run(
          `INSERT INTO vault_kv (domain, key, body, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(domain, key) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
          [DOMAIN, key, body, new Date().toISOString()],
        )
      })
    } catch (error) {
      this.degrade(`failed to write subscription: ${String(error)}`)
      throw error
    }
  }

  async deleteSubscription(subscriptionId: string): Promise<boolean> {
    this.ensureOpen()
    const key = `sub:${subscriptionId}`
    try {
      const res = this.vault.transaction((tx) => {
        return tx.run(`DELETE FROM vault_kv WHERE domain = ? AND key = ?`, [DOMAIN, key])
      })
      return res.changes > 0
    } catch (error) {
      this.degrade(`failed to delete subscription: ${String(error)}`)
      return false
    }
  }

  async hasDedupeKey(key: string): Promise<boolean> {
    this.ensureOpen()
    const vaultKey = `dedup:${key}`
    try {
      const row = this.vault.get<VaultRow>(
        `SELECT body FROM vault_kv WHERE domain = ? AND key = ?`,
        [DOMAIN, vaultKey],
      )
      return row !== undefined
    } catch {
      return false
    }
  }

  async recordDedupeKey(key: string, expiresAt?: string | null): Promise<void> {
    this.ensureOpen()
    const vaultKey = `dedup:${key}`
    const body = JSON.stringify({ recordedAt: new Date().toISOString(), expiresAt: expiresAt ?? null })
    try {
      this.vault.transaction((tx) => {
        tx.run(
          `INSERT INTO vault_kv (domain, key, body, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(domain, key) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
          [DOMAIN, vaultKey, body, new Date().toISOString()],
        )
      })
    } catch (error) {
      this.degrade(`failed to record dedupe key: ${String(error)}`)
    }
  }

  async writeEvidence(observationId: string, data: Record<string, unknown>): Promise<void> {
    this.ensureOpen()
    const key = `evidence:${observationId}`
    const body = JSON.stringify(data)
    try {
      this.vault.transaction((tx) => {
        tx.run(
          `INSERT INTO vault_kv (domain, key, body, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(domain, key) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
          [DOMAIN, key, body, new Date().toISOString()],
        )
      })
    } catch (error) {
      this.degrade(`failed to write evidence: ${String(error)}`)
      throw error
    }
  }

  async readEvidence(observationId: string): Promise<Record<string, unknown> | null> {
    this.ensureOpen()
    const key = `evidence:${observationId}`
    try {
      const row = this.vault.get<VaultRow>(
        `SELECT body FROM vault_kv WHERE domain = ? AND key = ?`,
        [DOMAIN, key],
      )
      if (!row) return null
      return JSON.parse(row.body) as Record<string, unknown>
    } catch {
      return null
    }
  }

  async close(): Promise<void> {
    this.closed = true
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error('the proactive vault store is closed')
  }

  private degrade(reason: string): void {
    this.degraded ??= reason
  }
}
