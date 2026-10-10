import type { GoalContent } from '../types'
import type {
  GoalMilestone,
  GoalMilestoneInput,
  GoalRoadmap,
  GoalRoadmapInput,
} from './types'
import { validateRoadmap, type RoadmapValidationResult } from './validator'
import { resolveMilestoneEligibility } from './dag'

export interface AdvisoryLessonInput {
  readonly recordId: string
  readonly claim: string
  readonly confidence?: string
  readonly sourceDomain?: string
}

export interface DecompositionOptions {
  readonly advisoryLessons?: readonly AdvisoryLessonInput[]
  readonly now?: () => Date
}

export interface BoundedMissionProposal {
  readonly milestoneId: string
  readonly title: string
  readonly intent: string
  readonly successCriteria: readonly string[]
  readonly requiredCapabilities: readonly string[]
}

/**
 * THE PROGRESSIVE ROADMAP PLANNER — Phase 5B.
 *
 * Decomposes long-term intent through progressive elaboration rather than
 * attempting hundreds of micro-actions in a single shot.
 *
 * Invariants:
 * 1. Long-Term Goal -> Milestones -> Bounded Missions -> Verified Work.
 * 2. Learning lessons remain advisory (never grant capabilities, never bypass verifiers).
 * 3. Bounded revisions and conservative code-owned ceilings.
 */
export class ProgressiveRoadmapPlanner {
  constructor(private readonly now: () => Date = () => new Date()) {}

  /**
   * Propose a high-level milestone roadmap for a long-term goal.
   *
   * Pure deterministic decomposition policy, integrating advisory lessons
   * without granting unverified authority.
   */
  proposeRoadmap(
    goal: GoalContent,
    existingRoadmap?: GoalRoadmap,
    options: DecompositionOptions = {},
  ): RoadmapValidationResult {
    const lessons = options.advisoryLessons ?? []
    const appliedLessons: string[] = []
    const advisoryNotes: string[] = []

    // Advisory learning scan
    for (const lesson of lessons) {
      if (lesson.claim && lesson.claim.length > 0) {
        appliedLessons.push(`lesson:${lesson.recordId}`)
        advisoryNotes.push(`Advisory note from prior experience: ${lesson.claim}`)
      }
    }

    // High-level milestone decomposition based on criteria or goal structure
    const milestoneInputs: GoalMilestoneInput[] = []
    const criteria = goal.completionCriteria.length > 0
      ? goal.completionCriteria
      : ['Feasibility & Exploration', 'Implementation & Verification', 'Synthesis & Review']

    for (let i = 0; i < criteria.length; i++) {
      const criterion = criteria[i] as string
      const id = `m-${i + 1}`
      const prevId = i > 0 ? `m-${i}` : undefined

      // Relevant blockers derived from advisory lessons
      const potentialBlockers: string[] = []
      if (criterion.toLowerCase().includes('research') || criterion.toLowerCase().includes('external')) {
        potentialBlockers.push('Network latency or external data unavailability')
      }
      if (criterion.toLowerCase().includes('mvp') || criterion.toLowerCase().includes('build')) {
        potentialBlockers.push('Unresolved prerequisites or unexpected dependency failures')
      }

      milestoneInputs.push({
        milestoneId: id,
        title: `Milestone ${i + 1}: ${criterion}`,
        intent: `Establish verifiable progress for "${criterion}" within goal "${goal.title}"`,
        expectedOutcome: `Criterion "${criterion}" verified with evidence.`,
        acceptanceCriteria: [criterion],
        requiredCapabilities: ['work.execute', 'mission.manage'],
        dependencies: prevId ? [prevId] : [],
        estimatedEffort: {
          minHours: 1,
          maxHours: 4,
          confidence: 'medium',
          description: 'Initial estimated effort (explicitly uncertain)',
        },
        potentialBlockers,
        resourcesNeeded: ['Core runtime', 'Authorized capabilities'],
        approvalRequired: false,
        advisoryLessonsApplied: appliedLessons,
      })
    }

    const roadmapInput: GoalRoadmapInput = {
      goalId: goal.goalId,
      milestones: milestoneInputs,
      advisoryNotes,
    }

    const revision = existingRoadmap?.revision ?? 0
    return validateRoadmap(roadmapInput, revision, undefined, this.now().toISOString())
  }

  /**
   * Evaluate which milestone is currently eligible to be pursued as a bounded Mission.
   */
  nextEligibleMilestone(roadmap: GoalRoadmap): GoalMilestone | null {
    const resolution = resolveMilestoneEligibility(roadmap.milestones)
    if (resolution.readyMilestones.length === 0) return null
    // Pick the earliest ready milestone in topological order
    return resolution.readyMilestones[0] ?? null
  }

  /**
   * Create a bounded Mission specification for an eligible milestone.
   *
   * Architectural invariant:
   * Milestone -> Bounded Mission.
   * The Mission has bounded acceptance criteria and does not claim to complete the whole goal.
   */
  createMissionForMilestone(
    milestone: GoalMilestone,
    goal: GoalContent,
  ): BoundedMissionProposal {
    return {
      milestoneId: milestone.milestoneId,
      title: `${goal.title} — ${milestone.title}`,
      intent: milestone.intent,
      successCriteria: milestone.acceptanceCriteria,
      requiredCapabilities: milestone.requiredCapabilities,
    }
  }

  /**
   * Advance a milestone's state when its linked Mission concludes.
   *
   * Evidence rule:
   * A succeeded Mission completes its linked milestone.
   * A failed Mission blocks or fails the milestone with honest reason.
   */
  settleMilestone(
    roadmap: GoalRoadmap,
    milestoneId: string,
    outcome: 'completed' | 'failed',
    evidence: { readonly reason?: string; readonly missionId?: string },
  ): GoalRoadmap {
    const updatedMilestones = roadmap.milestones.map((m) => {
      if (m.milestoneId !== milestoneId) return m

      const boundMissionIds = evidence.missionId
        ? Array.from(new Set([...m.boundMissionIds, evidence.missionId]))
        : m.boundMissionIds

      if (outcome === 'completed') {
        return {
          ...m,
          status: 'completed' as const,
          verifiedAt: this.now().toISOString(),
          boundMissionIds,
          failureReason: null,
        }
      } else {
        return {
          ...m,
          status: 'failed' as const,
          boundMissionIds,
          failureReason: evidence.reason ?? 'linked mission failed',
        }
      }
    })

    const resolution = resolveMilestoneEligibility(updatedMilestones)

    return {
      ...roadmap,
      milestones: resolution.milestones,
      updatedAt: this.now().toISOString(),
    }
  }
}
