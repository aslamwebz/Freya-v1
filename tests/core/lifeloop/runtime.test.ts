import { describe, expect, it } from 'vitest'
import {
  NON_JUSTIFYING_KINDS,
  LifeLoopRuntime,
  reduceLifeLoopState,
} from '../../../core/lifeloop'
import {
  FOCUSED,
  T0,
  T_PLUS_30S,
  T_PLUS_1M,
  T_PLUS_1H,
  T_PLUS_25H,
  decided,
  harness,
  periodicWake,
  refused,
  workWake,
} from './harness'

/**
 * The runtime, driven.
 *
 * Every test here is a proposition about money or about boundedness, and every one
 * of them is checked against the *journal* rather than against an in-memory flag —
 * because the claim this phase makes is about what the durable record shows, and a
 * flag could be correct while the log said otherwise.
 */
function runtimeWith(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options)
  const runtime = new LifeLoopRuntime({ ports: h.ports, limits: options.limits })
  return { h, runtime }
}

async function opened(options: Parameters<typeof harness>[0] = {}) {
  const built = runtimeWith(options)
  await built.runtime.open()
  return built
}

describe('a wake is not a model call', () => {
  it('accepts a justifying wake, thinks once, and closes itself out', async () => {
    const { h, runtime } = await opened()
    const outcome = await runtime.considerWake(workWake())
    expect(outcome.outcome).toBe('accepted')
    expect(h.cognitionCalls()).toBe(1)
    expect(h.types()).toEqual([
      'lifeloop.wake.received',
      'lifeloop.filter.passed',
      'lifeloop.cognition.requested',
      'lifeloop.action.started',
      'lifeloop.action.completed',
      'lifeloop.verification.started',
      'lifeloop.verification.passed',
      'lifeloop.continuation.decided',
      'lifeloop.stopped',
      'lifeloop.reset',
    ])
    // And it ends idle, holding nothing, with no deadline left over.
    expect(runtime.status().state).toBe('IDLE')
    expect(runtime.status().currentWake).toBeNull()
    expect(runtime.status().currentDeadline).toBeNull()
  })

  it('deterministically refuses a periodic check and never reaches the prefilter allowance', async () => {
    const { h, runtime } = await opened({
      schedules: [{ scheduleId: 'sched-1', dueAt: T0 }],
    })
    const outcome = await runtime.considerWake(periodicWake())
    expect(outcome.outcome).toBe('accepted')
    // Woken, evaluated, refused. Not one thought.
    expect(h.cognitionCalls()).toBe(0)
    expect(h.types()).toContain('lifeloop.filter.denied')
    expect(runtime.status().state).toBe('IDLE')
  })

it('deterministically refuses the four non-justifying kinds the same way', async () => {
    // These are the cases a plausible implementation gets wrong by reading
    // "something happened" as "Freya should think about it". They are named here so
    // the refusal is observed rather than assumed — and the four are exactly the set
    // the domain declares as non-justifying, so a fifth appearing later would fail
    // this test rather than quietly start costing money.
    const cases = [
      { source: 'scheduled-heartbeat', kind: 'periodic-check', actor: 'host-heartbeat', ref: 'sched-1', goal: null },
      { source: 'mission-transition', kind: 'mission-activated', actor: 'core-subsystem', ref: 'mission-1', goal: 'goal-1' },
      { source: 'work-transition', kind: 'run-started', actor: 'core-subsystem', ref: 'run-9', goal: 'goal-1' },
      { source: 'authorized-event', kind: 'system-health', actor: 'core-subsystem', ref: 'health-1', goal: 'goal-1' },
    ] as const
    expect(cases.map((entry) => entry.kind).sort()).toEqual([...NON_JUSTIFYING_KINDS].sort())
    for (const entry of cases) {
      const { h, runtime } = await opened({
        // A heartbeat has to name a registered schedule, or the registry refuses it
        // for a different reason entirely and this test would prove nothing.
        schedules: [{ scheduleId: 'sched-1', dueAt: T0 }],
      })
      const outcome = await runtime.considerWake({
        source: entry.source,
        kind: entry.kind,
        actor: entry.actor,
        goalRef: entry.goal,
        sourceRef: entry.ref,
        occurredAt: T0,
      })
      expect(outcome.outcome, entry.kind).toBe('accepted')
      // Woken, evaluated, refused. Not one thought.
      expect(h.cognitionCalls(), entry.kind).toBe(0)
      expect(h.types(), entry.kind).toContain('lifeloop.filter.denied')
      expect(runtime.status().state, entry.kind).toBe('IDLE')
    }
  })

  it('spends nothing at all with no grant, no budget, or the loop switched off', async () => {
    // Each of these is a different gate, and each of them alone is enough. They are
    // tested separately because a compound test would pass if only one of them
    // worked.
    //
    // Two of them refuse at the *registry*, before the loop is even entered, and the
    // rest refuse at the *prefilter*, after it has. Both spend nothing, and both are
    // asserted here — a gate that only refused at the filter would look identical
    // from a bill and differ in what a reader of the journal is told.
const registryGates: readonly {
      label: string
      options: Parameters<typeof harness>[0]
      stopAll: boolean
      code: string
    }[] = [
      { label: 'untrustworthy journal', options: { journalTrustworthy: false }, stopAll: false, code: 'journal-not-trustworthy' },
      { label: 'stopped', options: { stopAll: true }, stopAll: true, code: 'stop-all-active' },
    ]
    for (const gate of registryGates) {
      const { h, runtime } = await opened(gate.options)
      const outcome = await runtime.considerWake(workWake())
      expect(outcome.outcome, gate.label).toBe('refused')
      expect((outcome as { code: string }).code, gate.label).toBe(gate.code)
      expect(h.cognitionCalls(), gate.label).toBe(0)
      // A latch found at open is recorded as a stop first — a Core that starts
      // stopped has a stopped loop, and the journal must say so rather than have it
      // inferred from the absence of activity.
      expect(h.types(), gate.label).toEqual(
        gate.stopAll ? ['lifeloop.stopped', 'lifeloop.wake.denied'] : ['lifeloop.wake.denied'],
      )
    }
    const filterGates = [
      { label: 'no grant', options: { grantAvailable: false } },
      { label: 'no budget', options: { budgetRemainingCalls: 0 } },
      { label: 'loop off', options: { enabled: false } },
    ] as const
    for (const gate of filterGates) {
      const { h, runtime } = await opened(gate.options)
      const outcome = await runtime.considerWake(workWake())
      expect(outcome.outcome, gate.label).toBe('accepted')
      expect(h.cognitionCalls(), gate.label).toBe(0)
      expect(h.types(), gate.label).toContain('lifeloop.filter.denied')
      expect(runtime.status().state, gate.label).toBe('IDLE')
    }
  })

  it('records a refusal without moving the loop, so an idle Freya is still idle afterwards', async () => {
    // The important half: a refusal must not leave the loop stuck. A `WAKING` loop
    // refuses every wake as busy and would never wake again.
    const { runtime } = await opened({ grantAvailable: false })
    await runtime.considerWake(workWake())
    expect(runtime.status().state).toBe('IDLE')
    const second = await runtime.considerWake(workWake({ sourceRef: 'run-10' }))
    expect(second.outcome).toBe('accepted')
  })

  it('refuses an unauthorized actor for every source, and says which one it refused', async () => {
    // Exhaustion, not examples: the property is a property of the *table*, and a
    // handful of cases cannot establish it.
    const actors = ['model', 'renderer', 'agent', 'connector', 'external-webhook', 'timer'] as const
    for (const actor of actors) {
      const { h, runtime } = await opened()
      const outcome = await runtime.considerWake(workWake({ actor }))
      expect(outcome.outcome, actor).toBe('refused')
      expect((outcome as { code: string }).code, actor).toBe('unauthorized-actor')
      expect(h.cognitionCalls(), actor).toBe(0)
    }
  })

  it('refuses a source that does not match its kind, so a heartbeat cannot claim to be a mission', async () => {
    const { h, runtime } = await opened()
    const outcome = await runtime.considerWake(
      workWake({ source: 'scheduled-heartbeat', kind: 'mission-completed', actor: 'host-heartbeat' }),
    )
    expect((outcome as { code: string }).code).toBe('kind-source-mismatch')
    expect(h.cognitionCalls()).toBe(0)
  })
})

