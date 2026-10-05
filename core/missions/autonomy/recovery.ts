import { evidenceCounts } from '../engine'
import { isTerminalMissionStatus } from '../types'
import type { MissionReason, MissionRecord } from '../types'
import { isFresh } from './continuation'
import type { MissionStepRecord } from './types'

/**
 * MISSION RECOVERY.
 *
 * What a restart is allowed to conclude, and what it must not.
 *
 * ## The one question this file exists to answer
 *
 * > A Mission was doing something when the process died. Should it do it again?
 *
 * The honest answer is *it depends, and the dependence is not knowable*. So the answer
 * here is always the same shape: anything that might have had an external effect is
 * recorded as `interrupted` and left for a person, and anything that provably did not is
 * safe to retry.
 *
 * That splits the steps four ways:
 *
 * | what the journal last said | what recovery concludes |
 * | --- | --- |
 * | step was `pending`, never delegated | **safe** — nothing was attempted |
 * | step was `delegated`, no run | **safe** — a worker held it, no action ran |
 * | step was `running`, a run id, `risk: none` | **retryable** — reading is repeatable |
 * | step was `running`, a run id, `risk: consequential` | **interrupted** — may have happened |
 *
 * ## Why the consequential case is never retried automatically
 *
 * Sending an email twice is not the same as failing to send it once. A `consequential`
 * step interrupted mid-action may have taken effect, and re-running it on the strength
 * of a guess would duplicate a real-world effect. Freya cannot un-send an email, cannot
 * un-charge a card and cannot un-post a message — so the only honest recovery is to
 * record the uncertainty and stop.
 *
 * That is why `mission.step.interrupted` **forgets the run id** in the fold. Leaving it
 * would let a later reconciliation attach the Run again and read the second attempt as a
 * resumption of the first, which is precisely the double-execution this file prevents.
 *
 * ## Determinism
 *
 * `planRecovery` is a pure function of (records, now). Same journal, same clock, same
 * report — which is what makes it testable, and what makes "recovery is deterministic"
 * checkable rather than aspirational. It reads no store, opens no connection and calls
 * no port.
 */

export type RecoveryActionCode =
  | 'settle_expired'
  /**
   * Deliberately absent: anything about approvals.
   *
   * There is no `expire_approvals` and no `settle_approvals`. A Mission does not own an
   * approval, so it has nothing to reconcile about one — Work's TTL decides when a gate
   * expires, Work writes `work.approval.expired`, and the Mission reads that outcome back
   * through its pointer. Recovery's job is to reconcile *this* subsystem's records, and an
   * approval gate is not one of them.
   */
  | 'record_missed_wake'
  | 'reset_never_started'
  | 'release_undelegated'
  | 'retry_safe_running'
  | 'mark_interrupted'
  | 'clear_fired_wake'
  | 'verify_expired_evidence'
  | 'reopen_stopped'

/**
 * One thing recovery concluded.
 *
 * `stepId` is null for Mission-wide actions. `reason` is a closed code, so a report can
 * be journalled without a sentence — which matters because a recovery report is
 * something a person reads *after* something went wrong, and it should not become a
 * place where a capability's error message leaks into the journal.
 */
export interface RecoveryAction {
  readonly code: RecoveryActionCode
  readonly missionId: string
  readonly stepId: string | null
  readonly reason: MissionReason
  /**
   * Whether recovery may apply this itself.
   *
   * Almost always true. False for `mark_interrupted` on a consequential step, because
   * recording the interruption is safe but **acting on it** is a person's decision. The
   * distinction is kept explicit rather than assumed: an action a caller silently skips
   * and an action it cannot perform are different failures.
   */
  readonly automatic: boolean
}

export interface RecoveryReport {
  readonly missionId: string
  readonly actions: readonly RecoveryAction[]
  /**
   * How many steps have an unknown external effect.
   *
   * Non-zero means the honest answer to "is this Mission safe to continue?" is no. It is
   * surfaced rather than inferred from the actions list, because it is the one number a
   * person actually wants.
   */
  readonly uncertainEffects: number
  /** Whether anything at all needs to happen. */
  readonly quiescent: boolean
}

/**
 * What to do about one Mission after a restart.
 *
 * Pure, ordered, and total. Returns an empty action list for a Mission with nothing
 * wrong, which is the common case and the one that must be cheap.
 *
 * The order is the order the checks are *allowed* to be applied in, and it is not
 * arbitrary:
 *
 * 1. **Deadline before steps.** A Mission past its lifetime is settled, and settling it
 *    means no step action should be taken — so this has to be visible to the caller
 *    before the per-step logic runs.
 * 2. **Steps, in plan order.** Deterministic output from an unordered source is not
 *    deterministic, and a recovery report whose order changed between runs would be
 *    impossible to compare after an incident.
 */
