import type {
  ActiveStrategyRecord,
  FailedImprovementRecord,
  PerformanceTelemetry,
  WeaknessRecord,
} from '../../metacognition/types'
import type { MetacognitionStore } from '../../metacognition/store'
import type { Vault } from '../vault'

const DOMAIN = 'metacognition'

interface VaultRow {
  readonly key: string
  readonly body: string
}

export class VaultMetacognitionStore implements MetacognitionStore {
  readonly mode = 'encrypted' as const
  readonly durable = true

  private degraded: string | null = null
  private closed = false

  constructor(private readonly vault: Vault) {}

  get faultReason(): string | null {
    return this.degraded
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error('Metacognition store is closed.')
  }

  private degrade(reason: string): void {
    this.degraded = reason
  }

  async readTelemetries(): Promise<readonly PerformanceTelemetry[]> {
    this.ensureOpen()
    try {
      const rows = this.vault.all<VaultRow>(
        `SELECT key, body FROM vault_kv WHERE domain = ? AND key LIKE 'telemetry:%'`,
        [DOMAIN],
      )
      const list: PerformanceTelemetry[] = []
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.body) as PerformanceTelemetry
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

  async writeTelemetry(telemetry: PerformanceTelemetry): Promise<void> {
    this.ensureOpen()
    const key = `telemetry:${telemetry.missionId}`
    const body = JSON.stringify(telemetry)
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
      this.degrade(`failed to write telemetry: ${String(error)}`)
      throw error
    }
  }

  async readWeaknesses(): Promise<readonly WeaknessRecord[]> {
    this.ensureOpen()
    try {
      const rows = this.vault.all<VaultRow>(
        `SELECT key, body FROM vault_kv WHERE domain = ? AND key LIKE 'weakness:%'`,
        [DOMAIN],
      )
      const list: WeaknessRecord[] = []
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.body) as WeaknessRecord
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

  async writeWeaknesses(weaknesses: readonly WeaknessRecord[]): Promise<void> {
    this.ensureOpen()
    try {
      this.vault.transaction((tx) => {
        tx.run(`DELETE FROM vault_kv WHERE domain = ? AND key LIKE 'weakness:%'`, [DOMAIN])
        for (const w of weaknesses) {
          const key = `weakness:${w.weaknessId}`
          const body = JSON.stringify(w)
          tx.run(
            `INSERT INTO vault_kv (domain, key, body, updated_at)
             VALUES (?, ?, ?, ?)`,
            [DOMAIN, key, body, new Date().toISOString()],
          )
        }
      })
    } catch (error) {
      this.degrade(`failed to write weaknesses: ${String(error)}`)
      throw error
    }
  }

  async readActiveStrategies(): Promise<readonly ActiveStrategyRecord[]> {
    this.ensureOpen()
    try {
      const rows = this.vault.all<VaultRow>(
        `SELECT key, body FROM vault_kv WHERE domain = ? AND key LIKE 'strategy:%'`,
        [DOMAIN],
      )
      const list: ActiveStrategyRecord[] = []
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.body) as ActiveStrategyRecord
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

  async writeActiveStrategy(strategy: ActiveStrategyRecord): Promise<void> {
    this.ensureOpen()
    const key = `strategy:${strategy.strategyId}`
    const body = JSON.stringify(strategy)
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
      this.degrade(`failed to write strategy: ${String(error)}`)
      throw error
    }
  }

  async readFailedImprovements(): Promise<readonly FailedImprovementRecord[]> {
    this.ensureOpen()
    try {
      const rows = this.vault.all<VaultRow>(
        `SELECT key, body FROM vault_kv WHERE domain = ? AND key LIKE 'failed_imp:%'`,
        [DOMAIN],
      )
      const list: FailedImprovementRecord[] = []
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.body) as FailedImprovementRecord
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

  async writeFailedImprovement(failed: FailedImprovementRecord): Promise<void> {
    this.ensureOpen()
    const key = `failed_imp:${failed.strategyId}`
    const body = JSON.stringify(failed)
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
      this.degrade(`failed to write failed improvement: ${String(error)}`)
      throw error
    }
  }

  async close(): Promise<void> {
    this.closed = true
  }
}