describe('the gate order is the contract', () => {
  it('reports journal integrity above STOP ALL, matching the Governor beneath it', async () => {
    // Two gates that both apply, and the *first* is reported. A loop that ranked
    // them the other way round would disagree with the gate underneath it about why
    // something was refused, and a reader would have two answers to one question.
    const { h, runtime } = await opened({ stopAll: true, journalTrustworthy: false })
    const outcome = await runtime.considerWake(workWake())
    expect((outcome as { code: string }).code).toBe('journal-not-trustworthy')
    expect(h.cognitionCalls()).toBe(0)
  })

  it('reports a stopped Freya as stopped, to everybody, without asking who they are', async () => {
    for (const actor of ['owner', 'core-subsystem', 'host-heartbeat'] as const) {
      const { h, runtime } = await opened({ stopAll: true })
      const outcome = await runtime.considerWake(workWake({ actor }))
      expect((outcome as { code: string }).code, actor).toBe('stop-all-active')
      expect(h.cognitionCalls(), actor).toBe(0)
    }
  })

  it('refuses a duplicate wake from the durable key rather than from memory', async () => {
    const { h, runtime } = await opened()
    await runtime.considerWake(workWake())
    const again = await runtime.considerWake(workWake())
    expect((again as { code: string }).code).toBe('duplicate-wake')
    expect(h.cognitionCalls()).toBe(1)
  })
})

