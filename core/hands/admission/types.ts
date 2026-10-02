/**
 * THE HANDS ADMISSION VOCABULARY — refusal codes, decisions and bounded metadata.
 *
 * This file is the closed vocabulary for action admission: why a request may be
 * refused, what an admitted action looks like, and the code-owned bounds that
 * keep admission finite. It is types and tables only — no policy, no I/O, no
 * clock — so the controller, the seam and the ledger can all depend on the
 * shapes without depending on each other.
 *
 * ## What is deliberately absent
 *
 * - **No execution.** Nothing here starts, runs or settles an action. An
 *   admitted action stops at a typed `pending` decision: this build has no
 *   executor, and admission is not one.
 * - **No authority.** A refusal code is a fact about a decision that already
 *   happened. Nothing in this vocabulary grants, widens or extends anything.
 * - **No invented codes.** The refusal set is closed. A caller cannot add one,
 *   and a hostile decision seam cannot either: a denial outside the set is
 *   refused rather than passed through.
 */

import type { HandsScopedCapabilityRef } from '../contract'
import { HANDS_LIMITS } from '../types'

/* --------------------------------------------------------- refusal codes */

/**
 * Why an action was refused admission.
 *
 * A closed set, because a refusal code a caller can invent is decoration. Each
 * code has exactly one owner in the controller:
 *
 * - `stopped` — the STOP ALL latch, which outranks everything;
 * - `malformed` — the envelope or its admission context is not well-formed;
 * - `unsupported` — the capability catalog does not route that id for that action;
 * - `unauthorized` — the caller's facts or Guard say no;
 * - `expired_grant` — no active grant covers this action;
 * - `over_budget` — the bounded concurrency/admission budget is exhausted.
 */
export const HANDS_ADMISSION_REFUSAL_CODES = [
  'unsupported',
  'unauthorized',
  'stopped',
  'over_budget',
  'expired_grant',
  'malformed',
] as const
export type HandsAdmissionRefusalCode = (typeof HANDS_ADMISSION_REFUSAL_CODES)[number]

export function isHandsAdmissionRefusalCode(value: unknown): value is HandsAdmissionRefusalCode {
  return typeof value === 'string' && (HANDS_ADMISSION_REFUSAL_CODES as readonly string[]).includes(value)
}

/** Why a code is a refusal, in words a person can act on. */
export const HANDS_ADMISSION_REFUSAL_REASONS: Readonly<
  Record<HandsAdmissionRefusalCode, string>
> = Object.freeze({
  unsupported: 'this Core build does not route that capability for that action',
  unauthorized: 'the caller is not authorised to use that capability in that scope',
  stopped: 'STOP ALL is active: no action is admitted',
  over_budget: 'the bounded action budget for this build is exhausted',
  expired_grant: 'no active grant covers this action',
  malformed: 'the action request or its admission context is not well-formed',
})

/* ------------------------------------------------------------- refusal */

/**
 * Why an action was refused admission.
 *
 * A refusal is *terminal*: it is not a failure to retry and not a result to
 * verify. `terminal` is a literal `true` so the terminality is visible in the
 * type, not only in a comment, and the record is frozen so a later write
 * cannot soften one.
 */
export interface HandsAdmissionRefusal {
  readonly actionId: string
  readonly code: HandsAdmissionRefusalCode
  readonly reason: string
  readonly capabilityId: string | null
  readonly refusedAt: string
  readonly terminal: true
}

/* ------------------------------------------------------------- budget */

/**
 * Bounded concurrency and admission budget metadata.
 *
 * Counts are facts about work already admitted; limits are ceilings this build
 * owns. A caller may lower a limit and may never raise one above
 * {@link HANDS_ADMISSION_LIMITS}, so "how much can happen at once" is a fact
 * about the build rather than a value a request supplies.
 */
export interface HandsAdmissionBudget {
  /** Actions that may be admitted at the same time. */
  readonly maxConcurrentActions: number
  /** Actions currently admitted and not yet settled. */
  readonly inFlightActions: number
  /** Actions a single ledger may admit in total. */
  readonly maxAdmittedActions: number
  /** Actions admitted so far in this ledger. */
  readonly admittedActions: number
}

