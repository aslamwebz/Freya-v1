import { describe, expect, it } from 'vitest'
import {
  DEADLINE_DEFAULT_MS,
  LIFE_LOOP_LIMITS,
  backoffDelayMs,
  defaultRetryCeiling,
  enforceDeadline,
  isExpired,
  narrowLifeLoopLimits,
  narrowRetryCeiling,
  nextRetry,
  remainingMs,
  resolveDeadline,
  retryCeilingReached,
} from '../../../core/lifeloop'
import { T0, T_PLUS_1M, T_PLUS_16M } from './fixture'

describe('deadlines are absolute instants', () => {
  it('measures from when the wait began, not from when it is checked', () => {
    // The distinction the whole module rests on. A relative deadline is extended
    // by every restart, so a 24-hour verification ceiling that restarts with the
    // app is not a ceiling at all.
    const deadline = resolveDeadline('verification', T0)
    expect(deadline.expiresAt).toBe('2026-03-02T09:00:00.000Z')
    expect(remainingMs(deadline, T0)).toBe(DEADLINE_DEFAULT_MS.verification)
    expect(remainingMs(deadline, T_PLUS_16M)).toBe(DEADLINE_DEFAULT_MS.verification - 16 * 60_000)
  })

  it('gives every deadline type a finite default', () => {
    for (const [type, span] of Object.entries(DEADLINE_DEFAULT_MS)) {
      const deadline = resolveDeadline(type as keyof typeof DEADLINE_DEFAULT_MS, T0)
      expect(Number.isFinite(span), type).toBe(true)
      expect(deadline.expiresAt, type).toBe(new Date(Date.parse(T0) + span).toISOString())
      expect(deadline.reason.length, type).toBeGreaterThan(0)
    }
  })

  it('never reports a negative amount of time left', () => {
    const deadline = resolveDeadline('action', T0)
    expect(remainingMs(deadline, '2026-06-01T00:00:00.000Z')).toBe(0)
  })

  it('treats a malformed deadline as already expired rather than as open-ended', () => {
    // Fail closed. A deadline that cannot be read is not a deadline that lasts
    // forever, and "cannot be read" must never be the comfortable answer.
    const broken = { type: 'wait' as const, expiresAt: 'whenever', reason: 'x' }
    expect(isExpired(broken, T0)).toBe(true)
    expect(remainingMs(broken, T0)).toBe(0)
  })

  it('fails closed on an unusable start instant instead of waiting forever', () => {
    const deadline = resolveDeadline('action', 'not-a-time')
    expect(isExpired(deadline, T0)).toBe(true)
  })

  it('shortens, never lengthens, when the caller has narrowed the limits', () => {
    const narrowed = narrowLifeLoopLimits({ maxWaitMs: 60_000 })
    const deadline = resolveDeadline('wait', T0, narrowed)
    expect(deadline.expiresAt).toBe(new Date(Date.parse(T0) + 60_000).toISOString())
  })
})

describe('limits can only ever narrow', () => {
  it('ignores a request to widen a ceiling', () => {
    // The single most important property of this file. There is no code path —
    // not configuration, not a payload, not a grant — that raises a bound, so
    // "bounded everywhere" is a property of the module and not of diligence.
    const hostile = narrowLifeLoopLimits({
      maxLoopIterations: 1_000_000,
      maxActionsPerIteration: Number.MAX_SAFE_INTEGER,
      maxWaitMs: 10 ** 15,
      maxBackoffMs: 10 ** 12,
      baseBackoffMs: 60_000,
      maxCognitionRequestsPerWake: 999,
    })
    expect(hostile).toEqual(LIFE_LOOP_LIMITS)
  })

  it('honours a request to tighten a ceiling', () => {
    expect(narrowLifeLoopLimits({ maxLoopIterations: 3 }).maxLoopIterations).toBe(3)
  })

  it('treats a malformed request as absent rather than as a bound', () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '5', null, {}]) {
      expect(narrowLifeLoopLimits({ maxLoopIterations: value as never }).maxLoopIterations).toBe(
        LIFE_LOOP_LIMITS.maxLoopIterations,
      )
    }
  })

  it('returns a frozen object, so a caller cannot widen it after the fact', () => {
    const limits = narrowLifeLoopLimits({ maxLoopIterations: 2 })
    expect(Object.isFrozen(limits)).toBe(true)
  })
})

describe('deadline enforcement', () => {
  it('reports an expired deadline as a failure even when nothing else objected', () => {
    const deadline = resolveDeadline('action', T0)
    const outcome = enforceDeadline(deadline, T_PLUS_16M)
    expect(outcome.ok).toBe(false)
    expect(outcome.code).toBe('deadline-expired')
  })

  it('reports the deadline before the attempt count, because time ran out first', () => {
    const deadline = resolveDeadline('action', T0)
    const outcome = enforceDeadline(deadline, T_PLUS_16M, { attempts: 99, maxAttempts: 3 })
    expect(outcome.code).toBe('deadline-expired')
  })

  it('reports the attempt ceiling once time is no longer the problem', () => {
    const outcome = enforceDeadline(null, T0, { attempts: 3, maxAttempts: 3 })
    expect(outcome.ok).toBe(false)
    expect(outcome.code).toBe('limit-attempts')
  })

  it('reports the action ceiling and the duration ceiling by name', () => {
    expect(enforceDeadline(null, T0, { attempts: 0, maxAttempts: 3, actions: 5, maxActions: 5 }).code).toBe(
      'limit-actions',
    )
    expect(
      enforceDeadline(null, T0, { attempts: 0, maxAttempts: 3, durationMs: 10, maxDurationMs: 10 }).code,
    ).toBe('limit-duration')
  })

  it('allows work that is inside every bound', () => {
    const outcome = enforceDeadline(resolveDeadline('action', T0), T_PLUS_1M, { attempts: 1, maxAttempts: 3 })
    expect(outcome.ok).toBe(true)
    expect(outcome.code).toBeNull()
  })

  it('reports a failure with a fixed sentence, never with the event that caused it', () => {
    const outcome = enforceDeadline(null, T0, { attempts: 3, maxAttempts: 3 })
    expect(outcome.reason).toBe('This had been tried the maximum number of times.')
  })
})

