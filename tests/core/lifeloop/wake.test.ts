import { describe, expect, it } from 'vitest'
import {
  NON_JUSTIFYING_KINDS,
  WAKE_ACTORS,
  WAKE_SOURCES,
  WAKE_SOURCE_ACTOR,
  justifiesCognition,
  orderWakes,
  readWakePayload,
  validateWake,
  wakeDedupeKey,
  type WAKE_KINDS,
  type WakeValidationInput,
} from '../../../core/lifeloop'
import { HEARTBEAT, OWNER, SUBSYSTEM, T0, T_PLUS_1H, schedule, wake } from './fixture'

function input(overrides: Partial<WakeValidationInput> = {}): WakeValidationInput {
  return {
    actor: SUBSYSTEM,
    now: T0,
    stopAllActive: false,
    journalTrustworthy: true,
    loopState: 'IDLE',
    ...overrides,
  }
}

describe('the closed set of wake sources', () => {
  it('is exactly five, and nothing outside it can wake the loop', () => {
    expect([...WAKE_SOURCES]).toEqual([
      'owner-interaction',
      'authorized-event',
      'scheduled-heartbeat',
      'mission-transition',
      'work-transition',
    ])
  })

  it('names a model, a renderer, an agent, a connector, a webhook and a timer as actors', () => {
    // The unauthorized list is the point of the taxonomy. If one of these were
    // ever removed from the actor vocabulary the registry would stop being able
    // to *name* what it refuses, which is the first half of refusing it well.
    for (const actor of ['model', 'renderer', 'agent', 'connector', 'external-webhook', 'timer']) {
      expect(WAKE_ACTORS as readonly string[]).toContain(actor)
    }
  })

  it('refuses every actor for every source it is not paired with', () => {
    // Exhaustion rather than examples, and with no exemption for the three
    // authorized actors. Skipping them would leave precisely the interesting
    // cases untested: an authorized actor raising the *wrong* source is how
    // "the host cannot fake an owner message" stops being true.
    for (const actor of WAKE_ACTORS) {
      for (const source of WAKE_SOURCES) {
        const outcome = validateWake(
          wake({ source, kind: kindForSource(source), sourceRef: 'thing-1', goalRef: 'goal-1' }),
          input({ actor, now: T0 }),
        )
        if (WAKE_SOURCE_ACTOR[source] !== actor) {
          expect(outcome.outcome, `${actor} raised ${source}`).toBe('denied')
          if (outcome.outcome === 'denied') expect(outcome.code).toBe('unauthorized-actor')
        } else {
          // Authorized for this source, so it must never be refused *for being
          // the wrong actor*. It may still be refused for something else — an
          // unregistered heartbeat, for instance — and that is the point: the
          // authorization is a separate question from the shape of the wake.
          if (outcome.outcome === 'denied') {
            expect(outcome.code, `${actor} raised its own ${source}`).not.toBe('unauthorized-actor')
          }
        }
      }
    }
  })

  it('names one actor per source, and never the model, the renderer or a timer', () => {
    // Read the table itself rather than re-deriving it: an actor that appeared on
    // the right-hand side could authorize a wake it has no business raising.
    expect(Object.keys(WAKE_SOURCE_ACTOR).sort()).toEqual([...WAKE_SOURCES].sort())
    for (const actor of Object.values(WAKE_SOURCE_ACTOR)) {
      expect([OWNER, SUBSYSTEM, HEARTBEAT]).toContain(actor)
      expect(WAKE_ACTORS as readonly string[]).toContain(actor)
    }
  })
})

function kindForSource(source: (typeof WAKE_SOURCES)[number]): WakeKindForTest {
  switch (source) {
    case 'owner-interaction':
      return 'owner-command'
    case 'authorized-event':
      return 'system-health'
    case 'scheduled-heartbeat':
      return 'periodic-check'
    case 'mission-transition':
      return 'mission-completed'
    case 'work-transition':
      return 'run-completed'
  }
}

type WakeKindForTest = (typeof WAKE_KINDS)[number]

