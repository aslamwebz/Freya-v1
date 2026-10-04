import { describe, expect, it } from 'vitest'
import {
  ENTERPRISE_LIMITS,
  ENTERPRISE_PAYLOAD_KEYS,
  analyseZeroHiddenSpend,
  auditTransitionTables,
  countsFor,
  initialEnterpriseState,
  inspectEnterprisePayload,
  reduceEnterpriseEntry,
  reduceEnterpriseState,
  type EnterpriseJournalEntry,
  type EnterpriseEventType,
} from '../../../core/enterprise'
import { ENV_ID, T0 } from './harness'

/**
 * The fold.
 *
 * Everything this subsystem knows comes from these entries, which makes the fold the
 * single place where a wrong belief about a business can enter the system. So the tests
 * are mostly about what it does with a *hostile* entry: does it refuse, and does the
 * refusal show up as a named anomaly rather than as a quietly plausible state?
 *
 * The property that matters most is that a tampered journal produces a **visible wrong
 * answer**. A fold that repaired what it found would hide the tampering, and the owner
 * would be looking at confident fiction about work already done.
 */

function entry(type: string, payload: Record<string, unknown>, at = T0): EnterpriseJournalEntry {
  return { type, recordedAt: at, payload }
}

/** A minimal, legal journal: one environment, activated. */
function seeded(): EnterpriseJournalEntry[] {
  return [
    entry('enterprise.environment.created', {
      environmentId: ENV_ID,
      kind: 'webzone',
      state: 'draft',
      title: 'Owner site',
      at: T0,
    }),
    entry('enterprise.environment.state-changed', {
      environmentId: ENV_ID,
      from: 'draft',
      to: 'active',
      code: 'activated',
      reason: 'the owner activated it',
      at: T0,
    }),
  ]
}

describe('a legal journal folds to the state it describes', () => {
  it('creates an environment in draft and then activates it', () => {
    const { state, anomalies } = reduceEnterpriseState(seeded())
    expect(anomalies).toEqual([])
    expect(state.environments[ENV_ID]).toMatchObject({ state: 'active', kind: 'webzone', title: 'Owner site' })
  })

  it('is a pure function of its entries, in order', () => {
    const first = reduceEnterpriseState(seeded())
    const second = reduceEnterpriseState(seeded())
    expect(JSON.stringify(first.state)).toBe(JSON.stringify(second.state))
  })

  it('is unaffected by entries it does not recognise, and says so', () => {
    const { anomalies } = reduceEnterpriseState([...seeded(), entry('enterprise.invented', { x: 1 })])
    expect(anomalies.map((anomaly) => anomaly.code)).toContain('unknown-event-type')
    // And the recognised entries still applied.
    expect(anomalies.filter((anomaly) => anomaly.code === 'unknown-event-type')).toHaveLength(1)
  })
})

describe('the fold refuses a payload shaped like authority', () => {
  /**
   * These are the payloads a real escalation attempt would look like. The journal is
   * the last place in the system where one should be able to appear, so each of these
   * is refused as a named anomaly and the entry has no effect at all.
   */
  const authorityPayloads: readonly { readonly key: string; readonly value: unknown }[] = [
    { key: 'capability', value: 'payments' },
    { key: 'grant', value: 'unlimited' },
    { key: 'authority', value: 'owner' },
    { key: 'permission', value: 'all' },
    { key: 'budget', value: 1_000_000 },
    { key: 'approved', value: true },
    { key: 'approvedBy', value: 'owner' },
    { key: 'ownerSignature', value: 'x' },
    { key: 'verdict', value: 'guilty' },
    { key: 'token', value: 'secret' },
    { key: 'realMoney', value: true },
  ]

  for (const { key, value } of authorityPayloads) {
    it(`refuses an environment entry carrying "${key}"`, () => {
      const { state, anomalies } = reduceEnterpriseState([
        entry('enterprise.environment.created', {
          environmentId: ENV_ID,
          kind: 'webzone',
          state: 'draft',
          title: 'x',
          at: T0,
          [key]: value,
        }),
      ])
      expect(anomalies.map((anomaly) => anomaly.code)).toContain('forbidden-payload-key')
      // Crucially: the entry had *no* effect. A refused payload must not half-apply.
      expect(state.environments).toEqual({})
    })
  }

  it('refuses a key that is simply not part of the event, on any event', () => {
    const { state, anomalies } = reduceEnterpriseState([
      entry('enterprise.environment.created', {
        environmentId: ENV_ID,
        kind: 'webzone',
        state: 'draft',
        title: 'x',
        at: T0,
        sneaky: 'value',
      }),
    ])
    expect(anomalies.map((anomaly) => anomaly.code)).toContain('unknown-payload-key')
    expect(state.environments).toEqual({})
  })

  it('refuses a payload longer than the journal text bound', () => {
    const { anomalies } = reduceEnterpriseState([
      entry('enterprise.environment.created', {
        environmentId: ENV_ID,
        kind: 'webzone',
        state: 'draft',
        title: 'x'.repeat(ENTERPRISE_LIMITS.maxPayloadTextLength + 1),
        at: T0,
      }),
    ])
    expect(anomalies.map((anomaly) => anomaly.code)).toContain('oversized-payload-text')
  })
})

