import type { AnyCoreEvent } from './events/envelope'
import { emptyGrantUsage, type CognitionGrant, type CognitionGrantUsage } from './cognition/grants'
import type { ModelUsage, PrincipalId } from './protocol/core-protocol'

/**
 * Everything Core knows, derived from durable events.
 *
 * One pure reducer serves both replay and live operation: replay folds history,
 * and the fabric publishes each newly appended event to the same reducer. There
 * is no second code path that could drift from the log.
 *
 * Nothing here is authoritative on its own. Delete the log and this state is
 * gone — which is the point: there is no in-memory truth that outlives the
 * durable record of it.
 */

export interface StopAllState {
  active: boolean
  activatedAt: string | null
  activatedBy: PrincipalId | null
}

export interface CoreState {
  stopAll: StopAllState
  grants: CognitionGrant[]
  /** Totals recovered from the log, independent of the live gateway. */
  durableUsage: ModelUsage
  /** User commands Core has received. */
  commandCount: number
  /** Metadata about the last command. Never its content: that is not here. */
  lastCommand: { commandId: string; contentLength: number; at: string } | null
  faults: string[]
}

export function initialCoreState(): CoreState {
  return {
    stopAll: { active: false, activatedAt: null, activatedBy: null },
    grants: [],
    durableUsage: { calls: 0, inputTokens: null, outputTokens: null },
    commandCount: 0,
    lastCommand: null,
    faults: [],
  }
}

export function isStopAllActive(state: CoreState): boolean {
  return state.stopAll.active
}

export function activeGrants(state: CoreState, now: Date): CognitionGrant[] {
  return state.grants.filter(
    (grant) => grant.revokedAt === null && new Date(grant.expiresAt).getTime() > now.getTime(),
  )
}

export function findGrant(state: CoreState, id: string): CognitionGrant | undefined {
  return state.grants.find((grant) => grant.id === id)
}

export function reduceCoreState(state: CoreState, event: AnyCoreEvent): CoreState {
  switch (event.type) {
    case 'security.stop_all.activated':
      return {
        ...state,
        stopAll: {
          active: true,
          activatedAt: event.occurredAt,
          activatedBy: event.payload.by,
        },
      }

    case 'security.stop_all.cleared':
      return {
        ...state,
        stopAll: { active: false, activatedAt: null, activatedBy: null },
      }

    case 'command.received':
      return {
        ...state,
        commandCount: state.commandCount + 1,
        lastCommand: {
          commandId: event.payload.commandId,
          contentLength: event.payload.contentLength,
          at: event.occurredAt,
        },
      }

    case 'cognition.grant.created':
      return { ...state, grants: [...state.grants, grantFromEvent(event)] }

    case 'cognition.grant.revoked':
      return {
        ...state,
        grants: state.grants.map((grant) =>
          grant.id === event.payload.grantId
            ? { ...grant, revokedAt: event.occurredAt, revokedBy: event.payload.revokedBy }
            : grant,
        ),
      }

    case 'cognition.grant.consumed':
      return {
        ...state,
        grants: state.grants.map((grant) =>
          grant.id === event.payload.grantId
            ? {
                ...grant,
                usage: {
                  calls: event.payload.callsUsed,
                  outputTokenBudgetReserved: event.payload.outputTokenBudgetReserved,
                  inputTokens: event.payload.inputTokens,
                  outputTokens: event.payload.outputTokens,
                },
              }
            : grant,
        ),
      }

    case 'model.request.started':
      return {
        ...state,
        durableUsage: { ...state.durableUsage, calls: state.durableUsage.calls + 1 },
      }

    case 'model.request.completed':
      return {
        ...state,
        durableUsage: accumulateUsage(state.durableUsage, {
          inputTokens: event.payload.inputTokens,
          outputTokens: event.payload.outputTokens,
        }),
      }

    case 'core.degraded':
      return { ...state, faults: [...state.faults, event.payload.reason] }

    default:
      return state
  }
}

function grantFromEvent(
  event: Extract<AnyCoreEvent, { type: 'cognition.grant.created' }>,
): CognitionGrant {
  return {
    id: event.payload.grantId,
    createdBy: event.payload.createdBy,
    createdAt: event.occurredAt,
    expiresAt: event.payload.expiresAt,
    allowedOrigins: event.payload.allowedOrigins,
    allowedCauses: event.payload.allowedCauses,
    goalId: event.payload.goalId,
    runId: event.payload.runId,
    actor: event.payload.actor,
    backgroundAllowed: event.payload.backgroundAllowed,
    maxCalls: event.payload.maxCalls,
    maxOutputTokens: event.payload.maxOutputTokens,
    usage: emptyGrantUsage(),
    revokedAt: null,
    revokedBy: null,
    parentGrantId: null,
  }
}

function accumulateUsage(
  current: ModelUsage,
  next: { inputTokens: number | null; outputTokens: number | null },
): ModelUsage {
  return {
    calls: current.calls,
    inputTokens: add(current.inputTokens, next.inputTokens),
    outputTokens: add(current.outputTokens, next.outputTokens),
  }
}

/**
 * `null` means "the provider did not report this", which is not zero. Adding a
 * known number to unknown keeps it unknown rather than inventing a figure.
 */
function add(current: number | null, next: number | null): number | null {
  if (next === null) return current
  return (current ?? 0) + next
}

export type { CognitionGrantUsage }
