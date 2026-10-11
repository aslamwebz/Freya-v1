import type { Capability, PrincipalId } from '../../shared/contracts/security'
import type { CoreEventType } from '../events/envelope'
import type { WorkCapability, WorkCapabilityContext, WorkCapabilityRequest, WorkCapabilityResult, WorkObservationContent, WorkRegistry, WorkVerificationOutcome } from './capability'
import type { WorkState } from './state'
import type { LimitName, StepRecord } from './types'
import { WORK_LIMITS, WORK_REASONS } from './types'

export interface LiveWorkPlan {
  readonly stepId: string
  readonly key: string
  readonly index: number
  readonly capabilityName: string
  readonly verifierName: string
  readonly requiresApproval: boolean
  readonly input: Record<string, unknown>
}

export interface LiveCapabilityCall {
  readonly controller: AbortController
  readonly expired: Promise<'duration'>
  readonly cancelled: Promise<'cancelled'>
  signalCancel(): void
  fired(): boolean
  clear(): void
}

type CapabilityOutcome =
  | { kind: 'resolved'; value: WorkCapabilityResult }
  | { kind: 'rejected'; error: unknown }
  | { kind: 'expired' }
  | { kind: 'cancelled' }
type VerificationOutcome =
  | { kind: 'answered'; verdict: WorkVerificationOutcome }
  | { kind: 'rejected'; error: unknown }
  | { kind: 'expired' }
  | { kind: 'cancelled' }
type DeadlinePhase = 'capability' | 'verification'

export interface WorkStepExecutionPort {
  state(): WorkState
  plans: ReadonlyMap<string, readonly LiveWorkPlan[]>
  calling: Map<string, LiveCapabilityCall>
  cancelRequested: ReadonlyMap<string, string>
  deadlineHit: Map<string, number>
  observationSummaries: Map<string, string>
  registry: WorkRegistry
  authorizer: { evaluate(capability: Capability): { allowed: true } | { allowed: false; outcome: 'deny' | 'approval_required'; reason: string } }
  principalId: PrincipalId
  now(): Date
  newId(): string
  settlement: {
    emit(type: CoreEventType, payload: Record<string, unknown>): Promise<void>
    writeStep(stepId: string, to: 'ready' | 'running' | 'verified' | 'failed' | 'cancelled' | 'skipped', payload: Record<string, unknown>): Promise<boolean>
    grantedApproval(step: StepRecord): boolean
    requestApproval(runId: string, stepId: string, live: LiveWorkPlan, capability: WorkCapability, justification: string): Promise<boolean>
    recordGuardDenial(reason: string, capability: Capability): Promise<void>
    finishCancelled(runId: string, reason: string): Promise<void>
    exhaustedLimit(runId: string): LimitName | null
    recordLimit(runId: string, limit: LimitName): Promise<void>
    failStep(runId: string, stepId: string, reason: string): Promise<boolean>
  }
}

