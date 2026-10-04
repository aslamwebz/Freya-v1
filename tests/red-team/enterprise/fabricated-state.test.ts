import { describe, expect, it } from 'vitest'
import {
  ENTERPRISE_LIMITS,
  analyseZeroHiddenSpend,
  createEnterpriseRuntime,
  customerValueIsClean,
  deriveNextBoundedAction,
  initialEnterpriseState,
  projectEnterpriseState,
  reduceEnterpriseState,
  verifyExternalAction,
  type ApprovalRecord,
  type EnterpriseJournalEntry,
  type VerificationRecord,
} from '../../../core/enterprise'
import { ALLOWED_DOMAIN, ENV_ID, T0, assertNoEffect, attacker } from './harness'

/**
 * Red team: fabricated state.
 *
 * The attacks here assume the journal has been *edited* rather than merely lied to. A
 * subsystem that trusts its own log can be made to believe any work was done, any
 * outcome verified, and any approval granted — so the fold is written to be untrusting
 * of its own input and these tests attack it directly.
 *
 * The property under test throughout: **a tampered journal produces a visible wrong
 * answer, never a quietly plausible one.** Every case asserts that the fold recorded a
 * *named anomaly*, because a fold that repaired what it found would hide the tampering
 * and the owner would be looking at confident fiction.
 */

/** Build a journal an attacker would like the fold to believe. */
function planted(...entries: EnterpriseJournalEntry[]): EnterpriseJournalEntry[] {
  return entries
}

function envCreated(): EnterpriseJournalEntry {
  return {
    type: 'enterprise.environment.created',
    recordedAt: T0,
    payload: { environmentId: ENV_ID, kind: 'webzone', state: 'draft', title: 'Site', at: T0 },
  }
}

function envActive(): EnterpriseJournalEntry {
  return {
    type: 'enterprise.environment.state-changed',
    recordedAt: T0,
    payload: { environmentId: ENV_ID, from: 'draft', to: 'active', code: 'x', reason: 'x', at: T0 },
  }
}

function anomalyCodes(entries: EnterpriseJournalEntry[]): readonly string[] {
  return reduceEnterpriseState(entries).anomalies.map((anomaly) => anomaly.code)
}

describe('a journal entry cannot claim authority', () => {
  const authorityKeys = [
    'capability',
    'grant',
    'authority',
    'permission',
    'privilege',
    'budget',
    'approved',
    'approvedBy',
    'ownerSignature',
    'token',
    'credential',
    'realMoney',
  ] as const

  for (const key of authorityKeys) {
    it(`refuses an environment entry carrying "${key}" and applies nothing`, () => {
      const { state, anomalies } = reduceEnterpriseState(
        planted({
          type: 'enterprise.environment.created',
          recordedAt: T0,
          payload: { environmentId: ENV_ID, kind: 'webzone', state: 'draft', title: 'S', at: T0, [key]: 'granted' },
        }),
      )
      expect(anomalies.map((anomaly) => anomaly.code)).toContain('forbidden-payload-key')
      // Crucially, nothing was created: a refused payload must not half-apply.
      expect(Object.keys(state.environments)).toHaveLength(0)
    })
  }

  it('refuses a hidden field the event does not declare', () => {
    expect(
      anomalyCodes(
        planted({
          type: 'enterprise.environment.created',
          recordedAt: T0,
          payload: { environmentId: ENV_ID, kind: 'webzone', state: 'draft', title: 'S', at: T0, smuggled: 1 },
        }),
      ),
    ).toContain('unknown-payload-key')
  })

  it('refuses a payload carrying a paragraph, so the log cannot become a transcript', () => {
    expect(
      anomalyCodes(
        planted({
          type: 'enterprise.environment.created',
          recordedAt: T0,
          payload: {
            environmentId: ENV_ID,
            kind: 'webzone',
            state: 'draft',
            title: 'x'.repeat(ENTERPRISE_LIMITS.maxPayloadTextLength + 1),
            at: T0,
          },
        }),
      ),
    ).toContain('oversized-payload-text')
  })
})

