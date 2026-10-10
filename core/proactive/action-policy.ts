/**
 * FREYA PROACTIVE INTELLIGENCE — Governed Action Policy & Boundaries (Phase 6C)
 *
 * Enforces action levels, probe budgets, continuation invariants, and attention routing.
 * Invariant: Freya must NEVER create or activate a new Mission autonomously without explicit pre-authorization.
 */

import type {
  ActionLevel,
  NormalizedObservation,
  ProactiveAdvisoryProposal,
  ProactiveGovernedDecision,
} from './types'

export type { ActionLevel, ProactiveGovernedDecision }

export const PROBE_BUDGET_LIMITS = {
  maxProbes: 3,
  maxProbeTokens: 1000,
} as const

export interface ContinuationVerificationContext {
  readonly goalIsActive: boolean
  readonly missionIsWaiting: boolean
  readonly milestonePreconditionsMet: boolean
  readonly budgetRemaining: number
  readonly principalAuthorized: boolean
  readonly stopAllActive: boolean
}

export interface ActionPolicyEnvironment {
  readonly stopAllActive?: () => boolean
  readonly probeCount?: number
  readonly probeTokensUsed?: number
  readonly checkContinuationPrerequisites?: (goalId: string | null, missionId: string | null) => ContinuationVerificationContext
}

export class GovernedActionPolicy {
  private probeCount = 0
  private probeTokensUsed = 0

  constructor(private readonly newId: () => string = () => `dec-${Date.now()}`) {}

  resetProbeBudget(): void {
    this.probeCount = 0
    this.probeTokensUsed = 0
  }

  getProbeStatus(): { probeCount: number; probeTokensUsed: number; remainingProbes: number } {
    return {
      probeCount: this.probeCount,
      probeTokensUsed: this.probeTokensUsed,
      remainingProbes: Math.max(0, PROBE_BUDGET_LIMITS.maxProbes - this.probeCount),
    }
  }

