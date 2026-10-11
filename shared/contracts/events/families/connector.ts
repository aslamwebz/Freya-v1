import type { ConnectorFailureCode, ConnectorKind } from '../vocabulary/connector.ts'

export const CONNECTOR_EVENT_TYPES = [
// Connectors (Phase 44) — the connection lifecycle, metadata only.
  //
  // A connector event describes *that a connection was requested, authorized,
  // refreshed, degraded, expired, revoked, failed or blocked*, and *that an
  // authenticated external event arrived*. There is no slot for a token, an
  // authorization header, a client secret or an event's payload: the token store
  // lives host-side and this file is read, copied and exported into backups.
  // Every field is an id, a closed label, a scope name, a measured length or an
  // instant.
  'connector.connection.requested',
'connector.connection.authorized',
'connector.connection.refreshed',
'connector.connection.degraded',
'connector.connection.expired',
'connector.connection.revoked',
'connector.connection.failed',
'connector.connection.blocked',
'connector.event.received',
'connector.event.denied',
'connector.action.reconciled',
] as const

export interface ConnectorEventPayloads {
/* ------------------------------------------------------------ connectors */

  // Metadata only, and the exact-key rules in `validate.ts` are load-bearing:
  // there is no slot for a token, a client secret, an authorization header or
  // an event's content. `accountLabel` is a display label Core assigned, never
  // an account credential.
  'connector.connection.requested': {
    requestId: string
    connector: ConnectorKind
  }

'connector.connection.authorized': {
    connector: ConnectorKind
    accountLabel: string
    scopes: string[]
    expiresAt: string | null
  }

'connector.connection.refreshed': {
    connector: ConnectorKind
    expiresAt: string | null
  }

'connector.connection.degraded': {
    connector: ConnectorKind
    failureCode: ConnectorFailureCode
    reason: string
  }

'connector.connection.expired': {
    connector: ConnectorKind
  }

'connector.connection.revoked': {
    connector: ConnectorKind
    reason: string
  }

'connector.connection.failed': {
    connector: ConnectorKind
    failureCode: ConnectorFailureCode
    reason: string
  }

'connector.connection.blocked': {
    connector: ConnectorKind
    failureCode: ConnectorFailureCode
    reason: string
  }

'connector.event.received': {
    eventId: string
    connector: ConnectorKind
    accountLabel: string | null
    kind: string
    dedupeKey: string
    payloadLength: number
  }

'connector.event.denied': {
    eventId: string
    connector: ConnectorKind
    kind: string
    dedupeKey: string
    failureCode: ConnectorFailureCode
    reason: string
  }

'connector.action.reconciled': {
    connector: ConnectorKind
    actionId: string
    outcome: string
  }
}