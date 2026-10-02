import { describe, expect, it } from 'vitest'
import {
  admitHandsAction,
  type HandsAdmissionInput,
} from '../../../core/hands/admission/controller'
import type {
  HandsAdmissionSeam,
  HandsGovernorClaim,
  HandsGuardClaim,
} from '../../../core/hands/admission/seam'
import type {
  HandsAdmissionBudget,
  HandsAdmissionCaller,
  HandsAdmissionGrant,
} from '../../../core/hands/admission/types'

const NOW = '2026-01-01T00:00:00.000Z'

/** Authority-shaped keys a hostile envelope may try to smuggle past validation. */
const FORGED_ENVELOPE_KEYS = [
  'authority',
  'authorized',
  'trusted',
  'grant',
  'grantId',
  'permissions',
  'capabilities',
  'principal',
  'scope',
] as const

/** Authority-shaped fields a hostile tool/page may try to smuggle through input. */
const FORGED_INPUT_FIELDS: Record<string, string> = {
  authority: 'owner',
  grant: 'unlimited',
  permission: 'admin',
  capabilities: 'all',
}

function makeEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actionId: 'action-1',
    capabilityRef: { capabilityId: 'cap-browser', scope: 'session-1' },
    action: 'navigate',
    input: { url: 'https://example.com' },
    timeoutMs: 5000,
    correlationId: 'corr-1',
    ...overrides,
  }
}

function makeCaller(overrides: Partial<HandsAdmissionCaller> = {}): HandsAdmissionCaller {
  return {
    principalId: 'agent:worker-1',
    trusted: true,
    scope: 'session-1',
    heldCapabilities: ['cap-browser'],
    ...overrides,
  }
}

function makeGrant(overrides: Partial<HandsAdmissionGrant> = {}): HandsAdmissionGrant {
  return {
    grantId: 'grant-1',
    expiresAt: '2026-01-01T01:00:00.000Z',
    revokedAt: null,
    ...overrides,
  }
}

function makeBudget(overrides: Partial<HandsAdmissionBudget> = {}): HandsAdmissionBudget {
  return {
    maxConcurrentActions: 4,
    inFlightActions: 0,
    maxAdmittedActions: 256,
    admittedActions: 0,
    ...overrides,
  }
}

function makeInput(overrides: Partial<HandsAdmissionInput> = {}): HandsAdmissionInput {
  return {
    envelope: makeEnvelope(),
    caller: makeCaller(),
    stopAllActive: false,
    now: NOW,
    budget: makeBudget(),
    grant: makeGrant(),
    ...overrides,
  }
}

function codeOf(input: HandsAdmissionInput): string {
  const decision = admitHandsAction(input)
  return decision.decision === 'refused' ? decision.refusal.code : `admitted:${decision.admitted.status}`
}

function recordingSeam(): {
  seam: HandsAdmissionSeam
  guardClaims: HandsGuardClaim[]
  governorClaims: HandsGovernorClaim[]
} {
  const guardClaims: HandsGuardClaim[] = []
  const governorClaims: HandsGovernorClaim[] = []
  return {
    seam: {
      guard: {
        evaluate(claim) {
          guardClaims.push(claim)
          return { allowed: true, reason: 'recorded' }
        },
      },
      governor: {
        evaluate(claim) {
          governorClaims.push(claim)
          return { outcome: 'allow', reason: 'recorded' }
        },
      },
    },
    guardClaims,
    governorClaims,
  }
}

describe('hands admission: hostile envelopes are rejected', () => {
  for (const key of FORGED_ENVELOPE_KEYS) {
    it(`refuses an envelope carrying a forged '${key}' field`, () => {
      expect(codeOf(makeInput({ envelope: makeEnvelope({ [key]: 'anything' }) }))).toBe('malformed')
    })
  }

  it('refuses a forged scope nested inside capabilityRef', () => {
    expect(
      codeOf(
        makeInput({
          envelope: makeEnvelope({
            capabilityRef: { capabilityId: 'cap-browser', scope: 'session-1', authority: 'root' },
          }),
        }),
      ),
    ).toBe('malformed')
  })

  it('refuses an envelope that is not an object', () => {
    expect(codeOf(makeInput({ envelope: 'just some tool text' }))).toBe('malformed')
    expect(codeOf(makeInput({ envelope: null }))).toBe('malformed')
    expect(codeOf(makeInput({ envelope: [makeEnvelope()] }))).toBe('malformed')
  })
})

