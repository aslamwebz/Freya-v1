/**
 * FREYA EVOLUTION — Encrypted Vault Evolution Store
 *
 * Persists versioned strategy candidates in SQLCipher Vault under domain = 'evolution'.
 */

import type { CandidateStatus, StrategyCandidate } from '../../evolution/strategy'
import type { EvolutionStore } from '../../evolution/store'
import type { Vault } from '../vault'

const DOMAIN = 'evolution'

interface VaultRow {
  readonly key: string
  readonly body: string
}

export class VaultEvolutionStore implements EvolutionStore {
  readonly mode = 'encrypted' as const
  readonly durable = true

  private degraded: string | null = null
  private closed = false

  constructor(private readonly vault: Vault) {}

  get faultReason(): string | null {
    return this.degraded
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error('Evolution store is closed.')
  }

  private degrade(reason: string): void {
    this.degraded = reason
  }

  async readCandidates(): Promise<readonly StrategyCandidate[]> {
    this.ensureOpen()
    try {
      const rows = this.vault.all<VaultRow>(
        `SELECT key, body FROM vault_kv WHERE domain = ? AND key LIKE 'candidate:%'`,
        [DOMAIN],
      )
      const list: StrategyCandidate[] = []
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.body) as StrategyCandidate
          list.push(parsed)
        } catch {
          // ignore corrupted row
        }
      }
      return list
    } catch {
      return []
    }
  }

  async writeCandidate(candidate: StrategyCandidate): Promise<void> {
    this.ensureOpen()
    const key = `candidate:${candidate.candidateId}`
    const body = JSON.stringify(candidate)
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
      this.degrade(`failed to write candidate: ${String(error)}`)
      throw error
    }
  }

  async getCandidate(candidateId: string): Promise<StrategyCandidate | null> {
    this.ensureOpen()
    const key = `candidate:${candidateId}`
    try {
      const rows = this.vault.all<VaultRow>(
        `SELECT key, body FROM vault_kv WHERE domain = ? AND key = ?`,
        [DOMAIN, key],
      )
      const row = rows[0]
      if (!row) return null
      return JSON.parse(row.body) as StrategyCandidate
    } catch {
      return null
    }
  }

  async updateCandidateStatus(
    candidateId: string,
    status: CandidateStatus,
    rejectionReason?: string | null,
  ): Promise<boolean> {
    this.ensureOpen()
    const existing = await this.getCandidate(candidateId)
    if (!existing) return false
    const updated: StrategyCandidate = {
      ...existing,
      status,
      rejectionReason: rejectionReason !== undefined ? rejectionReason : existing.rejectionReason,
      updatedAt: new Date().toISOString(),
    }
    await this.writeCandidate(updated)
    return true
  }

  async deleteCandidate(candidateId: string): Promise<boolean> {
    this.ensureOpen()
    const key = `candidate:${candidateId}`
    try {
      const res = this.vault.transaction((tx) => {
        return tx.run(`DELETE FROM vault_kv WHERE domain = ? AND key = ?`, [DOMAIN, key])
      })
      return res.changes > 0
    } catch (error) {
      this.degrade(`failed to delete candidate: ${String(error)}`)
      return false
    }
  }

  async close(): Promise<void> {
    this.closed = true
  }
}
