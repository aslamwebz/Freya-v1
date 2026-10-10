/**
 * THE EXECUTIVE DECISION ENGINE — Unified Decision-Making (Phase 4A & 4B).
 *
 * Pure functions only: no I/O, no clock read (injected `now`), no model, no
 * randomness. Same inputs + same clock = same decision.
 *
 * The core invariant:
 * > Executive decides what is eligible and preferable. It does not grant permission to execute it.
 *
 * It bridges Core's authoritative subsystems:
 * - Missions (open goals, progress, blockers, deadlines, priorities)
 * - Workforce (worker availability, capabilities, assignments)
 * - Guard/Governor (permissions, spending ceilings)
 * - STOP ALL (global safety override)
 */

import type { MissionPriority } from '../missions/autonomy/types'
import type { MissionSummaryView } from '../missions/types'
import type { WorkerView } from '../workforce/types'
import {
  EXECUTIVE_LIMITS,
  instantMs,
  type BoundedAction,
  type ExecutiveState,
  type ImportanceLevel,
  type PrioritizationResult,
  type PriorityTier,
  type RankedItem,
} from './types'
import { prioritize, type WorkItemMetadata } from './prioritizer'
import { coordinateItem, type WorkerInfo, type CoordinationItem, type CoordinatorContext } from './coordinator'
import { projectExecutiveState } from './projection'

export type ExecutiveDecisionKind =
  | 'start'
  | 'continue'
  | 'delegate'
  | 'defer'
  | 'pause'
  | 'escalate'
  | 'no_action'

export interface ExecutiveDecisionInput {
  readonly missions: readonly MissionSummaryView[]
  readonly workers?: readonly WorkerView[]
  readonly stopAllActive: boolean
  readonly guardMayManage: boolean
  readonly now: string // ISO date string
  readonly activeRunsCount?: number
  readonly maxConcurrentMissions?: number
  readonly maxConcurrentWorkers?: number
  readonly pendingApprovals?: ReadonlySet<string>
  readonly explicitPriorities?: ReadonlyMap<string, MissionPriority>
}

export interface ExecutiveCandidateEvaluation {
  readonly missionId: string
  readonly priority: MissionPriority
  readonly tier: PriorityTier
  readonly eligible: boolean
  readonly blockerReason: string | null
  readonly decisionProposal: ExecutiveDecisionKind
  readonly reasoning: readonly string[]
  readonly deadlineAt: string | null
  readonly assignedWorkerId: string | null
}

export interface ExecutiveDecisionOutcome {
  readonly decision: ExecutiveDecisionKind
  readonly selectedMissionId: string | null
  readonly reason: string
  readonly explanation: string
  readonly assignedWorkerId: string | null
  readonly evaluatedAt: string
  readonly candidates: readonly ExecutiveCandidateEvaluation[]
  readonly blockedMissions: readonly { readonly missionId: string; readonly reason: string }[]
  readonly deferredMissions: readonly { readonly missionId: string; readonly reason: string }[]
  readonly state: ExecutiveState
}

function priorityToImportance(priority: MissionPriority): ImportanceLevel {
  switch (priority) {
    case 'urgent':
      return 'critical'
    case 'important':
      return 'high'
    case 'routine':
    default:
      return 'normal'
  }
}

/**
 * Pure evaluation function connecting Core authoritative state to a bounded executive decision.
 */
