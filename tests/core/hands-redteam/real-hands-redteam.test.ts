import { describe, expect, it } from 'vitest'
import {
  HANDS_ADMISSION_LIMITS,
  admitHandsAction,
  initialHandsState,
  isActionVerified,
  recordActionResult,
  recordObservation,
  recordVerificationResult,
  validateActionEnvelope,
} from '../../../core/hands'

const NOW = '2026-10-02T00:00:00.000Z'
const EXPIRES = '2026-10-03T00:00:00.000Z'

const envelope = {
  actionId: 'hands-action-1',
  capabilityRef: { capabilityId: 'cap-browser', scope: 'session-1' },
  action: 'navigate',
  input: { url: 'https://example.com' },
  timeoutMs: 5_000,
  correlationId: 'corr-1',
}

const caller = {
  principalId: 'owner',
  trusted: true,
  scope: 'session-1',
  heldCapabilities: ['cap-browser'],
}

const grant = {
  grantId: 'grant-1',
  expiresAt: EXPIRES,
  revokedAt: null,
}

const budget = {
  maxConcurrentActions: HANDS_ADMISSION_LIMITS.maxConcurrentActions,
  inFlightActions: 0,
  maxAdmittedActions: HANDS_ADMISSION_LIMITS.maxAdmittedActions,
  admittedActions: 0,
}

const permissiveSeam = {
  guard: {
    evaluate: () => ({ allowed: true as const, reason: 'test-only permissive guard' }),
  },
  governor: {
    evaluate: () => ({ outcome: 'allow' as const, reason: 'test-only permissive governor' }),
  },
}

describe('production Hands red-team invariants', () => {
  it('rejects authority-shaped smuggling at the exact action-envelope boundary', () => {
    expect(validateActionEnvelope(envelope).ok).toBe(true)

    expect(
      validateActionEnvelope({
        ...envelope,
        authority: 'owner',
      }).ok,
    ).toBe(false)

    expect(
      validateActionEnvelope({
        ...envelope,
        capabilityRef: {
          ...envelope.capabilityRef,
          grant: 'forged-grant',
        },
      }).ok,
    ).toBe(false)
  })

  it('keeps an action id single-use: a later result cannot re-settle it', () => {
    const first = {
      actionId: envelope.actionId,
      status: 'completed' as const,
      startedAt: NOW,
      settledAt: NOW,
      durationMs: 10,
      reason: null,
      observationIds: [],
    }
    const forgedLater = {
      ...first,
      status: 'cancelled' as const,
      reason: 'late overwrite attempt',
    }

    const once = recordActionResult(initialHandsState(), first)
    const twice = recordActionResult(once, forgedLater)

    expect(twice.actions.get(envelope.actionId)).toEqual(first)
  })

  it('never treats action completion as verification success', () => {
    const completed = recordActionResult(initialHandsState(), {
      actionId: envelope.actionId,
      status: 'completed',
      startedAt: NOW,
      settledAt: NOW,
      durationMs: 10,
      reason: null,
      observationIds: [],
    })

    expect(isActionVerified(completed, envelope.actionId)).toBe(false)

    const failedVerification = recordVerificationResult(completed, {
      verificationId: 'verification-failed',
      actionId: envelope.actionId,
      status: 'failed',
      reason: 'intent not established',
      verdictAt: NOW,
    })
    expect(isActionVerified(failedVerification, envelope.actionId)).toBe(false)

    const passedVerification = recordVerificationResult(failedVerification, {
      verificationId: 'verification-passed',
      actionId: envelope.actionId,
      status: 'passed',
      reason: 'independent verifier established the intent',
      verdictAt: NOW,
    })
    expect(isActionVerified(passedVerification, envelope.actionId)).toBe(true)
  })

  it('refuses observations that arrive after an action is terminal', () => {
    const settled = recordActionResult(initialHandsState(), {
      actionId: envelope.actionId,
      status: 'completed',
      startedAt: NOW,
      settledAt: NOW,
      durationMs: 10,
      reason: null,
      observationIds: [],
    })

    const afterLateObservation = recordObservation(settled, {
      observationId: 'late-observation',
      actionId: envelope.actionId,
      kind: 'result',
      summary: 'late evidence',
      data: { hostile: true },
      recordedAt: NOW,
    })

    expect(afterLateObservation.observations.size).toBe(0)
  })

  it('proves possession is not authority: Guard denial still wins', () => {
    const decision = admitHandsAction({
      envelope,
      caller,
      stopAllActive: false,
      now: NOW,
      budget,
      grant,
      seam: {
        guard: {
          evaluate: () => ({ allowed: false as const, reason: 'explicit red-team denial' }),
        },
        governor: permissiveSeam.governor,
      },
    })

    expect(decision.decision).toBe('refused')
    if (decision.decision === 'refused') {
      expect(decision.refusal.code).toBe('unauthorized')
      expect(decision.refusal.terminal).toBe(true)
    }
  })

  it('STOP ALL outranks malformed input and any permissive decision seam', () => {
    const decision = admitHandsAction({
      envelope: { authority: 'forged' },
      caller,
      stopAllActive: true,
      now: NOW,
      budget,
      grant,
      seam: permissiveSeam,
    })

    expect(decision.decision).toBe('refused')
    if (decision.decision === 'refused') {
      expect(decision.refusal.code).toBe('stopped')
      expect(decision.refusal.terminal).toBe(true)
    }
  })

  it('refuses forged scope even when both injected decision seams allow', () => {
    const decision = admitHandsAction({
      envelope: {
        ...envelope,
        capabilityRef: { ...envelope.capabilityRef, scope: 'session-2' },
      },
      caller,
      stopAllActive: false,
      now: NOW,
      budget,
      grant,
      seam: permissiveSeam,
    })

    expect(decision.decision).toBe('refused')
    if (decision.decision === 'refused') {
      expect(decision.refusal.code).toBe('unauthorized')
    }
  })

  it('enforces the hard concurrency bound even when the injected Governor allows', () => {
    const decision = admitHandsAction({
      envelope,
      caller,
      stopAllActive: false,
      now: NOW,
      budget: {
        ...budget,
        inFlightActions: budget.maxConcurrentActions,
      },
      grant,
      seam: permissiveSeam,
    })

    expect(decision.decision).toBe('refused')
    if (decision.decision === 'refused') {
      expect(decision.refusal.code).toBe('over_budget')
      expect(decision.refusal.terminal).toBe(true)
    }
  })
})
