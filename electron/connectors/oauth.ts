/**
 * THE CONNECTOR OAUTH COORDINATOR — the host's authorization flow.
 *
 * It builds an authorization URL from a provider config, holds the state, nonce
 * and PKCE verifier for each pending request, verifies the callback that comes
 * back, exchanges the code for tokens through an injected client, and writes the
 * result to the secure token store. The tokens never leave this module except
 * into the store.
 *
 * ## Serialized refresh
 *
 * A refresh is the one operation two concurrent callers can race. Each
 * connector's refreshes are chained through a per-connector promise, so a
 * second caller waits for the first and reuses its result rather than spending
 * the refresh token twice — which, for providers that rotate refresh tokens,
 * would invalidate the connector.
 *
 * ## Fail-closed
 *
 * No config, no secure store, no pending request or a callback whose state does
 * not match are all refusals with a stated reason. Nothing is exchanged on a
 * callback that did not verify.
 */

import { createAuthRequest, verifyAuthCallback, type AuthRequest, type AuthCallback } from '../../core/connectors/auth'
import type { ConnectorTokenRecord, ConnectorTokenStore } from '../../core/connectors/token-store'
import type { ConnectorFailureCode, ConnectorKind } from '../../core/connectors/types'

export interface OAuthProviderConfig {
  readonly connector: ConnectorKind
  readonly authorizationEndpoint: string
  readonly tokenEndpoint: string
  readonly clientId: string
  readonly clientSecret: string | null
  readonly redirectUri: string
  readonly extraAuthParams?: Readonly<Record<string, string>>
}

/** What an exchange or refresh returned. Never logged. */
export interface OAuthTokenResponse {
  readonly accessToken: string
  readonly refreshToken: string | null
  readonly expiresInSeconds: number | null
  /** A display label the provider returned. Never a credential. */
  readonly accountLabel: string
  readonly scopes: readonly string[]
}

/** The HTTP seam, injected so the coordinator is testable offline. */
export interface OAuthClient {
  exchange(input: { config: OAuthProviderConfig; code: string; codeVerifier: string }): Promise<OAuthTokenResponse>
  refresh(input: { config: OAuthProviderConfig; refreshToken: string }): Promise<OAuthTokenResponse>
}

export interface ConnectorOAuthCoordinatorOptions {
  tokenStore: ConnectorTokenStore
  client: OAuthClient
  configs: Readonly<Partial<Record<ConnectorKind, OAuthProviderConfig>>>
  now?: () => Date
  newId?: () => string
  random?: (size: number) => Uint8Array
}

export type OAuthBeginResult =
  | { readonly ok: true; readonly authorizationUrl: string }
  | { readonly ok: false; readonly reason: string }

export type OAuthCompleteResult =
  | { readonly ok: true; readonly record: ConnectorTokenRecord }
  | { readonly ok: false; readonly failureCode: ConnectorFailureCode; readonly reason: string }

export class ConnectorOAuthCoordinator {
  private readonly tokenStore: ConnectorTokenStore
  private readonly client: OAuthClient
  private readonly configs: Readonly<Partial<Record<ConnectorKind, OAuthProviderConfig>>>
  private readonly now: () => Date
  private readonly random: ((size: number) => Uint8Array) | undefined
  private readonly pending = new Map<string, AuthRequest>()
  private readonly present = new Set<ConnectorKind>()
  private readonly refreshing = new Map<ConnectorKind, Promise<ConnectorTokenRecord | null>>()

  constructor(options: ConnectorOAuthCoordinatorOptions) {
    this.tokenStore = options.tokenStore
    this.client = options.client
    this.configs = options.configs
    this.now = options.now ?? (() => new Date())
    this.random = options.random
  }

  /** Whether a provider has client credentials configured. */
  configured(connector: ConnectorKind): boolean {
    const config = this.configs[connector]
    return config !== undefined && config.clientId.length > 0
  }

  /** Whether a stored token is present, from the sync cache. */
  tokenPresent(connector: ConnectorKind): boolean {
    return this.present.has(connector)
  }

  /** Load the stored token presence at startup. Never returns a token. */
  async hydrate(): Promise<void> {
    for (const connector of Object.keys(this.configs) as ConnectorKind[]) {
      const record = await this.tokenStore.load(connector)
      if (record !== null) this.present.add(connector)
    }
  }

