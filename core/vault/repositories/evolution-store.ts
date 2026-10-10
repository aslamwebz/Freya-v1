/**
 * FREYA EVOLUTION — Encrypted Vault Evolution Store
 *
 * Persists versioned strategy candidates, approvals, promotions, and rollbacks in SQLCipher Vault under domain = 'evolution'.
 */

import type { CandidateStatus, StrategyCandidate } from '../../evolution/strategy'
import type { PromotionRecord, RollbackRecord, StrategyPromotionApproval } from '../../evolution/approval'
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

  async readApprovals(): Promise<readonly StrategyPromotionApproval[]> {
    this.ensureOpen()
    try {
      const rows = this.vault.all<VaultRow>(
        `SELECT key, body FROM vault_kv WHERE domain = ? AND key LIKE 'approval:%'`,
        [DOMAIN],
      )
      const list: StrategyPromotionApproval[] = []
      for (const row of rows) {
        try {
          list.push(JSON.parse(row.body) as StrategyPromotionApproval)
        } catch {
          // ignore corrupted row
        }
      }
      return list
    } catch {
      return []
    }
  }

  async writeApproval(approval: StrategyPromotionApproval): Promise<void> {
    this.ensureOpen()
    const key = `approval:${approval.approvalId}`
    const body = JSON.stringify(approval)
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
      this.degrade(`failed to write approval: ${String(error)}`)
      throw error
    }
  }

  async getApproval(approvalId: string): Promise<StrategyPromotionApproval | null> {
    this.ensureOpen()
    const key = `approval:${approvalId}`
    try {
      const rows = this.vault.all<VaultRow>(
        `SELECT key, body FROM vault_kv WHERE domain = ? AND key = ?`,
        [DOMAIN, key],
      )
      const row = rows[0]
      if (!row) return null
      return JSON.parse(row.body) as StrategyPromotionApproval
    } catch {
      return null
    }
  }

  async readPromotionHistory(): Promise<readonly PromotionRecord[]> {
    this.ensureOpen()
    try {
      const rows = this.vault.all<VaultRow>(
        `SELECT key, body FROM vault_kv WHERE domain = ? AND key LIKE 'promotion:%' ORDER BY key ASC`,
        [DOMAIN],
      )
      const list: PromotionRecord[] = []
      for (const row of rows) {
        try {
          list.push(JSON.parse(row.body) as PromotionRecord)
        } catch {
          // ignore corrupted row
        }
      }
      return list
    } catch {
      return []
    }
  }

  async writePromotionRecord(record: PromotionRecord): Promise<void> {
    this.ensureOpen()
    const key = `promotion:${record.candidateId}:${record.activatedAt}`
    const body = JSON.stringify(record)
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
      this.degrade(`failed to write promotion record: ${String(error)}`)
      throw error
    }
  }

  async readRollbackHistory(): Promise<readonly RollbackRecord[]> {
    this.ensureOpen()
    try {
      const rows = this.vault.all<VaultRow>(
        `SELECT key, body FROM vault_kv WHERE domain = ? AND key LIKE 'rollback:%' ORDER BY key ASC`,
        [DOMAIN],
      )
      const list: RollbackRecord[] = []
      for (const row of rows) {
        try {
          list.push(JSON.parse(row.body) as RollbackRecord)
        } catch {
          // ignore corrupted row
        }
      }
      return list
    } catch {
      return []
    }
  }

  async writeRollbackRecord(record: RollbackRecord): Promise<void> {
    this.ensureOpen()
    const key = `rollback:${record.candidateId}:${record.rolledBackAt}`
    const body = JSON.stringify(record)
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
      this.degrade(`failed to write rollback record: ${String(error)}`)
      throw error
    }
  }

  async close(): Promise<void> {
    this.closed = true
  }
}
