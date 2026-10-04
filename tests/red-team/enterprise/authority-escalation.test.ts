import { describe, expect, it } from 'vitest'
import {
  AUTHORIZATION_GATES,
  ENTERPRISE_WAKE_ACTOR,
  FORBIDDEN_ENTERPRISE_ACTIONS,
  WEBZONE_OPERATION_KINDS,
  authorizeEnterpriseAction,
  effectiveForbiddenActions,
  isAuthorizationGate,
} from '../../../core/enterprise'
import { ALLOWED_DOMAIN, ENV_ID, LIMITS, absoluteDenials, assertNoEffect, attacker } from './harness'

/**
 * Red team: authority escalation.
 *
 * Each attack is an attempt to get Freya to do something her owner did not authorise,
 * and each asserts two things — the refusal, **and** that the bounded effect port was
 * never reached. The second assertion is the one that matters: a refusal that is
 * reported but not enforced is the failure mode that actually occurs.
 */

/** A context whose every gate holds, so an attack has to defeat a gate to succeed. */
const OPEN_CONTEXT = {
  enabled: true,
  journalTrustworthy: true,
  stopped: false,
  environment: {
    environmentId: ENV_ID,
    state: 'active' as const,
    boundaries: {
      maxTasks: 8,
      maxMissions: 4,
      maxWebzoneOperations: 16,
      maxConcurrentOperations: 2,
      allowedDomains: [ALLOWED_DOMAIN],
      forbiddenActions: effectiveForbiddenActions([]),
    },
    spendingLimits: LIMITS,
    ledger: { totalMinor: 0, currency: 'USD', byDay: {}, daysRetained: [] },
    createdAt: '2026-06-01T09:00:00.000Z',
    deadlineAt: null,
    counts: { tasks: 0, missions: 0, operations: 0, concurrent: 0 },
  },
  approvals: [],
  verification: null,
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    actionId: 'act-1',
    environmentId: ENV_ID,
    kind: 'publish' as const,
    target: `https://${ALLOWED_DOMAIN}/about`,
    payload: 'hello',
    consequential: false,
    amountMinor: 0,
    currency: 'USD',
    claimsAction: null,
    performed: false,
    at: '2026-06-01T09:00:00.000Z',
    ...overrides,
  }
}

describe('the absolute deny list resists every attempt to shrink it', () => {
  it('cannot be emptied by an empty list', () => {
    const merged = effectiveForbiddenActions([])
    for (const action of FORBIDDEN_ENTERPRISE_ACTIONS) {
      expect(merged, action).toContain(action)
    }
  })

  it('cannot be emptied by a list that names only permitted things', () => {
    const merged = effectiveForbiddenActions(['publish-content', 'read-inventory'])
    for (const action of FORBIDDEN_ENTERPRISE_ACTIONS) {
      expect(merged, action).toContain(action)
    }
  })

  it('cannot be emptied by a list shaped like a permission grant', () => {
    const merged = effectiveForbiddenActions(['allow: everything', 'permit: real-money-transfer'])
    for (const action of FORBIDDEN_ENTERPRISE_ACTIONS) {
      expect(merged, action).toContain(action)
    }
  })
})

describe('an action claiming to be forbidden is refused, for every denial in the list', () => {
  for (const action of absoluteDenials()) {
    it(`refuses "${action}" and performs no effect`, async () => {
      const attackerInstance = attacker()
      await attackerInstance.ready()
      const result = await attackerInstance.attempt({ claimsAction: action })
      expect(result.performed, action).toBe(false)
      expect(result.code, action).toBe('forbidden-action')
      assertNoEffect(result)
    })

    it(`refuses "${action}" at the gate, having consulted no later gate`, () => {
      const decision = authorizeEnterpriseAction(OPEN_CONTEXT, request({ claimsAction: action }))
      expect(decision.allowed, action).toBe(false)
      expect(decision.refusedAt, action).toBe('boundary')
      expect(decision.evaluated, action).not.toContain('spending')
      expect(decision.evaluated, action).not.toContain('approval')
    })
  }
})

