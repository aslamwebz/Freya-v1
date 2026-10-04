import {
  SPENDING_GATE_KINDS,
  isSpendingGateKind,
  type EnterpriseRefusalCode,
  type SpendingGateKind,
  type SpendingLimits,
} from './types'
import type { SpendingGateInput } from './ports'

/**
 * Spending gates: the hard financial walls of this phase.
 *
 * Three properties do the real work here.
 *
 * **Integer minor units, everywhere.** No amount in this file is a float. `0.1 + 0.2`
 * is greater than `0.3` in IEEE 754, so a float gate can refuse an action that is
 * exactly at the limit and — much worse — admit one that is exactly over it. Amounts
 * arrive as integer minor units and a non-integer is refused rather than rounded,
 * because a rounded ceiling is not the ceiling the owner set.
 *
 * **No currency conversion, ever.** A gate holds amounts in exactly one currency. An
 * action denominated in anything else is refused with `spending-currency-mismatch`
 * rather than converted, because there is no exchange rate in this subsystem, no
 * source for one, and inventing one would mean the gate was comparing two numbers
 * that do not mean the same thing. Refusing is the honest answer and it is also the
 * cheap one.
 *
 * **The gates only ever close.** A gate result carries the projected spend it was
 * evaluated against, so an auditor can reconstruct why an action was allowed by
 * replaying three integers. Nothing in this file can raise a limit.
 *
 * Pure. No clock, no journal, no provider, no payment route of any kind.
 */

export interface SpendingDecision {
  readonly held: boolean
  readonly gate: SpendingGateKind | null
  readonly limitMinor: number
  readonly projectedMinor: number
  readonly code: EnterpriseRefusalCode | null
  readonly reason: string
}

const HELD = (
  gate: SpendingGateKind,
  limitMinor: number,
  projectedMinor: number,
  reason: string,
): SpendingDecision => ({
  held: true,
  gate,
  limitMinor,
  projectedMinor,
  code: null,
  reason,
})

const REFUSED = (
  gate: SpendingGateKind,
  limitMinor: number,
  projectedMinor: number,
  code: EnterpriseRefusalCode,
  reason: string,
): SpendingDecision => ({
  held: false,
  gate,
  limitMinor,
  projectedMinor,
  code,
  reason,
})

/** An ISO-4217-shaped currency: exactly three ASCII letters. */
const CURRENCY_PATTERN = /^[A-Z]{3}$/

export function isCurrency(value: unknown): value is string {
  return typeof value === 'string' && CURRENCY_PATTERN.test(value)
}

/** A non-negative whole number of minor units. Zero is legal; a fraction is not. */
export function isMinorAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * The largest amount a limit may express.
 *
 * A structural bound, not an economic policy: it exists so that "owner-set" cannot be
 * satisfied with `Infinity`, `Number.MAX_SAFE_INTEGER` or `NaN`, all of which are
 * numbers and all of which would make the gate a no-op. One hundred thousand units of
 * the environment's own currency is far above any plausible zero-real-capital Phase 33
 * budget and far below anything that would break arithmetic.
 */
export const MAX_SPENDING_LIMIT_MINOR = 100_000_000

export interface SpendingLimitsReading {
  readonly ok: boolean
  readonly limits: SpendingLimits | null
  readonly code: EnterpriseRefusalCode | null
  readonly reason: string
}

/**
 * Validate an owner-supplied set of spending limits.
 *
 * Fails closed on anything unrepresentable. `hardCeiling: false` is refused rather
 * than honoured, because the phase specifies the ceiling as hard and a record that
 * says otherwise is not a softer limit — it is a malformed record, and treating it as
 * a soft limit would quietly introduce the exact "hidden spending" property the phase
 * forbids.
 */