describe('wake attribution is Core\'s, not the payload\'s', () => {
  it('accepts a well-formed wake from its authorized actor', () => {
    const outcome = validateWake(wake(), input())
    expect(outcome.outcome).toBe('accepted')
  })

  it('refuses a payload whose source is not in the closed set', () => {
    const forged = { ...wake(), source: 'renderer-poll' }
    const outcome = validateWake(forged, input())
    expect(outcome.outcome).toBe('denied')
    if (outcome.outcome === 'denied') expect(outcome.code).toBe('unknown-source')
  })

  it('refuses a kind that does not belong to the source it arrived on', () => {
    // A heartbeat claiming to be a work transition is the cheapest possible way
    // to get a routine tick treated as something the owner cares about.
    const outcome = validateWake(wake({ source: 'scheduled-heartbeat', kind: 'run-failed' }), input({ actor: HEARTBEAT }))
    expect(outcome.outcome).toBe('denied')
    if (outcome.outcome === 'denied') expect(outcome.code).toBe('kind-source-mismatch')
  })
})

describe('wake field validation', () => {
  it('refuses a wake with no id, because the journal has to name it later', () => {
    const outcome = validateWake({ ...wake(), wakeId: '' }, input())
    expect(outcome.outcome).toBe('denied')
    if (outcome.outcome === 'denied') expect(outcome.code).toBe('missing-wake-id')
  })

  it('refuses a non-object wake without throwing', () => {
    for (const value of [null, undefined, 7, 'wake', [], true]) {
      const outcome = validateWake(value, input())
      expect(outcome.outcome).toBe('denied')
    }
  })

  it('refuses a wake about something that does not name the something', () => {
    const outcome = validateWake(wake({ sourceRef: null }), input())
    expect(outcome.outcome).toBe('denied')
    if (outcome.outcome === 'denied') expect(outcome.code).toBe('missing-source-reference')
  })

  it('lets an owner interaction go without naming a reference', () => {
    const outcome = validateWake(
      wake({ source: 'owner-interaction', kind: 'owner-message', sourceRef: null, goalRef: null }),
      input({ actor: OWNER }),
    )
    expect(outcome.outcome).toBe('accepted')
  })

  it('refuses a timestamp that is not a time', () => {
    const outcome = validateWake(wake({ occurredAt: 'soon' }), input())
    expect(outcome.outcome).toBe('denied')
    if (outcome.outcome === 'denied') expect(outcome.code).toBe('malformed-timestamp')
  })

  it('refuses a wake observed before it happened rather than clamping it', () => {
    const outcome = validateWake(wake({ occurredAt: T_PLUS_1H, observedAt: T0 }), input())
    expect(outcome.outcome).toBe('denied')
    if (outcome.outcome === 'denied') expect(outcome.code).toBe('observed-before-occurred')
  })
})

describe('STOP ALL and journal integrity outrank attribution questions', () => {
  it('refuses every wake while stopped, authorized or not', () => {
    for (const source of WAKE_SOURCES) {
      const outcome = validateWake(
        wake({ source, kind: kindForSource(source), sourceRef: 'thing-1', goalRef: 'g' }),
        input({ stopAllActive: true, actor: OWNER }),
      )
      expect(outcome.outcome).toBe('denied')
      if (outcome.outcome === 'denied') expect(outcome.code).toBe('stop-all-active')
    }
  })

  it('refuses every wake when the journal cannot be believed', () => {
    const outcome = validateWake(wake(), input({ journalTrustworthy: false }))
    expect(outcome.outcome).toBe('denied')
    if (outcome.outcome === 'denied') expect(outcome.code).toBe('journal-not-trustworthy')
  })

  it('prefers the untrustworthy-journal refusal over a stopped one', () => {
    // Order is the contract: a log with a hole may have lost the very STOP ALL
    // that would have refused this, so the hole is the more alarming answer.
    const outcome = validateWake(wake(), input({ journalTrustworthy: false, stopAllActive: true }))
    expect(outcome.outcome).toBe('denied')
    if (outcome.outcome === 'denied') expect(outcome.code).toBe('journal-not-trustworthy')
  })
})