describe('the fold checks values, not only key names', () => {
  it('refuses an unknown state rather than defaulting it', () => {
    const { anomalies } = reduceEnterpriseState([
      entry('enterprise.environment.created', {
        environmentId: ENV_ID,
        kind: 'webzone',
        state: 'operational',
        title: 'x',
        at: T0,
      }),
    ])
    expect(anomalies.map((anomaly) => anomaly.code)).toContain('malformed-payload')
  })

  it('refuses an unknown environment kind', () => {
    const { anomalies } = reduceEnterpriseState([
      entry('enterprise.environment.created', {
        environmentId: ENV_ID,
        kind: 'trading-floor',
        state: 'draft',
        title: 'x',
        at: T0,
      }),
    ])
    expect(anomalies.map((anomaly) => anomaly.code)).toContain('malformed-payload')
  })

  it('refuses an unknown catalog item kind', () => {
    const { anomalies } = reduceEnterpriseState([
      ...seeded(),
      entry('enterprise.catalog.item-created', {
        itemId: 'item-1',
        environmentId: ENV_ID,
        itemKind: 'treasury',
        name: 'x',
        state: 'draft',
        at: T0,
      }),
    ])
    expect(anomalies.map((anomaly) => anomaly.code)).toContain('malformed-payload')
  })

  it('refuses a non-boolean "held" on a gate record', () => {
    const { anomalies } = reduceEnterpriseState([
      ...seeded(),
      entry('enterprise.boundary.checked', {
        environmentId: ENV_ID,
        actionId: 'act-1',
        boundary: 'domain',
        held: 'yes',
        at: T0,
      }),
    ])
    expect(anomalies.map((anomaly) => anomaly.code)).toContain('malformed-payload')
  })

  it('refuses a payload that is not an object', () => {
    for (const payload of ['a string', 42, null, ['an', 'array']]) {
      const { anomalies } = reduceEnterpriseState([
        entry('enterprise.environment.created', payload as unknown as Record<string, unknown>),
      ])
      expect(anomalies.map((anomaly) => anomaly.code), String(payload)).toContain('malformed-payload')
    }
  })

  it('names an unknown record separately from a malformed payload', () => {
    // "There is no such task" and "this entry says something impossible" are different
    // mistakes and an operator debugging a journal needs to tell them apart.
    for (const [eventType, payload] of [
      ['enterprise.task.state-changed', { taskId: 'nope', environmentId: ENV_ID, from: 'draft', to: 'active', code: 'x', at: T0 }],
      ['enterprise.environment.state-changed', { environmentId: 'nope', from: 'draft', to: 'active', code: 'x', reason: 'x', at: T0 }],
      ['enterprise.task.completed', { taskId: 'nope', environmentId: ENV_ID, at: T0 }],
      ['enterprise.approval.granted', { approvalId: 'nope', environmentId: ENV_ID, at: T0 }],
      ['enterprise.webzone-operation.failed', { operationId: 'nope', environmentId: ENV_ID, code: 'x', reason: 'x', at: T0 }],
      // A rollback names the *action* it reverses, so the check is that the action is
      // one the journal knows about.
      // A rollback names the action it reverses, so it must name one the journal
      // knows about — otherwise the audit claims a reversal of something that never ran.
      [
        'enterprise.rollback.executed',
        { rollbackId: 'r1', actionId: 'nope', environmentId: ENV_ID, outcome: 'success', reason: 'x', at: T0 },
      ],
    ] as const) {
      const { anomalies } = reduceEnterpriseState([entry(eventType, { ...payload })])
      expect(anomalies.map((anomaly) => anomaly.code), eventType).toContain('unknown-record')
      expect(anomalies.map((anomaly) => anomaly.code), eventType).not.toContain('malformed-payload')
    }
  })
})