  /**
   * Determine governed decision and action level according to Phase 6C rules.
   */
  evaluate(
    proposal: ProactiveAdvisoryProposal,
    observation: NormalizedObservation,
    env: ActionPolicyEnvironment = {},
  ): ProactiveGovernedDecision {
    const decisionId = this.newId()
    const stopAll = env.stopAllActive?.() ?? false

    // Emergency Stop overrides EVERYTHING
    if (stopAll) {
      return {
        decisionId,
        observationId: observation.observationId,
        decision: 'defer',
        level: 1,
        actionRef: null,
        reason: 'STOP ALL is active: all proactive actions paused',
        requiresApproval: false,
        executed: false,
        outcome: 'Action suppressed due to emergency stop',
      }
    }

    const candidate = proposal.candidateAction

    // 1. Level 1 — Direct / Pre-authorized actions
    if (candidate === 'ignore') {
      return {
        decisionId,
        observationId: observation.observationId,
        decision: 'ignore',
        level: 1,
        actionRef: null,
        reason: 'Event ignored as noise or redundant',
        requiresApproval: false,
        executed: true,
        outcome: 'Event ignored',
      }
    }

    if (candidate === 'record') {
      return {
        decisionId,
        observationId: observation.observationId,
        decision: 'record',
        level: 1,
        actionRef: observation.evidenceRef,
        reason: 'Event recorded into private knowledge/evidence registry',
        requiresApproval: false,
        executed: true,
        outcome: 'Observation recorded into evidence store',
      }
    }

    if (candidate === 'defer') {
      return {
        decisionId,
        observationId: observation.observationId,
        decision: 'defer',
        level: 1,
        actionRef: null,
        reason: 'Action deferred awaiting preconditions or batch window',
        requiresApproval: false,
        executed: true,
        outcome: 'Action deferred',
      }
    }

    if (candidate === 'notify') {
      return {
        decisionId,
        observationId: observation.observationId,
        decision: 'notify',
        level: 1,
        actionRef: observation.observationId,
        reason: proposal.justification.slice(0, 390) || 'Notification routed to Attention engine',
        requiresApproval: false,
        executed: true,
        outcome: 'Notification submitted to Attention engine',
      }
    }

    // 2. Level 2 — Bounded Investigation
    if (candidate === 'investigate') {
      const currentProbes = env.probeCount ?? this.probeCount
      const currentTokens = env.probeTokensUsed ?? this.probeTokensUsed

      if (currentProbes >= PROBE_BUDGET_LIMITS.maxProbes || currentTokens >= PROBE_BUDGET_LIMITS.maxProbeTokens) {
        // Probe budget exhausted -> Escalate to Level 3 approval request
        return {
          decisionId,
          observationId: observation.observationId,
          decision: 'request_approval',
          level: 3,
          actionRef: null,
          reason: `Investigation probe budget exhausted (${currentProbes}/${PROBE_BUDGET_LIMITS.maxProbes} probes used)`,
          requiresApproval: true,
          executed: false,
          outcome: 'Escalated to owner approval due to probe budget limits',
        }
      }

      this.probeCount++
      return {
        decisionId,
        observationId: observation.observationId,
        decision: 'investigate',
        level: 2,
        actionRef: observation.observationId,
        reason: 'Read-only diagnostic investigation probe authorized within budget',
        requiresApproval: false,
        executed: true,
        outcome: `Probe #${this.probeCount} authorized`,
      }
    }

    // 3. Continuation of Existing Mission
    if (candidate === 'continue_existing_mission') {
      const continuationCtx = env.checkContinuationPrerequisites?.(observation.goalId, observation.missionId) ?? {
        goalIsActive: false,
        missionIsWaiting: false,
        milestonePreconditionsMet: false,
        budgetRemaining: 0,
        principalAuthorized: false,
        stopAllActive: false,
      }

      const allPreconditionsSatisfied =
        continuationCtx.goalIsActive &&
        continuationCtx.missionIsWaiting &&
        continuationCtx.milestonePreconditionsMet &&
        continuationCtx.budgetRemaining > 0 &&
        continuationCtx.principalAuthorized &&
        !continuationCtx.stopAllActive

      if (allPreconditionsSatisfied) {
        // Level 1: Pre-authorized continuation
        return {
          decisionId,
          observationId: observation.observationId,
          decision: 'continue_existing_mission',
          level: 1,
          actionRef: observation.missionId,
          reason: 'Pre-authorized continuation conditions satisfied for existing Mission',
          requiresApproval: false,
          executed: true,
          outcome: `Authorized continuation signaled for mission ${observation.missionId}`,
        }
      }

      // Preconditions not fully satisfied -> Escalate to Level 3 approval request
      const missingReason = [
        !continuationCtx.goalIsActive && 'goal not active',
        !continuationCtx.missionIsWaiting && 'mission not waiting',
        !continuationCtx.milestonePreconditionsMet && 'milestone unmet',
        continuationCtx.budgetRemaining <= 0 && 'budget exhausted',
        !continuationCtx.principalAuthorized && 'unauthorized',
      ]
        .filter(Boolean)
        .join(', ')

      return {
        decisionId,
        observationId: observation.observationId,
        decision: 'request_approval',
        level: 3,
        actionRef: observation.missionId,
        reason: `Continuation requires owner approval: ${missingReason || 'unmet conditions'}`,
        requiresApproval: true,
        executed: false,
        outcome: 'Escalated to owner approval: prerequisites not satisfied',
      }
    }

    // 4. Level 3 — Governed / Approval Required
    return {
      decisionId,
      observationId: observation.observationId,
      decision: 'request_approval',
      level: 3,
      actionRef: observation.observationId,
      reason: proposal.justification.slice(0, 390) || 'Action requires explicit owner authorization',
      requiresApproval: true,
      executed: false,
      outcome: 'Awaiting owner authorization',
    }
  }
}