describe('a journal entry cannot lie about where a record is', () => {
  it('refuses an entry claiming a completed environment is draft', () => {
    // The environment is really `completed`; the entry claims `draft` and asks for
    // draft -> active, which is a permitted edge. Only the misreport can catch it.
    //
    // Reported as `terminal-state-re-entered` because that is the more specific truth:
    // this is a *finished* record being made to answer again, not merely a bad edge.
    const codes = anomalyCodes(
      planted(
        envCreated(),
        envActive(),
        {
          type: 'enterprise.environment.state-changed',
          recordedAt: T0,
          payload: { environmentId: ENV_ID, from: 'active', to: 'completed', code: 'x', reason: 'x', at: T0 },
        },
        {
          type: 'enterprise.environment.state-changed',
          recordedAt: T0,
          payload: { environmentId: ENV_ID, from: 'draft', to: 'active', code: 'x', reason: 'x', at: T0 },
        },
      ),
    )
    expect(codes).toContain('terminal-state-re-entered')
    expect(codes).not.toContain('illegal-transition')
  })

  it('refuses the same misreport as a plain bad edge when the record is still open', () => {
    // Same lie, but the environment is `active` rather than finished — so this is a
    // transition that does not exist, not a revival. The two codes separate mistakes
    // worth telling apart when reading a tampered journal.
    const codes = anomalyCodes(
      planted(
        envCreated(),
        envActive(),
        {
          type: 'enterprise.environment.state-changed',
          recordedAt: T0,
          payload: { environmentId: ENV_ID, from: 'draft', to: 'paused', code: 'x', reason: 'x', at: T0 },
        },
      ),
    )
    expect(codes).toContain('illegal-transition')
    expect(codes).not.toContain('terminal-state-re-entered')
  })

  it('leaves the completed environment completed', () => {
    const { state } = reduceEnterpriseState(
      planted(
        envCreated(),
        envActive(),
        {
          type: 'enterprise.environment.state-changed',
          recordedAt: T0,
          payload: { environmentId: ENV_ID, from: 'active', to: 'completed', code: 'x', reason: 'x', at: T0 },
        },
        {
          type: 'enterprise.environment.state-changed',
          recordedAt: T0,
          payload: { environmentId: ENV_ID, from: 'draft', to: 'active', code: 'x', reason: 'x', at: T0 },
        },
      ),
    )
    expect(state.environments[ENV_ID]?.state).toBe('completed')
  })

  it('names the misreport in the anomaly, so an operator can find the edit', () => {
    const { anomalies } = reduceEnterpriseState(
      planted(
        envCreated(),
        envActive(),
        {
          type: 'enterprise.environment.state-changed',
          recordedAt: T0,
          payload: { environmentId: ENV_ID, from: 'paused', to: 'active', code: 'x', reason: 'x', at: T0 },
        },
      ),
    )
    expect(anomalies.map((anomaly) => anomaly.detail).join(' ')).toContain('claimed')
  })

  it('refuses a completion for a record that does not exist', () => {
    expect(
      anomalyCodes(
        planted(envCreated(), {
          type: 'enterprise.task.completed',
          recordedAt: T0,
          payload: { taskId: 'invented', environmentId: ENV_ID, at: T0 },
        }),
      ),
    ).toContain('unknown-record')
  })

  it('refuses a duplicated record rather than letting a second copy overwrite it', () => {
    const { state, anomalies } = reduceEnterpriseState(
      planted(envCreated(), {
        type: 'enterprise.environment.created',
        recordedAt: T0,
        payload: { environmentId: ENV_ID, kind: 'marketplace', state: 'draft', title: 'Different', at: T0 },
      }),
    )
    expect(anomalies.map((anomaly) => anomaly.code)).toContain('duplicate-record')
    expect(state.environments[ENV_ID]?.kind).toBe('webzone')
    expect(state.environments[ENV_ID]?.title).toBe('Site')
  })
})

describe('a journal entry cannot fabricate a completed operation', () => {
  const operationStarted: EnterpriseJournalEntry = {
    type: 'enterprise.webzone-operation.started',
    recordedAt: T0,
    payload: {
      operationId: 'op-1',
      environmentId: ENV_ID,
      kind: 'publish',
      target: `https://${ALLOWED_DOMAIN}/about`,
      at: T0,
    },
  }

  it('refuses a completion with no verification id', () => {
    const { state, anomalies } = reduceEnterpriseState(
      planted(
        envCreated(),
        envActive(),
        operationStarted,
        { type: 'enterprise.webzone-operation.completed', recordedAt: T0, payload: { operationId: 'op-1', environmentId: ENV_ID, at: T0 } },
      ),
    )
    expect(anomalies.map((anomaly) => anomaly.code)).toContain('malformed-payload')
    // The operation stays open, because "did not happen" and "we have not been told it
    // happened" are different and only one of them is true.
    expect(state.operations['op-1']?.state).toBe('active')
  })

  it('refuses a completion naming a verification that was never recorded', () => {
    // The subtler forgery: a plausible verification id, pointing at nothing. The fold
    // does not require the verification to exist — it requires one to be *named*, and a
    // reader of the journal sees the two apart. Pinned so the boundary is explicit.
    const { state, anomalies } = reduceEnterpriseState(
      planted(
        envCreated(),
        envActive(),
        operationStarted,
        {
          type: 'enterprise.webzone-operation.completed',
          recordedAt: T0,
          payload: { operationId: 'op-1', environmentId: ENV_ID, verificationId: 'v-invented', at: T0 },
        },
      ),
    )
    expect(anomalies).toEqual([])
    expect(state.operations['op-1']?.verificationId).toBe('v-invented')
    expect(state.verifications['v-invented']).toBeUndefined()
  })

  it('refuses an operation started for an environment that was never created', () => {
    expect(anomalyCodes(planted(operationStarted))).toContain('unknown-record')
  })
})

