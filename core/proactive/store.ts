/**
 * FREYA PROACTIVE INTELLIGENCE — Store Interface & In-Memory Implementation
 *
 * Persists subscriptions, deduplication history, and encrypted observation evidence.
 */

import type { ObservationSubscription } from './types'

export interface ProactiveStoreHealth {
  readonly mode: 'encrypted' | 'ephemeral'
  readonly durable: boolean
  readonly faultReason: string | null
}

export interface ProactiveStore {
  readonly mode: 'encrypted' | 'ephemeral'
  readonly durable: boolean
  readonly faultReason: string | null

  // Subscriptions
  readSubscriptions(): Promise<readonly ObservationSubscription[]>
  writeSubscription(subscription: ObservationSubscription): Promise<void>
  deleteSubscription(subscriptionId: string): Promise<boolean>

  // Deduplication
  hasDedupeKey(key: string): Promise<boolean>
  recordDedupeKey(key: string, expiresAt?: string | null): Promise<void>

  // Evidence / Confidential observations
  writeEvidence(observationId: string, data: Record<string, unknown>): Promise<void>
  readEvidence(observationId: string): Promise<Record<string, unknown> | null>

  close(): Promise<void>
}

export class MemoryProactiveStore implements ProactiveStore {
  readonly mode = 'ephemeral' as const
  readonly durable = false
  readonly faultReason: string | null

  private readonly subscriptions = new Map<string, ObservationSubscription>()
  private readonly dedupeKeys = new Map<string, string | null>()
  private readonly evidence = new Map<string, Record<string, unknown>>()

  constructor(options?: { faultReason?: string | null }) {
    this.faultReason = options?.faultReason ?? null
  }

  async readSubscriptions(): Promise<readonly ObservationSubscription[]> {
    return [...this.subscriptions.values()]
  }

  async writeSubscription(subscription: ObservationSubscription): Promise<void> {
    this.subscriptions.set(subscription.subscriptionId, subscription)
  }

  async deleteSubscription(subscriptionId: string): Promise<boolean> {
    return this.subscriptions.delete(subscriptionId)
  }

  async hasDedupeKey(key: string): Promise<boolean> {
    return this.dedupeKeys.has(key)
  }

  async recordDedupeKey(key: string, expiresAt?: string | null): Promise<void> {
    this.dedupeKeys.set(key, expiresAt ?? null)
  }

  async writeEvidence(observationId: string, data: Record<string, unknown>): Promise<void> {
    this.evidence.set(observationId, data)
  }

  async readEvidence(observationId: string): Promise<Record<string, unknown> | null> {
    return this.evidence.get(observationId) ?? null
  }

  async close(): Promise<void> {
    // In-memory teardown
  }
}