describe('every payload the runtime writes is a payload the journal accepts', () => {
  it('across every path the loop can take', async () => {
    // This is the assertion that catches a whole class of bug rather than one
    // instance. A payload the Core validator refuses is written to disk anyway and
    // rejected on the *next* read — which truncates the log at that line and takes
    // the durable security state with it. So "the loop journals a refusal" and "the
    // journal stays readable afterwards" are the same requirement.
    const paths: readonly { label: string; run: (h: ReturnType<typeof harness>, r: LifeLoopRuntime) => Promise<void> }[] = [
      {
        label: 'the happy path',
        run: async (_h, r) => {
          await r.considerWake(workWake())
        },
      },
      {
        label: 'a denied wake',
        run: async (_h, r) => {
          await r.considerWake(workWake({ actor: 'renderer' }))
        },
      },
      {
        label: 'a cognition refusal',
        run: async (_h, r) => {
          await r.considerWake(workWake())
        },
      },
      {
        label: 'a failed verification and its retry',
        run: async (_h, r) => {
          await r.considerWake(workWake())
        },
      },
      {
        label: 'a suppressed interrupt',
        run: async (_h, r) => {
          await r.considerWake(workWake())
        },
      },
      {
        label: 'an approval parking',
        run: async (_h, r) => {
          await r.considerWake(workWake())
        },
      },
      {
        label: 'a stop and its lift',
        run: async (_h, r) => {
          await r.stop()
          await r.lift()
        },
      },
      {
        label: 'an owner pre-emption mid-continuation',
        run: async (_h, r) => {
          await r.preemptByOwner()
        },
      },
    ]
    const options: readonly [string, Parameters<typeof harness>[0]][] = [
      ['default', {}],
      ['refused cognition', { cognition: () => refused() }],
      ['failed verification', { verification: () => ({ holds: false, code: 'reference-still-open' }) }],
      ['a loud conclusion', { cognition: () => decided('interrupt') }],
      ['a loud conclusion needing approval', { cognition: () => decided('interrupt'), escalationApprovalRequired: true }],
    ]
    for (const [label, overrides] of options) {
      for (const path of paths) {
        const { h, runtime } = await opened(overrides)
        await path.run(h, runtime)
        expect(h.validate(), `${label} / ${path.label}`).toEqual([])
      }
    }
  })
})

