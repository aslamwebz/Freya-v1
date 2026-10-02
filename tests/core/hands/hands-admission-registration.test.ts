import { describe, expect, it } from 'vitest'
import {
  admitHandsAction,
  type HandsAdmissionInput,
} from '../../../core/hands/admission/controller'
import {
  cancelRegistration,
  expireRegistrations,
  handsAdmissionBudgetFrom,
  inFlightCount,
  initialHandsAdmissionLedger,
  registerAdmission,
  stopAllRegistrations,
  submitHandsAdmission,
  type HandsAdmissionSubmitInput,
} from '../../../core/hands/admission/registration'
import { HANDS_ADMISSION_LIMITS } from '../../../core/hands/admission/types'
import type {
  HandsAdmissionCaller,
  HandsAdmissionGrant,
} from '../../../core/hands/admission/types'

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

function makeSubmitInput(overrides: Partial<HandsAdmissionSubmitInput> = {}): HandsAdmissionSubmitInput {
  const caller: HandsAdmissionCaller = {
    principalId: 'agent:worker-1',
    trusted: true,
    scope: 'session-1',
    heldCapabilities: ['cap-browser'],
  }
  const grant: HandsAdmissionGrant = {
    grantId: 'grant-1',
    expiresAt: '2026-01-01T01:00:00.000Z',
    revokedAt: null,
  }
  return {
    envelope: makeEnvelope(),
    caller,
    stopAllActive: false,
    now: NOW,
    grant,
    ...overrides,
  }
}

/**
 * A complete admission input standing on its own: budget metadata derived
 * from an empty ledger, exactly as a submission would supply it.
 */
function standaloneAdmission(
  overrides: Partial<HandsAdmissionSubmitInput> = {},
): HandsAdmissionInput {
  return {
    ...makeSubmitInput(overrides),
    budget: handsAdmissionBudgetFrom(initialHandsAdmissionLedger()),
  }
}

describe('the admission ledger: registration', () => {
  it('starts empty and in flight of nothing', () => {
    const ledger = initialHandsAdmissionLedger()
    expect(ledger.registrations.size).toBe(0)
    expect(inFlightCount(ledger)).toBe(0)
  })

  it('registers an admitted action with its cancellation path and deadline', () => {
    const decision = admitHandsAction(standaloneAdmission())
    expect(decision.decision).toBe('admitted')
    if (decision.decision !== 'admitted') return

    const ledger = registerAdmission(initialHandsAdmissionLedger(), decision.admitted)
    expect(ledger.registrations.size).toBe(1)
    const registration = ledger.registrations.get('action-1')
    expect(registration).toEqual({
      actionId: 'action-1',
      status: 'registered',
      registeredAt: NOW,
      deadlineAt: '2026-01-01T00:00:05.000Z',
      settledAt: null,
      settleReason: null,
    })
    expect(inFlightCount(ledger)).toBe(1)
  })

  it('registration is idempotent for an action id already registered', () => {
    const decision = admitHandsAction(standaloneAdmission())
    if (decision.decision !== 'admitted') throw new Error('expected admission')
    const once = registerAdmission(initialHandsAdmissionLedger(), decision.admitted)
    const twice = registerAdmission(once, decision.admitted)
    expect(twice.registrations.size).toBe(1)
    expect(twice.registrations.get('action-1')?.status).toBe('registered')
  })
})

