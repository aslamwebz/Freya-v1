import { describe, expect, it } from 'vitest'
import {
  ENTERPRISE_EVENT_TYPES,
  ENTERPRISE_LIMITS,
  analyseZeroHiddenSpend,
  createEnterpriseRuntime,
  findCognitionEventsInVocabulary,
  inspectEnterprisePayload,
  reduceEnterpriseState,
  type EnterpriseEventType,
} from '../../../core/enterprise'
import { T0, assertNoEffect, attacker } from './harness'

/**
 * Red team: hidden inference.
 *
 * The attacks here are not about authority — they are about *this phase acting at all
 * without being asked*. A subsystem that runs on a timer spends money while the owner
 * sleeps, and no amount of correct authority-checking makes that acceptable.
 *
 * Two properties are tested, and they are different:
 *
 *   1. **Structural** — the code has no timer, no polling and no route to a model, so
 *      there is nothing to disable. Tested in `tests/core/enterprise/assertions.test.ts`
 *      against the source.
 *   2. **Behavioural** — an idle journal produces no action, and every action in the
 *      journal traces to a wake. Tested here against the runtime.
 *
 * The behavioural half is the one that catches an *algorithmic* poll — a loop that calls
 * something without a timer — which no source scan would find.
 */

describe('an idle subsystem does nothing at all', () => {
  it('performs no effect from an empty journal', () => {
    expect(analyseZeroHiddenSpend({ entries: [] })).toEqual({
      violations: [],
      wakes: 0,
      actions: 0,
    })
  })

  it('performs no effect merely from being opened', async () => {
    const attackerInstance = attacker()
    await attackerInstance.ready()
    expect(attackerInstance.effects()).toBe(0)
    expect(attackerInstance.reversals()).toBe(0)
  })

  it('performs no effect from having its state read repeatedly', async () => {
    const attackerInstance = attacker()
    await attackerInstance.ready()
    for (let index = 0; index < 25; index += 1) {
      attackerInstance.projection()
      attackerInstance.snapshot()
    }
    expect(attackerInstance.effects()).toBe(0)
  })

  it('proposes no next action when there is nothing to do', async () => {
    const attackerInstance = attacker()
    await attackerInstance.ready()
    const projection = attackerInstance.projection()
    expect(projection.nextBoundedAction).toBeNull()
  })
})

describe('this phase has no route to a model', () => {
  it('declares no event type that could record a cognition request', () => {
    expect(findCognitionEventsInVocabulary()).toEqual([])
  })

  it('declares no event type naming a provider, a token or a model', () => {
    for (const type of ENTERPRISE_EVENT_TYPES) {
      expect(type, type).not.toMatch(/model|provider|token|inference|thinking|llm/i)
    }
  })

  it('still writes a journal that contains nothing cognition-shaped', async () => {
    const attackerInstance = attacker()
    await attackerInstance.ready()
    await attackerInstance.attempt({})
    for (const type of attackerInstance.journalTypes()) {
      expect(type, type).not.toMatch(/cognition|model|provider|token|inference/i)
    }
  })
})

