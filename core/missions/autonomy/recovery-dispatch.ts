import type { MissionCommandOutcome, MissionReason, MissionRecord } from '../types'
import type { RecoveryAction } from './recovery'

export interface MissionRecoveryDispatchPort {
  missions: {
    transition(input: { missionId: string; to: MissionRecord['status']; reason: MissionReason }): Promise<MissionCommandOutcome>
    interruptStep(input: { missionId: string; planId: string; stepId: string; consequential: boolean }): Promise<MissionCommandOutcome>
    setBlocker(input: { missionId: string; code: string; stepId: string | null; raised: boolean }): Promise<MissionCommandOutcome>
    scheduleWake(input: {
      missionId: string
      wakeId: string
      kind: 'event' | 'time' | 'manual'
      source: 'fabric' | 'time' | 'owner'
      dueAt: string
      eventType: string | null
    }): Promise<MissionCommandOutcome>
  }
  newId(): string
}

export class MissionRecoveryDispatch {
  constructor(private readonly port: MissionRecoveryDispatchPort) {}
  async applyRecovery(mission: MissionRecord, actions: readonly RecoveryAction[]): Promise<void> {
    for (const action of actions) {
      switch (action.code) {
        // **No approval case, and that is the point.** `planRecovery` emits nothing about
        // gates, because a Mission does not own one. Work's TTL expires a gate and writes
        // `work.approval.expired`; the next decision reads that outcome through
        // `approvalState` and acts on it. Recovery used to expire gates itself, and with
        // no durable per-gate instant that meant expiring *every* pending gate on *every*
        // reconciliation — which made a restart into a refusal, quietly withdrawing a
        // question before any person had answered it. That failure is not reachable from
        // here any more.
        case 'settle_expired':
          await this.port.missions.transition({ missionId: mission.missionId, to: 'failed', reason: 'deadline_expired' })
          break
        case 'mark_interrupted':
          // Recorded even when not acted on. The uncertainty becomes durable, which is
          // what stops a later restart from treating the step as merely unfinished.
          await this.port.missions.interruptStep({
            missionId: mission.missionId,
            planId: mission.activePlan?.planId ?? '',
            stepId: action.stepId ?? '',
            consequential: !action.automatic,
          })
          break
        case 'release_undelegated':
          await this.port.missions.setBlocker({ missionId: mission.missionId, code: 'step_failed', stepId: action.stepId, raised: false })
          break
        case 'retry_safe_running':
          await this.port.missions.setBlocker({ missionId: mission.missionId, code: 'step_failed', stepId: action.stepId, raised: false })
          break
        case 'record_missed_wake':
        case 'clear_fired_wake':
        case 'verify_expired_evidence':
        case 'reset_never_started':
        case 'reopen_stopped':
          // Nothing to write. These are *observations* about the restored state, and
          // the next `step()` re-decides from facts that already include them — writing
          // an event for each would put noise in a journal somebody reads as history.
          break
      }
    }
  }

  async scheduleWake(
    missionId: string,
    mission: MissionRecord,
    kind: 'event' | 'time' | 'manual',
    source: 'fabric' | 'time' | 'owner',
    dueAt: string,
    eventType: string | null,
  ): Promise<void> {
    // Never later than the Mission's own deadline. A wake after the deadline is a wake
    // for a Mission that will already have been settled, and it is the kind of dangling
    // promise that makes a parked Mission look like it is still going to do something.
    const bound = Math.min(Date.parse(dueAt), Date.parse(mission.deadlineAt))
    await this.port.missions.scheduleWake({
      missionId,
      wakeId: this.port.newId(),
      kind,
      source,
      dueAt: new Date(bound).toISOString(),
      eventType: kind === 'event' ? eventType : null,
    })
  }

}