  /** Build an authorization URL and hold the request's secrets host-side. */
  begin(connector: ConnectorKind, requestId: string, scopes: readonly string[]): OAuthBeginResult {
    const config = this.configs[connector]
    if (config === undefined || config.clientId.length === 0) {
      return { ok: false, reason: 'no client credentials are configured for this connector' }
    }
    const request = createAuthRequest({
      requestId,
      connector,
      now: this.now(),
      ...(this.random === undefined ? {} : { random: this.random }),
    })
    this.pending.set(requestId, request)
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: scopes.join(' '),
      state: request.state,
      nonce: request.nonce,
      code_challenge: request.codeChallenge,
      code_challenge_method: 'S256',
      ...(config.extraAuthParams ?? {}),
    })
    return { ok: true, authorizationUrl: `${config.authorizationEndpoint}?${params.toString()}` }
  }

  /**
   * Verify a callback and exchange its code.
   *
   * The pending request is consumed on any outcome, so a replayed callback
   * finds no request and is refused rather than exchanging the code twice.
   */
  async complete(input: { connector: ConnectorKind; callback: AuthCallback }): Promise<OAuthCompleteResult> {
    const config = this.configs[input.connector]
    if (config === undefined || config.clientId.length === 0) {
      return { ok: false, failureCode: 'unconfigured', reason: 'no client credentials are configured for this connector' }
    }
    const request = [...this.pending.values()].find((entry) => entry.connector === input.connector)
    if (request === undefined) {
      return { ok: false, failureCode: 'invalid_request', reason: 'no authorization was in progress for this connector' }
    }
    const verdict = verifyAuthCallback(request, input.callback, this.now())
    this.pending.delete(request.requestId)
    if (!verdict.ok) {
      return { ok: false, failureCode: verdict.failureCode, reason: verdict.reason }
    }
    let response: OAuthTokenResponse
    try {
      response = await this.client.exchange({ config, code: input.callback.code, codeVerifier: request.codeVerifier })
    } catch {
      return { ok: false, failureCode: 'provider_error', reason: 'the authorization code could not be exchanged' }
    }
    const record: ConnectorTokenRecord = {
      connector: input.connector,
      accountLabel: response.accountLabel,
      scopes: [...response.scopes],
      accessToken: response.accessToken,
      refreshToken: response.refreshToken,
      expiresAt: response.expiresInSeconds === null ? null : new Date(this.now().getTime() + response.expiresInSeconds * 1000).toISOString(),
      storedAt: this.now().toISOString(),
    }
    try {
      await this.tokenStore.save(record)
    } catch {
      return { ok: false, failureCode: 'secret_store_unavailable', reason: 'the credential could not be stored securely' }
    }
    this.present.add(input.connector)
    return { ok: true, record }
  }

  /**
   * Refresh a connector's token, serialized per connector.
   *
   * A concurrent caller joins the in-flight refresh rather than starting a
   * second one. A connector with no refresh token is left as-is.
   */
  async refresh(connector: ConnectorKind): Promise<ConnectorTokenRecord | null> {
    const inFlight = this.refreshing.get(connector)
    if (inFlight !== undefined) return inFlight
    const task = this.doRefresh(connector)
    this.refreshing.set(connector, task)
    try {
      return await task
    } finally {
      this.refreshing.delete(connector)
    }
  }

  private async doRefresh(connector: ConnectorKind): Promise<ConnectorTokenRecord | null> {
    const config = this.configs[connector]
    if (config === undefined) return null
    const existing = await this.tokenStore.load(connector)
    if (existing === null || existing.refreshToken === null) return existing
    let response: OAuthTokenResponse
    try {
      response = await this.client.refresh({ config, refreshToken: existing.refreshToken })
    } catch {
      return existing
    }
    const record: ConnectorTokenRecord = {
      connector,
      accountLabel: response.accountLabel,
      scopes: [...response.scopes],
      accessToken: response.accessToken,
      refreshToken: response.refreshToken ?? existing.refreshToken,
      expiresAt: response.expiresInSeconds === null ? null : new Date(this.now().getTime() + response.expiresInSeconds * 1000).toISOString(),
      storedAt: this.now().toISOString(),
    }
    try {
      await this.tokenStore.save(record)
    } catch {
      return existing
    }
    this.present.add(connector)
    return record
  }

  /** Clear the stored token and any pending request. */
  async disconnect(connector: ConnectorKind): Promise<void> {
    for (const [requestId, request] of this.pending) {
      if (request.connector === connector) this.pending.delete(requestId)
    }
    this.present.delete(connector)
    await this.tokenStore.clear(connector)
  }

  /** The store's honest description of its protection. */
  get storeKind(): ConnectorTokenStore['kind'] {
    return this.tokenStore.kind
  }

  get storeReason(): string | null {
    return this.tokenStore.reason
  }
}
