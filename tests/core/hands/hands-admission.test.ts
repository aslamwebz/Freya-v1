import { describe, expect, it } from 'vitest'
import {
  admitHandsAction,
  refuseHandsAdmission,
  type HandsAdmissionInput,
} from '../../../core/hands/admission/controller'
import type {
  HandsAdmissionSeam,
  HandsGovernorClaim,
  HandsGuardClaim,
} from '../../../core/hands/admission/seam'
import {
  HANDS_ADMISSION_LIMITS,
  HANDS_ADMISSION_REFUSAL_CODES,
  HANDS_ADMISSION_REFUSAL_REASONS,
  type HandsAdmissionBudget,
  type HandsAdmissionCaller,
  type HandsAdmissionGrant,
} from '../../../core/hands/admission/types'
import { HANDS_LIMITS } from '../../../core/hands/types'

const NOW = '2026-01-01T00:00:00.000Z'

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
    maxAdmittedActions: HANDS_LIMITS.maxActions,
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

function refusalCodeOf(input: HandsAdmissionInput): string {
  const decision = admitHandsAction(input)
  return decision.decision === 'refused' ? decision.refusal.code : `admitted:${decision.admitted.status}`
}

function spySeam(): {
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
          return { allowed: true, reason: 'allowed by test seam' }
        },
      },
      governor: {
        evaluate(claim) {
          governorClaims.push(claim)
          return { outcome: 'allow', reason: 'allowed by test seam' }
        },
      },
    },
    guardClaims,
    governorClaims,
  }
}

function permissiveSeam(): HandsAdmissionSeam {
  return {
    guard: { evaluate: () => ({ allowed: true, reason: 'permissive' }) },
    governor: { evaluate: () => ({ outcome: 'allow', reason: 'permissive' }) },
  }
}

describe('admitHandsAction: admission', () => {
  it('admits a well-formed request to a pending decision', () => {
    const decision = admitHandsAction(makeInput())
    expect(decision.decision).toBe('admitted')
    if (decision.decision !== 'admitted') return
    const admitted = decision.admitted
    expect(admitted.status).toBe('pending')
    expect(admitted.actionId).toBe('action-1')
    expect(admitted.capabilityRef).toEqual({ capabilityId: 'cap-browser', scope: 'session-1' })
    expect(admitted.action).toBe('navigate')
    expect(admitted.admittedAt).toBe(NOW)
    expect(admitted.timeoutMs).toBe(5000)
    expect(admitted.deadlineAt).toBe('2026-01-01T00:00:05.000Z')
    expect(admitted.correlationId).toBe('corr-1')
    expect(admitted.grantId).toBe('grant-1')
    expect(admitted.caller).toEqual({ principalId: 'agent:worker-1', scope: 'session-1' })
    expect(admitted.budget).toEqual({
      maxConcurrentActions: 4,
      inFlightAfter: 1,
      maxAdmittedActions: HANDS_LIMITS.maxActions,
      admittedAfter: 1,
    })
  })

  it('an admitted decision stops at pending and carries no execution fields', () => {
    const decision = admitHandsAction(makeInput())
    expect(decision.decision).toBe('admitted')
    if (decision.decision !== 'admitted') return
    for (const field of [
      'startedAt',
      'settledAt',
      'durationMs',
      'observationIds',
      'result',
      'observations',
      'verdict',
    ]) {
      expect(decision.admitted).not.toHaveProperty(field)
    }
    expect(decision.admitted.status).not.toBe('running')
  })

  it('defaults a null timeout to the ceiling and derives the deadline from it', () => {
    const decision = admitHandsAction(makeInput({ envelope: makeEnvelope({ timeoutMs: null }) }))
    expect(decision.decision).toBe('admitted')
    if (decision.decision !== 'admitted') return
    expect(decision.admitted.timeoutMs).toBe(HANDS_LIMITS.maxActionTimeoutMs)
    expect(decision.admitted.deadlineAt).toBe('2026-01-01T00:05:00.000Z')
  })
})