export class WorkStepExecutor {
  constructor(private readonly port: WorkStepExecutionPort) {}
  async execute(runId: string, stepId: string): Promise<boolean> {
    const run = this.port.state().runs.get(runId)
    const step = this.port.state().steps.get(stepId)
    const live = this.port.plans.get(runId)?.find((candidate) => candidate.stepId === stepId)
    if (!run || !step || !live) return false

    const capability = this.port.registry.capability(live.capabilityName)
    if (!capability) return this.port.settlement.failStep(runId, stepId, WORK_REASONS.capabilityMissing)
    const verifier = this.port.registry.verifier(live.verifierName)
    if (!verifier) return this.port.settlement.failStep(runId, stepId, WORK_REASONS.verifierMissing)

    // A step parked in `awaiting_approval` has already cleared its gate, and so has
    // one whose recorded approval was granted — otherwise approving a consequential
    // request would simply park the step in front of the same gate again.
    const granted = this.port.settlement.grantedApproval(step)
    if (step.status !== 'awaiting_approval' && !granted) {
      const guard = this.port.authorizer.evaluate(capability.capability)
      if (!guard.allowed) {
        if (guard.outcome === 'approval_required') {
          return this.port.settlement.requestApproval(runId, stepId, live, capability, guard.reason)
        }
        await this.port.settlement.recordGuardDenial(guard.reason, capability.capability)
        return this.port.settlement.failStep(runId, stepId, guard.reason)
      }

      if (capability.risk === 'consequential' || live.requiresApproval) {
        return this.port.settlement.requestApproval(
          runId,
          stepId,
          live,
          capability,
          capability.risk === 'consequential'
            ? 'this capability is consequential and will not run without your approval'
            : 'this step asked to be approved before it runs',
        )
      }
    }

    if (this.port.cancelRequested.has(runId)) {
      await this.port.settlement.finishCancelled(runId, this.port.cancelRequested.get(runId) ?? WORK_REASONS.cancelled)
      return false
    }

    const ceiling = this.port.settlement.exhaustedLimit(runId)
    if (ceiling !== null) {
      await this.port.settlement.recordLimit(runId, ceiling)
      return this.port.settlement.failStep(runId, stepId, limitReason(ceiling))
    }

    const attempt = step.attempts + 1
    const actionId = this.port.newId()
    const request: WorkCapabilityRequest = {
      runId,
      stepId,
      stepKey: step.key,
      actionId,
      attempt,
      input: live.input,
      correlationId: runId,
    }

    const controller = new AbortController()
    /**
     * The remaining wall clock for this Run, computed *before* the capability is
     * called rather than before the next one. Checking it between Actions was not a
     * ceiling at all: a capability could start a second before the deadline and run
     * for an hour afterwards, and the Run would still be allowed to continue.
     */
    const deadlineAt = Date.parse(run.startedAt ?? this.port.now().toISOString()) + run.limits.maxDurationMs
    const remainingMs = deadlineAt - this.port.now().getTime()
    if (remainingMs <= 0) {
      await this.port.settlement.recordLimit(runId, 'duration')
      return this.port.settlement.failStep(runId, stepId, limitReason('duration'))
    }

    const armed = this.armDeadline(runId, controller, remainingMs)
    this.port.calling.set(runId, armed)
    const began = this.port.now().getTime()

    try {
      await this.port.settlement.emit('work.step.started', {
        runId,
        stepId,
        stepKey: step.key,
        index: step.index,
        capability: capability.name,
        attempt,
      })
      await this.port.settlement.emit('work.action.started', {
        runId,
        stepId,
        actionId,
        attempt,
        capability: capability.name,
        principal: this.port.principalId,
      })

      /**
       * Raced, not awaited.
       *
       * Aborting asks a capability to stop; it does not make it stop. A capability
       * that ignores its signal would hold this Run open indefinitely, so the
       * engine stops *waiting* at the deadline and settles the Run itself. The
       * capability's promise is still given both handlers, so if it eventually
       * settles — or rejects — nothing escapes as an unhandled rejection and its
       * result is simply ignored. That is the honest boundary: JavaScript cannot
       * forcibly terminate arbitrary code, so the engine stops *believing* it
       * instead of pretending it stopped.
       */
      const context: WorkCapabilityContext = { signal: controller.signal, now: this.port.now }
      const outcome = await Promise.race([
        capability.execute(request, context).then(
          (value): CapabilityOutcome => ({ kind: 'resolved', value }),
          (error: unknown): CapabilityOutcome => ({ kind: 'rejected', error }),
        ),
        armed.expired.then((): CapabilityOutcome => ({ kind: 'expired' })),
        armed.cancelled.then((): CapabilityOutcome => ({ kind: 'cancelled' })),
      ])

      const elapsed = Math.max(0, this.port.now().getTime() - began)

      // Cancellation is checked first, and always. It wins a race with the
      // deadline because a person pressing stop is a more specific fact than a
      // budget running out, and because `cancelRun` set its flag in the same
      // synchronous turn as the abort.
      if (this.port.cancelRequested.has(runId)) {
        const reason = this.port.cancelRequested.get(runId) ?? WORK_REASONS.cancelled
        await this.port.settlement.emit('work.action.cancelled', { runId, stepId, actionId, attempt, reason })
        await this.port.settlement.writeStep(stepId, 'cancelled', { runId, reason })
        await this.port.settlement.finishCancelled(runId, reason)
        return false
      }

      /**
       * A capability that resolved *after* the deadline is not a success.
       *
       * `armed.fired()` rather than only the race outcome, because a capability can
       * win the race microseconds before the timer fires. Without this check a slow
       * capability could complete an Action after its budget expired and the Run
       * would go on to `completed` — which is the exact failure this ceiling exists
       * to prevent.
       */
      if (outcome.kind === 'cancelled') {
        // The race was released by the owner rather than by the clock. `cancelRun`
        // sets its flag and releases the race in the same synchronous turn, so the
        // branch above normally gets there first; this covers the ordering where the
        // release lands first. The reason comes from the same place either way, so a
        // cancellation can never be recorded with the ceiling's wording.
        const reason = this.port.cancelRequested.get(runId) ?? WORK_REASONS.cancelled
        await this.port.settlement.emit('work.action.cancelled', { runId, stepId, actionId, attempt, reason })
        await this.port.settlement.writeStep(stepId, 'cancelled', { runId, reason })
        await this.port.settlement.finishCancelled(runId, reason)
        return false
      }

      if (outcome.kind === 'expired' || armed.fired() || this.port.now().getTime() >= deadlineAt) {
        return this.finishDeadline(runId, stepId, 'capability', { actionId, attempt, elapsedMs: elapsed })
      }

      if (outcome.kind === 'rejected') {
        // Aborted without a cancel or a deadline: Core is shutting down. That is a
        // cancellation, and it says so rather than calling it a failure.
        if (controller.signal.aborted) {
          const reason = 'the capability was aborted'
          await this.port.settlement.emit('work.action.cancelled', { runId, stepId, actionId, attempt, reason })
          await this.port.settlement.writeStep(stepId, 'cancelled', { runId, reason })
          await this.port.settlement.finishCancelled(runId, reason)
          return false
        }
        const reason = WORK_REASONS.capabilityFailed
        await this.port.settlement.emit('work.action.failed', { runId, stepId, actionId, attempt, reason, durationMs: elapsed })
        // Thrown diagnostics are deliberately not journalled: a capability may
        // wrap a provider, filesystem or process error whose message contains
        // secrets or local paths. The fixed reason is the durable fact.
        await this.port.settlement.writeStep(stepId, 'failed', { runId, reason })
        return true
      }

      const observation = normaliseObservation(outcome.value.observation, step.key)

      await this.port.settlement.emit('work.action.completed', { runId, stepId, actionId, attempt, durationMs: elapsed })

      const observationId = this.port.newId()
      this.port.observationSummaries.set(observationId, observation.summary)
      await this.port.settlement.emit('work.observation.recorded', {
        runId,
        stepId,
        actionId,
        observationId,
        kind: observation.kind,
        summaryLength: observation.summary.length,
        detailLength: measure(observation.data),
      })

      /**
       * The deadline still holds, and it is the *same* one.
       *
       * `maxDurationMs` bounds the whole active path of a Step — capability, then
       * observation, then verification — not the capability and then whatever is
       * left over. There is no fresh budget here: `deadlineAt` was computed once,
       * before the capability was called, and verification gets the remainder of
       * *that* window. Re-arming per phase would let a Step take the ceiling three
       * times over and turn a bounded Run into an unbounded one.
       *
       * Checked before requesting a verification that cannot now finish, so a
       * verification is not even asked for when the budget to ask is already gone.
       */
      if (armed.fired() || this.port.now().getTime() >= deadlineAt) {
        return this.finishDeadline(runId, stepId, 'verification')
      }

      const verificationId = this.port.newId()
      await this.port.settlement.emit('work.verification.requested', {
        runId,
        stepId,
        verificationId,
        verifier: verifier.name,
      })

      /**
       * Raced against the same deadline, for the same reason as the capability.
       *
       * A verifier is code, so it can be as slow or as stubborn as a capability,
       * and `await`-ing it unbounded would leave the ceiling bounding the first
       * half of a Step and not the second half — which is the hole this closes.
       * On the final Step that hole is the whole Run: a verifier returning `passed`
       * after the budget was gone would complete it.
       *
       * Both handlers are attached, so a verifier that eventually settles after the
       * deadline has its result discarded rather than becoming an unhandled
       * rejection or a resurrected Run.
       */
      const verification = await Promise.race([
        /**
         * The call is wrapped rather than merely promise-chained, because
         * `WorkVerifier.verify` is allowed to return an outcome *or* a promise of
         * one — so it may also throw synchronously, before any promise exists to
         * attach a rejection handler to. Chaining the result would let that throw
         * escape the `race` entirely and tear down the Run driver, which is a
         * verifier's own failure being escalated into an engine failure.
         */
        (async (): Promise<VerificationOutcome> => {
          try {
            return { kind: 'answered', verdict: await verifier.verify({
              runId,
              stepId,
              stepKey: step.key,
              attempt,
              input: live.input,
              observation,
            }) }
          } catch (error: unknown) {
            return { kind: 'rejected', error }
          }
        })(),
        armed.expired.then((): VerificationOutcome => ({ kind: 'expired' })),
        armed.cancelled.then((): VerificationOutcome => ({ kind: 'cancelled' })),
      ])

      // Cancellation first, on this path too, for the same reason as everywhere.
      if (this.port.cancelRequested.has(runId)) {
        const reason = this.port.cancelRequested.get(runId) ?? WORK_REASONS.cancelled
        await this.port.settlement.writeStep(stepId, 'cancelled', { runId, reason })
        await this.port.settlement.finishCancelled(runId, reason)
        return false
      }

      /**
       * A verdict that arrived after the deadline is not a verdict.
       *
       * The clock is re-checked as well as the race, because a verifier can win the
       * race microseconds before the timer fires — and because `now` is injected, so
       * it can be past the deadline while the timer has not been scheduled yet.
       *
       * Note what is *not* written: no `work.verification.completed` at all, and
       * certainly not a `passed` one. The verification is recorded as requested and
       * unanswered, which is what actually happened. Writing `failed` would be just
       * as much a fabrication — it would put a verdict in the audit trail that the
       * verifier never gave.
       */
      if (verification.kind === 'expired' || armed.fired() || this.port.now().getTime() >= deadlineAt) {
        return this.finishDeadline(runId, stepId, 'verification')
      }

      if (verification.kind === 'cancelled') {
        // Released by the owner rather than by the clock. The `cancelRequested`
        // branch above normally gets here first; this covers the reverse ordering.
        // No verdict is written, because none was ever given.
        const reason = this.port.cancelRequested.get(runId) ?? WORK_REASONS.cancelled
        await this.port.settlement.writeStep(stepId, 'cancelled', { runId, reason })
        await this.port.settlement.finishCancelled(runId, reason)
        return false
      }

      if (verification.kind === 'rejected') {
        // A verifier is trusted code, but its thrown diagnostic may still contain
        // provider text, local paths or secrets. Keep that diagnostic out of the
        // durable Work stream and record only the code-owned failure.
        await this.port.settlement.emit('work.verification.completed', {
          runId,
          stepId,
          verificationId,
          verdict: 'failed',
          reason: WORK_REASONS.verifierFailed,
        })
        await this.port.settlement.writeStep(stepId, 'failed', {
          runId,
          reason: WORK_REASONS.verifierFailed,
        })
        return true
      }

      const verdict = verification.verdict
      const durableReason =
        verdict.verdict === 'passed'
          ? WORK_REASONS.verificationPassed
          : WORK_REASONS.verificationFailed
      await this.port.settlement.emit('work.verification.completed', {
        runId,
        stepId,
        verificationId,
        verdict: verdict.verdict,
        reason: durableReason,
      })

      if (verdict.verdict === 'passed') {
        await this.port.settlement.writeStep(stepId, 'verified', { runId, attempt })
        return true
      }
      // Verifier reasons may be derived from the Step input or Observation. Those
      // values are intentionally non-durable, so the journal keeps only a fixed
      // conclusion instead of echoing the underlying content.
      await this.port.settlement.writeStep(stepId, 'failed', { runId, reason: durableReason })
      return true
    } finally {
      // Exactly once, on every path: success, failure, cancellation, the deadline,
      // or a throw from the verifier. A deadline timer that outlived its capability
      // would fire into a Run that had already settled.
      armed.clear()
      if (this.port.calling.get(runId) === armed) this.port.calling.delete(runId)
    }
  }

