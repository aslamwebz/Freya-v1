import {
  ECONOMIC_LIMITS,
  type EconomicEventType,
  type EconomicExperimentKind,
  type EconomicLimitRequest,
  type EconomicLimits,
  type EconomicStage,
  type EconomicWakeActor,
  type EconomicWakeKind,
  type EconomicWakeSource,
  type PricePoint,
} from '../../../core/economic/types'
import { narrowEconomicLimits } from '../../../core/economic/limits'
import type { EvidenceObservation } from '../../../core/economic/evidence'
import type { EconomicJournalEntry } from '../../../core/economic/state'
import type { EconomicPorts } from '../../../core/economic/ports'
import { validateDurableEvent } from '../../../core/events/validate'

/**
 * A Core-free harness for Economic Intelligence.
 *
 * The point of this file is that **nothing in it can spend and nothing in it can place a
 * real order**. There is no provider, no gateway, no grant store, no broker and no venue;
 * `observationsFor` and `priceSeriesFor` return scripted answers and count the calls, and
 * `realMoney` is a switch a test flips to prove the gate refuses. That is deliberate: a
 * test that wanted to prove "this subsystem has no route to money" cannot use a real
 * Core, because a real Core could have done something before the assertion ran.
 *
 * Every instant is a literal and every id is a counter, so "after the deadline" means
 * exactly that and two runs over the same script produce the same journal.
 */

/** The fixed clock the whole suite reads. Nothing here calls `Date.now()`. */
export const T0 = '2026-03-01T09:00:00.000Z'
export const T_PLUS_1M = '2026-03-01T09:01:00.000Z'
export const T_PLUS_1H = '2026-03-01T10:00:00.000Z'
export const T_PLUS_1D = '2026-03-02T09:00:00.000Z'
export const T_PLUS_15D = '2026-03-16T09:00:00.000Z'
export const T_PLUS_16D = '2026-03-17T09:00:00.000Z'
export const T_PLUS_31D = '2026-04-01T09:00:00.000Z'

/** One journal entry, as the fold and the validator would both see it. */
export interface HarnessEntry extends EconomicJournalEntry {
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
  readonly observations?: readonly EvidenceObservation[]
  readonly series?: readonly PricePoint[]
  readonly limits?: EconomicLimitRequest
}

export interface Harness {
  /** The ports as Core would satisfy them, so a runtime can be built and driven. */
  readonly ports: EconomicPorts
  readonly entries: readonly HarnessEntry[]
  readonly limits: EconomicLimits
  /**
   * Pre-load the journal, as a previous process would have left it.
   *
   * Copied rather than aliased, so a test can replay one process's journal into a second
   * harness and then let both keep writing without them sharing state.
   */
  seed(entries: readonly HarnessEntry[]): void
  /** Every payload written, checked against the Core journal validator. */
  validate(): readonly string[]
  types(): readonly string[]
  /** The payloads of one event type, in order. */
  payloads(type: EconomicEventType): readonly Record<string, unknown>[]
  setClock(instant: string): void
  setStopAll(active: boolean): void
  setJournalTrustworthy(trustworthy: boolean): void
  setEnabled(enabled: boolean): void
  setGuardAllows(allows: boolean): void
  setGovernorAuthorized(authorized: boolean): void
  setApprovalSatisfied(satisfied: boolean): void
  setBudgetRemaining(units: number): void
  setObservations(observations: readonly EvidenceObservation[]): void
  setSeries(series: readonly PricePoint[]): void
  observationCalls(): number
  seriesCalls(): number
  refusals(): readonly string[]
  changes(): number
}

