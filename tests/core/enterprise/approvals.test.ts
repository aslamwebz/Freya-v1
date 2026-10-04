import { describe, expect, it } from 'vitest'
import {
  approvalCovers,
  approvalDecisionIsOwners,
  checkApprovalGate,
  countPendingApprovals,
  isExpired,
  mayRequestApproval,
  readApprovalRequest,
  type ApprovalRecord,
  type ApprovalSubject,
} from '../../../core/enterprise'
import { T0, T_PLUS_1H, T_PLUS_25H } from './harness'

/**
 * Approvals, tested as the answer to "is this approval for *this* thing".
 *
 * The interesting failures are not "no approval exists" — that case is easy. They are
 * the ones where a real, owner-granted approval exists and is nonetheless the wrong one:
 * for a different page, a different action body, revoked, or expired. Each of those is
 * a case where a naive "is there a granted approval for this environment?" check says
 * yes and the action is wrong.
 */

const SUBJECT: ApprovalSubject = Object.freeze({
  kind: 'action',
  subjectKind: 'webzone-operation',
  subjectRef: 'act-1',
  subjectDigest: 'publish|https://example.com/about|5|0|USD',
})

function approval(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    approvalId: 'ap-1',
    environmentId: 'env-1',
    kind: 'action',
    subjectKind: 'webzone-operation',
    subjectRef: 'act-1',
    subjectDigest: 'publish|https://example.com/about|5|0|USD',
    reasoning: 'the owner was asked and agreed',
    state: 'granted',
    requestedAt: '2026-05-01T08:00:00.000Z',
    decidedAt: '2026-05-01T08:30:00.000Z',
    expiresAt: '2026-05-02T08:30:00.000Z',
    ...overrides,
  }
}

describe('an approval covers one exact action, not a reference', () => {
  it('covers the action it was granted for', () => {
    expect(approvalCovers(approval(), SUBJECT, T0).covers).toBe(true)
  })

  it('does not cover a different action body under the same reference', () => {
    // The substitution attack: the owner approved publishing page A, and something
    // later presents that approval while publishing page B.
    const verdict = approvalCovers(
      approval(),
      { ...SUBJECT, subjectDigest: 'publish|https://example.com/other|5|0|USD' },
      T0,
    )
    expect(verdict.covers).toBe(false)
    expect(verdict.code).toBe('approval-subject-mismatch')
    expect(verdict.reason).toContain('exact action')
  })

  it('does not cover a different subject reference', () => {
    const verdict = approvalCovers(approval(), { ...SUBJECT, subjectRef: 'act-2' }, T0)
    expect(verdict.code).toBe('approval-subject-mismatch')
  })

  it('does not cover a different subject kind', () => {
    const verdict = approvalCovers(approval(), { ...SUBJECT, subjectKind: 'task' }, T0)
    expect(verdict.code).toBe('approval-subject-mismatch')
  })

  it('does not cover a different approval kind', () => {
    // A spending approval is not an action approval. Using one to satisfy the other
    // would let a ceiling conversation authorise a public change.
    const verdict = approvalCovers(
      approval({ kind: 'spending' }),
      SUBJECT,
      T0,
    )
    expect(verdict.code).toBe('approval-subject-mismatch')
    expect(verdict.reason).toContain('spending')
  })

  it('is not a standing permission: it stops being one at its expiry', () => {
    const verdict = approvalCovers(approval(), SUBJECT, T_PLUS_25H)
    expect(verdict.covers).toBe(false)
    expect(verdict.code).toBe('approval-expired')
  })

  it('stops covering the moment the owner withdraws it', () => {
    const verdict = approvalCovers(approval({ state: 'revoked' }), SUBJECT, T0)
    expect(verdict.code).toBe('approval-revoked')
  })

  it('does not cover after an explicit denial', () => {
    const verdict = approvalCovers(approval({ state: 'denied' }), SUBJECT, T0)
    expect(verdict.code).toBe('approval-not-granted')
  })

  it('does not cover while still pending', () => {
    const verdict = approvalCovers(approval({ state: 'pending' }), SUBJECT, T0)
    expect(verdict.code).toBe('approval-not-granted')
  })
})

