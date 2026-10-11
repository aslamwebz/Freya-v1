import type { WorkRisk } from '../../work/types'
import type { MissionReason } from '../reasons'
import {
  DEFAULT_MISSION_BUDGET,
  type MissionBudget,
  type MissionCapabilityPort,
  type MissionPlanRecord,
  type MissionStepRecord,
} from './types'

/**
 * THE MISSION PLANNER.
 *
 * Turns "what are we trying to do" into a bounded list of typed, capability-bound
 * steps. No model call, no network, no clock read of its own — a pure function of
 * (intent, capability table, budget), which is what makes a plan reproducible and a
 * replan observable.
 *
 * ## A planner cannot invent authority
 *
 * Three refusals carry this file:
 *
 * 1. **A step names a capability, and a capability that is not registered produces a
 *    blocked step rather than a step.** `resolveBinding` returns null and the step is
 *    written as `blocked` / `unknown_capability`. There is no path from a plan to a
 *    capability the table does not contain, so no plan can widen what Freya may do.
 * 2. **The planner never writes a grant, and never reads one.** It is handed a
 *    *lookup* function, not a grant store. The distinction matters: a planner that could
 *    add a capability would be an authority-issuing component wearing a planner's
 *    interface.
 * 3. **Risk and approval come from the capability's own registration**, never from the
 *    plan. A planner cannot mark a `consequential` capability as `none` to slip past
 *    Guard, because `binding.risk` is copied from the table rather than chosen.
 *
 * ## Replanning is bounded twice over
 *
 * `maxPlanRevisions` bounds how many plans a Mission may ever have, and it is checked
 * by the caller against durable state before the planner is even invoked — so the
 * ceiling survives a restart and cannot be re-planned away. Within one plan,
 * `maxStepsPerPlan` bounds the length. Both are code-owned ceilings that a caller may
 * narrow and never raise.
 *
 * ## What a plan deliberately does not contain
 *
 * No labels, no inputs, no descriptions. `MissionStepRecord` has no field that could
 * hold a sentence, so a plan is structurally incapable of becoming a copy of the goal.
 * Everything descriptive lives in the encrypted intent store.
 */

/** What the planner was asked to produce. Private content never appears here. */
export interface PlanRequest {
  readonly missionId: string
  /**
   * What each step does, as a *capability name* plus its dependencies.
   *
   * This is the whole input surface. There is no "description", no "instruction" and no
   * free text, because a planner handed prose is a planner whose output can be prose,
   * and this one's output goes into a journal.
   */
  readonly steps: readonly PlanStepRequest[]
  /** The plan this replaces, or null for a first plan. */
  readonly supersedes?: string | null
}

export interface PlanStepRequest {
  readonly stepId: string
  readonly capability: string
  /**
   * A registered verifier name.
   *
   * Required and resolved against the registry. A Step with no way to be checked is a
   * Step that can only ever complete on the strength of an Action, which is precisely
   * what Phase 6 made the verifier mandatory to prevent — so an unknown name blocks the
   * step rather than being defaulted to something that always passes.
   */
  readonly verifier: string
  readonly dependsOn?: readonly string[]
  /** Force an approval gate on top of whatever the capability carries. Can only add. */
  readonly requiresApproval?: boolean
}

/**
 * Why a plan could not be built.
 *
 * Every refusal names what stopped it, and none of them is "the model was unsure".
 * A planner that could not build a plan says so; it does not build a smaller one and
 * report success.
 */
export type PlanRefusal =
  | { readonly ok: false; readonly reason: 'no_steps' }
  | { readonly ok: false; readonly reason: 'too_many_steps'; readonly count: number; readonly ceiling: number }
  | { readonly ok: false; readonly reason: 'replan_ceiling'; readonly revisions: number; readonly ceiling: number }
  | {
      readonly ok: false
      readonly reason: 'malformed'
      /** Which request was unreadable, by index. Never its contents. */
      readonly index: number
    }

export type PlanOutcome =
  | { readonly ok: true; readonly plan: MissionPlanRecord; readonly blocked: readonly string[] }
  | PlanRefusal

/**
 * Build a plan.
 *
 * Every step is resolved against the capability table **before** the plan is returned,
 * so a caller cannot receive a plan containing an unresolvable capability and discover
 * the problem later. Unresolvable steps are written as `blocked` and their ids come
 * back in `blocked`, which is how the caller knows to raise a blocker rather than
 * proceed and fail at execution time.
 *
 * `now` is a parameter rather than a read so a plan's `createdAt` is a function of its
 * inputs — a test can build the same plan twice and get the same record.
 */
