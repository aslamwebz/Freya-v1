import type { RunRecord, StepRecord } from '../work/types'
import { countPlanSteps, evidenceCounts } from './metrics'
import type { WorkTruthPort } from './projection'
import type { MissionRecord, MissionVerificationContext } from './types'

type VerificationRunStatus = 'completed' | 'failed' | 'cancelled' | 'verified_steps' | 'non_terminal'

export interface MissionVerificationContextInput {
  readonly missionId: string
  readonly mission: MissionRecord
  readonly requiredRunIds: readonly string[]
  readonly work: WorkTruthPort
  readonly now: () => Date
}

/** Build the verifier's bounded context from counts, statuses and ids only. */
export function buildMissionVerificationContext(
  input: MissionVerificationContextInput,
): MissionVerificationContext {
  const { missionId, mission, requiredRunIds, work } = input
  const runStatuses: Record<string, VerificationRunStatus> = {}
  const runStepStatuses: Record<string, { verified: number; total: number; failed: number; other: number }> = {}

  for (const runId of requiredRunIds) {
    const run: RunRecord | undefined = work.run(runId)
    const steps: readonly StepRecord[] = work.stepsOf(runId)
    const verified = steps.filter((step) => step.status === 'verified').length
    const failed = steps.filter((step) => step.status === 'failed').length
    runStepStatuses[runId] = {
      verified,
      total: steps.length,
      failed,
      other: steps.length - verified - failed,
    }

    if (run === undefined) {
      runStatuses[runId] = 'cancelled'
      continue
    }
    if (work.isSettled(run.status)) {
      runStatuses[runId] = run.status === 'failed' ? 'failed' : run.status === 'cancelled' ? 'cancelled' : 'completed'
      continue
    }
    runStatuses[runId] = 'non_terminal'
  }

  const evidence = evidenceCounts(mission.evidence, input.now())
  const plan = mission.activePlan
  const stepCounts = countPlanSteps(plan?.steps ?? [])

  return {
    missionId,
    status: mission.status,
    requiredRunIds: [...requiredRunIds],
    runStatuses,
    runStepStatuses,
    stepCounts,
    observedResults: evidence.observed,
    // **Excluded from** `observedResults`, not added to it. A verifier reading
    // `observedResults` and seeing 40 when 10 of those expired would conclude the
    // outcome is established on 40 fresh observations, which it is not.
    expiredObservedResults: evidence.expired,
    reportedResults: evidence.reported,
    requestedQuantity: mission.requestedQuantity,
    blocked: mission.blockers.length > 0,
    // Reads the Mission's *pointer*, not a gate lifecycle. `outcome === null` means Work has
    // not reported how the gate went, so it is still open — the Mission is waiting, and
    // saying so is the whole claim being made here.
    approvalPending: mission.approval !== null && mission.approval.outcome === null,
    uncertainEffects: mission.blockers.filter((blocker) => blocker.code === 'step_failed').length,
  }
}