describe('wake deduplication', () => {
  it('keys on source, kind and reference rather than on the wake id', () => {
    const first = wake({ wakeId: 'wake-a' })
    const second = wake({ wakeId: 'wake-b' })
    expect(wakeDedupeKey(first)).toBe(wakeDedupeKey(second))
  })

  it('refuses a second wake for a fact already looked at', () => {
    const key = wakeDedupeKey(wake())
    const outcome = validateWake(wake({ wakeId: 'wake-again' }), input({ processedWakeKeys: [key] }))
    expect(outcome.outcome).toBe('denied')
    if (outcome.outcome === 'denied') expect(outcome.code).toBe('duplicate-wake')
  })

  it('treats a different reference as a different fact', () => {
    const key = wakeDedupeKey(wake({ sourceRef: 'run-9' }))
    const outcome = validateWake(wake({ sourceRef: 'run-10' }), input({ processedWakeKeys: [key] }))
    expect(outcome.outcome).toBe('accepted')
  })
})

describe('the loop only accepts a wake when it is not already busy', () => {
  it('refuses a wake into a running loop', () => {
    for (const state of ['WAKING', 'ALLOW', 'ACTING', 'VERIFYING', 'CONTINUE']) {
      const outcome = validateWake(wake(), input({ loopState: state }))
      expect(outcome.outcome, state).toBe('denied')
      if (outcome.outcome === 'denied') expect(outcome.code).toBe('loop-busy')
    }
  })

  it('accepts a wake while waiting, because that is what wakes it', () => {
    const outcome = validateWake(wake(), input({ loopState: 'WAIT' }))
    expect(outcome.outcome).toBe('accepted')
  })

  it('refuses a wake into a loop that has not been closed out', () => {
    for (const state of ['DENY', 'STOP']) {
      const outcome = validateWake(wake(), input({ loopState: state }))
      expect(outcome.outcome, state).toBe('denied')
      if (outcome.outcome === 'denied') expect(outcome.code).toBe('awaiting-reset')
    }
  })
})

describe('the heartbeat is bounded, not trusted', () => {
  it('refuses a heartbeat naming a schedule that is not registered', () => {
    const outcome = validateWake(
      wake({ source: 'scheduled-heartbeat', kind: 'periodic-check', sourceRef: 'ghost' }),
      input({ actor: HEARTBEAT, schedules: [schedule()] }),
    )
    expect(outcome.outcome).toBe('denied')
    if (outcome.outcome === 'denied') expect(outcome.code).toBe('unknown-schedule')
  })

  it('defers a heartbeat for a schedule that is not due yet, with a deadline', () => {
    const outcome = validateWake(
      wake({ source: 'scheduled-heartbeat', kind: 'periodic-check', sourceRef: 'sched-1', observedAt: T0 }),
      input({ actor: HEARTBEAT, schedules: [schedule({ dueAt: T_PLUS_1H })] }),
    )
    expect(outcome.outcome).toBe('deferred')
    if (outcome.outcome === 'deferred') {
      expect(outcome.code).toBe('heartbeat-not-due')
      expect(outcome.deadline).toBe(T_PLUS_1H)
    }
  })

  it('defers a heartbeat whose condition does not hold', () => {
    const outcome = validateWake(
      wake({ source: 'scheduled-heartbeat', kind: 'periodic-check', sourceRef: 'sched-1' }),
      input({ actor: HEARTBEAT, schedules: [schedule()], conditionHolds: () => false }),
    )
    expect(outcome.outcome).toBe('deferred')
    if (outcome.outcome === 'deferred') expect(outcome.code).toBe('heartbeat-condition-unmet')
  })

  it('treats an absent condition probe as unmet rather than as allowed', () => {
    // Fail-closed. A heartbeat whose condition cannot be evaluated has not been
    // shown to be due, and an unchecked condition is not a licence.
    const outcome = validateWake(
      wake({ source: 'scheduled-heartbeat', kind: 'periodic-check', sourceRef: 'sched-1' }),
      input({ actor: HEARTBEAT, schedules: [schedule()] }),
    )
    expect(outcome.outcome).toBe('deferred')
  })

  it('accepts a due heartbeat whose condition holds', () => {
    const outcome = validateWake(
      wake({ source: 'scheduled-heartbeat', kind: 'schedule-due', sourceRef: 'sched-1' }),
      input({ actor: HEARTBEAT, schedules: [schedule()], conditionHolds: () => true }),
    )
    expect(outcome.outcome).toBe('accepted')
  })
})

