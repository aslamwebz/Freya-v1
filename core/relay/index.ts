/**
 * THE RELAY DOMAIN — Phase 16.
 *
 * Email, calendar, GitHub and external connectors through bounded capabilities
 * rather than raw account access. Relay is a capability-gated transport and
 * control plane: it is not a credential vault, and it is not a model-controlled
 * account bridge.
 *
 * | File | Owns |
 * | --- | --- |
 * | `types.ts` | The closed vocabularies — connectors, actions, statuses, risk, failure codes, limits. |
 * | `validation.ts` | Strict normalization of addresses, repo refs, recipients, attachments, pagination and payload sizes. |
 * | `adapters.ts` | The narrow adapter ports and the deterministic offline fakes. |
 * | `state.ts` | The fold of `relay.*` events — actions, approvals, idempotency keys, budget instants. |
 * | `engine.ts` | The one impure piece: gates, idempotency, retry, approval, adapter calls, journal appends. |
 * | `projection.ts` | The only route from domain facts to a window. |
 *
 * The engine holds no gateway, no authority object and no provider. It cannot
 * spend a model call, mint a capability or clear STOP ALL. A model may propose
 * a Relay action in conversation; it cannot execute one, because the only
 * execution door is a Core command a renderer reaches through the bridge.
 */

export * from './types'
export * from './validation'
export * from './adapters'
export * from './state'
export * from './engine'
export * from './projection'
