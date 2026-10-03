import { describe, expect, it } from 'vitest'
import {
  LIFE_LOOP_LIMITS,
  evaluatePreCognition,
  type PreCognitionInput,
} from '../../../core/lifeloop'
import { T0, T_PLUS_1H, T_PLUS_1M, FOCUSED, authority, progress, wake } from './fixture'

function input(overrides: Partial<PreCognitionInput> = {}): PreCognitionInput {
  return {
    wake: wake({ kind: 'run-failed' }),
    now: T0,
    progress: progress(),
    authority: authority(),
    ...overrides,
  }
}

describe('the filter allows a wake that genuinely justifies thinking', () => {
  it('allows a finished run, with room in the budget and a grant behind it', () => {
    const outcome = evaluatePreCognition(input())
    expect(outcome.outcome).toBe('allow')
  })

  it('is a total function: every input reaches a verdict, and never an exception', () => {
    // Determinism, proved the only way it can be: the whole cross-product of the
    // gates, not one favourable corner repeated. A filter that threw on an
    // unusual combination would fail open at the one moment it mattered.
    const booleans = [true, false]
    const verdicts = new Set<string>()
    for (const journalTrustworthy of booleans) {
      for (const stopAllActive of booleans) {
        for (const enabled of booleans) {
          for (const grantAvailable of booleans) {
            for (const focused of booleans) {
              for (const kind of ['run-failed', 'periodic-check'] as const) {
                const outcome = evaluatePreCognition(
                  input({
                    wake: wake({ kind }),
                    authority: authority({
                      journalTrustworthy,
                      stopAllActive,
                      enabled,
                      grantAvailable,
                      focus: { focused, focusRef: null },
                      requestedOutcome: 'interrupt',
                    }),
                  }),
                )
                verdicts.add(outcome.outcome)
              }
            }
          }
        }
      }
    }
    // Both verdicts appear and only these two: `allow` when every gate is open, the
    // wake kind justifies thinking and the owner is not mid-task; `deny` for
    // everything else. Nothing throws, and nothing produces a third shape.
    expect([...verdicts].sort()).toEqual(['allow', 'deny'])
  })

  it('refuses the same input identically across repeated calls', () => {
    const first = evaluatePreCognition(input())
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(evaluatePreCognition(input())).toEqual(first)
    }
  })
})

describe('an idle Freya spends nothing', () => {
  it('refuses every state that is not actively waking', () => {
    for (const state of ['IDLE', 'DENY', 'STOP', 'WAIT', 'ALLOW', 'ACTING', 'VERIFYING', 'CONTINUE']) {
      const outcome = evaluatePreCognition(input({ progress: progress({ state }) }))
      expect(outcome.outcome, state).toBe('deny')
      if (outcome.outcome === 'deny') expect(outcome.code).toBe('no-active-wake')
    }
  })

  it('cannot be talked out of it by a justifying wake', () => {
    // A perfectly good reason to think, delivered while Freya has nothing to
    // think about, is still nothing to think about.
    const outcome = evaluatePreCognition(
      input({
        progress: progress({ state: 'IDLE' }),
        wake: wake({ source: 'owner-interaction', kind: 'owner-message', goalRef: null, sourceRef: null }),
      }),
    )
    expect(outcome.outcome).toBe('deny')
    if (outcome.outcome === 'deny') expect(outcome.code).toBe('no-active-wake')
  })
})

describe('the gate order is the contract', () => {
  it('prefers an untrustworthy journal over everything, including STOP ALL', () => {
    // Matches `core/cognition/governor.ts`: a log with a hole may have lost the
    // very STOP ALL that would have refused this.
    const outcome = evaluatePreCognition(
      input({ authority: authority({ journalTrustworthy: false, stopAllActive: true }) }),
    )
    expect(outcome.outcome).toBe('deny')
    if (outcome.outcome === 'deny') expect(outcome.code).toBe('journal-not-trustworthy')
  })

  it('prefers STOP ALL over a disabled loop, a missing grant and an empty budget', () => {
    const outcome = evaluatePreCognition(
      input({
        authority: authority({ stopAllActive: true, enabled: false, grantAvailable: false, budgetRemainingCalls: 0 }),
      }),
    )
    expect(outcome.outcome).toBe('deny')
    if (outcome.outcome === 'deny') expect(outcome.code).toBe('stop-all-active')
  })

  it('prefers a disabled loop over budget and grant', () => {
    const outcome = evaluatePreCognition(
      input({ authority: authority({ enabled: false, grantAvailable: false, budgetRemainingCalls: 0 }) }),
    )
    if (outcome.outcome === 'deny') expect(outcome.code).toBe('loop-disabled')
    else throw new Error('expected a denial')
  })

  it('prefers an exhausted budget over a missing grant, because no grant would have helped', () => {
    const outcome = evaluatePreCognition(
      input({ authority: authority({ budgetRemainingCalls: 0, grantAvailable: false }) }),
    )
    if (outcome.outcome === 'deny') expect(outcome.code).toBe('budget-exhausted')
    else throw new Error('expected a denial')
  })

  it('refuses a negative budget rather than treating it as room', () => {
    const outcome = evaluatePreCognition(input({ authority: authority({ budgetRemainingCalls: -5 }) }))
    if (outcome.outcome === 'deny') expect(outcome.code).toBe('budget-exhausted')
    else throw new Error('expected a denial')
  })
})

