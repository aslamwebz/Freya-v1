import {
  type BoundedAction,
  type SovereigntyAssertionVerdict,
  type SovereigntyLimits,
  type SovereigntyState,
} from './types'
import type { SovereigntyFoldedState } from './state'
import type { SovereigntySnapshot } from './runtime'

export const SOVEREIGNTY_SCHEMA_VERSION = 1

export const NO_REAL_MONEY =
  'Sovereign Intelligence performs no real-money actions, no real spending and no real financial transactions.'

export const PROJECTED_SOVEREIGNTY_ACTION_KINDS = [
  'reason',
  'route',
  'fallback',
  'export',
  'import',
  'verify',
  'wait',
  'escalate',
  'stop',
] as const

export type ProjectedSovereigntyActionKind = (typeof PROJECTED_SOVEREIGNTY_ACTION_KINDS)[number]

export const PROJECTED_SOVEREIGNTY_KIND_ORDER: Readonly<Record<ProjectedSovereigntyActionKind, number>> =
  Object.freeze({
    reason: 0,
    route: 1,
    fallback: 2,
    export: 3,
    import: 4,
    verify: 5,
    wait: 6,
    escalate: 7,
    stop: 8,
  })

export interface SovereigntyProjectionInput {
  readonly state: SovereigntyFoldedState
  readonly snapshot: SovereigntySnapshot
  readonly now: string
  readonly sequence: number
}

export interface SovereigntyCountersView {
  readonly providers: number
  readonly routingDecisions: number
  readonly offlineSessions: number
  readonly portableDataRecords: number
  readonly refusals: number
}

export interface SovereigntyProviderView {
  readonly providerId: string
  readonly name: string
  readonly status: string
  readonly priority: number
  readonly isLocal: boolean
  readonly isOfflineCapable: boolean
}

export interface SovereigntyRoutingView {
  readonly decisionId: string
  readonly providerId: string
  readonly reason: string
  readonly routedAt: string
}

export interface SovereigntyOfflineSessionView {
  readonly sessionId: string
  readonly mode: string
  readonly startedAt: string
  readonly endedAt: string | null
  readonly reasoningCount: number
}

export interface SovereigntyPortableDataView {
  readonly recordId: string
  readonly operation: string
  readonly status: string
  readonly dataHash: string
  readonly encryptionVersion: string
  readonly createdAt: string
  readonly completedAt: string | null
}

export interface SovereigntyRedTeamView {
  readonly refusedAttempts: number
  readonly recentRefusals: readonly string[]
}

export interface SovereigntySummaryView {
  readonly currentState: SovereigntyState
  readonly health: 'online' | 'offline' | 'porting' | 'degraded' | 'failed'
  readonly reason: string | null
  readonly activeProvider: SovereigntyProviderView | null
  readonly offlineMode: string
  readonly portableDataStatus: SovereigntyPortableDataView | null
  readonly recentDecisions: readonly SovereigntyRoutingView[]
  readonly nextBoundedAction: BoundedAction | null
  readonly counters: SovereigntyCountersView
  readonly redTeam: SovereigntyRedTeamView
  readonly lastRefusal: { readonly code: string; readonly at: string } | null
  readonly requiresOwnerAction: boolean
  readonly assertions: SovereigntyAssertionVerdict | null
  readonly limits: SovereigntyLimits
  readonly narrowedLimits: readonly string[]
  readonly realMoney: string
}

export interface SovereigntyProjection {
  readonly health: 'online' | 'offline' | 'porting' | 'degraded' | 'failed'
  readonly reason: string | null
  readonly schemaVersion: number
  readonly sequence: number
  readonly generatedAt: string
  readonly summary: SovereigntySummaryView
}

