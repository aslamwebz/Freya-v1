/**
 * What the Brain is currently doing, read from Core.
 *
 * The Brain has no personality (uiplan.md:402–438): it expresses cognition, and
 * only when cognition is real. This mapping is deliberately a pure function of
 * facts Core already reports, so the visualization cannot claim activity that is
 * not happening.
 */
export type BrainState =
  | 'calm'
  | 'thinking'
  | 'researching'
  | 'delegating'
  | 'load'
  | 'success'
  | 'uncertainty'

export interface BrainInput {
  /** Core's active provider calls. */
  readonly activeRequests: number
  /** Workers Core reports as working. */
  readonly working: number
  /** Core's fault count. */
  readonly faultCount: number
  /** Core's lifecycle word. */
  readonly lifecycle: string
}

export function brainState(input: BrainInput): BrainState {
  // Damage and degradation outrank activity: a Brain that looks busy while Core is
  // degraded would be the exact false confidence the plan forbids.
  if (input.lifecycle === 'degraded' || input.faultCount > 0) return 'uncertainty'
  if (input.activeRequests >= 3) return 'load'
  if (input.activeRequests > 0) return 'thinking'
  if (input.working > 0) return 'delegating'
  return 'calm'
}
