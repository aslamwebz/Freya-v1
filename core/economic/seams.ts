import type { EconomicWakeRequest } from './ports'

/**
 * The Phase 31 seam.
 *
 * Long-Horizon Autonomy is being built concurrently, on its own branch, by another lane.
 * Phase 32 depends on it — a multi-day economic question *is* a long-horizon question —
 * and it cannot wait for it, so this file is where the dependency is made **narrow,
 * declared and inert**.
 *
 * The rule is that every contact with Phase 31 goes through one interface of three
 * methods, that interface is implemented in exactly one file, and the default
 * implementation returns nothing for everything. So:
 *
 *   - a Phase 31 branch that never lands changes nothing here, and the seam compiles
 *     today against a frozen object rather than against a type that does not exist yet;
 *   - a Phase 31 branch that lands can be wired by providing one object, and the change
 *     is reviewable in a single diff;
 *   - and — the property that actually matters — **nothing can drive economic
 *     intelligence until somebody deliberately supplies that object.** There is no
 *     import of Phase 31 anywhere in this lane, so there is no path from a long-horizon
 *     goal to a wake that a reviewer would have to find by reading call sites.
 *
 * The methods are questions, never commands. Phase 32 *asks* the long-horizon subsystem
 * whether a goal is open and what it would take to continue; it never tells it anything,
 * and the seam's type has no method that writes to Phase 31's state. The direction of
 * dependency is one-way by construction rather than by convention.
 */
export interface LongHorizonSeam {
  /** Stable identity of the implementation, for the projection and the release gate. */
  readonly name: string
  /**
   * The long-horizon goals Phase 31 currently holds open for this experiment.
   *
   * Read-only. A goal here is a *reference*: Phase 32 never interprets it, never
   * completes it and never judges whether it is still worth pursuing. It uses the list to
   * decide whether a wake about a goal should be honoured, and Phase 31 remains the only
   * thing that can say a goal is closed.
   */
  goalsFor(experimentId: string): readonly string[]
  /**
   * Turn a long-horizon continuation into an economic wake, or nothing.
   *
   * Returning `null` is the common and correct answer — a continuation about something
   * that is not an economic experiment is not this lane's business, and `null` is how
   * the seam says so without raising a refusal the owner would then have to read.
   */
  wakeFor(goalRef: string, occurredAt: string): EconomicWakeRequest | null
  /** Whether Phase 31 wants this goal pursued again. */
  continueGoal(goalRef: string): boolean
}

/**
 * The inert seam.
 *
 * Exported frozen and used as the runtime's default, so "Phase 31 is not connected" is a
 * fact a surface can read rather than a null a caller has to remember to check. Every
 * method returns the empty answer, and the `name` says why.
 */
export const NO_LONG_HORIZON_SEAM: LongHorizonSeam = Object.freeze({
  name: 'no-long-horizon-seam',
  goalsFor: () => Object.freeze([]),
  wakeFor: () => null,
  continueGoal: () => false,
})

/**
 * Is this seam connected to anything?
 *
 * Exists so the projection can tell "no long-horizon goal is open" — which is a fine
 * state — from "long-horizon autonomy is not wired to economic intelligence yet", which
 * is a fact about the build and should be visible rather than inferred from an empty
 * list.
 */
export function isSeamConnected(seam: LongHorizonSeam): boolean {
  return seam !== NO_LONG_HORIZON_SEAM
}

/**
 * Whether a wake may be honoured on a long-horizon goal.
 *
 * Three conditions, and the third is the one a later lane would forget: the seam must be
 * connected, the goal must be one the seam actually holds, and Phase 31 must itself say
 * it wants the goal continued. A seam that could be *argued* into continuing a goal is a
 * seam that has become an authority, and this subsystem has enough of those already.
 */
export function mayHonourGoal(seam: LongHorizonSeam, goalRef: string, experimentId: string): boolean {
  if (!isSeamConnected(seam)) return false
  if (!seam.goalsFor(experimentId).includes(goalRef)) return false
  return seam.continueGoal(goalRef)
}