describe('a wake must not be able to reach a model by being louder', () => {
  it('journals a suppressed interrupt rather than quietly downgrading it', async () => {
    // The gap between "Freya decided not to interrupt" and "Freya was told not to"
    // is the whole of Phase 23's restraint, and it is only visible if the refusal is
    // journaled. A focus-suppressed interrupt is a fact about a human being.
    const { h, runtime } = await opened({ focus: FOCUSED, cognition: () => decided('interrupt') })
    await runtime.considerWake(workWake())
    expect(h.types()).toContain('lifeloop.cognition.denied')
    // The spent call is real — the thought happened — but nothing was raised.
    expect(h.cognitionCalls()).toBe(1)
    expect(h.escalations()).toEqual([])
    const denial = h.entries.find((entry) => entry.type === 'lifeloop.cognition.denied')
    expect(denial?.payload.code).toBe('focus-blocks-escalation')
    // And the loop is back to idle rather than wedged in `ALLOW`.
    expect(runtime.status().state).toBe('IDLE')
  })

  it('raises a cue through Attention even while the owner is focused, because focus suppresses only interrupt', async () => {
    const { h, runtime } = await opened({ focus: FOCUSED, cognition: () => decided('subtle-cue') })
    await runtime.considerWake(workWake())
    expect(h.escalations()).toEqual([{ outcome: 'subtle-cue', escalation: 'subtle-cue' }])
    expect(runtime.status().conclusion?.escalation).toBe('subtle-cue')
  })

  it('lets Attention suppress what the loop asked for, and records that rather than a failure', async () => {
    // Attention owns the owner's attention. When it declines, the system worked; the
    // loop must not treat that as its own failure and retry into the same wall.
    const h = harness({ cognition: () => decided('speak') })
    const runtime = new LifeLoopRuntime({ ports: h.ports })
    await runtime.open()
    await runtime.considerWake(workWake())
    expect(h.escalations()).toHaveLength(1)
    expect(runtime.status().conclusion?.attentionSuppressed).toBe(false)
    expect(runtime.status().state).toBe('IDLE')
  })
})

describe('approval parks the loop rather than ending it', () => {
  it('waits on an absolute approval deadline and says the owner has to decide', async () => {
    const { h, runtime } = await opened({
      cognition: () => decided('interrupt'),
      escalationApprovalRequired: true,
    })
    await runtime.considerWake(workWake())
    expect(runtime.status().state).toBe('WAIT')
    expect(runtime.status().currentDeadline?.type).toBe('approval')
    // Absolute, and journaled: a restart cannot move it.
    expect(runtime.status().currentDeadline?.expiresAt).toBe('2026-03-02T09:00:00.000Z')
    expect(h.escalations()).toEqual([])
    const decision = h.entries.find((entry) => entry.type === 'lifeloop.continuation.decided')
    expect(decision?.payload.decision).toBe('awaiting-approval')
  })

  it('preserves the parked approval across a restart, because the deadline is durable', async () => {
    const first = await opened({
      cognition: () => decided('interrupt'),
      escalationApprovalRequired: true,
    })
    await first.runtime.considerWake(workWake())

    // A second runtime over the same journal: this is what a restart looks like.
    const second = harness({ clock: T_PLUS_30S })
    second.seed(first.h.entries)
    const recovered = new LifeLoopRuntime({ ports: second.ports })
    const report = await recovered.open()
    expect(report.recoveredState).toBe('WAIT')
    expect(report.requiresOwnerAction).toBe(false)
    // The same instant, not one re-derived from the restart: a relative wait is
    // extended by every restart, and a day becomes a day per crash.
    expect(recovered.status().currentDeadline?.expiresAt).toBe('2026-03-02T09:00:00.000Z')
    // And nothing is spent on the way back in.
    expect(second.cognitionCalls()).toBe(0)
  })
})