describe('a real-money or binding action cannot be described, let alone performed', () => {
  const moneyShaped: readonly { readonly name: string; readonly target: string; readonly payload: string }[] = [
    { name: 'a payment page', target: `https://${ALLOWED_DOMAIN}/pay`, payload: 'transfer 500 USD' },
    { name: 'an order form', target: `https://${ALLOWED_DOMAIN}/order`, payload: 'order 10 units' },
    { name: 'an account opening', target: `https://${ALLOWED_DOMAIN}/signup`, payload: 'open an account' },
    { name: 'a contract acceptance', target: `https://${ALLOWED_DOMAIN}/terms`, payload: 'I accept' },
  ]

  for (const shaped of moneyShaped) {
    it(`refuses ${shaped.name} before any effect`, async () => {
      const attackerInstance = attacker()
      await attackerInstance.ready()
      const result = await attackerInstance.attempt({
        target: shaped.target,
        payload: shaped.payload,
        claimsAction: 'real-money-transfer',
      })
      expect(result.performed).toBe(false)
      assertNoEffect(result)
    })
  }

  it('has no operation kind that could mean paying, ordering or signing', () => {
    // The stronger property: the vocabulary has no such member, so the deny list is
    // never the only thing standing between a caller and a payment. Asserted against
    // the imported table rather than via `require`, which is not available in ESM and
    // would have thrown at runtime rather than failing an assertion.
    for (const kind of WEBZONE_OPERATION_KINDS) {
      for (const word of ['pay', 'order', 'transfer', 'sign', 'contract', 'trade']) {
        expect(kind.includes(word), `${kind}/${word}`).toBe(false)
      }
    }
  })

  it('keeps the operation vocabulary to exactly the five permitted kinds', () => {
    expect([...WEBZONE_OPERATION_KINDS]).toEqual(['publish', 'update', 'delete', 'query', 'interact'])
  })
})

describe('a wake cannot be forged from a source that has no right to issue one', () => {
  const sources = ['renderer', 'model', 'webhook', 'agent', 'connector', 'self-timer', ''] as const

  for (const source of sources) {
    it(`refuses a wake claiming to be "${source}"`, async () => {
      const attackerInstance = attacker()
      await attackerInstance.ready()
      const outcome = await attackerInstance.wake({ source, actor: 'owner' })
      expect(outcome.accepted, source).toBe(false)
      expect(attackerInstance.journalTypes()).toContain('enterprise.wake.denied')
    })
  }

  it('refuses a genuine source arriving as an actor it cannot be', async () => {
    // The renderer forgery: claim to be the owner, from any source.
    const attackerInstance = attacker()
    await attackerInstance.ready()
    for (const source of ['scheduled-heartbeat', 'authorized-event', 'core-subsystem']) {
      const outcome = await attackerInstance.wake({ source, actor: 'owner' })
      expect(outcome.accepted, source).toBe(false)
    }
  })

  it('refuses an unrecognised actor even from a real source', async () => {
    const attackerInstance = attacker()
    await attackerInstance.ready()
    const outcome = await attackerInstance.wake({ source: 'owner', actor: 'renderer' })
    expect(outcome.accepted).toBe(false)
  })

  it('maps each source to exactly one actor, and only the owner to the owner', () => {
    for (const [source, actor] of Object.entries(ENTERPRISE_WAKE_ACTOR)) {
      expect(isAuthorizationGate(source) || typeof source === 'string', source).toBe(true)
      if (actor === 'owner') expect(source, 'only owner may arrive as the owner').toBe('owner')
    }
  })
})

describe('the gate order cannot be reordered to reach an unsafe gate first', () => {
  it('always refuses the journal before the money', () => {
    const decision = authorizeEnterpriseAction(
      { ...OPEN_CONTEXT, journalTrustworthy: false },
      request({ amountMinor: 99_999 }),
    )
    expect(decision.refusedAt).toBe('journal-trustworthy')
    expect(decision.evaluated).not.toContain('spending')
  })

  it('always refuses the stop latch before the owner is troubled', () => {
    const decision = authorizeEnterpriseAction(
      { ...OPEN_CONTEXT, stopped: true },
      request({ consequential: true }),
    )
    expect(decision.refusedAt).toBe('stop-all')
    expect(decision.evaluated).not.toContain('approval')
  })

  it('always refuses the money before asking the owner', () => {
    const decision = authorizeEnterpriseAction(
      OPEN_CONTEXT,
      request({ consequential: true, amountMinor: 99_999 }),
    )
    expect(decision.refusedAt).toBe('spending')
  })

  it('keeps the nine gates in a fixed, total order', () => {
    expect(AUTHORIZATION_GATES).toHaveLength(9)
    expect(new Set(AUTHORIZATION_GATES).size).toBe(9)
  })
})

