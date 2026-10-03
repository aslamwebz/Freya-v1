import {
  LIFE_LOOP_LIMITS,
  type DecideOutcome,
  type FocusState,
  type LifeLoopLimits,
  type PreCognitionDenialCode,
  type PreCognitionOutcome,
  type WakeEvent,
} from './types'
import { resolveEscalation } from './decide'
import { justifiesCognition } from './wake'

/**
 * The Pre-Cognition Filter.
 *
 * The deterministic gate in front of every model call the life loop could ever
 * want. It is a pure function of the wake, the injected clock and facts that are
 * *already* authorized — no model, no network, no journal write, no randomness.
 * Same inputs, same answer, forever, which is what lets the guarantee "an idle
 * Freya spends nothing" be a function rather than a hope.
 *
 * The order below is the contract. Each check is cheap, each check refuses
 * something a later check would otherwise permit, and the first refusal is the
 * one reported — so the journal says the *actual* reason rather than the last
 * one to be reached.
 */

/** What the filter is allowed to know about the loop's own progress. */
export interface LifeLoopProgress {
  readonly state: string
  readonly iterationCount: number
  readonly actionCount: number
  readonly verificationCount: number
  readonly cognitionRequestCount: number
  /** ISO instant the current iteration began, or null when not in one. */
  readonly iterationStartedAt: string | null
  /** Attempts already spent on the unit of work in hand. */
  readonly attemptCount: number
  /** Schedules the heartbeat is already holding open. */
  readonly pendingScheduleCount: number
}

/** The already-authorized security and authority facts. */
export interface PreCognitionAuthority {
  readonly stopAllActive: boolean
  readonly journalTrustworthy: boolean
  /** The loop is enabled at all. A disabled loop denies before anything else. */
  readonly enabled: boolean
  /** Whether an active grant could cover a background call. */
  readonly grantAvailable: boolean
  /** Calls still available under the active grant. Zero means exhausted. */
  readonly budgetRemainingCalls: number
  /** ISO instant a cooldown lifts, or null when none is active. */
  readonly cooldownUntil: string | null
  /** What the owner is focused on, as Attention already knows it. */
  readonly focus: FocusState
  /** What the loop decided this wake was worth, and how loudly it may say so. */
  readonly requestedOutcome: DecideOutcome
}

export interface PreCognitionInput {
  readonly wake: WakeEvent
  /** ISO instant, injected. */
  readonly now: string
  readonly progress: LifeLoopProgress
  readonly authority: PreCognitionAuthority
  readonly limits?: LifeLoopLimits
}

const DENIAL_REASONS: Readonly<Record<PreCognitionDenialCode, string>> = Object.freeze({
  'journal-not-trustworthy':
    "Freya's record of what happened could not be believed, so she will not think on top of it.",
  'stop-all-active': 'Freya is stopped. Nothing is thought while she is stopped.',
  'loop-disabled': 'The life loop is switched off, so nothing is woken.',
  'no-active-wake': 'There is no live wake, so there is nothing to think about.',
  'budget-exhausted': 'There is no cognition left in the budget for this.',
  'grant-unavailable': 'Nothing has authorized Freya to spend thinking on this.',
  'focus-blocks-escalation':
    'The owner is in the middle of something, so this does not get to interrupt them.',
  'cognition-not-justified':
    'That woke Freya, but it is not on its own a reason for her to think.',
  'limit-iterations': 'Freya has already done as much in this wake as she is allowed to.',
  'limit-actions': 'Freya has already acted as much in this wake as she is allowed to.',
  'limit-verifications':
    'Freya has already checked as much in this wake as she is allowed to.',
  'limit-attempts': 'That has been tried as many times as it is allowed to be tried.',
  'limit-schedules': 'There are already as many schedules open as Freya will hold.',
  'limit-duration': 'This pass of the loop has taken as long as it is allowed to take.',
})

export function preCognitionDenialReason(code: PreCognitionDenialCode): string {
  return DENIAL_REASONS[code]
}

function deny(code: PreCognitionDenialCode): PreCognitionOutcome {
  return { outcome: 'deny', code, reason: preCognitionDenialReason(code) }
}

