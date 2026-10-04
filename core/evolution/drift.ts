import {
  DRIFT_CHECK_OUTCOMES,
  isDriftCheckOutcome,
  type AuthorityEnvelope,
  type DriftCheckOutcome,
  type DriftCheckRecord,
  type ProposedAuthorityEnvelope,
} from './types'

/**
 * Authority drift prevention: the detector.
 *
 * Authority drift is detected when an improvement proposes an authority or
 * capability envelope wider than the one the evolution subsystem currently
 * holds. The detector compares the proposed envelope against the current one
 * and reports a closed outcome.
 *
 * ## What counts as drift
 *
 * 1. A new capability the subsystem does not hold
 * 2. A new grant the subsystem does not hold
 * 3. A higher budget ceiling
 * 4. A weakened approval requirement
 * 5. A cleared STOP ALL latch
 *
 * ## What the detector does NOT do
 *
 * - It never widens authority
 * - It never self-modifies trusted runtime code
 * - It never exceeds authority
 * - It always respects STOP ALL
 *
 * ## Detection is deterministic
 *
 * Same proposed envelope + same current envelope = same detection. No model
 * calls, no randomness, no wall-clock reads.
 */

export type DriftCheckResult =
  | { readonly outcome: 'no-drift'; readonly reason: string }
  | { readonly outcome: 'drift-detected'; readonly reason: string; readonly violations: readonly string[] }
  | { readonly outcome: 'boundary-violation'; readonly reason: string }

/**
 * Compare a proposed authority envelope against the current one.
 *
 * Returns `no-drift` when the proposed envelope is the same or narrower,
 * `drift-detected` when it widens the envelope, and `boundary-violation` when
 * it attempts to touch a protected security invariant.
 */
export function detectAuthorityDrift(
  proposed: ProposedAuthorityEnvelope,
  current: AuthorityEnvelope,
): DriftCheckResult {
  const violations: string[] = []

  const newCapabilities = proposed.capabilities.filter(
    (cap) => !current.capabilities.includes(cap),
  )
  if (newCapabilities.length > 0) {
    violations.push(`new capabilities: [${newCapabilities.join(', ')}]`)
  }

  const newGrants = proposed.grants.filter((grant) => !current.grants.includes(grant))
  if (newGrants.length > 0) {
    violations.push(`new grants: [${newGrants.join(', ')}]`)
  }

  if (proposed.budgetCeiling > current.budgetCeiling) {
    violations.push(
      `budget ceiling ${proposed.budgetCeiling} exceeds current ${current.budgetCeiling}`,
    )
  }

  if (proposed.approvalRequired === false && current.approvalRequired === true) {
    violations.push('approval requirement would be weakened')
  }

  if (proposed.stopAllLatched === false && current.stopAllLatched === true) {
    violations.push('STOP ALL latch would be cleared')
  }

  if (violations.length > 0) {
    return {
      outcome: 'drift-detected',
      reason: `the proposed envelope widens authority: ${violations.join('; ')}`,
      violations: Object.freeze(violations),
    }
  }

  return {
    outcome: 'no-drift',
    reason: 'the proposed envelope is the same as or narrower than the current envelope',
  }
}

/**
 * Check whether an improvement attempts to self-modify trusted runtime code.
 *
 * This is a boundary violation, not drift. It is checked separately because it
 * is a different class of refusal: drift is about widening authority, while
 * self-modification is about changing the code that enforces the boundaries.
 */
export function isSelfModificationAttempt(
  proposed: ProposedAuthorityEnvelope,
): { readonly isAttempt: boolean; readonly reason: string } {
  const selfModifyCaps = proposed.capabilities.filter(
    (cap) => cap === 'self-modify' || cap === 'modify-code' || cap === 'trusted-runtime-write',
  )
  if (selfModifyCaps.length > 0) {
    return {
      isAttempt: true,
      reason: `the proposed envelope carries [${selfModifyCaps.join(', ')}], which would self-modify trusted runtime code`,
    }
  }
  return { isAttempt: false, reason: 'the proposed envelope does not attempt self-modification' }
}

/**
 * Check whether an improvement attempts to weaken Guard, Governor, STOP ALL,
 * approval or budget rules.
 *
 * This is a boundary violation. The closed set of protected security
 * invariants is code-owned and cannot be widened.
 */
export function isProtectedInvariantViolation(
  proposed: ProposedAuthorityEnvelope,
  current: AuthorityEnvelope,
): { readonly isViolation: boolean; readonly reason: string } {
  if (proposed.stopAllLatched === false && current.stopAllLatched === true) {
    return {
      isViolation: true,
      reason: 'the proposed envelope would clear the STOP ALL latch',
    }
  }
  if (proposed.approvalRequired === false && current.approvalRequired === true) {
    return {
      isViolation: true,
      reason: 'the proposed envelope would weaken the approval requirement',
    }
  }
  if (proposed.budgetCeiling > current.budgetCeiling) {
    return {
      isViolation: true,
      reason: 'the proposed envelope would widen the budget',
    }
  }
  return { isViolation: false, reason: 'the proposed envelope does not violate a protected invariant' }
}

/**
 * Construct a drift check record.
 */
export function createDriftCheckRecord(input: {
  readonly checkId: string
  readonly improvementId: string
  readonly outcome: DriftCheckOutcome
  readonly reason: string
  readonly checkedAt: string
}): DriftCheckRecord {
  return Object.freeze({
    checkId: input.checkId,
    improvementId: input.improvementId,
    outcome: input.outcome,
    reason: input.reason,
    checkedAt: input.checkedAt,
  })
}

export { DRIFT_CHECK_OUTCOMES, isDriftCheckOutcome }
