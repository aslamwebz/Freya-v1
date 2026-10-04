/**
 * The Phase 31 seam for resilience.
 *
 * Phase 36 depends on Phase 31's long-horizon autonomy for event-sourced
 * recovery and restart continuity. The dependency is declared narrow,
 * default-empty and unable to drive anything until somebody supplies an
 * implementation.
 */

/**
 * The long-horizon seam interface.
 */
export interface LongHorizonSeam {
  readonly name: string
  goalsFor(experimentId: string): readonly string[]
  wakeFor(goalRef: string, now: string): { readonly source: string; readonly kind: string } | null
}

/**
 * The inert seam: no long-horizon subsystem connected.
 */
export const NO_LONG_HORIZON_SEAM: LongHorizonSeam = Object.freeze({
  name: 'none',
  goalsFor: () => [],
  wakeFor: () => null,
})

/**
 * Whether the seam is connected.
 */
export function isSeamConnected(seam: LongHorizonSeam): boolean {
  return seam.name !== 'none'
}

/**
 * Whether a goal may be honoured.
 */
export function mayHonourGoal(
  seam: LongHorizonSeam,
  goalRef: string,
  experimentId: string,
): boolean {
  return isSeamConnected(seam) && seam.goalsFor(experimentId).includes(goalRef)
}