describe('admitHandsAction: malformed', () => {
  it('refuses an envelope with an extra key', () => {
    expect(refusalCodeOf(makeInput({ envelope: makeEnvelope({ authority: 'owner' }) }))).toBe(
      'malformed',
    )
  })

  it('refuses an envelope with a missing key', () => {
    const envelope = makeEnvelope()
    delete envelope.correlationId
    expect(refusalCodeOf(makeInput({ envelope }))).toBe('malformed')
  })

  it('refuses nested input', () => {
    expect(
      refusalCodeOf(makeInput({ envelope: makeEnvelope({ input: { nested: { deep: true } } }) })),
    ).toBe('malformed')
  })

  it('refuses an admission context with an invalid instant', () => {
    expect(refusalCodeOf(makeInput({ now: 'not-a-date' }))).toBe('malformed')
  })

  it('refuses an admission context with a negative concurrency count', () => {
    expect(refusalCodeOf(makeInput({ budget: makeBudget({ inFlightActions: -1 }) }))).toBe(
      'malformed',
    )
  })

  it('refuses an admission context with a non-finite budget count', () => {
    expect(refusalCodeOf(makeInput({ budget: makeBudget({ admittedActions: Number.NaN }) }))).toBe(
      'malformed',
    )
  })

  it('refuses an admission context with a malformed caller', () => {
    const caller = { ...makeCaller(), heldCapabilities: 'cap-browser' } as unknown as
      HandsAdmissionCaller
    expect(refusalCodeOf(makeInput({ caller }))).toBe('malformed')
  })

  it('refuses an admission context with an unparseable grant instant', () => {
    expect(refusalCodeOf(makeInput({ grant: makeGrant({ expiresAt: 'whenever' }) }))).toBe(
      'malformed',
    )
  })
})

describe('admitHandsAction: unsupported', () => {
  it('refuses a capability this Core does not know', () => {
    expect(
      refusalCodeOf(
        makeInput({
          envelope: makeEnvelope({
            capabilityRef: { capabilityId: 'cap-unknown', scope: 'session-1' },
          }),
        }),
      ),
    ).toBe('unsupported')
  })

  it('refuses an action outside the capability vocabulary', () => {
    expect(refusalCodeOf(makeInput({ envelope: makeEnvelope({ action: 'exfiltrate' }) }))).toBe(
      'unsupported',
    )
  })

  it('refuses a capability whose kind is declared but not routable', () => {
    const catalog = new Map([
      [
        'cap-clipboard',
        { capabilityId: 'cap-clipboard', kind: 'clipboard', actions: ['read'] },
      ],
    ])
    const decision = admitHandsAction(
      makeInput({
        envelope: makeEnvelope({
          capabilityRef: { capabilityId: 'cap-clipboard', scope: 'session-1' },
          action: 'read',
        }),
        catalog: catalog as never,
        caller: makeCaller({ heldCapabilities: ['cap-clipboard'] }),
      }),
    )
    expect(decision.decision).toBe('refused')
    if (decision.decision !== 'refused') return
    expect(decision.refusal.code).toBe('unsupported')
  })
})

describe('admitHandsAction: unauthorized', () => {
  it('refuses a capability named in a scope the caller is not acting in', () => {
    expect(
      refusalCodeOf(
        makeInput({
          envelope: makeEnvelope({
            capabilityRef: { capabilityId: 'cap-browser', scope: 'session-admin' },
          }),
        }),
      ),
    ).toBe('unauthorized')
  })

  it('refuses a capability the caller does not hold', () => {
    expect(refusalCodeOf(makeInput({ caller: makeCaller({ heldCapabilities: [] }) }))).toBe(
      'unauthorized',
    )
  })

  it('refuses when Guard denies a capability the caller does hold', () => {
    const { seam, guardClaims } = spySeam()
    const decision = admitHandsAction(
      makeInput({
        seam: {
          guard: {
            evaluate(claim) {
              guardClaims.push(claim)
              return { allowed: false, reason: 'policy says no' }
            },
          },
          governor: seam.governor,
        },
      }),
    )
    expect(decision.decision).toBe('refused')
    if (decision.decision !== 'refused') return
    expect(decision.refusal.code).toBe('unauthorized')
    expect(decision.refusal.reason).toBe('policy says no')
  })
})

