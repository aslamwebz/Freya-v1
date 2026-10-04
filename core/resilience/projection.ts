import {
  type BoundedAction,
  type ResilienceAssertionVerdict,
  type ResilienceLimits,
  type ResilienceState,
} from './types'
import type { ResilienceFoldedState } from './state'
import type { CrashRecoveryReport } from './recovery'
import type { ResilienceSnapshot } from './runtime'

/**
 * The explainable resilience state.
 *
 * A pure function of the folded state, the snapshot and the clock.
 */

export const RESILIENCE_SCHEMA_VERSION = 1

/**
 * The no-real-money statement.
 */
export const NO_REAL_MONEY =
  'Resilience & Self-Recovery performs no real-money actions, no real spending and no real financial transactions.'

/**
 * The projected action kinds.
 */
export const PROJECTED_ACTION_KINDS = [
  'recover',
  'repair',
  'backup',
  'restore',
  'verify',
  'wait',
  'escalate',
  'stop',
] as const

export type ProjectedActionKind = (typeof PROJECTED_ACTION_KINDS)[number]

/**
 * The projected kind order.
 */
export const PROJECTED_KIND_ORDER: Readonly<Record<ProjectedActionKind, number>> = Object.freeze({
  recover: 0,
  repair: 1,
  backup: 2,
  restore: 3,
  verify: 4,
  wait: 5,
  escalate: 6,
  stop: 7,
})

export interface ResilienceProjectionInput {
  readonly state: ResilienceFoldedState
  readonly snapshot: ResilienceSnapshot
  readonly now: string
  readonly sequence: number
}

export interface ResilienceCountersView {
  readonly failures: number
  readonly recoveries: number
  readonly repairs: number
  readonly backups: number
  readonly restores: number
  readonly degradedModeEntries: number
  readonly refusals: number
}

export interface ResilienceFailureView {
  readonly failureId: string
  readonly kind: string
  readonly detectedAt: string
  readonly recoverable: boolean
}

export interface ResilienceRecoveryView {
  readonly recoveryId: string
  readonly failureId: string
  readonly outcome: string | null
  readonly reason: string
  readonly progress: number
}

export interface ResilienceRepairView {
  readonly repairId: string
  readonly failureId: string
  readonly outcome: string | null
  readonly reason: string
  readonly progress: number
}

export interface ResilienceDegradedModeView {
  readonly recordId: string
  readonly level: string
  readonly reason: string
  readonly capabilities: readonly string[]
  readonly startedAt: string
  readonly endedAt: string | null
}

export interface ResilienceRedTeamView {
  readonly refusedAttempts: number
  readonly recentRefusals: readonly string[]
}

export interface ResilienceSummaryView {
  readonly currentState: ResilienceState
  readonly health: 'healthy' | 'degraded' | 'recovering' | 'repairing' | 'failed'
  readonly reason: string | null
  readonly activeRecoveries: readonly ResilienceRecoveryView[]
  readonly activeRepairs: readonly ResilienceRepairView[]
  readonly degradedMode: ResilienceDegradedModeView | null
  readonly recentFailures: readonly ResilienceFailureView[]
  readonly nextBoundedAction: BoundedAction | null
  readonly counters: ResilienceCountersView
  readonly redTeam: ResilienceRedTeamView
  readonly lastRefusal: { readonly code: string; readonly at: string } | null
  readonly recovery: string | null
  readonly requiresOwnerAction: boolean
  readonly assertions: ResilienceAssertionVerdict | null
  readonly limits: ResilienceLimits
  readonly narrowedLimits: readonly string[]
  readonly realMoney: string
}

export interface ResilienceProjection {
  readonly health: 'healthy' | 'degraded' | 'recovering' | 'repairing' | 'failed'
  readonly reason: string | null
  readonly schemaVersion: number
  readonly sequence: number
  readonly generatedAt: string
  readonly summary: ResilienceSummaryView
}

/**
 * Project the resilience state.
 */
