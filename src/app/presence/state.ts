/**
 * The Brain's state — read from Core, never guessed.
 *
 * A pure function of facts Core already reports. Damage and degradation outrank
 * activity: a Brain that looked busy while Core was degraded would be exactly the
 * false confidence the truth rule forbids.
 *
 * The `operational` flag separates a Core that is up but unhealthy (degraded
 * journal, ephemeral-fallback) from a Core that has not started at all. A
 * Core that is operationally up is allowed to be calm; a Core that is not
 * operationally up falls into the uncertainty state so the operator knows
 * the workspace is not really online.
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
  /**
   * Whether the Core process can currently serve commands. Defaults to
   * `lifecycle === 'ready'` so older callers that only know the lifecycle
   * keep their old meaning, and so a Core that is `degraded` but
   * operational is treated as up rather than down.
   */
  readonly operational?: boolean
}

export function brainState(input: BrainInput): BrainState {
  const operational = input.operational ?? input.lifecycle === 'ready'
  if (!operational || input.faultCount > 0) return 'uncertainty'
  if (input.activeRequests >= 3) return 'load'
  if (input.activeRequests > 0) return 'thinking'
  if (input.working > 0) return 'delegating'
  return 'calm'
}