/**
 * The release shipping scope.
 *
 * A release has to say what it claims. This is that sentence, written down per
 * capability so a machine can check it:
 *
 *   - `shipping` — the release claims this capability runs in this build. If its
 *     readiness is anything other than `active` or `degraded`, the release does not
 *     ship. A reduced (`degraded`) capability does not block: a Brain with no Vault
 *     key still serves the owner, and the report says so in words.
 *   - `not-shipping` — the release makes no claim. The capability is still inventoried
 *     and still reported; it simply cannot be used to justify a green light.
 *
 * The distinction matters because "everything in the repository is running" is not a
 * claim any honest build can make, and a gate that demanded it would be a gate that
 * always fails — which teaches people to ignore it. What has to be true is that every
 * capability the release *says* it ships is genuinely running, and that every
 * capability it does not claim is named rather than quietly dropped.
 *
 * The list mirrors the runtime registry's own `activation: 'core-owned'` set. It is
 * declared separately rather than derived, because the registry answers "what may be
 * activated", and this answers "what does the release promise". `tests/qualification/
 * scope.test.ts` asserts the two sets stay consistent, so neither can grow alone.
 */

import { READINESS_STATES, isRunningReadiness, type ReadinessState } from './types'

export type ShippingClaim = 'shipping' | 'not-shipping'

export interface ShippingDeclaration {
  readonly id: string
  readonly claim: ShippingClaim
  /** Why this claim, in one sentence. */
  readonly reason: string
}

function declare(id: string, claim: ShippingClaim, reason: string): ShippingDeclaration {
  return Object.freeze({ id, claim, reason })
}

/**
 * What the release promises.
 *
 * Grouped the way the report reads: the security spine first, then the Core-owned
 * lanes, then the capabilities the release explicitly does not claim.
 */
export const SHIPPING_SCOPE: readonly ShippingDeclaration[] = Object.freeze([
  /* The spine. Nothing ships if this does not run. */
  declare('core.security-spine', 'shipping', 'the authority path every other lane is gated through'),
  declare('core.vault', 'shipping', 'the one encrypted store; a missing key degrades it, it does not remove it'),

  /* Core-owned lanes. */
  declare('core.missions', 'shipping', 'owned and started by the Core composition root'),
  declare('core.work', 'shipping', 'owned and started by the Core composition root'),
  declare('core.conversation', 'shipping', 'owned; a missing keyring entry degrades it to a non-durable transcript'),
  declare('core.context', 'shipping', 'owned and started by the Core composition root'),
  declare('core.workforce', 'shipping', 'owned; subordinate agents hold no authority'),
  declare('core.brain', 'shipping', 'owned; a missing keyring entry degrades it to non-durable memory'),
  declare('core.personality', 'shipping', 'owned; a missing key degrades expression guidance, never the memory'),
  declare('core.attention', 'shipping', 'owned and deterministic; it reaches no model on its own'),
  declare('core.office', 'shipping', 'owned and a pure projection of real state'),
  declare('core.relay', 'shipping', 'owned; a connector-less relay is degraded, not absent'),
  declare('core.skills', 'shipping', 'owned; a skill body never enters runtime code'),
  declare('core.voice', 'shipping', 'owned; with no local engine it is degraded and no cloud engine is implied'),
  declare('core.world', 'shipping', 'owned; evidence shares the one Vault'),
  declare('core.life', 'shipping', 'owned and derived; a Life fault never moves the security posture'),
  declare('core.consciousness', 'shipping', 'owned and derived; it is stored nowhere'),
  declare('core.lifeloop', 'shipping', 'owned; zero idle inference is a property of the loop, not a setting'),
  declare('core.foundry', 'shipping', 'owned; activating an artifact grants no authority'),

  /* Not claimed by this release. Inventoried and reported, never counted as shipped. */
  declare(
    'core.long-horizon',
    'not-shipping',
    'the continuation subsystem is not wired into Core, so the domain is implemented and not activated',
  ),
  declare(
    'core.economic',
    'not-shipping',
    'fail-closed: paper research, simulation and paper trading only; no real-money authority exists',
  ),
  declare(
    'core.enterprise',
    'not-shipping',
    'fail-closed: bounded workflows only; no spending authority and no hidden inference',
  ),
  declare(
    'core.multidevice',
    'not-shipping',
    'no device transport and no enrolled trusted device exist, and neither is invented to fill the gap',
  ),
  declare(
    'core.resilience',
    'not-shipping',
    'the dedicated recovery-journal seam is not satisfied, so self-recovery is not activated',
  ),
  declare(
    'core.sovereignty',
    'not-shipping',
    'registered and dependency-checked; no handler is wired, so it is available and not running',
  ),
  declare(
    'core.evolution',
    'not-shipping',
    'registered and dependency-checked; no handler is wired, so it is available and not running',
  ),
  declare(
    'core.threshold',
    'not-shipping',
    'a measurement framework, not an authority source; no handler is wired',
  ),
  declare(
    'core.device-hands',
    'not-shipping',
    'the runtime domain is declared blocked by the registry itself, because a real capability grant is the owner\'s to create at run time; the Phase 42 host seam is genuinely wired and is qualified by the device-hands gate, and that gate evidence is reported separately from this readiness',
  ),
  declare(
    'core.browserext',
    'not-shipping',
    'the runtime domain is declared fail-closed by the registry itself; the Phase 43 host seam is genuinely wired and is qualified by the browser-extension gate, which proves pairing, read-only observation and the refusal of every act',
  ),
])

const SCOPE_BY_ID: ReadonlyMap<string, ShippingDeclaration> = new Map(
  SHIPPING_SCOPE.map((declaration) => [declaration.id, declaration]),
)

export function shippingClaimFor(id: string): ShippingDeclaration | undefined {
  return SCOPE_BY_ID.get(id)
}

export function shippingCapabilities(): readonly ShippingDeclaration[] {
  return SHIPPING_SCOPE.filter((declaration) => declaration.claim === 'shipping')
}

export function notShippingCapabilities(): readonly ShippingDeclaration[] {
  return SHIPPING_SCOPE.filter((declaration) => declaration.claim === 'not-shipping')
}

/**
 * The capabilities whose readiness must be `active` or `degraded`.
 *
 * These are not "every domain that happens to be switched on". These are the domains
 * the release has said are running, so a reviewer can hold it to that sentence.
 */
export function shippingReadinessFloor(): readonly ReadinessState[] {
  return ['active', 'degraded']
}

export function satisfiesShippingClaim(readiness: ReadinessState): boolean {
  return isRunningReadiness(readiness)
}

/** Readiness states that are not a running state, kept for the report's own wording. */
export function nonRunningReadiness(): readonly ReadinessState[] {
  return READINESS_STATES.filter((state) => !isRunningReadiness(state))
}