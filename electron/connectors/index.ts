/**
 * THE HOST CONNECTOR RUNTIME — Phase 44's main-process half.
 *
 * | File | Owns |
 * | --- | --- |
 * | `token-store.ts` | The keyring-backed secure store and its fail-closed fallback. |
 * | `oauth.ts` | The OAuth flow: state, nonce, PKCE, callback verification, serialized refresh. |
 * | `http.ts` | The bounded HTTP client: host allowlist, timeout, response ceiling. |
 * | `adapters.ts` | The five bounded provider adapters. |
 * | `runtime.ts` | The assembly, and the narrow `ConnectorAuthPort` Core holds. |
 *
 * Core never sees a token: it sees a port that returns a URL and a status.
 */

export * from './token-store'
export * from './oauth'
export * from './http'
export * from './adapters'
export * from './runtime'