describe('backoff grows, and stops growing', () => {
  const ceiling = defaultRetryCeiling()

  it('doubles each attempt, with the jitter sample added', () => {
    expect(backoffDelayMs(1, 0, ceiling)).toBe(1_000)
    expect(backoffDelayMs(2, 0, ceiling)).toBe(2_000)
    expect(backoffDelayMs(3, 0, ceiling)).toBe(4_000)
    expect(backoffDelayMs(3, 500, ceiling)).toBe(4_500)
  })

  it('never exceeds the ceiling, however many attempts have passed', () => {
    for (const attempt of [1, 5, 20, 64, 1_000, 1_000_000, Number.MAX_SAFE_INTEGER]) {
      expect(backoffDelayMs(attempt, ceiling.jitterMs, ceiling), String(attempt)).toBeLessThanOrEqual(
        LIFE_LOOP_LIMITS.maxBackoffMs,
      )
    }
  })

  it('clamps a hostile jitter sample into the jitter window instead of adding it', () => {
    // An attacker who controls the number of retries also controls this number.
    // Without a clamp, `Number.MAX_SAFE_INTEGER` of "jitter" is an unbounded wait.
    // The clamp is to `jitterMs`, not to `maxBackoffMs` — the jitter window is
    // what jitter is allowed to be, and a sample beyond it is not jitter at all.
    expect(backoffDelayMs(1, Number.MAX_SAFE_INTEGER, ceiling)).toBe(1_000 + ceiling.jitterMs)
    expect(backoffDelayMs(1, -500, ceiling)).toBe(1_000)
    expect(backoffDelayMs(1, Number.NaN, ceiling)).toBe(1_000)
  })

  it('still cannot exceed the ceiling when both the exponent and the jitter are maximal', () => {
    expect(backoffDelayMs(1_000_000, Number.MAX_SAFE_INTEGER, ceiling)).toBe(LIFE_LOOP_LIMITS.maxBackoffMs)
  })

  it('clamps the exponent so an absurd attempt count cannot produce Infinity', () => {
    expect(Number.isFinite(backoffDelayMs(1_000_000, 0, ceiling))).toBe(true)
  })
})

describe('whether to retry is answered by a counter, never by a judgement', () => {
  it('counts down to the ceiling and then refuses', () => {
    let ceilingNow = defaultRetryCeiling()
    const delays: number[] = []
    for (let attempt = 0; attempt < LIFE_LOOP_LIMITS.maxAttemptsPerUnit; attempt += 1) {
      const decision = nextRetry(ceilingNow, 0)
      expect(decision.retry, `attempt ${attempt}`).toBe(true)
      if (!decision.retry) break
      delays.push(decision.delayMs)
      ceilingNow = decision.ceiling
    }
    // Three attempts, doubling each time, and then nothing more — ever.
    expect(delays).toEqual([1_000, 2_000, 4_000])
    const refused = nextRetry(ceilingNow, 0)
    expect(refused.retry).toBe(false)
    if (!refused.retry) expect(refused.code).toBe('limit-attempts')
  })

  it('counts an attempt as spent the moment it is issued', () => {
    const first = nextRetry(defaultRetryCeiling(), 0)
    expect(first.retry).toBe(true)
    if (!first.retry) return
    expect(first.ceiling.currentAttempt).toBe(1)
    expect(retryCeilingReached(first.ceiling)).toBe(false)
    const second = nextRetry(first.ceiling, 0)
    expect(second.retry).toBe(true)
    if (!second.retry) return
    expect(second.ceiling.currentAttempt).toBe(2)
    // The third call is the last one the ceiling permits.
    const third = nextRetry(second.ceiling, 0)
    if (!third.retry) return
    expect(retryCeilingReached(third.ceiling)).toBe(true)
    expect(nextRetry(third.ceiling, 0).retry).toBe(false)
  })

  it('cannot be widened by a caller asking for more attempts or a longer delay', () => {
    const widened = narrowRetryCeiling(defaultRetryCeiling(), {
      maxAttempts: 10_000,
      maxBackoffMs: 10 ** 12,
      baseBackoffMs: 60_000,
      jitterMs: 10 ** 9,
    })
    expect(widened).toEqual(defaultRetryCeiling())
  })

  it('honours a caller that wants fewer attempts', () => {
    const tightened = narrowRetryCeiling(defaultRetryCeiling(), { maxAttempts: 1 })
    expect(tightened.maxAttempts).toBe(1)
    // One retry is permitted; the second is refused on the counter, not on a view.
    const first = nextRetry(tightened, 0)
    expect(first.retry).toBe(true)
    if (!first.retry) return
    expect(nextRetry(first.ceiling, 0).retry).toBe(false)
  })
})