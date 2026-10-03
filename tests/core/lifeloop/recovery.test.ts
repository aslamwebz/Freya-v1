import { describe, expect, it } from 'vitest'
import {
  DEADLINE_DEFAULT_MS,
  LIFE_LOOP_LIMITS,
  describeRecovery,
  initialLifeLoopState,
  projectLifeLoopStatus,
  recoverLifeLoop,
  reduceLifeLoopState,
  reduceLifeLoopWake,
  residualWaitMs,
  retryCeilingFor,
  type LifeLoopJournalEntry,
} from '../../../core/lifeloop'
import { T0, T_PLUS_1H, T_PLUS_31D, wake } from './fixture'

/**
 * Journal builders.
 *
 * Written by hand rather than generated, because the point of these tests is that
 * a *specific* journal produces a *specific* state — and a helper that "helpfully"
 * filled in a legal transition would hide the very thing being tested.
 */
function entry(type: string, payload: Record<string, unknown>, recordedAt = T0): LifeLoopJournalEntry {
  return { type, recordedAt, payload }
}

const WAKE_RECEIVED = entry('lifeloop.wake.received', {
  wakeId: 'wake-1',
  source: 'work-transition',
  kind: 'run-failed',
  wakeKey: 'work-transition|run-failed|run-9',
  iteration: 0,
  goalRef: 'goal-1',
  sourceRef: 'run-9',
  occurredAt: T0,
  observedAt: T0,
})

/** wake -> filter passed -> action started -> action completed -> verified. */
const HAPPY_PATH: LifeLoopJournalEntry[] = [
  WAKE_RECEIVED,
  entry('lifeloop.filter.passed', { wakeId: 'wake-1', wakeKey: 'k', code: 'cognition-justified', iteration: 0 }),
  entry('lifeloop.cognition.requested', { wakeId: 'wake-1', wakeKey: 'k', iteration: 0, cognitionRequest: 1 }),
  entry('lifeloop.action.started', { wakeId: 'wake-1', iteration: 0, actionIndex: 0, deadlineType: 'action' }),
  entry('lifeloop.action.completed', { wakeId: 'wake-1', iteration: 0, actionIndex: 0 }),
  entry('lifeloop.verification.started', { wakeId: 'wake-1', iteration: 0, verificationIndex: 0, deadlineType: 'verification' }),
  entry('lifeloop.verification.passed', { wakeId: 'wake-1', iteration: 0, verificationIndex: 0 }),
]

describe('the fold is deterministic and derives everything from the journal', () => {
  it('starts idle, with nothing remembered', () => {
    const state = initialLifeLoopState()
    expect(state.state).toBe('IDLE')
    expect(state.wake).toBeNull()
    expect(state.deadline).toBeNull()
    expect(projectLifeLoopStatus(state).isIdle).toBe(true)
  })

  it('reaches CONTINUE by way of the only path that gets there', () => {
    const { state, anomalies } = reduceLifeLoopState(HAPPY_PATH)
    expect(anomalies).toEqual([])
    expect(state.state).toBe('CONTINUE')
    expect(state.iterationCount).toBe(0)
    expect(state.actionCount).toBe(1)
    expect(state.verificationCount).toBe(1)
    expect(state.cognitionRequestCount).toBe(1)
  })

  it('produces the same state for the same journal, every time, and on any slice of it', () => {
    // Recovery reads whatever the journal happens to hold when the process died,
    // which is an arbitrary prefix. Folding every prefix is what makes "replay is
    // deterministic" a claim about the journal rather than about one happy path.
    const first = reduceLifeLoopState(HAPPY_PATH)
    expect(first.anomalies).toEqual([])
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(reduceLifeLoopState(HAPPY_PATH)).toEqual(first)
    }
    for (let cut = 0; cut <= HAPPY_PATH.length; cut += 1) {
      const prefix = reduceLifeLoopState(HAPPY_PATH.slice(0, cut))
      expect(prefix.anomalies, `prefix of ${cut}`).toEqual([])
      expect(reduceLifeLoopState(HAPPY_PATH.slice(0, cut)), `prefix of ${cut}`).toEqual(prefix)
    }
  })

  it('keeps the wake it is working on, as read back off the journal', () => {
    const { state } = reduceLifeLoopState(HAPPY_PATH)
    expect(state.wake).toEqual(wake({ source: 'work-transition', kind: 'run-failed', sourceRef: 'run-9' }))
    expect(state.wakeKey).toBe('work-transition|run-failed|run-9')
  })

  it('passes over events of every other subsystem untouched', () => {
    const { state, anomalies } = reduceLifeLoopState([
      entry('core.started', { lifecycle: 'ready' }),
      entry('work.step.ready', { runId: 'r1' }),
      ...HAPPY_PATH,
      entry('conversation.turn.completed', { turnId: 't1' }),
    ])
    expect(state.state).toBe('CONTINUE')
    expect(anomalies).toEqual([])
  })
})