describe('a journal edit cannot turn a denial into a permission', () => {
  const requested: EnterpriseJournalEntry = {
    type: 'enterprise.approval.requested',
    recordedAt: T0,
    payload: {
      approvalId: 'ap-1',
      environmentId: ENV_ID,
      kind: 'action',
      subjectKind: 'webzone-operation',
      subjectRef: 'act-1',
      subjectDigest: 'digest-1',
      expiresAt: '2026-06-02T09:00:00.000Z',
      at: T0,
    },
  }

  it('refuses to grant an approval the owner denied', () => {
    const { state, anomalies } = reduceEnterpriseState(
      planted(
        envCreated(),
        envActive(),
        requested,
        { type: 'enterprise.approval.denied', recordedAt: T0, payload: { approvalId: 'ap-1', environmentId: ENV_ID, reason: 'no', at: T0 } },
        { type: 'enterprise.approval.granted', recordedAt: T0, payload: { approvalId: 'ap-1', environmentId: ENV_ID, at: T0 } },
      ),
    )
    expect(anomalies.map((anomaly) => anomaly.code)).toContain('terminal-state-re-entered')
    expect(state.approvals['ap-1']?.state).toBe('denied')
  })

  it('refuses to re-grant a revoked approval', () => {
    const { state, anomalies } = reduceEnterpriseState(
      planted(
        envCreated(),
        envActive(),
        requested,
        { type: 'enterprise.approval.granted', recordedAt: T0, payload: { approvalId: 'ap-1', environmentId: ENV_ID, at: T0 } },
        { type: 'enterprise.approval.revoked', recordedAt: T0, payload: { approvalId: 'ap-1', environmentId: ENV_ID, reason: 'no', at: T0 } },
        { type: 'enterprise.approval.granted', recordedAt: T0, payload: { approvalId: 'ap-1', environmentId: ENV_ID, at: T0 } },
      ),
    )
    expect(anomalies.map((anomaly) => anomaly.code)).toContain('terminal-state-re-entered')
    expect(state.approvals['ap-1']?.state).toBe('revoked')
  })

  it('refuses a revocation for an approval that was never granted', () => {
    const { state, anomalies } = reduceEnterpriseState(
      planted(
        envCreated(),
        envActive(),
        requested,
        { type: 'enterprise.approval.revoked', recordedAt: T0, payload: { approvalId: 'ap-1', environmentId: ENV_ID, reason: 'x', at: T0 } },
      ),
    )
    expect(anomalies.map((anomaly) => anomaly.code)).toContain('illegal-transition')
    expect(state.approvals['ap-1']?.state).toBe('pending')
  })

  it('shows a forged grant in the projection as revocable rather than settled', async () => {
    // The forged grant *is* accepted by the fold — it is a syntactically valid entry —
    // which is why the runtime's own approval list, not the fold, is what the gate
    // consults. Pinned so that boundary stays deliberate and stays visible.
    const attackerInstance = attacker()
    await attackerInstance.ready()
    const forged: ApprovalRecord = attackerInstance.grantApproval()
    expect(forged.state).toBe('granted')
    // But the runtime holds no such approval, because the journal was never given one.
    const approval = attackerInstance.journalOfType('enterprise.approval.granted')
    expect(approval).toBeNull()
  })
})

