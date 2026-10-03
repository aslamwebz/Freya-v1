import {
  LIFE_LOOP_LIMITS,
  type ContinuationState,
  type DecideOutcome,
  type FocusState,
  type LifeLoopCognitionOutcome,
  type LifeLoopEventType,
  type LifeLoopJournalEntry,
  type LifeLoopLimits,
  type LifeLoopPorts,
  type LifeLoopVerificationOutcome,
  type PendingSchedule,
  type WakeActor,
  type WakeKind,
  type WakeSource,
} from '../../../core/lifeloop'
import { validateDurableEvent } from '../../../core/events/validate'

/**
 * A Core-free harness for the life-loop runtime.
 *
 * The point of this file is that **nothing in it can spend**. There is no provider,
 * no gateway and no grant store; `requestCognition` returns a scripted answer and
 * counts the calls. That is deliberate: a test that wanted to prove "a wake does not
 * imply a model call" cannot use a real Core, because a real Core could have spent
 * the money before the assertion ran.
 *
 * Every instant is a literal and every id is a counter, so "after the deadline"
 * means exactly that and two runs over the same script produce the same journal.
 */

export const T0 = '2026-03-01T09:00:00.000Z'
export const T_PLUS_30S = '2026-03-01T09:00:30.000Z'
export const T_PLUS_1M = '2026-03-01T09:01:00.000Z'
export const T_PLUS_1H = '2026-03-01T10:00:00.000Z'
export const T_PLUS_25H = '2026-03-02T10:00:00.000Z'

export const UNFOCUSED: FocusState = Object.freeze({ focused: false, focusRef: null })
export const FOCUSED: FocusState = Object.freeze({ focused: true, focusRef: 'window-1' })

/** One journal entry, as the fold and the validator would both see it. */
export interface HarnessEntry extends LifeLoopJournalEntry {
  readonly type: string
  readonly recordedAt: string
  readonly payload: Record<string, unknown>
}

export interface HarnessOptions {
  readonly clock?: string
  readonly stopAll?: boolean
  readonly journalTrustworthy?: boolean
  readonly enabled?: boolean
  readonly focus?: FocusState
  readonly schedules?: readonly PendingSchedule[]
  readonly conditionHolds?: (scheduleId: string) => boolean
  readonly grantAvailable?: boolean
  readonly budgetRemainingCalls?: number
  readonly openGoals?: readonly string[]
  readonly escalationApprovalRequired?: boolean
  readonly cognition?: (iteration: number) => LifeLoopCognitionOutcome
  readonly verification?: (reference: string, kind: string) => LifeLoopVerificationOutcome
  readonly limits?: Partial<Record<keyof LifeLoopLimits, number>>
}

export interface Harness {
  readonly ports: LifeLoopPorts
  readonly entries: readonly HarnessEntry[]
  /**
   * Pre-load the journal, as a previous process would have left it.
   *
   * Copied rather than aliased, so a test can replay one process's journal into a
   * second harness and then let both keep writing without them sharing state.
   */
  seed(entries: readonly HarnessEntry[]): void
  /** The journal as a *validated* Core journal, for a round-trip through the fold. */
  validate(): readonly string[]
  types(): readonly string[]
  setClock(instant: string): void
  setStopAll(active: boolean): void
  setFocus(focus: FocusState): void
  setSchedules(schedules: readonly PendingSchedule[]): void
  setJournalTrustworthy(trustworthy: boolean): void
  setEnabled(enabled: boolean): void
  setGrantAvailable(available: boolean): void
  setBudgetRemaining(calls: number): void
  cognitionCalls(): number
  escalations(): readonly { readonly outcome: DecideOutcome; readonly escalation: string }[]
  verifications(): readonly { readonly kind: string; readonly reference: string }[]
  changes(): number
}

/**
 * Build the ports a runtime needs, and record everything it writes.
 *
 * The journal is a plain array rather than a file, and that is what lets the harness
 * assert the strongest property available here: **every payload the runtime writes
 * is accepted by the Core journal validator**. A payload that were not would reach
 * disk and be rejected on the next read, which truncates the log at that line — so a
 * mismatch is not a cosmetic test failure but a corrupted journal, and it is the one
 * failure mode that a runtime test can catch and a unit test cannot.
 */
