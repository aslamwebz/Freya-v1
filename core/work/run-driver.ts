import type { CoreEventType } from '../events/envelope'
import type { WorkState } from './state'
import { isTerminalRunStatus, WORK_LIMITS, WORK_REASONS, type RunStatus } from './types'

export interface WorkRunDriverPort {
  state(): WorkState
  cancelRequested: ReadonlyMap<string, string>
  advancing: Map<string, Promise<void>>
  stopAll?: () => boolean
  stopAllReason?: () => string
  stepExecutor: { execute(runId: string, stepId: string): Promise<boolean> }
  settlement: {
    finishCancelled(runId: string, reason: string): Promise<void>
    finishRun(runId: string): Promise<void>
    moveRun(runId: string, to: RunStatus, event: CoreEventType, payload: Record<string, unknown>): Promise<boolean>
    writeReadyStep(stepId: string, payload: Record<string, unknown>): Promise<boolean>
    skipRemaining(runId: string, reason: string): Promise<void>
  }
}

export class WorkRunDriver {
  constructor(private readonly port: WorkRunDriverPort) {}
  async advance(runId: string): Promise<void> {
    const existing = this.port.advancing.get(runId)
    if (existing) {
      await existing
      return
    }
    const run = this.drive(runId)
    this.port.advancing.set(runId, run)
    try {
      await run
    } finally {
      if (this.port.advancing.get(runId) === run) this.port.advancing.delete(runId)
    }
  }

  private async drive(runId: string): Promise<void> {
    for (;;) {
      const run = this.port.state().runs.get(runId)
      if (!run || isTerminalRunStatus(run.status)) return
      if (run.status === 'paused' || run.status === 'awaiting_approval' || run.status === 'waiting') return

      if (this.port.cancelRequested.has(runId)) {
        await this.port.settlement.finishCancelled(runId, this.port.cancelRequested.get(runId) ?? WORK_REASONS.cancelled)
        return
      }
      if (this.port.stopAll?.() === true) {
        await this.port.settlement.finishCancelled(
          runId,
          this.port.stopAllReason?.() ?? 'Freya is stopped, so this run was stopped with it',
        )
        return
      }
      if (run.status === 'queued') {
        await this.port.settlement.moveRun(runId, 'running', 'work.run.started', { runId })
        continue
      }

      const selection = await this.selectStep(runId)
      if (selection === null) return
      if (selection === 'finish') {
        await this.port.settlement.finishRun(runId)
        return
      }
      if (!(await this.port.stepExecutor.execute(runId, selection))) return
    }
  }

  /**
   * Choose the next Step, or decide the Run is over.
   *
   * Strictly in planned order, which is what `deterministic` means and the whole
   * reason a dependency graph is not needed yet. Two behaviours are folded in
   * because they are bookkeeping rather than scheduling:
   *
   * - a `pending` step whose predecessors have all settled becomes `ready`;
   * - a `failed` step with attempts left returns to `ready`, and one without them
   *   means the Run cannot continue — so every later step is `skipped` and the Run
   *   is finished, which records it as failed with the reason already written.
   *
   * Returns `null` when another loop owns this Run.
   */
  private async selectStep(runId: string): Promise<string | 'finish' | null> {
    for (const stepId of this.port.state().runSteps.get(runId) ?? []) {
      const step = this.port.state().steps.get(stepId)
      if (!step) continue

      if (step.status === 'verified' || step.status === 'cancelled' || step.status === 'skipped') continue

      if (step.status === 'pending') {
        await this.port.settlement.writeReadyStep(stepId, { runId, stepKey: step.key })
        return stepId
      }

      if (step.status === 'failed') {
        const ceiling = this.port.state().runs.get(runId)?.limits.maxAttemptsPerStep ?? WORK_LIMITS.maxAttemptsPerStep
        if (step.attempts < ceiling && !this.port.cancelRequested.has(runId)) {
          await this.port.settlement.writeReadyStep(stepId, { runId, stepKey: step.key })
          return stepId
        }
        await this.port.settlement.skipRemaining(runId, `step "${step.key}" failed and will not be retried`)
        return 'finish'
      }

      if (step.status === 'ready') return stepId
      // running / waiting / awaiting_approval with nobody driving: another loop
      // owns it. Standing aside is the honest answer.
      return null
    }
    return 'finish'
  }

}