describe('a fresh wake restarts the per-wake counters', () => {
  it('zeroes actions, verifications and cognition requests', () => {
    // "Bounded per wake" has to mean per wake. Counters that survived into the
    // next wake would make the ceiling a ceiling on the process, which is a very
    // different promise.
    const second = entry('lifeloop.wake.received', {
      wakeId: 'wake-2',
      source: 'mission-transition',
      kind: 'mission-failed',
      wakeKey: 'mission-transition|mission-failed|mission-3',
      iteration: 0,
    })
    const { state } = reduceLifeLoopState([...HAPPY_PATH, second])
    expect(state.state).toBe('WAKING')
    expect(state.actionCount).toBe(0)
    expect(state.verificationCount).toBe(0)
    expect(state.cognitionRequestCount).toBe(0)
  })

  it('remembers both wake keys, so neither can be processed twice', () => {
    const second = entry('lifeloop.wake.received', {
      wakeId: 'wake-2',
      source: 'mission-transition',
      kind: 'mission-failed',
      wakeKey: 'mission-transition|mission-failed|mission-3',
      iteration: 0,
    })
    const { state } = reduceLifeLoopState([...HAPPY_PATH, second])
    expect(state.processedWakeKeys).toEqual([
      'work-transition|run-failed|run-9',
      'mission-transition|mission-failed|mission-3',
    ])
  })
})

describe('waiting states come back out of the journal holding a deadline', () => {
  it('gives a wait an absolute wait deadline', () => {
    const { state } = reduceLifeLoopState([
      WAKE_RECEIVED,
      entry('lifeloop.filter.denied', {
        wakeId: 'wake-1',
        wakeKey: 'k',
        outcome: 'wait',
        code: 'cooldown-active',
        deadlineType: 'wait',
        iteration: 0,
      }),
    ])
    expect(state.state).toBe('WAIT')
    expect(state.deadline?.type).toBe('wait')
    expect(state.deadline?.expiresAt).toBe(new Date(Date.parse(T0) + DEADLINE_DEFAULT_MS.wait).toISOString())
  })

  it('gives an action an action deadline, and a verification a verification deadline', () => {
    const acting = reduceLifeLoopState(HAPPY_PATH.slice(0, 4)).state
    expect(acting.state).toBe('ACTING')
    expect(acting.deadline?.type).toBe('action')
    const verifying = reduceLifeLoopState(HAPPY_PATH.slice(0, 6)).state
    expect(verifying.state).toBe('VERIFYING')
    expect(verifying.deadline?.type).toBe('verification')
  })

  it('gives a terminal state no deadline, because nothing is outstanding', () => {
    const { state } = reduceLifeLoopState([
      WAKE_RECEIVED,
      entry('lifeloop.filter.denied', { wakeId: 'wake-1', wakeKey: 'k', outcome: 'deny', code: 'cognition-not-justified', iteration: 0 }),
    ])
    expect(state.state).toBe('DENY')
    expect(state.deadline).toBeNull()
    expect(state.stopCode).toBe('cognition-not-justified')
  })
})