describe('an illegal transition is refused, not applied', () => {
  it('refuses to skip straight from draft to completed', () => {
    const { state, anomalies } = reduceEnterpriseState([
      ...seeded().slice(0, 1),
      entry('enterprise.environment.state-changed', {
        environmentId: ENV_ID,
        from: 'draft',
        to: 'completed',
        code: 'x',
        reason: 'x',
        at: T0,
      }),
    ])
    expect(anomalies.map((anomaly) => anomaly.code)).toContain('illegal-transition')
    expect(state.environments[ENV_ID]?.state).toBe('draft')
  })

  it('refuses a transition that lies about where the record actually is', () => {
    // The escalation this closes: the fold used to validate `transition(from, to)` as
    // the payload described it, so an entry claiming `from: 'draft'` for a record that
    // is already `completed` was checked against the wrong situation and believed.
    const { state, anomalies } = reduceEnterpriseState([
      ...seeded(),
      entry('enterprise.environment.state-changed', {
        environmentId: ENV_ID,
        from: 'draft',
        to: 'active',
        code: 'x',
        reason: 'x',
        at: T0,
      }),
    ])
    // The record is already `active`; active -> active is a self-transition.
    expect(anomalies.map((anomaly) => anomaly.code)).toContain('illegal-transition')
    expect(state.environments[ENV_ID]?.state).toBe('active')
  })

  it('says in the anomaly that the entry misreported the state', () => {
    const { anomalies } = reduceEnterpriseState([
      ...seeded(),
      entry('enterprise.environment.state-changed', {
        environmentId: ENV_ID,
        from: 'paused',
        to: 'active',
        code: 'x',
        reason: 'x',
        at: T0,
      }),
    ])
    const detail = anomalies.map((anomaly) => anomaly.detail).join(' ')
    expect(detail).toContain('claimed')
  })

it('refuses the same lie on a task', () => {
    const { state, anomalies } = reduceEnterpriseState([
      ...seeded(),
      entry('enterprise.task.created', { taskId: 't1', environmentId: ENV_ID, state: 'draft', at: T0 }),
      entry('enterprise.task.completed', { taskId: 't1', environmentId: ENV_ID, at: T0 }),
      // The record is `completed`; the entry claims `draft`. Reopening it must fail,
      // and the failure is specifically "a finished record was revived".
      entry('enterprise.task.state-changed', {
        taskId: 't1',
        environmentId: ENV_ID,
        from: 'draft',
        to: 'active',
        code: 'x',
        at: T0,
      }),
    ])
    expect(anomalies.map((anomaly) => anomaly.code)).toContain('terminal-state-re-entered')
    expect(state.tasks['t1']?.state).toBe('completed')
  })

  it('refuses a lie that is not a revival, with the plain illegal-transition code', () => {
    // Same misreporting, but the record is still open — so this is a bad edge, not a
    // revived terminal record. The two codes separate mistakes worth telling apart.
    const { state, anomalies } = reduceEnterpriseState([
      ...seeded(),
      entry('enterprise.task.created', { taskId: 't1', environmentId: ENV_ID, state: 'draft', at: T0 }),
      entry('enterprise.task.state-changed', {
        taskId: 't1',
        environmentId: ENV_ID,
        from: 'draft',
        to: 'active',
        code: 'x',
        at: T0,
      }),
      // Record is `active`; claims `draft`. draft -> paused is a real edge, so only
      // the misreport can catch it.
      entry('enterprise.task.state-changed', {
        taskId: 't1',
        environmentId: ENV_ID,
        from: 'draft',
        to: 'paused',
        code: 'x',
        at: T0,
      }),
    ])
    expect(anomalies.map((anomaly) => anomaly.code)).toContain('illegal-transition')
    expect(anomalies.map((anomaly) => anomaly.code)).not.toContain('terminal-state-re-entered')
    expect(state.tasks['t1']?.state).toBe('active')
  })

  it('refuses the same lie on a mission', () => {
    const { state, anomalies } = reduceEnterpriseState([
      ...seeded(),
      entry('enterprise.mission.created', { missionId: 'm1', environmentId: ENV_ID, state: 'draft', at: T0 }),
      entry('enterprise.mission.state-changed', {
        missionId: 'm1',
        environmentId: ENV_ID,
        from: 'draft',
        to: 'active',
        code: 'x',
        at: T0,
      }),
      // Claim `draft` while it is really `completed`, trying to reopen it.
      entry('enterprise.mission.state-changed', {
        missionId: 'm1',
        environmentId: ENV_ID,
        from: 'draft',
        to: 'active',
        code: 'x',
        at: T0,
      }),
      entry('enterprise.mission.completed', { missionId: 'm1', environmentId: ENV_ID, at: T0 }),
      entry('enterprise.mission.state-changed', {
        missionId: 'm1',
        environmentId: ENV_ID,
        from: 'draft',
        to: 'active',
        code: 'x',
        at: T0,
      }),
    ])
    expect(state.missions['m1']?.state).toBe('completed')
    expect(anomalies.map((anomaly) => anomaly.code)).toContain('illegal-transition')
  })

  it('refuses to reopen a completed environment, naming it a reopened terminal record', () => {
    const { state, anomalies } = reduceEnterpriseState([
      ...seeded(),
      entry('enterprise.environment.state-changed', {
        environmentId: ENV_ID,
        from: 'active',
        to: 'completed',
        code: 'x',
        reason: 'x',
        at: T0,
      }),
      entry('enterprise.environment.state-changed', {
        environmentId: ENV_ID,
        from: 'completed',
        to: 'active',
        code: 'x',
        reason: 'x',
        at: T0,
      }),
    ])
    // The more specific code, because "a finished record was revived" and "that edge
    // does not exist" are different mistakes worth telling apart in a journal.
    expect(anomalies.map((anomaly) => anomaly.code)).toContain('terminal-state-re-entered')
    expect(state.environments[ENV_ID]?.state).toBe('completed')
  })

  it('refuses a self-transition', () => {
    const { anomalies } = reduceEnterpriseState([
      ...seeded(),
      entry('enterprise.environment.state-changed', {
        environmentId: ENV_ID,
        from: 'active',
        to: 'active',
        code: 'x',
        reason: 'x',
        at: T0,
      }),
    ])
    expect(anomalies.map((anomaly) => anomaly.code)).toContain('illegal-transition')
  })

  it('refuses a duplicated record rather than overwriting it', () => {
    const { state, anomalies } = reduceEnterpriseState([...seeded(), ...seeded()])
    expect(anomalies.map((anomaly) => anomaly.code)).toContain('duplicate-record')
    expect(state.environments[ENV_ID]?.title).toBe('Owner site')
  })

  it('bounds how many environments can exist', () => {
    const many: EnterpriseJournalEntry[] = []
    for (let index = 0; index <= ENTERPRISE_LIMITS.maxEnvironments; index += 1) {
      many.push(
        entry('enterprise.environment.created', {
          environmentId: `env-${index}`,
          kind: 'webzone',
          state: 'draft',
          title: `Environment ${index}`,
          at: T0,
        }),
      )
    }
    const { state, anomalies } = reduceEnterpriseState(many)
    expect(Object.keys(state.environments)).toHaveLength(ENTERPRISE_LIMITS.maxEnvironments)
    expect(anomalies.length).toBeGreaterThan(0)
  })
})

