/**
 * CONNECTOR PROJECTION — the only route from connector facts to a window.
 *
 * A mirror, in the same sense as every other subsystem's: Core builds it, a
 * window holds what Core last sent, and nothing a window can do writes a field
 * of it. The projection carries connection state, account labels, scope names,
 * capability flags and event metadata — and no secret. A token, a refresh
 * token, a client secret and an authorization header are not fields here, so
 * they cannot leak through the one object a window is handed.
 */

import type { ConnectorProjection } from '../protocol/connectors'
import { connectorDefinition, grantCovers } from './catalog'
import type { ConnectorEngine } from './engine'
import {
  CONNECTOR_LIMITS,
  CONNECTOR_KINDS,
  type ConnectorKind,
  type ConnectorState,
} from './types'

/** The projection schema this lane speaks. */
export const CONNECTOR_SCHEMA_VERSION = 1

export function projectConnectors(input: {
  sequence: number
  engine: ConnectorEngine
  /** Whether Relay holds a pending approval for this connector. */
  pendingApproval: (connector: ConnectorKind) => boolean
  /** The most recent events the fold holds. */
  recentEvents: readonly {
    eventId: string
    connector: ConnectorKind
    kind: string
    receivedAt: string
    accepted: boolean
    reason: string | null
  }[]
}): ConnectorProjection {
  const { engine } = input
  return {
    health: 'ready',
    reason: null,
    schemaVersion: CONNECTOR_SCHEMA_VERSION,
    sequence: input.sequence,
    connectors: CONNECTOR_KINDS.map((connector) => {
      const definition = connectorDefinition(connector)
      const status = engine.stateOf(connector)
      const scopes = engine.grantedScopes(connector)
      const readable = engine.canRead(connector)
      const writable = engine.canWrite(connector)
      const destructive =
        status.state === 'connected-readwrite' && grantCovers(scopes, definition.destructiveScopes)
      return {
        connector,
        label: definition.label,
        state: status.state,
        accountLabel: engine.accountLabelOf(connector),
        reason: status.reason,
        failureCode: status.failureCode,
        read: readable,
        write: writable,
        destructive,
        scopes,
        lastSuccessAt: engine.lastSuccessOf(connector),
        updatedAt: engine.updatedAtOf(connector),
        pendingApproval: input.pendingApproval(connector),
      }
    }),
    recentEvents: input.recentEvents.slice(-CONNECTOR_LIMITS.maxRecentEvents).reverse().map((event) => ({
      eventId: event.eventId,
      connector: event.connector,
      kind: event.kind,
      receivedAt: event.receivedAt,
      accepted: event.accepted,
      reason: event.reason,
    })),
    limits: {
      maxReadResults: CONNECTOR_LIMITS.maxReadResults,
      maxEventPayloadChars: CONNECTOR_LIMITS.maxEventPayloadChars,
      maxRecentEvents: CONNECTOR_LIMITS.maxRecentEvents,
      authRequestTtlMs: CONNECTOR_LIMITS.authRequestTtlMs,
      maxRetries: CONNECTOR_LIMITS.maxRetries,
      requestTimeoutMs: CONNECTOR_LIMITS.requestTimeoutMs,
    },
  }
}

/** The states a window may render, exported so a surface cannot invent one. */
export const CONNECTOR_STATE_LABELS: Readonly<Record<ConnectorState, string>> = Object.freeze({
  unsupported: 'Unsupported',
  unconfigured: 'Not configured',
  'credentials-missing': 'Credentials missing',
  'authorization-required': 'Authorization required',
  connecting: 'Connecting',
  'connected-readonly': 'Connected (read only)',
  'connected-readwrite': 'Connected (read & write)',
  degraded: 'Degraded',
  expired: 'Expired',
  revoked: 'Revoked',
  failed: 'Failed',
  'blocked-by-policy': 'Blocked by policy',
})