describe('the gate distinguishes "never asked" from "told no"', () => {
  it('says approval-missing when nothing was ever requested', () => {
    const verdict = checkApprovalGate({ approvals: [], subject: SUBJECT, at: T0 })
    expect(verdict.satisfied).toBe(false)
    expect(verdict.code).toBe('approval-missing')
    expect(verdict.reason).toContain('none has been requested')
  })

  it('says not-granted when the owner said no, so the two are never confused', () => {
    // Collapsing these would make "the owner said no" look like "we forgot to ask",
    // and a subsystem that cannot tell those apart keeps re-asking.
    const verdict = checkApprovalGate({
      approvals: [approval({ state: 'denied' })],
      subject: SUBJECT,
      at: T0,
    })
    expect(verdict.code).toBe('approval-not-granted')
  })

  it('prefers telling the owner the approval covers a different action', () => {
    const verdict = checkApprovalGate({
      approvals: [approval({ subjectDigest: 'something-else' })],
      subject: SUBJECT,
      at: T0,
    })
    expect(verdict.code).toBe('approval-subject-mismatch')
  })

  it('is satisfied by any one matching granted approval', () => {
    const verdict = checkApprovalGate({
      approvals: [
        approval({ approvalId: 'ap-old', state: 'denied' }),
        approval({ approvalId: 'ap-new', subjectDigest: 'something-else' }),
        approval({ approvalId: 'ap-good' }),
      ],
      subject: SUBJECT,
      at: T0,
    })
    expect(verdict.satisfied).toBe(true)
    expect(verdict.approvalId).toBe('ap-good')
  })

  it('ignores approvals for a different subject entirely when looking for one', () => {
    const verdict = checkApprovalGate({
      approvals: [approval({ subjectRef: 'act-9' })],
      subject: SUBJECT,
      at: T0,
    })
    expect(verdict.satisfied).toBe(false)
    expect(verdict.code).toBe('approval-missing')
  })
})

describe('an already-expired request is refused rather than raised and voided', () => {
  const valid = {
    environmentId: 'env-1',
    kind: 'action',
    subjectKind: 'webzone-operation',
    subjectRef: 'act-1',
    subjectDigest: 'digest-1',
    reasoning: 'the owner should know why',
    expiresAt: '2026-05-02T09:00:00.000Z',
  }

  it('accepts a request that expires in the future', () => {
    expect(readApprovalRequest(valid, T0).ok).toBe(true)
  })

  it('refuses one that expired before it was even raised', () => {
    // Otherwise "ask the owner" becomes a way to pass the gate without a person.
    const reading = readApprovalRequest({ ...valid, expiresAt: T0 }, T0)
    expect(reading.ok).toBe(false)
    expect(reading.reason).toContain('already expired')
  })

  it('refuses one with a relative or unparseable expiry', () => {
    for (const expiresAt of ['soon', '', 'in 5 minutes', 'tomorrow']) {
      const reading = readApprovalRequest({ ...valid, expiresAt }, T0)
      expect(reading.ok, expiresAt).toBe(false)
    }
  })

  it('refuses a request with no subject, because that approves everything', () => {
    const reading = readApprovalRequest({ ...valid, subjectRef: '' }, T0)
    expect(reading.ok).toBe(false)
    expect(reading.reason).toContain('approves everything')
  })

  it('refuses a request with no digest, so it cannot be swapped for another action', () => {
    const reading = readApprovalRequest({ ...valid, subjectDigest: '' }, T0)
    expect(reading.ok).toBe(false)
    expect(reading.reason).toContain('digest')
  })

  it('refuses a request with no reasoning', () => {
    const reading = readApprovalRequest({ ...valid, reasoning: '' }, T0)
    expect(reading.ok).toBe(false)
    expect(reading.reason).toContain('must say why')
  })

  it('refuses reasoning longer than the journal bound', () => {
    const reading = readApprovalRequest({ ...valid, reasoning: 'x'.repeat(500) }, T0)
    expect(reading.ok).toBe(false)
  })

  it('refuses an unknown kind or subject kind rather than defaulting', () => {
    expect(readApprovalRequest({ ...valid, kind: 'anything' }, T0).ok).toBe(false)
    expect(readApprovalRequest({ ...valid, subjectKind: 'whatever' }, T0).ok).toBe(false)
  })

  it('refuses a request with no environment', () => {
    const reading = readApprovalRequest({ ...valid, environmentId: '' }, T0)
    expect(reading.ok).toBe(false)
  })
})

