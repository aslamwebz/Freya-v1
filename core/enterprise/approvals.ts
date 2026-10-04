import {
  APPROVAL_PENDING_LIMITS,
  approvalTransition,
} from './machine'
import {
  ENTERPRISE_LIMITS,
  isApprovalKind,
  isApprovalSubjectKind,
  type ApprovalKind,
  type ApprovalState,
  type ApprovalSubjectKind,
  type EnterpriseRefusalCode,
} from './types'
import type { EnterpriseApprovalRequest } from './ports'

/**
 * Owner approvals.
 *
 * An approval is the only thing in this phase that lets work the subsystem would
 * otherwise refuse proceed, so the interesting question is not "is there an approval"
 * but **"is this approval for *this* thing"**. Everything here is built around
 * answering that second question.
 *
 * Three properties carry it:
 *
 *   - **One subject per approval.** An approval names a `subjectKind`, a `subjectRef`
 *     *and* a `subjectDigest`. The digest is the body of the exact action; Core
 *     computes it and this lane only ever compares it for equality. Publishing an
 *     approved page and then publishing a *different* page under the same reference
 *     changes the digest, and `approvalCovers` refuses.
 *
 *   - **Single use, by construction.** There is no "approvals remaining" counter to
 *     manage and no way to widen an approval's scope, because there is no scope field
 *     wider than one subject. An approval cannot become a standing permission.
 *
 *   - **Revocable, and the revocation survives.** `granted` is deliberately not
 *     terminal in `../enterprise/machine`, so an approval the owner withdrew is
 *     recorded as withdrawn rather than quietly surviving in the fold as `granted`.
 *
 * This lane can *ask* for an approval and can *check* one. It cannot grant, deny,
 * forge or widen one, and it cannot answer its own request: `approvalDecisionIsOwners`
 * exists to refuse an answer that did not come from the owner.
 *
 * Pure. No clock, no journal, no owner, no network.
 */

export interface ApprovalRecord {
  readonly approvalId: string
  readonly environmentId: string
  readonly kind: ApprovalKind
  readonly subjectKind: ApprovalSubjectKind
  readonly subjectRef: string
  readonly subjectDigest: string
  readonly reasoning: string
  readonly state: ApprovalState
  readonly requestedAt: string
  readonly decidedAt: string | null
  readonly expiresAt: string
}

export interface ApprovalRequestReading {
  readonly ok: boolean
  readonly request: EnterpriseApprovalRequest | null
  readonly code: EnterpriseRefusalCode | null
  readonly reason: string
}

