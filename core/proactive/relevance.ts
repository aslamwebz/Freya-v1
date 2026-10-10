/**
 * FREYA PROACTIVE INTELLIGENCE — Deterministic Relevance Filter (Phase 6B)
 *
 * Evaluates observation significance and opportunity classification deterministically.
 * Invariant: An irrelevant event must cost ZERO model tokens.
 */

import type { NormalizedObservation, RelevanceAssessment } from './types'

export type { RelevanceAssessment }

export interface GoalMilestoneSummary {
  readonly milestoneId: string
  readonly status: string // 'pending' | 'active' | 'completed' | 'failed' | 'blocked'
  readonly criteria?: readonly string[]
}

export interface GoalSummary {
  readonly goalId: string
  readonly state: string // 'draft' | 'active' | 'paused' | 'completed' | 'cancelled' | 'failed'
  readonly title: string
  readonly milestones: readonly GoalMilestoneSummary[]
}

export interface MissionSummary {
  readonly missionId: string
  readonly state: string
}

export interface RelevanceFilterEnvironment {
  readonly getGoal?: (goalId: string) => GoalSummary | null
  readonly activeGoals?: () => readonly GoalSummary[]
  readonly activeMissions?: () => readonly MissionSummary[]
  readonly isBlockedOnResource?: (resourceId: string) => boolean
}

const THREAT_KEYWORDS = ['threat', 'vulnerability', 'failed', 'blocked', 'delay', 'regression', 'security', 'cve']
const PROGRESS_KEYWORDS = ['completed', 'verified', 'passed', 'progress', 'deployed', 'resolved', 'success', 'shipped']
const INITIATIVE_PREDICATES = ['execute-action', 'request-action', 'execute-command', 'run-tool']

