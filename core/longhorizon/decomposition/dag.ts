import type { GoalMilestone, MilestoneStatus } from './types'

export type GraphValidationResult =
  | { readonly valid: true; readonly topologicalOrder: readonly string[] }
  | { readonly valid: false; readonly error: string; readonly cycle?: readonly string[] }

/**
 * Validate a milestone dependency graph.
 *
 * Ensures:
 * 1. Every milestone has a unique id.
 * 2. No milestone depends on itself.
 * 3. All dependencies exist within the milestone set (no dangling/invalid references).
 * 4. No circular dependencies (cycles) exist in the graph.
 * 5. Produces a topological order from prerequisites to dependents.
 */
export function validateMilestoneGraph(
  milestones: readonly GoalMilestone[],
): GraphValidationResult {
  if (milestones.length === 0) {
    return { valid: true, topologicalOrder: [] }
  }

  const idMap = new Map<string, GoalMilestone>()
  for (const milestone of milestones) {
    if (idMap.has(milestone.milestoneId)) {
      return { valid: false, error: `duplicate milestone id: ${milestone.milestoneId}` }
    }
    idMap.set(milestone.milestoneId, milestone)
  }

  // Check self-dependency and dangling dependencies
  for (const milestone of milestones) {
    for (const depId of milestone.dependencies) {
      if (depId === milestone.milestoneId) {
        return {
          valid: false,
          error: `milestone ${milestone.milestoneId} cannot depend on itself`,
          cycle: [milestone.milestoneId, milestone.milestoneId],
        }
      }
      if (!idMap.has(depId)) {
        return {
          valid: false,
          error: `milestone ${milestone.milestoneId} has unknown dependency: ${depId}`,
        }
      }
    }
  }

  // Cycle detection and topological sort using 3-color DFS
  // 0 = unvisited (white), 1 = visiting (gray), 2 = visited (black)
  const visited = new Map<string, number>()
  const parent = new Map<string, string | null>()
  const topologicalOrder: string[] = []
  let detectedCycle: string[] | null = null

  function dfs(currentId: string, path: string[]): boolean {
    visited.set(currentId, 1) // Gray

    const current = idMap.get(currentId)!
    for (const depId of current.dependencies) {
      const state = visited.get(depId) ?? 0
      if (state === 1) {
        // Cycle found: reconstruct cycle
        const cycleStartIndex = path.indexOf(depId)
        if (cycleStartIndex !== -1) {
          detectedCycle = [...path.slice(cycleStartIndex), currentId, depId]
        } else {
          detectedCycle = [depId, currentId, depId]
        }
        return false
      }
      if (state === 0) {
        parent.set(depId, currentId)
        if (!dfs(depId, [...path, currentId])) return false
      }
    }

    visited.set(currentId, 2) // Black
    topologicalOrder.push(currentId)
    return true
  }

  for (const milestone of milestones) {
    const state = visited.get(milestone.milestoneId) ?? 0
    if (state === 0) {
      if (!dfs(milestone.milestoneId, [])) {
        const cycle: readonly string[] = (detectedCycle as string[] | null) ?? []
        return {
          valid: false,
          error: `dependency cycle detected: ${cycle.length > 0 ? cycle.join(' -> ') : 'cycle'}`,
          cycle,
        }
      }
    }
  }

  // Reverse topological order gives prerequisites first
  return {
    valid: true,
    topologicalOrder: topologicalOrder,
  }
}

export interface MilestoneResolutionResult {
  readonly milestones: readonly GoalMilestone[]
  readonly readyMilestones: readonly GoalMilestone[]
  readonly blockedMilestones: readonly GoalMilestone[]
  readonly inProgressMilestones: readonly GoalMilestone[]
  readonly completedMilestones: readonly GoalMilestone[]
  readonly failedMilestones: readonly GoalMilestone[]
  readonly isComplete: boolean
  readonly hasFailures: boolean
}

/**
 * Pure function: resolve milestone statuses based on dependency states.
 *
 * Rule:
 * - A milestone is 'ready' ONLY when all of its dependencies are 'completed'.
 * - If any dependency is 'failed' or 'blocked', the milestone is 'blocked'.
 * - If dependencies are in progress or pending, the milestone is 'blocked' (waiting on dependencies).
 * - Terminal states ('completed', 'failed', 'skipped') and active state ('in_progress') are preserved.
 */
export function resolveMilestoneEligibility(
  milestones: readonly GoalMilestone[],
): MilestoneResolutionResult {
  const milestoneMap = new Map<string, GoalMilestone>()
  for (const m of milestones) {
    milestoneMap.set(m.milestoneId, m)
  }

  const updated: GoalMilestone[] = []

  for (const milestone of milestones) {
    // Preserve terminal states and active in-progress
    if (
      milestone.status === 'completed' ||
      milestone.status === 'failed' ||
      milestone.status === 'skipped' ||
      milestone.status === 'in_progress'
    ) {
      updated.push(milestone)
      continue
    }

    // Inspect dependencies
    let allCompleted = true
    let blockedReason: string | null = null

    for (const depId of milestone.dependencies) {
      const dep = milestoneMap.get(depId)
      if (!dep || dep.status !== 'completed') {
        allCompleted = false
        if (dep?.status === 'failed') {
          blockedReason = `dependency failed: ${depId}`
          break
        } else if (dep?.status === 'blocked') {
          blockedReason = `dependency blocked: ${depId}`
        } else {
          blockedReason = `waiting on dependency: ${depId}`
        }
      }
    }

    const nextStatus: MilestoneStatus = allCompleted ? 'ready' : 'blocked'

    updated.push({
      ...milestone,
      status: nextStatus,
      failureReason: nextStatus === 'blocked' ? blockedReason : milestone.failureReason,
    })
  }

  const readyMilestones = updated.filter((m) => m.status === 'ready')
  const blockedMilestones = updated.filter((m) => m.status === 'blocked')
  const inProgressMilestones = updated.filter((m) => m.status === 'in_progress')
  const completedMilestones = updated.filter((m) => m.status === 'completed')
  const failedMilestones = updated.filter((m) => m.status === 'failed')

  const isComplete = updated.length > 0 && updated.every((m) => m.status === 'completed' || m.status === 'skipped')
  const hasFailures = failedMilestones.length > 0

  return {
    milestones: updated,
    readyMilestones,
    blockedMilestones,
    inProgressMilestones,
    completedMilestones,
    failedMilestones,
    isComplete,
    hasFailures,
  }
}