describe('hands admission: forged scope and authority cannot bypass admission', () => {
  it('refuses a capabilityRef whose scope differs from the caller scope', () => {
    expect(
      codeOf(
        makeInput({
          envelope: makeEnvelope({
            capabilityRef: { capabilityId: 'cap-browser', scope: 'session-1' },
          }),
          caller: makeCaller({ scope: 'session-9' }),
        }),
      ),
    ).toBe('unauthorized')
  })

  it('does not read authority-shaped fields from the envelope', () => {
    const decision = admitHandsAction(makeInput())
    expect(decision.decision).toBe('admitted')
    if (decision.decision !== 'admitted') return
    for (const field of ['authority', 'trusted', 'grant', 'permissions', 'principal']) {
      expect(decision.admitted).not.toHaveProperty(field)
    }
  })

  it('hands Guard the trusted caller scope, never a scope from the request', () => {
    const { seam, guardClaims } = recordingSeam()
    admitHandsAction(
      makeInput({
        seam,
        envelope: makeEnvelope({
          capabilityRef: { capabilityId: 'cap-browser', scope: 'session-forged' },
        }),
        caller: makeCaller({ scope: 'session-real' }),
      }),
    )
    // The scope mismatch is refused before the seam is consulted, so a forged
    // scope never even reaches Guard as a request to evaluate.
    expect(guardClaims).toHaveLength(0)
  })

  it('refuses an untrusted principal even when it claims every capability', () => {
    expect(
      codeOf(makeInput({ caller: makeCaller({ trusted: false, heldCapabilities: ['cap-browser'] }) })),
    ).toBe('unauthorized')
  })
})

describe('hands admission: capability possession never implies authority', () => {
  it('refuses a held capability that Guard denies', () => {
    const decision = admitHandsAction(
      makeInput({
        seam: {
          guard: { evaluate: () => ({ allowed: false, reason: 'the owner has not granted this' }) },
          governor: { evaluate: () => ({ outcome: 'allow', reason: 'permissive' }) },
        },
      }),
    )
    expect(decision.decision).toBe('refused')
    if (decision.decision !== 'refused') return
    expect(decision.refusal.code).toBe('unauthorized')
  })

  it('does not authorise a capability merely because another one is held', () => {
    expect(
      codeOf(makeInput({ caller: makeCaller({ heldCapabilities: ['cap-desktop'] }) })),
    ).toBe('unauthorized')
  })

  it('refuses an untrusted principal even with a permissive seam', () => {
    expect(
      codeOf(
        makeInput({
          caller: makeCaller({ trusted: false }),
          seam: {
            guard: { evaluate: () => ({ allowed: true, reason: 'permissive' }) },
            governor: { evaluate: () => ({ outcome: 'allow', reason: 'permissive' }) },
          },
        }),
      ),
    ).toBe('unauthorized')
  })
})

