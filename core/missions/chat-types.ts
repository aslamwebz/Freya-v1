import type { ResearchSource } from '../research/evidence'

export interface ChatMissionProposal {
  readonly goal: string
  readonly scope: string
  readonly successCriteria: readonly string[]
}

export const CHAT_MISSION_POLICY = Object.freeze({ maxModelCalls: 3, maxActions: 3, maxExternalRequests: 32, maxPlanRevisions: 2, maxDurationMs: 30 * 60 * 1000, maxStepsPerPlan: 2 })

export interface ChatMissionBinding {
  readonly conversationId: string
  readonly proposalMessageId: string
  readonly ownerId: string
  readonly grantId: string
  readonly approvedAt: string
  readonly scope: string
  readonly paused: boolean
  readonly reportMessageId?: string
}

export interface MissionResearchEvidence {
  readonly sources: readonly ResearchSource[]
  readonly verified: boolean
  readonly failure: string | null
}

export interface ConversationMissionView {
  readonly proposalMessageId: string
  readonly missionId: string | null
  readonly status: string
  readonly paused: boolean
  readonly steps: readonly { stepId: string; intent: string; status: string }[]
  readonly blockers: readonly string[]
}
