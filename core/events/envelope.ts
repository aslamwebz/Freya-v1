import type { CoreEventType } from '../../shared/contracts/events/names'
export { CORE_EVENT_SCHEMA_VERSION, CORE_EVENT_TYPES } from '../../shared/contracts/events/names'
export type { CoreEventType } from '../../shared/contracts/events/names'
export { type ConversationTurnEvent } from '../../shared/contracts/events/families/conversation'
export { type WorkforceBudgetPayload } from '../../shared/contracts/events/families/workforce'
export { type MissionStepPayload } from '../../shared/contracts/events/families/mission'
export { type MissionLimitsPayload } from '../../shared/contracts/events/families/mission'
export { type MissionBudgetPayload } from '../../shared/contracts/events/families/mission'
export { type MissionTransitionPayload } from '../../shared/contracts/events/families/mission'
export { type GoalLimitsPayload } from '../../shared/contracts/events/families/longhorizon'
export { type SkillRefusalReason } from '../../shared/contracts/events/families/skill'
export { type SkillVersionEvent } from '../../shared/contracts/events/families/skill'
export { type ResearchStageEvent } from '../../shared/contracts/events/families/research'
export { type ResearchStageCounters } from '../../shared/contracts/events/families/research'
import type { PrincipalId } from '../../shared/contracts/identity'



export interface CoreEventEnvelope<T extends CoreEventType = CoreEventType> {
  eventId: string
  /** Monotonic per Core lifetime, and after replay, across the whole log. */
  sequence: number
  type: T
  schemaVersion: number
  occurredAt: string

  source: 'core' | 'renderer' | 'system'
  actor: PrincipalId

  /** Ties related events together across subsystems. */
  correlationId: string
  /** The event that caused this one. */
  causationId: string | null

  payload: CoreEventPayloads[T]
}

/** The payload each event type carries. */
import type { CoreLifecycleEventPayloads } from '../../shared/contracts/events/families/core'
import type { CommandEventPayloads } from '../../shared/contracts/events/families/command'
import type { GuardEventPayloads } from '../../shared/contracts/events/families/guard'
import type { SecurityEventPayloads } from '../../shared/contracts/events/families/security'
import type { CognitionEventPayloads } from '../../shared/contracts/events/families/cognition'
import type { ModelEventPayloads } from '../../shared/contracts/events/families/model'
import type { ConversationEventPayloads } from '../../shared/contracts/events/families/conversation'
import type { VoiceEventPayloads } from '../../shared/contracts/events/families/voice'
import type { BrainEventPayloads } from '../../shared/contracts/events/families/brain'
import type { LifeEventPayloads } from '../../shared/contracts/events/families/life'
import type { PersonalityEventPayloads } from '../../shared/contracts/events/families/personality'
import type { ResearchEventPayloads } from '../../shared/contracts/events/families/research'
import type { WorkEventPayloads } from '../../shared/contracts/events/families/work'
import type { MissionEventPayloads } from '../../shared/contracts/events/families/mission'
import type { WorkforceEventPayloads } from '../../shared/contracts/events/families/workforce'
import type { AttentionEventPayloads } from '../../shared/contracts/events/families/attention'
import type { LifeloopEventPayloads } from '../../shared/contracts/events/families/lifeloop'
import type { EconomicEventPayloads } from '../../shared/contracts/events/families/economic'
import type { SkillEventPayloads } from '../../shared/contracts/events/families/skill'
import type { ForgeEventPayloads } from '../../shared/contracts/events/families/forge'
import type { FoundryEventPayloads } from '../../shared/contracts/events/families/foundry'
import type { OfficeEventPayloads } from '../../shared/contracts/events/families/office'
import type { RelayEventPayloads } from '../../shared/contracts/events/families/relay'
import type { ConnectorEventPayloads } from '../../shared/contracts/events/families/connector'
import type { LonghorizonEventPayloads } from '../../shared/contracts/events/families/longhorizon'
import type { RuntimeEventPayloads } from '../../shared/contracts/events/families/runtime'
import type { ProactiveEventPayloads } from '../../shared/contracts/events/families/proactive'

export interface CoreEventPayloads extends CoreLifecycleEventPayloads, CommandEventPayloads, GuardEventPayloads, SecurityEventPayloads, CognitionEventPayloads, ModelEventPayloads, ConversationEventPayloads, VoiceEventPayloads, BrainEventPayloads, LifeEventPayloads, PersonalityEventPayloads, ResearchEventPayloads, WorkEventPayloads, MissionEventPayloads, WorkforceEventPayloads, AttentionEventPayloads, LifeloopEventPayloads, EconomicEventPayloads, SkillEventPayloads, ForgeEventPayloads, FoundryEventPayloads, OfficeEventPayloads, RelayEventPayloads, ConnectorEventPayloads, LonghorizonEventPayloads, RuntimeEventPayloads, ProactiveEventPayloads {}


/**
 * Every Core event, as a discriminated union.
 *
 * The mapping matters: it is what lets `Extract<Event, { type: T }>['payload']`
 * resolve to the payload of one specific event type rather than to a union of
 * every payload in the system.
 */
export type AnyCoreEvent = {
  [K in CoreEventType]: CoreEventEnvelope<K>
}[CoreEventType]

/**
 * Events that change durable security or governance state.
 *
 * ## No `work.*` event is in this list, and none may be
 *
 * The test is the same one that keeps `brain.degraded` out, and it is worth
 * restating because Work is the subsystem where it is most tempting to add one.
 * These events describe Freya *doing work*: what was planned, what was attempted,
 * what came back, whether it verified, and what a person decided about it.
 *
 * A Work fault or a Work success can neither grant cognition nor clear a stop. A
 * run that reached `completed` says nothing about whether Freya may think next,
 * and an execution ceiling that was hit says nothing about the authority to reach
 * it. Putting these in the security stream would let an ordinary work failure
 * masquerade as a safety posture, and let a real safety problem look like a
 * failing step.
 *
 * The genuinely security-relevant part of Work is already recorded in the events
 * that *are* in this list: `guard.decision` is written every time Guard refuses a
 * capability, and `work.action.started` names the principal whose capabilities were
 * evaluated. Approval decisions belong to Work's own stream because an approval
 * gates one capability execution; it does not alter what Freya is allowed to think,
 * which is what `cognition.grant.*` and `security.stop_all.*` are for.
 */
export const SECURITY_EVENT_TYPES: readonly CoreEventType[] = [
  'guard.decision',
  'security.stop_all.activated',
  'security.stop_all.cleared',
  'cognition.grant.created',
  'cognition.grant.revoked',
  'cognition.grant.reserved',
  'cognition.grant.usage_reported',
]

export function isSecurityEvent(type: CoreEventType): boolean {
  return SECURITY_EVENT_TYPES.includes(type)
}
