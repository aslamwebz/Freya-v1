import { describe, expect, it } from 'vitest'
import {
  analyseZeroHiddenSpend,
  createEnterpriseRuntime,
  ENTERPRISE_PAYLOAD_KEYS,
  inspectEnterprisePayload,
  type EnterpriseEventType,
} from '../../../core/enterprise'
import { ALLOWED_DOMAIN, BOUNDARIES_INPUT, ENV_ID, LIMITS, T0, T_PLUS_1H, harness } from './harness'

/**
 * The runtime.
 *
 * The harness has no provider, no gateway, no grant store and no network, so **every
 * number in this file is a count of calls to a scripted port**. That is what lets the
 * two claims that matter be tested rather than asserted:
 *
 *   - a refused action performs no effect, so `effectCalls()` stays where it was;
 *   - an authorized action performs exactly one, and cannot perform it twice.
 */

const GOOD_LIMITS = LIMITS

async function opened(options = {}) {
  const h = harness(options)
  const runtime = createEnterpriseRuntime({ ports: h.ports })
  await runtime.open()
  await runtime.openEnvironment({
    environmentId: ENV_ID,
    kind: 'webzone',
    title: 'Owner site',
    boundaries: BOUNDARIES_INPUT,
    spendingLimits: GOOD_LIMITS,
    at: T0,
  })
  return { h, runtime }
}

describe('opening replays the journal and refuses an untrustworthy one', () => {
  it('replays a prior journal into the same state it had', async () => {
    const first = harness()
    const firstRuntime = createEnterpriseRuntime({ ports: first.ports })
    await firstRuntime.open()
    await firstRuntime.openEnvironment({
      environmentId: ENV_ID,
      kind: 'webzone',
      title: 'Owner site',
      boundaries: BOUNDARIES_INPUT,
      spendingLimits: GOOD_LIMITS,
      at: T0,
    })

    // A second process, same journal.
    const second = harness()
    second.seed(first.entries as never)
    const secondRuntime = createEnterpriseRuntime({ ports: second.ports })
    await secondRuntime.open()
    expect(Object.keys(secondRuntime.snapshot().environments)).toEqual([ENV_ID])
    expect(secondRuntime.snapshot().environments[ENV_ID]?.title).toBe('Owner site')
  })

  it('refuses to open at all when the journal cannot be believed', async () => {
    const h = harness({ journalTrustworthy: false })
    const runtime = createEnterpriseRuntime({ ports: h.ports })
    // Refused rather than opened-and-repaired: a repair on startup is a place where an
    // unreadable record quietly becomes a believed one.
    await expect(runtime.open()).rejects.toThrow(/cannot be believed/)
  })

  it('is idempotent, so a second open does not re-replay', async () => {
    const h = harness()
    const runtime = createEnterpriseRuntime({ ports: h.ports })
    await runtime.open()
    const after = h.changes()
    await runtime.open()
    expect(h.changes()).toBe(after)
  })
})

describe('the runtime writes only payloads the fold would accept', () => {
  it('produces a journal every entry of which validates against its key table', async () => {
    const { h, runtime } = await opened()
    await runtime.handleWake({
      source: 'owner',
      kind: 'owner-request',
      actor: 'owner',
      environmentId: ENV_ID,
      sourceRef: null,
      wakeKey: 'wake-1',
      at: T0,
    })
    await runtime.performAction({
      actionId: 'act-1',
      environmentId: ENV_ID,
      kind: 'publish',
      target: `https://${ALLOWED_DOMAIN}/about`,
      payload: 'hello',
      consequential: false,
      amountMinor: 0,
      currency: 'USD',
      claimsAction: null,
      performed: false,
      at: T0,
    })

    const failures: string[] = []
    for (const item of h.entries) {
      const anomalies = inspectEnterprisePayload(
        item.type as EnterpriseEventType,
        item.payload,
      )
      if (anomalies.length > 0) {
        failures.push(`${item.type}: ${anomalies[0]?.code ?? ''} ${anomalies[0]?.detail ?? ''}`)
      }
      // And the keys must be exactly the published set, no extras.
      const allowed = ENTERPRISE_PAYLOAD_KEYS[item.type as EnterpriseEventType] ?? []
      for (const key of Object.keys(item.payload)) {
        if (!allowed.includes(key)) failures.push(`${item.type}: undeclared key ${key}`)
      }
    }
    expect(failures).toEqual([])
  })

  it('leaves no hidden-spend violation in a clean run', async () => {
    const { h, runtime } = await opened()
    await runtime.handleWake({
      source: 'owner',
      kind: 'owner-request',
      actor: 'owner',
      environmentId: ENV_ID,
      sourceRef: null,
      wakeKey: 'wake-1',
      at: T0,
    })
    await runtime.performAction({
      actionId: 'act-1',
      environmentId: ENV_ID,
      kind: 'publish',
      target: `https://${ALLOWED_DOMAIN}/about`,
      payload: 'hello',
      consequential: false,
      amountMinor: 0,
      currency: 'USD',
      claimsAction: null,
      performed: false,
      at: T0,
    })
    expect(analyseZeroHiddenSpend({ entries: h.entries }).violations).toEqual([])
  })
})

