/**
 * THE SENSES REFUSAL VOCABULARY — why a capability action was refused.
 *
 * A refusal is terminal: it is not a failure to retry and not a result to
 * verify. The set of codes is closed, because a code a caller can invent is
 * decoration; each code names exactly one owner in the admission pipeline.
 */

import { PHASE25_LIMITS, type CapabilityActionRefusal, type Phase25CapabilityKind } from './types'

/**
 * Why a capability action was refused.
 *
 * - `stop_all` — the STOP ALL latch, which outranks everything;
 * - `invalid_context` — the admission context is not well-formed;
 * - `capability_unknown` — the kind is not one this build knows;
 * - `action_unsupported` — the kind does not accept that action;
 * - `invalid_input` — the input failed exact-key/type/bound validation;
 * - `capability_unauthorized` — the caller's facts or Guard say no;
 * - `governor_denied` — cognition was required and no grant covered it;
 * - `budget_exceeded` — the remaining budget is short of the action's cost;
 * - `approval_required` — the action needs an approval that is not present.
 */
export const SENSES_REFUSAL_CODES = [
  'stop_all',
  'invalid_context',
  'capability_unknown',
  'action_unsupported',
  'invalid_input',
  'capability_unauthorized',
  'governor_denied',
  'budget_exceeded',
  'approval_required',
] as const
export type SensesRefusalCode = (typeof SENSES_REFUSAL_CODES)[number]

export function isSensesRefusalCode(value: unknown): value is SensesRefusalCode {
  return typeof value === 'string' && (SENSES_REFUSAL_CODES as readonly string[]).includes(value)
}

/** Why a code is a refusal, in words a person can act on. */
export const SENSES_REFUSAL_REASONS: Readonly<Record<SensesRefusalCode, string>> = Object.freeze({
  stop_all: 'STOP ALL is active: no capability action is admitted',
  invalid_context: 'the admission context is not well-formed',
  capability_unknown: 'that is not a capability kind this Core knows',
  action_unsupported: 'that capability does not accept that action',
  invalid_input: 'the action input is not valid',
  capability_unauthorized: 'the caller is not authorised to use that capability',
  governor_denied: 'cognition was required and no grant covered it',
  budget_exceeded: 'the remaining budget is below the cost of this action',
  approval_required: 'this action requires an approval that has not been granted',
})

/**
 * Build a terminal refusal.
 *
 * The reason defaults to the code's table entry; a `detail` replaces it when
 * the deciding layer can say something more actionable. The record is frozen:
 * a refusal cannot be softened after the fact.
 */
export function refuseCapabilityAction(
  actionId: string,
  capabilityKind: Phase25CapabilityKind | null,
  code: SensesRefusalCode,
  refusedAt: string,
  detail?: string,
): CapabilityActionRefusal {
  const reason = (detail ?? SENSES_REFUSAL_REASONS[code]).slice(0, PHASE25_LIMITS.maxInputBytes)
  return Object.freeze({
    actionId,
    code,
    reason,
    capabilityKind,
    refusedAt,
    terminal: true as const,
  })
}
