/**
 * THE CONNECTOR DOMAIN — Phase 44's vocabulary.
 *
 * Relay (Phase 16) is the capability-gated *action* plane: it validates an
 * action, checks Guard and the budget ledger, creates a pending approval for a
 * write and calls a bounded adapter. This module is the *connection* plane that
 * Relay deliberately does not own: whether a provider is configured at all,
 * whether a person has authorized it, which scopes were granted, whether the
 * grant is expired or revoked, and what authenticated external events arrived.
 *
 * The two planes are complementary and neither implies the other:
 *
 *   - **Connector existence is not connection.** A connector is in the catalog
 *     the moment this code ships. `unconfigured` and `credentials-missing` are
 *     the honest states until a host supplies client credentials and a person
 *     completes an authorization.
 *   - **Connected is not authorized for every action.** A read-only grant is
 *     `connected-readonly`; a send requires `connected-readwrite` and the write
 *     scope. `read permission != write permission` is a property of the state
 *     machine, not of a caller's care.
 *   - **Authentication is not authority.** A valid token grants nothing on its
 *     own. Every action still passes Relay's Guard, budget and approval gates,
 *     and a connector action additionally checks the connection state and the
 *     granted scope before Relay is asked.
 *
 * ## What is deliberately absent
 *
 * There is **no token field, anywhere**. No access token, no refresh token, no
 * client secret, no authorization header, no cookie. The secure token store is
 * a host-side seam (`ConnectorTokenStore`) whose records never cross into Core
 * and never reach the journal or a projection. This file holds the *shape* of a
 * connection, not a credential.
 *
 * ## Bounded everywhere
 *
 * Every list has a maximum, every string a maximum, every event payload a byte
 * ceiling. An unbounded connector is how a transport plane quietly becomes an
 * exfiltration channel.
 */

import type { RelayAction, RelayConnectorId } from '../relay/types'

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

export function isConnectorKind(value: unknown): value is ConnectorKind {
  return typeof value === 'string' && (CONNECTOR_KINDS as readonly string[]).includes(value)
}

/* ---------------------------------------------------------------- states */

/**
 * A connector's connection state, as the projection reports it.
 *
 * The set is closed and every value is evidence-backed. A state is never set by
 * a renderer: it is derived from the durable `connector.*` fold, the host's
 * configuration report and the catalog. `connected-*` is only reachable after
 * an authorization event, and a revocation is terminal until a new authorization.
 */
export const CONNECTOR_STATES = [
  /** No definition for this connector in this build. */
  'unsupported',
  /** The build defines it, but the host supplied no client credentials. */
  'unconfigured',
  /** Configured, but no stored authorization exists. */
  'credentials-missing',
  /** Configured, no grant, and an authorization is required before any action. */
  'authorization-required',
  /** An authorization is in progress. */
  'connecting',
  /** Authorized with read scopes only. Writes are refused. */
  'connected-readonly',
  /** Authorized with read and write scopes. Writes may be requested. */
  'connected-readwrite',
  /** Authorized, but the provider or transport reported a problem. */
  'degraded',
  /** The grant is past its expiry. */
  'expired',
  /** The grant was withdrawn. Credentials are cleared where supported. */
  'revoked',
  /** The last connection attempt failed. */
  'failed',
  /** Policy refuses the connector in this build or context. */
  'blocked-by-policy',
] as const
export type ConnectorState = (typeof CONNECTOR_STATES)[number]

export function isConnectorState(value: unknown): value is ConnectorState {
  return typeof value === 'string' && (CONNECTOR_STATES as readonly string[]).includes(value)
}

/** The states in which a read may be attempted. */
export const CONNECTOR_READABLE_STATES: readonly ConnectorState[] = [
  'connected-readonly',
  'connected-readwrite',
]

/** The states in which a write may be requested. */
export const CONNECTOR_WRITABLE_STATES: readonly ConnectorState[] = ['connected-readwrite']

/* ------------------------------------------------------------- authority */

/**
 * What an action needs, as a closed class.
 *
 * `read` changes nothing. `write` mutates account state a person can undo.
 * `destructive` removes or cancels something and is gated separately. The class
 * is chosen by Core's policy table, never by a caller.
 */
export const CONNECTOR_AUTHORITIES = ['read', 'write', 'destructive'] as const
export type ConnectorAuthority = (typeof CONNECTOR_AUTHORITIES)[number]

export function isConnectorAuthority(value: unknown): value is ConnectorAuthority {
  return typeof value === 'string' && (CONNECTOR_AUTHORITIES as readonly string[]).includes(value)
}

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

export function isConnectorFailureCode(value: unknown): value is ConnectorFailureCode {
  return typeof value === 'string' && (CONNECTOR_FAILURE_CODES as readonly string[]).includes(value)
}

