/**
 * THE CONNECTOR ENGINE — connection lifecycle, policy, and delegation to Relay.
 *
 * This is the only code that turns a connector command into a connection-state
 * change or a Relay action. It is written so the properties Phase 44 claims are
 * structural:
 *
 *   - **Connection is checked before authority.** Every action first resolves
 *     the connector's connection state and refuses when it is not readable (for
 *     a read) or readwrite (for a write). A registered adapter with no grant
 *     cannot be used.
 *   - **Scope is checked before Relay.** A read requires the read scope and a
 *     write requires its write scope. `read permission != write permission` is
 *     enforced here, before the action is even submitted.
 *   - **No second approval system.** Write and destructive actions are
 *     forwarded to the existing Relay engine, which owns Guard, the budget
 *     ledger and the approval lifecycle. The connector engine never executes a
 *     write itself and never mints an approval.
 *   - **Events grant nothing.** `ingestEvent` validates, dedupes and journals
 *     metadata. It has no path to an action, a capability or a model.
 *
 * The engine holds no token store, no HTTP client and no provider. It holds an
 * `authPort` the host supplied (which returns only a URL and a status, never a
 * secret) and an `actionPort` that is Relay.
 */

import { randomUUID } from 'node:crypto'
import type { EventFabric } from '../events/fabric'
import type { RelayAction } from '../relay/types'
import type { RelayEngineResult, RelayReadResult } from '../relay/engine'
import { actionPolicy, isReadAction } from './policy'
import {
  connectorDefinition,
  grantCovers,
  knownScopes,
  scopesForAuthority,
} from './catalog'
import { findConnection, isDuplicateEvent } from './state'
import {
  CONNECTOR_LIMITS,
  sanitizeConnectorText,
  type ConnectorFailureCode,
  type ConnectorKind,
  type ConnectorState,
  type ConnectorFold,
} from './types'
import {
  validateActionRequest,
  validateAuthorizationCompletion,
  validateConnectRequest,
  validateDisconnectRequest,
  validateEventInput,
} from './validation'

/**
 * The host's authorization seam.
 *
 * Every method returns display metadata or a URL — never a token. `describe`
 * is synchronous so the projection can be built without an await, and it
 * reports only whether client credentials and a stored token exist.
 */
export interface ConnectorAuthPort {
  describe(connector: ConnectorKind): { configured: boolean; tokenPresent: boolean; reason: string | null }
  beginAuthorization(input: {
    connector: ConnectorKind
    requestId: string
    scopes: readonly string[]
  }): Promise<{ ok: true; authorizationUrl: string } | { ok: false; reason: string }>
  disconnect(connector: ConnectorKind): Promise<void>
}

/** The action seam: Relay, and nothing else. */
export interface ConnectorActionPort {
  execute(input: { action: RelayAction; payload: unknown }): Promise<RelayEngineResult>
}

export interface ConnectorEngineOptions {
  fabric: EventFabric
  auth: ConnectorAuthPort
  action: ConnectorActionPort
  /** Read fresh at each decision; never copied into state. */
  stopAll: () => boolean
  /** The folded connector state, owned by Core's reducer. */
  getState: () => ConnectorFold
  /** Connectors policy refuses outright. Code-owned and host-supplied. */
  blocked?: readonly ConnectorKind[]
  now?: () => Date
  newId?: () => string
}

export type ConnectorReadResult = RelayReadResult

export type ConnectorEngineResult =
  | { readonly ok: true; readonly kind: 'read'; readonly result: ConnectorReadResult }
  | { readonly ok: true; readonly kind: 'pending'; readonly actionId: string; readonly approvalId: string; readonly summary: string }
  | { readonly ok: true; readonly kind: 'replayed'; readonly actionId: string; readonly status: string }
  | { readonly ok: false; readonly failureCode: ConnectorFailureCode; readonly reason: string }