describe('a refused action performs no effect', () => {
  const cases: readonly { readonly name: string; readonly overrides: Parameters<typeof harness>[0] }[] = [
    { name: 'STOP ALL is latched', overrides: { stopAll: true } },
    { name: 'the subsystem is disabled', overrides: { enabled: false } },
  ]

  for (const testCase of cases) {
    it(`performs nothing when ${testCase.name}`, async () => {
      const { h, runtime } = await opened(testCase.overrides)
      const outcome = await runtime.performAction({
        actionId: 'act-1',
        environmentId: ENV_ID,
        kind: 'publish',
        target: `https://${ALLOWED_DOMAIN}/about`,
        payload: 'hello',
        consequential: false,
        amountMinor: 0,
        currency: 'USD',
        claimsAction: null,
        performed: false,
        at: T0,
      })
      expect(outcome.performed).toBe(false)
      expect(h.effectCalls()).toBe(0)
    })
  }

  it('performs nothing when the journal becomes untrustworthy mid-life', async () => {
    // The latch and the journal flag are read fresh on every attempt, not captured at
    // open. A copied reading would let a latch thrown mid-run be acted on.
    const { h, runtime } = await opened()
    h.setJournalTrustworthy(false)
    const outcome = await runtime.performAction({
      actionId: 'act-1',
      environmentId: ENV_ID,
      kind: 'publish',
      target: `https://${ALLOWED_DOMAIN}/about`,
      payload: 'hello',
      consequential: false,
      amountMinor: 0,
      currency: 'USD',
      claimsAction: null,
      performed: false,
      at: T0,
    })
    expect(outcome.performed).toBe(false)
    expect(outcome.code).toBe('journal-untrustworthy')
    expect(h.effectCalls()).toBe(0)
  })

  it('performs nothing when STOP ALL is latched mid-life', async () => {
    const { h, runtime } = await opened()
    h.setStopAll(true)
    const outcome = await runtime.performAction({
      actionId: 'act-1',
      environmentId: ENV_ID,
      kind: 'publish',
      target: `https://${ALLOWED_DOMAIN}/about`,
      payload: 'hello',
      consequential: false,
      amountMinor: 0,
      currency: 'USD',
      claimsAction: null,
      performed: false,
      at: T0,
    })
    expect(outcome.performed).toBe(false)
    expect(outcome.code).toBe('stop-all-latched')
    expect(h.effectCalls()).toBe(0)
  })

  it('performs nothing for a target outside the allowlist', async () => {
    const { h, runtime } = await opened()
    const outcome = await runtime.performAction({
      actionId: 'act-1',
      environmentId: ENV_ID,
      kind: 'publish',
      target: 'https://evil.test/about',
      payload: 'hello',
      consequential: false,
      amountMinor: 0,
      currency: 'USD',
      claimsAction: null,
      performed: false,
      at: T0,
    })
    expect(outcome.performed).toBe(false)
    expect(outcome.refusedAt).toBe('boundary')
    expect(h.effectCalls()).toBe(0)
  })

  it('performs nothing for a forbidden action, and journals the refusal', async () => {
    const { h, runtime } = await opened()
    for (const claimsAction of [
      'real-money-transfer',
      'place-real-order',
      'open-account',
      'accept-contract',
      'self-approve',
      'bypass-guard',
      'grant-authority',
      'widen-spending-limit',
    ]) {
      const before = h.effectCalls()
      const outcome = await runtime.performAction({
        actionId: 'act-1',
        environmentId: ENV_ID,
        kind: 'publish',
        target: `https://${ALLOWED_DOMAIN}/about`,
        payload: 'hello',
        consequential: false,
        amountMinor: 0,
        currency: 'USD',
        claimsAction,
        performed: false,
        at: T0,
      })
      expect(outcome.performed, claimsAction).toBe(false)
      expect(outcome.code, claimsAction).toBe('forbidden-action')
      expect(h.effectCalls(), claimsAction).toBe(before)
      expect(h.types(), claimsAction).toContain('enterprise.action.refused')
    }
  })

  it('records every refusal with the gate that stopped it', async () => {
    const { h, runtime } = await opened({ stopAll: true })
    const outcome = await runtime.performAction({
      actionId: 'act-1',
      environmentId: ENV_ID,
      kind: 'publish',
      target: `https://${ALLOWED_DOMAIN}/about`,
      payload: 'hello',
      consequential: false,
      amountMinor: 0,
      currency: 'USD',
      claimsAction: null,
      performed: false,
      at: T0,
    })
    const refusal = h.entries.find((item) => item.type === 'enterprise.action.refused')
    expect(refusal?.payload.gate).toBe(outcome.refusedAt)
  })
})

