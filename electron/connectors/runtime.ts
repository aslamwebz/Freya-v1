/**
 * THE CONNECTOR RUNTIME — the host's assembly of the connection plane.
 *
 * It builds the secure token store, the OAuth coordinator and the bounded
 * provider adapters, and exposes the narrow `ConnectorAuthPort` Core holds.
 * Core never sees the token store, the coordinator or the adapters: it sees a
 * port that returns a URL and a status, and an adapter set Relay calls.
 *
 * With no client credentials configured, every connector reports `unconfigured`
 * and every adapter refuses because no token exists. Nothing is simulated.
 */

import type { RelayAdapterSet } from '../../core/relay/adapters'
import type { ConnectorAuthPort } from '../../core/connectors/engine'
import type { ConnectorKind } from '../../core/connectors/types'
import { createBoundedAdapters } from './adapters'
import { ConnectorOAuthCoordinator, type OAuthClient, type OAuthProviderConfig } from './oauth'
import { createSecureTokenStore, type SecureStorageLike } from './token-store'
import type { FetchLike } from './http'

export interface ConnectorRuntimeOptions {
  /**
   * Electron's `safeStorage`, or a test double. Absent means no secure storage,
   * so the runtime is fail-closed and cannot persist a token.
   */
  safeStorage?: SecureStorageLike
  /** Where the encrypted token file lives. Derived from the Core data path. */
  tokenFilePath: string
  /** Per-provider OAuth configuration. A missing provider is unconfigured. */
  configs: Readonly<Partial<Record<ConnectorKind, OAuthProviderConfig>>>
  /** The HTTP seam for token exchange and refresh. */
  oauthClient: OAuthClient
  /** The HTTP seam for provider adapters. */
  fetchImpl: FetchLike
  now?: () => Date
  random?: (size: number) => Uint8Array
}

export interface ConnectorRuntime {
  /** The narrow port Core holds. Returns a URL and a status — never a token. */
  auth: ConnectorAuthPort
  /** The bounded adapters Relay calls. */
  adapters: RelayAdapterSet
  /** The host's own handle, for refresh and callback completion. */
  coordinator: ConnectorOAuthCoordinator
  /** The token store's honest description of its protection. */
  storeKind: 'secure' | 'memory' | 'unavailable'
  storeReason: string | null
}

/**
 * Build the runtime.
 *
 * `hydrate()` loads only token *presence* at startup, so a connector whose
 * token survived a restart reports its stored state; a connector whose token is
 * gone reports `credentials-missing`.
 */
export async function createConnectorRuntime(options: ConnectorRuntimeOptions): Promise<ConnectorRuntime> {
  const tokenStore = options.safeStorage === undefined
    ? createSecureTokenStore({
        // An explicitly unavailable backend. `createSecureTokenStore` returns a
        // NullConnectorTokenStore, which is the fail-closed behaviour.
        safeStorage: {
          isEncryptionAvailable: () => false,
          encryptString: () => Buffer.alloc(0),
          decryptString: () => '',
        },
        filePath: options.tokenFilePath,
      })
    : createSecureTokenStore({ safeStorage: options.safeStorage, filePath: options.tokenFilePath })

  const coordinator = new ConnectorOAuthCoordinator({
    tokenStore,
    client: options.oauthClient,
    configs: options.configs,
    now: options.now,
    ...(options.random === undefined ? {} : { random: options.random }),
  })
  await coordinator.hydrate()

  const auth: ConnectorAuthPort = {
    describe(connector) {
      const configured = coordinator.configured(connector)
      if (!configured) {
        return {
          configured: false,
          tokenPresent: false,
          reason: 'no client credentials are configured for this connector',
        }
      }
      return { configured: true, tokenPresent: coordinator.tokenPresent(connector), reason: null }
    },
    async beginAuthorization(input) {
      if (coordinator.storeKind === 'unavailable') {
        return { ok: false, reason: coordinator.storeReason ?? 'no secure token store is available' }
      }
      return coordinator.begin(input.connector, input.requestId, input.scopes)
    },
    async disconnect(connector) {
      await coordinator.disconnect(connector)
    },
  }

  return {
    auth,
    adapters: createBoundedAdapters({ tokenStore, fetchImpl: options.fetchImpl }),
    coordinator,
    storeKind: tokenStore.kind,
    storeReason: tokenStore.reason,
  }
}
