/**
 * THE HANDS ADMISSION LEDGER — registration, cancellation and timeout.
 *
 * Admission alone says "this may happen". The ledger is where an admitted
 * action is *registered*: it holds the cancellation path and the deadline for
 * every pending action, counts what is in flight against the bounded budget,
 * and settles entries exactly once.
 *
 * ## What is deliberately enforced
 *
 * - **Pending stays pending.** Registering an admitted action books a slot and
 *   a deadline; nothing here starts, runs or completes an action. Settlement
 *   is only `cancelled` or `timed_out` — the two terminal edges a registration
 *   has, each reached at most once.
 * - **Terminal is terminal.** A settled registration is never rewritten: a
 *   second cancel, a later sweep and STOP ALL all leave it exactly as it was.
 * - **The bound is real.** Budget metadata is *derived from the ledger*, not
 *   supplied by the submission, so concurrency cannot be widened by asking
 *   politely; it is freed only by a settlement.
 * - **Duplicate ids are refused.** A replayed `actionId` does not get a second
 *   slot, a second deadline, or a second chance.
 *
 * Pure by construction: instants arrive as arguments, no clock is read, and
 * every operation returns the same ledger object when it changes nothing.
 */

import { admitHandsAction, refuseHandsAdmission, type HandsAdmissionInput } from './controller'
import {
  handsAdmissionLimits,
  type HandsAdmissionBudget,
  type HandsAdmissionDecision,
  type HandsAdmissionLimits,
  type HandsAdmittedAction,
} from './types'

/* -------------------------------------------------------------- types */

/**
 * A registration's lifecycle.
 *
 * `registered` → `cancelled` | `timed_out`. Terminal states have no outgoing
 * edges: the table mirrors the action statuses the contract already owns.
 */
export const HANDS_ADMISSION_REGISTRATION_STATUSES = [
  'registered',
  'cancelled',
  'timed_out',
] as const
export type HandsAdmissionRegistrationStatus =
  (typeof HANDS_ADMISSION_REGISTRATION_STATUSES)[number]

/**
 * One admitted action's cancellation path and timeout deadline.
 *
 * This is the registration the future executor would attach to: `deadlineAt`
 * is when it times out, and settling is how Core says it was cancelled or ran
 * out of time. No timer is armed here — instants are compared, not waited on.
 */
export interface HandsAdmissionRegistration {
  readonly actionId: string
  readonly status: HandsAdmissionRegistrationStatus
  readonly registeredAt: string
  readonly deadlineAt: string
  readonly settledAt: string | null
  readonly settleReason: string | null
}

/** The ledger: every admission registration, keyed by action id. */
export interface HandsAdmissionLedger {
  readonly registrations: ReadonlyMap<string, HandsAdmissionRegistration>
}

/**
 * A submission: everything admission needs except the budget, which the ledger
 * derives from itself. A caller never supplies its own concurrency count.
 */
export type HandsAdmissionSubmitInput = Omit<HandsAdmissionInput, 'budget'>

/* ----------------------------------------------------------- lifecycle */

export function initialHandsAdmissionLedger(): HandsAdmissionLedger {
  return { registrations: new Map() }
}

/**
 * Register an admitted action.
 *
 * Books its cancellation path and deadline. Idempotent for an id already
 * present — a second registration of the same action books nothing and
 * changes nothing.
 */
export function registerAdmission(
  ledger: HandsAdmissionLedger,
  admitted: HandsAdmittedAction,
): HandsAdmissionLedger {
  if (ledger.registrations.has(admitted.actionId)) return ledger
  const registrations = new Map(ledger.registrations)
  registrations.set(
    admitted.actionId,
    Object.freeze({
      actionId: admitted.actionId,
      status: 'registered' as const,
      registeredAt: admitted.admittedAt,
      deadlineAt: admitted.deadlineAt,
      settledAt: null,
      settleReason: null,
    }),
  )
  return { registrations }
}

/**
 * Cancel one pending registration.
 *
 * Terminal states are not rewritten: cancelling a settled action, or an id the
 * ledger has never seen, returns the very same ledger object.
 */
export function cancelRegistration(
  ledger: HandsAdmissionLedger,
  actionId: string,
  now: string,
  reason: string,
): HandsAdmissionLedger {
  return settle(ledger, actionId, 'cancelled', now, reason)
}

