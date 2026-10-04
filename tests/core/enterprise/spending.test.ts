import { describe, expect, it } from 'vitest'
import {
  ENTERPRISE_LIMITS,
  MAX_SPENDING_LIMIT_MINOR,
  accumulateSpend,
  checkAllSpendingGates,
  checkSpendingGate,
  dayKeyOf,
  emptyLedger,
  isMinorAmount,
  readSpendingLimits,
  spentOnDay,
  type SpendingLimits,
} from '../../../core/enterprise'
import { LIMITS, T0, limits } from './harness'

/**
 * Spending gates.
 *
 * Two claims are tested here that are easy to state and easy to get wrong:
 *
 *   1. **Integer minor units, never floats.** A float ceiling can refuse an action that
 *      is exactly at the limit and can admit one exactly over it, and a test suite
 *      written in whole cents will never notice. So the float cases are explicit here.
 *   2. **No currency conversion, ever.** There is no exchange rate in this subsystem
 *      and no source for one, so a differently-denominated action is refused rather
 *      than converted. Refusing is both the honest and the cheap answer.
 */

describe('amounts must be whole minor units', () => {
  it('accepts zero and positive integers', () => {
    for (const value of [0, 1, 99, 100, 2500, 10_000]) {
      expect(isMinorAmount(value), String(value)).toBe(true)
    }
  })

  it('refuses a fraction rather than rounding it', () => {
    // Rounding a ceiling is not the ceiling the owner set.
    for (const value of [0.1, 2.5, 99.999, Number.NaN]) {
      expect(isMinorAmount(value), String(value)).toBe(false)
    }
  })

  it('accepts -0, which is zero and not a negative amount', () => {
    // Worth pinning: `Object.is(-0, -0)` is true but `-0 < 0` is false, so -0 takes
    // the zero path here. A future "reject anything negative-looking" change would
    // break this, and it should break loudly rather than quietly refuse real spends.
    expect(isMinorAmount(-0)).toBe(true)
  })

  it('refuses negatives, Infinity and NaN', () => {
    for (const value of [-1, -2500, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(isMinorAmount(value), String(value)).toBe(false)
    }
  })
})

describe('the classic float failure cannot happen here', () => {
  it('holds an action that lands exactly on the ceiling', () => {
    // 0.1 + 0.2 > 0.3 in IEEE 754. In minor units the same sum is 30 and the
    // comparison is exact, so an action that costs exactly the limit is inside it.
    const decision = checkSpendingGate({
      gate: 'per-action',
      limitMinor: 30,
      spentMinor: 0,
      amountMinor: 30,
      currency: 'USD',
      actionCurrency: 'USD',
    })
    expect(decision.held).toBe(true)
    expect(decision.projectedMinor).toBe(30)
  })

  it('refuses one minor unit over, not one arbitrary epsilon over', () => {
    const decision = checkSpendingGate({
      gate: 'per-action',
      limitMinor: 30,
      spentMinor: 0,
      amountMinor: 31,
      currency: 'USD',
      actionCurrency: 'USD',
    })
    expect(decision.held).toBe(false)
    expect(decision.code).toBe('spending-per-action-exceeded')
  })

  it('never compares a fractional amount, so it refuses rather than guesses', () => {
    const decision = checkSpendingGate({
      gate: 'per-action',
      limitMinor: 30,
      spentMinor: 0,
      amountMinor: 0.1 + 0.2,
      currency: 'USD',
      actionCurrency: 'USD',
    })
    expect(decision.held).toBe(false)
    expect(decision.code).toBe('spending-amount-invalid')
  })
})

describe('all three gates must hold, and each says so', () => {
  const ledger = emptyLedger('USD')

  it('refuses on the per-action gate first, because it needs no history', () => {
    const decision = checkAllSpendingGates(limits(), ledger, 3_000, '2026-05-01')
    expect(decision.gate).toBe('per-action')
    expect(decision.code).toBe('spending-per-action-exceeded')
  })

  it('refuses on the daily gate for an amount that is fine per-action', () => {
    const spent = accumulateSpend(emptyLedger('USD'), T0, 4_000)
    const decision = checkAllSpendingGates(limits(), spent, 2_000, dayKeyOf(T0) ?? '')
    expect(decision.gate).toBe('per-day')
    expect(decision.code).toBe('spending-per-day-exceeded')
  })

  it('refuses on the total gate across days, each inside its own daily ceiling', () => {
    const spent = accumulateSpend(accumulateSpend(emptyLedger('USD'), T0, 4_000), '2026-05-02T09:00:00.000Z', 4_000)
    const decision = checkAllSpendingGates(limits(), spent, 2_500, '2026-05-03')
    expect(decision.gate).toBe('total')
    expect(decision.code).toBe('spending-total-exceeded')
  })

  it('allows an amount inside all three', () => {
    const decision = checkAllSpendingGates(limits(), ledger, 100, '2026-05-01')
    expect(decision.held).toBe(true)
    expect(decision.gate).toBe('total')
  })

  it('reports the projected total on the success path, so the audit can reconstruct it', () => {
    const spent = accumulateSpend(emptyLedger('USD'), T0, 1_000)
    const decision = checkAllSpendingGates(limits(), spent, 500, dayKeyOf(T0) ?? '')
    expect(decision.projectedMinor).toBe(1_500)
    expect(decision.limitMinor).toBe(LIMITS.maxTotalSpend)
  })
})

describe('there is no currency conversion in this subsystem', () => {
  const base = { gate: 'per-action' as const, limitMinor: 1_000, spentMinor: 0, amountMinor: 100 }

  it('refuses an action denominated in a different currency', () => {
    const decision = checkSpendingGate({ ...base, currency: 'USD', actionCurrency: 'EUR' })
    expect(decision.held).toBe(false)
    expect(decision.code).toBe('spending-currency-mismatch')
    // And it says why, in terms the owner can act on.
    expect(decision.reason).toContain('USD')
    expect(decision.reason).toContain('EUR')
  })

  it('refuses an action with a malformed currency rather than assuming one', () => {
    for (const currency of ['dollars', 'US', 'US$', '', 'usd', 'USDT']) {
      const decision = checkSpendingGate({ ...base, currency: 'USD', actionCurrency: currency })
      expect(decision.held, currency).toBe(false)
      expect(decision.code, currency).toBe('spending-currency-mismatch')
    }
  })
})

describe('a malformed limit is refused, not clamped into place', () => {
  it('accepts the valid shape', () => {
    expect(readSpendingLimits(LIMITS).ok).toBe(true)
  })

  it('refuses a soft ceiling, because a soft ceiling is an unbounded one', () => {
    const reading = readSpendingLimits({ ...LIMITS, hardCeiling: false })
    expect(reading.ok).toBe(false)
    expect(reading.code).toBe('spending-amount-invalid')
  })

  it('refuses a missing hardCeiling rather than defaulting it to true', () => {
    const { hardCeiling: _ignored, ...withoutFlag } = LIMITS
    expect(readSpendingLimits(withoutFlag).ok).toBe(false)
  })

  it('refuses fractional limits', () => {
    for (const field of ['maxTotalSpend', 'maxPerAction', 'maxPerDay'] as const) {
      const reading = readSpendingLimits({ ...LIMITS, [field]: 10.5 })
      expect(reading.ok, field).toBe(false)
      expect(reading.code, field).toBe('spending-amount-invalid')
    }
  })

  it('refuses Infinity, which would make the gate a no-op', () => {
    const reading = readSpendingLimits({ ...LIMITS, maxTotalSpend: Number.POSITIVE_INFINITY })
    expect(reading.ok).toBe(false)
    expect(reading.code).toBe('spending-amount-invalid')
  })

  it('refuses a limit above the largest expressible amount', () => {
    const reading = readSpendingLimits({ ...LIMITS, maxTotalSpend: MAX_SPENDING_LIMIT_MINOR + 1 })
    expect(reading.ok).toBe(false)
  })

  it('refuses a per-action ceiling above the total, which could never bind first', () => {
    const reading = readSpendingLimits({ ...LIMITS, maxPerAction: LIMITS.maxTotalSpend + 1 })
    expect(reading.ok).toBe(false)
    expect(reading.code).toBe('spending-amount-invalid')
  })

  it('refuses a daily ceiling above the total, for the same reason', () => {
    const reading = readSpendingLimits({ ...LIMITS, maxPerDay: LIMITS.maxTotalSpend + 1 })
    expect(reading.ok).toBe(false)
  })

  it('refuses a malformed currency', () => {
    for (const currency of ['', 'US', 'dollars', 'usd']) {
      expect(readSpendingLimits({ ...LIMITS, currency }).ok, currency).toBe(false)
    }
  })

  it('refuses nonsense where an object should be', () => {
    for (const input of [null, undefined, 42, 'USD', []]) {
      expect(readSpendingLimits(input).ok, String(input)).toBe(false)
    }
  })
})

describe('the ledger only ever moves up, and only by whole amounts', () => {
  it('adds to the total and the day', () => {
    const ledger = accumulateSpend(emptyLedger('USD'), T0, 250)
    expect(ledger.totalMinor).toBe(250)
    expect(spentOnDay(ledger, '2026-05-01')).toBe(250)
  })

  it('ignores a negative amount rather than subtracting it', () => {
    // A refund arriving through the front door would otherwise drive the total below
    // zero and hand the environment free budget.
    const ledger = accumulateSpend(emptyLedger('USD'), T0, -5_000)
    expect(ledger.totalMinor).toBe(0)
  })

  it('ignores a fractional amount', () => {
    expect(accumulateSpend(emptyLedger('USD'), T0, 10.5).totalMinor).toBe(0)
  })

  it('ignores zero, which is not a spend', () => {
    expect(accumulateSpend(emptyLedger('USD'), T0, 0).totalMinor).toBe(0)
  })

  it('ignores an unparseable instant rather than inventing a day bucket', () => {
    expect(accumulateSpend(emptyLedger('USD'), 'not-a-date', 100).totalMinor).toBe(0)
  })

  it('keeps day buckets bounded so a long-lived environment cannot grow without limit', () => {
    // Real ISO instants, one per day, so the instants actually parse — a hand-built
    // string like `2026-01-500T...` is not a date, and a test that used one would be
    // asserting the behaviour of a rejected input.
    const instants = dailyInstants(500)
    let ledger = emptyLedger('USD')
    for (const instant of instants) {
      ledger = accumulateSpend(ledger, instant, 1)
    }
    expect(Object.keys(ledger.byDay).length).toBeLessThanOrEqual(400)
  })

  it('still totals correctly after dropping old days', () => {
    let ledger = emptyLedger('USD')
    for (const instant of dailyInstants(500)) {
      ledger = accumulateSpend(ledger, instant, 1)
    }
    // The total is monotonic even though the day buckets are not. This is the property
    // that matters: pruning a cache must never prune the number the owner is judged by.
    expect(ledger.totalMinor).toBe(500)
  })

  it('keeps the most recent days when pruning, so today is never the one dropped', () => {
    const instants = dailyInstants(500)
    let ledger = emptyLedger('USD')
    for (const instant of instants) {
      ledger = accumulateSpend(ledger, instant, 1)
    }
    const lastDay = dayKeyOf(instants[instants.length - 1] ?? '')
    expect(lastDay).not.toBeNull()
    expect(spentOnDay(ledger, lastDay ?? '')).toBe(1)
  })
})

describe('the day key cannot be moved by a timezone change', () => {
  it('groups by UTC date', () => {
    expect(dayKeyOf('2026-05-01T00:00:00.000Z')).toBe('2026-05-01')
    expect(dayKeyOf('2026-05-01T23:59:59.999Z')).toBe('2026-05-01')
    expect(dayKeyOf('2026-05-02T00:00:00.000Z')).toBe('2026-05-02')
  })

  it('refuses an instant it cannot parse', () => {
    expect(dayKeyOf('')).toBeNull()
    expect(dayKeyOf('tomorrow')).toBeNull()
  })
})

/** `count` real ISO instants, one per day, starting 2026-01-01. */
function dailyInstants(count: number): string[] {
  const instants: string[] = []
  for (let index = 0; index < count; index += 1) {
    instants.push(new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toISOString())
  }
  return instants
}

describe('the limit the owner sets is the limit that applies', () => {
  it('uses the values the owner chose, not the phase defaults', () => {
    const generous: SpendingLimits = {
      maxTotalSpend: 50_000,
      maxPerAction: 5_000,
      maxPerDay: 10_000,
      currency: 'GBP',
      hardCeiling: true,
    }
    const decision = checkAllSpendingGates(generous, emptyLedger('GBP'), 4_000, '2026-05-01')
    expect(decision.held).toBe(true)
  })

  it('still refuses an amount the owner never allowed, however generous the rest', () => {
    const generous: SpendingLimits = {
      maxTotalSpend: 50_000,
      maxPerAction: 5_000,
      maxPerDay: 10_000,
      currency: 'GBP',
      hardCeiling: true,
    }
    const decision = checkAllSpendingGates(generous, emptyLedger('GBP'), 5_001, '2026-05-01')
    expect(decision.code).toBe('spending-per-action-exceeded')
  })

  it('exposes the phase ceiling for the structural bound it documents', () => {
    expect(ENTERPRISE_LIMITS.maxEnvironments).toBeGreaterThan(0)
    expect(MAX_SPENDING_LIMIT_MINOR).toBeGreaterThan(LIMITS.maxTotalSpend)
  })
})