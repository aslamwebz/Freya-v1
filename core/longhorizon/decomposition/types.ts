/**
 * THE LONG-HORIZON GOAL DECOMPOSITION DOMAIN — Phase 5B.
 *
 * Transforms an enduring long-term goal into a bounded, revisable sequence of
 * meaningful milestones connected via a dependency graph (DAG).
 *
 * Architectural Invariant:
 * Long-Term Goal -> Milestones -> Bounded Missions -> Verified Work
 *
 * - A goal does not execute directly; it decomposes into milestones.
 * - A milestone does not execute directly; it spawns bounded Missions.
 * - A Mission does not claim success; it executes and verifies Work steps.
 * - Completed Work does not automatically complete the goal.
 */

export const MILESTONE_STATUSES = [
  'pending',
  'ready',
  'in_progress',
  'completed',
  'blocked',
  'failed',
  'skipped',
] as const

export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number]

export interface MilestoneEffortEstimate {
  readonly minHours: number
  readonly maxHours: number
  readonly confidence: 'low' | 'medium' | 'high'
  readonly description: string
}

export interface GoalMilestone {
  readonly milestoneId: string
  readonly goalId: string
  readonly title: string
  readonly intent: string
  readonly expectedOutcome: string
  readonly acceptanceCriteria: readonly string[]
  readonly requiredCapabilities: readonly string[]
  /** Prerequisite milestone IDs that must be 'completed' before this can proceed. */
  readonly dependencies: readonly string[]
  /** Explicitly uncertain effort estimate. */
  readonly estimatedEffort: MilestoneEffortEstimate
  readonly potentialBlockers: readonly string[]
  readonly resourcesNeeded: readonly string[]
  readonly approvalRequired: boolean
  readonly status: MilestoneStatus
  /** Optional link to underlying Goal checkpoint id. */
  readonly checkpointId: string | null
  /** Bounded Mission IDs created to pursue this milestone. */
  readonly boundMissionIds: readonly string[]
  readonly verifiedAt: string | null
  readonly failureReason: string | null
  /** Provenance of advisory lessons from Learning that informed this milestone. */
  readonly advisoryLessonsApplied: readonly string[]
}

export interface GoalMilestoneInput {
  readonly milestoneId?: string
  readonly title: string
  readonly intent: string
  readonly expectedOutcome: string
  readonly acceptanceCriteria: readonly string[]
  readonly requiredCapabilities?: readonly string[]
  readonly dependencies?: readonly string[]
  readonly estimatedEffort?: Partial<MilestoneEffortEstimate>
  readonly potentialBlockers?: readonly string[]
  readonly resourcesNeeded?: readonly string[]
  readonly approvalRequired?: boolean
  readonly advisoryLessonsApplied?: readonly string[]
}

export interface GoalRoadmap {
  readonly goalId: string
  readonly revision: number
  readonly milestones: readonly GoalMilestone[]
  readonly createdAt: string
  readonly updatedAt: string
  readonly advisoryNotes?: readonly string[]
}

export interface GoalRoadmapInput {
  readonly goalId: string
  readonly milestones: readonly GoalMilestoneInput[]
  readonly advisoryNotes?: readonly string[]
}

/* ------------------------------------------------------------- ceilings */

export interface DecompositionLimits {
  readonly maxMilestonesPerGoal: number
  readonly maxDependenciesPerMilestone: number
  readonly maxCriteriaPerMilestone: number
  readonly maxTitleChars: number
  readonly maxIntentChars: number
  readonly maxExpectedOutcomeChars: number
  readonly maxEffortHours: number
  readonly maxPlanRevisions: number
}

export const DEFAULT_DECOMPOSITION_LIMITS: Readonly<DecompositionLimits> = Object.freeze({
  maxMilestonesPerGoal: 16,
  maxDependenciesPerMilestone: 8,
  maxCriteriaPerMilestone: 16,
  maxTitleChars: 160,
  maxIntentChars: 1000,
  maxExpectedOutcomeChars: 1000,
  maxEffortHours: 1000,
  maxPlanRevisions: 10,
})
