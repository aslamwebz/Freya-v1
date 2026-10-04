import { describe, expect, it } from 'vitest'
import {
  claimIsUnreliable,
  evidenceIsAdmissible,
  evidenceSupportsPass,
  mayBeConsideredComplete,
  verifyExternalAction,
  type EvidenceInput,
  type VerificationInput,
} from '../../../core/enterprise'
import { T0 } from './harness'

/**
 * Verification, tested as the place where a *success* has to be earned.
 *
 * Every other outcome is easy to reach honestly. The dangerous case is the one where
 * something reports success and the subsystem believes it, so the file is weighted
 * towards `passed`: for each way a pass can be faked, there is a test that it is not.
 */

const GOOD_EVIDENCE: EvidenceInput = Object.freeze({
  claimed: true,
  claimedBy: 'external-observation',
  observed: true,
  matched: true,
})

function input(overrides: Partial<VerificationInput> = {}): VerificationInput {
  return {
    actionId: 'act-1',
    environmentId: 'env-1',
    outcome: 'passed',
    evidence: GOOD_EVIDENCE,
    deadlineAt: null,
    stopped: false,
    at: T0,
    ...overrides,
  }
}

describe('a pass requires independent evidence', () => {
  it('passes when something outside the operation actually observed it happen', () => {
    const decision = verifyExternalAction(input())
    expect(decision.outcome).toBe('passed')
    expect(decision.completes).toBe(true)
    expect(decision.certain).toBe(true)
  })

  it('fails when nothing observed it, because unobserved is not successful', () => {
    const decision = verifyExternalAction(
      input({ evidence: { ...GOOD_EVIDENCE, observed: false } }),
    )
    expect(decision.outcome).toBe('failed')
    expect(decision.completes).toBe(false)
    expect(decision.reason).toContain('Nothing observed')
  })

  it('fails when the observation did not match the intent', () => {
    const decision = verifyExternalAction(
      input({ evidence: { ...GOOD_EVIDENCE, matched: false } }),
    )
    expect(decision.outcome).toBe('failed')
    expect(decision.reason).toContain('did not match')
  })

  it('names which source produced the claim, so the refusal is legible', () => {
    const decision = verifyExternalAction(
      input({ evidence: { claimed: true, claimedBy: 'model', observed: false, matched: false } }),
    )
    expect(decision.code).toBe('claim-not-evidence')
    expect(decision.reason).toContain('model')
  })
})

describe('the thing being verified cannot verify itself', () => {
  it('refuses a pass claimed by the operation itself', () => {
    const decision = verifyExternalAction(
      input({ evidence: { claimed: true, claimedBy: 'environment', observed: true, matched: true } }),
    )
    expect(decision.outcome).toBe('failed')
    expect(decision.code).toBe('claim-not-evidence')
  })

  it('refuses a pass claimed by a model, however confident the claim', () => {
    const decision = verifyExternalAction(
      input({ evidence: { claimed: true, claimedBy: 'model', observed: true, matched: true } }),
    )
    expect(decision.outcome).toBe('failed')
    expect(decision.code).toBe('claim-not-evidence')
  })

  it('refuses a pass claimed by an agent, and says so with the fabrication code', () => {
    // A subordinate agent is not an independent observer: it is another thing inside
    // the system that wants the work to look done.
    const decision = verifyExternalAction(
      input({ evidence: { claimed: true, claimedBy: 'agent', observed: true, matched: true } }),
    )
    expect(decision.code).toBe('claim-not-evidence')
    expect(decision.reason).toContain('agent')
  })

  it('names the three sources that cannot testify', () => {
    for (const claimedBy of ['model', 'environment', 'agent'] as const) {
      expect(claimIsUnreliable({ ...GOOD_EVIDENCE, claimedBy }), claimedBy).toBe(true)
      const decision = verifyExternalAction(
        input({ evidence: { claimed: true, claimedBy, observed: true, matched: true } }),
      )
      expect(decision.outcome, claimedBy).toBe('failed')
      expect(decision.code, claimedBy).toBe('claim-not-evidence')
    }
  })

  it('accepts a pass from the three sources that can actually testify', () => {
    for (const claimedBy of ['owner', 'core', 'external-observation'] as const) {
      const decision = verifyExternalAction(
        input({ evidence: { claimed: true, claimedBy, observed: true, matched: true } }),
      )
      expect(decision.outcome, claimedBy).toBe('passed')
    }
  })

  it('reports admissibility directly, without building a whole input to ask', () => {
    expect(evidenceIsAdmissible(GOOD_EVIDENCE)).toBe(true)
    expect(evidenceIsAdmissible({ ...GOOD_EVIDENCE, claimedBy: 'model' })).toBe(false)
    expect(evidenceIsAdmissible({ ...GOOD_EVIDENCE, observed: false })).toBe(false)
  })

  it('treats a mismatch as admissible, because it is what evidences a failure', () => {
    // Admissibility is about *who spoke*, not about what they said. Folding the match
    // in here made a well-evidenced failure indistinguishable from no evidence at all.
    expect(evidenceIsAdmissible({ ...GOOD_EVIDENCE, matched: false })).toBe(true)
    expect(evidenceSupportsPass({ ...GOOD_EVIDENCE, matched: false })).toBe(false)
    expect(evidenceSupportsPass(GOOD_EVIDENCE)).toBe(true)
  })
})

