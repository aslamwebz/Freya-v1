import { RESILIENCE_LIMITS, type ResilienceLimitRequest, type ResilienceLimits } from './types'

/**
 * The clamp on the ceilings.
 *
 * There is exactly one way to configure the resilience subsystem and it can
 * only ever make things smaller. That is not a limitation of the
 * implementation — it is the property the whole phase rests on, and it is why
 * the request type is deliberately untyped as to value.
 */
export function defaultResilienceLimits(): ResilienceLimits {
  return RESILIENCE_LIMITS
}

/**
 * Clamp a request against the ceilings.
 *
 * Total and total-returning: it cannot throw and it cannot produce a value
 * that is absent, non-finite or negative.
 */
export function narrowResilienceLimits(request?: ResilienceLimitRequest): ResilienceLimits {
  if (request === undefined || request === null || typeof request !== 'object') {
    return RESILIENCE_LIMITS
  }

  const narrowed: Record<string, number> = {}
  for (const key of Object.keys(RESILIENCE_LIMITS) as (keyof ResilienceLimits)[]) {
    narrowed[key] = clamp(request[key], RESILIENCE_LIMITS[key])
  }
  return Object.freeze(narrowed) as ResilienceLimits
}

/**
 * Clamp one requested ceiling.
 */
function clamp(requested: unknown, ceiling: number): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return ceiling
  if (requested <= 0) return 0
  const floored = Math.floor(requested)
  return floored < ceiling ? floored : ceiling
}

/**
 * Has this limit been narrowed at all?
 */
export function narrowedLimitNames(limits: ResilienceLimits): readonly string[] {
  return (Object.keys(RESILIENCE_LIMITS) as (keyof ResilienceLimits)[]).filter(
    (key) => limits[key] < RESILIENCE_LIMITS[key],
  )
}
