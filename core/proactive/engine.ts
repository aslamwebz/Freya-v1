import { randomUUID } from 'node:crypto'
import type { EventFabric } from '../events/fabric'
import { DeduplicationRegistry, computeDedupeKey } from './dedup'
import { normalizeObservation } from './normalization'
import type { ProactiveStore } from './store'
import { SubscriptionRegistry } from './subscriptions'
import {
  PROACTIVE_LIMITS,
  type NormalizedObservation,
  type ObservationDropReason,
  type ObservationIngestResult,
  type ObservationSubscription,
  type ObservationSubscriptionInput,
  type ProactiveAdvisoryProposal,
  type RawObservationInput,
  type RelevanceAssessment,
} from './types'
import {
  DeterministicRelevanceFilter,
  type GoalSummary,
  type MissionSummary,
} from './relevance'
import { ProactiveMindReasoner, type MindReasoningPort } from './reasoner'

export interface ProactiveEngineOptions {
  readonly fabric: EventFabric
  readonly store: ProactiveStore
  readonly modelProvider?: MindReasoningPort
  readonly getGoal?: (goalId: string) => GoalSummary | null
  readonly activeGoals?: () => readonly GoalSummary[]
  readonly activeMissions?: () => readonly MissionSummary[]
  readonly recallLearning?: (query: { goal?: string }) => string
  readonly now?: () => Date
  readonly newId?: () => string
  readonly stopAll?: () => boolean
  readonly onChange?: () => void
}

export class ProactiveEngine {
  private readonly dedup: DeduplicationRegistry
  private readonly subscriptionRegistry: SubscriptionRegistry
  private readonly recentObservationBuffer: NormalizedObservation[] = []
  private readonly relevanceFilter: DeterministicRelevanceFilter
  private readonly mindReasoner: ProactiveMindReasoner | undefined
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(private readonly options: ProactiveEngineOptions) {
    this.now = options.now ?? (() => new Date())
    this.newId = options.newId ?? (() => randomUUID())
    this.dedup = new DeduplicationRegistry(options.store)
    this.subscriptionRegistry = new SubscriptionRegistry(options.store, this.now)
    this.relevanceFilter = new DeterministicRelevanceFilter()
    if (options.modelProvider) {
      this.mindReasoner = new ProactiveMindReasoner(options.modelProvider)
    }
  }

  async open(): Promise<void> {
    await this.subscriptionRegistry.load()
  }

  async close(): Promise<void> {
    await this.options.store.close()
  }

  stopAllActive(): boolean {
    return this.options.stopAll?.() ?? false
  }

  /**
   * Ingest and normalize an observation from internal or external sources.
   * Enforces STOP ALL, deduplication, authorization, sanitization, and confidential storage.
   */
  async ingest(input: RawObservationInput): Promise<ObservationIngestResult> {
    const dedupeKey = computeDedupeKey(
      input.sourceType,
      input.sourceId,
      input.sourceRef,
      input.rawSummary ?? '',
    )

    // 1. Emergency Stop Check
    if (this.stopAllActive()) {
      await this.emitDropped(input.sourceType, input.sourceId, dedupeKey, 'stop-all-active')
      return { ok: false, dropCode: 'stop-all-active', reason: 'STOP ALL is active' }
    }

    // 2. Expiration Check
    const nowIso = this.now().toISOString()
    if (input.expiresAt !== undefined && input.expiresAt !== null && input.expiresAt < nowIso) {
      await this.emitDropped(input.sourceType, input.sourceId, dedupeKey, 'expired')
      return { ok: false, dropCode: 'expired', reason: 'observation is already expired' }
    }

    // 3. Authorization Check for external sources
    if (input.sourceType === 'connector' || input.sourceType === 'resource_monitor') {
      const auth = this.subscriptionRegistry.evaluateSourceAuthorization(
        input.sourceId,
        input.predicate ?? 'observed',
      )
      if (!auth.authorized) {
        const dropCode = (auth.reason as ObservationDropReason) ?? 'unauthorized-source'
        await this.emitDropped(input.sourceType, input.sourceId, dedupeKey, dropCode)
        return { ok: false, dropCode, reason: `external observation refused: ${auth.reason}` }
      }
    }

    // 4. Deduplication Check
    const isDup = await this.dedup.isDuplicate(dedupeKey)
    if (isDup) {
      await this.emitDropped(input.sourceType, input.sourceId, dedupeKey, 'duplicate')
      return { ok: false, dropCode: 'duplicate', reason: 'duplicate observation detected' }
    }

    // 5. Encrypted Evidence Storage (if raw details present)
    const observationId = this.newId()
    let evidenceRef: string | null = null
    if (input.details && Object.keys(input.details).length > 0) {
      try {
        await this.options.store.writeEvidence(observationId, input.details)
        evidenceRef = observationId
      } catch (err) {
        console.error('[freya.proactive] failed to write observation evidence', err)
      }
    }

    // 6. Normalization
    const normalized = normalizeObservation(input, observationId, dedupeKey, nowIso, evidenceRef)
    if (!normalized.ok) {
      await this.emitDropped(input.sourceType, input.sourceId, dedupeKey, 'malformed-payload')
      return { ok: false, dropCode: 'malformed-payload', reason: normalized.reason }
    }

    const observation = normalized.observation

    // 7. Record Deduplication Key
    await this.dedup.record(dedupeKey, observation.expiresAt)

    // 8. Cache Observation
    this.recentObservationBuffer.unshift(observation)
    if (this.recentObservationBuffer.length > PROACTIVE_LIMITS.maxRecentObservations) {
      this.recentObservationBuffer.pop()
    }

    // 9. Emit Journal Event
    await this.emitReceived(observation)

    // 10. Deterministic Relevance Assessment
    const assessment = this.evaluateRelevance(observation)

    // Emit Relevance Event
    await this.emitRelevanceEvaluated(observation, assessment)

    // 11. Bounded Mind Reasoning (only when warranted and reasoner configured)
    let proposal: ProactiveAdvisoryProposal | undefined
    if (assessment.warrantsReasoning && this.mindReasoner !== undefined) {
      const goal = assessment.goalId ? this.options.getGoal?.(assessment.goalId) ?? null : null
      const learningAdvice = this.options.recallLearning?.({ goal: goal?.title ?? observation.claim.rawSummary })
      try {
        proposal = await this.mindReasoner.reason({
          observation,
          assessment,
          goal,
          activeMissions: this.options.activeMissions?.(),
          learningAdvice,
        })
      } catch (err) {
        console.error('[freya.proactive] reasoning error', err)
      }
    }

    this.options.onChange?.()
    return { ok: true, observation, assessment, proposal }
  }

