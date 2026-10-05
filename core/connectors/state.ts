/**
 * CONNECTOR STATE — the fold of the durable `connector.*` events.
 *
 * Same rule as every other subsystem: there is no mutable state that is not the
 * journal's image. Connection records, authorization requests, event metadata
 * and dedupe keys are all *derived* from events, which is what makes revocation
 * and replay protection survive a restart without a second store.
 *
 * ## What is not here
 *
 * No token, no client secret, no authorization header, no event payload. The
 * fold holds ids, closed labels, scope names, measured lengths and instants —
 * the same bargain every other subsystem makes with the journal. Event content
 * crosses to a consumer once, in the host call that delivered it, and is never
 * written down.
 */

import type { AnyCoreEvent } from '../events/envelope'
import { grantIsReadwrite } from './catalog'
import {
  CONNECTOR_LIMITS,
  initialConnectorState,
  type ConnectorConnectionRecord,
  type ConnectorEventRecord,
  type ConnectorKind,
  type ConnectorFold,
} from './types'

function pushBounded<T>(list: readonly T[], value: T, max: number): readonly T[] {
  const next = [...list, value]
  return next.length > max ? next.slice(next.length - max) : next
}

/** The connection record for a connector, if the fold holds one. */
export function findConnection(state: ConnectorFold, connector: ConnectorKind): ConnectorConnectionRecord | undefined {
  return state.connections.find((record) => record.connector === connector)
}

/** Whether a dedupe key has already been seen. */
export function isDuplicateEvent(state: ConnectorFold, dedupeKey: string): boolean {
  return state.dedupe.includes(dedupeKey)
}

function upsertConnection(
  state: ConnectorFold,
  connector: ConnectorKind,
  update: (existing: ConnectorConnectionRecord | undefined) => ConnectorConnectionRecord,
): ConnectorFold {
  const existing = findConnection(state, connector)
  const next = update(existing)
  const without = state.connections.filter((record) => record.connector !== connector)
  return { ...state, connections: pushBounded(without, next, CONNECTOR_LIMITS.maxConnectors) }
}

/**
 * Fold one durable event into connector state.
 *
 * Only `connector.*` events change it; everything else returns the same object,
 * so this can be called for every event in the log without cost.
 */