describe('a wake that is real but not worth a model call', () => {
  it('refuses a routine periodic check, with the reason on the record', () => {
    const outcome = evaluatePreCognition(
      input({ wake: wake({ source: 'scheduled-heartbeat', kind: 'periodic-check', sourceRef: 'sched-1' }) }),
    )
    expect(outcome.outcome).toBe('deny')
    if (outcome.outcome === 'deny') {
      expect(outcome.code).toBe('cognition-not-justified')
      expect(outcome.reason).toMatch(/not on its own a reason/)
    }
  })

  it('refuses a system health ping', () => {
    const outcome = evaluatePreCognition(
      input({ wake: wake({ source: 'authorized-event', kind: 'system-health', sourceRef: 'health-1' }) }),
    )
    if (outcome.outcome === 'deny') expect(outcome.code).toBe('cognition-not-justified')
    else throw new Error('expected a denial')
  })

  it('refuses a thing that has only just started', () => {
    for (const kind of ['mission-activated', 'run-started'] as const) {
      const outcome = evaluatePreCognition(input({ wake: wake({ kind }) }))
      expect(outcome.outcome, kind).toBe('deny')
    }
  })
})

describe('cooldown waits, and the wait carries a deadline', () => {
  it('waits rather than denies while a cooldown is still running', () => {
    const outcome = evaluatePreCognition(
      input({ authority: authority({ cooldownUntil: T_PLUS_1H }) }),
    )
    expect(outcome.outcome).toBe('wait')
    if (outcome.outcome === 'wait') {
      expect(outcome.code).toBe('cooldown-active')
      expect(outcome.deadline).toBe(T_PLUS_1H)
    }
  })

  it('stops waiting once the cooldown has passed', () => {
    // A minute in, not an hour: the iteration's own duration ceiling would
    // legitimately refuse an hour-old iteration, and mixing the two would make
    // this test pass or fail for the wrong reason.
    const outcome = evaluatePreCognition(
      input({ now: T_PLUS_1M, authority: authority({ cooldownUntil: T0 }) }),
    )
    expect(outcome.outcome).toBe('allow')
  })

  it('fails closed on a cooldown that is not a time', () => {
    // A malformed cooldown is not "no cooldown". An unparseable ceiling would
    // otherwise read as an absent one and let the wait through.
    const outcome = evaluatePreCognition(input({ authority: authority({ cooldownUntil: 'soon' }) }))
    expect(outcome.outcome).toBe('wait')
  })
})

describe('focus outranks the loop’s wish to interrupt', () => {
  it('refuses an interrupt while the owner is mid-task, and names focus as the reason', () => {
    // The check exists so the refusal is *journaled*. Reading it back off a later
    // decision would mean the loop had already decided to interrupt and only then
    // discovered it could not — which is the moment the owner notices.
    const outcome = evaluatePreCognition(
      input({ authority: authority({ requestedOutcome: 'interrupt', focus: FOCUSED }) }),
    )
    expect(outcome.outcome).toBe('deny')
    if (outcome.outcome === 'deny') expect(outcome.code).toBe('focus-blocks-escalation')
  })

  it('lets a decision that does not interrupt through while the owner is busy', () => {
    for (const outcome of ['do-nothing', 'remember', 'subtle-cue', 'speak'] as const) {
      const verdict = evaluatePreCognition(
        input({ authority: authority({ requestedOutcome: outcome, focus: FOCUSED }) }),
      )
      expect(verdict.outcome, outcome).toBe('allow')
    }
  })

  it('lets an interrupt through when the owner is free', () => {
    const outcome = evaluatePreCognition(input({ authority: authority({ requestedOutcome: 'interrupt' }) }))
    expect(outcome.outcome).toBe('allow')
  })

  it('prefers focus over the wake kind, so the record says why and not what', () => {
    const outcome = evaluatePreCognition(
      input({
        wake: wake({ source: 'scheduled-heartbeat', kind: 'periodic-check', sourceRef: 'sched-1' }),
        authority: authority({ requestedOutcome: 'interrupt', focus: FOCUSED }),
      }),
    )
    if (outcome.outcome === 'deny') expect(outcome.code).toBe('focus-blocks-escalation')
    else throw new Error('expected a denial')
  })

  it('refuses an interrupt under STOP ALL without blaming the owner’s focus', () => {
    // Both would deny. Reporting focus would put "she was busy" in the journal
    // for a stop that had nothing to do with what the owner was doing.
    const outcome = evaluatePreCognition(
      input({ authority: authority({ requestedOutcome: 'interrupt', focus: FOCUSED, stopAllActive: true }) }),
    )
    if (outcome.outcome === 'deny') expect(outcome.code).toBe('stop-all-active')
    else throw new Error('expected a denial')
  })
})