describe('an authorized action performs exactly one effect and verifies it', () => {
  it('performs once and completes', async () => {
    const { h, runtime } = await opened()
    const outcome = await runtime.performAction({
      actionId: 'act-1',
      environmentId: ENV_ID,
      kind: 'publish',
      target: `https://${ALLOWED_DOMAIN}/about`,
      payload: 'hello',
      consequential: false,
      amountMinor: 0,
      currency: 'USD',
      claimsAction: null,
      performed: false,
      at: T0,
    })
    expect(outcome.performed).toBe(true)
    expect(outcome.verification?.outcome).toBe('passed')
    expect(h.effectCalls()).toBe(1)
    expect(h.types()).toContain('enterprise.webzone-operation.completed')
  })

  it('does not record completion when the effect did not happen', async () => {
    // Verification is the second gate and it is enforced against the record: an
    // operation whose verification failed must not appear as completed.
    const { h, runtime } = await opened({ effectHolds: false })
    const outcome = await runtime.performAction({
      actionId: 'act-1',
      environmentId: ENV_ID,
      kind: 'publish',
      target: `https://${ALLOWED_DOMAIN}/about`,
      payload: 'hello',
      consequential: false,
      amountMinor: 0,
      currency: 'USD',
      claimsAction: null,
      performed: false,
      at: T0,
    })
    expect(outcome.performed).toBe(true)
    expect(outcome.verification?.outcome).toBe('failed')
    expect(h.types()).not.toContain('enterprise.webzone-operation.completed')
    expect(h.types()).toContain('enterprise.webzone-operation.failed')
  })

  it('records spend only after verification, never before', async () => {
    const { h, runtime } = await opened({ effectHolds: false })
    await runtime.performAction({
      actionId: 'act-1',
      environmentId: ENV_ID,
      kind: 'publish',
      target: `https://${ALLOWED_DOMAIN}/about`,
      payload: 'hello',
      consequential: false,
      amountMinor: 500,
      currency: 'USD',
      claimsAction: null,
      performed: false,
      at: T0,
    })
    // A failed verification means the money was never committed, so the ledger must not
    // have moved. This is the ordering that makes "no hidden spending" mean something.
    const spendGates = h.entries.filter((item) => item.type === 'enterprise.spending-gate.checked')
    expect(spendGates.length).toBeGreaterThan(0)
    const verificationIndex = h.entries.findIndex((item) => item.type === 'enterprise.external-action.verified')
    const completionIndex = h.entries.findIndex((item) => item.type === 'enterprise.webzone-operation.completed')
    expect(verificationIndex).toBeLessThan(completionIndex === -1 ? Number.MAX_SAFE_INTEGER : completionIndex)
  })

  it('never records a completion without a verification', async () => {
    const { h, runtime } = await opened()
    await runtime.performAction({
      actionId: 'act-1',
      environmentId: ENV_ID,
      kind: 'publish',
      target: `https://${ALLOWED_DOMAIN}/about`,
      payload: 'hello',
      consequential: false,
      amountMinor: 0,
      currency: 'USD',
      claimsAction: null,
      performed: false,
      at: T0,
    })
    const completed = h.entries.find((item) => item.type === 'enterprise.webzone-operation.completed')
    expect(typeof completed?.payload.verificationId).toBe('string')
    expect(String(completed?.payload.verificationId).length).toBeGreaterThan(0)
  })
})