export function evaluateExecutiveDecision(input: ExecutiveDecisionInput): ExecutiveDecisionOutcome {
  const { now, stopAllActive, guardMayManage, missions, workers = [] } = input
  const nowMs = instantMs(now) ?? Date.now()

  // 1. Critical Invariant: STOP ALL outranks all decisions
  if (stopAllActive) {
    const stopAction: BoundedAction = {
      actionId: 'action-stop-all',
      kind: 'stop',
      target: 'all',
      maxDurationMs: 0,
      maxAttempts: 0,
      deadlineAt: now,
    }
    const state: ExecutiveState = {
      whatMatters: [],
      why: ['STOP ALL is active; all autonomous decisions and actions are inhibited.'],
      whatIsBlocked: missions.map((m) => `${m.missionId}: stop_all_active`),
      whatIsUncertain: [],
      nextBoundedAction: stopAction,
      generatedAt: now,
    }
    return {
      decision: 'no_action',
      selectedMissionId: null,
      reason: 'stop_all_active',
      explanation: 'STOP ALL is active; all autonomous decisions and actions are inhibited.',
      assignedWorkerId: null,
      evaluatedAt: now,
      candidates: [],
      blockedMissions: missions.map((m) => ({ missionId: m.missionId, reason: 'stop_all_active' })),
      deferredMissions: [],
      state,
    }
  }

  // 2. Invariant: Guard capability check must be allowed
  if (!guardMayManage) {
    const state: ExecutiveState = {
      whatMatters: [],
      why: ['Guard evaluated mission.manage as denied; no executive scheduling authorized.'],
      whatIsBlocked: [],
      whatIsUncertain: [],
      nextBoundedAction: null,
      generatedAt: now,
    }
    return {
      decision: 'no_action',
      selectedMissionId: null,
      reason: 'guard_denied',
      explanation: 'Guard evaluated mission.manage as denied; no executive scheduling authorized.',
      assignedWorkerId: null,
      evaluatedAt: now,
      candidates: [],
      blockedMissions: [],
      deferredMissions: [],
      state,
    }
  }

  // 3. Filter open (non-terminal) missions
  const openMissions = missions.filter(
    (m) => m.status !== 'completed' && m.status !== 'failed' && m.status !== 'cancelled',
  )

  if (openMissions.length === 0) {
    const state: ExecutiveState = {
      whatMatters: [],
      why: ['No open missions require executive scheduling.'],
      whatIsBlocked: [],
      whatIsUncertain: [],
      nextBoundedAction: null,
      generatedAt: now,
    }
    return {
      decision: 'no_action',
      selectedMissionId: null,
      reason: 'no_open_missions',
      explanation: 'No open missions exist that require executive attention.',
      assignedWorkerId: null,
      evaluatedAt: now,
      candidates: [],
      blockedMissions: [],
      deferredMissions: [],
      state,
    }
  }

  // 4. Map available workers to executive WorkerInfo
  const workerPool: WorkerInfo[] = workers.map((w) => {
    const maxAssignments = w.budget?.maxOpenAssignments ?? 5
    const remainingAssignments = w.remaining?.assignments ?? maxAssignments
    const currentOpenAssignments = Math.max(0, maxAssignments - remainingAssignments)
    return {
      workerId: w.workerId,
      status: w.status === 'idle' ? 'idle' : w.status === 'working' ? 'working' : 'stopped',
      capabilities: [...w.capabilities],
      specialisation: w.specialisation,
      maxOpenAssignments: maxAssignments,
      currentOpenAssignments,
      remainingBudget: 100, // Normalized
    }
  })

  // 5. Evaluate each open mission for eligibility & map to WorkItemMetadata for ranking
  const candidateEvaluations: ExecutiveCandidateEvaluation[] = []
  const workItems: WorkItemMetadata[] = []
  const blockedMissions: { missionId: string; reason: string }[] = []
  const deferredMissions: { missionId: string; reason: string }[] = []

  for (const mission of openMissions) {
    const explicitPriority = input.explicitPriorities?.get(mission.missionId) ?? mission.priority
    const deadlineMs = mission.deadlineAt ? instantMs(mission.deadlineAt) : null
    const isDeadlineExpired = deadlineMs !== null && nowMs >= deadlineMs

    let eligible = true
    let blockerReason: string | null = null
    let proposal: ExecutiveDecisionKind = 'start'

    // Blocker / eligibility assessment
    if (isDeadlineExpired) {
      eligible = false
      blockerReason = 'deadline_expired'
      proposal = 'escalate'
      blockedMissions.push({ missionId: mission.missionId, reason: 'deadline_expired' })
    } else if (mission.pendingApproval !== null) {
      eligible = false
      blockerReason = `approval_pending:${mission.pendingApproval.approvalId}`
      proposal = 'defer'
      deferredMissions.push({ missionId: mission.missionId, reason: blockerReason })
    } else if (mission.blockers.includes('budget_exhausted')) {
      eligible = false
      blockerReason = 'budget_exhausted'
      proposal = 'pause'
      blockedMissions.push({ missionId: mission.missionId, reason: 'budget_exhausted' })
    } else if (mission.blockers.length > 0) {
      eligible = false
      blockerReason = `blocked:${mission.blockers[0] ?? 'unknown'}`
      proposal = 'defer'
      deferredMissions.push({ missionId: mission.missionId, reason: blockerReason })
    } else if (mission.status === 'stopped') {
      eligible = false
      blockerReason = 'mission_stopped'
      proposal = 'defer'
      deferredMissions.push({ missionId: mission.missionId, reason: 'mission_stopped' })
    } else if (mission.status === 'active' || mission.status === 'planning') {
      eligible = true
      proposal = 'continue'
    } else if (mission.status === 'ready' || mission.status === 'draft') {
      eligible = true
      proposal = 'start'
    }

    const importance = priorityToImportance(explicitPriority)
    const ownerIntent =
      explicitPriority === 'urgent'
        ? 'priority'
        : mission.status === 'stopped'
          ? 'defer'
          : 'none'

    workItems.push({
      itemId: mission.missionId,
      kind: 'mission',
      createdAt: mission.createdAt,
      deadlineAt: mission.deadlineAt,
      ownerImportance: importance,
      ownerIntent,
      dependencies: [],
      dependentCount: 0,
      evidenceState: 'fresh',
      confidence: 'high',
      verificationPending: mission.currentStep?.status === 'running',
      approvalPending: mission.pendingApproval !== null,
      budgetExhausted: mission.blockers.includes('budget_exhausted'),
      stopAllActive: false,
    })

    candidateEvaluations.push({
      missionId: mission.missionId,
      priority: explicitPriority,
      tier: explicitPriority === 'urgent' ? 'critical' : explicitPriority === 'important' ? 'high' : 'normal',
      eligible,
      blockerReason,
      decisionProposal: proposal,
      reasoning: [
        `Status: ${mission.status}`,
        `Priority: ${explicitPriority}`,
        ...(blockerReason ? [`Blocker: ${blockerReason}`] : ['Eligible for execution']),
      ],
      deadlineAt: mission.deadlineAt,
      assignedWorkerId: null,
    })
  }

  // 6. Deterministic prioritization pipeline
  const prioResult: PrioritizationResult = prioritize({
    now,
    items: workItems,
    evidence: [],
    activeItemIds: new Set(
      openMissions.filter((m) => m.status === 'active' || m.status === 'planning').map((m) => m.missionId),
    ),
  })

  // 7. Find the highest-priority ELIGIBLE candidate
  let chosenCandidate: ExecutiveCandidateEvaluation | null = null
  for (const ranked of prioResult.ranked) {
    const evalItem = candidateEvaluations.find((c) => c.missionId === ranked.itemId)
    if (evalItem && evalItem.eligible) {
      chosenCandidate = evalItem
      break
    }
  }

  // 8. Handle case where all open missions are ineligible (blocked or deferred)
  if (!chosenCandidate) {
    const whatMatters: RankedItem[] = candidateEvaluations.map((c, idx) => ({
      itemId: c.missionId,
      rank: idx + 1,
      priority: c.tier,
      urgency: 'normal',
      importance: priorityToImportance(c.priority),
      reasoning: c.reasoning,
      blockedReason: c.blockerReason,
      uncertainty: [],
    }))

    const state: ExecutiveState = {
      whatMatters: whatMatters.slice(0, EXECUTIVE_LIMITS.maxWhatMattersItems),
      why: ['Open missions exist but all are currently blocked or waiting for approvals.'],
      whatIsBlocked: blockedMissions.map((b) => `${b.missionId}: ${b.reason}`),
      whatIsUncertain: [],
      nextBoundedAction: null,
      generatedAt: now,
    }

    return {
      decision: 'no_action',
      selectedMissionId: null,
      reason: 'all_missions_ineligible',
      explanation: 'Open missions exist but all are currently blocked, stopped, or pending approval.',
      assignedWorkerId: null,
      evaluatedAt: now,
      candidates: candidateEvaluations,
      blockedMissions,
      deferredMissions,
      state,
    }
  }

  // 9. Resource Allocation (Worker Assignment if needed)
  let assignedWorkerId: string | null = null
  if (workerPool.length > 0) {
    const coordItem: CoordinationItem = {
      itemId: chosenCandidate.missionId,
      requiredCapabilities: ['cognition.request'],
      requiredBudget: 1,
      priority: chosenCandidate.priority === 'urgent' ? 1.0 : chosenCandidate.priority === 'important' ? 0.75 : 0.5,
      missionId: chosenCandidate.missionId,
      runId: null,
      requiresApproval: false,
      approvalId: null,
      allowedSpecialisations: [],
    }

    const coordContext: CoordinatorContext = {
      now,
      items: [coordItem],
      workers: workerPool,
      activeDelegations: [],
      stopAllActive: false,
      budgetRemaining: 100,
      pendingApprovals: new Set(),
      maxConcurrentAssignments: 10,
      guardCleared: true,
      governorAuthorized: true,
    }

    const coordResult = coordinateItem(coordItem, coordContext)

    if (coordResult.decision === 'proceed' && coordResult.workerId) {
      assignedWorkerId = coordResult.workerId
    } else if (coordResult.decision === 'wait' || coordResult.blockedReason === 'no_workers_available') {
      // If workers are required and all are busy, defer
      if (chosenCandidate.decisionProposal === 'start' && workerPool.every((w) => w.status !== 'idle')) {
        const deferredState = projectExecutiveState({
          now,
          prioritization: prioResult,
          plans: [],
          confidence: 'high',
        })
        return {
          decision: 'defer',
          selectedMissionId: chosenCandidate.missionId,
          reason: 'workers_busy',
          explanation: `Mission ${chosenCandidate.missionId} is highest priority, but all suitable workers are currently busy.`,
          assignedWorkerId: null,
          evaluatedAt: now,
          candidates: candidateEvaluations,
          blockedMissions,
          deferredMissions,
          state: deferredState,
        }
      }
    }
  }

  // 10. Construct next bounded action and projected state
  const nextAction: BoundedAction = {
    actionId: `action-${chosenCandidate.decisionProposal}-${chosenCandidate.missionId}`,
    kind: chosenCandidate.decisionProposal === 'start' || chosenCandidate.decisionProposal === 'continue' ? 'execute' : 'wait',
    target: chosenCandidate.missionId,
    maxDurationMs: EXECUTIVE_LIMITS.maxWaitMs,
    maxAttempts: EXECUTIVE_LIMITS.maxRetryAttempts,
    deadlineAt: chosenCandidate.deadlineAt ?? new Date(nowMs + EXECUTIVE_LIMITS.maxWaitMs).toISOString(),
  }

  const projectedState = projectExecutiveState({
    now,
    prioritization: prioResult,
    plans: [],
    confidence: 'high',
  })

  return {
    decision: chosenCandidate.decisionProposal,
    selectedMissionId: chosenCandidate.missionId,
    reason: 'highest_priority_eligible',
    explanation: `Selected mission ${chosenCandidate.missionId} (${chosenCandidate.priority}) to ${chosenCandidate.decisionProposal}.`,
    assignedWorkerId,
    evaluatedAt: now,
    candidates: candidateEvaluations,
    blockedMissions,
    deferredMissions,
    state: {
      ...projectedState,
      nextBoundedAction: nextAction,
    },
  }
}
