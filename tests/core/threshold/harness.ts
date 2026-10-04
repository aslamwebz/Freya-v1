import {
  THRESHOLD_LIMITS,
  type ThresholdEventType,
  type ThresholdLimitRequest,
  type ThresholdLimits,
  type ThresholdWakeActor,
  type ThresholdWakeKind,
  type ThresholdWakeSource,
} from '../../../core/threshold/types'
import { narrowThresholdLimits } from '../../../core/threshold/limits'
import type { ThresholdJournalEntry } from '../../../core/threshold/state'
import type { ThresholdPorts } from '../../../core/threshold/ports'
import { validateDurableEvent } from '../../../core/events/validate'

/** The fixed clock the whole suite reads. */
export const T0 = '2026-03-01T09:00:00.000Z'
export const T_PLUS_1M = '2026-03-01T09:01:00.000Z'
export const T_PLUS_1H = '2026-03-01T10:00:00.000Z'
export const T_PLUS_1D = '2026-03-02T09:00:00.000Z'
export const T_PLUS_15D = '2026-03-16T09:00:00.000Z'
export const T_PLUS_16D = '2026-03-17T09:00:00.000Z'
export const T_PLUS_31D = '2026-04-01T09:00:00.000Z'

/** One journal entry. */
export interface HarnessEntry extends ThresholdJournalEntry {
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
  readonly limits?: ThresholdLimitRequest
}

export interface Harness {
  readonly ports: ThresholdPorts
  readonly entries: readonly HarnessEntry[]
  readonly limits: ThresholdLimits
  seed(entries: readonly HarnessEntry[]): void
  validate(): readonly string[]
  types(): readonly string[]
  payloads(type: ThresholdEventType): readonly Record<string, unknown>[]
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

/**
 * Build the ports a runtime needs, and record everything it writes.
 */
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

  const ports: ThresholdPorts = {
    now: () => clock,
    newId: () => `h-${(ids += 1)}`,
    append: async (type: ThresholdEventType, payload: Record<string, string | number | boolean | null>) => {
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
    limits: narrowThresholdLimits(options.limits),
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
        .filter((entry) => entry.type === 'threshold.wake.denied')
        .map((entry) => String(entry.payload.code)),
    changes: () => changes,
  }
}

/** A wake whose source and kind are kept in agreement. */
export function wake(overrides: {
  readonly source?: ThresholdWakeSource
  readonly kind?: ThresholdWakeKind
  readonly actor?: ThresholdWakeActor
  readonly goalRef?: string | null
  readonly sourceRef?: string | null
  readonly occurredAt?: string
} = {}) {
  const source = overrides.source ?? 'authorized-event'
  const kind = overrides.kind ?? ('system-health' as ThresholdWakeKind)
  return {
    source,
    kind,
    actor: overrides.actor ?? ('core-subsystem' as ThresholdWakeActor),
    goalRef: overrides.goalRef === undefined ? null : overrides.goalRef,
    sourceRef: overrides.sourceRef === undefined ? 'src-1' : overrides.sourceRef,
    occurredAt: overrides.occurredAt ?? T0,
  }
}

export { THRESHOLD_LIMITS, narrowThresholdLimits }
export type { ThresholdLimits }
