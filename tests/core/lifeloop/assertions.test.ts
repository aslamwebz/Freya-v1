import { describe, expect, it } from 'vitest'
import {
  LIFE_LOOP_EVENT_TYPES,
  LIFE_LOOP_PAYLOAD_KEYS,
  ZERO_IDLE_ASSERTIONS,
  analyseZeroIdleInference,
  auditContinuationTable,
  findTimerUsageInSource,
  findUnboundedLoopInSource,
  type InferenceViolation,
  type LifeLoopJournalEntry,
} from '../../../core/lifeloop'
import { T0 } from './fixture'

function entry(type: string, payload: Record<string, unknown> = {}): LifeLoopJournalEntry {
  return { type, recordedAt: T0, payload }
}

/**
 * A wake that passed every deterministic gate, and the cognition it authorized.
 *
 * The Core payloads are the ones the envelope really carries. `cognition.requested`
 * names no grant and no provider, and `model.request.started` names the grant that
 * paid for the contact — a fixture that invented other fields would test a
 * payload Core cannot produce.
 */
function authorizedThink(): LifeLoopJournalEntry[] {
  return [
    entry('lifeloop.wake.received', { wakeId: 'w', wakeKey: 'k', iteration: 0 }),
    entry('lifeloop.filter.passed', { wakeId: 'w', wakeKey: 'k', code: 'cognition-justified', iteration: 0 }),
    entry('lifeloop.cognition.requested', { wakeId: 'w', wakeKey: 'k', iteration: 0, cognitionRequest: 1 }),
    entry('cognition.requested', { requestId: 'r1', origin: 'system', cause: 'run_finished' }),
    entry('cognition.allowed', { requestId: 'r1', grantId: 'grant-1' }),
    entry('model.request.started', { requestId: 'r1', grantId: 'grant-1', providerId: 'p1' }),
    entry('model.request.completed', { requestId: 'r1' }),
  ]
}

/** The owner's own turn: the one request that needs no wake. */
function ownerTurn(): LifeLoopJournalEntry[] {
  return [
    entry('cognition.requested', { requestId: 'r1', origin: 'user', cause: 'user_message' }),
    entry('cognition.allowed', { requestId: 'r1', grantId: null }),
    entry('model.request.started', { requestId: 'r1', grantId: null, providerId: 'p1' }),
  ]
}

describe('the eight assertions, by name', () => {
  it('are the eight the phase promised, and none of them is decorative', () => {
    expect([...ZERO_IDLE_ASSERTIONS]).toEqual([
      'noModelCallWithoutWake',
      'noContinuousPolling',
      'noHiddenReasoning',
      'noUnrestrictedLoops',
      'noAuthorityEscalation',
      'noIdleModelCall',
      'noBackgroundReasoning',
      'noHiddenDurableState',
    ])
    const report = analyseZeroIdleInference({ entries: [] })
    for (const assertion of ZERO_IDLE_ASSERTIONS) {
      expect(report.checks[assertion], assertion).toBe(true)
    }
  })

  it('holds for an empty journal, which is the state of an idle Freya', () => {
    const report = analyseZeroIdleInference({ entries: [] })
    expect(report.holds).toBe(true)
    expect(report.counted).toEqual({ cognitionRequests: 0, providerStarts: 0, wakes: 0, lifeLoopEvents: 0 })
  })

  it('holds for a properly authorized wake', () => {
    const report = analyseZeroIdleInference({ entries: authorizedThink() })
    expect(report.violations).toEqual([])
    expect(report.holds).toBe(true)
    expect(report.counted.providerStarts).toBe(1)
  })

  it("holds for the owner's own turn, which needs no wake", () => {
    // The single exemption, and it is narrow: the event says the owner asked,
    // in a turn of their own, and that a human is waiting. A request that only
    // *claims* to be from the user is not exempt.
    expect(analyseZeroIdleInference({ entries: ownerTurn() }).holds).toBe(true)
  })
})