export function plan(request: PlanRequest, capabilities: MissionCapabilityPort, budget: MissionBudget, now: Date): PlanOutcome {
  if (request.steps.length === 0) return { ok: false, reason: 'no_steps' }
  if (request.steps.length > budget.maxStepsPerPlan) {
    return {
      ok: false,
      reason: 'too_many_steps',
      count: request.steps.length,
      ceiling: budget.maxStepsPerPlan,
    }
  }

  const steps: MissionStepRecord[] = []
  const blocked: string[] = []
  const seen = new Set<string>()

  for (const [index, raw] of request.steps.entries()) {
    const stepId = raw?.stepId
    // Bounded and shape-checked before anything is read out of it. A request whose
    // entries are not objects is malformed rather than empty, because the two mean
    // different things to whoever asked.
    if (typeof raw !== 'object' || raw === null || typeof stepId !== 'string' || stepId.length === 0) {
      return { ok: false, reason: 'malformed', index }
    }
    if (seen.has(stepId)) return { ok: false, reason: 'malformed', index }
    if (typeof raw.capability !== 'string' || raw.capability.length === 0) {
      return { ok: false, reason: 'malformed', index }
    }
    if (typeof raw.verifier !== 'string' || raw.verifier.length === 0) {
      return { ok: false, reason: 'malformed', index }
    }

    // A dependency on a step that has not been declared cannot be satisfied, and a plan
    // that waits on nothing real would run steps out of order. Refused whole.
    const dependsOn = raw.dependsOn === undefined ? [] : [...raw.dependsOn]
    if (!Array.isArray(dependsOn)) return { ok: false, reason: 'malformed', index }
    for (const dependency of dependsOn) {
      if (typeof dependency !== 'string' || dependency.length === 0) {
        return { ok: false, reason: 'malformed', index }
      }
      if (!seen.has(dependency)) return { ok: false, reason: 'malformed', index }
    }

    // **The authority boundary.** The capability is resolved against the registered
    // table or it is not in the plan as a runnable step. There is no branch that
    // produces a step naming something unregistered.
    const binding = capabilities.lookup(raw.capability)
    // The verifier is resolved independently of the capability, because a plan chooses
    // the check rather than inheriting it. An unknown verifier is as fatal as an unknown
    // capability: a Step whose verifier is not registered can never be established, and
    // committing it would put a step in the plan that can only ever fail.
    const verifierKnown = capabilities.verifiers().includes(raw.verifier)
    if (binding === null || !verifierKnown) {
      blocked.push(stepId)
      steps.push(
        Object.freeze({
          stepId,
          index,
          capability: raw.capability,
          // The *requested* verifier is kept rather than replaced with a placeholder. A
          // blocked step is a record of what was asked for, and losing the name would
          // mean a later correction could not tell what the plan had intended.
          verifier: raw.verifier,
          dependsOn: Object.freeze([...dependsOn]),
          status: 'blocked' as const,
          workerId: null,
          runId: null,
          attempts: 0,
          // Risk comes from the capability when it resolved. When it did not, `none` is
          // the honest value: an unresolvable capability has no risk to report, and
          // claiming otherwise would put a bound on something that does not exist.
          risk: binding === null ? ('none' as const) : binding.risk,
          requiresApproval: false,
          approvalId: null,
          reason: 'unknown_capability' as MissionReason,
          startedAt: null,
          settledAt: null,
        }),
      )
      seen.add(stepId)
      continue
    }

    steps.push(
      Object.freeze({
        stepId,
        index,
        capability: raw.capability,
        // The plan's verifier, resolved against the registry. Checked rather than
        // defaulted, so a Step cannot reach `verified` through a verifier nobody
        // registered.
        verifier: raw.verifier,
        dependsOn: Object.freeze([...dependsOn]),
        status: 'pending' as const,
        workerId: null,
        runId: null,
        attempts: 0,
        risk: binding.risk,
        // Can only *add* a gate. `binding.requiresApproval` already carries whatever the
        // capability demands, so this is `||` and never `&&`.
        requiresApproval: binding.requiresApproval || raw.requiresApproval === true,
        approvalId: null,
        reason: null,
        startedAt: null,
        settledAt: null,
      }),
    )
    seen.add(stepId)
  }

  return {
    ok: true,
    plan: Object.freeze({
      planId: `${request.missionId}-p1`,
      revision: 1,
      createdAt: now.toISOString(),
      steps: Object.freeze(steps),
      supersedes: request.supersedes ?? null,
      reason: null,
    }),
    blocked: Object.freeze(blocked),
  }
}

