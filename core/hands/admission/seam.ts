/**
 * THE HANDS DECISION SEAM — where Guard and Governor are asked.
 *
 * The controller in this folder validates, resolves and bounds; the *decision*
 * about authority belongs to Guard and the decision about allowance belongs to
 * the Governor, and both are reached only through the interfaces below. Keeping
 * the seam explicit is what makes the separation structural rather than a
 * naming convention: the controller has no branch that admits an action
 * because it looked reasonable.
 *
 * ## What the seam is handed — and what it is not
 *
 * Claims carry ids, scopes, instants and measured counts. They never carry the
 * action's `input`, because input is untrusted content from a tool, a page or a
 * context: content cannot argue its way into a claim. The caller's facts
 * (`trusted`, `heldCapabilities`) arrive from the trusted pathway, and even
 * then possession is only *evidence for Guard*, never a verdict.
 *
 * ## Defaults are deny-by-default
 *
 * {@link defaultHandsGuard} and {@link defaultHandsGovernor} apply the real
 * policy: an untrusted principal holds nothing, a capability outside the
 * caller's own scope is refused, a missing/revoked/expired grant is refused,
 * and a budget at its bound is refused. The controller additionally enforces
 * the latch, the caller facts, the grant instants and the bounds itself, so a
 * permissive injected seam still cannot admit past them.
 */

import type { HandsScopedCapabilityRef } from '../contract'
import type { HandsAdmissionBudget, HandsAdmissionCaller, HandsAdmissionGrant } from './types'

/* ---------------------------------------------------------------- guard */

/** What Guard is asked: who is asking, for what, in which scope. */
export interface HandsGuardClaim {
  readonly principalId: string
  readonly trusted: boolean
  /** Possession, for Guard to weigh — never authority by itself. */
  readonly heldCapabilities: readonly string[]
  readonly capabilityRef: HandsScopedCapabilityRef
  /** The scope the caller is acting in, from the trusted pathway. */
  readonly callerScope: string
  readonly action: string
}

export type HandsGuardVerdict =
  | { readonly allowed: true; readonly reason: string }
  | { readonly allowed: false; readonly reason: string }

/** The Guard half of the seam. One capability request, one principal. */
export interface HandsGuardSeam {
  evaluate(claim: HandsGuardClaim): HandsGuardVerdict
}

/* ------------------------------------------------------------- governor */

/** What the Governor is asked: under which grant, against which budget, when. */
export interface HandsGovernorClaim {
  readonly actionId: string
  readonly capabilityRef: HandsScopedCapabilityRef
  readonly grant: HandsAdmissionGrant | null
  readonly budget: HandsAdmissionBudget
  readonly timeoutMs: number
  readonly now: string
}

/** The only codes a Governor denial may name. */
export type HandsGovernorDenialCode = 'expired_grant' | 'over_budget'

export type HandsGovernorVerdict =
  | { readonly outcome: 'allow'; readonly reason: string }
  | {
      readonly outcome: 'deny'
      readonly code: HandsGovernorDenialCode
      readonly reason: string
    }

/** The Governor half of the seam. One admission request, one verdict. */
export interface HandsGovernorSeam {
  evaluate(claim: HandsGovernorClaim): HandsGovernorVerdict
}

/**
 * The seam the controller consults before anything can be admitted.
 *
 * Both halves are required: there is no configuration in which an action is
 * admitted without a Guard verdict and a Governor verdict.
 */
export interface HandsAdmissionSeam {
  readonly guard: HandsGuardSeam
  readonly governor: HandsGovernorSeam
}

/* --------------------------------------------------------------- defaults */

/**
 * Guard's default policy.
 *
 * Deny by default: an untrusted principal carries no authority whatever it
 * claims to hold, a capability named outside the caller's own scope is a scope
 * confusion rather than an elevation, and possession is checked last — because
 * holding a capability is the *weakest* of the three claims.
 */
export const defaultHandsGuard: HandsGuardSeam = {
  evaluate(claim: HandsGuardClaim): HandsGuardVerdict {
    if (!claim.trusted) {
      return { allowed: false, reason: 'the principal is not trusted' }
    }
    if (claim.capabilityRef.scope !== claim.callerScope) {
      return {
        allowed: false,
        reason: 'the capability was named in a scope the caller is not acting in',
      }
    }
    if (!claim.heldCapabilities.includes(claim.capabilityRef.capabilityId)) {
      return { allowed: false, reason: 'the caller does not hold the capability it named' }
    }
    return { allowed: true, reason: 'the caller holds the capability in its own scope' }
  },
}

/**
 * The Governor's default policy.
 *
 * Deny by default: no grant means no action, a revoked or expired grant is a
 * refusal rather than a prompt, and a budget at its bound refuses rather than
 * queues — a queue nobody drains is a silent admission.
 */
export const defaultHandsGovernor: HandsGovernorSeam = {
  evaluate(claim: HandsGovernorClaim): HandsGovernorVerdict {
    const grant = claim.grant
    if (grant === null) {
      return { outcome: 'deny', code: 'expired_grant', reason: 'no grant covers this action' }
    }
    if (grant.revokedAt !== null) {
      return { outcome: 'deny', code: 'expired_grant', reason: 'the grant was revoked' }
    }
    if (!(Date.parse(grant.expiresAt) > Date.parse(claim.now))) {
      return { outcome: 'deny', code: 'expired_grant', reason: 'the grant has expired' }
    }
    if (claim.budget.inFlightActions >= claim.budget.maxConcurrentActions) {
      return {
        outcome: 'deny',
        code: 'over_budget',
        reason: 'the concurrency bound for admitted actions is reached',
      }
    }
    if (claim.budget.admittedActions >= claim.budget.maxAdmittedActions) {
      return {
        outcome: 'deny',
        code: 'over_budget',
        reason: 'the session admission cap is reached',
      }
    }
    return { outcome: 'allow', reason: 'within the grant and the bounded budget' }
  },
}

/** The seam used when a caller supplies none: the real policy, not a bypass. */
export const defaultHandsAdmissionSeam: HandsAdmissionSeam = {
  guard: defaultHandsGuard,
  governor: defaultHandsGovernor,
}

/** Whether a value has the shape of a seam. Checked before any consultation. */
export function isHandsAdmissionSeam(value: unknown): value is HandsAdmissionSeam {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { guard?: unknown; governor?: unknown }
  const half = (part: unknown): boolean =>
    typeof part === 'object' &&
    part !== null &&
    typeof (part as { evaluate?: unknown }).evaluate === 'function'
  return half(candidate.guard) && half(candidate.governor)
}

/** The claim built for Guard from a caller and a validated request. */
export function guardClaim(
  caller: HandsAdmissionCaller,
  capabilityRef: HandsScopedCapabilityRef,
  action: string,
): HandsGuardClaim {
  return {
    principalId: caller.principalId,
    trusted: caller.trusted,
    heldCapabilities: caller.heldCapabilities,
    capabilityRef,
    callerScope: caller.scope,
    action,
  }
}

/** The claim built for the Governor from the validated admission context. */
export function governorClaim(args: {
  actionId: string
  capabilityRef: HandsScopedCapabilityRef
  grant: HandsAdmissionGrant | null
  budget: HandsAdmissionBudget
  timeoutMs: number
  now: string
}): HandsGovernorClaim {
  return {
    actionId: args.actionId,
    capabilityRef: args.capabilityRef,
    grant: args.grant,
    budget: args.budget,
    timeoutMs: args.timeoutMs,
    now: args.now,
  }
}
