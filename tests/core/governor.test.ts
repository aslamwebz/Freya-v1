// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { evaluateCognition, type CognitionRequest } from '../../core/cognition/governor'
import { emptyGrantUsage, type CognitionGrant } from '../../core/cognition/grants'
import type { CognitionCause, CognitionOrigin, PrincipalId } from '../../core/protocol/core-protocol'

const NOW = new Date('2026-03-01T12:00:00.000Z')

function grant(overrides: Partial<CognitionGrant> = {}): CognitionGrant {
  return {
    id: 'grant-1',
    createdBy: 'owner',
    createdAt: '2026-03-01T11:00:00.000Z',
    expiresAt: '2026-03-01T13:00:00.000Z',
    allowedOrigins: ['user', 'system'],
    allowedCauses: ['user_message', 'user_requested_test', 'explicit_review'],
    goalId: null,
    runId: null,
    actor: null,
    backgroundAllowed: false,
    maxCalls: 2,
    maxOutputTokens: 500,
    usage: emptyGrantUsage(),
    revokedAt: null,
    revokedBy: null,
    parentGrantId: null,
    ...overrides,
  }
}

function request(overrides: Partial<CognitionRequest> = {}): CognitionRequest {
  return {
    cognitionRequestId: 'req-1',
    origin: 'user',
    cause: 'user_message',
    actor: 'owner',
    correlationId: 'corr-1',
    parentRunId: null,
    goalId: null,
    requestedModel: null,
    maxOutputTokens: 100,
    authorization: { grantId: null, userInitiated: true },
    background: false,
    ...overrides,
  }
}

/**
 * The journal defaults to trustworthy here so the existing cases stay about what
 * they are about. The untrustworthy case has its own tests below, because it
 * changes the answer for every request rather than any particular one.
 */
const allow = (grants: CognitionGrant[] = [], stopAllActive = false) =>
  evaluateCognition(request(), { grants, stopAllActive, now: NOW, journalTrustworthy: true })

describe('Cognition Governor — explicit user cognition', () => {
  it('allows an explicit user-initiated turn with no grant', () => {
    expect(allow().outcome).toBe('allow')
  })

  it('does not treat a non-user origin as user-initiated', () => {
    const decision = evaluateCognition(
      request({ origin: 'system', cause: 'world_changed' }),
      { grants: [], stopAllActive: false, now: NOW, journalTrustworthy: true },
    )
    expect(decision.outcome).toBe('deny')
    expect(decision.reason).toBe('not-user-initiated-and-no-grant')
  })

  it('does not treat a background request as user-initiated', () => {
    const decision = evaluateCognition(
      request({ background: true }),
      { grants: [], stopAllActive: false, now: NOW, journalTrustworthy: true },
    )
    expect(decision.outcome).toBe('deny')
  })

  it('refuses a zero or negative token request rather than assuming a default', () => {
    expect(allow().outcome).toBe('allow')
    expect(evaluateCognition(request({ maxOutputTokens: 0 }), { grants: [], stopAllActive: false, now: NOW, journalTrustworthy: true })).toMatchObject({
      outcome: 'deny',
      reason: 'zero-token-request',
    })
    expect(
      evaluateCognition(request({ maxOutputTokens: -5 }), { grants: [], stopAllActive: false, now: NOW, journalTrustworthy: true }),
    ).toMatchObject({ outcome: 'deny', reason: 'zero-token-request' })
  })

  it('refuses an absurd token request instead of quietly truncating it', () => {
    expect(
      evaluateCognition(request({ maxOutputTokens: 1_000_000 }), { grants: [], stopAllActive: false, now: NOW, journalTrustworthy: true }),
    ).toMatchObject({ outcome: 'deny', reason: 'excessive-token-request' })
  })
})