/**
 * Build the ports a runtime needs, and record everything it writes.
 *
 * The journal is a plain array rather than a file, and that is what lets the harness
 * assert the strongest property available here: **every payload the runtime writes is
 * accepted by the Core journal validator**. A payload that were not would reach disk and
 * be rejected on the next read, which truncates the log at that line — so a mismatch is
 * not a cosmetic test failure but a corrupted journal, and it is the one failure mode a
 * runtime test can catch and a unit test cannot.
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
  let observations = options.observations ?? []
  let series = options.series ?? []
  let ids = 0
  let observationCalls = 0
  let seriesCalls = 0
  let changes = 0

  const ports: EconomicPorts = {
    now: () => clock,
    newId: () => `h-${(ids += 1)}`,
    append: async (type: EconomicEventType, payload: Record<string, string | number | boolean | null>) => {
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
    observationsFor: async () => {
      observationCalls += 1
      return observations
    },
    priceSeriesFor: async () => {
      seriesCalls += 1
      return series
    },
    onChange: () => {
      changes += 1
    },
  }

  return {
    ports,
    limits: narrowEconomicLimits(options.limits),
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
    setObservations: (next) => {
      observations = next
    },
    setSeries: (next) => {
      series = next
    },
    observationCalls: () => observationCalls,
    seriesCalls: () => seriesCalls,
    refusals: () =>
      entries
        .filter((entry) => entry.type === 'economic.refusal.recorded')
        .map((entry) => String(entry.payload.code)),
    changes: () => changes,
  }
}

/** A wake whose source and kind are kept in agreement, because a mismatch is refused. */
export function wake(overrides: {
  readonly source?: EconomicWakeSource
  readonly kind?: EconomicWakeKind
  readonly actor?: EconomicWakeActor
  readonly experimentId?: string | null
  readonly goalRef?: string | null
  readonly sourceRef?: string | null
  readonly occurredAt?: string
} = {}) {
  const source = overrides.source ?? 'experiment-transition'
  const kind = overrides.kind ?? ('experiment-transitioned' as EconomicWakeKind)
  return {
    source,
    kind,
    actor: overrides.actor ?? ('core-subsystem' as EconomicWakeActor),
    experimentId: overrides.experimentId === undefined ? 'exp-1' : overrides.experimentId,
    goalRef: overrides.goalRef === undefined ? null : overrides.goalRef,
    sourceRef: overrides.sourceRef === undefined ? 'exp-1' : overrides.sourceRef,
    occurredAt: overrides.occurredAt ?? T0,
  }
}

/** An experiment draft whose criteria are slugs, as the domain requires. */
export function experimentDraft(overrides: {
  readonly experimentId?: string
  readonly kind?: EconomicExperimentKind
  readonly title?: string
  readonly question?: string
  readonly completionCriteria?: readonly string[]
  readonly createdAt?: string
  readonly deadlineAt?: string | null
} = {}) {
  return {
    experimentId: overrides.experimentId ?? 'exp-1',
    kind: overrides.kind ?? ('research' as EconomicExperimentKind),
    title: overrides.title ?? 'Is there a market for a very small widget?',
    question: overrides.question ?? 'Would anyone pay for this at all?',
    completionCriteria: overrides.completionCriteria ?? ['peer-reviewed-demand', 'competitor-pricing'],
    createdAt: overrides.createdAt ?? T0,
    deadlineAt: overrides.deadlineAt === undefined ? null : overrides.deadlineAt,
  }
}

/** An observation, with the fields the admission table checks. */
export function observation(overrides: Partial<EvidenceObservation> & { readonly claim: string }): EvidenceObservation {
  return {
    evidenceId: overrides.evidenceId ?? 'ev-1',
    source: overrides.source ?? 'published-study',
    sourceRef: overrides.sourceRef ?? 'filing-2026-01',
    citation: overrides.citation ?? 'A published study, 2026',
    observedAt: overrides.observedAt ?? T0,
    ...overrides,
  }
}

/**
 * A price series with the given closes.
 *
 * Built from literals with an hourly step so "the same inputs" is literally true: no
 * rounding, no interpolation, and `t(n)` is a pure function of `n`.
 */
export function series(closes: readonly number[], from = T0, stepMs = 3_600_000): readonly PricePoint[] {
  return closes.map((close, index) => ({
    at: new Date(Date.parse(from) + index * stepMs).toISOString(),
    close,
  }))
}

/** The stages, for exhaustion tests written as data. */
export const STAGES: readonly EconomicStage[] = ECONOMIC_LIMITS
  ? (['IDLE', 'RESEARCHING', 'SIMULATING', 'PAPER_TRADING', 'ANALYZING', 'COMPLETE', 'FAILED'] as const)
  : []

export { ECONOMIC_LIMITS, narrowEconomicLimits }
export type { EconomicLimits }