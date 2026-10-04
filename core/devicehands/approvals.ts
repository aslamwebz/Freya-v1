import {
  DEVICE_HANDS_LIMITS,
  isDeviceHandsApprovalState,
  type DeviceHandsActionKey,
  type DeviceHandsApprovalRecord,
  type DeviceHandsApprovalState,
  type DeviceHandsApprovalSubject,
  type DeviceHandsRefusalCode,
} from './types'

/**
 * Owner approvals: the only thing standing between a request and an action that
 * executes, reads somebody's buffer, or leaves the machine.
 *
 * ## What is deliberately enforced
 *
 * - **An approval is bound to one exact action body.** Every field that would change
 *   what the action *does* goes into `digest`, and {@link approvalCovers} compares the
 *   subject rather than checking that *an* approval exists. That is what stops the
 *   obvious substitution: an approval for `run ls in /tmp` is not permission to `run
 *   rm -rf /tmp`, because the two digests differ.
 * - **Only the owner decides.** A decision reporting that it came from `core` is
 *   recorded as a **denial** ({@link approvalDecisionIsOwners}). An approval is the
 *   single thing that lets work this subsystem would otherwise refuse proceed, so
 *   "who answered" is part of the answer it gets — and an answer from anybody but the
 *   owner is the answer `no`.
 * - **Approvals expire, are revocable, and are single-subject.** There is no
 *   "until further notice" and no wildcard subject. A grant of *many* actions is a
 *   grant of a list of action keys, checked one at a time.
 * - **Pending approvals are bounded**, so a system that keeps asking cannot fill the
 *   record with requests nobody will answer.
 * - **The reasoning is not in here.** An approval request carries no model prose: a
 *   person is being asked to authorize running a program or sending a file, and a
 *   generated justification in that position is the persuasion problem this phase
 *   exists to avoid.
 */

export interface ApprovalRequestReading {
  readonly ok: boolean
  readonly request:
    | {
        readonly approvalId: string
        readonly actionKey: DeviceHandsActionKey
        readonly subjectRef: string
        readonly digest: string
        readonly expiresAt: string
      }
    | null
  readonly code: DeviceHandsRefusalCode | null
  readonly reason: string
}

/**
 * Read one approval request.
 *
 * `digest` is supplied by the runtime, from the *normalised* action — not by the
 * caller. That ordering is the whole of the substitution defence: a caller cannot
 * choose what it is asking to be approved for, it can only ask, and the runtime
 * answers with the digest of what it would actually do.
 */
export function readApprovalRequest(
  input: unknown,
  actionKey: DeviceHandsActionKey,
  digest: string,
  now: string,
): ApprovalRequestReading {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {
      ok: false,
      request: null,
      code: 'request-malformed',
      reason: 'An approval request must be an object.',
    }
  }
  const raw = input as Record<string, unknown>
  if (typeof raw.approvalId !== 'string' || raw.approvalId.length === 0 || raw.approvalId.length > 128) {
    return {
      ok: false,
      request: null,
      code: 'request-malformed',
      reason: 'An approval request needs an id of at most 128 characters.',
    }
  }
  if (typeof raw.subjectRef !== 'string' || raw.subjectRef.length === 0 || raw.subjectRef.length > 200) {
    return {
      ok: false,
      request: null,
      code: 'request-malformed',
      reason: 'An approval request needs a subject reference of at most 200 characters.',
    }
  }
  if (raw.actionKey !== undefined && raw.actionKey !== actionKey) {
    return {
      ok: false,
      request: null,
      code: 'approval-subject-mismatch',
      reason: 'An approval request cannot name a different action than the one it is for.',
    }
  }
  const expiresAt = readExpiry(raw.expiresAt, now)
  if (expiresAt === null) {
    return {
      ok: false,
      request: null,
      code: 'request-malformed',
      reason: `An approval request needs an absolute expiry instant no more than ${String(DEVICE_HANDS_LIMITS.maxApprovalTtlMs / 60_000)} minutes out. A relative or missing expiry is refused.`,
    }
  }
  if (Date.parse(now) >= Date.parse(expiresAt)) {
    return {
      ok: false,
      request: null,
      code: 'approval-expired',
      reason: 'An approval request must expire in the future. An already-expired request cannot be granted.',
    }
  }
  return {
    ok: true,
    request: { approvalId: raw.approvalId, actionKey, subjectRef: raw.subjectRef, digest, expiresAt },
    code: null,
    reason: 'The request names one exact action body.',
  }
}

function readExpiry(value: unknown, now: string): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null
  const nowMs = Date.parse(now)
  const expiryMs = Date.parse(value)
  if (!Number.isFinite(nowMs)) return null
  // Only ever *narrowed*. An owner may ask for a shorter window than the ceiling and
  // may never ask for a longer one; a request for a year is refused rather than
  // clamped, because a clamped request still reads to the owner as a year.
  if (expiryMs - nowMs > DEVICE_HANDS_LIMITS.maxApprovalTtlMs) return null
  return new Date(expiryMs).toISOString()
}

/** Whether an instant has passed. An unparseable instant has not. */
export function isExpired(expiresAt: string, now: string): boolean {
  const expiry = Date.parse(expiresAt)
  const at = Date.parse(now)
  if (!Number.isFinite(expiry) || !Number.isFinite(at)) return false
  return at >= expiry
}