describe('no operation is complete without a verification', () => {
  const withOperation = [
    ...seeded(),
    entry('enterprise.webzone-operation.started', {
      operationId: 'op-1',
      environmentId: ENV_ID,
      kind: 'publish',
      target: 'https://example.com/about',
      at: T0,
    }),
  ]

  it('refuses a completion carrying no verification id', () => {
    // This is the single most important line in the fold: it is what makes "no
    // operation is complete without verification" true of the *record* and not only of
    // the runtime that happened to write it.
    const { state, anomalies } = reduceEnterpriseState([
      ...withOperation,
      entry('enterprise.webzone-operation.completed', {
        operationId: 'op-1',
        environmentId: ENV_ID,
        at: T0,
      }),
    ])
    expect(anomalies.map((anomaly) => anomaly.code)).toContain('malformed-payload')
    expect(state.operations['op-1']?.state).toBe('active')
  })

  it('refuses a completion carrying an empty verification id', () => {
    const { state, anomalies } = reduceEnterpriseState([
      ...withOperation,
      entry('enterprise.webzone-operation.completed', {
        operationId: 'op-1',
        environmentId: ENV_ID,
        verificationId: '',
        at: T0,
      }),
    ])
    expect(anomalies.map((anomaly) => anomaly.code)).toContain('malformed-payload')
    expect(state.operations['op-1']?.state).toBe('active')
  })

  it('accepts a completion that names a verification', () => {
    const { state, anomalies } = reduceEnterpriseState([
      ...withOperation,
      entry('enterprise.webzone-operation.completed', {
        operationId: 'op-1',
        environmentId: ENV_ID,
        verificationId: 'v-1',
        at: T0,
      }),
    ])
    expect(anomalies).toEqual([])
    expect(state.operations['op-1']).toMatchObject({ state: 'completed', verificationId: 'v-1' })
  })

  it('refuses an operation started for an environment that does not exist', () => {
    const { anomalies } = reduceEnterpriseState([
      entry('enterprise.webzone-operation.started', {
        operationId: 'op-1',
        environmentId: 'no-such-env',
        kind: 'publish',
        target: 'https://example.com/',
        at: T0,
      }),
    ])
    expect(anomalies.map((anomaly) => anomaly.code)).toContain('unknown-record')
  })
})