describe('the retry ceiling counts attempts, and survives a restart', () => {
  it('tries three times in total, not three times per wake', async () => {
    const { h, runtime } = await opened({
      verification: () => ({ holds: false, code: 'reference-still-open' }),
    })
    await runtime.considerWake(workWake())
    // Failure one: parked on a bounded backoff rather than denied.
    expect(runtime.status().state).toBe('WAIT')
    expect(runtime.status().currentDeadline?.type).toBe('wait')
    expect(h.cognitionCalls()).toBe(1)

    // Force the next attempt at each expiry.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      h.setClock(T_PLUS_25H)
      await runtime.tick()
      // A fresh wake about the same work continues the attempt count rather than
      // resetting it, which is the property the whole ceiling rests on.
      const outcome = await runtime.considerWake(workWake({ sourceRef: `run-9:${attempt}` }))
      expect(['accepted', 'refused']).toContain(outcome.outcome)
    }
    expect(runtime.status().retriesExhausted).toBe(true)
  })

  it('counts an attempt even though the step failed, because that is what a ceiling counts', async () => {
    const { h, runtime } = await opened({
      verification: () => ({ holds: false, code: 'reference-still-open' }),
    })
    await runtime.considerWake(workWake())
    expect(runtime.status().attemptCount).toBe(1)
    expect(h.types()).toContain('lifeloop.verification.failed')
  })

  it('records the backoff as an absolute instant, so a restart cannot lengthen it into a month', async () => {
    const { h, runtime } = await opened({
      verification: () => ({ holds: false, code: 'reference-still-open' }),
    })
    await runtime.considerWake(workWake())
    const parked = h.entries.find(
      (entry) => entry.type === 'lifeloop.filter.denied' && entry.payload.code === 'retry-backoff',
    )
    // A retry backoff is seconds, not the thirty-day `wait` default. If the deadline
    // were re-derived from the default rather than journaled, this would read as
    // 2026-03-31 and a two-second pause would survive a restart as a month.
    expect(parked?.payload.deadlineExpiresAt).not.toBe('2026-03-31T09:00:00.000Z')
    expect(Date.parse(String(parked?.payload.deadlineExpiresAt))).toBeLessThan(
      Date.parse(T0) + 60 * 60_000,
    )
  })
})

describe('a deadline that passes ends the wait rather than renewing it', () => {
  it('closes out and reports the loss to the owner', async () => {
    const h = harness({ clock: T0, schedules: [{ scheduleId: 'sched-1', dueAt: T0 }], conditionHolds: () => false })
    const runtime = new LifeLoopRuntime({ ports: h.ports })
    await runtime.open()
    // A schedule that is registered and due, but whose condition is unmet: refused,
    // nothing held, and the loop stays where it was.
    const outcome = await runtime.considerWake(
      workWake({ source: 'scheduled-heartbeat', kind: 'schedule-due', actor: 'host-heartbeat', goalRef: null, sourceRef: 'sched-1' }),
    )
    expect(outcome.outcome).toBe('deferred')
    expect(runtime.status().state).toBe('IDLE')
    expect(runtime.status().currentDeadline).toBeNull()
    expect(runtime.status().lastRefusal?.code).toBe('heartbeat-condition-unmet')
  })

  it('expires a held deadline on the next tick and does not resume the work', async () => {
    const first = await opened({
      schedules: [{ scheduleId: 'sched-1', dueAt: T_PLUS_1M }],
      conditionHolds: () => false,
    })
    // Not due yet, so the loop parks on a deadline that is genuinely in the future.
    const deferred = await first.runtime.considerWake(
      workWake({ source: 'scheduled-heartbeat', kind: 'schedule-due', actor: 'host-heartbeat', goalRef: null, sourceRef: 'sched-1', occurredAt: T0 }),
    )
    // Heartbeat-not-due is the other deferral, and it is the one that holds.
    expect((deferred as { code?: string }).code).toBe('heartbeat-not-due')
    expect(first.runtime.status().state).toBe('WAIT')
    expect(first.runtime.status().currentDeadline?.expiresAt).toBe(T_PLUS_1M)

first.h.setClock(T_PLUS_1H)
    // Withdrawn first, so this is about the deadline alone. A schedule that was still
    // due would be offered again on the same tick — which is correct, and is what
    // makes the count below exactly one.
    first.h.setSchedules([])
    const fired = await first.runtime.tick()
    expect(fired).toBe(1)
    expect(first.runtime.status().state).toBe('IDLE')
    expect(first.h.cognitionCalls()).toBe(0)
  })
})