describe('expiry is absolute and evaluated against the clock it is given', () => {
  it('is not expired at the instant of issue', () => {
    expect(isExpired(approval(), T0)).toBe(false)
  })

  it('is expired once the instant has passed, not before it', () => {
    const record = approval({ expiresAt: T_PLUS_1H })
    expect(isExpired(record, T0)).toBe(false)
    expect(isExpired(record, T_PLUS_1H)).toBe(true)
    expect(isExpired(record, T_PLUS_25H)).toBe(true)
  })

  it('fails closed on an expiry it cannot parse', () => {
    // Failing open here would let a hand-edited approval last forever.
    expect(isExpired(approval({ expiresAt: 'whenever' }), T0)).toBe(true)
    expect(isExpired(approval(), 'whenever')).toBe(true)
  })
})

describe('the owner cannot be pestered with requests', () => {
  it('counts pending requests per environment and kind', () => {
    const approvals = [
      approval({ approvalId: 'a1', kind: 'action', state: 'pending' }),
      approval({ approvalId: 'a2', kind: 'action', state: 'pending' }),
      approval({ approvalId: 's1', kind: 'spending', state: 'pending' }),
      approval({ approvalId: 'g1', kind: 'action', state: 'granted' }),
      approval({ approvalId: 'x1', kind: 'action', state: 'pending', environmentId: 'env-2' }),
    ]
    expect(countPendingApprovals(approvals, 'env-1')).toEqual({ action: 2, spending: 1, boundary: 0 })
  })

  it('refuses to exceed the pending bound for a kind', () => {
    const approvals = Array.from({ length: 32 }, (_, index) =>
      approval({ approvalId: `a${index}`, kind: 'action', state: 'pending' }),
    )
    const verdict = mayRequestApproval(approvals, 'env-1', 'action')
    expect(verdict.allowed).toBe(false)
    expect(verdict.code).toBe('approval-bound-exceeded')
  })

  it('allows the request that reaches the bound exactly', () => {
    const approvals = Array.from({ length: 31 }, (_, index) =>
      approval({ approvalId: `a${index}`, kind: 'action', state: 'pending' }),
    )
    expect(mayRequestApproval(approvals, 'env-1', 'action').allowed).toBe(true)
  })

  it('does not count settled requests against the bound', () => {
    const approvals = Array.from({ length: 100 }, (_, index) =>
      approval({ approvalId: `a${index}`, kind: 'action', state: 'granted' }),
    )
    expect(mayRequestApproval(approvals, 'env-1', 'action').allowed).toBe(true)
  })

  it('bounds each kind separately', () => {
    const spending = Array.from({ length: 16 }, (_, index) =>
      approval({ approvalId: `s${index}`, kind: 'spending', state: 'pending' }),
    )
    expect(mayRequestApproval(spending, 'env-1', 'spending').allowed).toBe(false)
    expect(mayRequestApproval(spending, 'env-1', 'action').allowed).toBe(true)
  })
})

describe('this subsystem cannot answer its own request', () => {
  it('accepts a decision that came from the owner', () => {
    expect(approvalDecisionIsOwners(SUBJECT, 'ap-1', 'owner')).toBe(true)
  })

  it('refuses a decision that came from Core, however it is dressed up', () => {
    // This is the single most dangerous failure available to this phase: an approval
    // is the only thing that lets otherwise-refused work proceed, so a subsystem that
    // can answer its own request has been handed the power the gate exists to prevent.
    expect(approvalDecisionIsOwners(SUBJECT, 'ap-1', 'core')).toBe(false)
    for (const decidedBy of ['agent', 'model', 'system', undefined, null, '', 'OWNER', 'Owner']) {
      expect(approvalDecisionIsOwners(SUBJECT, 'ap-1', decidedBy), String(decidedBy)).toBe(false)
    }
  })

  it('refuses an owner decision with no approval id or no digest', () => {
    expect(approvalDecisionIsOwners(SUBJECT, '', 'owner')).toBe(false)
    expect(
      approvalDecisionIsOwners({ ...SUBJECT, subjectDigest: '' }, 'ap-1', 'owner'),
    ).toBe(false)
  })
})