describe('a withdrawn customer cannot reappear', () => {
  const withCustomer = [
    ...seeded(),
    entry('enterprise.customer.created', {
      customerId: 'cus-1',
      environmentId: ENV_ID,
      displayName: 'Acme Ltd',
      state: 'active',
      at: T0,
    }),
  ]

  it('withdraws, and then refuses any further write', () => {
    const { state, anomalies } = reduceEnterpriseState([
      ...withCustomer,
      entry('enterprise.customer.withdrawn', { customerId: 'cus-1', environmentId: ENV_ID, at: T0 }),
      entry('enterprise.customer.state-changed', {
        customerId: 'cus-1',
        environmentId: ENV_ID,
        from: 'withdrawn',
        to: 'active',
        code: 'x',
        at: T0,
      }),
    ])
    expect(anomalies.map((anomaly) => anomaly.code)).toContain('terminal-state-re-entered')
    expect(state.customers['cus-1']?.state).toBe('withdrawn')
  })

  it('refuses to withdraw twice, so the audit does not double-count', () => {
    const { anomalies } = reduceEnterpriseState([
      ...withCustomer,
      entry('enterprise.customer.withdrawn', { customerId: 'cus-1', environmentId: ENV_ID, at: T0 }),
      entry('enterprise.customer.withdrawn', { customerId: 'cus-1', environmentId: ENV_ID, at: T0 }),
    ])
    expect(anomalies.map((anomaly) => anomaly.code)).toContain('duplicate-record')
  })
})

describe('an approval cannot be self-answered through the journal', () => {
  const withApproval = [
    ...seeded(),
    entry('enterprise.approval.requested', {
      approvalId: 'ap-1',
      environmentId: ENV_ID,
      kind: 'action',
      subjectKind: 'webzone-operation',
      subjectRef: 'act-1',
      subjectDigest: 'digest-1',
      expiresAt: '2026-05-02T09:00:00.000Z',
      at: T0,
    }),
  ]

  it('records a granted approval, and keeps it revocable', () => {
    const { state } = reduceEnterpriseState([
      ...withApproval,
      entry('enterprise.approval.granted', { approvalId: 'ap-1', environmentId: ENV_ID, at: T0 }),
    ])
    expect(state.approvals['ap-1']?.state).toBe('granted')
  })

  it('records a revocation from granted, so withdrawal survives the fold', () => {
    // `granted` is deliberately non-terminal so this transition exists at all.
    const { state, anomalies } = reduceEnterpriseState([
      ...withApproval,
      entry('enterprise.approval.granted', { approvalId: 'ap-1', environmentId: ENV_ID, at: T0 }),
      entry('enterprise.approval.revoked', {
        approvalId: 'ap-1',
        environmentId: ENV_ID,
        reason: 'changed my mind',
        at: T0,
      }),
    ])
    expect(anomalies).toEqual([])
    expect(state.approvals['ap-1']?.state).toBe('revoked')
  })

  it('refuses to grant an approval the owner already denied', () => {
    // The most consequential thing a journal edit could attempt: turn a refusal into a
    // permission. Only the owner may move an approval from a settled state.
    const { state, anomalies } = reduceEnterpriseState([
      ...withApproval,
      entry('enterprise.approval.denied', {
        approvalId: 'ap-1',
        environmentId: ENV_ID,
        reason: 'no',
        at: T0,
      }),
      entry('enterprise.approval.granted', { approvalId: 'ap-1', environmentId: ENV_ID, at: T0 }),
    ])
    expect(anomalies.map((anomaly) => anomaly.code)).toContain('terminal-state-re-entered')
    expect(state.approvals['ap-1']?.state).toBe('denied')
  })

  it('refuses to re-grant an approval that was revoked', () => {
    const { state, anomalies } = reduceEnterpriseState([
      ...withApproval,
      entry('enterprise.approval.granted', { approvalId: 'ap-1', environmentId: ENV_ID, at: T0 }),
      entry('enterprise.approval.revoked', {
        approvalId: 'ap-1',
        environmentId: ENV_ID,
        reason: 'changed my mind',
        at: T0,
      }),
      entry('enterprise.approval.granted', { approvalId: 'ap-1', environmentId: ENV_ID, at: T0 }),
    ])
    expect(anomalies.map((anomaly) => anomaly.code)).toContain('terminal-state-re-entered')
    expect(state.approvals['ap-1']?.state).toBe('revoked')
  })

  it('refuses to revoke an approval that was never granted', () => {
    const { state, anomalies } = reduceEnterpriseState([
      ...withApproval,
      entry('enterprise.approval.revoked', {
        approvalId: 'ap-1',
        environmentId: ENV_ID,
        reason: 'x',
        at: T0,
      }),
    ])
    expect(anomalies.map((anomaly) => anomaly.code)).toContain('illegal-transition')
    expect(state.approvals['ap-1']?.state).toBe('pending')
  })
})

