import type { MissionRecord } from '../types'
import { defaultWaitMs } from './continuation'

export type MissionBudgetState = Pick<MissionRecord, 'budget' | 'spend' | 'planRevisions'>

export function remainingMissionBudget(mission: MissionBudgetState): {
  actions: number
  retries: number
  delegations: number
  planRevisions: number
} {
  return {
    actions: Math.max(0, mission.budget.maxActions - mission.spend.actions),
    retries: Math.max(0, mission.budget.maxRetries - mission.spend.retries),
    delegations: Math.max(0, mission.budget.maxDelegations - mission.spend.delegations),
    planRevisions: Math.max(0, mission.budget.maxPlanRevisions - mission.planRevisions),
  }
}

export function countOpenDelegations(mission: Pick<MissionRecord, 'activePlan'>): number {
  let open = 0
  for (const step of mission.activePlan?.steps ?? []) {
    if (step.status === 'delegated' || step.status === 'running') open += 1
  }
  return open
}

/** Number of live Missions other than the one currently being advanced. */
export function countSiblingMissions(liveMissionCount: number): number {
  return Math.max(0, liveMissionCount - 1)
}

/** The existing bounded wake policy, with time supplied by the runtime clock. */
export function missionWakeDelay(mission: MissionRecord, now: Date): number {
  return defaultWaitMs(mission, now)
}