  async subscribe(input: ObservationSubscriptionInput): Promise<ObservationSubscription> {
    if (this.stopAllActive()) throw new Error('STOP ALL is active')
    const subscriptionId = input.subscriptionId ?? this.newId()
    const sub = await this.subscriptionRegistry.register(input, subscriptionId)

    await this.emitSubscriptionUpdated(sub)
    this.options.onChange?.()
    return sub
  }

  async revokeSubscription(subscriptionId: string): Promise<boolean> {
    const ok = await this.subscriptionRegistry.revoke(subscriptionId)
    if (ok) {
      const sub = this.subscriptionRegistry.get(subscriptionId)
      if (sub) await this.emitSubscriptionUpdated(sub)
      this.options.onChange?.()
    }
    return ok
  }

  async revoke(subscriptionId: string): Promise<boolean> {
    return this.revokeSubscription(subscriptionId)
  }

  getSubscriptions(): readonly ObservationSubscription[] {
    return this.subscriptionRegistry.list()
  }

  subscriptions(): readonly ObservationSubscription[] {
    return this.getSubscriptions()
  }

  getRecentObservations(limit = 50): readonly NormalizedObservation[] {
    return this.recentObservationBuffer.slice(0, limit)
  }

  recentObservations(limit = 50): readonly NormalizedObservation[] {
    return this.getRecentObservations(limit)
  }

  async isDuplicate(dedupeKey: string): Promise<boolean> {
    return await this.dedup.isDuplicate(dedupeKey)
  }

  evaluateRelevance(observation: NormalizedObservation): RelevanceAssessment {
    return this.relevanceFilter.evaluate(observation, {
      getGoal: this.options.getGoal,
      activeGoals: this.options.activeGoals,
      activeMissions: this.options.activeMissions,
    })
  }

  /* -------------------------------------------------------------- internal */

  private async emitRelevanceEvaluated(
    obs: NormalizedObservation,
    assessment: RelevanceAssessment,
  ): Promise<void> {
    try {
      await this.options.fabric.append(
        'proactive.relevance.evaluated',
        {
          observationId: obs.observationId,
          goalId: assessment.goalId,
          classification: assessment.opportunityType,
          isRelevant: assessment.isRelevant,
          confidence: assessment.confidence,
          reasoningApplied: assessment.warrantsReasoning && this.mindReasoner !== undefined,
        },
        { actor: 'system' },
      )
    } catch (err) {
      console.error('[freya.proactive] failed to append relevance.evaluated event', err)
    }
  }

  private async emitReceived(obs: NormalizedObservation): Promise<void> {
    try {
      await this.options.fabric.append(
        'proactive.observation.received',
        {
          observationId: obs.observationId,
          sourceType: obs.sourceType,
          sourceId: obs.sourceId,
          trust: obs.trust,
          dedupeKey: obs.dedupeKey,
          observedAt: obs.observedAt,
          goalId: obs.goalId,
          milestoneId: obs.milestoneId,
          evidenceRef: obs.evidenceRef,
        },
        { actor: 'system' },
      )
    } catch (err) {
      console.error('[freya.proactive] failed to append observation.received event', err)
    }
  }

  private async emitDropped(
    sourceType: string,
    sourceId: string,
    dedupeKey: string,
    reason: string,
  ): Promise<void> {
    try {
      await this.options.fabric.append(
        'proactive.observation.dropped',
        {
          sourceType,
          sourceId,
          dedupeKey,
          reason,
        },
        { actor: 'system' },
      )
    } catch (err) {
      console.error('[freya.proactive] failed to append observation.dropped event', err)
    }
  }

  private async emitSubscriptionUpdated(sub: ObservationSubscription): Promise<void> {
    try {
      await this.options.fabric.append(
        'proactive.subscription.updated',
        {
          subscriptionId: sub.subscriptionId,
          sourceId: sub.sourceId,
          active: sub.active,
          expiresAt: sub.expiresAt,
        },
        { actor: 'system' },
      )
    } catch (err) {
      console.error('[freya.proactive] failed to append subscription.updated event', err)
    }
  }
}
