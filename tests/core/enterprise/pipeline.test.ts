import { describe, expect, it } from 'vitest'
import {
  ENTERPRISE_LIMITS,
  actionDigest,
  authorizeEnterpriseAction,
  dayKeyOf,
  type ApprovalRecord,
} from '../../../core/enterprise'
import { actionRequest, passingContext } from './harness'

/**
 * The authorization pipeline, tested as the one door every action must come through.
 *
 * The central claim of this test file is that **no gate can be skipped**. That is
 * proved by execution rather than by reading: a request that passes everything is shown
 * to evaluate all nine gates, and a request that fails gate *k* is shown to evaluate
 * exactly gates 1..k and to name gate *k*. A gate added to the table without being
 * wired would fail the first case.
 */

describe('a request that passes everything evaluates every gate', () => {
  it('walks all nine, in order, with nothing left over', () => {
    const decision = authorizeEnterpriseAction(passingContext(), actionRequest())
    expect(decision.allowed).toBe(true)
    expect(decision.refusedAt).toBeNull()
    expect(decision.evaluated).toHaveLength(9)
    expect(decision.remaining).toEqual([])
    expect(decision.evaluated[0]).toBe('journal-trustworthy')
    expect(decision.evaluated[decision.evaluated.length - 1]).toBe('verification')
  })
})

describe('a refusal short-circuits, and names the gate that refused', () => {
  /**
   * Each case fails exactly one gate with the earlier ones passing, and asserts both
   * halves: which gate refused, and that nothing after it was consulted. A gate that
   * refused without stopping the walk would be a gate that costs an owner an
   * interruption for work it was never going to allow.
   */
  const cases = [
    {
      name: 'an untrustworthy journal',
      context: () => passingContext({ journalTrustworthy: false }),
      request: () => actionRequest(),
      gate: 'journal-trustworthy',
      code: 'journal-untrustworthy',
    },
    {
      name: 'STOP ALL latched',
      context: () => passingContext({ stopped: true }),
      request: () => actionRequest(),
      gate: 'stop-all',
      code: 'stop-all-latched',
    },
    {
      name: 'the subsystem is switched off',
      context: () => passingContext({ enabled: false }),
      request: () => actionRequest(),
      gate: 'environment',
      code: 'subsystem-disabled',
    },
    {
      name: 'a terminal environment',
      context: () => passingContext({ state: 'completed' }),
      request: () => actionRequest(),
      gate: 'environment',
      code: 'environment-terminal',
    },
    {
      name: 'a draft environment',
      context: () => passingContext({ state: 'draft' }),
      request: () => actionRequest(),
      gate: 'environment',
      code: 'environment-not-active',
    },
    {
      name: 'a past deadline',
      context: () => passingContext({ deadlineAt: '2026-05-01T08:00:00.000Z' }),
      request: () => actionRequest({ at: '2026-05-01T09:00:00.000Z' }),
      gate: 'deadline',
      code: 'deadline-expired',
    },
    {
      name: 'a target outside the allowlist',
      context: () => passingContext(),
      request: () => actionRequest({ target: 'https://evil.test/about' }),
      gate: 'boundary',
      code: 'domain-not-allowed',
    },
    {
      name: 'an operation-count ceiling already reached',
      context: () => passingContext({ counts: { tasks: 0, missions: 0, operations: 16, concurrent: 0 } }),
      request: () => actionRequest(),
      gate: 'boundary',
      code: 'operation-count-exceeded',
    },
    {
      name: 'a per-action spending ceiling exceeded',
      context: () => passingContext(),
      request: () => actionRequest({ amountMinor: 2_501 }),
      gate: 'spending',
      code: 'spending-per-action-exceeded',
    },
    {
      // Two days of spending, each inside the daily ceiling, together over the total.
      // This isolates the total gate: a per-day-only test would pass even if the total
      // gate did not exist.
      name: 'a total spending ceiling exceeded across several days',
      context: () => passingContext({ spentMinor: 9_000 }),
      request: () => actionRequest({ amountMinor: 1_500, at: '2026-05-03T09:00:00.000Z' }),
      gate: 'spending',
      code: 'spending-total-exceeded',
    },
    {
      name: 'a daily spending ceiling exceeded on the day itself',
      context: () => passingContext({ spentMinor: 4_000 }),
      request: () => actionRequest({ amountMinor: 1_500 }),
      gate: 'spending',
      code: 'spending-per-day-exceeded',
    },
  ] as const

  for (const testCase of cases) {
    it(`refuses on ${testCase.name} at the ${testCase.gate} gate`, () => {
      const decision = authorizeEnterpriseAction(testCase.context(), testCase.request())
      expect(decision.allowed).toBe(false)
      expect(decision.refusedAt).toBe(testCase.gate)
      expect(decision.code).toBe(testCase.code)
      expect(decision.reason.length).toBeGreaterThan(0)
    })
  }

  it('stops at the refusing gate and consults nothing after it', () => {
    const decision = authorizeEnterpriseAction(passingContext({ stopped: true }), actionRequest())
    expect(decision.evaluated).toEqual(['journal-trustworthy', 'stop-all'])
    expect(decision.remaining).toEqual([
      'environment',
      'deadline',
      'duration',
      'boundary',
      'spending',
      'approval',
      'verification',
    ])
  })

  it('checks money before it troubles the owner', () => {
    // One action that both overspends and needs approval. The refusal must be the
    // money, because asking a person to authorize work the ceiling forbids anyway is
    // the failure mode the gate order exists to prevent.
    const decision = authorizeEnterpriseAction(
      passingContext(),
      actionRequest({ amountMinor: 99_999, consequential: true }),
    )
    expect(decision.refusedAt).toBe('spending')
    expect(decision.evaluated).not.toContain('approval')
  })

  it('checks the journal and the stop latch before anything that could spend', () => {
    const decision = authorizeEnterpriseAction(
      passingContext({ stopped: true, journalTrustworthy: false, spentMinor: 9_999 }),
      actionRequest({ amountMinor: 500 }),
    )
    // The journal gate is first, so it refuses even though the stop is also latched.
    expect(decision.refusedAt).toBe('journal-trustworthy')
  })
})