export type ConnectorConnectResult =
  | { readonly ok: true; readonly kind: 'authorization'; readonly requestId: string; readonly authorizationUrl: string }
  | { readonly ok: false; readonly failureCode: ConnectorFailureCode; readonly reason: string }

export type ConnectorDisconnectResult =
  | { readonly ok: true; readonly kind: 'revoked' }
  | { readonly ok: false; readonly failureCode: ConnectorFailureCode; readonly reason: string }

export type ConnectorAuthorizationResult =
  | { readonly ok: true; readonly kind: 'authorized' }
  | { readonly ok: false; readonly failureCode: ConnectorFailureCode; readonly reason: string }

export type ConnectorEventResult =
  | { readonly ok: true; readonly kind: 'accepted'; readonly eventId: string }
  | { readonly ok: false; readonly failureCode: ConnectorFailureCode; readonly reason: string }

function refused(failureCode: ConnectorFailureCode, reason: string): ConnectorEngineResult {
  return { ok: false, failureCode, reason }
}

export class ConnectorEngine {
  private readonly fabric: EventFabric
  private readonly auth: ConnectorAuthPort
  private readonly action: ConnectorActionPort
  private readonly stopAll: () => boolean
  private readonly getState: () => ConnectorFold
  private readonly blocked: ReadonlySet<ConnectorKind>
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(options: ConnectorEngineOptions) {
    this.fabric = options.fabric
    this.auth = options.auth
    this.action = options.action
    this.stopAll = options.stopAll
    this.getState = options.getState
    this.blocked = new Set(options.blocked ?? [])
    this.now = options.now ?? (() => new Date())
    this.newId = options.newId ?? (() => randomUUID())
  }

  /**
   * The connection state of one connector, derived from evidence.
   *
   * The order is deliberate: policy, then configuration, then the stored token,
   * then the folded record. A folded `connected-*` record whose token has
   * vanished reports `credentials-missing`, because the record is history and
   * the missing token is the present fact.
   */
  stateOf(connector: ConnectorKind): { state: ConnectorState; reason: string | null; failureCode: ConnectorFailureCode | null } {
    if (this.blocked.has(connector)) {
      return { state: 'blocked-by-policy', reason: 'this connector is refused by policy in this build', failureCode: 'blocked_by_policy' }
    }
    const described = this.auth.describe(connector)
    if (!described.configured) {
      return { state: 'unconfigured', reason: described.reason ?? 'no client credentials are configured for this connector', failureCode: 'unconfigured' }
    }
    const record = findConnection(this.getState(), connector)
    if (record === undefined) {
      if (!described.tokenPresent) {
        return { state: 'credentials-missing', reason: 'no authorization has been stored for this connector', failureCode: 'credentials_missing' }
      }
      return { state: 'authorization-required', reason: 'a stored token exists but no authorization was recorded', failureCode: 'authorization_required' }
    }
    // A folded connected record whose token has vanished reports the missing
    // token, because the record is history and the missing token is the present
    // fact. A terminal record (revoked, expired, failed) is its own truth and is
    // reported as it stands.
    if (!described.tokenPresent && record.state.startsWith('connected')) {
      return { state: 'credentials-missing', reason: 'the stored authorization is no longer present', failureCode: 'credentials_missing' }
    }
    return { state: record.state, reason: record.reason, failureCode: record.failureCode }
  }

  /** The scopes currently granted for a connector, from the folded record. */
  grantedScopes(connector: ConnectorKind): readonly string[] {
    return findConnection(this.getState(), connector)?.scopes ?? []
  }

  /** The account display label, when the fold holds one. Never a credential. */
  accountLabelOf(connector: ConnectorKind): string | null {
    return findConnection(this.getState(), connector)?.accountLabel ?? null
  }

  /** When the connector last succeeded, when the fold holds it. */
  lastSuccessOf(connector: ConnectorKind): string | null {
    return findConnection(this.getState(), connector)?.lastSuccessAt ?? null
  }