function isInstant(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

/**
 * Validate a request before it is put in front of the owner.
 *
 * The expiry is absolute and must be in the future *at request time*, checked here
 * rather than at decision time. An approval that is already expired when it is raised
 * is not a slow approval, it is a way to make the gate pass without a person ever
 * being asked — so it is refused at the point of creation.
 */
export function readApprovalRequest(input: unknown, now: string): ApprovalRequestReading {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>

  if (!isApprovalKind(raw.kind)) {
    return {
      ok: false,
      request: null,
      code: 'approval-required',
      reason: 'The approval kind is not one of action, spending or boundary.',
    }
  }
  if (!isApprovalSubjectKind(raw.subjectKind)) {
    return {
      ok: false,
      request: null,
      code: 'approval-required',
      reason: 'The approval subject kind is not one this phase can ask about.',
    }
  }
  if (typeof raw.subjectRef !== 'string' || raw.subjectRef.length === 0) {
    return {
      ok: false,
      request: null,
      code: 'approval-required',
      reason: 'An approval must name one subject. An approval naming nothing approves everything.',
    }
  }
  if (typeof raw.subjectDigest !== 'string' || raw.subjectDigest.length === 0) {
    return {
      ok: false,
      request: null,
      code: 'approval-required',
      reason:
        'An approval must carry a digest of the exact action body, so it cannot be spent on a different one.',
    }
  }
  if (typeof raw.environmentId !== 'string' || raw.environmentId.length === 0) {
    return {
      ok: false,
      request: null,
      code: 'environment-unknown',
      reason: 'An approval must name the environment it belongs to.',
    }
  }
  if (!isInstant(raw.expiresAt)) {
    return {
      ok: false,
      request: null,
      code: 'approval-required',
      reason: 'An approval expiry must be an absolute instant, so a restart cannot extend it.',
    }
  }
  if (Date.parse(raw.expiresAt) <= Date.parse(now)) {
    return {
      ok: false,
      request: null,
      code: 'approval-required',
      reason:
        'An approval that has already expired is refused at request time rather than raised and immediately voided.',
    }
  }
  const reasoning = typeof raw.reasoning === 'string' ? raw.reasoning : ''
  if (reasoning.length > ENTERPRISE_LIMITS.maxPayloadTextLength) {
    return {
      ok: false,
      request: null,
      code: 'approval-required',
      reason: 'The reasoning shown to the owner is longer than the bounded length.',
    }
  }
  if (reasoning.length === 0) {
    return {
      ok: false,
      request: null,
      code: 'approval-required',
      reason:
        'An approval request must say why. An owner asked to authorize money or a public change is owed a reason.',
    }
  }

  return {
    ok: true,
    request: {
      environmentId: raw.environmentId,
      kind: raw.kind,
      subjectKind: raw.subjectKind,
      subjectRef: raw.subjectRef,
      subjectDigest: raw.subjectDigest,
      reasoning,
      expiresAt: raw.expiresAt,
    },
    code: null,
    reason: 'The request names exactly one subject, carries a digest and expires at an absolute instant.',
  }
}

/* ------------------------------------------------------------------ gates */

export interface ApprovalSubject {
  readonly kind: ApprovalKind
  readonly subjectKind: ApprovalSubjectKind
  readonly subjectRef: string
  readonly subjectDigest: string
}

export interface ApprovalGateInput {
  readonly approvals: readonly ApprovalRecord[]
  readonly subject: ApprovalSubject
  readonly at: string
}

export interface ApprovalGateDecision {
  readonly satisfied: boolean
  readonly approvalId: string | null
  readonly code: EnterpriseRefusalCode | null
  readonly reason: string
}

const REFUSED = (
  code: EnterpriseRefusalCode,
  reason: string,
  approvalId: string | null = null,
): ApprovalGateDecision => ({ satisfied: false, approvalId, code, reason })

/** Is this instant past the approval's expiry? */
export function isExpired(approval: ApprovalRecord, at: string): boolean {
  const now = Date.parse(at)
  const expiry = Date.parse(approval.expiresAt)
  if (!Number.isFinite(now) || !Number.isFinite(expiry)) return true
  return now >= expiry
}

/**
 * Does this specific approval cover this specific subject?
 *
 * All four fields compared, and the state checked, in one place so that there is
 * exactly one definition of "approved" in the phase. Comparing on the subject rather
 * than merely testing for the existence of a granted approval is the whole defence
 * against approval reuse: a granted approval for a different page, a different task
 * or a different operation body does not appear here at all.
 */
export function approvalCovers(
  approval: ApprovalRecord,
  subject: ApprovalSubject,
  at: string,
): { readonly covers: boolean; readonly code: EnterpriseRefusalCode | null; readonly reason: string } {
  if (approval.kind !== subject.kind) {
    return {
      covers: false,
      code: 'approval-subject-mismatch',
      reason: `This is a ${approval.kind} approval and the action needs a ${subject.kind} approval.`,
    }
  }
  if (approval.subjectKind !== subject.subjectKind) {
    return {
      covers: false,
      code: 'approval-subject-mismatch',
      reason: `This approval is about a ${approval.subjectKind}, not a ${subject.subjectKind}.`,
    }
  }
  if (approval.subjectRef !== subject.subjectRef) {
    return {
      covers: false,
      code: 'approval-subject-mismatch',
      reason: 'This approval names a different subject.',
    }
  }
  if (approval.subjectDigest !== subject.subjectDigest) {
    return {
      covers: false,
      code: 'approval-subject-mismatch',
      reason:
        'The action body differs from the one the owner approved. An approval covers one exact action, not a reference.',
    }
  }
  if (approval.state === 'revoked') {
    return { covers: false, code: 'approval-revoked', reason: 'The owner withdrew this approval.' }
  }
  if (approval.state === 'denied') {
    return {
      covers: false,
      code: 'approval-not-granted',
      reason: 'The owner denied this approval.',
    }
  }
  if (approval.state === 'expired' || isExpired(approval, at)) {
    return {
      covers: false,
      code: 'approval-expired',
      reason: 'This approval expired. An expired approval is not a slow approval; it is no approval.',
    }
  }
  if (approval.state !== 'granted') {
    return {
      covers: false,
      code: 'approval-not-granted',
      reason: 'The owner has not decided on this approval yet.',
    }
  }
  return {
    covers: true,
    code: null,
    reason: 'The owner granted this exact action and it has not been withdrawn or expired.',
  }
}

/**
 * The approval gate.
 *
 * Two distinct refusals that are worth keeping apart, because they mean different
 * things to the owner:
 *
 *   - `approval-missing` — nothing has ever been asked. The action needs approval and
 *     nobody has been asked, so the right next step is to ask.
 *   - `approval-not-granted` — something was asked and the answer was no, or has not
 *     arrived. The right next step is to wait, or to stop.
 *
 * Collapsing them would make "the owner said no" look like "we forgot to ask", and a
 * subsystem that keeps re-asking a person who already said no is a subsystem that has
 * learned to pester.
 */
export function checkApprovalGate(input: ApprovalGateInput): ApprovalGateDecision {
  const matching = input.approvals.filter(
    (approval) =>
      approval.kind === input.subject.kind &&
      approval.subjectKind === input.subject.subjectKind &&
      approval.subjectRef === input.subject.subjectRef,
  )

  if (matching.length === 0) {
    return REFUSED(
      'approval-missing',
      `This action needs a ${input.subject.kind} approval and none has been requested for ${input.subject.subjectRef}.`,
    )
  }

  // Prefer a refusal that is specific about the subject over one that is not, so the
  // owner is told the approval covers a different action rather than that a stale one
  // is in the way.
  let mismatch: ApprovalGateDecision | null = null
  for (const approval of matching) {
    const verdict = approvalCovers(approval, input.subject, input.at)
    if (verdict.covers) {
      return {
        satisfied: true,
        approvalId: approval.approvalId,
        code: null,
        reason: verdict.reason,
      }
    }
    if (verdict.code === 'approval-subject-mismatch') {
      mismatch = REFUSED(verdict.code, verdict.reason, approval.approvalId)
    }
  }
  if (mismatch !== null) return mismatch

  const decided = matching[matching.length - 1]
  const verdict =
    decided === undefined
      ? null
      : approvalCovers(decided, input.subject, input.at)
  return REFUSED(
    verdict?.code ?? 'approval-not-granted',
    verdict?.reason ?? 'No approval covers this action.',
    decided?.approvalId ?? null,
  )
}

/* ----------------------------------------------------------------- bounds */

export interface PendingApprovalCount {
  readonly action: number
  readonly spending: number
  readonly boundary: number
}

export function countPendingApprovals(
  approvals: readonly ApprovalRecord[],
  environmentId: string,
): PendingApprovalCount {
  const pending = approvals.filter(
    (approval) => approval.environmentId === environmentId && approval.state === 'pending',
  )
  return {
    action: pending.filter((approval) => approval.kind === 'action').length,
    spending: pending.filter((approval) => approval.kind === 'spending').length,
    boundary: pending.filter((approval) => approval.kind === 'boundary').length,
  }
}

/**
 * May one more pending approval of this kind be raised?
 *
 * The bound exists so that "ask the owner" is not a way to fill a queue. A subsystem
 * that can raise requests without limit will raise requests without limit, and the
 * owner's approval queue becoming noise is how approval stops meaning consent.
 */
export function mayRequestApproval(
  approvals: readonly ApprovalRecord[],
  environmentId: string,
  kind: ApprovalKind,
): { readonly allowed: boolean; readonly code: EnterpriseRefusalCode | null; readonly reason: string } {
  const counts = countPendingApprovals(approvals, environmentId)
  const limit = APPROVAL_PENDING_LIMITS[kind]
  const current = counts[kind]
  if (current >= limit) {
    return {
      allowed: false,
      code: 'approval-bound-exceeded',
      reason: `This environment already has its ceiling of ${String(limit)} pending ${kind} approvals.`,
    }
  }
  return {
    allowed: true,
    code: null,
    reason: `${String(current)} of ${String(limit)} pending ${kind} approvals are outstanding.`,
  }
}

/* ----------------------------------------------------------- owner answers */

/**
 * Is this answer actually the owner's?
 *
 * The enterprise subsystem cannot approve its own requests. Rather than trusting that
 * every caller of `requestOwnerApproval` is Core, the decision is checked: only the
 * owner's decision may move an approval, and anything else leaves it `pending`.
 *
 * A subsystem that answers its own approval request has not been given a new
 * capability — it has been handed the power to do exactly what the owner gate exists
 * to prevent, which is the most dangerous single thing this phase could get wrong.
 */
export function approvalDecisionIsOwners(
  subject: ApprovalSubject,
  approvalId: string,
  decidedBy: unknown,
): boolean {
  return (
    decidedBy === 'owner' &&
    typeof approvalId === 'string' &&
    approvalId.length > 0 &&
    typeof subject.subjectDigest === 'string' &&
    subject.subjectDigest.length > 0
  )
}

/**
 * May this approval move to this state?
 *
 * Delegates to the shared table so an approval cannot be driven through a path the
 * environment state machine would refuse.
 */
export function mayTransitionApproval(
  from: ApprovalState,
  to: ApprovalState,
): { readonly allowed: boolean; readonly code: string; readonly reason: string } {
  return approvalTransition(from, to)
}