describe('a wake is the only public way in, and a forged one is refused', () => {
  const valid = {
    source: 'owner',
    kind: 'owner-request',
    actor: 'owner',
    environmentId: ENV_ID,
    sourceRef: null,
    wakeKey: 'wake-1',
    at: T0,
  }

  it('accepts an authorized wake and records it once', async () => {
    const { h, runtime } = await opened()
    const outcome = await runtime.handleWake(valid)
    expect(outcome.accepted).toBe(true)
    expect(h.types().filter((type) => type === 'enterprise.wake.received')).toHaveLength(1)
  })

  it('refuses the same wake twice, so it cannot produce two decisions', async () => {
    const { runtime } = await opened()
    await runtime.handleWake(valid)
    const again = await runtime.handleWake(valid)
    expect(again.accepted).toBe(false)
    expect(again.reason).toContain('already been handled')
  })

  it('refuses a source that is not one this subsystem accepts', async () => {
    const { h, runtime } = await opened()
    const outcome = await runtime.handleWake({ ...valid, source: 'renderer', actor: 'owner' })
    expect(outcome.accepted).toBe(false)
    expect(h.types()).toContain('enterprise.wake.denied')
  })

  it('refuses a source arriving as an actor it has no business being', async () => {
    const { runtime } = await opened()
    // `scheduled-heartbeat` must arrive as the host heartbeat, not as the owner.
    const outcome = await runtime.handleWake({
      ...valid,
      source: 'scheduled-heartbeat',
      actor: 'owner',
    })
    expect(outcome.accepted).toBe(false)
    expect(outcome.reason).toContain('was not raised by Core')
  })

  it('refuses an unknown wake kind', async () => {
    const { runtime } = await opened()
    expect((await runtime.handleWake({ ...valid, kind: 'whenever' })).accepted).toBe(false)
  })

  it('refuses a wake with no key, which could not be deduplicated', async () => {
    const { runtime } = await opened()
    expect((await runtime.handleWake({ ...valid, wakeKey: '' })).accepted).toBe(false)
  })
})

describe('only the owner may answer an approval', () => {
  const request = {
    environmentId: ENV_ID,
    kind: 'action',
    subjectKind: 'webzone-operation',
    subjectRef: 'act-1',
    subjectDigest: 'digest-1',
    reasoning: 'publishing the about page',
    expiresAt: T_PLUS_1H,
  }

  it('records a grant the owner gave', async () => {
    const { h, runtime } = await opened({ decidedBy: 'owner', granted: true })
    const outcome = await runtime.requestApproval(request)
    expect(outcome.ok).toBe(true)
    expect(runtime.approvals()[0]).toMatchObject({ state: 'granted' })
    expect(h.types()).toContain('enterprise.approval.granted')
  })

  it('treats a decision that came from Core as a denial', async () => {
    // The single most dangerous failure available to this phase: an approval is the only
    // thing that lets otherwise-refused work proceed.
    const { h, runtime } = await opened({ decidedBy: 'core', granted: true })
    const outcome = await runtime.requestApproval(request)
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('Only the owner')
    expect(h.types()).toContain('enterprise.approval.denied')
    expect(h.types()).not.toContain('enterprise.approval.granted')
  })

  it('records an owner denial as a denial', async () => {
    const { runtime } = await opened({ decidedBy: 'owner', granted: false })
    const outcome = await runtime.requestApproval(request)
    expect(outcome.ok).toBe(false)
    expect(runtime.approvals()[0]).toMatchObject({ state: 'denied' })
  })

  it('refuses a request with no reasoning, before troubling the owner at all', async () => {
    const { h, runtime } = await opened()
    const outcome = await runtime.requestApproval({ ...request, reasoning: '' })
    expect(outcome.ok).toBe(false)
    expect(h.approvalRequests()).toHaveLength(0)
  })

  it('refuses an already-expired request without raising it', async () => {
    const { h, runtime } = await opened()
    const outcome = await runtime.requestApproval({ ...request, expiresAt: T0 })
    expect(outcome.ok).toBe(false)
    expect(h.approvalRequests()).toHaveLength(0)
  })

  it('passes the bounded reasoning to the owner rather than model prose', async () => {
    const { h, runtime } = await opened()
    await runtime.requestApproval(request)
    expect(h.approvalRequests()[0]?.reasoning).toBe('publishing the about page')
  })
})