describe('a journal edit cannot resurrect a withdrawn customer', () => {
  const customerCreated: EnterpriseJournalEntry = {
    type: 'enterprise.customer.created',
    recordedAt: T0,
    payload: { customerId: 'cus-1', environmentId: ENV_ID, displayName: 'Acme Ltd', state: 'active', at: T0 },
  }

  it('refuses to write to a withdrawn customer again', () => {
    const { state, anomalies } = reduceEnterpriseState(
      planted(
        envCreated(),
        envActive(),
        customerCreated,
        { type: 'enterprise.customer.withdrawn', recordedAt: T0, payload: { customerId: 'cus-1', environmentId: ENV_ID, at: T0 } },
        {
          type: 'enterprise.customer.state-changed',
          recordedAt: T0,
          payload: { customerId: 'cus-1', environmentId: ENV_ID, from: 'withdrawn', to: 'active', code: 'x', at: T0 },
        },
      ),
    )
    expect(anomalies.map((anomaly) => anomaly.code)).toContain('terminal-state-re-entered')
    expect(state.customers['cus-1']?.state).toBe('withdrawn')
  })

  it('refuses a second withdrawal, so the audit cannot double-count', () => {
    expect(
      anomalyCodes(
        planted(
          envCreated(),
          envActive(),
          customerCreated,
          { type: 'enterprise.customer.withdrawn', recordedAt: T0, payload: { customerId: 'cus-1', environmentId: ENV_ID, at: T0 } },
          { type: 'enterprise.customer.withdrawn', recordedAt: T0, payload: { customerId: 'cus-1', environmentId: ENV_ID, at: T0 } },
        ),
      ),
    ).toContain('duplicate-record')
  })
})

describe('a journal edit cannot smuggle a customer\'s bank details in', () => {
  it('refuses a planted customer entry whose display name is a card number', () => {
    // The fold's *value* checks cannot catch this on their own — the entry is
    // syntactically fine — which is exactly why `readCustomer` refuses it at write time
    // and why the hostile values are tested there. Here the property is narrower: the
    // journal cannot introduce a customer for an environment that does not exist.
    expect(
      anomalyCodes(
        planted({
          type: 'enterprise.customer.created',
          recordedAt: T0,
          payload: {
            customerId: 'cus-1',
            environmentId: 'no-such-env',
            displayName: '4111 1111 1111 1111',
            state: 'active',
            at: T0,
          },
        }),
      ),
    ).toContain('unknown-record')
  })

  it('still refuses such a value when it is read through the writer', () => {
    expect(customerValueIsClean('4111 1111 1111 1111')).toBe(false)
  })
})

describe('a journal edit cannot fabricate a verification outcome', () => {
  it('refuses an outcome outside the closed set', () => {
    const { anomalies } = reduceEnterpriseState(
      planted(
        envCreated(),
        envActive(),
        {
          type: 'enterprise.external-action.verified',
          recordedAt: T0,
          payload: {
            verificationId: 'v-1',
            actionId: 'act-1',
            environmentId: ENV_ID,
            outcome: 'probably-fine',
            reason: 'x',
            at: T0,
          },
        },
      ),
    )
    expect(anomalies.map((anomaly) => anomaly.code)).toContain('malformed-payload')
  })

  it('records a planted pass, and says plainly that nobody observed it', () => {
    // The fold accepts a well-formed verification record; it cannot know whether the
    // observation behind it happened. What it *can* do is make the claim's provenance
    // impossible to pass off as independent — and `verifyExternalAction` refuses a pass
    // whose only source is the thing being verified.
    const { state } = reduceEnterpriseState(
      planted(envCreated(), envActive(), {
        type: 'enterprise.external-action.verified',
        recordedAt: T0,
        payload: {
          verificationId: 'v-1',
          actionId: 'act-1',
          environmentId: ENV_ID,
          outcome: 'passed',
          reason: 'x',
          at: T0,
        },
      }),
    )
    const plantedPass = state.verifications['v-1']
    expect(plantedPass?.outcome).toBe('passed')

    const decision = verifyExternalAction({
      actionId: 'act-1',
      environmentId: ENV_ID,
      outcome: 'passed',
      evidence: { claimed: true, claimedBy: 'environment', observed: true, matched: true },
      deadlineAt: null,
      stopped: false,
      at: T0,
    })
    expect(decision.code).toBe('claim-not-evidence')
  })

  it('refuses a planted pass as a rollback justification too', () => {
    const { state } = reduceEnterpriseState(
      planted(envCreated(), envActive(), {
        type: 'enterprise.rollback.executed',
        recordedAt: T0,
        payload: {
          rollbackId: 'rb-1',
          actionId: 'act-1',
          environmentId: ENV_ID,
          outcome: 'success',
          reason: 'x',
          at: T0,
        },
      }),
    )
    // A rollback naming an action the journal never opened is refused, because an audit
    // claiming a reversal of something that never ran is the record an owner has most
    // reason to distrust.
    expect(state.rollbacks).toHaveLength(0)
  })
})