export function planRecovery(mission: MissionRecord, now: Date): RecoveryReport {
  const actions: RecoveryAction[] = []
  const push = (code: RecoveryActionCode, stepId: string | null, reason: MissionReason, automatic = true): void => {
    actions.push({ code, missionId: mission.missionId, stepId, reason, automatic })
  }

  // A settled Mission is left completely alone. There is nothing to recover *for*, and
  // writing recovery events against a completed Mission would be noise in a journal that
  // somebody may read as its history.
  if (isTerminalMissionStatus(mission.status)) {
    return { missionId: mission.missionId, actions: [], uncertainEffects: 0, quiescent: true }
  }

  // 1. Nothing.
  //
  // There is no `expire_approvals` action here any more, and the gap is the design.
  //
  // A Mission used to own its approval gates: it opened them, decided them and expired
  // them, with its own `MissionApprovalGate` lifecycle and its own id sequence. That was a
  // second approval system inside Core, asking a person the same question Work was
  // already asking and answering neither one.
  //
  // The gate is **Work's** now. Work's TTL expires it and Work writes
  // `work.approval.expired`; this Mission reads the outcome back through its pointer and
  // acts on Work's record. There is nothing for recovery to expire, because there is
  // nothing here that owns a clock on a decision.
  //
  // The other reason there is no action is the one that used to bite: with no durable
  // per-gate instant, "is this gate still open" could not be asked, so every pending gate
  // was expired on every reconciliation — and a restart silently withdrew a question
  // before any person had answered it. That failure is not reachable from here at all now.
  // 2. The deadline.
  if (Date.parse(now.toISOString()) >= Date.parse(mission.deadlineAt)) {
    push('settle_expired', null, 'deadline_expired')
  }

  // 3. A wake whose instant passed while the process was down. Recorded, so "we waited
  //    for an event and it never came" is a fact in the journal rather than an absence.
  const wake = mission.wake
  if (wake !== null && wake.firedAt === null && Date.parse(now.toISOString()) >= Date.parse(wake.dueAt)) {
    push('record_missed_wake', null, 'wake_missed')
  }
  // A wake that *had* fired before the crash is cleared so the next wait can be
  // scheduled. A fired wake left in place would make `mayWake` refuse forever, which is
  // a Mission that can never wake again.
  if (wake !== null && wake.firedAt !== null) {
    push('clear_fired_wake', null, 'woken')
  }

  // 4. Evidence that went stale while down. Not an action on the Mission's status — the
  //    consequence is that `evidenceCounts` reports it as expired wherever it is read, and
  //    this records that recovery noticed.
  const evidence = evidenceCounts(mission.evidence, now)
  if (evidence.expired > 0) {
    push('verify_expired_evidence', null, 'verification_expired')
  }

  // 5. Steps, in plan order.
  let uncertain = 0
  for (const step of mission.activePlan?.steps ?? []) {
    const action = recoverStep(step, now)
    if (action !== null) {
      uncertain += action.code === 'mark_interrupted' ? 1 : 0
      // Stamped here, where the Mission is in scope. See `recoverStep`'s note.
      actions.push({ ...action, missionId: mission.missionId })
    }
  }

  // 6. STOP ALL. A Mission left `stopped` by a crash stays stopped: the gate is latched
  //    and only the owner reopens it. Reported rather than actioned, because there is
  //    nothing automatic to do — the honest recovery outcome is "still stopped".
  if (mission.status === 'stopped') {
    push('reopen_stopped', null, 'stopped')
  }

  return {
    missionId: mission.missionId,
    actions,
    uncertainEffects: uncertain,
    quiescent: actions.length === 0,
  }
}

/**
 * What to do about one step.
 *
 * The four-way split from the module note, and the reason the `risk` field is consulted
 * here and nowhere else in recovery.
 */
function recoverStep(step: MissionStepRecord, now: Date): RecoveryAction | null {
  // `missionId` is left blank here and stamped by the caller, because this function does
  // not know which Mission the step belongs to and inventing one would produce a report
  // whose actions named the wrong Mission.
  void now
  const at = (code: RecoveryActionCode, reason: MissionReason, automatic = true): RecoveryAction => ({
    code,
    missionId: '',
    stepId: step.stepId,
    reason,
    automatic,
  })

  switch (step.status) {
    case 'pending':
      // Never attempted. `reset_never_started` exists for the case where the step was
      // left `pending` but the Mission had moved on around it — a no-op in the ordinary
      // case, and recorded so a restored plan is byte-identical to the one before the
      // crash.
      return null

    case 'delegated':
      // A worker held it. Whether the worker started anything is unknown from the
      // journal, so a `consequential` delegated step is treated as interrupted rather
      // than released — a worker *may* have acted before the process died.
      return step.risk === 'consequential'
        ? at('mark_interrupted', 'interrupted', false)
        : at('release_undelegated', 'delegated')

    case 'running':
      // An action was in flight. `runId` being present is what makes the difference
      // between "probably started" and "definitely might have".
      if (step.runId === null) {
        return step.risk === 'consequential'
          ? at('mark_interrupted', 'interrupted', false)
          : at('release_undelegated', 'delegated')
      }
      return step.risk === 'consequential'
        ? at('mark_interrupted', 'interrupted', false)
        : at('retry_safe_running', 'interrupted')

    case 'blocked':
      // Already blocked. Nothing to recover, and in particular an `interrupted` block
      // stays blocked — recovery must not quietly un-park a step whose effect is unknown.
      return null

    default:
      // Terminal: verified, failed, cancelled or skipped. Nothing to recover.
      return null
  }
}

/**
 * Whether a Mission is safe to continue automatically.
 *
 * `false` when anything has an unknown external effect. This is the question a caller
 * should ask before letting the loop run, and it is asked here rather than inferred by
 * each caller from the action list — three callers inferring it three ways is three
 * answers.
 */
export function isSafeToContinue(report: RecoveryReport): boolean {
  return report.uncertainEffects === 0
}

/**
 * Whether evidence backing a Mission is still fresh.
 *
 * Separate from `planRecovery` because completion needs this answer and recovery does
 * not: a verifier asks "does this evidence still hold?" and gets one boolean.
 *
 * A Mission with **no** evidence is not fresh — `false`, not `true`. An empty set
 * vacuously satisfies a freshness test, and "vacuously satisfied" would let a Mission
 * with nothing behind it read as though it had everything behind it.
 */
export function evidenceIsFresh(mission: MissionRecord, now: Date): boolean {
  const evidence = evidenceCounts(mission.evidence, now)
  if (evidence.observed === 0) return false
  if (evidence.expired > 0) return false
  return mission.evidence.every((item) => item.expiresAt === null || isFresh(item.expiresAt, now))
}