describe('Cognition Governor — unattended cognition', () => {
  it('denies background cognition with no grant', () => {
    const decision = evaluateCognition(
      request({ origin: 'system', cause: 'world_changed', authorization: { grantId: null, userInitiated: false }, background: true }),
      { grants: [], stopAllActive: false, now: NOW, journalTrustworthy: true },
    )
    expect(decision.outcome).toBe('deny')
    expect(decision.reason).toBe('not-user-initiated-and-no-grant')
  })

  it('denies background cognition even when a foreground grant exists', () => {
    const g = grant()
    const decision = evaluateCognition(
      request({ origin: 'system', background: true, authorization: { grantId: g.id, userInitiated: false } }),
      { grants: [g], stopAllActive: false, now: NOW, journalTrustworthy: true },
    )
    expect(decision).toMatchObject({ outcome: 'deny', reason: 'grant-rejected', grantId: 'grant-1' })
  })

  it('allows background cognition when a grant explicitly permits it', () => {
    const g = grant({ backgroundAllowed: true, allowedOrigins: ['system'], allowedCauses: ['world_changed'] })
    const decision = evaluateCognition(
      request({ origin: 'system', cause: 'world_changed', background: true, authorization: { grantId: g.id, userInitiated: false } }),
      { grants: [g], stopAllActive: false, now: NOW, journalTrustworthy: true },
    )
    expect(decision.outcome).toBe('allow')
  })
})

describe('Cognition Governor — STOP ALL', () => {
  it('denies even a fully valid user request while STOP ALL is active', () => {
    const decision = evaluateCognition(request(), { grants: [], stopAllActive: true, now: NOW, journalTrustworthy: true })
    expect(decision).toMatchObject({ outcome: 'deny', reason: 'stop-all-active' })
  })

  it('denies a valid grant while STOP ALL is active', () => {
    const g = grant({ backgroundAllowed: true, allowedOrigins: ['user'], allowedCauses: ['user_message'] })
    const decision = evaluateCognition(
      request({ background: true, authorization: { grantId: g.id, userInitiated: false } }),
      { grants: [g], stopAllActive: true, now: NOW, journalTrustworthy: true },
    )
    expect(decision.outcome).toBe('deny')
  })
})