describe('STOP ALL outranks every observation', () => {
  it('concludes nothing at all, even with perfect evidence', () => {
    const decision = verifyExternalAction(input({ stopped: true }))
    expect(decision.outcome).toBe('interrupted')
    expect(decision.completes).toBe(false)
    expect(decision.certain).toBe(false)
  })

  it('refuses to read a deadline it cannot parse rather than assuming one', () => {
    const decision = verifyExternalAction(input({ deadlineAt: 'soon' }))
    expect(decision.outcome).toBe('failed')
    expect(decision.completes).toBe(false)
  })
})

describe('a late success is a failure with extra steps', () => {
  it('is deadline-expired rather than passed when the deadline has passed', () => {
    const decision = verifyExternalAction(
      input({ deadlineAt: '2026-04-30T09:00:00.000Z', at: T0 }),
    )
    expect(decision.outcome).toBe('deadline-expired')
    expect(decision.completes).toBe(false)
    expect(decision.reason).toContain('late success')
  })

  it('passes while the deadline is still in the future', () => {
    const decision = verifyExternalAction(
      input({ deadlineAt: '2026-05-02T09:00:00.000Z', at: T0 }),
    )
    expect(decision.outcome).toBe('passed')
  })

  it('checks the deadline before the evidence, so a slow success cannot be laundered', () => {
    // Perfect evidence *and* an expired deadline. The deadline must win, because
    // checking evidence first would let a slow result present as a clean pass.
    const decision = verifyExternalAction(
      input({ deadlineAt: '2026-04-30T09:00:00.000Z', at: T0 }),
    )
    expect(decision.outcome).toBe('deadline-expired')
  })
})

describe('a reported failure with good evidence is still a failure', () => {
  it('trusts the evidence and reports the outcome the evidence supports', () => {
    const decision = verifyExternalAction(
      input({ outcome: 'failed', evidence: { ...GOOD_EVIDENCE, matched: false } }),
    )
    expect(decision.outcome).toBe('failed')
    expect(decision.certain).toBe(true)
    expect(decision.completes).toBe(false)
  })

  it('does not upgrade a failure to a pass on the strength of the claim', () => {
    const decision = verifyExternalAction(
      input({ outcome: 'failed', evidence: GOOD_EVIDENCE }),
    )
    expect(decision.outcome).toBe('failed')
    expect(decision.completes).toBe(false)
  })
})

describe('an outcome outside the closed set is refused', () => {
  it('fails closed on a made-up outcome', () => {
    for (const outcome of ['probably', 'ok', 'success', 'done', ''] as unknown as VerificationInput['outcome'][]) {
      const decision = verifyExternalAction(input({ outcome }))
      expect(decision.outcome, String(outcome)).toBe('failed')
      expect(decision.completes, String(outcome)).toBe(false)
    }
  })
})

describe('completion is derivable from the record alone', () => {
  it('refuses to call an action complete with no verification at all', () => {
    const verdict = mayBeConsideredComplete(null)
    expect(verdict.complete).toBe(false)
    expect(verdict.code).toBe('verification-missing')
  })

  it('refuses to call an action complete when verification did not pass', () => {
    for (const outcome of ['failed', 'interrupted', 'deadline-expired'] as const) {
      const verdict = mayBeConsideredComplete({
        verificationId: 'v-1',
        actionId: 'act-1',
        environmentId: 'env-1',
        outcome,
        reason: 'x',
        verifiedAt: T0,
      })
      expect(verdict.complete, outcome).toBe(false)
      expect(verdict.code, outcome).toBe('verification-failed')
    }
  })

  it('accepts completion only on a passed verification', () => {
    const verdict = mayBeConsideredComplete({
      verificationId: 'v-1',
      actionId: 'act-1',
      environmentId: 'env-1',
      outcome: 'passed',
      reason: 'observed',
      verifiedAt: T0,
    })
    expect(verdict.complete).toBe(true)
    expect(verdict.code).toBeNull()
  })
})