import { isExpired, remainingMs } from './deadlines'
import type {
  ContinuationState,
  RecoveryAction,
  RecoveryReport,
} from './types'
import type { LifeLoopState } from './state'

/**
 * Restart recovery.
 *
 * The rule this module exists to enforce is the uncomfortable one: **Freya does
 * not pick up where she left off.** A process that died mid-action has lost the
 * in-memory plan that action was part of, so replaying the journal proves only
 * that some action *started* — never that it finished. Treating a start as a
 * completion is how a system convinces its owner that work happened when it did
 * not, and that is a worse failure than losing the work.
 *
 * So every recovery decision here is one of three: reset to idle and re-evaluate
 * on a genuinely new wake, preserve a wait whose deadline has not passed, or stop
 * something that was genuinely interrupted and require the owner to start it
 * again. Nothing is resumed, ever, by this module.
 *
 * Pure. Same journal and same clock gives the same report, which is what makes
 * "deterministic recovery" testable rather than aspirational.
 */

export interface RecoveryInput {
  /** The state the fold derived from the journal. */
  readonly state: LifeLoopState
  /** ISO instant, injected. */
  readonly now: string
  /** Whether the replayed journal carries a live STOP ALL latch. */
  readonly stopAllActive: boolean
}

const RECOVERY_REASONS = {
  'stay-idle': 'Freya was not doing anything when the process ended.',
  'reset-to-idle': 'The loop had already finished, so it was closed out.',
  're-evaluate-on-next-wake':
    'Freya was interrupted mid-thought, so she will look again when something genuinely new wakes her.',
  'preserve-wait': 'What Freya was waiting for is still possible, so the wait stands.',
  'wait-deadline-expired':
    'What Freya was waiting for ran out of time while the process was gone, so the wait is over.',
  'interrupted-action-stopped':
    'A bounded action was interrupted by the process ending, so it is stopped and has to be started again.',
  'interrupted-verification-stopped':
    'A verification was interrupted by the process ending, so it is stopped and has to be started again.',
  'stop-all-latched':
    'Freya is stopped. Nothing resumes until the owner clears it.',
} as const

/**
 * Where each interrupted state recovers to.
 *
 * The asymmetry is the whole design: `WAIT` survives because a condition in the
 * world can still come true and the deadline is absolute, while `ACTING` and
 * `VERIFYING` do not survive because the thing that was in flight is gone.
 */
const RECOVERY_TARGETS: Readonly<
  Record<ContinuationState, { readonly to: ContinuationState; readonly code: RecoveryAction['code'] }>
> = Object.freeze({
  IDLE: { to: 'IDLE', code: 'stay-idle' },
  WAKING: { to: 'IDLE', code: 're-evaluate-on-next-wake' },
  WAIT: { to: 'WAIT', code: 'preserve-wait' },
  ALLOW: { to: 'IDLE', code: 're-evaluate-on-next-wake' },
  ACTING: { to: 'STOP', code: 'interrupted-action-stopped' },
  VERIFYING: { to: 'STOP', code: 'interrupted-verification-stopped' },
  CONTINUE: { to: 'IDLE', code: 're-evaluate-on-next-wake' },
  DENY: { to: 'IDLE', code: 'reset-to-idle' },
  STOP: { to: 'IDLE', code: 'reset-to-idle' },
})

/**
 * Reconcile an interrupted loop.
 *
 * Three cases deserve their explanation, because they are the ones a plausible
 * implementation would get wrong:
 *
 *   - **A wait whose deadline has already passed** becomes `DENY`, not `WAIT`.
 *     The alternative is a wait that no future heartbeat can ever satisfy and no
 *     owner can see, which is a dead loop that looks alive.
 *
 *   - **A wait whose deadline has not passed** keeps its *original* absolute
 *     deadline. It is not re-derived from `now`, because a relative wait is
 *     extended by every restart and thirty days becomes thirty days per crash.
 *
 *   - **STOP ALL outranks everything**, including a stop that was itself the
 *     thing being recovered. A restart does not clear the latch, so a stopped
 *     Freya stays stopped and the report says so.
 */
export function recoverLifeLoop(input: RecoveryInput): RecoveryReport {
  const { state, now } = input
  const interrupted: ContinuationState = state.state

  // The latch first. Nothing below it matters while it is held.
  if (input.stopAllActive) {
    return {
      interruptedState: interrupted,
      recoveredState: 'STOP',
      actions: [
        {
          code: 'stop-all-latched',
          from: interrupted,
          to: 'STOP',
          reason: RECOVERY_REASONS['stop-all-latched'],
        },
      ],
      resumption: 'none',
      residualDeadline: null,
      requiresOwnerAction: true,
      stopAllActive: true,
    }
  }

  const target = RECOVERY_TARGETS[interrupted]

  // The wait case is the only one that consults the clock.
  if (interrupted === 'WAIT') {
    const deadline = state.deadline
    // A wait with no deadline is a wait that can never end. Treated as expired
    // rather than preserved, because "unbounded wait" is precisely the failure
    // the wait deadline exists to prevent.
    const expired = deadline === null || isExpired(deadline, now)
    const code = expired ? 'wait-deadline-expired' : 'preserve-wait'
    return {
      interruptedState: interrupted,
      recoveredState: expired ? 'DENY' : 'WAIT',
      actions: [
        {
          code,
          from: interrupted,
          to: expired ? 'DENY' : 'WAIT',
          reason: RECOVERY_REASONS[code],
        },
      ],
      resumption: expired ? 'none' : 'wait',
      residualDeadline: expired ? null : deadline,
      // An expired wait is a loss, and a loss is the owner's to hear about.
      requiresOwnerAction: expired,
      stopAllActive: false,
    }
  }

  return {
    interruptedState: interrupted,
    recoveredState: target.to,
    actions: [
      {
        code: target.code,
        from: interrupted,
        to: target.to,
        reason: RECOVERY_REASONS[target.code],
      },
    ],
    // 'none' unless a wait survives. There is deliberately no 'resume' value.
    resumption: 'none',
    residualDeadline: null,
    // An interrupted action or verification is work the owner thought was under
    // way, so somebody has to be told.
    requiresOwnerAction: target.to === 'STOP',
    stopAllActive: false,
  }
}

/**
 * Whether a preserved wait is still worth keeping, in whole milliseconds.
 *
 * Exposed so a caller can render "Freya is still waiting, N days left" without
 * re-deriving the arithmetic — and, more importantly, without a way to reach a
 * wait that has quietly run out.
 */
export function residualWaitMs(report: RecoveryReport, now: string): number {
  if (report.residualDeadline === null) return 0
  return remainingMs(report.residualDeadline, now)
}

/**
 * A one-line, safe-to-journal summary of a recovery.
 *
 * Assembled from closed codes only. A recovery report can be rendered into a log
 * and an owner's surface, so nothing that reaches it may be an arbitrary string.
 */
export function describeRecovery(report: RecoveryReport): string {
  const parts = report.actions.map((action) => `${action.code}: ${action.reason}`)
  const suffix = report.requiresOwnerAction ? ' The owner has to decide what happens next.' : ''
  return `${parts.join(' ')}${suffix}`
}