/**
 * Evaluate whether cognition is justified, before any provider is contacted.
 *
 * Returns `allow` only when every one of the following is true:
 *
 *   - the journal can be believed and STOP ALL is clear;
 *   - the loop is enabled and there is a live wake — so an idle Freya, who has
 *     no wake, is refused here and nowhere else needs to know it;
 *   - budget and grant both have room;
 *   - no cooldown is holding the wake back;
 *   - the owner is not mid-task, if what was decided would have interrupted them;
 *   - the wake's *kind* is one that justifies inference on its own;
 *   - and this iteration is still inside every ceiling.
 *
 * The last of those is the anti-runaway clause. A wake that justifies cognition
 * is allowed exactly this many times, and then it is refused by count rather
 * than by judgement — because "should she think again?" is a question a loop
 * must not keep asking about itself.
 */
export function evaluatePreCognition(input: PreCognitionInput): PreCognitionOutcome {
  const limits = input.limits ?? LIFE_LOOP_LIMITS

  // 1. Journal integrity, above everything. A log with a hole in it may have lost
  //    the STOP ALL that would have refused this, so it is not trusted to be the
  //    whole latch.
  if (!input.authority.journalTrustworthy) return deny('journal-not-trustworthy')

  // 2. STOP ALL, above everything below it.
  if (input.authority.stopAllActive) return deny('stop-all-active')

  // 3. The loop being switched off is not a judgement call.
  if (!input.authority.enabled) return deny('loop-disabled')

  // 4. The idle case, stated explicitly rather than implied. There is no
  //    `IDLE -> allow` path anywhere in this module, which is the property the
  //    zero-idle-inference suite asserts.
  if (input.progress.state !== 'WAKING') return deny('no-active-wake')

  // 5. Budget before grant, because an exhausted budget is the more specific
  //    answer and no grant would have helped.
  if (input.authority.budgetRemainingCalls <= 0) return deny('budget-exhausted')
  if (!input.authority.grantAvailable) return deny('grant-unavailable')

  // 6. Cooldown waits rather than denies, and carries a deadline so the wait is
  //    bounded and a reader can see when it lifts.
  if (input.authority.cooldownUntil !== null) {
    const liftsAt = Date.parse(input.authority.cooldownUntil)
    if (!Number.isFinite(liftsAt) || liftsAt > Date.parse(input.now)) {
      return {
        outcome: 'wait',
        code: 'cooldown-active',
        reason: 'Freya is holding off for a moment after the last thing she thought about.',
        deadline: input.authority.cooldownUntil,
      }
    }
  }

  // 7. Focus. The owner being mid-task outranks the loop's wish to interrupt
  //    them, and only that wish: a cue or a word is still worth having, so this
  //    refuses `interrupt` alone and says why. `resolveEscalation` applies the
  //    same rule at the point the outcome is used; this check exists so the
  //    refusal is *journaled* rather than inferred after the fact.
  const escalation = resolveEscalation(
    input.authority.requestedOutcome,
    input.authority.focus,
    input.authority.stopAllActive,
  )
  if (escalation.suppressed && escalation.code === 'focus-suppressed-interrupt') {
    return deny('focus-blocks-escalation')
  }

  // 8. The heart of it. A wake is an event; only some events are worth a model
  //    call. `periodic-check`, `system-health`, `mission-activated` and
  //    `run-started` are woken and then deterministically refused here.
  if (!justifiesCognition(input.wake.kind)) return deny('cognition-not-justified')

  // 9. Ceilings. Counted before the question of judgement, so that even a wake
  //    that always justifies inference can only do so a bounded number of times
  //    per wake.
  const { progress } = input
  if (progress.iterationCount >= limits.maxLoopIterations) return deny('limit-iterations')
  if (progress.actionCount >= limits.maxActionsPerIteration) return deny('limit-actions')
  if (progress.verificationCount >= limits.maxVerificationsPerIteration) {
    return deny('limit-verifications')
  }
  if (progress.cognitionRequestCount >= limits.maxCognitionRequestsPerWake) {
    return deny('limit-iterations')
  }
  if (progress.attemptCount >= limits.maxAttemptsPerUnit) return deny('limit-attempts')
  if (input.wake.source === 'scheduled-heartbeat') {
    if (progress.pendingScheduleCount > limits.maxPendingSchedules) {
      return deny('limit-schedules')
    }
  }
  if (progress.iterationStartedAt !== null) {
    const started = Date.parse(progress.iterationStartedAt)
    const now = Date.parse(input.now)
    if (Number.isFinite(started) && now - started > limits.maxLoopIterationMs) {
      return deny('limit-duration')
    }
  }

  return {
    outcome: 'allow',
    code: 'cognition-justified',
    reason: 'This woke Freya, and it is the kind of event worth thinking about.',
  }
}