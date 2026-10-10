/**
 * THE LONG-HORIZON GOAL BUDGET HIERARCHY — Phase 5C.
 *
 * Enforces strictly nested, non-widening budget limits:
 * Owner Budget -> Goal Budget -> Milestone/Mission Budget -> Work Step Limits
 *
 * Invariants:
 * 1. A goal cannot spend more than the owner authorized for that goal.
 * 2. A milestone/Mission budget cannot exceed the remaining goal budget.
 * 3. A Work capability step cannot exceed the Mission's approved limits.
 * 4. Exhausting any level pauses execution and demands owner review.
 * 5. No autonomous "budget top-up" without explicit owner authorization.
 */

import type { MissionBudget } from '../missions/autonomy/types'
import { DEFAULT_MISSION_BUDGET } from '../missions/autonomy/types'

export interface GoalBudgetPolicy {
  readonly maxModelCalls: number
  readonly maxActions: number
  readonly maxExternalRequests: number
  readonly maxMissions: number
  readonly maxDurationMs: number
}

export const DEFAULT_GOAL_BUDGET: Readonly<GoalBudgetPolicy> = Object.freeze({
  maxModelCalls: 128,
  maxActions: 512,
  maxExternalRequests: 128,
  maxMissions: 16,
  maxDurationMs: 90 * 24 * 60 * 60_000, // 90 days
})

export interface GoalSpend {
  readonly modelCalls: number
  readonly actions: number
  readonly externalRequests: number
  readonly completedMissions: number
}

export const ZERO_GOAL_SPEND: Readonly<GoalSpend> = Object.freeze({
  modelCalls: 0,
  actions: 0,
  externalRequests: 0,
  completedMissions: 0,
})

export interface GoalBudgetRemaining {
  readonly remainingModelCalls: number
  readonly remainingActions: number
  readonly remainingExternalRequests: number
  readonly remainingMissions: number
}

export type BudgetValidationResult =
  | { readonly ok: true; readonly value: GoalBudgetPolicy }
  | { readonly ok: false; readonly reason: string }

export type MissionBudgetDerivationResult =
  | { readonly ok: true; readonly budget: MissionBudget }
  | { readonly ok: false; readonly reason: string }

/**
 * Validate that a proposed goal budget does not exceed owner-authorized ceilings.
 */
export function validateGoalBudget(
  input: Partial<GoalBudgetPolicy>,
  ownerCeiling: GoalBudgetPolicy = DEFAULT_GOAL_BUDGET,
): BudgetValidationResult {
  const modelCalls = Number(input.maxModelCalls ?? ownerCeiling.maxModelCalls)
  const actions = Number(input.maxActions ?? ownerCeiling.maxActions)
  const externalRequests = Number(input.maxExternalRequests ?? ownerCeiling.maxExternalRequests)
  const missions = Number(input.maxMissions ?? ownerCeiling.maxMissions)
  const durationMs = Number(input.maxDurationMs ?? ownerCeiling.maxDurationMs)

  if (modelCalls <= 0 || !Number.isInteger(modelCalls)) {
    return { ok: false, reason: 'maxModelCalls must be a positive integer' }
  }
  if (actions <= 0 || !Number.isInteger(actions)) {
    return { ok: false, reason: 'maxActions must be a positive integer' }
  }
  if (externalRequests < 0 || !Number.isInteger(externalRequests)) {
    return { ok: false, reason: 'maxExternalRequests must be a non-negative integer' }
  }
  if (missions <= 0 || !Number.isInteger(missions)) {
    return { ok: false, reason: 'maxMissions must be a positive integer' }
  }
  if (durationMs <= 0 || !Number.isFinite(durationMs)) {
    return { ok: false, reason: 'maxDurationMs must be a positive number' }
  }

  // Enforce owner ceilings
  if (modelCalls > ownerCeiling.maxModelCalls) {
    return { ok: false, reason: `maxModelCalls (${modelCalls}) exceeds owner ceiling (${ownerCeiling.maxModelCalls})` }
  }
  if (actions > ownerCeiling.maxActions) {
    return { ok: false, reason: `maxActions (${actions}) exceeds owner ceiling (${ownerCeiling.maxActions})` }
  }
  if (externalRequests > ownerCeiling.maxExternalRequests) {
    return {
      ok: false,
      reason: `maxExternalRequests (${externalRequests}) exceeds owner ceiling (${ownerCeiling.maxExternalRequests})`,
    }
  }
  if (missions > ownerCeiling.maxMissions) {
    return { ok: false, reason: `maxMissions (${missions}) exceeds owner ceiling (${ownerCeiling.maxMissions})` }
  }
  if (durationMs > ownerCeiling.maxDurationMs) {
    return { ok: false, reason: `maxDurationMs (${durationMs}) exceeds owner ceiling (${ownerCeiling.maxDurationMs})` }
  }

  return {
    ok: true,
    value: {
      maxModelCalls: modelCalls,
      maxActions: actions,
      maxExternalRequests: externalRequests,
      maxMissions: missions,
      maxDurationMs: durationMs,
    },
  }
}