  /**
   * Arm this Run's duration ceiling for one capability call.
   *
   * Two things happen when it expires, in this order and both synchronously: the
   * reason is recorded, *then* the signal is aborted. Recording first means
   * anything that reacts to the abort — including the capability's own handler —
   * already finds why it was stopped, rather than having to infer it.
   */
  private armDeadline(
    runId: string,
    controller: AbortController,
    remainingMs: number,
  ): LiveCapabilityCall {
    let timer: ReturnType<typeof setTimeout> | undefined
    let fired = false
    let signalCancel!: () => void

    const expired = new Promise<'duration'>((resolve) => {
      timer = setTimeout(() => {
        fired = true
        this.port.deadlineHit.set(runId, this.port.now().getTime())
        controller.abort()
        resolve('duration')
      }, remainingMs)
      // A deadline is not a reason to keep a process alive. Without this an
      // application quitting inside a Run's window would be held open by a timer
      // whose only job is to stop work that is about to be abandoned anyway.
      ;(timer as { unref?: () => void }).unref?.()
    })

    /**
     * Resolved by `cancelRun`, so a capability or verifier that ignores its abort
     * cannot also swallow a cancellation. Never rejects, and never needs clearing:
     * an unresolved promise holds nothing.
     */
    const cancelled = new Promise<'cancelled'>((resolve) => {
      signalCancel = () => {
        resolve('cancelled')
      }
    })

    return {
      controller,
      expired,
      cancelled,
      signalCancel: () => {
        signalCancel()
      },
      fired: () => fired,
      clear: () => {
        if (timer === undefined) return
        clearTimeout(timer)
        timer = undefined
      },
    }
  }