describe('admitHandsAction: stopped', () => {
  it('refuses every request while the STOP ALL latch is set', () => {
    const decision = admitHandsAction(makeInput({ stopAllActive: true }))
    expect(decision.decision).toBe('refused')
    if (decision.decision !== 'refused') return
    expect(decision.refusal.code).toBe('stopped')
    expect(decision.refusal.terminal).toBe(true)
    expect(decision.refusal.reason).toBe(HANDS_ADMISSION_REFUSAL_REASONS.stopped)
  })

  it('the stop latch outranks a malformed envelope', () => {
    expect(
      refusalCodeOf(
        makeInput({ stopAllActive: true, envelope: makeEnvelope({ extra: 'field' }) }),
      ),
    ).toBe('stopped')
  })

  it('the stop latch outranks an unauthorized caller', () => {
    expect(
      refusalCodeOf(makeInput({ stopAllActive: true, caller: makeCaller({ trusted: false }) })),
    ).toBe('stopped')
  })

  it('the stop latch outranks a permissive seam', () => {
    expect(refusalCodeOf(makeInput({ stopAllActive: true, seam: permissiveSeam() }))).toBe(
      'stopped',
    )
  })

  it('consults no seam while stopped', () => {
    const { seam, guardClaims, governorClaims } = spySeam()
    admitHandsAction(makeInput({ stopAllActive: true, seam }))
    expect(guardClaims).toHaveLength(0)
    expect(governorClaims).toHaveLength(0)
  })
})

describe('admitHandsAction: expired_grant', () => {
  it('refuses an expired grant', () => {
    expect(
      refusalCodeOf(makeInput({ grant: makeGrant({ expiresAt: '2025-12-31T23:59:59.000Z' }) })),
    ).toBe('expired_grant')
  })

  it('refuses a revoked grant', () => {
    expect(refusalCodeOf(makeInput({ grant: makeGrant({ revokedAt: NOW }) }))).toBe('expired_grant')
  })

  it('refuses when no grant covers the action', () => {
    expect(refusalCodeOf(makeInput({ grant: null }))).toBe('expired_grant')
  })

  it('refuses an expired grant even with a permissive seam', () => {
    expect(
      refusalCodeOf(
        makeInput({
          seam: permissiveSeam(),
          grant: makeGrant({ expiresAt: '2025-12-31T23:59:59.000Z' }),
        }),
      ),
    ).toBe('expired_grant')
  })

  it('maps a Governor denial of expired_grant onto the refusal', () => {
    const decision = admitHandsAction(
      makeInput({
        seam: {
          guard: permissiveSeam().guard,
          governor: { evaluate: () => ({ outcome: 'deny', code: 'expired_grant', reason: 'grant no longer covers this capability' }) },
        },
      }),
    )
    expect(decision.decision).toBe('refused')
    if (decision.decision !== 'refused') return
    expect(decision.refusal.code).toBe('expired_grant')
    expect(decision.refusal.reason).toBe('grant no longer covers this capability')
  })
})

describe('admitHandsAction: over_budget', () => {
  it('refuses when the concurrency bound is reached', () => {
    expect(refusalCodeOf(makeInput({ budget: makeBudget({ inFlightActions: 4 }) }))).toBe(
      'over_budget',
    )
  })

  it('admits one below the concurrency bound', () => {
    expect(refusalCodeOf(makeInput({ budget: makeBudget({ inFlightActions: 3 }) }))).toBe(
      'admitted:pending',
    )
  })

  it('refuses when the session admission cap is reached', () => {
    expect(
      refusalCodeOf(
        makeInput({
          budget: makeBudget({
            admittedActions: HANDS_LIMITS.maxActions,
            maxAdmittedActions: HANDS_LIMITS.maxActions,
          }),
        }),
      ),
    ).toBe('over_budget')
  })

  it('clamps a budget limit raised above the code-owned ceiling', () => {
    const decision = admitHandsAction(
      makeInput({ budget: makeBudget({ maxConcurrentActions: 999, inFlightActions: 4 }) }),
    )
    expect(decision.decision).toBe('refused')
    if (decision.decision !== 'refused') return
    expect(decision.refusal.code).toBe('over_budget')
  })

  it('enforces the concurrency bound even with a permissive seam', () => {
    expect(
      refusalCodeOf(
        makeInput({ seam: permissiveSeam(), budget: makeBudget({ inFlightActions: 4 }) }),
      ),
    ).toBe('over_budget')
  })

  it('maps a Governor denial of over_budget onto the refusal', () => {
    const decision = admitHandsAction(
      makeInput({
        seam: {
          guard: permissiveSeam().guard,
          governor: { evaluate: () => ({ outcome: 'deny', code: 'over_budget', reason: 'the grant has no allowance left' }) },
        },
      }),
    )
    expect(decision.decision).toBe('refused')
    if (decision.decision !== 'refused') return
    expect(decision.refusal.code).toBe('over_budget')
    expect(decision.refusal.reason).toBe('the grant has no allowance left')
  })
})