/** The budget snapshot an admitted action carries forward. */
export interface HandsAdmittedBudgetMetadata {
  readonly maxConcurrentActions: number
  readonly inFlightAfter: number
  readonly maxAdmittedActions: number
  readonly admittedAfter: number
}

/**
 * Code-owned ceilings for admission.
 *
 * As everywhere in Hands: a caller may lower these and may never raise them.
 */
export const HANDS_ADMISSION_LIMITS = Object.freeze({
  maxConcurrentActions: 4,
  maxAdmittedActions: HANDS_LIMITS.maxActions,
})

export interface HandsAdmissionLimits {
  readonly maxConcurrentActions: number
  readonly maxAdmittedActions: number
}

/**
 * Resolve a partial limit set against the ceiling.
 *
 * Every override is clamped into `[1, HANDS_ADMISSION_LIMITS[key]]`.
 */
export function handsAdmissionLimits(
  overrides: Partial<HandsAdmissionLimits> = {},
): HandsAdmissionLimits {
  const clamp = (requested: number | undefined, ceiling: number): number => {
    if (requested === undefined) return ceiling
    if (typeof requested !== 'number' || !Number.isFinite(requested)) return ceiling
    return Math.max(1, Math.min(Math.floor(requested), ceiling))
  }
  return {
    maxConcurrentActions: clamp(
      overrides.maxConcurrentActions,
      HANDS_ADMISSION_LIMITS.maxConcurrentActions,
    ),
    maxAdmittedActions: clamp(
      overrides.maxAdmittedActions,
      HANDS_ADMISSION_LIMITS.maxAdmittedActions,
    ),
  }
}

/* ------------------------------------------------- caller and grant */

/**
 * The caller, as Core knows it.
 *
 * Supplied by the trusted pathway that asked for admission — never read out of
 * the request. `heldCapabilities` is *possession*: what the caller holds says
 * nothing about what it may do, which is Guard's decision.
 */
export interface HandsAdmissionCaller {
  readonly principalId: string
  /** False for a principal created from untrusted input. */
  readonly trusted: boolean
  /** The scope the caller is acting in, right now. */
  readonly scope: string
  /** Capabilities held at this instant. Never inferred from context. */
  readonly heldCapabilities: readonly string[]
}

/**
 * The grant this action relies on.
 *
 * An active grant is a *fact* checked by the controller; coverage policy is
 * the Governor's. `null` is deliberately not admitted: no grant, no action.
 */
export interface HandsAdmissionGrant {
  readonly grantId: string
  /** An absolute instant. Grants expire; there is no "until further notice". */
  readonly expiresAt: string
  readonly revokedAt: string | null
}

/* --------------------------------------------------------- decision */

/**
 * An admitted action, stopping at a typed pending decision.
 *
 * `status: 'pending'` is the whole of it: the action is admitted and *would*
 * be executable by an executor, and this build does not have one. There is
 * deliberately no field for a start instant, a result, an observation or a
 * verdict — admission cannot be walked forward into execution by writing to it.
 */
export interface HandsAdmittedAction {
  readonly decision: 'admitted'
  readonly status: 'pending'
  readonly actionId: string
  readonly capabilityRef: HandsScopedCapabilityRef
  readonly action: string
  /**
   * Validated, sanitised, and still untrusted.
   *
   * Content, never authority: nothing downstream may read this as a grant, a
   * principal or a policy, and neither seam is ever handed it.
   */
  readonly input: Readonly<Record<string, unknown>>
  readonly admittedAt: string
  /** The clamped wall-clock budget for this action, in milliseconds. */
  readonly timeoutMs: number
  /** `admittedAt + timeoutMs`: when a cancellation/timeout registration fires. */
  readonly deadlineAt: string
  readonly correlationId: string | null
  readonly caller: { readonly principalId: string; readonly scope: string }
  readonly grantId: string
  readonly budget: HandsAdmittedBudgetMetadata
}

/**
 * The outcome of admission.
 *
 * Exactly one of two things: a terminal refusal, or a pending/executable
 * decision. Nothing in between, and nothing that implies the action ran.
 */
export type HandsAdmissionDecision =
  | { readonly decision: 'refused'; readonly refusal: HandsAdmissionRefusal }
  | { readonly decision: 'admitted'; readonly admitted: HandsAdmittedAction }
