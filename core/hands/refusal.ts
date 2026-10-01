/**
 * THE HANDS REFUSAL — unsupported and unauthorized capability refusal shapes.
 *
 * This file provides the factory functions for creating refusals. Each refusal
 * is a terminal outcome: it is not a failure that can be retried, and it is not
 * a success that can be verified. It carries a closed code and a human-readable
 * reason, and nothing else.
 *
 * ## What is deliberately enforced
 *
 * - **A refusal is not an action result.** The two are distinct types because
 *   "the action was refused" and "the action was attempted and failed" are
 *   different facts with different consequences.
 * - **A refusal is not a verification result.** A refusal means the action was
 *   never attempted, so there is nothing to verify.
 * - **Capability possession does not imply authority.** A caller may hold a
 *   capability id and still be refused. The refusal is based on whether the
 *   caller is authorised to use the capability, not on whether it possesses it.
 */

import type { HandsActionRefusal, HandsCapabilityId } from './contract'
import { HANDS_REFUSAL_REASONS, type HandsRefusalCode } from './types'

/**
 * Create a refusal.
 *
 * A pure function that creates a `HandsActionRefusal` from a code and optional
 * capability id. The reason is derived from the code, not supplied by the
 * caller, so a refusal reason is always one the Core has chosen.
 */
export function createHandsRefusal(
  actionId: string,
  code: HandsRefusalCode,
  capabilityId: HandsCapabilityId | null,
  refusedAt: string,
): HandsActionRefusal {
  return {
    actionId,
    code,
    reason: HANDS_REFUSAL_REASONS[code],
    capabilityId,
    refusedAt,
  }
}

/**
 * Create a refusal for an unsupported capability.
 *
 * The capability kind is not one this Core knows. This is a terminal refusal:
 * the action was never attempted, and there is nothing to verify.
 */
export function refuseUnsupportedCapability(
  actionId: string,
  capabilityId: HandsCapabilityId | null,
  refusedAt: string,
): HandsActionRefusal {
  return createHandsRefusal(actionId, 'capability_unknown', capabilityId, refusedAt)
}

/**
 * Create a refusal for a deferred capability.
 *
 * The capability kind is known but not routed in this build. This is a terminal
 * refusal: the action was never attempted, and there is nothing to verify.
 */
export function refuseDeferredCapability(
  actionId: string,
  capabilityId: HandsCapabilityId | null,
  refusedAt: string,
): HandsActionRefusal {
  return createHandsRefusal(actionId, 'capability_deferred', capabilityId, refusedAt)
}

/**
 * Create a refusal for an unauthorized capability.
 *
 * The caller does not hold the capability it named. This is a terminal refusal:
 * the action was never attempted, and there is nothing to verify.
 *
 * **Capability possession does not imply authority.** A caller may hold a
 * capability id and still be refused. The refusal is based on whether the
 * caller is authorised to use the capability, not on whether it possesses it.
 */
export function refuseUnauthorizedCapability(
  actionId: string,
  capabilityId: HandsCapabilityId | null,
  refusedAt: string,
): HandsActionRefusal {
  return createHandsRefusal(actionId, 'capability_unauthorized', capabilityId, refusedAt)
}

/**
 * Create a refusal for an invalid envelope.
 *
 * The action envelope failed exact-key validation. This is a terminal refusal:
 * the action was never attempted, and there is nothing to verify.
 */
export function refuseInvalidEnvelope(
  actionId: string,
  refusedAt: string,
): HandsActionRefusal {
  return createHandsRefusal(actionId, 'invalid_envelope', null, refusedAt)
}

/**
 * Create a refusal for an invalid request.
 *
 * The action request failed schema validation. This is a terminal refusal: the
 * action was never attempted, and there is nothing to verify.
 */
export function refuseInvalidRequest(
  actionId: string,
  refusedAt: string,
): HandsActionRefusal {
  return createHandsRefusal(actionId, 'invalid_request', null, refusedAt)
}

/**
 * Create a refusal for a budget exceeded.
 *
 * The action budget was exceeded. This is a terminal refusal: the action was
 * never attempted, and there is nothing to verify.
 */
export function refuseBudgetExceeded(
  actionId: string,
  capabilityId: HandsCapabilityId | null,
  refusedAt: string,
): HandsActionRefusal {
  return createHandsRefusal(actionId, 'budget_exceeded', capabilityId, refusedAt)
}

/**
 * Create a refusal for a timeout exceeded.
 *
 * The action timeout was exceeded. This is a terminal refusal: the action was
 * never attempted, and there is nothing to verify.
 */
export function refuseTimeoutExceeded(
  actionId: string,
  capabilityId: HandsCapabilityId | null,
  refusedAt: string,
): HandsActionRefusal {
  return createHandsRefusal(actionId, 'timeout_exceeded', capabilityId, refusedAt)
}