describe('the admission ledger: cancellation registration', () => {
  function admitAction1() {
    const decision = admitHandsAction(standaloneAdmission())
    if (decision.decision !== 'admitted') throw new Error('expected admission')
    return decision.admitted
  }

  it('cancels a registered action exactly once', () => {
    const ledger = registerAdmission(initialHandsAdmissionLedger(), admitAction1())
    const cancelled = cancelRegistration(ledger, 'action-1', NOW, 'the owner pressed stop')
    const registration = cancelled.registrations.get('action-1')
    expect(registration?.status).toBe('cancelled')
    expect(registration?.settledAt).toBe(NOW)
    expect(registration?.settleReason).toBe('the owner pressed stop')
    expect(inFlightCount(cancelled)).toBe(0)
  })

  it('a cancelled registration is terminal: it is never rewritten', () => {
    const ledger = registerAdmission(initialHandsAdmissionLedger(), admitAction1())
    const cancelled = cancelRegistration(ledger, 'action-1', NOW, 'stop')
    const again = cancelRegistration(cancelled, 'action-1', '2026-01-01T00:00:09.000Z', 'different reason')
    expect(again.registrations.get('action-1')).toEqual(cancelled.registrations.get('action-1'))
    expect(again.registrations.get('action-1')?.settleReason).toBe('stop')
  })

  it('cancelling an unknown action id changes nothing', () => {
    const ledger = registerAdmission(initialHandsAdmissionLedger(), admitAction1())
    const unchanged = cancelRegistration(ledger, 'no-such-action', NOW, 'stop')
    expect(unchanged).toBe(ledger)
  })
})

describe('the admission ledger: timeout registration', () => {
  function admitAction1(at: string = NOW) {
    const decision = admitHandsAction(standaloneAdmission({ now: at }))
    if (decision.decision !== 'admitted') throw new Error('expected admission')
    return decision.admitted
  }

  it('settles an action whose deadline has passed as timed out', () => {
    const ledger = registerAdmission(initialHandsAdmissionLedger(), admitAction1())
    const swept = expireRegistrations(ledger, '2026-01-01T00:00:05.000Z')
    const registration = swept.registrations.get('action-1')
    expect(registration?.status).toBe('timed_out')
    expect(registration?.settledAt).toBe('2026-01-01T00:00:05.000Z')
    expect(registration?.settleReason).toBe('the action deadline passed')
    expect(inFlightCount(swept)).toBe(0)
  })

  it('leaves an action before its deadline untouched', () => {
    const ledger = registerAdmission(initialHandsAdmissionLedger(), admitAction1())
    const swept = expireRegistrations(ledger, '2026-01-01T00:00:04.999Z')
    expect(swept.registrations.get('action-1')?.status).toBe('registered')
    expect(inFlightCount(swept)).toBe(1)
  })

  it('never rewrites an already settled registration', () => {
    const ledger = registerAdmission(initialHandsAdmissionLedger(), admitAction1())
    const cancelled = cancelRegistration(ledger, 'action-1', NOW, 'stop')
    const swept = expireRegistrations(cancelled, '2026-01-01T00:00:09.000Z')
    expect(swept.registrations.get('action-1')?.status).toBe('cancelled')
    expect(swept.registrations.get('action-1')?.settleReason).toBe('stop')
  })
})

describe('the admission ledger: STOP ALL', () => {
  it('cancels every pending registration and leaves settled ones alone', () => {
    const first = admitHandsAction(standaloneAdmission())
    const second = admitHandsAction(
      standaloneAdmission({ envelope: makeEnvelope({ actionId: 'action-2' }) }),
    )
    if (first.decision !== 'admitted' || second.decision !== 'admitted') {
      throw new Error('expected admission')
    }
    let ledger = registerAdmission(initialHandsAdmissionLedger(), first.admitted)
    ledger = registerAdmission(ledger, second.admitted)
    ledger = cancelRegistration(ledger, 'action-2', NOW, 'already stopped')

    const stopped = stopAllRegistrations(ledger, '2026-01-01T00:00:09.000Z')
    expect(stopped.registrations.get('action-1')?.status).toBe('cancelled')
    expect(stopped.registrations.get('action-1')?.settleReason).toBe('stop-all')
    expect(stopped.registrations.get('action-1')?.settledAt).toBe('2026-01-01T00:00:09.000Z')
    expect(stopped.registrations.get('action-2')?.settleReason).toBe('already stopped')
    expect(inFlightCount(stopped)).toBe(0)
  })
})

