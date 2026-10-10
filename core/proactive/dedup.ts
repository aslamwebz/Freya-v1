import { createHash } from 'node:crypto'
import type { ProactiveStore } from './store'
import { PROACTIVE_LIMITS } from './types'

export function computeDedupeKey(
  sourceType: string,
  sourceId: string,
  sourceRef: string,
  rawSummary: string,
): string {
  const normalizedSummary = rawSummary.trim().toLowerCase().slice(0, PROACTIVE_LIMITS.maxObservationTextLength)
  const hash = createHash('sha256')
    .update(`${sourceType}:${sourceId}:${sourceRef}:${normalizedSummary}`)
    .digest('hex')
    .slice(0, 32)
  return `${sourceType}:${sourceId}:${hash}`
}

export class DeduplicationRegistry {
  private readonly memoryKeys = new Set<string>()

  constructor(private readonly store: ProactiveStore) {}

  async isDuplicate(key: string): Promise<boolean> {
    if (this.memoryKeys.has(key)) return true
    return await this.store.hasDedupeKey(key)
  }

  async record(key: string, expiresAt?: string | null): Promise<void> {
    this.memoryKeys.add(key)
    if (this.memoryKeys.size > PROACTIVE_LIMITS.maxDedupeHistory) {
      // Evict oldest entries
      const first = this.memoryKeys.values().next().value
      if (first !== undefined) this.memoryKeys.delete(first)
    }
    await this.store.recordDedupeKey(key, expiresAt)
  }
}