describe('no model call without a wake', () => {
  it('catches a cognition request that nothing woke', () => {
    const report = analyseZeroIdleInference({
      entries: [entry('cognition.requested', { origin: 'system', grantId: 'g' }), entry('cognition.allowed', {})],
    })
    expect(report.holds).toBe(false)
    expect(report.checks.noModelCallWithoutWake).toBe(false)
  })

  it('catches a request that merely claims to be from the owner', () => {
    // `origin: 'user'` is not enough on its own. The request has to name a
    // message from the owner as its cause — otherwise it is Freya deciding to
    // think about something in the user's name, and that needs a wake.
    const forged = analyseZeroIdleInference({
      entries: [
        entry('cognition.requested', { requestId: 'r1', origin: 'user', cause: 'explicit_review' }),
        entry('cognition.allowed', { requestId: 'r1', grantId: null }),
      ],
    })
    expect(forged.holds).toBe(false)
    expect(forged.violations.map((v) => v.code)).toContain('model-call-without-wake')
  })

  it('catches a provider contacted with no request in the journal at all', () => {
    const report = analyseZeroIdleInference({ entries: [entry('model.request.started', { requestId: 'r1' })] })
    expect(report.holds).toBe(false)
    expect(report.checks.noModelCallWithoutWake).toBe(false)
  })

  it('catches more provider starts than requests', () => {
    // Cannot be explained by bookkeeping, so it is a finding in its own right
    // rather than a rounding discrepancy.
    const report = analyseZeroIdleInference({
      entries: authorizedThink().concat([
        entry('model.request.started', { requestId: 'r2' }),
        entry('model.request.started', { requestId: 'r3' }),
      ]),
    })
    expect(report.holds).toBe(false)
    expect(report.violations.map((v) => v.code)).toContain('model-call-without-wake')
  })
})

describe('no idle model call', () => {
  it('catches a request with no standing filter decision behind it', () => {
    // The wake arrived but nothing ever said it was worth thinking about.
    const report = analyseZeroIdleInference({
      entries: [
        entry('lifeloop.wake.received', { wakeId: 'w', wakeKey: 'k', iteration: 0 }),
        entry('cognition.requested', { origin: 'system', grantId: 'g' }),
      ],
    })
    expect(report.holds).toBe(false)
    expect(report.checks.noIdleModelCall).toBe(false)
  })

  it('catches a request made after the filter said no', () => {
    // Whatever was allowed before is no longer allowed. Without this, a loop
    // could think again on the strength of a filter that has since refused.
    const report = analyseZeroIdleInference({
      entries: [
        entry('lifeloop.wake.received', { wakeId: 'w', wakeKey: 'k', iteration: 0 }),
        entry('lifeloop.filter.passed', { wakeId: 'w', wakeKey: 'k' }),
        entry('lifeloop.filter.denied', { wakeId: 'w', wakeKey: 'k', outcome: 'deny', code: 'x' }),
        entry('cognition.requested', { origin: 'system', grantId: 'g' }),
      ],
    })
    expect(report.holds).toBe(false)
    expect(report.violations.map((v) => v.code)).toContain('model-call-while-idle')
  })

  it('catches a request made while STOP ALL was in force', () => {
    const report = analyseZeroIdleInference({
      entries: [
        entry('lifeloop.wake.received', { wakeId: 'w', wakeKey: 'k', iteration: 0 }),
        entry('lifeloop.filter.passed', { wakeId: 'w', wakeKey: 'k' }),
        entry('security.stop_all.activated', { activatedBy: 'owner' }),
        entry('cognition.requested', { origin: 'system', grantId: 'g' }),
      ],
    })
    expect(report.holds).toBe(false)
    expect(report.violations.map((v) => v.code)).toContain('model-call-while-stop-all')
  })

  it('catches a request made while the whole journal was under a latch', () => {
    const report = analyseZeroIdleInference({ entries: authorizedThink(), stopAllActive: true })
    expect(report.holds).toBe(false)
    // Which violation fired, not merely that one did. The latch path is
    // otherwise indistinguishable from any other refusal, and this input differs
    // from the clean one only in this flag.
    expect(report.violations.map((v) => v.code)).toContain('model-call-while-stop-all')
  })

  it('catches a request made after STOP ALL was activated in the journal itself', () => {
    const report = analyseZeroIdleInference({
      entries: [entry('security.stop_all.activated', { reason: 'owner' })].concat(authorizedThink()),
    })
    expect(report.violations.map((v) => v.code)).toContain('model-call-while-stop-all')
  })
})