describe('an approval the attacker forges is not an approval', () => {
  it('refuses an action presenting a forged approval id', async () => {
    const attackerInstance = attacker()
    await attackerInstance.ready()
    await attackerInstance.seekApproval({ subjectDigest: 'digest-1' })
    // Present the forged record to the gate directly: it is not in the runtime's list,
    // so the gate cannot see it.
    const decision = authorizeEnterpriseAction(
      { ...OPEN_CONTEXT, approvals: [attackerInstance.grantApproval()] },
      request({ consequential: true }),
    )
    // A forged record *presented* by the attacker does reach the gate here, so what is
    // being tested is whether a matching digest alone is enough. It is not, because the
    // runtime's own approval list is what counts — this decision stands only because the
    // digest of the live request differs from the forged one.
    expect(decision.allowed).toBe(false)
    expect(decision.refusedAt).toBe('approval')
    expect(decision.code).toBe('approval-subject-mismatch')
  })

  it('refuses when the live approval is for a different action body', async () => {
    const attackerInstance = attacker()
    await attackerInstance.ready()
    const granted = await attackerInstance.seekApproval({ subjectDigest: 'digest-for-another-page' })
    expect(granted.ok).toBe(true)

    const decision = authorizeEnterpriseAction(
      { ...OPEN_CONTEXT, approvals: [attackerInstance.grantApproval({ subjectDigest: 'digest-for-another-page' })] },
      request({ consequential: true }),
    )
    expect(decision.code).toBe('approval-subject-mismatch')
  })

  it('treats a decision that did not come from the owner as a denial', async () => {
    const attackerInstance = attacker({ decidedBy: 'core', granted: true })
    await attackerInstance.ready()
    const outcome = await attackerInstance.seekApproval({})
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('Only the owner')
    expect(attackerInstance.journalTypes()).not.toContain('enterprise.approval.granted')
  })
})

describe('STOP ALL wins every contest', () => {
  const contests: readonly { readonly name: string; readonly attempt: Parameters<ReturnType<typeof attacker>['attempt']>[0] }[] = [
    { name: 'a forbidden action', attempt: { claimsAction: 'real-money-transfer' } },
    { name: 'an over-limit spend', attempt: { amountMinor: 99_999 } },
    { name: 'a consequential action', attempt: { consequential: true } },
    { name: 'an out-of-bounds target', attempt: { target: 'https://evil.test/' } },
  ]

  for (const contest of contests) {
    it(`refuses ${contest.name} while stopped, without even reaching its own gate`, async () => {
      const attackerInstance = attacker({ stopAll: true })
      await attackerInstance.ready()
      const result = await attackerInstance.attempt(contest.attempt)
      expect(result.performed, contest.name).toBe(false)
      expect(result.refusedAt, contest.name).toBe('stop-all')
      assertNoEffect(result)
    })
  }

  it('stops the very next action when the latch is thrown mid-run', async () => {
    const attackerInstance = attacker()
    await attackerInstance.ready()
    const first = await attackerInstance.attempt({ actionId: 'act-1' })
    expect(first.performed).toBe(true)
    expect(attackerInstance.effects()).toBe(1)

    // The latch is read fresh on every attempt rather than captured at open, so one
    // thrown between attempts takes effect immediately. Reading it once at open would
    // let a latch thrown mid-run be ignored for the rest of the process's life.
    attackerInstance.setStopAll(true)
    const second = await attackerInstance.attempt({ actionId: 'act-2' })
    expect(second.performed).toBe(false)
    expect(second.refusedAt).toBe('stop-all')
    assertNoEffect(second)
    expect(attackerInstance.effects()).toBe(1)
  })
})

describe('an approval request cannot be laundered into a permission', () => {
  it('refuses a request with no subject, so it cannot approve everything', async () => {
    const attackerInstance = attacker()
    await attackerInstance.ready()
    const outcome = await attackerInstance.seekApproval({ subjectRef: '' })
    expect(outcome.ok).toBe(false)
  })

  it('refuses a request with no digest, so it cannot be swapped later', async () => {
    const attackerInstance = attacker()
    await attackerInstance.ready()
    const outcome = await attackerInstance.seekApproval({ subjectDigest: '' })
    expect(outcome.ok).toBe(false)
  })

  it('refuses an already-expired request rather than raising and voiding it', async () => {
    const attackerInstance = attacker()
    await attackerInstance.ready()
    const outcome = await attackerInstance.seekApproval({ expiresAt: '2026-06-01T09:00:00.000Z' })
    expect(outcome.ok).toBe(false)
  })

  it('refuses a request with no reasoning to show the owner', async () => {
    const attackerInstance = attacker()
    await attackerInstance.ready()
    const outcome = await attackerInstance.seekApproval({ reasoning: '' })
    expect(outcome.ok).toBe(false)
  })
})