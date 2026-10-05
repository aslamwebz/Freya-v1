/**
 * RELAY STATE — the fold of the durable `relay.*` events.
 *
 * Same rule as every other subsystem: there is no mutable state that is not
 * the journal's image. Action records, approvals, idempotency keys and budget
 * instants are all *derived* from events, which is what makes replay
 * protection and rate limits survive a restart without a second store.
 *
 * ## What is not here
 *
 * No message body, no event title, no issue text, no repo content. The fold
 * holds ids, closed labels, counts, instants and measured lengths — the same
 * bargain every other subsystem makes with the journal. Content crosses back
 * to a caller only through the bounded result of the command that asked.
 *
 * ## Bounded
 *
 * Every list is capped. A fold that grew with every action would be a memory
 * leak shaped like an audit trail, and — worse — the budget instants that
 * enforce the send cap would eventually be evicted by the noise of reads,
 * quietly widening the cap they exist to hold.
 */

import type { AnyCoreEvent } from '../events/envelope'
import {
  RELAY_LIMITS,
  initialRelayState,
  type RelayActionRecord,
  type RelayActionStatus,
  type RelayApprovalRecord,
  type RelayConnectorId,
  type RelayState,
} from './types'

function pushBounded<T>(list: readonly T[], value: T, max: number): readonly T[] {
  const next = [...list, value]
  return next.length > max ? next.slice(next.length - max) : next
}

function pushInstant(list: readonly string[], at: string, max: number): readonly string[] {
  return pushBounded(list, at, max)
}

/** The most recent instants within the rolling window, oldest first. */
export function instantsInWindow(list: readonly string[], now: number, windowMs: number): readonly string[] {
  const cutoff = now - windowMs
  return list.filter((at) => {
    const ms = Date.parse(at)
    return Number.isFinite(ms) && ms >= cutoff
  })
}

/** Count actions a connector performed in the rolling window. */
export function connectorActionsInWindow(state: RelayState, connector: RelayConnectorId, now: number): number {
  return instantsInWindow(state.actionInstants[connector] ?? [], now, RELAY_LIMITS.budgetWindowMs).length
}

/** Count sends in the rolling window. */
export function sendsInWindow(state: RelayState, now: number): number {
  return instantsInWindow(state.sendInstants, now, RELAY_LIMITS.budgetWindowMs).length
}

/** Count drafts in the rolling window. */
export function draftsInWindow(state: RelayState, now: number): number {
  return instantsInWindow(state.draftInstants, now, RELAY_LIMITS.budgetWindowMs).length
}

/** Count Telegram sends in the rolling window. */
export function telegramSendsInWindow(state: RelayState, now: number): number {
  return instantsInWindow(state.telegramSendInstants, now, RELAY_LIMITS.budgetWindowMs).length
}

/** Count external invocations in the rolling window. */
export function externalInvokesInWindow(state: RelayState, now: number): number {
  return instantsInWindow(state.externalInstants, now, RELAY_LIMITS.budgetWindowMs).length
}

/** The action record for an idempotency key, if the fold still holds it. */
export function findByIdempotencyKey(state: RelayState, key: string): RelayActionRecord | undefined {
  return state.actions.find((action) => action.idempotencyKey === key)
}

/** The approval record for an id, if the fold holds it. */
export function findApproval(state: RelayState, approvalId: string): RelayApprovalRecord | undefined {
  return state.approvals.find((approval) => approval.approvalId === approvalId)
}

/** Pending approvals, oldest first. */
export function pendingApprovals(state: RelayState): readonly RelayApprovalRecord[] {
  return state.approvals.filter((approval) => approval.status === 'pending')
}

/**
 * Fold one durable event into Relay state.
 *
 * Only `relay.*` events change it; everything else returns the same object,
 * so this can be called for every event in the log without cost.
 */