/**
 * Settle every registration whose deadline has passed.
 *
 * Compared, never waited on: `deadlineAt <= now` is `timed_out`. An instant
 * this build cannot parse compares false against every deadline, so a bad
 * sweep settles nothing rather than everything.
 */
export function expireRegistrations(
  ledger: HandsAdmissionLedger,
  now: string,
): HandsAdmissionLedger {
  const at = Date.parse(now)
  if (!Number.isFinite(at)) return ledger
  let next = ledger
  for (const registration of [...ledger.registrations.values()]) {
    if (registration.status !== 'registered') continue
    if (Date.parse(registration.deadlineAt) <= at) {
      next = settle(next, registration.actionId, 'timed_out', now, 'the action deadline passed')
    }
  }
  return next
}

/**
 * STOP ALL: cancel every pending registration.
 *
 * Already-settled entries keep the reason they were settled with — a terminal
 * record is history, and STOP ALL does not rewrite history.
 */
export function stopAllRegistrations(
  ledger: HandsAdmissionLedger,
  now: string,
): HandsAdmissionLedger {
  let next = ledger
  for (const registration of [...ledger.registrations.values()]) {
    if (registration.status !== 'registered') continue
    next = settle(next, registration.actionId, 'cancelled', now, 'stop-all')
  }
  return next
}

/** How many registrations are pending — the in-flight concurrency count. */
export function inFlightCount(ledger: HandsAdmissionLedger): number {
  let count = 0
  for (const registration of ledger.registrations.values()) {
    if (registration.status === 'registered') count += 1
  }
  return count
}

/**
 * Derive budget metadata from the ledger.
 *
 * The counts are facts about this ledger; the limits are clamped to the
 * code-owned ceilings. This is the only budget admission ever sees — a
 * submission cannot hand itself one.
 */
export function handsAdmissionBudgetFrom(
  ledger: HandsAdmissionLedger,
  overrides: Partial<HandsAdmissionLimits> = {},
): HandsAdmissionBudget {
  const limits = handsAdmissionLimits(overrides)
  return {
    maxConcurrentActions: limits.maxConcurrentActions,
    inFlightActions: inFlightCount(ledger),
    maxAdmittedActions: limits.maxAdmittedActions,
    admittedActions: ledger.registrations.size,
  }
}

/**
 * Submit one action for admission against this ledger.
 *
 * The budget is derived from the ledger, admission runs, and only a decision
 * that was admitted — and whose id is not already registered — books a slot.
 * A refusal returns the ledger untouched, so a refused request changes
 * nothing about what may happen next.
 */
export function submitHandsAdmission(
  ledger: HandsAdmissionLedger,
  input: HandsAdmissionSubmitInput,
  limits?: Partial<HandsAdmissionLimits>,
): { readonly ledger: HandsAdmissionLedger; readonly decision: HandsAdmissionDecision } {
  const decision = admitHandsAction({ ...input, budget: handsAdmissionBudgetFrom(ledger, limits) })
  if (decision.decision === 'refused') {
    return { ledger, decision }
  }
  const admitted = decision.admitted
  if (ledger.registrations.has(admitted.actionId)) {
    // A replayed id is not a second action; it is a malformed request. It gets
    // a terminal refusal, not a second slot or a second deadline.
    return {
      ledger,
      decision: {
        decision: 'refused',
        refusal: refuseHandsAdmission(
          admitted.actionId,
          admitted.capabilityRef.capabilityId,
          'malformed',
          admitted.admittedAt,
          'an action with that id is already registered',
        ),
      },
    }
  }
  return { ledger: registerAdmission(ledger, admitted), decision }
}

/* ------------------------------------------------------------ internals */

function settle(
  ledger: HandsAdmissionLedger,
  actionId: string,
  status: 'cancelled' | 'timed_out',
  now: string,
  reason: string,
): HandsAdmissionLedger {
  const existing = ledger.registrations.get(actionId)
  if (!existing || existing.status !== 'registered') return ledger
  const registrations = new Map(ledger.registrations)
  registrations.set(
    actionId,
    Object.freeze({ ...existing, status, settledAt: now, settleReason: reason }),
  )
  return { registrations }
}