describe('no hidden reasoning', () => {
  it('catches cognition that was allowed with no request behind it', () => {
    const report = analyseZeroIdleInference({ entries: [entry('cognition.allowed', {})] })
    expect(report.holds).toBe(false)
    expect(report.checks.noHiddenReasoning).toBe(false)
  })

  it('catches cognition that was denied with no request behind it', () => {
    const report = analyseZeroIdleInference({ entries: [entry('cognition.denied', {})] })
    expect(report.holds).toBe(false)
    expect(report.checks.noHiddenReasoning).toBe(false)
  })
})

describe('no background reasoning', () => {
  it('catches a provider contacted with no grant and no owner turn behind it', () => {
    // The Governor allows a grantless call in exactly one case: the owner asked,
    // in their own turn. `model.request.started` is where a provider is actually
    // contacted and where the grant is recorded, so that is where the rule is
    // read back off the journal.
    const report = analyseZeroIdleInference({
      entries: [
        entry('lifeloop.wake.received', { wakeId: 'w', wakeKey: 'k', iteration: 0 }),
        entry('lifeloop.filter.passed', { wakeId: 'w', wakeKey: 'k' }),
        entry('cognition.requested', { requestId: 'r1', origin: 'system', cause: 'world_changed' }),
        entry('cognition.allowed', { requestId: 'r1', grantId: null }),
        entry('model.request.started', { requestId: 'r1', grantId: null }),
      ],
    })
    expect(report.holds).toBe(false)
    expect(report.violations.map((v) => v.code)).toContain('background-call-without-grant')
    expect(report.checks.noBackgroundReasoning).toBe(false)
  })

  it('does not report a granted background call', () => {
    const report = analyseZeroIdleInference({
      entries: [
        entry('lifeloop.wake.received', { wakeId: 'w', wakeKey: 'k', iteration: 0 }),
        entry('lifeloop.filter.passed', { wakeId: 'w', wakeKey: 'k' }),
        entry('cognition.requested', { requestId: 'r1', origin: 'system', cause: 'world_changed' }),
        entry('cognition.allowed', { requestId: 'r1', grantId: 'grant-1' }),
        entry('model.request.started', { requestId: 'r1', grantId: 'grant-1' }),
      ],
    })
    expect(report.violations.map((v) => v.code)).not.toContain('background-call-without-grant')
    expect(report.holds).toBe(true)
  })
})

describe('no unrestricted loops', () => {
  it('catches a wake that acted past its action ceiling', () => {
    const events: LifeLoopJournalEntry[] = [entry('lifeloop.wake.received', { wakeId: 'w', wakeKey: 'k', iteration: 0 })]
    for (let index = 0; index < 4; index += 1) {
      events.push(entry('lifeloop.action.started', { wakeId: 'w', iteration: 0, actionIndex: index, deadlineType: 'action' }))
    }
    const report = analyseZeroIdleInference({ entries: events, limits: { maxLoopIterations: 10, maxActionsPerIteration: 2, maxVerificationsPerIteration: 64 } })
    expect(report.holds).toBe(false)
    expect(report.violations.map((v) => v.code)).toContain('loop-exceeded-action-bound')
  })

  it('catches a wake that thought more times than its iteration ceiling allows', () => {
    const events: LifeLoopJournalEntry[] = []
    for (let index = 0; index < 3; index += 1) {
      events.push(
        entry('lifeloop.wake.received', { wakeId: 'w', wakeKey: `k${index}`, iteration: index }),
        entry('cognition.requested', { origin: 'system', grantId: 'g' }),
        entry('cognition.allowed', {}),
        entry('model.request.started', { requestId: `r${index}` }),
      )
    }
    const report = analyseZeroIdleInference({ entries: events, limits: { maxLoopIterations: 1, maxActionsPerIteration: 128, maxVerificationsPerIteration: 64 } })
    expect(report.holds).toBe(false)
    expect(report.violations.map((v) => v.code)).toContain('loop-exceeded-iteration-bound')
    expect(report.violations.some((v) => v.detail.includes('over the 1 ceiling'))).toBe(true)
  })

  it('catches a continuation that rounds again past its ceiling', () => {
    const report = analyseZeroIdleInference({
      entries: [
        entry('lifeloop.wake.received', { wakeId: 'w', wakeKey: 'k', iteration: 0 }),
        entry('lifeloop.continuation.decided', { wakeId: 'w', iteration: 7, decision: 'continue' }),
      ],
      limits: { maxLoopIterations: 3, maxActionsPerIteration: 128, maxVerificationsPerIteration: 64 },
    })
    expect(report.holds).toBe(false)
    expect(report.violations.map((v) => v.code)).toContain('loop-exceeded-iteration-bound')
  })

  it('catches a wake that checked past its verification ceiling', () => {
    const events: LifeLoopJournalEntry[] = [entry('lifeloop.wake.received', { wakeId: 'w', wakeKey: 'k', iteration: 0 })]
    for (let index = 0; index < 3; index += 1) {
      events.push(entry('lifeloop.verification.started', { wakeId: 'w', iteration: 0, verificationIndex: index, deadlineType: 'verification' }))
    }
    const report = analyseZeroIdleInference({ entries: events, limits: { maxLoopIterations: 10, maxActionsPerIteration: 128, maxVerificationsPerIteration: 2 } })
    expect(report.holds).toBe(false)
    expect(report.checks.noUnrestrictedLoops).toBe(false)
    // Named specifically. Reporting an overflowed *verification* bound as an
    // action-bound violation would tell a reader the loop acted too much when it
    // checked too much, which is a different bug with a different fix.
    expect(report.violations.map((v) => v.code)).toContain('loop-exceeded-verification-bound')
    expect(report.violations.map((v) => v.code)).not.toContain('loop-exceeded-action-bound')
  })
})