/* ---------------------------------------------------------------- limits */

/**
 * Code-owned ceilings. A caller may never raise one.
 *
 * The auth-request TTL is the bounded window in which a callback may complete;
 * a callback after it is refused rather than accepted late. `maxEventDedupeKeys`
 * bounds the replay-protection store so it cannot grow without limit.
 */
export const CONNECTOR_LIMITS = Object.freeze({
  /** The connectors this build can describe. */
  maxConnectors: CONNECTOR_KINDS.length,
  /** Scope labels on one grant. */
  maxScopeEntries: 32,
  /** Rows one connector read may return. */
  maxReadResults: 100,
  /** Characters in one event payload, before validation. */
  maxEventPayloadChars: 16_000,
  /** Dedupe keys retained for replay protection. Bounded and documented. */
  maxEventDedupeKeys: 512,
  /** Recent events the projection retains. */
  maxRecentEvents: 50,
  /** Characters in a reason sentence. */
  maxReasonChars: 300,
  /** Characters in an account display label. */
  maxAccountLabelChars: 128,
  /** Characters in an event kind label. */
  maxEventKindChars: 64,
  /** How long a pending authorization may wait for its callback. */
  authRequestTtlMs: 10 * 60 * 1000,
  /** Pending authorization requests held at once. */
  maxPendingAuthRequests: 16,
  /** Transient retries a bounded adapter performs. Never a loop. */
  maxRetries: 2,
  /** A single provider request's timeout. */
  requestTimeoutMs: 20_000,
})

/* --------------------------------------------------------------- records */

/** The scopes a connector grant carries, as a bounded list of labels. */
export interface ConnectorGrant {
  readonly connector: ConnectorKind
  readonly accountLabel: string
  readonly scopes: readonly string[]
  readonly grantedAt: string
  readonly expiresAt: string | null
}

/**
 * One connector's folded connection record.
 *
 * `accountLabel` is a display label the host assigned from the provider's own
 * response (an email address, a login). It is never a credential and never a
 * token. `reason` is a bounded sentence Core wrote, never an adapter's raw text.
 */
export interface ConnectorConnectionRecord {
  readonly connector: ConnectorKind
  readonly state: ConnectorState
  readonly accountLabel: string | null
  readonly scopes: readonly string[]
  readonly reason: string | null
  readonly failureCode: ConnectorFailureCode | null
  readonly updatedAt: string
  readonly lastSuccessAt: string | null
  readonly authorizedAt: string | null
  readonly expiresAt: string | null
}

/** A pending or settled authorization request. */
export interface ConnectorAuthRequestRecord {
  readonly requestId: string
  readonly connector: ConnectorKind
  readonly status: 'pending' | 'completed' | 'expired' | 'denied'
  readonly requestedAt: string
}

/**
 * One authenticated external event, as metadata.
 *
 * The event's *content* is deliberately absent: `payloadLength` is a
 * measurement, exactly as a conversation turn's `contentLength` is. The content
 * is delivered to the consumer that asked for it and is never written here.
 */
export interface ConnectorEventRecord {
  readonly eventId: string
  readonly connector: ConnectorKind
  readonly accountLabel: string | null
  readonly kind: string
  readonly dedupeKey: string
  readonly receivedAt: string
  readonly payloadLength: number
  readonly accepted: boolean
  readonly reason: string | null
}

/** The folded connector state, derived from `connector.*` events. */
export interface ConnectorFold {
  readonly connections: readonly ConnectorConnectionRecord[]
  readonly authRequests: readonly ConnectorAuthRequestRecord[]
  readonly events: readonly ConnectorEventRecord[]
  /** Dedupe keys retained, oldest first. */
  readonly dedupe: readonly string[]
}

export function initialConnectorState(): ConnectorFold {
  return { connections: [], authRequests: [], events: [], dedupe: [] }
}

/* -------------------------------------------------------------- utilities */

/** Whether a string is a bounded opaque id. */
export function isConnectorId(value: unknown, max = 128): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  )
}

/**
 * Sanitize a display label into bounded, control-character-free data.
 *
 * Not a security boundary on its own — a label is never authority — but it
 * keeps a pathological payload from becoming a multi-megabyte string and keeps
 * terminal control sequences out of anything that might render it.
 */
export function sanitizeConnectorText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  let out = ''
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    const isControl =
      code <= 8 ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      (code >= 127 && code <= 159)
    if (isControl) continue
    out += character
  }
  const collapsed = out.replace(/\s+/g, ' ').trim()
  return collapsed.length > max ? collapsed.slice(0, max) : collapsed
}

/** A connector's mapping onto Relay's action plane. */
export interface ConnectorRelayMapping {
  readonly relayConnector: RelayConnectorId
  /** The Relay action a connector action maps to. */
  readonly relayAction: RelayAction
}