/**
 * Build the *next* revision of a plan.
 *
 * Separate from `plan` rather than a parameter, because the two differ in the one way
 * that matters most: a revision carries a `reason` and a `supersedes`, so the chain of
 * plans a Mission went through is readable from the journal afterwards. A Mission that
 * quietly re-planned its way to a success would otherwise leave no trace of the plan it
 * originally announced.
 *
 * The revision ceiling is checked here **as well as** in the runtime, and returns a
 * `replan_ceiling` refusal rather than a plan. That is belt and braces on purpose: this
 * is the function a caller would reach for directly, and a ceiling that only the runtime
 * enforced would be one refactor away from being unbounded.
 */
export function replan(
  request: PlanRequest,
  capabilities: MissionCapabilityPort,
  budget: MissionBudget,
  revisionsSoFar: number,
  now: Date,
): PlanOutcome {
  if (revisionsSoFar >= budget.maxPlanRevisions) {
    return { ok: false, reason: 'replan_ceiling', revisions: revisionsSoFar, ceiling: budget.maxPlanRevisions }
  }
  const outcome = plan(request, capabilities, budget, now)
  if (!outcome.ok) return outcome
  return {
    ok: true,
    plan: {
      ...outcome.plan,
      planId: `${request.missionId}-p${revisionsSoFar + 1}`,
      revision: revisionsSoFar + 1,
      reason: request.supersedes === null ? 'plan_revised' : 'plan_revised',
    },
    blocked: outcome.blocked,
  }
}

/**
 * Whether a step's dependencies are all verified.
 *
 * A pure question about a plan, asked before a step starts. A step whose dependency is
 * merely *done* is not the same as one whose dependency is *verified*, and only the
 * second is a reason to proceed — which is the same distinction Phase 6 draws between a
 * completed Run and a verified one.
 *
 * An empty dependency list is satisfied. That is not a loophole: a root step is supposed
 * to have no dependencies, and requiring one would make root steps unrunnable.
 */
export function dependenciesSatisfied(steps: readonly MissionStepRecord[], stepId: string): boolean {
  const target = steps.find((step) => step.stepId === stepId)
  if (target === undefined) return false
  const byId = new Map(steps.map((step) => [step.stepId, step] as const))
  for (const dependency of target.dependsOn) {
    const step = byId.get(dependency)
    if (step === undefined) return false
    if (step.status !== 'verified') return false
  }
  return true
}

/**
 * Which step a Mission should work on next.
 *
 * The first step in plan order that is `pending` and whose dependencies are verified.
 * **Plan order rather than urgency**, and that is a choice worth stating: a Mission with
 * nine pending steps and a ceiling of four delegations should start at step one and run
 * out of budget in a predictable place, rather than leapfrog to whichever step the
 * planner felt was most valuable. Predictability is what makes a budget a budget.
 */
export function nextRunnableStep(steps: readonly MissionStepRecord[]): MissionStepRecord | null {
  for (const step of steps) {
    if (step.status !== 'pending') continue
    if (!dependenciesSatisfied(steps, step.stepId)) continue
    return step
  }
  return null
}

/** How many steps have reached a terminal status of any kind. A count, not a fraction. */
export function settledStepCount(steps: readonly MissionStepRecord[]): number {
  return steps.filter((step) => step.status !== 'pending' && step.status !== 'delegated' && step.status !== 'running' && step.status !== 'blocked').length
}

/** The default budget, for a caller that has none and wants the code-owned ceilings. */
export const DEFAULT_PLAN_BUDGET: Readonly<MissionBudget> = DEFAULT_MISSION_BUDGET

/**
 * Re-exported so a caller reading about risk has the vocabulary in front of it.
 *
 * `WorkRisk` is Work's own closed enum and this planner does not extend it: a Mission
 * step's risk is the capability's risk, and inventing a fourth level here would create
 * a value Guard has never evaluated.
 */
export type { WorkRisk }