describe('Cognition Governor — grants', () => {
  const withGrant = (g: CognitionGrant, overrides: Partial<CognitionRequest> = {}) =>
    evaluateCognition(
      request({ authorization: { grantId: g.id, userInitiated: false }, ...overrides }),
      { grants: [g], stopAllActive: false, now: NOW, journalTrustworthy: true },
    )

  it('allows a request inside a valid grant', () => {
    expect(withGrant(grant())).toMatchObject({ outcome: 'allow', grantId: 'grant-1' })
  })

  it('denies an expired grant', () => {
    const g = grant({ expiresAt: '2026-03-01T11:59:59.000Z' })
    expect(withGrant(g)).toMatchObject({ outcome: 'deny', reason: 'no-active-grant' })
  })

  it('denies a revoked grant', () => {
    const g = grant({ revokedAt: '2026-03-01T11:30:00.000Z', revokedBy: 'owner' })
    expect(withGrant(g)).toMatchObject({ outcome: 'deny', reason: 'no-active-grant' })
  })

  it('denies a grant used outside its origin scope', () => {
    const g = grant({ allowedOrigins: ['system'] })
    const decision = withGrant(g, { origin: 'user' })
    expect(decision.outcome).toBe('deny')
  })

  it('denies a grant used outside its cause scope', () => {
    const g = grant({ allowedCauses: ['explicit_review'] })
    expect(withGrant(g, { cause: 'world_changed' as CognitionCause })).toMatchObject({ outcome: 'deny' })
  })

  it('denies a grant scoped to a different goal', () => {
    const g = grant({ goalId: 'goal-a' })
    expect(withGrant(g, { goalId: 'goal-b' })).toMatchObject({ outcome: 'deny' })
  })

  it('allows a grant scoped to the matching goal', () => {
    const g = grant({ goalId: 'goal-a' })
    expect(withGrant(g, { goalId: 'goal-a' })).toMatchObject({ outcome: 'allow' })
  })

  it('denies a grant scoped to a different run', () => {
    const g = grant({ runId: 'run-a' })
    expect(withGrant(g, { parentRunId: 'run-b' })).toMatchObject({ outcome: 'deny' })
  })

  it('denies a grant scoped to a different actor', () => {
    const g = grant({ actor: 'agent:smith' })
    expect(withGrant(g, { actor: 'system' as PrincipalId })).toMatchObject({ outcome: 'deny' })
  })

  it('denies when the call budget is exhausted', () => {
    const g = grant({ usage: { ...emptyGrantUsage(), calls: 2 } })
    expect(withGrant(g)).toMatchObject({ outcome: 'deny' })
  })

  it('denies when the remaining call budget is exactly zero', () => {
    const g = grant({ maxCalls: 1, usage: { ...emptyGrantUsage(), calls: 1 } })
    expect(withGrant(g).outcome).toBe('deny')
  })

  it('denies when the reserved budget cannot cover the request', () => {
    // Reported usage does not move the budget; the reservation does. So a grant
    // with 450 of 500 reserved cannot serve another 100-token request.
    const g = grant({
      usage: { calls: 1, outputTokenBudgetReserved: 450, inputTokens: 900, outputTokens: 450, unknownUsageCalls: 0 },
    })
    expect(withGrant(g, { maxOutputTokens: 100 })).toMatchObject({ outcome: 'deny' })
  })

  it('allows a request that exactly consumes the remaining token budget', () => {
    const g = grant({ maxOutputTokens: 500, usage: { ...emptyGrantUsage(), calls: 1, inputTokens: 900, outputTokens: 400 } })
    expect(withGrant(g, { maxOutputTokens: 100 })).toMatchObject({ outcome: 'allow' })
  })

  it('measures the token budget against what was reserved, not what was reported', () => {
    // A provider that reported nothing has reserved nothing extra, but the
    // allowance it was granted is already spent. Unknown usage must not read as
    // zero *and* must not be able to claw budget back.
    const g = grant({
      maxOutputTokens: 1000,
      usage: { calls: 1, outputTokenBudgetReserved: 300, inputTokens: null, outputTokens: null, unknownUsageCalls: 0 },
    })
    expect(withGrant(g, { maxOutputTokens: 700 })).toMatchObject({ outcome: 'allow' })
    expect(withGrant(g, { maxOutputTokens: 701 })).toMatchObject({ outcome: 'deny' })
  })

  it('does not refund reserved budget when a provider reports less than reserved', () => {
    // The provider said it used 10 of the 300 it was allowed. The budget still
    // shows 300 reserved: actual usage is a report, not a correction.
    const g = grant({
      maxOutputTokens: 1000,
      usage: { calls: 1, outputTokenBudgetReserved: 300, inputTokens: 5, outputTokens: 10, unknownUsageCalls: 0 },
    })
    expect(withGrant(g, { maxOutputTokens: 701 })).toMatchObject({ outcome: 'deny' })
  })

  it('exhausts a grant whose reserved budget is already at the ceiling', () => {
    const tight = grant({
      maxOutputTokens: 0,
      usage: { calls: 1, outputTokenBudgetReserved: 0, inputTokens: null, outputTokens: null, unknownUsageCalls: 0 },
    })
    expect(withGrant(tight, { maxOutputTokens: 100 })).toMatchObject({ outcome: 'deny' })
  })

  it('denies a grant id that does not exist', () => {
    const decision = evaluateCognition(
      request({ authorization: { grantId: 'no-such-grant', userInitiated: false } }),
      { grants: [grant()], stopAllActive: false, now: NOW, journalTrustworthy: true },
    )
    expect(decision).toMatchObject({ outcome: 'deny', reason: 'grant-missing' })
  })

  it('never allows a request for an origin outside every grant', () => {
    for (const origin of ['goal', 'workflow', 'agent', 'learning', 'system'] as const) {
      const g = grant({ allowedOrigins: ['user'] })
      const decision = evaluateCognition(
        request({ origin: origin as CognitionOrigin, authorization: { grantId: g.id, userInitiated: false } }),
        { grants: [g], stopAllActive: false, now: NOW, journalTrustworthy: true },
      )
      expect(decision.outcome).toBe('deny')
    }
  })
})