describe('every action traces back to a wake', () => {
  it('flags an action with no wake anywhere in the journal', () => {
    const report = analyseZeroHiddenSpend({
      entries: [
        {
          type: 'enterprise.action.started',
          recordedAt: T0,
          payload: { actionId: 'act-1', environmentId: 'env-1', kind: 'publish', at: T0 },
        },
      ],
    })
    expect(report.violations.map((violation) => violation.code)).toContain('action-without-wake')
  })

  it('sees a genuine run — wake first, then the action — as traceable', async () => {
    const attackerInstance = attacker()
    await attackerInstance.ready()
    // The wake is required. Attempting without one is the violation the previous test
    // checks for, so a "clean" run has to include it or it would not be a clean run.
    await attackerInstance.wake({ wakeKey: 'wake-1' })
    await attackerInstance.attempt({})
    expect(analyseZeroHiddenSpend({ entries: attackerInstance.entries() }).violations).toEqual([])
  })

  it('flags a genuine action performed with no wake at all', async () => {
    const attackerInstance = attacker()
    await attackerInstance.ready()
    // No wake. The action is performed — the runtime does not require a wake to have
    // been journalled — and the audit is what notices. Worth pinning: the runtime and
    // the audit are separate defences, and this is the audit doing its job alone.
    await attackerInstance.attempt({})
    const report = analyseZeroHiddenSpend({ entries: attackerInstance.entries() })
    expect(report.violations.map((violation) => violation.code)).toContain('action-without-wake')
  })

  it('records the wake before the action it authorised', async () => {
    const attackerInstance = attacker()
    await attackerInstance.ready()
    await attackerInstance.wake({ wakeKey: 'wake-1' })
    await attackerInstance.attempt({})
    const types = attackerInstance.journalTypes()
    expect(types.indexOf('enterprise.wake.received')).toBeLessThan(
      types.indexOf('enterprise.action.started'),
    )
  })

  it('refuses the same wake twice, so one authorization cannot drive two actions', async () => {
    const attackerInstance = attacker()
    await attackerInstance.ready()
    const first = await attackerInstance.wake({ wakeKey: 'wake-1' })
    expect(first.accepted).toBe(true)
    const second = await attackerInstance.wake({ wakeKey: 'wake-1' })
    expect(second.accepted).toBe(false)
    // And a replayed journal does not leave a wake that could be counted twice.
    expect(
      analyseZeroHiddenSpend({ entries: attackerInstance.entries() }).violations,
    ).toEqual([])
  })

  it('flags a duplicate wake key planted in a journal', () => {
    const entries = [
      { type: 'enterprise.wake.received', recordedAt: T0, payload: { wakeKey: 'w', source: 'owner', at: T0 } },
      { type: 'enterprise.wake.received', recordedAt: T0, payload: { wakeKey: 'w', source: 'owner', at: T0 } },
    ]
    expect(analyseZeroHiddenSpend({ entries }).violations.map((v) => v.code)).toContain(
      'action-without-wake',
    )
  })
})

describe('an action cannot repeat past its ceiling', () => {
  it('flags five starts of one action, past the phase ceiling of three', () => {
    const entries = [
      { type: 'enterprise.wake.received', recordedAt: T0, payload: { wakeKey: 'w', source: 'owner', at: T0 } },
      ...Array.from({ length: 5 }, () => ({
        type: 'enterprise.action.started',
        recordedAt: T0,
        payload: { actionId: 'act-1', environmentId: 'env-1', kind: 'publish', at: T0 },
      })),
    ]
    const report = analyseZeroHiddenSpend({ entries })
    expect(report.violations.map((violation) => violation.code)).toContain('unbounded-repeated-action')
  })

  it('counts repeats across the whole journal, so a crash loop cannot spend past it', () => {
    // A ceiling held in memory resets on every restart. Counted over the log, it does
    // not — which is why this reads the journal rather than the runtime's counters.
    const entries = [
      { type: 'enterprise.wake.received', recordedAt: T0, payload: { wakeKey: 'w', source: 'owner', at: T0 } },
      ...Array.from({ length: 4 }, () => ({
        type: 'enterprise.action.started',
        recordedAt: T0,
        payload: { actionId: 'act-1', environmentId: 'env-1', kind: 'publish', at: T0 },
      })),
    ]
    expect(analyseZeroHiddenSpend({ entries }).violations).not.toEqual([])
    expect(analyseZeroHiddenSpend({ entries, maxRepeatsPerAction: 10 }).violations).toEqual([])
  })
})

