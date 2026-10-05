/**
 * THE SECURE TOKEN STORE — a seam, and the rule that governs it.
 *
 * OAuth access tokens, refresh tokens and bot tokens are the most valuable
 * thing a connector holds: a leaked refresh token is durable access to a
 * person's mail, files, calendar or messages. So they live **only** in a
 * host-side secure store, and this file defines the contract that store must
 * satisfy — not an implementation of it.
 *
 * The rule is fail-closed and stated once:
 *
 *   - **No secure store means no persistence.** `NullConnectorTokenStore`
 *     refuses every `save` with `TokenStoreUnavailableError` and returns null
 *     from every `load`. There is deliberately no fallback that writes a token
 *     beside the data it protects, and none that keeps a long-lived token in
 *     plaintext. A connector whose token cannot be stored securely stays
 *     `credentials-missing` rather than pretending to be connected.
 *   - **A record never reaches Core, the journal or a projection.** This
 *     interface returns a `ConnectorTokenRecord` to the host adapter that asked
 *     for it. Nothing in `core/connectors/engine.ts` accepts or returns one, and
 *     `redactTokenRecord` exists so a diagnostic can be produced without the
 *     secret.
 *
 * The concrete keyring-backed store lives in `electron/connectors/token-store.ts`.
 */

import type { ConnectorKind } from './types'

/** One stored authorization. Never logged, never projected, never journaled. */
export interface ConnectorTokenRecord {
  readonly connector: ConnectorKind
  /** A display label the provider returned. Never a credential. */
  readonly accountLabel: string
  readonly scopes: readonly string[]
  readonly accessToken: string
  readonly refreshToken: string | null
  /** When the access token expires, or null when the provider does not say. */
  readonly expiresAt: string | null
  /** When the record was written, so a stale refresh can be recognised. */
  readonly storedAt: string
}

/**
 * The store contract.
 *
 * `kind` is the store's own honest description of its protection:
 * `secure` when the OS wraps the bytes, `memory` for the ephemeral test store,
 * `unavailable` when no secure storage exists. A caller that needs persistence
 * checks `kind` and refuses to promise durability otherwise.
 */
export interface ConnectorTokenStore {
  readonly kind: 'secure' | 'memory' | 'unavailable'
  /** Why there is no secure storage, when there is none. */
  readonly reason: string | null
  load(connector: ConnectorKind): Promise<ConnectorTokenRecord | null>
  /** Persist a record. Throws `TokenStoreUnavailableError` when it cannot. */
  save(record: ConnectorTokenRecord): Promise<void>
  clear(connector: ConnectorKind): Promise<void>
}

/** Raised when a token cannot be persisted securely. Never carries a secret. */
export class TokenStoreUnavailableError extends Error {
  constructor(message = 'no secure token store is available, so the credential was not persisted') {
    super(message)
    this.name = 'TokenStoreUnavailableError'
  }
}

/**
 * An ephemeral store for tests and for a machine with no secure storage.
 *
 * It holds records in process memory only. It is honest about that through
 * `kind: 'memory'`, and a production host must not treat a `memory` store as
 * durable. Its records are still never logged or projected.
 */
export class MemoryConnectorTokenStore implements ConnectorTokenStore {
  readonly kind = 'memory' as const
  readonly reason: string | null = null
  private readonly records = new Map<ConnectorKind, ConnectorTokenRecord>()

  async load(connector: ConnectorKind): Promise<ConnectorTokenRecord | null> {
    return this.records.get(connector) ?? null
  }

  async save(record: ConnectorTokenRecord): Promise<void> {
    this.records.set(record.connector, record)
  }

  async clear(connector: ConnectorKind): Promise<void> {
    this.records.delete(connector)
  }
}

/**
 * The fail-closed store: there is no secure storage, so nothing persists.
 *
 * This is what a host supplies when `safeStorage` is unavailable. A connector
 * that tries to authorize against it is refused with a stated reason, which is
 * the truthful outcome: better `credentials-missing` than a token on disk.
 */
export class NullConnectorTokenStore implements ConnectorTokenStore {
  readonly kind = 'unavailable' as const
  constructor(readonly reason: string = 'this machine has no OS secure storage available') {}

  async load(_connector: ConnectorKind): Promise<ConnectorTokenRecord | null> {
    void _connector
    return null
  }

  async save(_record: ConnectorTokenRecord): Promise<void> {
    void _record
    throw new TokenStoreUnavailableError(this.reason)
  }

  async clear(_connector: ConnectorKind): Promise<void> {
    void _connector
    // Nothing to clear: the store never held anything.
  }
}

/**
 * A token record with every secret replaced by a length marker.
 *
 * The one function that may be handed a record outside the adapter that owns
 * it, so a diagnostic can say a token exists and how long it is without ever
 * printing it. `accessToken` and `refreshToken` are reduced to a presence flag.
 */
export function redactTokenRecord(record: ConnectorTokenRecord): {
  connector: ConnectorKind
  accountLabel: string
  scopes: readonly string[]
  hasAccessToken: boolean
  hasRefreshToken: boolean
  expiresAt: string | null
  storedAt: string
} {
  return {
    connector: record.connector,
    accountLabel: record.accountLabel,
    scopes: record.scopes,
    hasAccessToken: record.accessToken.length > 0,
    hasRefreshToken: record.refreshToken !== null && record.refreshToken.length > 0,
    expiresAt: record.expiresAt,
    storedAt: record.storedAt,
  }
}
