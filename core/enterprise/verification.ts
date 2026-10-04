import {
  ENTERPRISE_LIMITS,
  VERIFICATION_OUTCOMES,
  isVerificationOutcome,
  type EnterpriseRefusalCode,
  type VerificationOutcome,
} from './types'
import type { EvidenceInput, VerificationInput } from './ports'

/**
 * External-action verification.
 *
 * The rule this file exists to make checkable is the one in the specification: *no
 * external action is considered complete without verification, and verification never
 * fabricates certainty.* The hard part is not refusing to pass an action that failed —
 * it is refusing to pass one that **succeeded**, because success is exactly the case
 * where it is tempting to take a claim at face value.
 *
 * So `passed` is the hardest outcome to reach, not the easiest:
 *
 *   - something must have been observed. A claim with no observation is not weak
 *     evidence, it is the absence of evidence, and it yields `failed`;
 *   - the observation must have matched what was intended;
 *   - the observation must not have come from a model or from the environment's own
 *     mouth. `claimedBy: 'model'` and `claimedBy: 'environment'` cannot produce a
 *     `passed`, whatever else they report — a subsystem verifying its own homework is
 *     not verification;
 *   - a deadline that has passed yields `deadline-expired`, never `passed`, even if
 *     the evidence is perfect. A late success is a failure with extra steps.
 *
 * `interrupted` outranks everything except an expired deadline, because a stopped
 * Freya must not learn anything new about the world.
 *
 * Pure. No clock, no journal, no network, and no way to construct a `passed` from a
 * claim.
 */

/** Who is allowed to have produced an observation that counts as evidence. */
export const EVIDENCE_SOURCES_THAT_COUNT: readonly EvidenceInput['claimedBy'][] = Object.freeze([
  'owner',
  'core',
  'external-observation',
])

export interface VerificationDecision {
  readonly outcome: VerificationOutcome
  readonly code: EnterpriseRefusalCode | null
  readonly reason: string
  /** Whether the action may now be considered complete. */
  readonly completes: boolean
  /** Whether this outcome is trustworthy enough to act on. */
  readonly certain: boolean
}

/**
 * Could this evidence come from something that is allowed to testify?
 *
 * The question is about *provenance only* — was anything observed, and by a source
 * whose word is worth having. It deliberately says nothing about whether the
 * observation matched, because that is a different question with a different answer
 * depending on which outcome is being claimed: a mismatch is exactly what supports a
 * `failed`.
 *
 * Getting this wrong in the strict direction is the bug worth avoiding. An earlier
 * version folded "matched" in here, which meant a well-evidenced *failure* looked like
 * the absence of evidence and was reported as though nobody had checked.
 */
export function evidenceIsAdmissible(evidence: EvidenceInput): boolean {
  if (!evidence.observed) return false
  return EVIDENCE_SOURCES_THAT_COUNT.includes(evidence.claimedBy)
}

/**
 * Can this evidence support a *pass*?
 *
 * Strictly more than admissibility: the observation must also have matched what was
 * intended. This is the gate `passed` has to clear, and it is the whole reason `passed`
 * is the hardest outcome to reach in this file.
 */
export function evidenceSupportsPass(evidence: EvidenceInput): boolean {
  return evidenceIsAdmissible(evidence) && evidence.matched
}

/** Sources whose word cannot establish an outcome, whatever else they report. */
export function claimIsUnreliable(evidence: EvidenceInput): boolean {
  return evidence.claimedBy === 'model' || evidence.claimedBy === 'environment' || evidence.claimedBy === 'agent'
}

export interface VerificationRecord {
  readonly verificationId: string
  readonly actionId: string
  readonly environmentId: string
  readonly outcome: VerificationOutcome
  readonly reason: string
  readonly verifiedAt: string
}

/**
 * Decide what happened to an external action.
 *
 * The order below is the specification's order and it is load-bearing; each step is
 * placed so that the more fundamental facts are checked first:
 *
 *   1. **Stopped.** A stopped Freya concludes nothing.
 *   2. **Deadline.** Past its deadline, an action is `deadline-expired`. Checked
 *      before the evidence so that a slow perfect success cannot be laundered into a
 *      clean pass.
 *   3. **Evidence admissibility.** No observation, or an observation from a source
 *      that cannot testify, is `failed` with `claim-not-evidence`. This is the
 *      fabrication case and it gets its own code so it is visible in the audit rather
 *      than blending into an ordinary failure.
 *   4. **The observation itself.** Matched or not.
 */