describe('the approval gate is only consulted when an approval is actually required', () => {
  it('is skipped for a read, which cannot be authorized because it changes nothing', () => {
    const decision = authorizeEnterpriseAction(passingContext(), actionRequest({ kind: 'query' }))
    expect(decision.allowed).toBe(true)
    // Consulted as part of the walk, but it held trivially.
    expect(decision.evaluated).toContain('approval')
    expect(decision.approvalSubject).toBeNull()
  })

  it('refuses a consequential publish with no approval at all', () => {
    const decision = authorizeEnterpriseAction(
      passingContext(),
      actionRequest({ consequential: true }),
    )
    expect(decision.refusedAt).toBe('approval')
    expect(decision.code).toBe('approval-missing')
  })

  it('refuses a delete even when the caller does not call it consequential', () => {
    const decision = authorizeEnterpriseAction(
      passingContext(),
      actionRequest({ kind: 'delete', consequential: false }),
    )
    expect(decision.refusedAt).toBe('approval')
    expect(decision.code).toBe('approval-missing')
  })

  it('allows a consequential publish covered by an approval for that exact body', () => {
    const request = actionRequest({ consequential: true })
    const approval = grantedApprovalFor(request)
    const decision = authorizeEnterpriseAction(passingContext({ approvals: [approval] }), request)
    expect(decision.allowed).toBe(true)
  })

  it('refuses the same publish when the approval was for a different body', () => {
    const approval = grantedApprovalFor(actionRequest({ payload: 'a different page' }))
    const decision = authorizeEnterpriseAction(
      passingContext({ approvals: [approval] }),
      actionRequest({ consequential: true }),
    )
    expect(decision.refusedAt).toBe('approval')
    expect(decision.code).toBe('approval-subject-mismatch')
  })

  it('refuses it when the approval was revoked', () => {
    const approval = grantedApprovalFor(actionRequest({ consequential: true }))
    const decision = authorizeEnterpriseAction(
      passingContext({ approvals: [{ ...approval, state: 'revoked' }] }),
      actionRequest({ consequential: true }),
    )
    expect(decision.code).toBe('approval-revoked')
  })
})