describe('a tampered journal produces a visible wrong answer, never a plausible one', () => {
  it('refuses to act on an event the state machine would not allow', () => {
    // A journal claiming Freya went straight from idle to acting is evidence of
    // tampering. Folding it would be believing the attacker.
    const { state, anomalies } = reduceLifeLoopState([
      entry('lifeloop.action.started', { wakeId: 'forged', iteration: 0, actionIndex: 0, deadlineType: 'action' }),
    ])
    expect(state.state).toBe('IDLE')
    expect(anomalies.map((a) => a.code)).toContain('illegal-transition')
  })

  it('refuses a cognition denial that no cognition asked for', () => {
    const { state, anomalies } = reduceLifeLoopState([entry('lifeloop.cognition.denied', { code: 'no-grant' })])
    expect(state.state).toBe('IDLE')
    expect(anomalies.map((a) => a.code)).toContain('illegal-transition')
  })

  it('reports an unknown life-loop event type rather than skipping it quietly', () => {
    const { anomalies } = reduceLifeLoopState([entry('lifeloop.thought.something', { note: 'x' })])
    expect(anomalies.map((a) => a.code)).toContain('unknown-event-type')
  })

  it('reports a malformed payload rather than folding an empty one', () => {
    const { state, anomalies } = reduceLifeLoopState([{ type: 'lifeloop.wake.received', payload: 'nope' }])
    expect(state.state).toBe('IDLE')
    expect(anomalies.map((a) => a.code)).toContain('malformed-payload')
  })

  it('names a payload key that is outside the closed vocabulary', () => {
    const { anomalies } = reduceLifeLoopState([
      entry('lifeloop.wake.received', { wakeId: 'w', source: 'work-transition', kind: 'run-failed', wakeKey: 'k', iteration: 0, extra: 'x' }),
    ])
    expect(anomalies.map((a) => a.code)).toContain('unknown-payload-key')
  })

  it('names an authority-shaped key as the escalation it is', () => {
    for (const key of ['capability', 'grant', 'grantId', 'verdict', 'token', 'budget']) {
      const { anomalies } = reduceLifeLoopState([
        entry('lifeloop.action.started', { wakeId: 'w', iteration: 0, actionIndex: 0, deadlineType: 'action', [key]: 'x' }),
      ])
      const found = anomalies.find((a) => a.code === 'forbidden-payload-key')
      expect(found, key).toBeDefined()
      expect(found?.detail).toContain(key)
    }
  })

  it('refuses a payload that has grown a paragraph in it', () => {
    // The journal is the least protected file in the system. A life-loop event
    // that could carry prose would quietly turn it into a transcript.
    const { anomalies } = reduceLifeLoopState([
      entry('lifeloop.wake.received', {
        wakeId: 'w',
        source: 'work-transition',
        kind: 'run-failed',
        wakeKey: 'k',
        iteration: 0,
        note: 'x'.repeat(500),
      }),
    ])
    expect(anomalies.map((a) => a.code)).toContain('oversized-payload-text')
  })

  it('reports a second stop arriving while already stopped', () => {
    const { anomalies } = reduceLifeLoopState([
      entry('lifeloop.stopped', { wakeId: 'w', iteration: 0, code: 'stop-all' }),
      entry('lifeloop.stopped', { wakeId: 'w', iteration: 0, code: 'stop-all' }),
    ])
    expect(anomalies.map((a) => a.code)).toContain('terminal-state-re-entered')
  })
})

describe('STOP ALL reaches every state through the journal alone', () => {
  it('stops a loop that was mid-action', () => {
    const { state } = reduceLifeLoopState([...HAPPY_PATH.slice(0, 4), entry('lifeloop.stopped', { wakeId: 'wake-1', iteration: 0, code: 'stop-all' })])
    expect(state.state).toBe('STOP')
    expect(state.stopCode).toBe('stop-all')
  })

  it('stops a loop that was only waking', () => {
    const { state } = reduceLifeLoopState([WAKE_RECEIVED, entry('lifeloop.stopped', { code: 'stop-all' })])
    expect(state.state).toBe('STOP')
  })

  it('stops an idle loop, because an owner pressing stop means stop', () => {
    const { state } = reduceLifeLoopState([entry('lifeloop.stopped', { code: 'stop-all' })])
    expect(state.state).toBe('STOP')
    expect(projectLifeLoopStatus(state).isStopped).toBe(true)
  })
})

describe('slicing a journal to one wake', () => {
  it('answers what had happened by the end of that wake, and no more', () => {
    const second = entry('lifeloop.wake.received', {
      wakeId: 'wake-2',
      source: 'mission-transition',
      kind: 'mission-failed',
      wakeKey: 'k2',
      iteration: 0,
    })
    const scoped = reduceLifeLoopWake([...HAPPY_PATH, second], 'wake-1')
    expect(scoped.state.state).toBe('CONTINUE')
    expect(scoped.state.wake?.wakeId).toBe('wake-1')
  })
})

/* ------------------------------------------------------------- recovery */

