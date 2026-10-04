import { ECONOMIC_LIMITS, type EconomicLimitRequest, type EconomicLimits } from './types'

/**
 * The clamp on the ceilings.
 *
 * There is exactly one way to configure the economic subsystem and it can only ever
 * make things smaller. That is not a limitation of the implementation — it is the
 * property the whole phase rests on, and it is why the request type is deliberately
 * untyped as to value: see `ECONOMIC_LIMITS` in `types.ts`.
 *
 * The interesting cases are all hostile ones, and they are all here rather than
 * assumed:
 *
 *   - a request **wider** than the ceiling is clamped to the ceiling, not applied and
 *     not refused. Refusing would be tidier and worse: a host that passed a generous
 *     limit would find the subsystem switched off, and the natural response to that is
 *     to pass a smaller one, which is a loop nobody wants to be in.
 *   - a request that is **not a finite number** falls back to the ceiling. `NaN`
 *     clamped naively is `NaN`, and a bound that is `NaN` is no bound at all.
 *   - a request of **zero** is honoured, because "this deployment may not simulate
 *     anything" is a legitimate and important configuration and refusing it would mean
 *     the only way to express it was to switch the subsystem off.
 *   - a request that is **negative or fractional** is floored at zero, because a
 *     negative ceiling would make every action instantly over budget and a fractional
 *     one is not a count.
 */

/** The frozen ceilings, as the fallback for anything a request cannot improve on. */
export function defaultEconomicLimits(): EconomicLimits {
  return ECONOMIC_LIMITS
}

/**
 * Clamp a request against the ceilings.
 *
 * Total and total-returning: it cannot throw and it cannot produce a value that is
 * absent, non-finite or negative. Every key in the request is handled, and every key
 * not in the request keeps the ceiling.
 */
export function narrowEconomicLimits(request?: EconomicLimitRequest): EconomicLimits {
  if (request === undefined || request === null || typeof request !== 'object') {
    return ECONOMIC_LIMITS
  }

  const narrowed: Record<string, number> = {}
  for (const key of Object.keys(ECONOMIC_LIMITS) as (keyof EconomicLimits)[]) {
    narrowed[key] = clamp(request[key], ECONOMIC_LIMITS[key])
  }
  return Object.freeze(narrowed) as EconomicLimits
}

/**
 * Clamp one requested ceiling.
 *
 * `typeof number` first, because `Number.isFinite('10')` is false and the coercion
 * would silently accept a string — and a limit that arrived as a string is a limit that
 * arrived from somewhere that was not paying attention.
 */
function clamp(requested: unknown, ceiling: number): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return ceiling
  if (requested <= 0) return 0
  const floored = Math.floor(requested)
  return floored < ceiling ? floored : ceiling
}

/**
 * Has this limit been narrowed at all?
 *
 * Exists so a surface can say "this deployment runs with narrower ceilings than the
 * code-owned ones" rather than showing sixteen numbers and letting a reader assume
 * they are the defaults. Cheap, and it is the difference between a bound that is
 * legible and one that is merely present.
 */
export function narrowedLimitNames(limits: EconomicLimits): readonly string[] {
  return (Object.keys(ECONOMIC_LIMITS) as (keyof EconomicLimits)[]).filter(
    (key) => limits[key] < ECONOMIC_LIMITS[key],
  )
}