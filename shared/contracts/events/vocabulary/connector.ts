/* ------------------------------------------------------------- providers */

/**
 * The connectors this build knows how to describe.
 *
 * A **closed** set. `unsupported` is a real state for a connector the host
 * names that this build has no definition for; it is never silently treated as
 * one of these.
 */
export const CONNECTOR_KINDS = [
  'gmail',
  'google-drive',
  'google-calendar',
  'github',
  'telegram',
] as const
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number]
/* ----------------------------------------------------------- failure codes */

/**
 * Why a connector operation did not happen. A closed set, because a failure
 * code a caller can invent is decoration.
 */
export const CONNECTOR_FAILURE_CODES = [
  'unsupported',
  'unconfigured',
  'credentials_missing',
  'authorization_required',
  'scope_missing',
  'connection_required',
  'read_only',
  'blocked_by_policy',
  'expired',
  'revoked',
  'rate_limited',
  'timeout',
  'cancelled',
  'provider_error',
  'write_unknown',
  'event_rejected',
  'event_replayed',
  'cross_account',
  'secret_store_unavailable',
  'invalid_request',
  'capability_denied',
  'stop_all',
  'budget_exceeded',
  'approval_denied',
  'approval_expired',
] as const
export type ConnectorFailureCode = (typeof CONNECTOR_FAILURE_CODES)[number]