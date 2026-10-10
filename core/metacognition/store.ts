/**
 * FREYA METACOGNITION — Store Interface & In-Memory Implementation
 *
 * Persists performance telemetry and discovered weakness records.
 */

import type {
  ActiveStrategyRecord,
  FailedImprovementRecord,
  PerformanceTelemetry,
  WeaknessRecord,
} from './types'

export interface MetacognitionStoreHealth {
  readonly mode: 'encrypted' | 'ephemeral'
  readonly durable: boolean
  readonly faultReason: string | null
}

export interface MetacognitionStore {
  readonly mode: 'encrypted' | 'ephemeral'
  readonly durable: boolean
  readonly faultReason: string | null

  // Telemetry Records
  readTelemetries(): Promise<readonly PerformanceTelemetry[]>
  writeTelemetry(telemetry: PerformanceTelemetry): Promise<void>

  // Weakness Records
  readWeaknesses(): Promise<readonly WeaknessRecord[]>
  writeWeaknesses(weaknesses: readonly WeaknessRecord[]): Promise<void>

  // Active / Failed Strategies
  readActiveStrategies(): Promise<readonly ActiveStrategyRecord[]>
  writeActiveStrategy(strategy: ActiveStrategyRecord): Promise<void>
  readFailedImprovements(): Promise<readonly FailedImprovementRecord[]>
  writeFailedImprovement(failed: FailedImprovementRecord): Promise<void>

  close(): Promise<void>
}

export class MemoryMetacognitionStore implements MetacognitionStore {
  readonly mode = 'ephemeral' as const
  readonly durable = false
  readonly faultReason: string | null

  private readonly telemetries: PerformanceTelemetry[] = []
  private readonly weaknesses = new Map<string, WeaknessRecord>()
  private readonly activeStrategies = new Map<string, ActiveStrategyRecord>()
  private readonly failedImprovements = new Map<string, FailedImprovementRecord>()

  constructor(options?: { faultReason?: string | null }) {
    this.faultReason = options?.faultReason ?? null
  }

  async readTelemetries(): Promise<readonly PerformanceTelemetry[]> {
    return [...this.telemetries]
  }

  async writeTelemetry(telemetry: PerformanceTelemetry): Promise<void> {
    this.telemetries.push(telemetry)
  }

  async readWeaknesses(): Promise<readonly WeaknessRecord[]> {
    return [...this.weaknesses.values()]
  }

  async writeWeaknesses(weaknesses: readonly WeaknessRecord[]): Promise<void> {
    this.weaknesses.clear()
    for (const w of weaknesses) {
      this.weaknesses.set(w.weaknessId, w)
    }
  }

  async readActiveStrategies(): Promise<readonly ActiveStrategyRecord[]> {
    return [...this.activeStrategies.values()]
  }

  async writeActiveStrategy(strategy: ActiveStrategyRecord): Promise<void> {
    this.activeStrategies.set(strategy.strategyId, strategy)
  }

  async readFailedImprovements(): Promise<readonly FailedImprovementRecord[]> {
    return [...this.failedImprovements.values()]
  }

  async writeFailedImprovement(failed: FailedImprovementRecord): Promise<void> {
    this.failedImprovements.set(failed.strategyId, failed)
  }

  async close(): Promise<void> {
    // No-op for in-memory store
  }
}