describe('restart recovery: Freya does not pick up where she left off', () => {
  it('resets a half-finished thought to idle rather than resuming it', () => {
    // The uncomfortable rule. A journal proves an action *started*; it cannot
    // prove it finished. Treating a start as a completion is how a system tells
    // its owner that work happened when it did not.
    const report = recoverLifeLoop({
      state: reduceLifeLoopState(HAPPY_PATH.slice(0, 4)).state,
      now: T0,
      stopAllActive: false,
    })
    expect(report.interruptedState).toBe('ACTING')
    expect(report.recoveredState).toBe('STOP')
    expect(report.actions[0]?.code).toBe('interrupted-action-stopped')
    expect(report.requiresOwnerAction).toBe(true)
  })

  it('resets an interrupted verification to stopped', () => {
    const report = recoverLifeLoop({
      state: reduceLifeLoopState(HAPPY_PATH.slice(0, 6)).state,
      now: T0,
      stopAllActive: false,
    })
    expect(report.recoveredState).toBe('STOP')
    expect(report.actions[0]?.code).toBe('interrupted-verification-stopped')
  })

  it('re-evaluates a waking, allowing or continuing loop on the next genuine wake', () => {
    for (const entries of [HAPPY_PATH.slice(0, 1), HAPPY_PATH.slice(0, 2), HAPPY_PATH]) {
      const report = recoverLifeLoop({ state: reduceLifeLoopState(entries).state, now: T0, stopAllActive: false })
      expect(report.recoveredState).toBe('IDLE')
      expect(report.actions[0]?.code).toBe('re-evaluate-on-next-wake')
      expect(report.resumption).toBe('none')
    }
  })

  it('closes out a loop that had already finished', () => {
    for (const entries of [[], [WAKE_RECEIVED, entry('lifeloop.filter.denied', { outcome: 'deny', code: 'x' })]]) {
      const report = recoverLifeLoop({ state: reduceLifeLoopState(entries).state, now: T0, stopAllActive: false })
      expect(report.recoveredState).toBe('IDLE')
    }
  })

  it('never resumes anything, in any state', () => {
    // Exhaustion over every reachable state: the recovery vocabulary has no
    // 'resume' in it, and this is the test that keeps it that way.
    for (const entries of [[], HAPPY_PATH.slice(0, 1), HAPPY_PATH.slice(0, 2), HAPPY_PATH.slice(0, 4), HAPPY_PATH.slice(0, 6), HAPPY_PATH]) {
      expect(recoverLifeLoop({ state: reduceLifeLoopState(entries).state, now: T0, stopAllActive: false }).resumption).toBe('none')
    }
  })
})

describe('a wait survives a restart only if its deadline has not passed', () => {
  const waiting = reduceLifeLoopState([
    WAKE_RECEIVED,
    entry('lifeloop.filter.denied', {
      wakeId: 'wake-1',
      wakeKey: 'k',
      outcome: 'wait',
      code: 'cooldown-active',
      deadlineType: 'wait',
      iteration: 0,
    }),
  ]).state

  it('keeps a wait whose deadline is still ahead, on its original deadline', () => {
    const report = recoverLifeLoop({ state: waiting, now: T0, stopAllActive: false })
    expect(report.recoveredState).toBe('WAIT')
    expect(report.actions[0]?.code).toBe('preserve-wait')
    expect(report.resumption).toBe('wait')
    expect(report.residualDeadline?.expiresAt).toBe(waiting.deadline?.expiresAt)
    expect(residualWaitMs(report, T0)).toBe(DEADLINE_DEFAULT_MS.wait)
  })

  it('does not extend the deadline on restart', () => {
    // Thirty days of waiting must mean thirty days in total, not thirty days per
    // crash. The deadline is carried out of the journal untouched.
    const later = recoverLifeLoop({ state: waiting, now: T_PLUS_1H, stopAllActive: false })
    expect(later.residualDeadline?.expiresAt).toBe(waiting.deadline?.expiresAt)
    expect(residualWaitMs(later, T_PLUS_1H)).toBe(DEADLINE_DEFAULT_MS.wait - 60 * 60_000)
  })

  it('ends a wait whose deadline passed while the process was gone', () => {
    // Otherwise this is a dead loop that looks alive: no heartbeat can ever
    // satisfy it and no owner can see it.
    const report = recoverLifeLoop({ state: waiting, now: T_PLUS_31D, stopAllActive: false })
    expect(report.recoveredState).toBe('DENY')
    expect(report.actions[0]?.code).toBe('wait-deadline-expired')
    expect(report.resumption).toBe('none')
    expect(report.requiresOwnerAction).toBe(true)
    expect(residualWaitMs(report, T_PLUS_31D)).toBe(0)
  })

  it('ends a wait that has no deadline at all, because an unbounded wait is the failure', () => {
    const headless = { ...waiting, deadline: null }
    const report = recoverLifeLoop({ state: headless, now: T0, stopAllActive: false })
    expect(report.recoveredState).toBe('DENY')
    expect(report.actions[0]?.code).toBe('wait-deadline-expired')
  })
})

