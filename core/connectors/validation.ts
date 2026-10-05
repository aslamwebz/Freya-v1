/**
 * CONNECTOR VALIDATION — strict normalization before anything reaches Relay or
 * the event fold.
 *
 * The connector command surface is narrow on purpose. A renderer names a
 * connector and an action from the closed vocabulary and supplies the action's
 * own bounded parameters. It cannot name a capability, a scope, an account, a
 * token, a budget or a limit, and a field outside the expected set is refused
 * rather than dropped.
 */

import { isConnectorAction, actionPolicy, type ConnectorAction } from './policy'
import {
  CONNECTOR_LIMITS,
  isConnectorId,
  isConnectorKind,
  sanitizeConnectorText,
  type ConnectorKind,
} from './types'

export type ConnectorValidation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string }

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** The keys a connector command payload may carry. */
function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).every((key) => keys.includes(key))
}

/** A connect request: a connector, and an optional authority level. */
export function validateConnectRequest(payload: unknown): ConnectorValidation<{
  connector: ConnectorKind
  authority: 'read' | 'write'
}> {
  const record = asRecord(payload)
  if (record === null) return { ok: false, reason: 'a connect request must be an object' }
  if (!hasOnlyKeys(record, ['connector', 'authority'])) {
    return { ok: false, reason: 'a connect request names a connector and an optional authority' }
  }
  if (!isConnectorKind(record.connector)) {
    return { ok: false, reason: 'that connector is not one this build supports' }
  }
  if (record.authority !== undefined && record.authority !== 'read' && record.authority !== 'write') {
    return { ok: false, reason: 'a connect authority must be read or write' }
  }
  return { ok: true, value: { connector: record.connector, authority: record.authority === 'write' ? 'write' : 'read' } }
}

/** A disconnect request: a connector and an optional reason. */
export function validateDisconnectRequest(payload: unknown): ConnectorValidation<{
  connector: ConnectorKind
  reason: string | null
}> {
  const record = asRecord(payload)
  if (record === null) return { ok: false, reason: 'a disconnect request must be an object' }
  if (!hasOnlyKeys(record, ['connector', 'reason'])) {
    return { ok: false, reason: 'a disconnect request names a connector and an optional reason' }
  }
  if (!isConnectorKind(record.connector)) {
    return { ok: false, reason: 'that connector is not one this build supports' }
  }
  let reason: string | null = null
  if (record.reason !== undefined && record.reason !== null) {
    if (typeof record.reason !== 'string') return { ok: false, reason: 'a disconnect reason must be a string' }
    reason = sanitizeConnectorText(record.reason, CONNECTOR_LIMITS.maxReasonChars)
  }
  return { ok: true, value: { connector: record.connector, reason } }
}

/**
 * A connector action request: a connector, an action, and the action's params.
 *
 * The connector must be the one the action belongs to, so a caller cannot ask
 * `gmail.send` under the `telegram` connector and have the mismatch resolved in
 * its favour. The params are forwarded to Relay, which validates them again.
 */
export function validateActionRequest(payload: unknown): ConnectorValidation<{
  connector: ConnectorKind
  action: ConnectorAction
  params: Record<string, unknown>
}> {
  const record = asRecord(payload)
  if (record === null) return { ok: false, reason: 'a connector action must be an object' }
  if (!hasOnlyKeys(record, ['connector', 'action', 'params'])) {
    return { ok: false, reason: 'a connector action names a connector, an action and params' }
  }
  if (!isConnectorKind(record.connector)) {
    return { ok: false, reason: 'that connector is not one this build supports' }
  }
  if (!isConnectorAction(record.action)) {
    return { ok: false, reason: 'that is not a connector action' }
  }
  const policy = actionPolicy(record.action)
  if (policy.connector !== record.connector) {
    return { ok: false, reason: `the action ${record.action} does not belong to the ${record.connector} connector` }
  }
  const params = record.params === undefined || record.params === null ? {} : asRecord(record.params)
  if (params === null) return { ok: false, reason: 'connector action params must be an object' }
  const serialized = JSON.stringify(params)
  if (serialized === undefined || serialized.length > CONNECTOR_LIMITS.maxEventPayloadChars * 4) {
    return { ok: false, reason: 'the connector action params are too large' }
  }
  return { ok: true, value: { connector: record.connector, action: record.action, params } }
}