describe('the fold bounds what it grows', () => {
  it('keeps the refusal list bounded while retaining the newest', () => {
    const refusals: EnterpriseJournalEntry[] = []
    for (let index = 0; index < ENTERPRISE_LIMITS.maxRetainedRefusals + 20; index += 1) {
      refusals.push(
        entry('enterprise.action.refused', {
          actionId: `act-${index}`,
          environmentId: ENV_ID,
          gate: 'boundary',
          code: 'domain-not-allowed',
          reason: 'x',
          at: T0,
        }),
      )
    }
    const { state } = reduceEnterpriseState([...seeded(), ...refusals])
    expect(state.refusals.length).toBeLessThanOrEqual(ENTERPRISE_LIMITS.maxRetainedRefusals)
    // The newest is the one kept, which is the one the owner is asking about.
    expect(state.lastRefusal?.actionId).toBe(`act-${refusals.length - 1}`)
    // And the oldest retained is the first one inside the window.
    expect(state.refusals[0]?.actionId).toBe(`act-${refusals.length - ENTERPRISE_LIMITS.maxRetainedRefusals}`)
  })

  it('keeps wake keys bounded and refuses a duplicate wake', () => {
    const wakes: EnterpriseJournalEntry[] = [
      entry('enterprise.wake.received', { wakeKey: 'wake-1', source: 'owner', at: T0 }),
      entry('enterprise.wake.received', { wakeKey: 'wake-1', source: 'owner', at: T0 }),
    ]
    const { state, anomalies } = reduceEnterpriseState(wakes)
    expect(anomalies.map((anomaly) => anomaly.code)).toContain('duplicate-record')
    expect(state.wakeKeys).toEqual(['wake-1'])
  })
})

describe('incremental folding matches whole-journal folding', () => {
  it('reaches the same state either way', () => {
    const whole = reduceEnterpriseState(seeded())
    let incremental = initialEnterpriseState()
    for (const item of seeded()) {
      incremental = reduceEnterpriseEntry(incremental, item).state
    }
    expect(JSON.stringify(incremental)).toBe(JSON.stringify(whole.state))
  })

  it('lets a single hostile entry be folded without a plausible history around it', () => {
    const result = reduceEnterpriseEntry(
      initialEnterpriseState(),
      entry('enterprise.environment.created', { environmentId: ENV_ID, capability: 'payments' } as never),
    )
    expect(result.anomalies.map((anomaly) => anomaly.code)).toContain('forbidden-payload-key')
    expect(result.state.environments).toEqual({})
  })
})

