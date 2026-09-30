import type { AnyCoreEvent } from './events/envelope'
import { emptyGrantUsage, type CognitionGrant, type CognitionGrantUsage } from './cognition/grants'
import { accumulateAttempt, accumulateReported, accumulateUsage, emptyUsage } from './model/usage'
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
    durableUsage: emptyUsage(),
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

    // Authorisation: one call spent, and this call's share of the allowance
    // taken off the budget. Both accumulate, and neither is ever refunded.
    case 'cognition.grant.reserved':
      return {
        ...state,
        grants: state.grants.map((grant) =>
          grant.id === event.payload.grantId
            ? {
                ...grant,
                usage: {
                  ...grant.usage,
                  calls: grant.usage.calls + 1,
                  outputTokenBudgetReserved:
                    grant.usage.outputTokenBudgetReserved + event.payload.outputTokenBudgetReserved,
                },
              }
            : grant,
        ),
      }

    // Reporting: what one provider said it used, added to the running total. An
    // unreported call adds nothing and is counted as unknown, so the figures
    // below are a lower bound rather than a total that quietly assumed zero.
    case 'cognition.grant.usage_reported':
      return {
        ...state,
        grants: state.grants.map((grant) =>
          grant.id === event.payload.grantId
            ? {
                ...grant,
                usage: accumulateReported(grant.usage, {
                  inputTokens: event.payload.inputTokens,
                  outputTokens: event.payload.outputTokens,
                }),
              }
            : grant,
        ),
      }

    // An attempt is counted when it is made: `model.request.started` is the only
    // record that a provider was ever reached, so it is the honest place for the
    // call count. It contributes no token figures and records no gap in
    // reporting, because the matching `completed` event carries both.
    case 'model.request.started':
      return { ...state, durableUsage: accumulateAttempt(state.durableUsage) }

    // Reported usage is added to the running total. A call that reported nothing
    // increments `unknownUsageCalls` instead of contributing a zero, so the
    // totals are a declared lower bound rather than a false exact figure.
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


export type { CognitionGrantUsage }
