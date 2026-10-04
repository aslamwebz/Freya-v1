import type { EconomicStage } from './types'
import type { EconomicFoldAnomaly, EconomicInterruption, EconomicState } from './state'

/**
 * Restart recovery.
 *
 * The rule is one sentence and everything here is that sentence: **a process that died
 * mid-stage cannot be resumed**, so nothing is resumed. What happens instead is that
 * every experiment the journal left in a live stage is *recorded as interrupted*,
 * durably, and left exactly where it was.
 *
 * Three things follow from taking that seriously, and they are the properties the
 * red-team suite checks:
 *
 *   1. **Nothing is fabricated.** Recovery adds no experiment, no evidence and no
 *      metric. It reports what the journal already proves and nothing else, so a
 *      projection after a restart is never nicer than the journal deserves.
 *   2. **Nothing continues silently.** There is no resume-on-boot, no auto-advance and no
 *      timer here. `resumption` is `awaiting-wake`, always: the next move needs a wake
 *      that names the experiment, which is a visible event rather than a behaviour.
 *   3. **The stop outranks all of it.** If STOP ALL was latched when the process ended,
 *      that is the report — not a list of experiments, and not a "and you can resume".
 *      A restart is not the owner clearing a latch.
 */

/** The closed things recovery can do. */
export const ECONOMIC_RECOVERY_ACTIONS = [
  'nothing-to-reconcile',
  'interrupted-experiments-recorded',
  'stop-all-latched',
  'experiments-already-terminal',
] as const

export type EconomicRecoveryActionCode = (typeof ECONOMIC_RECOVERY_ACTIONS)[number]

export interface EconomicRecoveryAction {
  readonly code: EconomicRecoveryActionCode
  readonly experimentId: string | null
  readonly stage: EconomicStage | null
  readonly reason: string
}

export interface EconomicRecoveryReport {
  /** Whether anything at all had to be recorded. False is a legitimate, common answer. */
  readonly reconciled: boolean
  /** Experiments found mid-stage. Visible, and never moved. */
  readonly interrupted: readonly EconomicInterruption[]
  readonly actions: readonly EconomicRecoveryAction[]
  /** Always `awaiting-wake`. There is no path here that resumes anything. */
  readonly resumption: 'awaiting-wake'
  /** True when only a person can move things on: a latch, or a refused continuation. */
  readonly requiresOwnerAction: boolean
  readonly stopAllActive: boolean
  readonly anomalies: readonly EconomicFoldAnomaly[]
  readonly recoveredAt: string
}

export interface EconomicRecoveryInput {
  readonly state: EconomicState
  readonly now: string
  readonly stopAllActive: boolean
  readonly anomalies?: readonly EconomicFoldAnomaly[]
}

const ACTION_REASONS: Readonly<Record<EconomicRecoveryActionCode, string>> = Object.freeze({
  'nothing-to-reconcile': 'Every experiment was where it should have been, so nothing had to be reconciled.',
  'interrupted-experiments-recorded':
    'An experiment was in the middle of a bounded step when the process ended, and it has been recorded as interrupted rather than resumed.',
  'stop-all-latched': 'Freya was stopped when the process ended, and a restart is not the owner clearing that.',
  'experiments-already-terminal':
    'Every experiment was already finished, and finishing is the one thing a restart may safely agree with.',
})

/**
 * Decide what recovery has to do.
 *
 * Pure. It reads a folded state and two facts and returns a plan; the runtime is what
 * journals the plan. Keeping the decision separate from the write is what lets a test
 * assert "recovery did not change any state" by comparing the state either side of it.
 */
export function planEconomicRecovery(input: EconomicRecoveryInput): EconomicRecoveryReport {
  const { state, now, stopAllActive } = input
  const anomalies = input.anomalies ?? []

  // The latch first, and unconditionally. A stopped subsystem is not a subsystem with
  // experiments in it; reporting the experiments would let a reader conclude that work
  // is in progress when in fact nothing is.
  if (stopAllActive) {
    return {
      reconciled: true,
      interrupted: [],
      actions: [
        {
          code: 'stop-all-latched',
          experimentId: null,
          stage: null,
          reason: ACTION_REASONS['stop-all-latched'],
        },
      ],
      resumption: 'awaiting-wake',
      requiresOwnerAction: true,
      stopAllActive: true,
      anomalies,
      recoveredAt: now,
    }
  }

  const interrupted: EconomicInterruption[] = state.interrupted.map((entry) => entry)

  // Anything the journal proves is still live, even if no reconciliation entry was
  // written for it, is reported. Belt and braces on purpose: the fold's own record is
  // the primary source, and a journal truncated between two entries would otherwise
  // leave a half-finished experiment looking untouched.
  for (const experiment of state.experiments) {
    if (!isLiveStage(experiment.stage)) continue
    if (interrupted.some((entry) => entry.experimentId === experiment.experimentId)) continue
    interrupted.push({
      experimentId: experiment.experimentId,
      stage: experiment.stage,
      at: experiment.updatedAt,
      code: 'restart-recovery',
    })
  }

  interrupted.sort((left, right) =>
    left.experimentId < right.experimentId ? -1 : left.experimentId > right.experimentId ? 1 : 0,
  )

  if (interrupted.length === 0) {
    return {
      reconciled: false,
      interrupted: [],
      actions: [
        {
          code: state.experiments.length === 0 ? 'nothing-to-reconcile' : 'experiments-already-terminal',
          experimentId: null,
          stage: null,
          reason:
            state.experiments.length === 0
              ? ACTION_REASONS['nothing-to-reconcile']
              : ACTION_REASONS['experiments-already-terminal'],
        },
      ],
      resumption: 'awaiting-wake',
      requiresOwnerAction: false,
      stopAllActive: false,
      anomalies,
      recoveredAt: now,
    }
  }

  return {
    reconciled: true,
    interrupted,
    actions: interrupted.map((entry) => ({
      code: 'interrupted-experiments-recorded' as const,
      experimentId: entry.experimentId,
      stage: entry.stage,
      reason: ACTION_REASONS['interrupted-experiments-recorded'],
    })),
    resumption: 'awaiting-wake',
    // True, and this is the interesting one. The subsystem has decided *not* to continue
    // these on its own, so somebody has to say whether they should — and an owner who
    // does not notice is exactly the failure this phase exists to prevent.
    requiresOwnerAction: true,
    stopAllActive: false,
    anomalies,
    recoveredAt: now,
  }
}

/** Is this a stage that means work was in progress? */
function isLiveStage(stage: EconomicStage): boolean {
  return stage !== 'IDLE' && stage !== 'COMPLETE' && stage !== 'FAILED'
}

/** The one-line summary of a recovery, safe to journal or to display. */
export function describeEconomicRecovery(report: EconomicRecoveryReport): string | null {
  if (!report.reconciled) return null
  if (report.stopAllActive) return ACTION_REASONS['stop-all-latched']
  const count = report.interrupted.length
  if (count === 0) return null
  const plural = count === 1 ? 'experiment was' : 'experiments were'
  return `${count} economic ${plural} interrupted by the restart and recorded rather than resumed; nothing continues without an explicit wake.`
}