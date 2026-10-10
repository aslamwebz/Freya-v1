import type { ProactiveStore } from './store'
import {
  PROACTIVE_LIMITS,
  type ObservationSubscription,
  type ObservationSubscriptionInput,
} from './types'

export class SubscriptionRegistry {
  private readonly subscriptions = new Map<string, ObservationSubscription>()
  private readonly hourlyCounts = new Map<string, { count: number; hourWindow: number }>()

  constructor(
    private readonly store: ProactiveStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async load(): Promise<void> {
    const stored = await this.store.readSubscriptions()
    this.subscriptions.clear()
    for (const sub of stored) {
      this.subscriptions.set(sub.subscriptionId, sub)
    }
  }

  async register(
    input: ObservationSubscriptionInput,
    subscriptionId: string,
  ): Promise<ObservationSubscription> {
    if (this.subscriptions.size >= PROACTIVE_LIMITS.maxSubscriptions) {
      throw new Error(`Maximum subscriptions ceiling reached (${PROACTIVE_LIMITS.maxSubscriptions})`)
    }

    const sub: ObservationSubscription = {
      subscriptionId,
      sourceId: input.sourceId.trim(),
      sourceType: input.sourceType.trim(),
      scope: input.scope.trim(),
      allowedTypes: [...input.allowedTypes],
      active: input.active ?? true,
      expiresAt: input.expiresAt ?? null,
      maxObservationsPerHour: input.maxObservationsPerHour ?? PROACTIVE_LIMITS.defaultRateLimitPerHour,
      consentGranted: input.consentGranted ?? true,
      registeredAt: this.now().toISOString(),
    }

    this.subscriptions.set(subscriptionId, sub)
    await this.store.writeSubscription(sub)
    return sub
  }

  async revoke(subscriptionId: string): Promise<boolean> {
    const existing = this.subscriptions.get(subscriptionId)
    if (!existing) return false
    const updated: ObservationSubscription = { ...existing, active: false }
    this.subscriptions.set(subscriptionId, updated)
    await this.store.writeSubscription(updated)
    return true
  }

  list(): readonly ObservationSubscription[] {
    return [...this.subscriptions.values()]
  }

  get(subscriptionId: string): ObservationSubscription | null {
    return this.subscriptions.get(subscriptionId) ?? null
  }

  /**
   * Validate whether an external observation is authorized under an active subscription.
   */
  evaluateSourceAuthorization(
    sourceId: string,
    observationType: string,
  ): { authorized: boolean; reason?: string } {
    const activeSubs = [...this.subscriptions.values()].filter(
      (s) => s.sourceId === sourceId && s.active,
    )

    if (activeSubs.length === 0) {
      return { authorized: false, reason: 'unauthorized-source' }
    }

    const nowIso = this.now().toISOString()
    const validSub = activeSubs.find((s) => {
      if (!s.consentGranted) return false
      if (s.expiresAt !== null && s.expiresAt < nowIso) return false
      if (s.allowedTypes.length > 0 && !s.allowedTypes.includes(observationType)) return false
      return true
    })

    if (!validSub) {
      return { authorized: false, reason: 'scope-mismatch' }
    }

    // Rate limit check
    const currentHour = Math.floor(this.now().getTime() / (1000 * 60 * 60))
    const usage = this.hourlyCounts.get(validSub.subscriptionId) ?? { count: 0, hourWindow: currentHour }
    if (usage.hourWindow !== currentHour) {
      usage.count = 0
      usage.hourWindow = currentHour
    }

    if (usage.count >= validSub.maxObservationsPerHour) {
      return { authorized: false, reason: 'rate-limit-exceeded' }
    }

    usage.count++
    this.hourlyCounts.set(validSub.subscriptionId, usage)
    return { authorized: true }
  }
}