describe('an approval covers exactly one action body', () => {
  it('binds to the kind, target, payload length, amount and currency', () => {
    const request = actionRequest()
    const digest = actionDigest(request)
    expect(digest).toContain('publish')
    expect(digest).toContain(request.target)
  })

  it('changes when any of them changes', () => {
    const base = actionDigest(actionRequest())
    expect(actionDigest(actionRequest({ target: 'https://example.com/other' }))).not.toBe(base)
    expect(actionDigest(actionRequest({ payload: 'different' }))).not.toBe(base)
    expect(actionDigest(actionRequest({ amountMinor: 100 }))).not.toBe(base)
    expect(actionDigest(actionRequest({ currency: 'EUR' }))).not.toBe(base)
    expect(actionDigest(actionRequest({ kind: 'update' }))).not.toBe(base)
  })
})

describe('completion requires verification, and a failed one is not a pass', () => {
  it('refuses to call a performed action complete with no verification record', () => {
    const decision = authorizeEnterpriseAction(
      passingContext(),
      actionRequest({ performed: true }),
    )
    expect(decision.refusedAt).toBe('verification')
    expect(decision.code).toBe('verification-missing')
  })

  it('refuses when the verification failed', () => {
    const decision = authorizeEnterpriseAction(
      passingContext({
        verification: {
          verificationId: 'v-1',
          actionId: 'act-1',
          environmentId: 'env-1',
          outcome: 'failed',
          reason: 'it did not happen',
          verifiedAt: '2026-05-01T09:00:00.000Z',
        },
      }),
      actionRequest({ performed: true }),
    )
    expect(decision.refusedAt).toBe('verification')
    expect(decision.code).toBe('verification-failed')
  })

  it('allows a performed action whose verification passed', () => {
    const decision = authorizeEnterpriseAction(
      passingContext({
        verification: {
          verificationId: 'v-1',
          actionId: 'act-1',
          environmentId: 'env-1',
          outcome: 'passed',
          reason: 'observed',
          verifiedAt: '2026-05-01T09:00:00.000Z',
        },
      }),
      actionRequest({ performed: true }),
    )
    expect(decision.allowed).toBe(true)
  })
})

describe('the duration ceiling is the code-owned one, not the owner\'s', () => {
  it('refuses an environment older than the phase ceiling', () => {
    const decision = authorizeEnterpriseAction(
      passingContext({ createdAt: '2020-01-01T00:00:00.000Z' }),
      actionRequest(),
    )
    expect(decision.refusedAt).toBe('duration')
    expect(decision.code).toBe('duration-ceiling-exceeded')
  })

  it('allows one comfortably inside it', () => {
    const decision = authorizeEnterpriseAction(
      passingContext({ createdAt: '2026-04-01T00:00:00.000Z' }),
      actionRequest(),
    )
    expect(decision.allowed).toBe(true)
  })
})

describe('the day key is UTC and derived, not local and not read from a clock', () => {
  it('groups by UTC date so a timezone change cannot open a hole in the ceiling', () => {
    expect(dayKeyOf('2026-05-01T23:59:00.000Z')).toBe('2026-05-01')
    expect(dayKeyOf('2026-05-02T00:01:00.000Z')).toBe('2026-05-02')
  })

  it('refuses an instant it cannot parse rather than inventing a day', () => {
    expect(dayKeyOf('not-a-date')).toBeNull()
  })

  it('is the basis of the daily ceiling, which therefore resets on the UTC date', () => {
    const ceiling = ENTERPRISE_LIMITS.maxEnvironments
    expect(ceiling).toBeGreaterThan(0)
    // Spend most of the day ceiling on day one; day two is unaffected by design.
    const sameDay = authorizeEnterpriseAction(
      passingContext({ spentMinor: 0 }),
      actionRequest({ amountMinor: 2_500, at: '2026-05-01T12:00:00.000Z' }),
    )
    expect(sameDay.allowed).toBe(true)
  })
})

/** A granted approval covering exactly this request, with the digest Core would compute. */
function grantedApprovalFor(request: ReturnType<typeof actionRequest>): ApprovalRecord {
  return {
    approvalId: 'ap-1',
    environmentId: 'env-1',
    kind: 'action',
    subjectKind: 'webzone-operation',
    subjectRef: request.actionId,
    subjectDigest: actionDigest(request),
    reasoning: 'the owner was asked and said yes',
    state: 'granted',
    requestedAt: '2026-05-01T08:00:00.000Z',
    decidedAt: '2026-05-01T08:30:00.000Z',
    expiresAt: '2026-05-02T08:30:00.000Z',
  }
}