describe('STOP ALL survives a restart', () => {
  it('keeps a stopped Freya stopped, whatever she was doing', () => {
    for (const entries of [[], HAPPY_PATH.slice(0, 1), HAPPY_PATH.slice(0, 4), HAPPY_PATH, [entry('lifeloop.stopped', { code: 'stop-all' })]]) {
      const report = recoverLifeLoop({
        state: reduceLifeLoopState(entries).state,
        now: T0,
        stopAllActive: true,
      })
      expect(report.recoveredState, `${entries.length} journal entries`).toBe('STOP')
      expect(report.actions[0]?.code).toBe('stop-all-latched')
      expect(report.resumption).toBe('none')
      expect(report.requiresOwnerAction).toBe(true)
    }
  })

  it('outranks everything else, including a stop that was already being recovered', () => {
    const report = recoverLifeLoop({
      state: reduceLifeLoopState(HAPPY_PATH.slice(0, 4)).state,
      now: T0,
      stopAllActive: true,
    })
    expect(report.actions).toHaveLength(1)
    expect(report.actions[0]?.code).toBe('stop-all-latched')
  })
})

/** wake -> filter passed -> action -> fail. Leaves the loop denied. */
const FAILED_STEP: LifeLoopJournalEntry[] = [
  WAKE_RECEIVED,
  entry('lifeloop.filter.passed', { wakeId: 'wake-1', wakeKey: 'work-transition|run-failed|run-9' }),
  entry('lifeloop.action.started', { wakeId: 'wake-1', iteration: 0, actionIndex: 0, deadlineType: 'action' }),
  entry('lifeloop.action.failed', { wakeId: 'wake-1', iteration: 0, actionIndex: 0, code: 'step-failed' }),
]

const CLOSE_OUT = entry('lifeloop.reset', { wakeId: 'wake-1', iteration: 0, code: 'retry' })

/** Every attempt the code allows, each one closed out and woken again. */
function threeFailuresAtTheSameWork(): LifeLoopJournalEntry[] {
  let entries: LifeLoopJournalEntry[] = []
  for (let attempt = 0; attempt < LIFE_LOOP_LIMITS.maxAttemptsPerUnit; attempt += 1) {
    entries = entries.concat(FAILED_STEP, CLOSE_OUT)
  }
  return entries
}

describe('the retry ceiling survives a restart', () => {
  it('counts the attempt even though the step failed', () => {
    const { state } = reduceLifeLoopState(FAILED_STEP)
    expect(state.state).toBe('DENY')
    expect(state.attemptCount).toBe(1)
    expect(retryCeilingFor(state).currentAttempt).toBe(1)
  })

  it('counts a failed verification as an attempt too', () => {
    const { state } = reduceLifeLoopState(
      HAPPY_PATH.slice(0, 5).concat([
        entry('lifeloop.verification.started', { wakeId: 'wake-1', iteration: 0, verificationIndex: 0 }),
        entry('lifeloop.verification.failed', { wakeId: 'wake-1', iteration: 0, verificationIndex: 0, code: 'not-true' }),
      ]),
    )
    expect(state.attemptCount).toBe(1)
  })

  it('reaches the ceiling after the code-owned number of attempts', () => {
    const { state } = reduceLifeLoopState(threeFailuresAtTheSameWork())
    expect(state.attemptCount).toBe(LIFE_LOOP_LIMITS.maxAttemptsPerUnit)
  })

  it('carries the count across a wake about the same work', () => {
    // The budget belongs to the goal, not to the notice. Three tries that each
    // closed out and woke Freya again are still three tries.
    const { state } = reduceLifeLoopState(threeFailuresAtTheSameWork().concat(WAKE_RECEIVED))
    expect(state.attemptCount).toBe(LIFE_LOOP_LIMITS.maxAttemptsPerUnit)
  })

  it('starts a fresh budget when the wake is about different work', () => {
    const otherWork = entry('lifeloop.wake.received', {
      wakeId: 'wake-2',
      source: 'work-transition',
      kind: 'run-failed',
      wakeKey: 'k2',
      iteration: 0,
      goalRef: 'goal-2',
      sourceRef: 'run-8',
      occurredAt: T0,
      observedAt: T0,
    })
    const { state } = reduceLifeLoopState(threeFailuresAtTheSameWork().concat(otherWork))
    expect(state.attemptCount).toBe(0)
  })

  it('reports exhaustion in the projection, so a caller need not re-derive it', () => {
    const status = projectLifeLoopStatus(reduceLifeLoopState(threeFailuresAtTheSameWork()).state)
    expect(status.attemptCount).toBe(LIFE_LOOP_LIMITS.maxAttemptsPerUnit)
    expect(status.retriesExhausted).toBe(true)
    expect(projectLifeLoopStatus(initialLifeLoopState()).retriesExhausted).toBe(false)
  })

  it('never reports more attempts than the ceiling allows', () => {
    const { state } = reduceLifeLoopState(
      threeFailuresAtTheSameWork().concat(threeFailuresAtTheSameWork()),
    )
    expect(retryCeilingFor(state).currentAttempt).toBe(LIFE_LOOP_LIMITS.maxAttemptsPerUnit)
    expect(retryCeilingFor(state).maxAttempts).toBe(LIFE_LOOP_LIMITS.maxAttemptsPerUnit)
  })
})