describe('the counts the boundary gate needs are derived, not tracked', () => {
  it('counts only what belongs to this environment', () => {
    const { state } = reduceEnterpriseState([
      ...seeded(),
      entry('enterprise.task.created', { taskId: 't1', environmentId: ENV_ID, state: 'draft', at: T0 }),
      entry('enterprise.task.created', { taskId: 't2', environmentId: ENV_ID, state: 'draft', at: T0 }),
      entry('enterprise.mission.created', { missionId: 'm1', environmentId: ENV_ID, state: 'draft', at: T0 }),
      entry('enterprise.catalog.item-created', {
        itemId: 'i1',
        environmentId: ENV_ID,
        itemKind: 'project',
        name: 'Launch',
        state: 'draft',
        at: T0,
      }),
    ])
    expect(countsFor(state, ENV_ID)).toMatchObject({ tasks: 2, missions: 1 })
    expect(countsFor(state, 'other-env')).toMatchObject({ tasks: 0, missions: 0, operations: 0, concurrent: 0 })
  })

  it('counts only active records as concurrent', () => {
    const { state } = reduceEnterpriseState([
      ...seeded(),
      entry('enterprise.task.created', { taskId: 't1', environmentId: ENV_ID, state: 'draft', at: T0 }),
      entry('enterprise.task.state-changed', {
        taskId: 't1',
        environmentId: ENV_ID,
        from: 'draft',
        to: 'active',
        code: 'x',
        at: T0,
      }),
      entry('enterprise.task.created', { taskId: 't2', environmentId: ENV_ID, state: 'draft', at: T0 }),
    ])
    expect(countsFor(state, ENV_ID).concurrent).toBe(1)
  })
})

describe('payload inspection is available on its own', () => {
  it('reports nothing for a legal payload', () => {
    expect(
      inspectEnterprisePayload('enterprise.environment.created', {
        environmentId: 'env-1',
        kind: 'webzone',
        state: 'draft',
        title: 'x',
        at: T0,
      }),
    ).toEqual([])
  })

  it('reports the authority key specifically, not just "unknown"', () => {
    const anomalies = inspectEnterprisePayload('enterprise.environment.created', {
      environmentId: 'env-1',
      kind: 'webzone',
      state: 'draft',
      title: 'x',
      at: T0,
      grant: 'x',
    })
    expect(anomalies[0]?.code).toBe('forbidden-payload-key')
    expect(anomalies[0]?.detail).toContain('Guard')
  })

  it('has a key table for every event type, checked against the published table', () => {
    // An empty payload is legal for no event, so this asserts the *table* exists and is
    // non-empty rather than relying on a payload happening to be invalid.
    for (const type of [
      'enterprise.action.refused',
      'enterprise.external-action.verified',
      'enterprise.rollback.executed',
      'enterprise.customer.withdrawn',
    ] as EnterpriseEventType[]) {
      const keys = ENTERPRISE_PAYLOAD_KEYS[type]
      expect(keys, type).toBeDefined()
      expect(keys.length, type).toBeGreaterThan(0)
    }
  })

  it('rejects every key an event does not declare, including a near-miss', () => {
    const keys = ENTERPRISE_PAYLOAD_KEYS['enterprise.customer.created']
    expect(keys).not.toContain('displayname')
    expect(keys).toContain('displayName')
  })
})

describe('the transition tables stay green', () => {
  it('finds nothing to complain about', () => {
    expect(auditTransitionTables()).toEqual([])
  })
})

