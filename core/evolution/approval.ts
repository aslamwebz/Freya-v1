/**
 * FREYA EVOLUTION — Authenticated Owner Promotion Approvals
 *
 * Enforces cryptographic and structural binding between candidate proposals,
 * strategy versions, and authenticated owner approval records.
 *
 * Invariants:
 * 1. Self-promotion is strictly impossible; approval must be decided by authenticated owner.
 * 2. Approvals are one-time and bound to the exact candidate digest.
 * 3. Modification of parameters, scopes, or versions invalidates the approval.
 * 4. Expired, revoked, or denied approvals are rejected.
 */

import { createHash } from 'node:crypto'
import type { PrincipalId } from '../../shared/contracts/identity'
import type { StrategyCandidate } from './strategy'

export type PromotionApprovalStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'revoked'
  | 'expired'

export interface StrategyPromotionApproval {
  readonly approvalId: string
  readonly candidateId: string
  readonly candidateDigest: string
  readonly strategyVersion: string
  readonly category: string
  readonly authorityScope: 'evolution.strategy.promote'
  readonly requestedPurpose: 'production_promotion'
  readonly status: PromotionApprovalStatus
  readonly requestedBy: PrincipalId
  readonly requestedAt: string
  readonly expiresAt: string
  readonly decidedBy: PrincipalId | null
  readonly decidedAt: string | null
  readonly decisionReason: string | null
  readonly consumed: boolean
  readonly consumedAt?: string | null
}

export interface PromotionRecord {
  readonly candidateId: string
  readonly version: string
  readonly previousStrategyId: string
  readonly approvalId: string
  readonly activatedAt: string
  readonly rollbackTargetId: string
}

export interface RollbackRecord {
  readonly candidateId: string
  readonly restoredStrategyId: string
  readonly reason: string
  readonly rolledBackAt: string
}

/**
 * Compute canonical digest of candidate parameters and specifications.
 * Any modification of parameters or specifications after approval changes this hash.
 */
export function computeCandidateDigest(candidate: StrategyCandidate): string {
  const payload = JSON.stringify({
    candidateId: candidate.candidateId,
    version: candidate.version,
    category: candidate.category,
    parameters: candidate.parameters,
    proposedChange: candidate.proposedChange,
    baselineStrategyId: candidate.baselineStrategyId,
    baselineParameters: candidate.baselineParameters,
    rollbackMechanism: candidate.rollbackMechanism,
  })
  return createHash('sha256').update(payload).digest('hex')
}

export type ApprovalValidationVerdict =
  | { readonly valid: true; readonly approval: StrategyPromotionApproval }
  | { readonly valid: false; readonly code: 'unauthorized'; readonly reason: string }

/**
 * Perform all 10 mandatory checks on a promotion approval record against a candidate.
 */
export function validatePromotionApproval(
  approval: StrategyPromotionApproval | null | undefined,
  candidate: StrategyCandidate,
  options?: {
    readonly callerPrincipal?: PrincipalId
    readonly now?: string
  },
): ApprovalValidationVerdict {
  if (!approval) {
    return {
      valid: false,
      code: 'unauthorized',
      reason: 'Approval request does not exist.',
    }
  }

  // 1. Exact candidate match
  if (approval.candidateId !== candidate.candidateId) {
    return {
      valid: false,
      code: 'unauthorized',
      reason: `Approval request is for candidate ${approval.candidateId}, but attempted to promote ${candidate.candidateId}.`,
    }
  }

  // 2. Exact version match
  if (approval.strategyVersion !== candidate.version) {
    return {
      valid: false,
      code: 'unauthorized',
      reason: `Approval request is for strategy version ${approval.strategyVersion}, but candidate is version ${candidate.version}.`,
    }
  }

  // 3. Digest match (verifies candidate was not modified after authorization)
  const currentDigest = computeCandidateDigest(candidate)
  if (approval.candidateDigest !== currentDigest) {
    return {
      valid: false,
      code: 'unauthorized',
      reason: 'Candidate parameters or specifications were modified after approval was granted.',
    }
  }

  // 4. Authority scope check
  if (approval.authorityScope !== 'evolution.strategy.promote') {
    return {
      valid: false,
      code: 'unauthorized',
      reason: `Approval authority scope ${approval.authorityScope} does not match required evolution.strategy.promote.`,
    }
  }

  // 5. Purpose check (must authorize production promotion, not merely experimentation)
  if (approval.requestedPurpose !== 'production_promotion') {
    return {
      valid: false,
      code: 'unauthorized',
      reason: 'Approval grants experiment-only authority, not production promotion.',
    }
  }

  // 6. Status check
  if (approval.status === 'denied') {
    return {
      valid: false,
      code: 'unauthorized',
      reason: `Approval request was denied: ${approval.decisionReason ?? 'no reason provided'}.`,
    }
  }
  if (approval.status === 'revoked') {
    return {
      valid: false,
      code: 'unauthorized',
      reason: 'Approval request was revoked.',
    }
  }
  if (approval.status === 'expired') {
    return {
      valid: false,
      code: 'unauthorized',
      reason: 'Approval request has expired.',
    }
  }
  if (approval.status !== 'approved') {
    return {
      valid: false,
      code: 'unauthorized',
      reason: `Approval request is in status ${approval.status}, not approved.`,
    }
  }

  // 7. Principal check: must be approved by authenticated owner
  if (approval.decidedBy !== 'owner') {
    return {
      valid: false,
      code: 'unauthorized',
      reason: `Approval was decided by ${approval.decidedBy ?? 'unknown'}, not authenticated owner.`,
    }
  }

  // 8. Expiry check
  const nowMs = Date.parse(options?.now ?? new Date().toISOString())
  const expiresAtMs = Date.parse(approval.expiresAt)
  if (nowMs > expiresAtMs) {
    return {
      valid: false,
      code: 'unauthorized',
      reason: `Approval expired at ${approval.expiresAt} (current time: ${options?.now ?? new Date().toISOString()}).`,
    }
  }

  // 9. Consumed check: cannot be reused
  if (approval.consumed) {
    return {
      valid: false,
      code: 'unauthorized',
      reason: 'Approval request has already been consumed and cannot be reused.',
    }
  }

  // 10. Caller principal check: caller must be owner
  if (options?.callerPrincipal && options.callerPrincipal !== 'owner') {
    return {
      valid: false,
      code: 'unauthorized',
      reason: `Caller principal ${options.callerPrincipal} is not authorized to promote strategies.`,
    }
  }

  return { valid: true, approval }
}