export function projectSovereigntyState(input: SovereigntyProjectionInput): SovereigntyProjection {
  const { state, snapshot, now } = input
  const { limits } = snapshot

  const activeProvider = state.providers.find((p) => p.status === 'healthy') ?? null

  const activeOfflineSession = state.offlineSessions.find((s) => s.endedAt === null) ?? null

  const recentDecisions = state.routingDecisions.slice(-16)

  const nextAction = nextBoundedAction(state, snapshot, now, limits)

  const health = snapshot.status.stopAllLatched
    ? 'failed'
    : state.currentState === 'ONLINE'
      ? 'online'
      : state.currentState === 'OFFLINE'
        ? 'offline'
        : state.currentState === 'PORTING'
          ? 'porting'
          : state.currentState === 'DEGRADED'
            ? 'degraded'
            : 'failed'

  const reason = snapshot.status.stopAllLatched
    ? 'Freya is stopped, so sovereignty is holding rather than working'
    : state.currentState === 'ONLINE'
      ? null
      : state.currentState === 'OFFLINE'
        ? 'Freya is operating in offline mode'
        : state.currentState === 'PORTING'
          ? 'Data export/import is in progress'
          : state.currentState === 'DEGRADED'
            ? 'Freya is operating in degraded mode'
            : 'Freya has failed and requires owner action'

  return {
    health,
    reason,
    schemaVersion: SOVEREIGNTY_SCHEMA_VERSION,
    sequence: input.sequence,
    generatedAt: now,
    summary: {
      currentState: state.currentState,
      health,
      reason,
      activeProvider: activeProvider
        ? {
            providerId: activeProvider.providerId,
            name: activeProvider.name,
            status: activeProvider.status,
            priority: activeProvider.priority,
            isLocal: activeProvider.isLocal,
            isOfflineCapable: activeProvider.isOfflineCapable,
          }
        : null,
      offlineMode: activeOfflineSession?.mode ?? 'none',
      portableDataStatus: state.portableDataRecords[0]
        ? {
            recordId: state.portableDataRecords[0].recordId,
            operation: state.portableDataRecords[0].operation,
            status: state.portableDataRecords[0].status,
            dataHash: state.portableDataRecords[0].dataHash,
            encryptionVersion: state.portableDataRecords[0].encryptionVersion,
            createdAt: state.portableDataRecords[0].createdAt,
            completedAt: state.portableDataRecords[0].completedAt,
          }
        : null,
      recentDecisions: recentDecisions.map((d) => ({
        decisionId: d.decisionId,
        providerId: d.providerId,
        reason: d.reason,
        routedAt: d.routedAt,
      })),
      nextBoundedAction: nextAction,
      counters: {
        providers: state.providers.length,
        routingDecisions: state.routingDecisions.length,
        offlineSessions: state.offlineSessions.length,
        portableDataRecords: state.portableDataRecords.length,
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
      requiresOwnerAction: snapshot.status.stopAllLatched,
      assertions: snapshot.assertions?.checks ?? null,
      limits,
      narrowedLimits: snapshot.narrowedLimits,
      realMoney: NO_REAL_MONEY,
    },
  }
}

function nextBoundedAction(
  state: SovereigntyFoldedState,
  snapshot: SovereigntySnapshot,
  now: string,
  limits: SovereigntyLimits,
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

  if (state.currentState === 'OFFLINE') {
    const active = state.offlineSessions.find((s) => s.endedAt === null)
    if (active) {
      return {
        actionId: `action-offline-${active.sessionId}`,
        kind: 'reason',
        target: active.sessionId,
        deadlineAt: now,
        maxAttempts: limits.maxRetryCeiling,
        reasoning: ['Offline reasoning is in progress.'],
      }
    }
  }

  if (state.currentState === 'PORTING') {
    return {
      actionId: 'action-verify',
      kind: 'verify',
      target: 'portable-data',
      deadlineAt: now,
      maxAttempts: 1,
      reasoning: ['Data export/import is in progress. The next bounded action is to verify completion.'],
    }
  }

  if (state.currentState === 'DEGRADED') {
    return {
      actionId: 'action-fallback',
      kind: 'fallback',
      target: 'provider',
      deadlineAt: now,
      maxAttempts: limits.maxRetryCeiling,
      reasoning: ['Freya is in degraded mode. The next bounded action is to attempt fallback.'],
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
