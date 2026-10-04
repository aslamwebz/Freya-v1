import { SOVEREIGNTY_LIMITS, type SovereigntyLimitRequest, type SovereigntyLimits } from './types'

export function defaultSovereigntyLimits(): SovereigntyLimits {
  return SOVEREIGNTY_LIMITS
}

export function narrowSovereigntyLimits(request?: SovereigntyLimitRequest): SovereigntyLimits {
  if (request === undefined || request === null || typeof request !== 'object') {
    return SOVEREIGNTY_LIMITS
  }

  const narrowed: Record<string, number> = {}
  for (const key of Object.keys(SOVEREIGNTY_LIMITS) as (keyof SovereigntyLimits)[]) {
    narrowed[key] = clamp(request[key], SOVEREIGNTY_LIMITS[key])
  }
  return Object.freeze(narrowed) as SovereigntyLimits
}

function clamp(requested: unknown, ceiling: number): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return ceiling
  if (requested <= 0) return 0
  const floored = Math.floor(requested)
  return floored < ceiling ? floored : ceiling
}

export function narrowedLimitNames(limits: SovereigntyLimits): readonly string[] {
  return (Object.keys(SOVEREIGNTY_LIMITS) as (keyof SovereigntyLimits)[]).filter(
    (key) => limits[key] < SOVEREIGNTY_LIMITS[key],
  )
}