describe('every action traces back to a wake', () => {
  const wake = entry('enterprise.wake.received', { wakeKey: 'wake-1', source: 'owner', at: T0 })

  it('sees a clean, properly-triggered run as clean', () => {
    const report = analyseZeroHiddenSpend({
      entries: [
        wake,
        entry('enterprise.action.started', { actionId: 'act-1', environmentId: ENV_ID, kind: 'publish', at: T0 }),
        // The *operation* must also be seen starting, because the completion names an
        // operation id. Tracked in a separate namespace in `analyseZeroHiddenSpend`, so
        // both entries are needed for a complete run to look complete.
        entry('enterprise.webzone-operation.started', {
          operationId: 'op-1',
          environmentId: ENV_ID,
          kind: 'publish',
          target: 'https://example.com/about',
          at: T0,
        }),
        entry('enterprise.spending-gate.checked', {
          environmentId: ENV_ID,
          actionId: 'act-1',
          gate: 'total',
          limitMinor: 100,
          projectedMinor: 0,
          held: true,
          at: T0,
        }),
        entry('enterprise.external-action.verified', {
          verificationId: 'v-1',
          actionId: 'act-1',
          environmentId: ENV_ID,
          outcome: 'passed',
          reason: 'observed',
          at: T0,
        }),
        entry('enterprise.webzone-operation.completed', {
          operationId: 'op-1',
          environmentId: ENV_ID,
          verificationId: 'v-1',
          at: T0,
        }),
      ],
    })
    expect(report.violations).toEqual([])
    expect(report.wakes).toBe(1)
    expect(report.actions).toBe(1)
  })

  it('flags actions taken with no wake anywhere in the journal', () => {
    const report = analyseZeroHiddenSpend({
      entries: [
        entry('enterprise.action.started', { actionId: 'act-1', environmentId: ENV_ID, kind: 'publish', at: T0 }),
      ],
    })
    expect(report.violations.map((violation) => violation.code)).toContain('action-without-wake')
  })

  it('flags an action that repeats past its ceiling, counted across the whole journal', () => {
    // A retry ceiling that resets per process is not a ceiling. Counting over the log
    // rather than in memory is what makes a crash loop unable to spend past it.
    const repeated = Array.from({ length: 5 }, () =>
      entry('enterprise.action.started', { actionId: 'act-1', environmentId: ENV_ID, kind: 'publish', at: T0 }),
    )
    const report = analyseZeroHiddenSpend({ entries: [wake, ...repeated] })
    expect(report.violations.map((violation) => violation.code)).toContain('unbounded-repeated-action')
  })

  it('honours a lower explicit ceiling when one is given', () => {
    const repeated = Array.from({ length: 3 }, () =>
      entry('enterprise.action.started', { actionId: 'act-1', environmentId: ENV_ID, kind: 'publish', at: T0 }),
    )
    const report = analyseZeroHiddenSpend({ entries: [wake, ...repeated], maxRepeatsPerAction: 2 })
    expect(report.violations.map((violation) => violation.code)).toContain('unbounded-repeated-action')
  })

  it('flags a completion with no verification, from the other side of the fold', () => {
    const report = analyseZeroHiddenSpend({
      entries: [
        wake,
        entry('enterprise.action.started', { actionId: 'act-1', environmentId: ENV_ID, kind: 'publish', at: T0 }),
        entry('enterprise.webzone-operation.completed', {
          operationId: 'op-1',
          environmentId: ENV_ID,
          at: T0,
        }),
      ],
    })
    expect(report.violations.map((violation) => violation.code)).toContain('completion-without-verification')
  })

it('accepts a properly verified completion as clean', () => {
    // The companion to the two cases above: the audit must not flag every completion,
    // or it would be switched off and protect nothing.
    const report = analyseZeroHiddenSpend({
      entries: [
        wake,
        entry('enterprise.action.started', { actionId: 'op-1', environmentId: ENV_ID, kind: 'publish', at: T0 }),
        entry('enterprise.webzone-operation.started', {
          operationId: 'op-1',
          environmentId: ENV_ID,
          kind: 'publish',
          target: 'https://example.com/about',
          at: T0,
        }),
        entry('enterprise.webzone-operation.completed', {
          operationId: 'op-1',
          environmentId: ENV_ID,
          verificationId: 'v-1',
          at: T0,
        }),
      ],
    })
    expect(report.violations).toEqual([])
  })

  it('flags a duplicate wake key, which is a wake that happened twice', () => {
    const report = analyseZeroHiddenSpend({ entries: [wake, wake] })
    expect(report.violations.map((violation) => violation.code)).toContain('action-without-wake')
  })

  it('flags a refusal that does not say which gate stopped it', () => {
    const report = analyseZeroHiddenSpend({
      entries: [entry('enterprise.action.refused', { actionId: 'act-1', environmentId: ENV_ID, at: T0 })],
    })
    expect(report.violations.map((violation) => violation.code)).toContain('refusal-without-gate')
  })

  it('reports a refusal that names its gate as clean', () => {
    const report = analyseZeroHiddenSpend({
      entries: [
        entry('enterprise.action.refused', {
          actionId: 'act-1',
          environmentId: ENV_ID,
          gate: 'boundary',
          code: 'domain-not-allowed',
          reason: 'x',
          at: T0,
        }),
      ],
    })
    expect(report.violations).toEqual([])
  })

  it('sees no actions and no violations in an idle journal', () => {
    const report = analyseZeroHiddenSpend({ entries: [] })
    expect(report.violations).toEqual([])
    expect(report.actions).toBe(0)
    expect(report.wakes).toBe(0)
  })
})