/**
 * Calculate remaining budget capacity for a goal.
 */
export function calculateRemainingGoalBudget(
  policy: GoalBudgetPolicy,
  spend: GoalSpend,
): GoalBudgetRemaining {
  return {
    remainingModelCalls: Math.max(0, policy.maxModelCalls - spend.modelCalls),
    remainingActions: Math.max(0, policy.maxActions - spend.actions),
    remainingExternalRequests: Math.max(0, policy.maxExternalRequests - spend.externalRequests),
    remainingMissions: Math.max(0, policy.maxMissions - spend.completedMissions),
  }
}

/**
 * Check if any resource in the goal budget has been exhausted.
 */
export function checkBudgetExhaustion(
  policy: GoalBudgetPolicy,
  spend: GoalSpend,
): { readonly exhausted: boolean; readonly depletedResources: readonly string[] } {
  const depleted: string[] = []
  if (spend.modelCalls >= policy.maxModelCalls) depleted.push('modelCalls')
  if (spend.actions >= policy.maxActions) depleted.push('actions')
  if (spend.externalRequests >= policy.maxExternalRequests) depleted.push('externalRequests')
  if (spend.completedMissions >= policy.maxMissions) depleted.push('missions')

  return {
    exhausted: depleted.length > 0,
    depletedResources: depleted,
  }
}

/**
 * Derive a bounded MissionBudget for an individual milestone Mission.
 *
 * Architectural Invariant:
 * The derived Mission budget is strictly bounded by the remaining goal budget.
 * It cannot widen or exceed remaining capacity.
 */
export function deriveMilestoneMissionBudget(
  policy: GoalBudgetPolicy,
  spend: GoalSpend,
  requestedBudget?: Partial<MissionBudget>,
): MissionBudgetDerivationResult {
  const remaining = calculateRemainingGoalBudget(policy, spend)

  if (remaining.remainingModelCalls <= 0) {
    return { ok: false, reason: 'goal budget exhausted: no model calls remaining' }
  }
  if (remaining.remainingActions <= 0) {
    return { ok: false, reason: 'goal budget exhausted: no actions remaining' }
  }
  if (remaining.remainingMissions <= 0) {
    return { ok: false, reason: 'goal budget exhausted: mission count limit reached' }
  }

  const requestedModelCalls = requestedBudget?.maxModelCalls ?? DEFAULT_MISSION_BUDGET.maxModelCalls
  const requestedActions = requestedBudget?.maxActions ?? DEFAULT_MISSION_BUDGET.maxActions
  const requestedExternal = requestedBudget?.maxExternalRequests ?? DEFAULT_MISSION_BUDGET.maxExternalRequests

  // Strictly bound by remaining capacity
  const maxModelCalls = Math.min(requestedModelCalls, remaining.remainingModelCalls)
  const maxActions = Math.min(requestedActions, remaining.remainingActions)
  const maxExternalRequests = Math.min(requestedExternal, remaining.remainingExternalRequests)

  const derived: MissionBudget = {
    ...DEFAULT_MISSION_BUDGET,
    ...requestedBudget,
    maxModelCalls,
    maxActions,
    maxExternalRequests,
  }

  return {
    ok: true,
    budget: derived,
  }
}

/**
 * Add incremental spend to goal spend record. Monotonically increases.
 */
export function recordGoalSpend(
  current: GoalSpend,
  incremental: Partial<GoalSpend>,
): GoalSpend {
  return {
    modelCalls: current.modelCalls + Math.max(0, incremental.modelCalls ?? 0),
    actions: current.actions + Math.max(0, incremental.actions ?? 0),
    externalRequests: current.externalRequests + Math.max(0, incremental.externalRequests ?? 0),
    completedMissions: current.completedMissions + Math.max(0, incremental.completedMissions ?? 0),
  }
}