  /** When the connector's state last changed, when the fold holds it. */
  updatedAtOf(connector: ConnectorKind): string | null {
    return findConnection(this.getState(), connector)?.updatedAt ?? null
  }

  /** Whether a connector currently has a readable grant. */
  canRead(connector: ConnectorKind): boolean {
    const { state } = this.stateOf(connector)
    if (state !== 'connected-readonly' && state !== 'connected-readwrite') return false
    return grantCovers(this.grantedScopes(connector), connectorDefinition(connector).readScopes)
  }

  /** Whether a connector currently has a readwrite grant. */
  canWrite(connector: ConnectorKind): boolean {
    const { state } = this.stateOf(connector)
    if (state !== 'connected-readwrite') return false
    const definition = connectorDefinition(connector)
    const scopes = this.grantedScopes(connector)
    return grantCovers(scopes, definition.writeScopes) || grantCovers(scopes, definition.destructiveScopes)
  }

  /**
   * Begin an authorization.
   *
   * Core journals the request first, then asks the host for a URL. If the host
   * cannot build one — no client credentials, no secure store — the request is
   * recorded as failed and the refusal is returned. A URL is never a secret.
   */
  async connect(payload: unknown): Promise<ConnectorConnectResult> {
    const validated = validateConnectRequest(payload)
    if (!validated.ok) return { ok: false, failureCode: 'invalid_request', reason: validated.reason }
    const connector = validated.value.connector
    if (this.stopAll()) {
      return { ok: false, failureCode: 'stop_all', reason: 'Freya is stopped. Every connector action is refused.' }
    }
    const state = this.stateOf(connector)
    if (state.state === 'blocked-by-policy') {
      return { ok: false, failureCode: 'blocked_by_policy', reason: state.reason ?? 'this connector is refused by policy' }
    }
    if (state.state === 'unconfigured') {
      return { ok: false, failureCode: 'unconfigured', reason: state.reason ?? 'no client credentials are configured for this connector' }
    }
    const authority = validated.value.authority
    const scopes = [...scopesForAuthority(connector, 'read'), ...(authority === 'write' ? scopesForAuthority(connector, 'write') : [])]
    const requestId = this.newId()
    await this.fabric.append(
      'connector.connection.requested',
      { requestId, connector },
      { actor: 'owner', correlationId: requestId },
    )
    const begun = await this.auth.beginAuthorization({ connector, requestId, scopes })
    if (!begun.ok) {
      await this.fabric.append(
        'connector.connection.failed',
        { connector, failureCode: 'secret_store_unavailable', reason: sanitizeConnectorText(begun.reason, CONNECTOR_LIMITS.maxReasonChars) },
        { actor: 'owner', correlationId: requestId },
      )
      return { ok: false, failureCode: 'secret_store_unavailable', reason: begun.reason }
    }
    return { ok: true, kind: 'authorization', requestId, authorizationUrl: begun.authorizationUrl }
  }

  /**
   * Complete an authorization. **Host-only; never a renderer command.**
   *
   * The scopes are checked against the catalog: a scope the build does not know
   * is refused rather than stored, which is what makes "no silent scope
   * expansion" structural. A completion with no pending request is refused, so a
   * callback cannot authorize a connector that was never asked to connect.
   */
  async authorizationComplete(payload: unknown): Promise<ConnectorAuthorizationResult> {
    const validated = validateAuthorizationCompletion(payload)
    if (!validated.ok) return { ok: false, failureCode: 'invalid_request', reason: validated.reason }
    const { connector, accountLabel, scopes, expiresAt } = validated.value
    const known = new Set(knownScopes(connector))
    const unknown = scopes.filter((scope) => !known.has(scope))
    if (unknown.length > 0) {
      return { ok: false, failureCode: 'scope_missing', reason: 'the authorization named a scope this build does not recognize' }
    }
    const pending = this.getState().authRequests.some(
      (entry) => entry.connector === connector && entry.status === 'pending',
    )
    if (!pending) {
      return { ok: false, failureCode: 'invalid_request', reason: 'no authorization was in progress for this connector' }
    }
    await this.fabric.append(
      'connector.connection.authorized',
      { connector, accountLabel, scopes: [...scopes], expiresAt },
      { actor: 'owner', correlationId: this.newId() },
    )
    return { ok: true, kind: 'authorized' }
  }

