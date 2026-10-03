import type {
  FocusState,
  LifeLoopProgress,
  PendingSchedule,
  PreCognitionAuthority,
  WakeActor,
  WakeEvent,
  WakeKind,
  WakeSource,
} from '../../../core/lifeloop'

/**
 * Fixtures for the life-loop domain.
 *
 * Every time in here is a literal. Nothing calls `Date.now()`, so a test that
 * says "after the deadline" means exactly that and not "roughly a minute ago" on
 * a slow machine.
 */

export const T0 = '2026-03-01T09:00:00.000Z'
export const T_PLUS_1M = '2026-03-01T09:01:00.000Z'
export const T_PLUS_1H = '2026-03-01T10:00:00.000Z'
export const T_PLUS_16M = '2026-03-01T09:16:00.000Z'
export const T_PLUS_25H = '2026-03-02T10:00:00.000Z'
export const T_PLUS_31D = '2026-03-31T09:00:00.000Z'

export interface WakeOverrides {
  readonly wakeId?: string
  readonly source?: WakeSource
  readonly kind?: WakeKind
  readonly goalRef?: string | null
  readonly sourceRef?: string | null
  readonly occurredAt?: string
  readonly observedAt?: string
}

/**
 * A wake, with its source and kind kept in agreement by default.
 *
 * Getting the pair right matters: the registry refuses a mismatch, so a fixture
 * that let them drift would quietly turn every test into a refusal test.
 */
export function wake(overrides: WakeOverrides = {}): WakeEvent {
  const kind = overrides.kind ?? 'run-completed'
  const source = overrides.source ?? 'work-transition'
  return {
    wakeId: overrides.wakeId ?? 'wake-1',
    source,
    kind,
    goalRef: overrides.goalRef === undefined ? 'goal-1' : overrides.goalRef,
    sourceRef: overrides.sourceRef === undefined ? 'run-9' : overrides.sourceRef,
    occurredAt: overrides.occurredAt ?? T0,
    observedAt: overrides.observedAt ?? T0,
  }
}

/** A pre-authorized, unremarkable state: loop is waking, budget exists. */
export function progress(overrides: Partial<LifeLoopProgress> = {}): LifeLoopProgress {
  return {
    state: 'WAKING',
    iterationCount: 0,
    actionCount: 0,
    verificationCount: 0,
    cognitionRequestCount: 0,
    iterationStartedAt: T0,
    attemptCount: 0,
    pendingScheduleCount: 0,
    ...overrides,
  }
}

/** Authority that permits exactly as much as the filter needs and no more. */
export function authority(overrides: Partial<PreCognitionAuthority> = {}): PreCognitionAuthority {
  return {
    stopAllActive: false,
    journalTrustworthy: true,
    enabled: true,
    grantAvailable: true,
    budgetRemainingCalls: 8,
    cooldownUntil: null,
    focus: UNFOCUSED,
    requestedOutcome: 'do-nothing',
    ...overrides,
  }
}

/** The owner is not in the middle of anything, so escalation is permitted. */
export const UNFOCUSED: FocusState = Object.freeze({ focused: false, focusRef: null })

/** The owner is mid-task. Only `interrupt` is suppressed. */
export const FOCUSED: FocusState = Object.freeze({ focused: true, focusRef: 'window-1' })

export function schedule(overrides: Partial<PendingSchedule> = {}): PendingSchedule {
  return { scheduleId: overrides.scheduleId ?? 'sched-1', dueAt: overrides.dueAt ?? T0 }
}

export const OWNER: WakeActor = 'owner'
export const SUBSYSTEM: WakeActor = 'core-subsystem'
export const HEARTBEAT: WakeActor = 'host-heartbeat'