  /**
   * Settle a Run whose duration ceiling expired mid-action.
   *
   * The Action settles as **failed**, not cancelled: the budget ran out, which is
   * not something anybody asked for, and writing `work.action.cancelled` here
   * would put a cancellation in the audit trail that never happened. The step
   * fails, every later step is skipped, and the Run fails with the ceiling as its
   * reason.
   *
   * `work.limits.exceeded` is written first so the ceiling is recorded even if a
   * later write is refused, and so a reader meets the cause before the effect.
   */
  private async finishDeadline(
    runId: string,
    stepId: string,
    phase: DeadlinePhase,
    action?: { actionId: string; attempt: number; elapsedMs: number },
  ): Promise<boolean> {
    const reason = limitReason('duration')
    await this.port.settlement.recordLimit(runId, 'duration')
    // Only a capability that overran has an action to settle. A verification that
    // overran comes after an action that completed, and that fact stays true.
    if (phase === 'capability' && action !== undefined) {
      await this.port.settlement.emit('work.action.failed', {
        runId,
        stepId,
        actionId: action.actionId,
        attempt: action.attempt,
        reason,
        durationMs: action.elapsedMs,
      })
    }
    return this.port.settlement.failStep(runId, stepId, reason)
  }

}

export function normaliseObservation(raw: WorkObservationContent | undefined, stepKey: string): WorkObservationContent {
  const kinds = ['result', 'exit', 'change', 'failure', 'input']
  const kind = raw && typeof raw.kind === 'string' && kinds.includes(raw.kind) ? (raw.kind as WorkObservationContent['kind']) : 'result'
  const summary = typeof raw?.summary === 'string' && raw.summary.trim().length > 0 ? raw.summary.trim().slice(0, WORK_LIMITS.maxSummaryChars) : `the capability returned no summary for step "${stepKey}"`
  const data = raw && typeof raw.data === 'object' && raw.data !== null && !Array.isArray(raw.data) ? raw.data : {}
  return { kind, summary, data }
}

function measure(data: Record<string, unknown>): number {
  try { return JSON.stringify(data)?.length ?? 0 } catch { return 0 }
}

function limitReason(limit: LimitName): string {
  switch (limit) {
    case 'steps': return WORK_REASONS.limitSteps
    case 'actions': return WORK_REASONS.limitActions
    case 'duration': return WORK_REASONS.limitDuration
    case 'attempts': return WORK_REASONS.limitAttempts
  }
}
