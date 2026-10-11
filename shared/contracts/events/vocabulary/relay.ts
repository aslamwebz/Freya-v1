/* ------------------------------------------------------------- connectors */

/**
 * The connectors this build can route.
 *
 * A **closed** set. `external` is the generic pattern: the host registers
 * named external connectors (by string id) under it, and registering one
 * widens nothing — the caller still needs `relay.external.invoke`, an approval
 * and a budget, exactly as for a built-in connector.
 */
export const RELAY_CONNECTORS = ['email', 'calendar', 'github', 'drive', 'telegram', 'external'] as const
export type RelayConnectorId = (typeof RELAY_CONNECTORS)[number]
/* ---------------------------------------------------------------- actions */

/**
 * The closed action vocabulary. Each action is separately bounded: one
 * capability, one validation rule, one risk class, one adapter call.
 *
 * Reads and writes are different names on purpose. `relay.email.read` does not
 * imply `relay.email.send`, and a principal holding every read capability and
 * no write capability can read and nothing else — the type system says so.
 */
export const RELAY_ACTIONS = [
  'email.read',
  'email.draft.create',
  'email.send',
  'calendar.read',
  'calendar.create',
  'calendar.update',
  'calendar.cancel',
  'github.read',
  'github.issue.create',
  'github.pr.create',
  'drive.read',
  'drive.file.create',
  'telegram.read',
  'telegram.send',
  'external.invoke',
] as const
export type RelayAction = (typeof RELAY_ACTIONS)[number]
/**
 * The risk class of an action, chosen by Core and never by a caller.
 *
 * `read` changes nothing. `routine` mutates account state a person can undo
 * (a draft, an event, an issue). `consequential` sends something to another
 * person or invokes an arbitrary external operation — the two actions whose
 * effect leaves the building.
 */
export const RELAY_RISK_CLASSES = ['read', 'routine', 'consequential'] as const
export type RelayRiskClass = (typeof RELAY_RISK_CLASSES)[number]
/**
 * Why an action did not happen. A closed set, because a failure code a caller
 * can invent is decoration.
 */
export const RELAY_FAILURE_CODES = [
  'unknown_action',
  'validation_failed',
  'capability_denied',
  'stop_all',
  'budget_exceeded',
  'connector_unavailable',
  'connector_faulted',
  'connection_required',
  'scope_missing',
  'rate_limited',
  'adapter_error',
  'transient_error',
  'write_unknown',
  'approval_denied',
  'approval_expired',
  'approval_unknown',
  'idempotency_replayed',
] as const
export type RelayFailureCode = (typeof RELAY_FAILURE_CODES)[number]