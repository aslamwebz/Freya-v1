import type {
  SovereigntyEventType,
  SovereigntyWakeActor,
  SovereigntyWakeKind,
  SovereigntyWakeSource,
} from './types'
import type { SovereigntyJournalEntry } from './state'

export type SovereigntyPayload = Readonly<Record<string, string | number | boolean | null>>

export interface SovereigntyPorts {
  now(): string
  newId(): string
  append(type: SovereigntyEventType, payload: SovereigntyPayload): Promise<void>
  replay(): Promise<readonly SovereigntyJournalEntry[]>
  stopAllActive(): boolean
  journalTrustworthy(): boolean
  enabled(): boolean
  guardAllows(): boolean
  governorAuthorized(): boolean
  approvalSatisfied(target: string): boolean
  budgetRemainingUnits(): number
  onChange(): void
}

export interface SovereigntyWakeRequest {
  readonly source: SovereigntyWakeSource
  readonly kind: SovereigntyWakeKind
  readonly actor: SovereigntyWakeActor
  readonly goalRef: string | null
  readonly sourceRef: string | null
  readonly occurredAt: string
}