/**
 * A host-supplied authorization completion.
 *
 * Host-only, never a renderer command. The account label is display metadata;
 * the scopes are checked against the catalog by the engine, which refuses a
 * scope the build does not know. `expiresAt` is an instant or null.
 */
export function validateAuthorizationCompletion(payload: unknown): ConnectorValidation<{
  connector: ConnectorKind
  accountLabel: string
  scopes: readonly string[]
  expiresAt: string | null
}> {
  const record = asRecord(payload)
  if (record === null) return { ok: false, reason: 'an authorization completion must be an object' }
  if (!hasOnlyKeys(record, ['connector', 'accountLabel', 'scopes', 'expiresAt'])) {
    return { ok: false, reason: 'an authorization completion carries a connector, an account label, scopes and an expiry' }
  }
  if (!isConnectorKind(record.connector)) {
    return { ok: false, reason: 'that connector is not one this build supports' }
  }
  if (typeof record.accountLabel !== 'string') {
    return { ok: false, reason: 'an account label must be a string' }
  }
  const accountLabel = sanitizeConnectorText(record.accountLabel, CONNECTOR_LIMITS.maxAccountLabelChars)
  if (accountLabel.length === 0) return { ok: false, reason: 'an account label is empty' }
  if (!Array.isArray(record.scopes)) return { ok: false, reason: 'scopes must be a list' }
  if (record.scopes.length > CONNECTOR_LIMITS.maxScopeEntries) {
    return { ok: false, reason: `at most ${CONNECTOR_LIMITS.maxScopeEntries} scopes may be granted` }
  }
  const scopes: string[] = []
  for (const scope of record.scopes) {
    if (typeof scope !== 'string' || scope.length === 0 || scope.length > 128) {
      return { ok: false, reason: 'a scope label is invalid' }
    }
    scopes.push(scope)
  }
  let expiresAt: string | null = null
  if (record.expiresAt !== undefined && record.expiresAt !== null) {
    if (typeof record.expiresAt !== 'string' || Number.isNaN(Date.parse(record.expiresAt))) {
      return { ok: false, reason: 'an expiry must be an ISO-8601 instant' }
    }
    expiresAt = record.expiresAt
  }
  return { ok: true, value: { connector: record.connector, accountLabel, scopes, expiresAt } }
}

/**
 * A host-supplied external event.
 *
 * The `payload` is content: it is bounded, measured, and never journaled. The
 * engine only records the event's kind, dedupe key and measured length, so an
 * event cannot carry a token or a message body into the durable log.
 */
export function validateEventInput(payload: unknown): ConnectorValidation<{
  connector: ConnectorKind
  accountLabel: string | null
  kind: string
  dedupeKey: string
  payload: unknown
}> {
  const record = asRecord(payload)
  if (record === null) return { ok: false, reason: 'a connector event must be an object' }
  if (!hasOnlyKeys(record, ['connector', 'accountLabel', 'kind', 'dedupeKey', 'payload'])) {
    return { ok: false, reason: 'a connector event carries a connector, a kind, a dedupe key and a payload' }
  }
  if (!isConnectorKind(record.connector)) {
    return { ok: false, reason: 'that connector is not one this build supports' }
  }
  const kind = sanitizeConnectorText(record.kind, CONNECTOR_LIMITS.maxEventKindChars)
  if (kind.length === 0) return { ok: false, reason: 'an event kind is required' }
  if (!isConnectorId(record.dedupeKey, 256)) {
    return { ok: false, reason: 'a dedupe key must be a bounded opaque id' }
  }
  let accountLabel: string | null = null
  if (record.accountLabel !== undefined && record.accountLabel !== null) {
    accountLabel = sanitizeConnectorText(record.accountLabel, CONNECTOR_LIMITS.maxAccountLabelChars)
    if (accountLabel.length === 0) return { ok: false, reason: 'an account label is empty' }
  }
  const serialized = JSON.stringify(record.payload ?? null)
  if (serialized === undefined || serialized.length > CONNECTOR_LIMITS.maxEventPayloadChars) {
    return { ok: false, reason: 'the event payload is too large' }
  }
  return { ok: true, value: { connector: record.connector, accountLabel, kind, dedupeKey: record.dedupeKey, payload: record.payload ?? null } }
}
