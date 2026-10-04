import {
  EVOLUTION_LIMITS,
  type EvolutionEventType,
  type EvolutionLimitRequest,
  type EvolutionLimits,
  type EvolutionWakeActor,
  type EvolutionWakeKind,
  type EvolutionWakeSource,
} from '../../../core/evolution/types'
import { narrowEvolutionLimits } from '../../../core/evolution/limits'
import type { EvolutionJournalEntry } from '../../../core/evolution/state'
import type { EvolutionPorts } from '../../../core/evolution/ports'

export const T0 = '2026-03-01T09:00:00.000Z'
export const T_PLUS_1M = '2026-03-01T09:01:00.000Z'
export const T_PLUS_1H = '2026-03-01T10:00:00.000Z'
export const T_PLUS_1D = '2026-03-02T09:00:00.000Z'
export const T_PLUS_15D = '2026-03-16T09:00:00.000Z'
export const T_PLUS_16D = '2026-03-17T09:00:00.000Z'
export const T_PLUS_31D = '2026-04-01T09:00:00.000Z'

export interface HarnessEntry extends EvolutionJournalEntry {
  readonly type: string
  readonly recordedAt: string
  readonly payload: Record<string, unknown>
}

export interface HarnessOptions {
  readonly clock?: string
  readonly stopAll?: boolean
  readonly journalTrustworthy?: boolean
  readonly enabled?: boolean
  readonly guardAllows?: boolean
  readonly governorAuthorized?: boolean
  readonly approvalSatisfied?: boolean
  readonly budgetRemainingUnits?: number
  readonly limits?: EvolutionLimitRequest
}

export interface Harness {
  readonly ports: EvolutionPorts
  readonly entries: readonly HarnessEntry[]
  readonly limits: EvolutionLimits
  seed(entries: readonly HarnessEntry[]): void
  types(): readonly string[]
  payloads(type: EvolutionEventType): readonly Record<string, unknown>[]
  setClock(instant: string): void
  setStopAll(active: boolean): void
  setJournalTrustworthy(trustworthy: boolean): void
  setEnabled(enabled: boolean): void
  setGuardAllows(allows: boolean): void
  setGovernorAuthorized(authorized: boolean): void
  setApprovalSatisfied(satisfied: boolean): void
  setBudgetRemaining(units: number): void
  refusals(): readonly string[]
  changes(): number
}

export function harness(options: HarnessOptions = {}): Harness {
  const entries: HarnessEntry[] = []
  let clock = options.clock ?? T0
  let stopAll = options.stopAll ?? false
  let trustworthy = options.journalTrustworthy ?? true
  let enabled = options.enabled ?? true
  let guardAllows = options.guardAllows ?? true
  let governorAuthorized = options.governorAuthorized ?? true
  let approvalSatisfied = options.approvalSatisfied ?? true
  let budget = options.budgetRemainingUnits ?? 1_000_000
  let ids = 0
  let changes = 0

  const ports: EvolutionPorts = {
    now: () => clock,
    newId: () => `h-${(ids += 1)}`,
    append: async (type: EvolutionEventType, payload: Record<string, string | number | boolean | null>) => {
      entries.push({ type, recordedAt: clock, payload: { ...payload } })
    },
    replay: async () => entries,
    stopAllActive: () => stopAll,
    journalTrustworthy: () => trustworthy,
    enabled: () => enabled,
    guardAllows: () => guardAllows,
    governorAuthorized: () => governorAuthorized,
    approvalSatisfied: () => approvalSatisfied,
    budgetRemainingUnits: () => budget,
    onChange: () => {
      changes += 1
    },
  }

  return {
    ports,
    limits: narrowEvolutionLimits(options.limits),
    get entries() {
      return entries
    },
    seed: (prior) => {
      for (const entry of prior) entries.push({ ...entry, payload: { ...entry.payload } })
    },
    types: () => entries.map((entry) => entry.type),
    payloads: (type) => entries.filter((entry) => entry.type === type).map((entry) => entry.payload),
    setClock: (instant) => {
      clock = instant
    },
    setStopAll: (active) => {
      stopAll = active
    },
    setJournalTrustworthy: (next) => {
      trustworthy = next
    },
    setEnabled: (next) => {
      enabled = next
    },
    setGuardAllows: (next) => {
      guardAllows = next
    },
    setGovernorAuthorized: (next) => {
      governorAuthorized = next
    },
    setApprovalSatisfied: (next) => {
      approvalSatisfied = next
    },
    setBudgetRemaining: (next) => {
      budget = next
    },
    refusals: () =>
      entries
        .filter((entry) => entry.type === 'evolution.wake.denied')
        .map((entry) => String(entry.payload.code)),
    changes: () => changes,
  }
}

export function wake(overrides: {
  readonly source?: EvolutionWakeSource
  readonly kind?: EvolutionWakeKind
  readonly actor?: EvolutionWakeActor
  readonly goalRef?: string | null
  readonly sourceRef?: string | null
  readonly occurredAt?: string
} = {}) {
  const source = overrides.source ?? 'authorized-event'
  const kind = overrides.kind ?? ('system-health' as EvolutionWakeKind)
  return {
    source,
    kind,
    actor: overrides.actor ?? ('core-subsystem' as EvolutionWakeActor),
    goalRef: overrides.goalRef === undefined ? null : overrides.goalRef,
    sourceRef: overrides.sourceRef === undefined ? 'src-1' : overrides.sourceRef,
    occurredAt: overrides.occurredAt ?? T0,
  }
}

export { EVOLUTION_LIMITS, narrowEvolutionLimits }
export type { EvolutionLimits }