describe('an unverified action is never recorded as complete', () => {
  it('performs the effect but records failure when the effect did not happen', async () => {
    const attackerInstance = attacker({ effectHolds: false })
    await attackerInstance.ready()
    const result = await attackerInstance.attempt({})
    expect(result.performed).toBe(true)
    expect(result.journalTypes).toContain('enterprise.webzone-operation.failed')
    expect(result.journalTypes).not.toContain('enterprise.webzone-operation.completed')
  })

  it('plants a completion without a verification and has the fold refuse it', () => {
    // The attack that matters: the *record* claims success. The fold is the last line,
    // because a runtime bug and a journal edit both arrive here.
    const state = reduceEnterpriseState([
      {
        type: 'enterprise.environment.created',
        recordedAt: T0,
        payload: { environmentId: 'env-1', kind: 'webzone', state: 'draft', title: 'S', at: T0 },
      },
      {
        type: 'enterprise.webzone-operation.started',
        recordedAt: T0,
        payload: { operationId: 'op-1', environmentId: 'env-1', kind: 'publish', target: 'https://example.com/', at: T0 },
      },
      {
        type: 'enterprise.webzone-operation.completed',
        recordedAt: T0,
        payload: { operationId: 'op-1', environmentId: 'env-1', at: T0 },
      },
    ])
    expect(state.anomalies.map((anomaly) => anomaly.code)).toContain('malformed-payload')
    expect(state.state.operations['op-1']?.state).toBe('active')
  })

  it('plants an empty verification id and has the fold refuse it too', () => {
    const state = reduceEnterpriseState([
      {
        type: 'enterprise.environment.created',
        recordedAt: T0,
        payload: { environmentId: 'env-1', kind: 'webzone', state: 'draft', title: 'S', at: T0 },
      },
      {
        type: 'enterprise.webzone-operation.started',
        recordedAt: T0,
        payload: { operationId: 'op-1', environmentId: 'env-1', kind: 'publish', target: 'https://example.com/', at: T0 },
      },
      {
        type: 'enterprise.webzone-operation.completed',
        recordedAt: T0,
        payload: { operationId: 'op-1', environmentId: 'env-1', verificationId: '', at: T0 },
      },
    ])
    expect(state.state.operations['op-1']?.state).toBe('active')
  })

  it('flags a completion that never started', () => {
    const report = analyseZeroHiddenSpend({
      entries: [
        { type: 'enterprise.wake.received', recordedAt: T0, payload: { wakeKey: 'w', source: 'owner', at: T0 } },
        {
          type: 'enterprise.webzone-operation.completed',
          recordedAt: T0,
          payload: { operationId: 'op-1', environmentId: 'env-1', verificationId: 'v-1', at: T0 },
        },
      ],
    })
    expect(report.violations.length).toBeGreaterThan(0)
  })
})

describe('a refusal is always recorded, never swallowed', () => {
  it('journals a refusal naming the gate that stopped it', async () => {
    const attackerInstance = attacker()
    await attackerInstance.ready()
    const result = await attackerInstance.attempt({ target: 'https://evil.test/' })
    const refusal = attackerInstance.journalOfType('enterprise.action.refused')
    expect(refusal).not.toBeNull()
    expect(refusal?.gate).toBe('boundary')
    expect(String(refusal?.code)).toBeTruthy()
    assertNoEffect(result)
  })

  it('journals a refused wake, naming why', async () => {
    const attackerInstance = attacker()
    await attackerInstance.ready()
    await attackerInstance.wake({ source: 'renderer', actor: 'owner' })
    const denial = attackerInstance.journalOfType('enterprise.wake.denied')
    expect(denial).not.toBeNull()
    expect(String(denial?.code)).toBeTruthy()
  })

  it('never records a refusal without naming a gate', async () => {
    const attackerInstance = attacker()
    await attackerInstance.ready()
    for (const attempt of [
      { target: 'https://evil.test/' },
      { claimsAction: 'real-money-transfer' },
      { amountMinor: 99_999 },
      { consequential: true },
    ]) {
      const result = await attackerInstance.attempt(attempt)
      if (result.performed) continue
      const refusal = attackerInstance.journalOfType('enterprise.action.refused')
      expect(String(refusal?.gate)).toBeTruthy()
    }
  })
})

