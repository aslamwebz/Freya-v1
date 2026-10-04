import { EVOLUTION_LIMITS, type EvolutionLimitRequest, type EvolutionLimits } from './types'

export function defaultEvolutionLimits(): EvolutionLimits {
  return EVOLUTION_LIMITS
}

export function narrowEvolutionLimits(request?: EvolutionLimitRequest): EvolutionLimits {
  if (request === undefined || request === null || typeof request !== 'object') {
    return EVOLUTION_LIMITS
  }

  const narrowed: Record<string, number> = {}
  for (const key of Object.keys(EVOLUTION_LIMITS) as (keyof EvolutionLimits)[]) {
    narrowed[key] = clamp(request[key], EVOLUTION_LIMITS[key])
  }
  return Object.freeze(narrowed) as EvolutionLimits
}

function clamp(requested: unknown, ceiling: number): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return ceiling
  if (requested <= 0) return 0
  const floored = Math.floor(requested)
  return floored < ceiling ? floored : ceiling
}

export function narrowedLimitNames(limits: EvolutionLimits): readonly string[] {
  return (Object.keys(EVOLUTION_LIMITS) as (keyof EvolutionLimits)[]).filter(
    (key) => limits[key] < EVOLUTION_LIMITS[key],
  )
}