export function reduceRelay(state: RelayState, event: AnyCoreEvent): RelayState {
  switch (event.type) {
    case 'relay.action.requested': {
      const record: RelayActionRecord = {
        actionId: event.payload.actionId,
        connector: event.payload.connector,
        action: event.payload.action,
        risk: event.payload.risk,
        status: 'pending_approval',
        idempotencyKey: event.payload.idempotencyKey ?? null,
        summary: event.payload.summary,
        failureCode: null,
        retries: 0,
        requestedAt: event.occurredAt,
        decidedAt: null,
        settledAt: null,
      }
      const without = state.actions.filter((action) => action.actionId !== record.actionId)
      return {
        ...state,
        actions: pushBounded(without, record, RELAY_LIMITS.maxIdempotencyKeys),
        actionInstants: {
          ...state.actionInstants,
          [record.connector]: pushInstant(
            state.actionInstants[record.connector] ?? [],
            event.occurredAt,
            RELAY_LIMITS.maxActionsPerConnectorPerWindow * 4,
          ),
        },
      }
    }

    case 'relay.approval.requested': {
      const record: RelayApprovalRecord = {
        approvalId: event.payload.approvalId,
        actionId: event.payload.actionId,
        connector: event.payload.connector,
        action: event.payload.action,
        risk: event.payload.risk,
        summary: event.payload.summary,
        status: 'pending',
        requestedAt: event.occurredAt,
        decidedAt: null,
      }
      const without = state.approvals.filter((approval) => approval.approvalId !== record.approvalId)
      return { ...state, approvals: pushBounded(without, record, RELAY_LIMITS.maxPendingApprovals * 4) }
    }

    case 'relay.approval.decided': {
      const decidedAt = event.occurredAt
      const decision = event.payload.decision
      const approvals = state.approvals.map((approval) =>
        approval.approvalId === event.payload.approvalId
          ? { ...approval, status: decision, decidedAt }
          : approval,
      )
      const status: RelayActionStatus = decision === 'approved' ? 'approved' : 'denied'
      const actions = state.actions.map((action) =>
        action.actionId === event.payload.actionId
          ? { ...action, status, decidedAt, settledAt: status === 'denied' ? decidedAt : action.settledAt }
          : action,
      )
      return { ...state, approvals, actions }
    }

    case 'relay.approval.expired': {
      const decidedAt = event.occurredAt
      const approvals = state.approvals.map((approval) =>
        approval.approvalId === event.payload.approvalId
          ? { ...approval, status: 'expired' as const, decidedAt }
          : approval,
      )
      return { ...state, approvals }
    }

    case 'relay.action.executed': {
      const settledAt = event.occurredAt
      const actions = state.actions.map((action) =>
        action.actionId === event.payload.actionId
          ? { ...action, status: 'completed' as const, settledAt, retries: event.payload.retries }
          : action,
      )
      // A read counts toward the per-connector budget too: a read storm is
      // still a storm, and the connector's rate limit applies to every call.
      const connector = event.payload.connector
      const actionInstants = {
        ...state.actionInstants,
        [connector]: pushInstant(
          state.actionInstants[connector] ?? [],
          settledAt,
          RELAY_LIMITS.maxActionsPerConnectorPerWindow * 4,
        ),
      }
      let sendInstants = state.sendInstants
      let draftInstants = state.draftInstants
      let telegramSendInstants = state.telegramSendInstants
      let externalInstants = state.externalInstants
      if (event.payload.action === 'email.send') {
        sendInstants = pushInstant(sendInstants, settledAt, RELAY_LIMITS.maxSendsPerWindow * 4)
      }
      if (event.payload.action === 'email.draft.create') {
        draftInstants = pushInstant(draftInstants, settledAt, RELAY_LIMITS.maxDraftsPerWindow * 4)
      }
      if (event.payload.action === 'telegram.send') {
        telegramSendInstants = pushInstant(telegramSendInstants, settledAt, RELAY_LIMITS.maxTelegramSendsPerWindow * 4)
      }
      if (event.payload.action === 'external.invoke') {
        externalInstants = pushInstant(externalInstants, settledAt, RELAY_LIMITS.maxExternalInvokesPerWindow * 4)
      }
      return { ...state, actions, actionInstants, sendInstants, draftInstants, telegramSendInstants, externalInstants }
    }

    case 'relay.action.failed': {
      const settledAt = event.occurredAt
      const actions = state.actions.map((action) =>
        action.actionId === event.payload.actionId
          ? {
              ...action,
              status: 'failed' as const,
              settledAt,
              failureCode: event.payload.failureCode,
              retries: event.payload.retries,
            }
          : action,
      )
      return { ...state, actions }
    }

    case 'relay.action.cancelled': {
      const settledAt = event.occurredAt
      const actions = state.actions.map((action) =>
        action.actionId === event.payload.actionId
          ? { ...action, status: 'cancelled' as const, settledAt, failureCode: event.payload.failureCode }
          : action,
      )
      return { ...state, actions }
    }

    case 'relay.connector.faulted': {
      return { ...state, faulted: { ...state.faulted, [event.payload.connector]: event.payload.reason } }
    }

    default:
      return state
  }
}

export { initialRelayState }
export type { RelayState } from './types'