export function harness(options: HarnessOptions = {}): Harness {
  const entries: HarnessEntry[] = []
  let clock = options.clock ?? T0
  let stopAll = options.stopAll ?? false
  let trustworthy = options.journalTrustworthy ?? true
  let enabled = options.enabled ?? true
  let focus = options.focus ?? UNFOCUSED
  let schedules = options.schedules ?? []
  let grantAvailable = options.grantAvailable ?? true
  let budget = options.budgetRemainingCalls ?? 8
  let ids = 0
  let cognitionCalls = 0
  let changes = 0
  const escalations: { outcome: DecideOutcome; escalation: string }[] = []
  const verifications: { kind: string; reference: string }[] = []

  const ports: LifeLoopPorts = {
    now: () => clock,
    newId: () => `h-${(ids += 1)}`,
    append: async (type: LifeLoopEventType, payload) => {
      entries.push({ type, recordedAt: clock, payload: { ...payload } })
    },
    replay: async () => entries,
    stopAllActive: () => stopAll,
    journalTrustworthy: () => trustworthy,
    enabled: () => enabled,
    schedules: () => schedules,
    conditionHolds: (scheduleId) =>
      options.conditionHolds?.(scheduleId) ??
      schedules.some((schedule) => schedule.scheduleId === scheduleId),
    focus: () => focus,
    grantAvailable: () => grantAvailable,
    budgetRemainingCalls: () => budget,
    requestCognition: async () => {
      cognitionCalls += 1
      return (
        options.cognition?.(cognitionCalls) ?? {
          status: 'decided' as const,
          outcome: 'do-nothing' as const,
          providerId: 'fake',
          model: 'fake-1',
        }
      )
    },
    verify: async (request) => {
      verifications.push({ kind: request.kind, reference: request.reference })
      return (
        options.verification?.(request.reference, request.kind) ?? {
          holds: true,
          code: 'reference-settled',
        }
      )
    },
    raiseEscalation: async (escalation) => {
      escalations.push({
        outcome: escalation.outcome,
        escalation: escalation.escalation,
      })
      return 'escalated' as const
    },
    goalOpen: (goalRef) => (options.openGoals ?? []).includes(goalRef),
    escalationApprovalRequired: () => options.escalationApprovalRequired ?? false,
    onChange: () => {
      changes += 1
    },
  }

  return {
    ports,
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
    setClock: (instant) => {
      clock = instant
    },
    setStopAll: (active) => {
      stopAll = active
    },
    setFocus: (next) => {
      focus = next
    },
    setSchedules: (next) => {
      schedules = next
    },
    setJournalTrustworthy: (next) => {
      trustworthy = next
    },
    setEnabled: (next) => {
      enabled = next
    },
    setGrantAvailable: (next) => {
      grantAvailable = next
    },
    setBudgetRemaining: (calls) => {
      budget = calls
    },
    cognitionCalls: () => cognitionCalls,
    escalations: () => escalations,
    verifications: () => verifications,
    changes: () => changes,
  }
}

/** A work-transition wake that justifies a thought, which is the interesting case. */
export function workWake(overrides: {
  readonly source?: WakeSource
  readonly kind?: WakeKind
  readonly actor?: WakeActor
  readonly goalRef?: string | null
  readonly sourceRef?: string | null
  readonly occurredAt?: string
} = {}) {
  return {
    source: overrides.source ?? 'work-transition',
    kind: overrides.kind ?? ('run-completed' as WakeKind),
    actor: overrides.actor ?? ('core-subsystem' as WakeActor),
    goalRef: overrides.goalRef === undefined ? 'goal-1' : overrides.goalRef,
    sourceRef: overrides.sourceRef === undefined ? 'run-9' : overrides.sourceRef,
    occurredAt: overrides.occurredAt ?? T0,
  }
}

/** A wake whose kind is *not* on its own a reason to spend. */
export function periodicWake(overrides: Parameters<typeof workWake>[0] = {}) {
  return workWake({
    source: 'scheduled-heartbeat',
    kind: 'periodic-check',
    actor: 'host-heartbeat',
    goalRef: null,
    sourceRef: 'sched-1',
    ...overrides,
  })
}

export function decided(outcome: DecideOutcome): LifeLoopCognitionOutcome {
  return { status: 'decided', outcome, providerId: 'fake', model: 'fake-1' }
}

export function refused(code = 'governor-refused'): LifeLoopCognitionOutcome {
  return { status: 'refused', code }
}

export { LIFE_LOOP_LIMITS }
export type { ContinuationState }