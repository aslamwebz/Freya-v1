import { THRESHOLD_LIMITS, type ThresholdLimitRequest, type ThresholdLimits } from './types'

/**
 * The clamp on the ceilings.
 *
 * There is exactly one way to configure the threshold subsystem and it can
 * only ever make things smaller. That is not a limitation of the
 * implementation — it is the property the whole phase rests on, and it is why
 * the request type is deliberately untyped as to value.
 */
export function defaultThresholdLimits(): ThresholdLimits {
  return THRESHOLD_LIMITS
}

/**
 * Clamp a request against the ceilings.
 *
 * Total and total-returning: it cannot throw and it cannot produce a value
 * that is absent, non-finite or negative.
 */
export function narrowThresholdLimits(request?: ThresholdLimitRequest): ThresholdLimits {
  if (request === undefined || request === null || typeof request !== 'object') {
    return THRESHOLD_LIMITS
  }

  const narrowed: Record<string, number> = {}
  for (const key of Object.keys(THRESHOLD_LIMITS) as (keyof ThresholdLimits)[]) {
    narrowed[key] = clamp(request[key], THRESHOLD_LIMITS[key])
  }
  return Object.freeze(narrowed) as ThresholdLimits
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
export function narrowedLimitNames(limits: ThresholdLimits): readonly string[] {
  return (Object.keys(THRESHOLD_LIMITS) as (keyof ThresholdLimits)[]).filter(
    (key) => limits[key] < THRESHOLD_LIMITS[key],
  )
}