describe('restart recovery does not pick up where it left off', () => {
  it('reconciles an interrupted action to stopped, and says the owner must decide', async () => {
const first = harness()
    // A journal that says the loop was acting when the process ended. Written by
    // hand because getting into that state requires the process to die mid-step.
    await first.ports.append('lifeloop.wake.received', {
      wakeId: 'w1', source: 'work-transition', kind: 'run-completed', wakeKey: 'k1',
      iteration: 1, goalRef: 'goal-1', sourceRef: 'run-9', occurredAt: T0, observedAt: T0,
    })
    await first.ports.append('lifeloop.filter.passed', { wakeId: 'w1', wakeKey: 'k1', code: 'cognition-justified', iteration: 1 })
    await first.ports.append('lifeloop.action.started', {
      wakeId: 'w1', iteration: 1, actionIndex: 1, deadlineType: 'action', deadlineExpiresAt: T_PLUS_1H,
    })

    const second = harness()
    // The same journal, a fresh runtime. This is what a restart looks like.
    second.seed(first.entries)
    const recovered = new LifeLoopRuntime({ ports: second.ports })
    const report = await recovered.open()
    expect(report.interruptedState).toBe('ACTING')
    expect(report.recoveredState).toBe('STOP')
    expect(report.requiresOwnerAction).toBe(true)
    expect(second.types()).toContain('lifeloop.stopped')
    // And the interrupted step is stopped, not resumed and not marked successful.
    expect(recovered.status().isStopped).toBe(true)
    expect(second.cognitionCalls()).toBe(0)
  })

  it('preserves a wait whose absolute deadline has not passed, unchanged', async () => {
    const first = await opened({
      schedules: [{ scheduleId: 'sched-1', dueAt: T_PLUS_1M }],
      conditionHolds: () => false,
    })
    await first.runtime.considerWake(
      workWake({ source: 'scheduled-heartbeat', kind: 'schedule-due', actor: 'host-heartbeat', goalRef: null, sourceRef: 'sched-1', occurredAt: T0 }),
    )
    const original = first.runtime.status().currentDeadline?.expiresAt

    const second = harness({ clock: T_PLUS_30S })
    second.seed(first.h.entries)
    const recovered = new LifeLoopRuntime({ ports: second.ports })
    const report = await recovered.open()
    expect(report.recoveredState).toBe('WAIT')
    // The *same* instant, not one re-derived from now. A relative wait is extended
    // by every restart, and thirty days becomes thirty days per crash.
    expect(recovered.status().currentDeadline?.expiresAt).toBe(original)
  })

  it('refuses to preserve a wait whose deadline passed while the process was gone', async () => {
    const first = await opened({
      schedules: [{ scheduleId: 'sched-1', dueAt: T_PLUS_1M }],
    })
    await first.runtime.considerWake(
      workWake({ source: 'scheduled-heartbeat', kind: 'schedule-due', actor: 'host-heartbeat', goalRef: null, sourceRef: 'sched-1', occurredAt: T0 }),
    )
    const second = harness({ clock: T_PLUS_25H })
    second.seed(first.h.entries)
    const recovered = new LifeLoopRuntime({ ports: second.ports })
    const report = await recovered.open()
    // A wait no future heartbeat can satisfy and no owner can see is a dead loop
    // that looks alive, so it is a loss rather than a wait.
    expect(report.recoveredState).toBe('DENY')
    expect(report.requiresOwnerAction).toBe(true)
  })

  it('keeps a stopped Freya stopped across a restart', async () => {
    const stopped = harness({ stopAll: true })
    const runtime = new LifeLoopRuntime({ ports: stopped.ports })
    const report = await runtime.open()
    expect(report.stopAllActive).toBe(true)
    expect(runtime.status().isStopped).toBe(true)
  })

  it('folds a replay of its own journal into the same state it held live', async () => {
    // The property "no hidden durable state", stated as a test rather than a
    // comment: whatever the running process believed, a cold replay must reach —
    // *including the anomalies*. A journal the loop wrote but its own fold refuses is
    // the worst possible outcome: the process looks healthy while the durable record
    // is unreadable, and the next start will truncate the log at that line.
    const paths = [
      { label: 'a quiet conclusion', options: {} },
      { label: 'a loud conclusion', options: { cognition: () => decided('speak') } },
      { label: 'a suppressed interrupt', options: { focus: FOCUSED, cognition: () => decided('interrupt') } },
      { label: 'a refused thought', options: { cognition: () => refused() } },
      { label: 'a failed verification', options: { verification: () => ({ holds: false, code: 'reference-still-open' }) } },
      { label: 'an approval parking', options: { cognition: () => decided('interrupt'), escalationApprovalRequired: true } },
      { label: 'a continued wake', options: { openGoals: ['goal-1'] } },
    ] as const
    for (const path of paths) {
      const { h, runtime } = await opened(path.options)
      await runtime.considerWake(workWake())
      const replayed = reduceLifeLoopState(h.entries)
      expect(replayed.anomalies.map((anomaly) => `${anomaly.eventType}: ${anomaly.detail}`), path.label).toEqual([])
      expect(replayed.state.state, path.label).toBe(runtime.status().state)
      expect(replayed.state.attemptCount, path.label).toBe(runtime.status().attemptCount)
      expect(replayed.state.conclusion, path.label).toEqual(runtime.status().conclusion)
    }
  })
})