export class DeterministicRelevanceFilter {
  /**
   * Deterministically evaluate observation relevance without invoking any model.
   * Token cost is strictly 0.
   */
  evaluate(
    obs: NormalizedObservation,
    env: RelevanceFilterEnvironment = {},
  ): RelevanceAssessment {
    const summaryLower = obs.claim.rawSummary.toLowerCase()
    const predicateLower = obs.claim.predicate.toLowerCase()

    // 1. Expiration check
    if (obs.expiresAt !== null) {
      const nowIso = new Date().toISOString()
      if (obs.expiresAt < nowIso) {
        return {
          isRelevant: false,
          opportunityType: 'unclassified_noise',
          confidence: 0,
          goalId: obs.goalId,
          milestoneId: obs.milestoneId,
          reason: 'event is expired',
          warrantsReasoning: false,
          tokensCost: 0,
        }
      }
    }

    // 2. Unauthorized initiative attempt from external source
    if (
      (obs.sourceType === 'connector' || obs.sourceType === 'resource_monitor') &&
      (INITIATIVE_PREDICATES.includes(predicateLower) ||
        summaryLower.includes('execute tool') ||
        summaryLower.includes('run command') ||
        summaryLower.includes('system instruction'))
    ) {
      return {
        isRelevant: true,
        opportunityType: 'unauthorized_initiative_request',
        confidence: 1.0,
        goalId: obs.goalId,
        milestoneId: obs.milestoneId,
        reason: 'unauthorized external initiative request',
        warrantsReasoning: false, // Deterministic refusal/governor gate, no model tokens needed
        tokensCost: 0,
      }
    }

    // 3. Goal-aware evaluation
    if (obs.goalId) {
      const goal = env.getGoal?.(obs.goalId)
      if (!goal) {
        return {
          isRelevant: false,
          opportunityType: 'unclassified_noise',
          confidence: 0,
          goalId: obs.goalId,
          milestoneId: obs.milestoneId,
          reason: 'referenced goal does not exist',
          warrantsReasoning: false,
          tokensCost: 0,
        }
      }

      // Terminal goals: cancelled, completed, failed
      if (goal.state === 'cancelled' || goal.state === 'completed' || goal.state === 'failed') {
        return {
          isRelevant: false,
          opportunityType: 'unclassified_noise',
          confidence: 0,
          goalId: obs.goalId,
          milestoneId: obs.milestoneId,
          reason: `referenced goal is ${goal.state}`,
          warrantsReasoning: false,
          tokensCost: 0,
        }
      }

      // Paused goal
      if (goal.state === 'paused') {
        const isUnblocker =
          summaryLower.includes('unblock') ||
          summaryLower.includes('resume') ||
          summaryLower.includes('available') ||
          summaryLower.includes('resolved')
        if (isUnblocker) {
          return {
            isRelevant: true,
            opportunityType: 'resource_unblocked',
            confidence: 0.8,
            goalId: obs.goalId,
            milestoneId: obs.milestoneId,
            reason: 'potential unblocker for paused goal',
            warrantsReasoning: true,
            tokensCost: 0,
          }
        }
        return {
          isRelevant: false,
          opportunityType: 'unclassified_noise',
          confidence: 0.2,
          goalId: obs.goalId,
          milestoneId: obs.milestoneId,
          reason: 'referenced goal is paused',
          warrantsReasoning: false,
          tokensCost: 0,
        }
      }

      // Active goal
      if (goal.state === 'active') {
        if (obs.milestoneId) {
          const milestone = goal.milestones.find((m) => m.milestoneId === obs.milestoneId)
          if (milestone?.status === 'completed') {
            return {
              isRelevant: false,
              opportunityType: 'unclassified_noise',
              confidence: 0.1,
              goalId: obs.goalId,
              milestoneId: obs.milestoneId,
              reason: 'milestone is already completed',
              warrantsReasoning: false,
              tokensCost: 0,
            }
          }

          // Check threat
          if (
            predicateLower.includes('threat') ||
            predicateLower.includes('fail') ||
            THREAT_KEYWORDS.some((kw) => summaryLower.includes(kw))
          ) {
            return {
              isRelevant: true,
              opportunityType: 'threat_to_goal',
              confidence: 0.9,
              goalId: obs.goalId,
              milestoneId: obs.milestoneId,
              reason: 'threat condition detected for active milestone',
              warrantsReasoning: true,
              tokensCost: 0,
            }
          }

          // Check progress
          if (
            predicateLower === 'milestone-settled' ||
            predicateLower === 'step-transitioned' ||
            PROGRESS_KEYWORDS.some((kw) => summaryLower.includes(kw))
          ) {
            return {
              isRelevant: true,
              opportunityType: 'goal_progress_opportunity',
              confidence: 0.95,
              goalId: obs.goalId,
              milestoneId: obs.milestoneId,
              reason: 'progress condition detected for active milestone',
              warrantsReasoning: true,
              tokensCost: 0,
            }
          }

          return {
            isRelevant: true,
            opportunityType: 'information_update',
            confidence: 0.75,
            goalId: obs.goalId,
            milestoneId: obs.milestoneId,
            reason: 'relevant update for active milestone',
            warrantsReasoning: true,
            tokensCost: 0,
          }
        }

        return {
          isRelevant: true,
          opportunityType: 'information_update',
          confidence: 0.7,
          goalId: obs.goalId,
          milestoneId: null,
          reason: 'relevant context for active goal',
          warrantsReasoning: true,
          tokensCost: 0,
        }
      }
    }

    // 4. Workforce / Resource status change
    if (
      predicateLower === 'worker-availability-changed' ||
      obs.sourceId === 'workforce' ||
      summaryLower.includes('worker') ||
      summaryLower.includes('capacity')
    ) {
      return {
        isRelevant: true,
        opportunityType: 'resource_unblocked',
        confidence: 0.85,
        goalId: null,
        milestoneId: null,
        reason: 'workforce resource availability changed',
        warrantsReasoning: true,
        tokensCost: 0,
      }
    }

    // 5. Scheduled review / obligation
    if (
      predicateLower === 'schedule-due' ||
      predicateLower === 'review-due' ||
      summaryLower.includes('scheduled review') ||
      summaryLower.includes('deadline approaching')
    ) {
      return {
        isRelevant: true,
        opportunityType: 'scheduled_obligation',
        confidence: 0.9,
        goalId: null,
        milestoneId: null,
        reason: 'scheduled obligation or deadline due',
        warrantsReasoning: true,
        tokensCost: 0,
      }
    }

    // 6. Active Mission link
    if (obs.missionId) {
      const activeMissions = env.activeMissions?.() ?? []
      const matched = activeMissions.some((m) => m.missionId === obs.missionId && m.state === 'active')
      if (matched) {
        return {
          isRelevant: true,
          opportunityType: 'information_update',
          confidence: 0.8,
          goalId: null,
          milestoneId: null,
          reason: 'observation relates to active mission',
          warrantsReasoning: true,
          tokensCost: 0,
        }
      }
      return {
        isRelevant: false,
        opportunityType: 'unclassified_noise',
        confidence: 0,
        goalId: null,
        milestoneId: null,
        reason: 'referenced mission is not active',
        warrantsReasoning: false,
        tokensCost: 0,
      }
    }

    // 7. General background noise -> 0 tokens!
    return {
      isRelevant: false,
      opportunityType: 'unclassified_noise',
      confidence: 0,
      goalId: null,
      milestoneId: null,
      reason: 'no correlation to active goals, missions, or authorized workflows',
      warrantsReasoning: false,
      tokensCost: 0,
    }
  }
}