describe('every ceiling is enforced by count, not by judgement', () => {
  it('refuses a step that has been tried as many times as it may be', () => {
    // The ceiling counts failures, so it is the retry rule and not the action
    // rule. Reporting the action bound here would say the loop had done too much
    // when what had actually happened is that it had tried too often.
    const refused = evaluatePreCognition(
      input({ progress: progress({ attemptCount: LIFE_LOOP_LIMITS.maxAttemptsPerUnit }) }),
    )
    if (refused.outcome === 'deny') expect(refused.code).toBe('limit-attempts')
    else throw new Error('expected a denial')
    const allowed = evaluatePreCognition(
      input({ progress: progress({ attemptCount: LIFE_LOOP_LIMITS.maxAttemptsPerUnit - 1 }) }),
    )
    expect(allowed.outcome).toBe('allow')
  })

  it('refuses a heartbeat when too many schedules are already open', () => {
    const heartbeat = input({
      wake: wake({ source: 'scheduled-heartbeat', kind: 'schedule-due', sourceRef: 'sched-1' }),
      progress: progress({ pendingScheduleCount: LIFE_LOOP_LIMITS.maxPendingSchedules + 1 }),
    })
    const refused = evaluatePreCognition(heartbeat)
    if (refused.outcome === 'deny') expect(refused.code).toBe('limit-schedules')
    else throw new Error('expected a denial')
    const allowed = evaluatePreCognition(
      input({
        wake: wake({ source: 'scheduled-heartbeat', kind: 'schedule-due', sourceRef: 'sched-1' }),
        progress: progress({ pendingScheduleCount: LIFE_LOOP_LIMITS.maxPendingSchedules }),
      }),
    )
    expect(allowed.outcome).toBe('allow')
  })

  it('does not apply the schedule ceiling to a wake that is not a heartbeat', () => {
    const outcome = evaluatePreCognition(
      input({ progress: progress({ pendingScheduleCount: LIFE_LOOP_LIMITS.maxPendingSchedules + 1 }) }),
    )
    expect(outcome.outcome).toBe('allow')
  })

  it('refuses the tenth iteration and allows the ninth', () => {
    const ceiling = LIFE_LOOP_LIMITS.maxLoopIterations
    const allowed = evaluatePreCognition(input({ progress: progress({ iterationCount: ceiling - 1 }) }))
    expect(allowed.outcome).toBe('allow')
    const refused = evaluatePreCognition(input({ progress: progress({ iterationCount: ceiling }) }))
    if (refused.outcome === 'deny') expect(refused.code).toBe('limit-iterations')
    else throw new Error('expected a denial')
  })

  it('refuses once this wake has asked for as much cognition as it is allowed', () => {
    // The anti-runaway clause. A wake that always justifies thinking still only
    // gets a fixed number of calls, so "should she think again?" is never a
    // question the loop asks about itself.
    const ceiling = LIFE_LOOP_LIMITS.maxCognitionRequestsPerWake
    const refused = evaluatePreCognition(input({ progress: progress({ cognitionRequestCount: ceiling }) }))
    if (refused.outcome === 'deny') expect(refused.code).toBe('limit-iterations')
    else throw new Error('expected a denial')
  })

  it('refuses once this wake has taken as many actions as it is allowed', () => {
    const refused = evaluatePreCognition(
      input({ progress: progress({ actionCount: LIFE_LOOP_LIMITS.maxActionsPerIteration }) }),
    )
    if (refused.outcome === 'deny') expect(refused.code).toBe('limit-actions')
    else throw new Error('expected a denial')
  })

  it('refuses once this wake has checked as much as it is allowed', () => {
    const refused = evaluatePreCognition(
      input({ progress: progress({ verificationCount: LIFE_LOOP_LIMITS.maxVerificationsPerIteration }) }),
    )
    if (refused.outcome === 'deny') expect(refused.code).toBe('limit-verifications')
    else throw new Error('expected a denial')
  })

  it('refuses an iteration that has outlived its duration ceiling', () => {
    const refused = evaluatePreCognition(
      input({ now: T_PLUS_1H, progress: progress({ iterationStartedAt: T0 }) }),
    )
    if (refused.outcome === 'deny') expect(refused.code).toBe('limit-duration')
    else throw new Error('expected a denial')
  })

  it('does not apply the duration ceiling when no iteration has begun', () => {
    const outcome = evaluatePreCognition(input({ progress: progress({ iterationStartedAt: null }) }))
    expect(outcome.outcome).toBe('allow')
  })
})