export function reduceConnector(state: ConnectorFold, event: AnyCoreEvent): ConnectorFold {
  switch (event.type) {
    case 'connector.connection.requested': {
      const connector = event.payload.connector
      const request = {
        requestId: event.payload.requestId,
        connector,
        status: 'pending' as const,
        requestedAt: event.occurredAt,
      }
      const withoutRequest = state.authRequests.filter((entry) => entry.requestId !== request.requestId)
      const withConnection = upsertConnection(state, connector, (existing) => ({
        connector,
        state: 'connecting',
        accountLabel: existing?.accountLabel ?? null,
        scopes: existing?.scopes ?? [],
        reason: null,
        failureCode: null,
        updatedAt: event.occurredAt,
        lastSuccessAt: existing?.lastSuccessAt ?? null,
        authorizedAt: existing?.authorizedAt ?? null,
        expiresAt: existing?.expiresAt ?? null,
      }))
      return {
        ...withConnection,
        authRequests: pushBounded(withoutRequest, request, CONNECTOR_LIMITS.maxPendingAuthRequests * 2),
      }
    }

    case 'connector.connection.authorized': {
      const connector = event.payload.connector
      const scopes = [...event.payload.scopes]
      const readwrite = grantIsReadwrite(connector, scopes)
      const withConnection = upsertConnection(state, connector, () => ({
        connector,
        state: readwrite ? 'connected-readwrite' : 'connected-readonly',
        accountLabel: event.payload.accountLabel,
        scopes,
        reason: null,
        failureCode: null,
        updatedAt: event.occurredAt,
        lastSuccessAt: event.occurredAt,
        authorizedAt: event.occurredAt,
        expiresAt: event.payload.expiresAt,
      }))
      const authRequests = withConnection.authRequests.map((entry) =>
        entry.connector === connector && entry.status === 'pending'
          ? { ...entry, status: 'completed' as const }
          : entry,
      )
      return { ...withConnection, authRequests }
    }

    case 'connector.connection.refreshed': {
      const connector = event.payload.connector
      return upsertConnection(state, connector, (existing) => ({
        connector,
        // A successful refresh restores a readable state; a connector with no
        // prior record is refreshed only after authorization, so readwrite is
        // the honest floor when scopes say so and readonly otherwise.
        state: existing !== undefined && grantIsReadwrite(connector, existing.scopes)
          ? 'connected-readwrite'
          : 'connected-readonly',
        accountLabel: existing?.accountLabel ?? null,
        scopes: existing?.scopes ?? [],
        reason: null,
        failureCode: null,
        updatedAt: event.occurredAt,
        lastSuccessAt: event.occurredAt,
        authorizedAt: existing?.authorizedAt ?? event.occurredAt,
        expiresAt: event.payload.expiresAt,
      }))
    }

    case 'connector.connection.degraded': {
      const connector = event.payload.connector
      return upsertConnection(state, connector, (existing) => ({
        connector,
        state: 'degraded',
        accountLabel: existing?.accountLabel ?? null,
        scopes: existing?.scopes ?? [],
        reason: event.payload.reason,
        failureCode: event.payload.failureCode,
        updatedAt: event.occurredAt,
        lastSuccessAt: existing?.lastSuccessAt ?? null,
        authorizedAt: existing?.authorizedAt ?? null,
        expiresAt: existing?.expiresAt ?? null,
      }))
    }

    case 'connector.connection.expired': {
      const connector = event.payload.connector
      return upsertConnection(state, connector, (existing) => ({
        connector,
        state: 'expired',
        accountLabel: existing?.accountLabel ?? null,
        scopes: existing?.scopes ?? [],
        reason: 'the authorization has expired',
        failureCode: 'expired',
        updatedAt: event.occurredAt,
        lastSuccessAt: existing?.lastSuccessAt ?? null,
        authorizedAt: existing?.authorizedAt ?? null,
        expiresAt: existing?.expiresAt ?? null,
      }))
    }

    case 'connector.connection.revoked': {
      const connector = event.payload.connector
      return upsertConnection(state, connector, (existing) => ({
        connector,
        state: 'revoked',
        accountLabel: existing?.accountLabel ?? null,
        scopes: [],
        reason: event.payload.reason,
        failureCode: 'revoked',
        updatedAt: event.occurredAt,
        lastSuccessAt: existing?.lastSuccessAt ?? null,
        authorizedAt: existing?.authorizedAt ?? null,
        expiresAt: null,
      }))
    }

    case 'connector.connection.failed': {
      const connector = event.payload.connector
      return upsertConnection(state, connector, (existing) => ({
        connector,
        state: 'failed',
        accountLabel: existing?.accountLabel ?? null,
        scopes: existing?.scopes ?? [],
        reason: event.payload.reason,
        failureCode: event.payload.failureCode,
        updatedAt: event.occurredAt,
        lastSuccessAt: existing?.lastSuccessAt ?? null,
        authorizedAt: existing?.authorizedAt ?? null,
        expiresAt: existing?.expiresAt ?? null,
      }))
    }

    case 'connector.connection.blocked': {
      const connector = event.payload.connector
      return upsertConnection(state, connector, (existing) => ({
        connector,
        state: 'blocked-by-policy',
        accountLabel: existing?.accountLabel ?? null,
        scopes: existing?.scopes ?? [],
        reason: event.payload.reason,
        failureCode: event.payload.failureCode,
        updatedAt: event.occurredAt,
        lastSuccessAt: existing?.lastSuccessAt ?? null,
        authorizedAt: existing?.authorizedAt ?? null,
        expiresAt: existing?.expiresAt ?? null,
      }))
    }

    case 'connector.event.received': {
      const record: ConnectorEventRecord = {
        eventId: event.payload.eventId,
        connector: event.payload.connector,
        accountLabel: event.payload.accountLabel,
        kind: event.payload.kind,
        dedupeKey: event.payload.dedupeKey,
        receivedAt: event.occurredAt,
        payloadLength: event.payload.payloadLength,
        accepted: true,
        reason: null,
      }
      return {
        ...state,
        events: pushBounded(state.events, record, CONNECTOR_LIMITS.maxRecentEvents * 4),
        dedupe: pushBounded(state.dedupe, record.dedupeKey, CONNECTOR_LIMITS.maxEventDedupeKeys),
      }
    }

    case 'connector.event.denied': {
      const record: ConnectorEventRecord = {
        eventId: event.payload.eventId,
        connector: event.payload.connector,
        accountLabel: null,
        kind: event.payload.kind,
        dedupeKey: event.payload.dedupeKey,
        receivedAt: event.occurredAt,
        payloadLength: 0,
        accepted: false,
        reason: event.payload.reason,
      }
      // A denied event still records its dedupe key, so a replay of a rejected
      // event is rejected again without a second decision.
      return {
        ...state,
        events: pushBounded(state.events, record, CONNECTOR_LIMITS.maxRecentEvents * 4),
        dedupe: pushBounded(state.dedupe, record.dedupeKey, CONNECTOR_LIMITS.maxEventDedupeKeys),
      }
    }

    case 'connector.action.reconciled': {
      // A successful action is the connector's most recent success. The state is
      // unchanged — an action does not move a connection — but the timestamp is
      // evidence the projection reports.
      if (event.payload.outcome !== 'completed') return state
      const connector = event.payload.connector
      return upsertConnection(state, connector, (existing) =>
        existing === undefined
          ? {
              connector,
              state: 'credentials-missing',
              accountLabel: null,
              scopes: [],
              reason: null,
              failureCode: null,
              updatedAt: event.occurredAt,
              lastSuccessAt: event.occurredAt,
              authorizedAt: null,
              expiresAt: null,
            }
          : { ...existing, lastSuccessAt: event.occurredAt, updatedAt: event.occurredAt },
      )
    }

    default:
      return state
  }
}

export { initialConnectorState }
export type { ConnectorFold } from './types'
