import type { WorkRisk } from '../../work/types'
import type { MissionCapabilityPort } from './types'
import type { PlanStepRequest } from './planner'
  /**
   * Choose what the first plan should be.
   *
   * ## The problem, stated plainly
   *
   * `planner.ts` deliberately takes **capability names** and not prose — handing a planner
   * sentences would let its output be sentences, and its output goes into a journal. So the
   * planner cannot derive steps from a goal by itself, and something has to say which
   * registered capabilities this goal should be pursued with. Core has no model call to ask.
   *
   * ## The rule: one capability, the least risky one
   *
   * A single step, naming the registered capability with the **lowest risk**, tie-broken by
   * name so two runs of the same Core plan the same work.
   *
   * Both halves of that are deliberate:
   *
   * - **One step.** A plan is a set of claims, and the Mission verifier requires *every* step
   *   to be verified before the goal is established. So a plan is only worth committing if
   *   all of it can succeed — and Core cannot know that about a capability it has never run.
   *   Proposing one step makes the plan a single bet whose outcome the next `step()` learns
   *   from, and a Mission that gets it wrong *replans* rather than being permanently poisoned
   *   by a sibling step it never had a chance at.
   * - **Lowest risk first.** `risk` is Core's own registration, not a guess: `none` before
   *   `routine` before `consequential`. Starting with the least consequential thing is the
   *   right default when nothing is known about which capability suits the goal, because the
   *   alternative is to open with a step that may need a person's signature.
   *
   * An earlier version proposed **every** registered capability, on the reasoning that
   * over-broad was safer than under-broad. It was not safer in any useful sense: a plan
   * containing an unfalsifiable step can never complete as a whole, so almost every Mission
   * blocked on `step_failed` with nothing to show. Failing safe means not committing to work
   * Core has no reason to believe, and one cautious step is that.
   *
   * ## What this does not do
   *
   * It does not narrow what Freya may do. `planner.ts` still resolves the name against the
   * table, `mayBeginStep` still asks the authority port, and the executor still goes through
   * Work's Guard. The rule picks *what to try first*, never *what is permitted*.
   *
   * Returns `null` when nothing at all is registered, so the caller blocks rather than
   * committing an empty plan.
   */
export function proposeSteps(
    missionId: string,
    capabilities: MissionCapabilityPort,
    refusals: string[],
  ): PlanStepRequest[] | null {
    const known = [...capabilities.known()].sort()
    if (known.length === 0) {
      refusals.push('no capability is registered, so there is nothing to plan')
      return null
    }
    if (capabilities.verifiers().length === 0) {
      // A step with no way to be checked can only ever complete on the strength of its
      // action, which is exactly what a mandatory verifier exists to prevent.
      refusals.push('no verifier is registered, so no step could ever be checked')
      return null
    }
    // **Only capabilities that declare their own verifier are planned.**
    //
    // The alphabetical-first verifier is `test.always-fails` — registered precisely to show
    // that verification can fail — so a planner that picked one would build a plan that
    // retries to its ceiling and blocks, which is indistinguishable from work that kept
    // failing. Leaving unpaired capabilities out is the conservative error: the Mission plans
    // less, and what it does plan has a check that was written for it.
    const paired = known
      .map((capability) => ({ capability, binding: capabilities.lookup(capability) }))
      .filter(
        (entry): entry is { capability: string; binding: NonNullable<ReturnType<MissionCapabilityPort['lookup']>> } =>
          entry.binding !== null && entry.binding.verifier !== null,
      )
    if (paired.length === 0) {
      refusals.push('no registered capability declares a verifier that could check it')
      return null
    }
    const rank: Readonly<Record<WorkRisk, number>> = { none: 0, routine: 1, consequential: 2 }
    // Lowest risk first, name as the tie-break, so the order is total and two runs of the
    // same Core plan the same work.
    const first = paired.sort(
      (a, b) =>
        rank[a.binding.risk] - rank[b.binding.risk] || a.capability.localeCompare(b.capability),
    )[0]
    if (first === undefined) {
      refusals.push('no registered capability could be planned')
      return null
    }
    return [
      {
        stepId: `${missionId}-s1`,
        capability: first.capability,
        // The capability's own declared pairing. Never chosen here.
        verifier: first.binding.verifier as string,
        dependsOn: [],
      },
    ]
  }