export function projectResilienceState(input: ResilienceProjectionInput): ResilienceProjection {
  const { state, snapshot, now } = input
  const { limits } = snapshot

  const activeRecoveries = state.recoveries
    .filter((r) => r.outcome === null)
    .slice(0, limits.maxConcurrentRecoveries)
    .map((r) => ({
      recoveryId: r.recoveryId,
      failureId: r.failureId,
      outcome: r.outcome,
      reason: r.reason,
      progress: r.progress,
    }))

  const activeRepairs = state.repairs
    .filter((r) => r.outcome === null)
    .slice(0, limits.maxConcurrentRepairs)
    .map((r) => ({
      repairId: r.repairId,
      failureId: r.failureId,
      outcome: r.outcome,
      reason: r.reason,
      progress: r.progress,
    }))

  const degradedMode = state.degradedModes.find((d) => d.endedAt === null) ?? null

  const recentFailures = state.failures
    .slice(-32)
    .map((f) => ({
      failureId: f.failureId,
      kind: f.kind,
      detectedAt: f.detectedAt,
      recoverable: f.recoverable,
    }))

  const nextAction = nextBoundedAction(state, snapshot, now, limits)

  const health = snapshot.status.stopAllLatched
    ? 'failed'
    : state.currentState === 'HEALTHY'
      ? 'healthy'
      : state.currentState === 'DEGRADED'
        ? 'degraded'
        : state.currentState === 'RECOVERING'
          ? 'recovering'
          : state.currentState === 'REPAIRING'
            ? 'repairing'
            : 'failed'

  const reason = snapshot.status.stopAllLatched
    ? 'Freya is stopped, so resilience is holding rather than working'
    : state.currentState === 'HEALTHY'
      ? null
      : state.currentState === 'DEGRADED'
        ? 'Freya is operating in degraded mode'
        : state.currentState === 'RECOVERING'
          ? 'Recovery is in progress'
          : state.currentState === 'REPAIRING'
            ? 'Repair is in progress'
            : 'Freya has failed and requires owner action'

  return {
    health,
    reason,
    schemaVersion: RESILIENCE_SCHEMA_VERSION,
    sequence: input.sequence,
    generatedAt: now,
    summary: {
      currentState: state.currentState,
      health,
      reason,
      activeRecoveries,
      activeRepairs,
      degradedMode: degradedMode
        ? {
            recordId: degradedMode.recordId,
            level: degradedMode.level,
            reason: degradedMode.reason,
            capabilities: degradedMode.capabilities,
            startedAt: degradedMode.startedAt,
            endedAt: degradedMode.endedAt,
          }
        : null,
      recentFailures,
      nextBoundedAction: nextAction,
      counters: {
        failures: state.failures.length,
        recoveries: state.recoveries.length,
        repairs: state.repairs.length,
        backups: state.backups.length,
        restores: state.restores.length,
        degradedModeEntries: state.degradedModes.length,
        refusals: state.refusals.length,
      },
      redTeam: {
        refusedAttempts: state.refusals.length,
        recentRefusals: state.refusals.slice(-32).map((r) => r.code),
      },
      lastRefusal:
        state.lastRefusalCode === null
          ? null
          : { code: state.lastRefusalCode, at: state.lastRefusalAt ?? '' },
      recovery: snapshot.recovery ? describeRecovery(snapshot.recovery) : null,
      requiresOwnerAction: snapshot.recovery?.requiresOwnerAction === true,
      assertions: snapshot.assertions?.checks ?? null,
      limits,
      narrowedLimits: snapshot.narrowedLimits,
      realMoney: NO_REAL_MONEY,
    },
  }
}

/**
 * Compute the next bounded action.
 */
function nextBoundedAction(
  state: ResilienceFoldedState,
  snapshot: ResilienceSnapshot,
  now: string,
  limits: ResilienceLimits,
): BoundedAction | null {
  if (snapshot.status.stopAllLatched) {
    return {
      actionId: 'action-stop',
      kind: 'stop',
      target: 'all',
      deadlineAt: now,
      maxAttempts: 0,
      reasoning: ['Freya is stopped. No action is possible until the owner clears the latch.'],
    }
  }

  if (state.currentState === 'RECOVERING') {
    const active = state.recoveries.find((r) => r.outcome === null)
    if (active) {
      return {
        actionId: `action-recover-${active.recoveryId}`,
        kind: 'recover',
        target: active.failureId,
        deadlineAt: now,
        maxAttempts: limits.maxRecoveryAttempts,
        reasoning: ['Recovery is in progress. The next bounded action is to continue recovery.'],
      }
    }
  }

  if (state.currentState === 'REPAIRING') {
    const active = state.repairs.find((r) => r.outcome === null)
    if (active) {
      return {
        actionId: `action-repair-${active.repairId}`,
        kind: 'repair',
        target: active.failureId,
        deadlineAt: now,
        maxAttempts: limits.maxRepairAttempts,
        reasoning: ['Repair is in progress. The next bounded action is to continue repair.'],
      }
    }
  }

  if (state.currentState === 'DEGRADED') {
    return {
      actionId: 'action-verify',
      kind: 'verify',
      target: 'degraded-mode',
      deadlineAt: now,
      maxAttempts: 1,
      reasoning: ['Freya is in degraded mode. The next bounded action is to verify the degradation is resolved.'],
    }
  }

  if (state.currentState === 'FAILED') {
    return {
      actionId: 'action-escalate',
      kind: 'escalate',
      target: 'owner',
      deadlineAt: now,
      maxAttempts: 1,
      reasoning: ['Freya has failed. The next bounded action is to escalate to the owner.'],
    }
  }

  return null
}

/**
 * Describe a recovery report.
 */
function describeRecovery(report: CrashRecoveryReport): string | null {
  if (!report.reconciled) return null
  if (report.stopAllActive) return 'Freya was stopped when the process ended.'
  const count = report.actions.length
  if (count === 0) return null
  return `${count} recovery action${count === 1 ? ' was' : 's were'} taken; nothing continues without an explicit wake.`
}