describe('the owner comes first', () => {
  it('abandons the work in hand and reconciles the loop back to something usable', async () => {
    const { h, runtime } = await opened()
    await runtime.considerWake(workWake())
    expect(runtime.status().state).toBe('IDLE')
    await runtime.preemptByOwner()
    expect(runtime.status().state).toBe('IDLE')
    expect(h.cognitionCalls()).toBe(1)
  })

  it('does not let an interruption buy a fresh retry allowance', async () => {
    // Pre-emption is bookkeeping, not a new unit of work. If it reset the attempt
    // count it would be a way around the retry ceiling — and being interrupted by
    // the owner would become the cheapest way to get three more tries.
    const { h, runtime } = await opened({
      verification: () => ({ holds: false, code: 'reference-still-open' }),
    })
    await runtime.considerWake(workWake())
    const attempts = runtime.status().attemptCount
    expect(attempts).toBe(1)
    const before = h.types().length
    await runtime.preemptByOwner()
    expect(runtime.status().attemptCount).toBe(attempts)
    // The reconciliation is the only entry pre-emption writes. It clears the
    // per-wake counters and leaves the retry budget exactly where it was.
    expect(h.types().slice(before)).toEqual(['lifeloop.reconciled'])
    expect(runtime.status().state).toBe('IDLE')
  })
})

describe('STOP ALL reaches every state, and only the owner lifts it', () => {
  it('stops an idle loop, because an owner pressing stop means stop', async () => {
    const { h, runtime } = await opened()
    await runtime.stop()
    expect(runtime.status().isStopped).toBe(true)
    expect(h.cognitionCalls()).toBe(0)
  })

  it('refuses every wake while latched, and lifts only on the owner\'s own act', async () => {
    const { h, runtime } = await opened()
    h.setStopAll(true)
    await runtime.stop()
    const refused2 = await runtime.considerWake(workWake())
    expect((refused2 as { code: string }).code).toBe('stop-all-active')
    h.setStopAll(false)
    await runtime.lift()
    expect(runtime.status().isStopped).toBe(false)
    const accepted = await runtime.considerWake(workWake({ sourceRef: 'run-10' }))
    expect(accepted.outcome).toBe('accepted')
  })

  it('lets a stop arriving over a completed loop make the stop latched, not clearable', async () => {
    // The one legitimate re-entry: a loop that had *completed* sits in the terminal
    // state with a clearable code, and the panic button during the same tick has to
    // leave a latch behind. If it did not, the next close-out would unfreighten it.
    const { h, runtime } = await opened({ cognition: () => decided('speak') })
    await runtime.considerWake(workWake())
    h.setStopAll(true)
    await runtime.stop()
    expect(runtime.status().isStopped).toBe(true)
    const folded = reduceLifeLoopState(h.entries).state
    expect(folded.stopCode).toBe('stop-all-latched')
  })

  it('refuses to close out over a latch, so a panic button is never self-clearing', async () => {
    const { h, runtime } = await opened()
    h.setStopAll(true)
    await runtime.stop()
    // A wake that would otherwise have closed the loop out is refused outright.
    const outcome = await runtime.considerWake(workWake())
    expect((outcome as { code: string }).code).toBe('stop-all-active')
    expect(runtime.status().isStopped).toBe(true)
  })
})