describe('admitHandsAction: precedence', () => {
  it('malformed outranks unsupported', () => {
    expect(
      refusalCodeOf(
        makeInput({
          envelope: makeEnvelope({
            extra: 'field',
            capabilityRef: { capabilityId: 'cap-unknown', scope: 'session-1' },
          }),
        }),
      ),
    ).toBe('malformed')
  })

  it('unsupported outranks unauthorized', () => {
    expect(
      refusalCodeOf(
        makeInput({
          envelope: makeEnvelope({
            capabilityRef: { capabilityId: 'cap-unknown', scope: 'session-1' },
          }),
          caller: makeCaller({ heldCapabilities: [] }),
        }),
      ),
    ).toBe('unsupported')
  })

  it('unauthorized outranks expired_grant', () => {
    expect(
      refusalCodeOf(makeInput({ caller: makeCaller({ heldCapabilities: [] }), grant: null })),
    ).toBe('unauthorized')
  })

  it('expired_grant outranks over_budget', () => {
    expect(
      refusalCodeOf(
        makeInput({ grant: null, budget: makeBudget({ inFlightActions: 4 }) }),
      ),
    ).toBe('expired_grant')
  })
})

describe('admitHandsAction: the seam is consulted', () => {
  it('hands Guard the caller, the capability reference and the scope', () => {
    const { seam, guardClaims } = spySeam()
    admitHandsAction(makeInput({ seam }))
    expect(guardClaims).toHaveLength(1)
    expect(guardClaims[0]).toEqual({
      principalId: 'agent:worker-1',
      trusted: true,
      heldCapabilities: ['cap-browser'],
      capabilityRef: { capabilityId: 'cap-browser', scope: 'session-1' },
      callerScope: 'session-1',
      action: 'navigate',
    })
  })

  it('hands the Governor the grant, the budget and the instant', () => {
    const { seam, governorClaims } = spySeam()
    admitHandsAction(makeInput({ seam }))
    expect(governorClaims).toHaveLength(1)
    expect(governorClaims[0]).toEqual({
      actionId: 'action-1',
      capabilityRef: { capabilityId: 'cap-browser', scope: 'session-1' },
      grant: makeGrant(),
      budget: makeBudget(),
      timeoutMs: 5000,
      now: NOW,
    })
  })

  it('consults no seam for a malformed envelope', () => {
    const { seam, guardClaims, governorClaims } = spySeam()
    admitHandsAction(makeInput({ envelope: makeEnvelope({ extra: 'field' }), seam }))
    expect(guardClaims).toHaveLength(0)
    expect(governorClaims).toHaveLength(0)
  })
})

describe('refuseHandsAdmission', () => {
  it('builds a terminal refusal carrying the code reason', () => {
    const refusal = refuseHandsAdmission('action-1', 'cap-browser', 'stopped', NOW)
    expect(refusal).toEqual({
      actionId: 'action-1',
      code: 'stopped',
      reason: HANDS_ADMISSION_REFUSAL_REASONS.stopped,
      capabilityId: 'cap-browser',
      refusedAt: NOW,
      terminal: true,
    })
  })

  it('accepts a detail that replaces the table reason', () => {
    const refusal = refuseHandsAdmission('action-1', null, 'malformed', NOW, 'already registered')
    expect(refusal.reason).toBe('already registered')
  })

  it('every code has a reason in the table', () => {
    for (const code of HANDS_ADMISSION_REFUSAL_CODES) {
      expect(HANDS_ADMISSION_REFUSAL_REASONS[code]).toBeTruthy()
    }
  })

  it('the limits table is frozen', () => {
    expect(Object.isFrozen(HANDS_ADMISSION_LIMITS)).toBe(true)
  })
})