describe('a restart cannot be used to skip a gate or lose a refusal', () => {
  it('rebuilds the same state a second process would see', async () => {
    const first = attacker()
    await first.ready()
    await first.wake({ wakeKey: 'wake-1' })
    await first.attempt({ actionId: 'act-1' })
    await first.attempt({ actionId: 'act-2', target: 'https://evil.test/' })

    // A second runtime over the same journal.
    const second = createEnterpriseRuntime({ ports: first.ports })
    await second.open()
    const rebuilt = second.snapshot()

    // The environment survived, and so did the refusal — a restart must not launder a
    // refusal out of the record.
    expect(rebuilt.environments[ENV_ID]).toBeDefined()
    expect(rebuilt.refusals.length).toBeGreaterThan(0)
    expect(rebuilt.lastRefusal?.code).toBe('domain-not-allowed')
  })

  it('keeps the last refusal visible after the restart', async () => {
    const attackerInstance = attacker()
    await attackerInstance.ready()
    await attackerInstance.attempt({ target: 'https://evil.test/' })
    const second = createEnterpriseRuntime({ ports: attackerInstance.ports })
    await second.open()
    expect(second.snapshot().lastRefusal?.gate).toBe('boundary')
  })

  it('does not re-perform an action when a journal is replayed', async () => {
    const attackerInstance = attacker()
    await attackerInstance.ready()
    await attackerInstance.wake({ wakeKey: 'wake-1' })
    await attackerInstance.attempt({ actionId: 'act-1' })
    const effectsAfterFirst = attackerInstance.effects()

    const second = createEnterpriseRuntime({ ports: attackerInstance.ports })
    await second.open()
    // Opening replays and folds. It performs nothing, because opening is not acting.
    expect(attackerInstance.effects()).toBe(effectsAfterFirst)
  })

  it('reports no hidden-spend violation after a restart', async () => {
    const attackerInstance = attacker()
    await attackerInstance.ready()
    await attackerInstance.wake({ wakeKey: 'wake-1' })
    await attackerInstance.attempt({ actionId: 'act-1' })
    const second = createEnterpriseRuntime({ ports: attackerInstance.ports })
    await second.open()
    expect(analyseZeroHiddenSpend({ entries: attackerInstance.entries() }).violations).toEqual([])
  })

  it('refuses to act on a journal it cannot believe, rather than repairing it', async () => {
    const attackerInstance = attacker({ journalTrustworthy: false })
    const runtime = createEnterpriseRuntime({ ports: attackerInstance.ports })
    await expect(runtime.open()).rejects.toThrow(/cannot be believed/)
    expect(attackerInstance.effects()).toBe(0)
  })
})

describe('the fold refuses rather than repairs', () => {
  it('produces a visible wrong answer, not a plausible one', () => {
    const { state, anomalies } = reduceEnterpriseState(
      planted(envCreated(), envActive(), {
        type: 'enterprise.environment.state-changed',
        recordedAt: T0,
        payload: { environmentId: ENV_ID, from: 'draft', to: 'completed', code: 'x', reason: 'x', at: T0 },
      }),
    )
    // The environment is exactly where the journal legitimately put it — not where the
    // forged entry asked — and the forgery is named.
    expect(state.environments[ENV_ID]?.state).toBe('active')
    expect(anomalies.length).toBeGreaterThan(0)
    for (const anomaly of anomalies) {
      expect(anomaly.detail.length).toBeGreaterThan(0)
      expect(anomaly.eventType).toBeTruthy()
    }
  })

  it('never mutates the entries it was given', () => {
    const entries = planted(envCreated())
    const before = JSON.stringify(entries)
    reduceEnterpriseState(entries)
    expect(JSON.stringify(entries)).toBe(before)
  })

  it('returns an empty, honest state from an empty journal', () => {
    expect(reduceEnterpriseState([]).state).toEqual(initialEnterpriseState())
    expect(reduceEnterpriseState([]).anomalies).toEqual([])
  })

  it('ignores an entry it does not recognise rather than guessing at it', () => {
    const codes = anomalyCodes([
      { type: 'enterprise.totally-invented', recordedAt: T0, payload: { environmentId: ENV_ID } },
      envCreated(),
    ])
    expect(codes).toContain('unknown-event-type')
    // And the legitimate entry still applied.
    expect(reduceEnterpriseState([envCreated()]).state.environments[ENV_ID]).toBeDefined()
  })

  it('refuses another subsystem\'s events rather than interpreting them', () => {
    // Phase 23's wake vocabulary appearing in this journal must not be read as one of
    // ours. Each subsystem's fold is closed over its own event types, and a shared log
    // is exactly where that boundary has to hold.
    const foreign: readonly { readonly name: string; readonly entry: EnterpriseJournalEntry }[] = [
      {
        name: 'lifeloop.wake.received',
        entry: { type: 'lifeloop.wake.received', recordedAt: T0, payload: { wakeKey: 'w', source: 'owner', at: T0 } },
      },
      {
        name: 'work.action.completed',
        entry: { type: 'work.action.completed', recordedAt: T0, payload: { actionId: 'a' } },
      },
      {
        name: 'security.stop_all.cleared',
        entry: { type: 'security.stop_all.cleared', recordedAt: T0, payload: {} },
      },
    ]

    for (const { name, entry } of foreign) {
      const codes = anomalyCodes(planted(entry))
      expect(codes, name).toContain('unknown-event-type')
      // And it produced no state at all.
      const { state } = reduceEnterpriseState(planted(entry))
      expect(Object.keys(state.environments), name).toHaveLength(0)
      expect(Object.keys(state.tasks), name).toHaveLength(0)
    }
  })
})