  /**
   * Revoke a connector.
   *
   * The host clears its token store first, then Core journals the revocation.
   * A host whose token store cannot clear still records the revocation: the
   * journal is the authority, and a token that outlives it is a token the host
   * must treat as invalid.
   */
  async disconnect(payload: unknown): Promise<ConnectorDisconnectResult> {
    const validated = validateDisconnectRequest(payload)
    if (!validated.ok) return { ok: false, failureCode: 'invalid_request', reason: validated.reason }
    const connector = validated.value.connector
    if (this.stopAll()) {
      return { ok: false, failureCode: 'stop_all', reason: 'Freya is stopped. Every connector action is refused.' }
    }
    const reason = validated.value.reason ?? 'the owner disconnected this connector'
    try {
      await this.auth.disconnect(connector)
    } catch {
      // A failed clear is reported by the journal, not hidden: the revocation
      // is still recorded, and the host must treat the token as invalid.
    }
    await this.fabric.append(
      'connector.connection.revoked',
      { connector, reason: reason.length > 0 ? reason : 'the owner disconnected this connector' },
      { actor: 'owner', correlationId: this.newId() },
    )
    return { ok: true, kind: 'revoked' }
  }

  /**
   * Execute a connector action.
   *
   * Reads run directly through Relay under Guard and the budget. Writes are
   * forwarded to Relay, which creates the pending approval — the connector
   * engine never executes a write. Connection state and scope are checked first,
   * so a read-only grant refuses a send before Relay is ever asked.
   */
  async execute(payload: unknown): Promise<ConnectorEngineResult> {
    const validated = validateActionRequest(payload)
    if (!validated.ok) return refused('invalid_request', validated.reason)
    const { connector, action, params } = validated.value
    if (this.stopAll()) {
      return refused('stop_all', 'Freya is stopped. Every connector action is refused.')
    }

    const policy = actionPolicy(action)
    const connection = this.stateOf(connector)
    if (connection.state === 'blocked-by-policy') {
      return refused('blocked_by_policy', connection.reason ?? 'this connector is refused by policy')
    }
    if (connection.state === 'unconfigured') {
      return refused('unconfigured', connection.reason ?? 'no client credentials are configured for this connector')
    }

    if (isReadAction(action)) {
      if (connection.state !== 'connected-readonly' && connection.state !== 'connected-readwrite') {
        return refused(connection.failureCode ?? 'connection_required', connection.reason ?? 'the connector is not connected for reading')
      }
    } else if (connection.state !== 'connected-readwrite') {
      return refused(connection.failureCode ?? 'read_only', connection.reason ?? 'the connector is not authorized for writes')
    }

    if (!grantCovers(this.grantedScopes(connector), [policy.scope])) {
      return refused('scope_missing', `the connector's grant does not include ${policy.scope}`)
    }

    let result: RelayEngineResult
    try {
      result = await this.action.execute({ action: policy.relayAction, payload: params })
    } catch {
      return refused('provider_error', 'the connector action could not be completed')
    }
    if (!result.ok) {
      return refused(mapRelayFailure(result.failureCode), result.reason)
    }
    if (result.kind === 'read') {
      await this.fabric.append(
        'connector.action.reconciled',
        { connector, actionId: this.newId(), outcome: 'completed' },
        { actor: 'owner', correlationId: this.newId() },
      )
      return { ok: true, kind: 'read', result: result.result }
    }
    if (result.kind === 'pending') {
      return { ok: true, kind: 'pending', actionId: result.actionId, approvalId: result.approvalId, summary: result.summary }
    }
    return { ok: true, kind: 'replayed', actionId: result.action.actionId, status: result.action.status }
  }