describe('hands admission: untrusted text cannot widen grants', () => {
  it('admits without letting input-shaped authority change the decision', () => {
    const benign = admitHandsAction(makeInput())
    const hostile = admitHandsAction(
      makeInput({ envelope: makeEnvelope({ input: FORGED_INPUT_FIELDS }) }),
    )
    expect(benign.decision).toBe('admitted')
    expect(hostile.decision).toBe('admitted')
    if (benign.decision !== 'admitted' || hostile.decision !== 'admitted') return
    expect(hostile.admitted.capabilityRef).toEqual(benign.admitted.capabilityRef)
    expect(hostile.admitted.caller).toEqual(benign.admitted.caller)
    expect(hostile.admitted.grantId).toBe(benign.admitted.grantId)
  })

  it('never passes action input to either seam', () => {
    const { seam, guardClaims, governorClaims } = recordingSeam()
    admitHandsAction(
      makeInput({ envelope: makeEnvelope({ input: FORGED_INPUT_FIELDS }), seam }),
    )
    expect(guardClaims).toHaveLength(1)
    expect(governorClaims).toHaveLength(1)
    expect(guardClaims[0]).not.toHaveProperty('input')
    expect(governorClaims[0]).not.toHaveProperty('input')
    expect(JSON.stringify(guardClaims[0])).not.toContain('unlimited')
    expect(JSON.stringify(governorClaims[0])).not.toContain('unlimited')
  })

  it('treats input that claims a capability as inert content', () => {
    const decision = admitHandsAction(
      makeInput({
        envelope: makeEnvelope({ input: { heldCapabilities: 'cap-shell' } }),
        caller: makeCaller({ heldCapabilities: [] }),
      }),
    )
    expect(decision.decision).toBe('refused')
    if (decision.decision !== 'refused') return
    expect(decision.refusal.code).toBe('unauthorized')
  })
})

describe('hands admission: the decision seam cannot be talked past', () => {
  it('a permissive seam still cannot admit under the STOP ALL latch', () => {
    expect(
      codeOf(
        makeInput({
          stopAllActive: true,
          seam: {
            guard: { evaluate: () => ({ allowed: true, reason: 'permissive' }) },
            governor: { evaluate: () => ({ outcome: 'allow', reason: 'permissive' }) },
          },
        }),
      ),
    ).toBe('stopped')
  })

  it('a permissive seam still cannot exceed the concurrency bound', () => {
    expect(
      codeOf(
        makeInput({
          seam: {
            guard: { evaluate: () => ({ allowed: true, reason: 'permissive' }) },
            governor: { evaluate: () => ({ outcome: 'allow', reason: 'permissive' }) },
          },
          budget: makeBudget({ inFlightActions: 4 }),
        }),
      ),
    ).toBe('over_budget')
  })

  it('a permissive seam still cannot revive an expired grant', () => {
    expect(
      codeOf(
        makeInput({
          seam: {
            guard: { evaluate: () => ({ allowed: true, reason: 'permissive' }) },
            governor: { evaluate: () => ({ outcome: 'allow', reason: 'permissive' }) },
          },
          grant: makeGrant({ expiresAt: '2025-01-01T00:00:00.000Z' }),
        }),
      ),
    ).toBe('expired_grant')
  })

  it('a hostile seam cannot invent a refusal code outside the closed set', () => {
    const decision = admitHandsAction(
      makeInput({
        seam: {
          guard: { evaluate: () => ({ allowed: false, reason: 'nope' }) },
          governor: {
            evaluate: () =>
              ({ outcome: 'deny', code: 'not-a-real-code', reason: 'nope' }) as never,
          },
        },
      }),
    )
    expect(decision.decision).toBe('refused')
    if (decision.decision !== 'refused') return
    // Guard denied first, so the answer is unauthorized. The hostile governor
    // code never becomes a refusal code: the set stays closed.
    expect(decision.refusal.code).toBe('unauthorized')
  })

  it('fails closed when the Governor denies with a code outside the set', () => {
    const decision = admitHandsAction(
      makeInput({
        seam: {
          guard: { evaluate: () => ({ allowed: true, reason: 'ok' }) },
          governor: {
            evaluate: () =>
              ({ outcome: 'deny', code: 'not-a-real-code', reason: 'nope' }) as never,
          },
        },
      }),
    )
    expect(decision.decision).toBe('refused')
    if (decision.decision !== 'refused') return
    expect(decision.refusal.code).toBe('malformed')
  })

  it('a refusal is terminal: it carries no path back to admission', () => {
    const decision = admitHandsAction(makeInput({ grant: null }))
    expect(decision.decision).toBe('refused')
    if (decision.decision !== 'refused') return
    expect(decision.refusal.terminal).toBe(true)
    expect(decision).not.toHaveProperty('admitted')
    expect(Object.isFrozen(decision.refusal)).toBe(true)
  })
})