describe('a denied loop has to be closed out before it can be used again', () => {
  it('stays denied in the journal until it is closed out', () => {
    // Without the close-out the loop is single-shot: one refusal and silence.
    const denied = reduceLifeLoopState(FAILED_STEP)
    expect(denied.state.state).toBe('DENY')
    expect(reduceLifeLoopState(denied.state.processedWakeKeys.length > 0 ? FAILED_STEP.concat(WAKE_RECEIVED) : []).state.state).toBe('DENY')
  })

  it('returns to idle on the close-out, keeping what was already learned', () => {
    const { state } = reduceLifeLoopState(FAILED_STEP.concat(CLOSE_OUT))
    expect(state.state).toBe('IDLE')
    expect(state.deadline).toBeNull()
    expect(state.stopCode).toBeNull()
    // The dedupe keys survive, or the same fact would wake her again on replay.
    expect(state.processedWakeKeys).toContain('work-transition|run-failed|run-9')
  })

  it('refuses a close-out from a state that is not closed', () => {
    const { anomalies } = reduceLifeLoopState([WAKE_RECEIVED, CLOSE_OUT])
    expect(anomalies.map((a) => a.code)).toContain('illegal-transition')
  })

  it('will not let a journal entry clear the STOP latch', () => {
    // Clearing STOP ALL is the owner's act and is recorded elsewhere. If a
    // life-loop reset could move STOP, the latch would be one lifecycle event
    // away from being self-clearing.
    const { state, anomalies } = reduceLifeLoopState([
      entry('lifeloop.stopped', { wakeId: 'wake-1', iteration: 0, code: 'stop-all' }),
      CLOSE_OUT,
    ])
    expect(state.state).toBe('STOP')
    expect(anomalies.map((a) => a.code)).toContain('illegal-transition')
  })
})

describe('a verification cannot be started by a loop that is not verifying', () => {
  it('reports an anomaly and arms no deadline from IDLE', () => {
    // A life-loop timer on a loop with no work is the shape a self-running timer
    // takes, so this is refused rather than quietly counted.
    const { state, anomalies } = reduceLifeLoopState([
      entry('lifeloop.verification.started', { wakeId: 'wake-1', iteration: 0, verificationIndex: 0, deadlineType: 'verification' }),
    ])
    expect(anomalies.map((a) => a.code)).toContain('illegal-transition')
    expect(state.state).toBe('IDLE')
    expect(state.deadline).toBeNull()
    expect(state.verificationCount).toBe(0)
  })

  it('counts it once the loop really is verifying', () => {
    const { state, anomalies } = reduceLifeLoopState(
      HAPPY_PATH.slice(0, 5).concat([
        entry('lifeloop.verification.started', { wakeId: 'wake-1', iteration: 0, verificationIndex: 0 }),
      ]),
    )
    expect(anomalies).toEqual([])
    expect(state.verificationCount).toBe(1)
    expect(state.deadline?.type).toBe('verification')
  })
})

describe('a recovery report is safe to render and safe to log', () => {
  it('is assembled from closed codes and fixed sentences only', () => {
    const report = recoverLifeLoop({
      state: reduceLifeLoopState(HAPPY_PATH.slice(0, 4)).state,
      now: T0,
      stopAllActive: false,
    })
    const text = describeRecovery(report)
    expect(text).toContain('interrupted-action-stopped')
    expect(text).toContain('The owner has to decide')
    // No payload value from the journal can reach the sentence.
    expect(text).not.toContain('run-9')
  })
})