export function readSpendingLimits(input: unknown): SpendingLimitsReading {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>

  const fields: readonly (keyof Omit<SpendingLimits, 'currency' | 'hardCeiling'>)[] = [
    'maxTotalSpend',
    'maxPerAction',
    'maxPerDay',
  ]
  for (const field of fields) {
    const value = raw[field]
    if (!isMinorAmount(value)) {
      return {
        ok: false,
        limits: null,
        code: 'spending-amount-invalid',
        reason: `${field} must be a whole number of minor units. Fractions, negatives, Infinity and NaN are refused rather than rounded.`,
      }
    }
    if (value > MAX_SPENDING_LIMIT_MINOR) {
      return {
        ok: false,
        limits: null,
        code: 'spending-amount-invalid',
        reason: `${field} is above the largest amount a limit can express, so it is refused rather than clamped.`,
      }
    }
  }
  if (!isCurrency(raw.currency)) {
    return {
      ok: false,
      limits: null,
      code: 'spending-currency-mismatch',
      reason: 'currency must be a three-letter code. This subsystem converts between currencies nowhere.',
    }
  }
  if (raw.hardCeiling !== true) {
    return {
      ok: false,
      limits: null,
      code: 'spending-amount-invalid',
      reason:
        'hardCeiling must be true. A soft ceiling is not a softer limit, it is an unbounded one.',
    }
  }

  const limits = raw as unknown as SpendingLimits
  if (limits.maxPerAction > limits.maxTotalSpend) {
    return {
      ok: false,
      limits: null,
      code: 'spending-amount-invalid',
      reason:
        'maxPerAction is above maxTotalSpend, so the per-action ceiling could never bind before the total did.',
    }
  }
  if (limits.maxPerDay > limits.maxTotalSpend) {
    return {
      ok: false,
      limits: null,
      code: 'spending-amount-invalid',
      reason:
        'maxPerDay is above maxTotalSpend, so the daily ceiling could never bind before the total did.',
    }
  }

  return {
    ok: true,
    limits: Object.freeze({
      maxTotalSpend: limits.maxTotalSpend,
      maxPerAction: limits.maxPerAction,
      maxPerDay: limits.maxPerDay,
      currency: limits.currency,
      hardCeiling: true,
    }),
    code: null,
    reason: 'Spending limits are whole minor units in a single currency with a hard ceiling.',
  }
}

/* -------------------------------------------------------------- the ledger */

/**
 * What an environment has spent, as derived from the journal.
 *
 * A plain total plus a per-day map, because the per-day gate is a different question
 * from the total gate and both have to be answerable without scanning history.
 */
export interface SpendingLedger {
  readonly totalMinor: number
  readonly currency: string
  readonly byDay: Readonly<Record<string, number>>
  /** Bounded so a long-lived environment cannot grow the fold's memory without limit. */
  readonly daysRetained: readonly string[]
}

/** How many day buckets are retained before the oldest is dropped. */
export const MAX_SPENDING_DAYS_RETAINED = 400

export function emptyLedger(currency: string): SpendingLedger {
  return Object.freeze({
    totalMinor: 0,
    currency,
    byDay: Object.freeze({}),
    daysRetained: Object.freeze([]),
  })
}

/**
 * The UTC day key for an instant, as `YYYY-MM-DD`.
 *
 * Derived from the string rather than from a clock so the whole gate stays pure. UTC
 * rather than local deliberately: a per-day ceiling that moves when the owner's
 * machine changes timezone is a ceiling with a hole in it.
 */
export function dayKeyOf(instant: string): string | null {
  const parsed = Date.parse(instant)
  if (!Number.isFinite(parsed)) return null
  return new Date(parsed).toISOString().slice(0, 10)
}

/**
 * Add a spend to the ledger.
 *
 * Ignores a negative or non-integer amount rather than subtracting it, because a
 * negative "spend" is a refund arriving through the front door and would let an
 * environment's total be driven below zero by an action that was supposed to cost
 * something.
 */
export function accumulateSpend(
  ledger: SpendingLedger,
  instant: string,
  amountMinor: number,
): SpendingLedger {
  if (!isMinorAmount(amountMinor) || amountMinor === 0) return ledger
  const day = dayKeyOf(instant)
  if (day === null) return ledger

  const byDay: Record<string, number> = { ...ledger.byDay, [day]: (ledger.byDay[day] ?? 0) + amountMinor }
  let days = [...ledger.daysRetained, day]
  if (days.length > MAX_SPENDING_DAYS_RETAINED) {
    days = days.slice(days.length - MAX_SPENDING_DAYS_RETAINED)
    for (const key of days) {
      if (!days.includes(key)) delete byDay[key]
    }
    const keep = new Set(days)
    for (const key of Object.keys(byDay)) {
      if (!keep.has(key)) delete byDay[key]
    }
  }
  return Object.freeze({
    totalMinor: ledger.totalMinor + amountMinor,
    currency: ledger.currency,
    byDay: Object.freeze(byDay),
    daysRetained: Object.freeze(days),
  })
}

/** What a day has cost so far. Zero for a day with no history. */
export function spentOnDay(ledger: SpendingLedger, dayKey: string): number {
  return ledger.byDay[dayKey] ?? 0
}

/* -------------------------------------------------------------- the gates */

/**
 * One gate, checked against one amount.
 *
 * The comparison is `projected > limit`, not `>=`: an action that lands exactly on the
 * ceiling is inside it. The refusal therefore happens one action later than a reader
 * might expect, and that is the correct behaviour for a ceiling rather than a quota.
 */
