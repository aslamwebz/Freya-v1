/**
 * THE CONNECTOR DOMAIN — Phase 44.
 *
 * | File | Owns |
 * | --- | --- |
 * | `types.ts` | The closed vocabularies — providers, states, authorities, failure codes, limits, records. |
 * | `catalog.ts` | The five provider definitions and their explicit minimal scopes. |
 * | `policy.ts` | The closed connector-action vocabulary and its Relay mapping. |
 * | `auth.ts` | OAuth state/nonce/PKCE and the callback check. |
 * | `token-store.ts` | The host-side secure-store seam, the memory and fail-closed stores, redaction. |
 * | `validation.ts` | Strict normalization of connector command payloads. |
 * | `state.ts` | The fold of `connector.*` events — connections, requests, events, dedupe. |
 * | `engine.ts` | The one impure piece: connection lifecycle, policy, and delegation to Relay. |
 * | `projection.ts` | The only route from connector facts to a window. |
 *
 * The engine holds no token store, no HTTP client and no provider. It holds an
 * `authPort` the host supplied (which returns only a URL and a status) and an
 * `actionPort` that is Relay, so there is no second approval system and no path
 * from a connector to a credential.
 */

export * from './types'
export * from './catalog'
export * from './policy'
export * from './auth'
export * from './token-store'
export * from './validation'
export * from './state'
export * from './engine'
export * from './projection'