describe('a wake does not imply a model call', () => {
  it('marks exactly the uninteresting kinds as not justifying cognition', () => {
    for (const kind of NON_JUSTIFYING_KINDS) expect(justifiesCognition(kind), kind).toBe(false)
  })

  it('does not justify cognition for a routine periodic check', () => {
    // The single most important assertion in this file. A heartbeat that thinks
    // is a bill that arrives on a timer.
    expect(justifiesCognition('periodic-check')).toBe(false)
    expect(justifiesCognition('schedule-due')).toBe(true)
  })

  it('does not justify cognition for a thing merely having started', () => {
    expect(justifiesCognition('mission-activated')).toBe(false)
    expect(justifiesCognition('run-started')).toBe(false)
  })

  it('justifies cognition for a thing that finished, failed or needs checking', () => {
    for (const kind of ['mission-completed', 'mission-failed', 'run-completed', 'run-failed', 'step-verified'] as const) {
      expect(justifiesCognition(kind), kind).toBe(true)
    }
  })
})

describe('wake ordering is total and reproducible', () => {
  it('puts the owner first and the heartbeat last', () => {
    const ordered = orderWakes([
      wake({ wakeId: 'h', source: 'scheduled-heartbeat', kind: 'periodic-check', occurredAt: T0 }),
      wake({ wakeId: 'w', source: 'work-transition', kind: 'run-completed' }),
      wake({ wakeId: 'o', source: 'owner-interaction', kind: 'owner-message', goalRef: null, sourceRef: null }),
      wake({ wakeId: 'm', source: 'mission-transition', kind: 'mission-failed' }),
    ])
    expect(ordered.map((w) => w.wakeId)).toEqual(['o', 'm', 'w', 'h'])
  })

  it('breaks a priority tie on the wake id, so the order never depends on input order', () => {
    // Two wakes from the same source at the same instant have no natural order.
    // Without the id tiebreak the result would depend on the order the journal
    // happened to be read in, which is exactly the sort of thing that makes a
    // replay disagree with the run it is replaying.
    const pair = [
      wake({ wakeId: 'b', source: 'work-transition', kind: 'run-failed', occurredAt: T0 }),
      wake({ wakeId: 'a', source: 'work-transition', kind: 'run-completed', occurredAt: T0 }),
    ]
    expect(orderWakes(pair).map((w) => w.wakeId)).toEqual(['a', 'b'])
    expect(orderWakes([...pair].reverse()).map((w) => w.wakeId)).toEqual(['a', 'b'])
  })

  it('is a fixed point: re-ordering an already ordered list changes nothing', () => {
    const ordered = orderWakes([
      wake({ wakeId: 'h', source: 'scheduled-heartbeat', kind: 'periodic-check', occurredAt: T0 }),
      wake({ wakeId: 'w', source: 'work-transition', kind: 'run-completed' }),
      wake({ wakeId: 'o', source: 'owner-interaction', kind: 'owner-message', goalRef: null, sourceRef: null }),
    ])
    // A real assertion on a real value, not the same expression compared with
    // itself: the second pass must reproduce the first exactly.
    expect(ordered.map((w) => w.wakeId)).toEqual(['o', 'w', 'h'])
    expect(orderWakes(ordered).map((w) => w.wakeId)).toEqual(['o', 'w', 'h'])
  })
})

describe('reading a wake off an untrusted payload', () => {
  it('returns null for anything malformed rather than repairing it', () => {
    for (const value of [null, undefined, 'wake', 42, [], {}, { source: 'nope', kind: 'run-completed' }]) {
      expect(readWakePayload(value)).toBeNull()
    }
  })

  it('reads a well-formed nested wake', () => {
    const parsed = readWakePayload({ wake: wake() })
    expect(parsed?.wakeId).toBe('wake-1')
    expect(parsed?.kind).toBe('run-completed')
  })
})