export function checkSpendingGate(input: SpendingGateInput): SpendingDecision {
  if (!isSpendingGateKind(input.gate)) {
    return REFUSED(
      'total',
      0,
      0,
      'spending-amount-invalid',
      'The gate named is not one of the three spending gates.',
    )
  }
  if (!isMinorAmount(input.limitMinor) || !isMinorAmount(input.spentMinor)) {
    return REFUSED(
      input.gate,
      0,
      0,
      'spending-amount-invalid',
      'A limit or a running total is not a whole number of minor units, so no comparison is trustworthy.',
    )
  }
  if (!isMinorAmount(input.amountMinor)) {
    return REFUSED(
      input.gate,
      input.limitMinor,
      input.spentMinor,
      'spending-amount-invalid',
      'The requested amount is not a whole number of minor units. Fractions are refused, never rounded.',
    )
  }
  if (!isCurrency(input.currency) || !isCurrency(input.actionCurrency)) {
    return REFUSED(
      input.gate,
      input.limitMinor,
      input.spentMinor,
      'spending-currency-mismatch',
      'A spending gate holds one currency and this action does not name a valid one.',
    )
  }
  if (input.actionCurrency !== input.currency) {
    return REFUSED(
      input.gate,
      input.limitMinor,
      input.spentMinor,
      'spending-currency-mismatch',
      `This gate holds ${input.currency} and the action is denominated in ${input.actionCurrency}. There is no conversion here, so the action is refused.`,
    )
  }

  const projected = input.spentMinor + input.amountMinor
  const unit = ` ${input.currency}`
  const ceiling = input.limitMinor

  switch (input.gate) {
    case 'per-action':
      if (input.amountMinor > ceiling) {
        return REFUSED(
          'per-action',
          ceiling,
          projected,
          'spending-per-action-exceeded',
          `This action costs ${String(input.amountMinor)}${unit} against a per-action ceiling of ${String(ceiling)}${unit}.`,
        )
      }
      return HELD(
        'per-action',
        ceiling,
        projected,
        `This action costs ${String(input.amountMinor)}${unit}, within the per-action ceiling of ${String(ceiling)}${unit}.`,
      )
    case 'per-day':
      if (projected > ceiling) {
        return REFUSED(
          'per-day',
          ceiling,
          projected,
          'spending-per-day-exceeded',
          `This would bring today to ${String(projected)}${unit}, past the daily ceiling of ${String(ceiling)}${unit}.`,
        )
      }
      return HELD(
        'per-day',
        ceiling,
        projected,
        `This would bring today to ${String(projected)}${unit}, within the daily ceiling of ${String(ceiling)}${unit}.`,
      )
    case 'total':
      if (projected > ceiling) {
        return REFUSED(
          'total',
          ceiling,
          projected,
          'spending-total-exceeded',
          `This would bring the environment to ${String(projected)}${unit}, past its total ceiling of ${String(ceiling)}${unit}.`,
        )
      }
      return HELD(
        'total',
        ceiling,
        projected,
        `This would bring the environment to ${String(projected)}${unit}, within its total ceiling of ${String(ceiling)}${unit}.`,
      )
  }
}

/**
 * All three gates, in the order they are named in the specification.
 *
 * Returns the *first* refusal rather than a list, so the refusal that reaches the
 * owner is a specific sentence about one gate instead of a compound one. Per-action is
 * evaluated first because it is the only gate that can be decided without any history,
 * and refusing on it costs nothing to compute.
 */
export function checkAllSpendingGates(
  limits: SpendingLimits,
  ledger: SpendingLedger,
  amountMinor: number,
  dayKey: string,
): SpendingDecision {
  const base = {
    currency: limits.currency,
    actionCurrency: limits.currency,
    amountMinor,
  }
  const gates: readonly { readonly gate: SpendingGateKind; readonly limitMinor: number; readonly spentMinor: number }[] = [
    { gate: 'per-action', limitMinor: limits.maxPerAction, spentMinor: 0 },
    { gate: 'per-day', limitMinor: limits.maxPerDay, spentMinor: spentOnDay(ledger, dayKey) },
    { gate: 'total', limitMinor: limits.maxTotalSpend, spentMinor: ledger.totalMinor },
  ]

  for (const gate of gates) {
    const decision = checkSpendingGate({ ...base, ...gate })
    if (!decision.held) return decision
  }
  const last = gates[gates.length - 1]
  return HELD(
    'total',
    last?.limitMinor ?? 0,
    ledger.totalMinor + amountMinor,
    `This stays inside all three ceilings: per action, per day and total, all in ${limits.currency}.`,
  )
}

/** The three gates as a closed tuple, for the audit and for the journal vocabulary. */
export function spendingGateKinds(): readonly SpendingGateKind[] {
  return SPENDING_GATE_KINDS
}