describe('the phase writes nothing outside its own vocabulary', () => {
  it('writes only event types it declares, and each validates', async () => {
    const attackerInstance = attacker()
    await attackerInstance.ready()
    await attackerInstance.wake({})
    await attackerInstance.attempt({})
    await attackerInstance.seekApproval({})

    for (const type of attackerInstance.journalTypes()) {
      expect(ENTERPRISE_EVENT_TYPES, type).toContain(type)
      const payload = attackerInstance.journalOfType(type)
      expect(inspectEnterprisePayload(type as EnterpriseEventType, payload ?? {}), type).toEqual([])
    }
  })

  it('keeps every payload value inside the journal text bound', async () => {
    const attackerInstance = attacker()
    await attackerInstance.ready()
    await attackerInstance.seekApproval({ reasoning: 'x'.repeat(500) })
    for (const entry of attackerInstance.entries()) {
      for (const [key, value] of Object.entries(entry.payload ?? {})) {
        if (typeof value === 'string') {
          expect(value.length, `${entry.type}/${key}`).toBeLessThanOrEqual(
            ENTERPRISE_LIMITS.maxPayloadTextLength,
          )
        }
      }
    }
  })
})

describe('a stopped or disabled subsystem cannot be driven by repetition', () => {
  it('performs nothing however many attempts are made while stopped', async () => {
    const attackerInstance = attacker({ stopAll: true })
    await attackerInstance.ready()
    for (let index = 0; index < 10; index += 1) {
      const result = await attackerInstance.attempt({ actionId: `act-${index}` })
      expect(result.performed).toBe(false)
      assertNoEffect(result)
    }
    expect(attackerInstance.effects()).toBe(0)
  })

  it('performs nothing however many attempts are made while disabled', async () => {
    const attackerInstance = attacker({ enabled: false })
    await attackerInstance.ready()
    for (let index = 0; index < 10; index += 1) {
      const result = await attackerInstance.attempt({ actionId: `act-${index}` })
      expect(result.performed).toBe(false)
      assertNoEffect(result)
    }
    expect(attackerInstance.effects()).toBe(0)
  })

  it('refuses to act at all on a journal that becomes untrustworthy mid-run', async () => {
    // Not at open — the environment opened fine, then the journal was marked corrupt. The
    // flag is read at every gate, so the running environment notices.
    const attackerInstance = attacker()
    await attackerInstance.ready()
    attackerInstance.setJournalTrustworthy(false)
    const result = await attackerInstance.attempt({})
    expect(result.performed).toBe(false)
    expect(result.code).toBe('journal-untrustworthy')
    assertNoEffect(result)
  })
})

describe('a runtime with no trustworthy journal refuses to open', () => {
  it('throws rather than opening and repairing', async () => {
    // Refused rather than opened-and-repaired. A repair on startup is a place where an
    // unreadable record quietly becomes a believed one, and the whole phase is built on
    // the opposite claim.
    const h = attacker({ stopAll: true, enabled: false, journalTrustworthy: false, effectHolds: false })
    const runtime = createEnterpriseRuntime({ ports: h.ports })
    await expect(runtime.open()).rejects.toThrow(/cannot be believed/)
    expect(h.effects()).toBe(0)
    expect(h.reversals()).toBe(0)
  })

  it('performs no effect even when the refuse-on-open is bypassed by an explicit opt-out', async () => {
    // The opt-out exists for a future migration. Even with it, the *gate* still refuses,
    // so a misconfigured integration that skipped the open check performs nothing.
    const h = attacker({ journalTrustworthy: false, effectHolds: false })
    const runtime = createEnterpriseRuntime({
      ports: h.ports,
      requireTrustworthyJournal: false,
    })
    await runtime.open()
    const result = await runtime.performAction({
      actionId: 'act-1',
      environmentId: 'env-1',
      kind: 'publish',
      target: 'https://example.com/about',
      payload: 'hello',
      consequential: false,
      amountMinor: 0,
      currency: 'USD',
      claimsAction: null,
      performed: false,
      at: T0,
    })
    expect(result.performed).toBe(false)
    expect(result.code).toBe('journal-untrustworthy')
    expect(h.effects()).toBe(0)
  })
})