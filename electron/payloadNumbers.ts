/** Preserve missing/invalid/bounded tri-state values without inventing defaults. */
export function readBoundedNumber(
  record: Record<string, unknown> | null,
  key: string,
  min: number,
  max: number,
): number | null | undefined {
  const value = record?.[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value < min || value > max) return null
  return value
}
