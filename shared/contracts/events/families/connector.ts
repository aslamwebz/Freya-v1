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
