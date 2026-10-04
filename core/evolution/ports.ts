import type { EvolutionEventType, EvolutionWakeActor, EvolutionWakeKind, EvolutionWakeSource } from './types'
import type { EvolutionJournalEntry } from './state'

export type EvolutionPayload = Readonly<Record<string, string | number | boolean | null | readonly string[]>>

export interface EvolutionPorts {
  now(): string
  newId(): string
  append(type: EvolutionEventType, payload: EvolutionPayload): Promise<void>
  replay(): Promise<readonly EvolutionJournalEntry[]>
  stopAllActive(): boolean
  journalTrustworthy(): boolean
  enabled(): boolean
  guardAllows(): boolean
  governorAuthorized(): boolean
  approvalSatisfied(target: string): boolean
  budgetRemainingUnits(): number
  onChange(): void
}

export interface EvolutionWakeRequest {
  readonly source: EvolutionWakeSource
  readonly kind: EvolutionWakeKind
  readonly actor: EvolutionWakeActor
  readonly goalRef: string | null
  readonly sourceRef: string | null
  readonly occurredAt: string
}