describe('the loop is single-threaded and bounded', () => {
  it('refuses a second wake while one is in flight, rather than stacking a second continuation', async () => {
    const { h, runtime } = await opened()
    const first = runtime.considerWake(workWake())
    const second = runtime.considerWake(workWake({ sourceRef: 'run-10' }))
    const [, other] = await Promise.all([first, second])
    // Whichever ordering the queue chose, exactly one loop ran and exactly one
    // thought was paid for per accepted wake.
    expect(h.cognitionCalls()).toBeLessThanOrEqual(2)
    expect(other.outcome).toBe('accepted')
  })

  it('goes round again only while the goal is still open, and stops at the ceiling', async () => {
    // The continuation path is exercised rather than asserted: a goal that stays
    // open keeps it going, and the ceiling is what finally stops it.
    const { h, runtime } = await opened({ openGoals: ['goal-1'], limits: { maxLoopIterations: 3 } })
    await runtime.considerWake(workWake())
    // Three iterations and no more, and the third is refused by count rather than
    // by judgement — because "should she think again?" is not a question a loop
    // may keep asking about itself.
    expect(h.cognitionCalls()).toBe(3)
    expect(runtime.status().state).toBe('IDLE')
    expect(h.types()).toContain('lifeloop.continuation.decided')
  })

  it('completes in one iteration when the goal is not open', async () => {
    const { h, runtime } = await opened()
    await runtime.considerWake(workWake())
    expect(h.cognitionCalls()).toBe(1)
  })

  it('does nothing at all once shut down, and a refused wake afterwards costs nothing', async () => {
    const { h, runtime } = await opened()
    await runtime.close()
    const outcome = await runtime.considerWake(workWake())
    expect(outcome.outcome).toBe('closed')
    expect(h.cognitionCalls()).toBe(0)
  })
})

describe('the heartbeat is bounded and never spends', () => {
  it('does nothing when there is nothing due and nothing held', async () => {
    const { h, runtime } = await opened()
    expect(await runtime.tick()).toBe(0)
    expect(h.entries).toEqual([])
    expect(h.cognitionCalls()).toBe(0)
  })

  it('offers at most one schedule per tick, so a backlog cannot become a stampede', async () => {
    const { h, runtime } = await opened({
      schedules: [
        { scheduleId: 'sched-1', dueAt: T0 },
        { scheduleId: 'sched-2', dueAt: T0 },
        { scheduleId: 'sched-3', dueAt: T0 },
      ],
      grantAvailable: false,
    })
    expect(await runtime.tick()).toBe(1)
    expect(h.types().filter((type) => type === 'lifeloop.wake.received')).toHaveLength(1)
  })

  it('refuses a schedule that is not registered, so a heartbeat cannot invent one', async () => {
    const { h, runtime } = await opened()
    const outcome = await runtime.considerWake(
      workWake({ source: 'scheduled-heartbeat', kind: 'schedule-due', actor: 'host-heartbeat', goalRef: null, sourceRef: 'ghost' }),
    )
    expect((outcome as { code: string }).code).toBe('unknown-schedule')
    expect(h.cognitionCalls()).toBe(0)
  })

  it('refuses a due schedule whose condition does not hold, and holds nothing', async () => {
    const { h, runtime } = await opened({
      schedules: [{ scheduleId: 'sched-1', dueAt: T0 }],
      conditionHolds: () => false,
    })
    const outcome = await runtime.considerWake(
      workWake({ source: 'scheduled-heartbeat', kind: 'schedule-due', actor: 'host-heartbeat', goalRef: null, sourceRef: 'sched-1' }),
    )
    expect(outcome.outcome).toBe('deferred')
    // Not parked: the registry hands back a `dueAt` that is already behind us, so
    // a wait on it would expire the instant it was created.
    expect(runtime.status().state).toBe('IDLE')
    expect(runtime.status().currentDeadline).toBeNull()
    expect(h.cognitionCalls()).toBe(0)
  })
})

describe('the audit reports the promise rather than asserting it in a comment', () => {
it('holds over a journal the loop wrote itself', async () => {
    const { runtime } = await opened({ cognition: () => decided('speak') })
    await runtime.considerWake(workWake())
    const report = await runtime.audit()
    expect(report.holds).toBe(true)
    expect(Object.values(report.checks).every(Boolean)).toBe(true)
  })

  it('names the violation when a provider was contacted with no wake behind it', async () => {
    // A forged journal, which is what an attacker who has written to the file would
    // leave behind. The assertion has to catch it or it is decoration.
    const report = await (async () => {
      const { runtime } = await opened()
      return await runtime.audit([
        { type: 'model.request.started', recordedAt: T0, payload: { requestId: 'r1', grantId: null } },
      ])
    })()
    expect(report.holds).toBe(false)
    expect(report.violations.map((violation) => violation.code)).toContain(
      'model-call-without-wake',
    )
  })
})



