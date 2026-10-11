import type { WorkRisk } from '../../work/types'
import { MISSION_REASONS, type MissionCommandOutcome, type MissionReason, type MissionRecord } from '../types'
import type { MissionStepRecord } from './types'
import { asksForGate } from './authority'
import { asApproval, applied, type AppliedDecision } from './results'

export interface MissionStepExecutionResult {
  readonly ok: true
  readonly runId: string
  readonly verified: boolean
  readonly observedResults: number
  readonly reportedResults: number
  readonly summaryLength: number
  readonly awaitingApproval: boolean
}

export interface MissionStepExecutionPort {
  missions: {
    transitionStep(input: {
      missionId: string
      planId: string
      stepId: string
      to: MissionStepRecord['status']
      workerId?: string | null
      runId?: string | null
      attempts?: number
      reason?: string | null
    }): Promise<MissionCommandOutcome>
    charge(input: { missionId: string; modelCalls: number; actions: number; externalRequests: number; retries: number; delegations: number }): Promise<MissionCommandOutcome>
    setBlocker(input: { missionId: string; code: string; stepId: string | null; raised: boolean }): Promise<MissionCommandOutcome>
    recordEvidence(input: {
      missionId: string
      evidenceId: string
      stepId: string | null
      kind: 'result' | 'observation' | 'report' | 'refusal'
      origin: 'observed' | 'reported'
      summaryLength: number
      expiresAt: string | null
    }): Promise<MissionCommandOutcome>
  }
  execute(input: {
    missionId: string
    stepId: string
    capability: string
    verifier: string
    risk: WorkRisk
    requiresApproval: boolean
    signal: AbortSignal
  }): Promise<MissionStepExecutionResult | { readonly ok: false; readonly reason: string }>
  observeApproval(
    missionId: string,
    step: MissionStepRecord,
    runId: string | null,
    source: 'requested' | 'observed',
    refusals: string[],
  ): Promise<MissionRecord['status']>
  transitionTo(
    missionId: string,
    status: MissionRecord['status'],
    reason: MissionReason,
    refusals: string[],
  ): Promise<MissionRecord['status']>
  newId(): string
}

export class MissionStepExecutor {
  constructor(private readonly port: MissionStepExecutionPort) {}
  async execute(
    missionId: string,
    mission: MissionRecord,
    step: MissionStepRecord,
    workerId: string,
    assignmentId: string,
    refusals: string[],
  ): Promise<AppliedDecision> {
    const planId = mission.activePlan?.planId ?? ''
    const controller = new AbortController()

    // The step becomes `running` *before* the action starts, strictly. That ordering is
    // what makes recovery able to distinguish "in flight" from "not started" — and an
    // executor that failed after starting its action but before answering would
    // otherwise leave no trace that anything had happened.
    await this.port.missions.transitionStep({
      missionId,
      planId,
      stepId: step.stepId,
      to: 'running',
      workerId,
      attempts: step.attempts + 1,
    })
    await this.port.missions.charge({
      missionId,
      modelCalls: 0,
      actions: 1,
      externalRequests: step.risk === 'consequential' ? 1 : 0,
      retries: 0,
      delegations: 0,
    })

    const outcome = await this.port.execute({
      missionId,
      stepId: step.stepId,
      capability: step.capability,
      verifier: step.verifier,
      risk: step.risk,
      // The plan's request, not a decision. It becomes `requiresApproval` on the Run, and
      // Work's Guard decides whether that becomes a gate.
      requiresApproval: asksForGate(step),
      signal: controller.signal,
    })
    void assignmentId

    // **An open gate is not a failure.** This is the branch that makes the single-gate
    // design work, and getting it wrong is the interesting mistake available here.
    //
    // The executor reports `awaiting_approval` because Work parked the Run at its gate:
    // Guard evaluated the capability and wanted a signature first. Nothing ran, and
    // nothing was disproved — so the step stays `running` (it *was* handed to Work and is
    // genuinely in flight from Work's point of view), the Mission parks in
    // `approval-required` pointing at Work's gate, and the reported decision becomes
    // `request_approval`.
    //
    // Marking it `failed` instead would be a lie in the most expensive direction: the
    // journal would say the step failed, the budget would have been charged for an action
    // that never happened, and a person answering "yes" a moment later would watch a
    // Mission that had already recorded the consequence of their own decision.
    if (outcome.ok && outcome.awaitingApproval) {
      return asApproval(
        await this.port.observeApproval(
          missionId,
          step,
          outcome.runId,
          asksForGate(step) ? 'requested' : 'observed',
          refusals,
        ),
        step.stepId,
      )
    }

    if (!outcome.ok) {
      refusals.push(outcome.reason)
      await this.port.missions.transitionStep({
        missionId,
        planId,
        stepId: step.stepId,
        to: 'failed',
        workerId,
        attempts: step.attempts + 1,
        reason: MISSION_REASONS.step_failed,
      })
      await this.port.missions.setBlocker({ missionId, code: 'step_failed', stepId: step.stepId, raised: true })
      return applied(await this.port.transitionTo(missionId, 'blocked', 'step_failed', refusals))
    }

    // The Run was already attached by the executor, through the one sequence that pairs
    // creation with admission (`attachChildRunWhileCreating`). Attaching it *again* here
    // would be a second, redundant call — and it is deliberately not defended against
    // silently, because the engine makes it idempotent and a redundant write is noise in a
    // journal somebody reads as a Mission's history.
    //
    // So this line only records the id on the *step*, which is a different fact: the step
    // now knows which Run executed it.
    void outcome.runId

    // Evidence first, then the step's status. If the process dies between them, recovery
    // finds a `running` step with evidence already recorded and can reconcile from the
    // evidence — which is truthful — rather than losing the observation.
    for (let i = 0; i < outcome.observedResults; i += 1) {
      await this.port.missions.recordEvidence({
        missionId,
        evidenceId: this.port.newId(),
        stepId: step.stepId,
        kind: 'result',
        origin: 'observed',
        summaryLength: outcome.summaryLength,
        expiresAt: null,
      })
    }
    for (let i = 0; i < outcome.reportedResults; i += 1) {
      // Recorded, displayed, and **not** counted: a capability saying it found something
      // is not a finding. This is the reported/observed split doing its job.
      await this.port.missions.recordEvidence({
        missionId,
        evidenceId: this.port.newId(),
        stepId: step.stepId,
        kind: 'report',
        origin: 'reported',
        summaryLength: outcome.summaryLength,
        expiresAt: null,
      })
    }

    await this.port.missions.transitionStep({
      missionId,
      planId,
      stepId: step.stepId,
      to: outcome.verified ? 'verified' : 'failed',
      workerId,
      runId: outcome.runId,
      attempts: step.attempts + 1,
      reason: outcome.verified ? MISSION_REASONS.step_verified : MISSION_REASONS.step_failed,
    })
    if (outcome.verified) {
      // The blocker this step caused is cleared, so a Mission that failed once and then
      // succeeded does not stay blocked for ever.
      await this.port.missions.setBlocker({ missionId, code: 'step_failed', stepId: step.stepId, raised: false })
      return applied('active')
    }
    await this.port.missions.setBlocker({ missionId, code: 'step_failed', stepId: step.stepId, raised: true })
    return applied(await this.port.transitionTo(missionId, 'blocked', 'step_failed', refusals))
  }

}
