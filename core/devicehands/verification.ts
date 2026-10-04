import type {
  DeviceHandsActionKey,
  DeviceHandsRefusalCode,
  DeviceHandsVerdict,
  DeviceHandsVerificationRecord,
} from './types'

/**
 * Verification: the only thing that can close an action as done.
 *
 * ## The distinction this file exists to keep
 *
 * **A port reporting success is a claim, not an observation.** A terminal adapter
 * that returns `exitCode: 0` has told Freya what it believes happened. That is worth
 * something — it is not nothing — but it is not evidence, and an action whose only
 * support is the adapter's own report is `unverified`, permanently, no matter how
 * confident the report sounded.
 *
 * So every port outcome carries `evidence`, and the two values are not the same:
 *
 *   - `reported` — "I did what you asked and here is my account of it". Not evidence.
 *   - `observed` — "I did it *and I read the result back*": the process really exited,
 *     the destination file really exists with those bytes, the page really is at that
 *     URL. Evidence, and the only kind that closes an action.
 *
 * A port that answers `holds: true` with `evidence: 'reported'` gets
 * `claim-not-evidence`. This is the same rule Phase 33 applies to external actions,
 * and it is the difference between an audit trail and a diary.
 */

/** The only evidence source that closes an action. */
export const EVIDENCE_KINDS = ['observed', 'reported'] as const
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number]

export interface DeviceOutcome {
  /** Whether the surface believes it did the thing. */
  readonly holds: boolean
  /** Whether it checked, or merely says so. */
  readonly evidence: EvidenceKind
  /** A closed code. Never prose from the thing that was operated on. */
  readonly code: string
}

export interface VerificationInput {
  readonly actionId: string
  readonly actionKey: DeviceHandsActionKey
  readonly at: string
  readonly deadlineAt: string
  /** Whether STOP ALL was latched when the action settled. */
  readonly stopped: boolean
  /** Whether Core cancelled this action before it settled. */
  readonly cancelled: boolean
  /** Whether a port was reached at all. False for an action refused at a gate. */
  readonly attempted: boolean
  readonly outcome: DeviceOutcome | null
}

export interface VerificationDecision {
  readonly verdict: DeviceHandsVerdict
  readonly code: DeviceHandsRefusalCode | null
  readonly reason: string
}

function refuse(verdict: DeviceHandsVerdict, code: DeviceHandsRefusalCode, reason: string): VerificationDecision {
  return { verdict, code, reason }
}

/**
 * Decide what may be claimed about an action that has settled.
 *
 * The order is the order in which the questions are meaningful: was the world stopped
 * under us, did we cancel it, did it run out of time, did anything happen at all, did
 * the surface say it worked, and *was that checked*.
 */
export function verifyDeviceAction(input: VerificationInput): VerificationDecision {
  if (input.stopped) {
    return refuse(
      'unverified',
      'verification-missing',
      'STOP ALL was latched when this action settled, so what it did is not established and this is recorded as not done.',
    )
  }
  if (input.cancelled) {
    return refuse('failed', 'action-cancelled', 'The action was cancelled before it settled.')
  }
  if (Date.parse(input.at) >= Date.parse(input.deadlineAt)) {
    return refuse(
      'failed',
      'action-timed-out',
      'The action settled at or after its deadline, so its result is outside the time it was authorised for.',
    )
  }
  if (!input.attempted || input.outcome === null) {
    return refuse(
      'unverified',
      'verification-missing',
      'No surface was reached, so there is nothing to verify. This action did not happen.',
    )
  }
  const outcome = input.outcome
  if (!outcome.holds) {
    return refuse(
      'failed',
      outcome.code === 'timeout' ? 'action-timed-out' : 'port-reported-failure',
      `The surface reported that it did not do the thing (${outcome.code}).`,
    )
  }
  if (outcome.evidence === 'reported') {
    return refuse(
      'unverified',
      'claim-not-evidence',
      `The surface reported success (${outcome.code}) but did not observe the result. An action whose only support is its own account is not verified, however confident the account sounded.`,
    )
  }
  return { verdict: 'passed', code: null, reason: `The result was observed at the destination (${outcome.code}).` }
}

/**
 * Whether an action may be described as complete.
 *
 * Only a `passed` verification qualifies. An action that was refused at a gate, that
 * was cancelled, that timed out, or whose only support was a report all read as *not
 * done* — and there is no branch anywhere in this phase that produces `completed`
 * without a passing verification record to point at.
 */
export function mayBeConsideredComplete(
  verification: DeviceHandsVerificationRecord | null,
): { readonly complete: boolean; readonly code: DeviceHandsRefusalCode | null; readonly reason: string } {
  if (verification === null) {
    return {
      complete: false,
      code: 'verification-missing',
      reason: 'There is no verification result for this action, so it is not complete.',
    }
  }
  if (verification.verdict === 'failed') {
    return {
      complete: false,
      code: 'verification-failed',
      reason: `Verification did not pass: ${verification.reason}`,
    }
  }
  if (verification.verdict !== 'passed') {
    return {
      complete: false,
      code: 'claim-not-evidence',
      reason: `This action is unverified rather than complete: ${verification.reason}`,
    }
  }
  return { complete: true, code: null, reason: 'A registered verifier observed the result and passed it.' }
}

/** The evidence kinds, for an exhaustive audit. */
export function evidenceKinds(): readonly string[] {
  return EVIDENCE_KINDS
}