/**
 * Whether a granted, unexpired, unrevoked approval covers exactly this subject.
 *
 * The comparison is on `actionKey` **and** `digest` **and** `subjectRef`. Dropping
 * any one of the three opens a real hole: comparing only the digest would let an
 * approval for one action id be presented for another identical one; comparing only
 * the action key would let any approval for `terminal.run` do any `terminal.run`.
 */
export function approvalCovers(
  approvals: readonly DeviceHandsApprovalRecord[],
  subject: DeviceHandsApprovalSubject,
  now: string,
): { readonly satisfied: boolean; readonly code: DeviceHandsRefusalCode | null; readonly reason: string } {
  let sawAny = false
  let sawGranted = false
  let grantedButExpired = false
  let sawExpired = false
  let sawRevoked = false
  let sawDenied = false

  for (const approval of approvals) {
    if (approval.subject.actionKey !== subject.actionKey) continue
    sawAny = true
    if (approval.state !== 'granted') {
      if (approval.state === 'expired') sawExpired = true
      if (approval.state === 'revoked') sawRevoked = true
      if (approval.state === 'denied') sawDenied = true
      continue
    }
    sawGranted = true
    if (isExpired(approval.expiresAt, now)) {
      // Counted separately from `sawExpired`, because "the owner granted this and the
      // window closed" and "this was never granted" are different answers and an audit
      // trail that merged them would make an expired approval look like a missing one.
      grantedButExpired = true
      sawExpired = true
      continue
    }
    if (
      approval.subject.digest === subject.digest &&
      approval.subject.subjectRef === subject.subjectRef
    ) {
      return {
        satisfied: true,
        code: null,
        reason: 'An approval the owner granted covers this exact action body and has not expired.',
      }
    }
  }

  if (!sawAny) {
    return {
      satisfied: false,
      code: 'approval-missing',
      reason: `No approval exists for ${subject.actionKey}. An approval covers one action body, not an action name.`,
    }
  }
  if (grantedButExpired) {
    return {
      satisfied: false,
      code: 'approval-expired',
      reason:
        'The owner approved this action name, but the approval has expired. A new approval is a new question to the owner, not a renewal of the old answer.',
    }
  }
  if (sawRevoked && !sawGranted) {
    return { satisfied: false, code: 'approval-revoked', reason: 'The approval covering this action was revoked.' }
  }
  if (sawDenied && !sawGranted) {
    return {
      satisfied: false,
      code: 'approval-not-granted',
      reason:
        'The owner was asked about this action and declined. A refusal is not a permission to ask again with the same request.',
    }
  }
  if (sawExpired && !sawGranted) {
    return { satisfied: false, code: 'approval-expired', reason: 'The approval covering this action has expired.' }
  }
  return {
    satisfied: false,
    code: 'approval-subject-mismatch',
    reason:
      'An approval exists for this action name, but not for this exact action body. An approval the owner gave for one command is not permission to run a different one.',
  }
}

/**
 * Whether a decision actually came from the owner.
 *
 * Narrow to the point of absurdity on purpose: `owner` is the only value that
 * returns true, so there is no configuration in which adding a decision-maker later
 * silently starts letting that decision-maker approve things.
 */
export function approvalDecisionIsOwners(decidedBy: unknown): boolean {
  return decidedBy === 'owner'
}

/** How many approvals are still awaiting an answer. */
export function countPendingApprovals(
  approvals: readonly DeviceHandsApprovalRecord[],
): number {
  let count = 0
  for (const approval of approvals) {
    if (approval.state === 'pending') count += 1
  }
  return count
}

/** Whether another approval may be requested. */
export function mayRequestApproval(
  approvals: readonly DeviceHandsApprovalRecord[],
): { readonly ok: boolean; readonly reason: string } {
  const pending = countPendingApprovals(approvals)
  if (pending >= DEVICE_HANDS_LIMITS.maxPendingApprovals) {
    return {
      ok: false,
      reason: `There are already ${String(pending)} approvals waiting for an answer, which is the ceiling. Device Hands will not keep asking.`,
    }
  }
  return { ok: true, reason: 'There is room to ask.' }
}

/**
 * Apply a decision to an approval record, honouring the machine.
 *
 * `pending → granted | denied`, and `granted → revoked`. A denied or revoked approval
 * is terminal: a later entry cannot revive it, because an approval somebody took back
 * is not an approval somebody gave again.
 */
export function mayTransitionApproval(
  from: DeviceHandsApprovalState,
  to: DeviceHandsApprovalState,
): { readonly allowed: boolean; readonly reason: string } {
  if (!isDeviceHandsApprovalState(from) || !isDeviceHandsApprovalState(to)) {
    return { allowed: false, reason: 'That is not an approval state this build knows.' }
  }
  if (from === to) {
    return { allowed: false, reason: `This approval is already ${to}.` }
  }
  if (from === 'pending' && (to === 'granted' || to === 'denied')) {
    return { allowed: true, reason: 'The owner answered.' }
  }
  if (from === 'granted' && to === 'revoked') {
    return { allowed: true, reason: 'The owner took the approval back.' }
  }
  return {
    allowed: false,
    reason: `An approval that is ${from} cannot become ${to}. A terminal decision is history.`,
  }
}