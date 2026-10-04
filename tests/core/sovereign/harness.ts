import {
  SOVEREIGNTY_LIMITS,
  type SovereigntyEventType,
  type SovereigntyLimitRequest,
  type SovereigntyLimits,
  type SovereigntyWakeActor,
  type SovereigntyWakeKind,
  type SovereigntyWakeSource,
} from '../../../core/sovereign/types'
import { narrowSovereigntyLimits } from '../../../core/sovereign/limits'
import type { SovereigntyJournalEntry } from '../../../core/sovereign/state'
import type { SovereigntyPorts } from '../../../core/sovereign/ports'
import { validateDurableEvent } from '../../../core/events/validate'

export const T0 = '2026-03-01T09:00:00.000Z'
export const T_PLUS_1M = '2026-03-01T09:01:00.000Z'
export const T_PLUS_1H = '2026-03-01T10:00:00.000Z'
export const T_PLUS_1D = '2026-03-02T09:00:00.000Z'
export const T_PLUS_15D = '2026-03-16T09:00:00.000Z'
export const T_PLUS_16D = '2026-03-17T09:00:00.000Z'
export const T_PLUS_31D = '2026-04-01T09:00:00.000Z'

export interface HarnessEntry extends SovereigntyJournalEntry {
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
  readonly limits?: SovereigntyLimitRequest
}

export interface Harness {
  readonly ports: SovereigntyPorts
  readonly entries: readonly HarnessEntry[]
  readonly limits: SovereigntyLimits
  seed(entries: readonly HarnessEntry[]): void
  validate(): readonly string[]
  types(): readonly string[]
  payloads(type: SovereigntyEventType): readonly Record<string, unknown>[]
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

  const ports: SovereigntyPorts = {
    now: () => clock,
    newId: () => `h-${(ids += 1)}`,
    append: async (type: SovereigntyEventType, payload: Record<string, string | number | boolean | null>) => {
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
    limits: narrowSovereigntyLimits(options.limits),
    get entries() {
      return entries
    },
    seed: (prior) => {
      for (const entry of prior) entries.push({ ...entry, payload: { ...entry.payload } })
    },
    validate: () =>
      entries
        .map((entry, index) => {
          const result = validateDurableEvent(
            {
              eventId: `evt-${index + 1}`,
              sequence: index + 1,
              type: entry.type,
              schemaVersion: 1,
              occurredAt: entry.recordedAt,
              source: 'core',
              actor: 'system',
              correlationId: `corr-${index + 1}`,
              causationId: null,
              payload: entry.payload,
            },
            0,
          )
          return result.ok ? '' : `${entry.type}: ${result.reason}`
        })
        .filter((failure) => failure.length > 0),
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
        .filter((entry) => entry.type === 'sovereignty.wake.denied')
        .map((entry) => String(entry.payload.code)),
    changes: () => changes,
  }
}

export function wake(overrides: {
  readonly source?: SovereigntyWakeSource
  readonly kind?: SovereigntyWakeKind
  readonly actor?: SovereigntyWakeActor
  readonly goalRef?: string | null
  readonly sourceRef?: string | null
  readonly occurredAt?: string
} = {}) {
  const source = overrides.source ?? 'authorized-event'
  const kind = overrides.kind ?? ('system-health' as SovereigntyWakeKind)
  return {
    source,
    kind,
    actor: overrides.actor ?? ('core-subsystem' as SovereigntyWakeActor),
    goalRef: overrides.goalRef === undefined ? null : overrides.goalRef,
    sourceRef: overrides.sourceRef === undefined ? 'src-1' : overrides.sourceRef,
    occurredAt: overrides.occurredAt ?? T0,
  }
}

export function provider(overrides: {
  readonly providerId?: string
  readonly name?: string
  readonly status?: string
  readonly priority?: number
  readonly isLocal?: boolean
  readonly isOfflineCapable?: boolean
} = {}) {
  return {
    providerId: overrides.providerId ?? 'p-1',
    name: overrides.name ?? 'Test Provider',
    status: overrides.status ?? ('healthy' as const),
    priority: overrides.priority ?? 0,
    isLocal: overrides.isLocal ?? false,
    isOfflineCapable: overrides.isOfflineCapable ?? false,
  }
}

export { SOVEREIGNTY_LIMITS, narrowSovereigntyLimits }
export type { SovereigntyLimits }