describe('the admission ledger: bounded concurrency', () => {
  it('derives budget metadata from the ledger', () => {
    const decision = admitHandsAction(standaloneAdmission())
    if (decision.decision !== 'admitted') throw new Error('expected admission')
    const ledger = registerAdmission(initialHandsAdmissionLedger(), decision.admitted)
    expect(handsAdmissionBudgetFrom(ledger)).toEqual({
      maxConcurrentActions: HANDS_ADMISSION_LIMITS.maxConcurrentActions,
      inFlightActions: 1,
      maxAdmittedActions: HANDS_ADMISSION_LIMITS.maxAdmittedActions,
      admittedActions: 1,
    })
  })

  it('clamps a requested concurrency limit raised above the ceiling', () => {
    expect(
      handsAdmissionBudgetFrom(initialHandsAdmissionLedger(), { maxConcurrentActions: 999 })
        .maxConcurrentActions,
    ).toBe(HANDS_ADMISSION_LIMITS.maxConcurrentActions)
  })

  it('refuses a submission once the concurrency bound is reached', () => {
    const limits = { maxConcurrentActions: 1 }
    const first = submitHandsAdmission(initialHandsAdmissionLedger(), makeSubmitInput(), limits)
    expect(first.decision.decision).toBe('admitted')
    expect(inFlightCount(first.ledger)).toBe(1)

    const second = submitHandsAdmission(
      first.ledger,
      makeSubmitInput({ envelope: makeEnvelope({ actionId: 'action-2' }) }),
      limits,
    )
    expect(second.decision.decision).toBe('refused')
    if (second.decision.decision !== 'refused') return
    expect(second.decision.refusal.code).toBe('over_budget')
    expect(inFlightCount(second.ledger)).toBe(1)
  })

  it('frees the bound when a pending action is cancelled or times out', () => {
    const limits = { maxConcurrentActions: 1 }
    const first = submitHandsAdmission(initialHandsAdmissionLedger(), makeSubmitInput(), limits)
    expect(first.decision.decision).toBe('admitted')

    const cancelled = cancelRegistration(first.ledger, 'action-1', NOW, 'stop')
    const retry = submitHandsAdmission(
      cancelled,
      makeSubmitInput({ envelope: makeEnvelope({ actionId: 'action-2' }) }),
      limits,
    )
    expect(retry.decision.decision).toBe('admitted')
    expect(inFlightCount(retry.ledger)).toBe(1)
  })

  it('refuses a duplicate action id instead of double-registering it', () => {
    const first = submitHandsAdmission(initialHandsAdmissionLedger(), makeSubmitInput())
    expect(first.decision.decision).toBe('admitted')

    const replay = submitHandsAdmission(first.ledger, makeSubmitInput())
    expect(replay.decision.decision).toBe('refused')
    if (replay.decision.decision !== 'refused') return
    expect(replay.decision.refusal.code).toBe('malformed')
    expect(replay.decision.refusal.terminal).toBe(true)
    expect(replay.ledger.registrations.size).toBe(1)
  })

  it('refuses everything under STOP ALL without registering anything', () => {
    const stopped = submitHandsAdmission(
      initialHandsAdmissionLedger(),
      makeSubmitInput({ stopAllActive: true }),
    )
    expect(stopped.decision.decision).toBe('refused')
    if (stopped.decision.decision !== 'refused') return
    expect(stopped.decision.refusal.code).toBe('stopped')
    expect(stopped.ledger.registrations.size).toBe(0)
  })

  it('a refused submission leaves the ledger exactly as it was', () => {
    const ledger = initialHandsAdmissionLedger()
    const decision = submitHandsAdmission(
      ledger,
      makeSubmitInput({ envelope: makeEnvelope({ extra: 'field' }) }),
    )
    expect(decision.ledger).toBe(ledger)
    expect(decision.decision.decision).toBe('refused')
    if (decision.decision.decision !== 'refused') return
    expect(decision.decision.refusal.code).toBe('malformed')
  })
})