describe('no authority escalation', () => {
  it('names every authority-shaped key a payload tried to carry', () => {
    // The check that actually protects the owner. A life-loop event cannot mint
    // authority, because its payload vocabulary is closed and enumerated and
    // anything shaped like a capability is refused before it reaches the journal.
    for (const key of ['capability', 'capabilities', 'grant', 'grantId', 'authority', 'verdict', 'allowed', 'token', 'secret', 'budget']) {
      const report = analyseZeroIdleInference({
        entries: [entry('lifeloop.action.started', { wakeId: 'w', iteration: 0, actionIndex: 0, deadlineType: 'action', [key]: 'x' })],
      })
      expect(report.holds, key).toBe(false)
      expect(report.checks.noAuthorityEscalation, key).toBe(false)
      expect(report.violations.map((v) => v.code), key).toContain('authority-key-in-payload')
    }
  })

  it('finds an attempt to smuggle in a whole capability list, without echoing it', () => {
    const report = analyseZeroIdleInference({
      entries: [entry('lifeloop.action.started', { wakeId: 'w', capabilities: ['browser.navigate', 'terminal.exec'] })],
    })
    expect(report.holds).toBe(false)
    const detail = report.violations.map((v) => v.detail).join(' ')
    expect(detail).toContain('capabilities')
    // The key is named; the value is not. A violation report ends up in a log
    // and in the owner's surface, and this is precisely where an attacker's
    // string must not arrive.
    expect(detail).not.toContain('browser.navigate')
    expect(detail).not.toContain('terminal.exec')
  })
})

describe('no hidden durable state', () => {
  it('catches a payload key outside the closed vocabulary', () => {
    const report = analyseZeroIdleInference({
      entries: [entry('lifeloop.wake.received', { wakeId: 'w', wakeKey: 'k', iteration: 0, transcript: 'Freya was thinking about the invoice' })],
    })
    expect(report.holds).toBe(false)
    expect(report.checks.noHiddenDurableState).toBe(false)
  })

  it('catches a long string, which is how a journal becomes a transcript', () => {
    const report = analyseZeroIdleInference({
      entries: [entry('lifeloop.wake.received', { wakeId: 'w', wakeKey: 'k', iteration: 0, thought: 'x'.repeat(400) })],
    })
    expect(report.holds).toBe(false)
    expect(report.violations.map((v) => v.code)).toContain('oversized-payload-text')
  })

  it('catches a life-loop event type that is not in the closed list', () => {
    const report = analyseZeroIdleInference({ entries: [entry('lifeloop.thought.recorded', {})] })
    expect(report.holds).toBe(false)
    expect(report.violations.map((v) => v.code)).toContain('unknown-payload-key')
  })

  it('accepts every event type the phase actually declares', () => {
    // The closed list has to be internally consistent: an event type the phase
    // promises must not be reported as unknown. Fed *populated* payloads, so the
    // closed-vocabulary check actually has keys to look at — an empty payload
    // would pass this test no matter what the vocabulary said.
    for (const type of LIFE_LOOP_EVENT_TYPES) {
      const report = analyseZeroIdleInference({ entries: [entry(type, populatedPayloadFor(type))] })
      expect(report.violations.map((v) => v.eventType), type).not.toContain(type)
      expect(report.violations, type).toEqual([])
    }
  })
})