export function verifyExternalAction(input: VerificationInput): VerificationDecision {
  if (!isVerificationOutcome(input.outcome)) {
    return {
      outcome: 'failed',
      code: 'verification-failed',
      reason: 'The outcome claimed is not one of the four verification outcomes.',
      completes: false,
      certain: false,
    }
  }

  if (input.stopped) {
    return {
      outcome: 'interrupted',
      code: 'verification-failed',
      reason:
        'STOP ALL is latched, so this action was not verified. An interrupted verification is paused work, not a result.',
      completes: false,
      certain: false,
    }
  }

  if (input.deadlineAt !== null) {
    const deadline = Date.parse(input.deadlineAt)
    const now = Date.parse(input.at)
    if (!Number.isFinite(deadline) || !Number.isFinite(now)) {
      return {
        outcome: 'failed',
        code: 'verification-failed',
        reason: 'This verification carries no trustworthy deadline, so its bounds cannot be checked.',
        completes: false,
        certain: false,
      }
    }
    if (now > deadline) {
      return {
        outcome: 'deadline-expired',
        code: 'verification-failed',
        reason:
          'The verification deadline passed. A late success is a failure with extra steps, not a pass.',
        completes: false,
        certain: false,
      }
    }
  }

  // Provenance first: a claim from the thing being verified, or from something that
  // only guesses, cannot establish anything — whatever it reports about matching.
  if (!evidenceIsAdmissible(input.evidence)) {
    const unreliable = claimIsUnreliable(input.evidence)
    return {
      outcome: 'failed',
      code: unreliable ? 'claim-not-evidence' : 'verification-failed',
      reason: unreliable
        ? `A ${input.evidence.claimedBy} reported this action as done. A claim from the thing being verified is not evidence of it, so this is not a pass.`
        : input.evidence.observed
          ? 'The observation did not match what was intended, so this action did not do what it said.'
          : 'Nothing observed this action happen. An unobserved action is not a successful one.',
      completes: false,
      certain: false,
    }
  }

  // Admissible evidence that says the observation did not match. This is a genuine,
  // well-evidenced failure — and it stays `failed` whatever label arrived with it,
  // because the evidence is what this subsystem trusts rather than the claim.
  if (!input.evidence.matched) {
    return {
      outcome: 'failed',
      code: null,
      reason: 'An independent observation did not match what this action intended to do.',
      completes: false,
      certain: true,
    }
  }

  if (input.outcome === 'passed') {
    return {
      outcome: 'passed',
      code: null,
      reason: 'An independent observation matched what this action intended to do.',
      completes: true,
      certain: true,
    }
  }

  // Admissible, matching evidence with a non-passing reported outcome. The evidence is
  // trusted over the label, so this is `interrupted` or `deadline-expired` only if that
  // is what the caller reported; a bare `failed` stays a failure rather than being
  // rounded up to a pass.
  return {
    outcome: input.outcome,
    code: null,
    reason: `An observation supports the reported outcome: ${input.outcome}.`,
    completes: false,
    certain: true,
  }
}

/**
 * Has this action been verified, and may it be called complete?
 *
 * Separate from {@link verifyExternalAction} because "complete" is a claim the
 * projection makes and it must be derivable from the journal alone: a completed action
 * whose verification is missing, failed or interrupted is exactly the state
 * `verification-missing` exists to prevent.
 */
export function mayBeConsideredComplete(
  verification: VerificationRecord | null | undefined,
): { readonly complete: boolean; readonly code: EnterpriseRefusalCode | null; readonly reason: string } {
  if (verification === null || verification === undefined) {
    return {
      complete: false,
      code: 'verification-missing',
      reason: 'This action has no verification record, so it cannot be called complete.',
    }
  }
  if (verification.outcome === 'passed') {
    return {
      complete: true,
      code: null,
      reason: 'This action was verified by an independent observation.',
    }
  }
  return {
    complete: false,
    code: 'verification-failed',
    reason: `This action verified as ${verification.outcome}, so it is not complete.`,
  }
}

/**
 * Fold a deadline to `deadline-expired` purely from the clock.
 *
 * Used by the reconciliation path on restart, where there is no verification to read
 * and the only fact available is that the bound has passed.
 */
export function deadlineHasExpired(deadlineAt: string | null, at: string): boolean {
  if (deadlineAt === null) return false
  const deadline = Date.parse(deadlineAt)
  const now = Date.parse(at)
  if (!Number.isFinite(deadline) || !Number.isFinite(now)) return true
  return now > deadline
}

/** The four outcomes, for the audit and for exhaustive tests. */
export function verificationOutcomes(): readonly VerificationOutcome[] {
  return VERIFICATION_OUTCOMES
}

/**
 * Verification reasons are shown to the owner, so they are bounded like every other
 * journal-bound string.
 */
export function verificationReasonWithinBounds(reason: string): boolean {
  return reason.length <= ENTERPRISE_LIMITS.maxPayloadTextLength
}