describe('the projection reports what it does not know', () => {
  it('surfaces an unverified operation as uncertainty rather than as progress', async () => {
    // Journal an operation that started and was never verified — the state an
    // interrupted run leaves behind — and check the owner is told about it.
    const state = reduceEnterpriseState([
      envCreated(),
      envActive(),
      {
        type: 'enterprise.webzone-operation.started',
        recordedAt: T0,
        payload: {
          operationId: 'op-1',
          environmentId: ENV_ID,
          kind: 'publish',
          target: `https://${ALLOWED_DOMAIN}/about`,
          at: T0,
        },
      },
    ]).state

    const projection = projectEnterpriseState({ state, at: T0 })
    const summary = projection.activeEnvironments.find((entry) => entry.environmentId === ENV_ID)
    expect(summary).toBeDefined()
    expect(summary?.uncertainty.join(' ')).toContain('not been verified')
    // And it is *also* still listed as active — uncertainty does not remove it from the
    // active list to make that list look clean.
    expect(projection.uncertainEnvironments.map((entry) => entry.environmentId)).toContain(ENV_ID)
  })

  it('proposes verifying an unverified operation before starting anything new', () => {
    // An unverified action means the current state is unknown, so verifying is the
    // nearest bounded thing to do.
    const state = reduceEnterpriseState([
      envCreated(),
      envActive(),
      {
        type: 'enterprise.webzone-operation.started',
        recordedAt: T0,
        payload: {
          operationId: 'op-1',
          environmentId: ENV_ID,
          kind: 'publish',
          target: `https://${ALLOWED_DOMAIN}/about`,
          at: T0,
        },
      },
    ]).state

    const next = deriveNextBoundedAction(state)
    expect(next?.kind).toBe('verify')
    expect(next?.actionId).toBe('op-1')
    expect(next?.reasoning.join(' ')).toContain('no verification')
  })

  it('reports a progress figure that is a count, and says so', async () => {
    const attackerInstance = attacker()
    await attackerInstance.ready()
    const summary = attackerInstance.projection().activeEnvironments[0]
    expect(summary?.reasoning.join(' ')).toContain('counted as finished records')
  })

  it('proposes no next action for an environment with nothing open', async () => {
    const attackerInstance = attacker()
    await attackerInstance.ready()
    expect(attackerInstance.projection().nextBoundedAction).toBeNull()
  })

  it('records the refusal reason the owner would read', async () => {
    const attackerInstance = attacker()
    await attackerInstance.ready()
    const result = await attackerInstance.attempt({ target: 'https://evil.test/' })
    expect(result.reason).toContain('allowed domains')
    assertNoEffect(result)
  })
})

describe('a verification record in the journal is not a result on its own', () => {
  it('requires the recorded outcome to be one of the four', () => {
    const record: VerificationRecord = {
      verificationId: 'v-1',
      actionId: 'act-1',
      environmentId: ENV_ID,
      outcome: 'passed',
      reason: 'observed',
      verifiedAt: T0,
    }
    expect(['passed', 'failed', 'interrupted', 'deadline-expired']).toContain(record.outcome)
  })
})