/**
 * A payload that uses every key the type's closed vocabulary allows.
 *
 * Built from the published table rather than hand-written, so the test cannot
 * drift away from what the phase actually permits.
 */
function populatedPayloadFor(type: string): Record<string, unknown> {
  const keys = LIFE_LOOP_PAYLOAD_KEYS[type as keyof typeof LIFE_LOOP_PAYLOAD_KEYS] ?? []
  const payload: Record<string, unknown> = {}
  for (const key of keys) {
    payload[key] =
      key === 'deadlineType'
        ? 'verification'
        : key === 'outcome'
          ? 'allow'
          : key === 'code' || key === 'decision'
            ? 'cognition-justified'
            : key === 'iteration' || key.endsWith('Index') || key === 'cognitionRequest' || key === 'actionCount' || key === 'verificationCount'
              ? 0
              : 'ref'
  }
  return payload
}

describe('structural findings fold into the same verdict', () => {
  it('fails the report when the source scan found a timer', () => {
    const structural: InferenceViolation[] = [
      {
        code: 'timer-in-core',
        assertion: 'noContinuousPolling',
        eventIndex: -1,
        eventType: 'core/lifeloop/index.ts',
        detail: 'setInterval',
      },
    ]
    const report = analyseZeroIdleInference({ entries: [], structural })
    expect(report.holds).toBe(false)
    expect(report.checks.noContinuousPolling).toBe(false)
  })

  it('lists every violation rather than stopping at the first', () => {
    // "There was exactly one" and "there were forty" are different diagnoses.
    const report = analyseZeroIdleInference({
      entries: [
        entry('cognition.allowed', {}),
        entry('cognition.denied', {}),
        entry('lifeloop.thought.recorded', {}),
      ],
    })
    expect(report.violations.length).toBeGreaterThanOrEqual(3)
  })
})

describe('the structural source checks', () => {
  it('finds every way a module could poll itself', () => {
    expect(findTimerUsageInSource('setInterval(() => tick(), 1000)')).toContain('setInterval')
    expect(findTimerUsageInSource('setTimeout(() => tick(), 1000)')).toContain('setTimeout')
    expect(findTimerUsageInSource('while (true) { poll() }')).toContain('while-true')
  })

  it('does not report a word appearing in a comment', () => {
    // The comments in this very module explain why there is no `setInterval`.
    // A check that flagged its own documentation would be switched off.
    expect(findTimerUsageInSource('// there is no setInterval in Core\nexport const x = 1')).toEqual([])
    expect(findTimerUsageInSource('/* setTimeout( would be a poll */\nexport const x = 1')).toEqual([])
  })

  it('does not flag a URL that merely contains a timer name', () => {
    expect(findTimerUsageInSource("const url = 'https://example.com/setInterval'")).toEqual([])
  })

  it('finds only genuinely unbounded loops', () => {
    expect(findUnboundedLoopInSource('for (;;) { work() }')).toEqual(['for-ever'])
    expect(findUnboundedLoopInSource('while (true) { work() }')).toEqual(['while-true'])
    expect(findUnboundedLoopInSource('for (const item of items) { use(item) }')).toEqual([])
    expect(findUnboundedLoopInSource('for (let i = 0; i < limit; i += 1) { use(i) }')).toEqual([])
  })
})

describe('the state machine still satisfies its own invariants', () => {
  it('audits clean, so the assertions above are not resting on a broken table', () => {
    expect(auditContinuationTable()).toEqual([])
  })
})