  /**
   * Ingest an authenticated external event.
   *
   * Host-only: the host authenticates the delivery and calls this with a bounded
   * payload. Core validates, checks the connector is connected, dedupes, and
   * journals metadata only. An event grants nothing — there is no path from here
   * to an action, a capability or a model.
   */
  async ingestEvent(payload: unknown): Promise<ConnectorEventResult> {
    const validated = validateEventInput(payload)
    if (!validated.ok) return { ok: false, failureCode: 'event_rejected', reason: validated.reason }
    const { connector, accountLabel, kind, dedupeKey, payload: content } = validated.value
    const eventId = this.newId()

    if (this.stopAll()) {
      return { ok: false, failureCode: 'stop_all', reason: 'Freya is stopped. Every connector event is refused.' }
    }
    if (isDuplicateEvent(this.getState(), dedupeKey)) {
      await this.fabric.append(
        'connector.event.denied',
        { eventId, connector, kind, dedupeKey, failureCode: 'event_replayed', reason: 'this event has already been received' },
        { actor: 'system', correlationId: eventId },
      )
      return { ok: false, failureCode: 'event_replayed', reason: 'this event has already been received' }
    }
    const connection = this.stateOf(connector)
    if (connection.state !== 'connected-readonly' && connection.state !== 'connected-readwrite') {
      await this.fabric.append(
        'connector.event.denied',
        { eventId, connector, kind, dedupeKey, failureCode: 'connection_required', reason: 'the connector is not connected' },
        { actor: 'system', correlationId: eventId },
      )
      return { ok: false, failureCode: 'connection_required', reason: 'the connector is not connected' }
    }
    const payloadLength = typeof content === 'string' ? content.length : JSON.stringify(content ?? null).length
    await this.fabric.append(
      'connector.event.received',
      { eventId, connector, accountLabel, kind, dedupeKey, payloadLength },
      { actor: 'system', correlationId: eventId },
    )
    return { ok: true, kind: 'accepted', eventId }
  }

  /**
   * Reconcile pending authorization requests recovered from the journal.
   *
   * A request whose callback never arrived in this process cannot be completed —
   * the host holds no verifier for it — so it is failed with a stated reason
   * rather than left `connecting` forever.
   */
  async reconcile(): Promise<void> {
    const now = this.now().getTime()
    const stale = this.getState().authRequests.filter((entry) => entry.status === 'pending')
    for (const entry of stale) {
      const requestedMs = Date.parse(entry.requestedAt)
      const expired = Number.isFinite(requestedMs) && now - requestedMs > CONNECTOR_LIMITS.authRequestTtlMs
      await this.fabric.append(
        'connector.connection.failed',
        {
          connector: entry.connector,
          failureCode: 'timeout',
          reason: expired
            ? 'the authorization request expired before it was completed'
            : 'the authorization request did not complete in this process',
        },
        { actor: 'system', correlationId: entry.requestId },
      )
    }
  }
}

/** Map Relay's failure code to the connector vocabulary. */
function mapRelayFailure(code: string): ConnectorFailureCode {
  switch (code) {
    case 'stop_all':
      return 'stop_all'
    case 'capability_denied':
      return 'capability_denied'
    case 'budget_exceeded':
      return 'budget_exceeded'
    case 'connection_required':
      return 'connection_required'
    case 'scope_missing':
      return 'scope_missing'
    case 'rate_limited':
      return 'rate_limited'
    case 'approval_denied':
      return 'approval_denied'
    case 'approval_expired':
      return 'approval_expired'
    case 'validation_failed':
    case 'unknown_action':
      return 'invalid_request'
    case 'connector_unavailable':
      return 'unconfigured'
    case 'connector_faulted':
      return 'provider_error'
    case 'transient_error':
      return 'timeout'
    default:
      return 'provider_error'
  }
}
