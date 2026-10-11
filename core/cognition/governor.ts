import type { CognitionCause, CognitionOrigin, GovernorOutcome } from '../../shared/contracts/security'
import type { PrincipalId } from '../../shared/contracts/identity'
import { checkGrant, isGrantActive, type CognitionGrant, type GrantContext } from './grants'

/**
 * The Cognition Governor.
 *
 * **No provider call may bypass this.** It is the only thing that decides
 * whether cognition happens at all.
 *
 * The Governor does not know that providers exist. It answers one question —
 * may this request proceed? — and the Model Gateway will only act on a permit
 * the Governor issued. Keeping the Governor ignorant of providers is what makes
 * the separation structural rather than a naming convention.
 */

export interface CognitionRequest {
  cognitionRequestId: string
  origin: CognitionOrigin
  cause: CognitionCause
  actor: PrincipalId

  correlationId: string
  /** Future-compatible: a run this request belongs to. */
  parentRunId?: string | null
  /** Future-compatible: the goal this request serves. */
  goalId?: string | null

  requestedModel?: string | null

  /** The ceiling the caller is asking for. Never treated as a default. */
  maxOutputTokens: number

  /**
   * The grant the request relies on, or null for an explicit user turn that
   * does not need one.
   */
  authorization: {
    grantId: string | null
    /** True when a human is directly waiting for this answer. */
    userInitiated: boolean
  }

  /** Nobody is watching: no open user turn. */
  background: boolean
}

export interface GovernorDecision {
  outcome: GovernorOutcome
  reason: string
  grantId: string | null
}

/**
 * Reasons the Governor may refuse. Each is auditable, and none of them has a
 * branch that lets the request through anyway.
 */
export type DenialReason =
  | 'stop-all-active'
  | 'journal-not-trustworthy'
  | 'not-user-initiated-and-no-grant'
  | 'grant-rejected'
  | 'grant-missing'
  | 'no-active-grant'
  | 'zero-token-request'
  | 'excessive-token-request'

/** A request for more than this is refused rather than quietly truncated. */
export const MAX_OUTPUT_TOKENS_PER_CALL = 4096

export interface GovernorInputs {
  grants: readonly CognitionGrant[]
  stopAllActive: boolean
  now: Date
  /**
   * Whether the event log can be believed.
   *
   * Checked before anything else, and above the STOP ALL latch, because it is
   * worse: a journal that failed validation has a hole in it, and the segment
   * that was discarded may have held the very STOP ALL that would otherwise have
   * refused this request. A replayed latch cannot be trusted to be the whole
   * latch, so a Core that cannot vouch for its log denies everything.
   */
  journalTrustworthy: boolean
}

export function evaluateCognition(request: CognitionRequest, inputs: GovernorInputs): GovernorDecision {
  // An untrustworthy journal outranks everything, including a valid grant and
  // including the replayed latch itself.
  if (!inputs.journalTrustworthy) {
    return { outcome: 'deny', reason: 'journal-not-trustworthy', grantId: null }
  }

  // STOP ALL outranks everything else, including a valid grant.
  if (inputs.stopAllActive) {
    return { outcome: 'deny', reason: 'stop-all-active', grantId: null }
  }

  if (!Number.isFinite(request.maxOutputTokens) || request.maxOutputTokens <= 0) {
    return { outcome: 'deny', reason: 'zero-token-request', grantId: null }
  }
  if (request.maxOutputTokens > MAX_OUTPUT_TOKENS_PER_CALL) {
    return {
      outcome: 'deny',
      reason: 'excessive-token-request',
      grantId: null,
    }
  }

  const { authorization } = request

  // An explicit, user-initiated turn needs no grant: the human is present and
  // asked for this specific answer. This is the only grantless path.
  if (authorization.grantId === null) {
    if (authorization.userInitiated && request.origin === 'user' && !request.background) {
      return { outcome: 'allow', reason: 'explicit user-initiated cognition', grantId: null }
    }
    return { outcome: 'deny', reason: 'not-user-initiated-and-no-grant', grantId: null }
  }

  const grant = inputs.grants.find((candidate) => candidate.id === authorization.grantId)
  if (!grant) {
    return {
      outcome: 'deny',
      reason: 'grant-missing',
      grantId: authorization.grantId,
    }
  }
  if (!isGrantActive(grant, inputs.now)) {
    // An expired grant is not "ask the human" — it is a refusal. Silence here
    // would be indistinguishable from permission.
    return { outcome: 'deny', reason: 'no-active-grant', grantId: grant.id }
  }

  const context: GrantContext = {
    origin: request.origin,
    cause: request.cause,
    goalId: request.goalId ?? null,
    runId: request.parentRunId ?? null,
    actor: request.actor,
    background: request.background,
    maxOutputTokens: request.maxOutputTokens,
  }

  const check = checkGrant(grant, context, inputs.now)
  if (!check.ok) {
    return { outcome: 'deny', reason: 'grant-rejected', grantId: grant.id }
  }

  return { outcome: 'allow', reason: 'within grant', grantId: grant.id }
}

