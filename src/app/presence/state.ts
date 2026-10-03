/**
 * The Brain's state — read from Core, never guessed.
 *
 * A pure function of facts Core already reports. Damage and degradation outrank
 * activity: a Brain that looked busy while Core was degraded would be exactly the
 * false confidence the truth rule forbids.
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
  readonly activeRequests: number
  readonly working: number
  readonly faultCount: number
  readonly lifecycle: string
}

export function brainState(input: BrainInput): BrainState {
  if (input.lifecycle === 'degraded' || input.faultCount > 0) return 'uncertainty'
  if (input.activeRequests >= 3) return 'load'
  if (input.activeRequests > 0) return 'thinking'
  if (input.working > 0) return 'delegating'
  return 'calm'
}