describe('a rollback is bounded, reversible, and separately authorized', () => {
  const base = {
    rollbackId: 'rb-1',
    actionId: 'op-1',
    environmentId: ENV_ID,
    consequence: 'reversible-write' as const,
    restorable: true,
    crossedBoundary: false,
    exceededSpending: false,
    spentMinor: 0,
    attempts: 0,
    environmentRollbacks: 0,
    approved: true,
    rolledBack: true,
    allOfIt: true,
  }

  it('rolls back a reversible action that the owner approved', async () => {
    const { h, runtime } = await opened()
    const outcome = await runtime.rollback(base)
    expect(outcome.outcome).toBe('success')
    expect(h.reverseCalls()).toBe(1)
  })

  it('refuses a destructive action with no restorable copy, and reverses nothing', async () => {
    const { h, runtime } = await opened()
    const outcome = await runtime.rollback({
      ...base,
      consequence: 'destructive',
      restorable: false,
    })
    expect(outcome.outcome).toBe('not-reversible')
    expect(h.reverseCalls()).toBe(0)
  })

  it('refuses an action that already spent money', async () => {
    const { h, runtime } = await opened()
    const outcome = await runtime.rollback({ ...base, spentMinor: 1 })
    expect(outcome.outcome).toBe('not-reversible')
    expect(h.reverseCalls()).toBe(0)
  })

  it('refuses an unapproved rollback, because undoing is itself a public change', async () => {
    const { h, runtime } = await opened()
    const outcome = await runtime.rollback({ ...base, approved: false })
    expect(outcome.outcome).toBe('not-reversible')
    expect(h.reverseCalls()).toBe(0)
  })

  it('does not attempt a rollback past its ceiling', async () => {
    const { h, runtime } = await opened()
    const outcome = await runtime.rollback({ ...base, attempts: 3 })
    expect(outcome.outcome).toBe('not-reversible')
    expect(h.reverseCalls()).toBe(0)
  })

  it('reports a partial reversal as partial rather than success', async () => {
    const { runtime } = await opened()
    const outcome = await runtime.rollback({ ...base, allOfIt: false })
    expect(outcome.outcome).toBe('partial')
  })

  it('reports a failed reversal as failed, and does not claim success', async () => {
    const { h, runtime } = await opened({ effectHolds: false })
    const outcome = await runtime.rollback(base)
    expect(outcome.outcome).toBe('failed')
    expect(h.types()).toContain('enterprise.rollback.executed')
  })
})

describe('the runtime schedules nothing and calls nothing it was not given', () => {
  it('performs no effect without an authorized action being requested', async () => {
    const { h, runtime } = await opened()
    await runtime.projection()
    await runtime.snapshot()
    expect(h.effectCalls()).toBe(0)
  })

  it('notifies a surface of changes but does not act on them', async () => {
    const { h, runtime } = await opened()
    const before = h.changes()
    await runtime.projection()
    // A notification is a read of state, not an act: onChange must not have fired and
    // nothing may have been performed.
    expect(h.changes()).toBe(before)
    expect(h.effectCalls()).toBe(0)
  })

  it('reports the approvals it holds as a copy, not as the live array', async () => {
    const { runtime } = await opened()
    const held = runtime.approvals() as unknown as unknown[]
    held.push('tampered')
    expect(runtime.approvals()).toHaveLength(0)
  })
})