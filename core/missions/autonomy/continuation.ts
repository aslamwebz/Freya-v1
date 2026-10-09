import type { MissionReason, MissionRecord } from '../types'
import {
  isMissionWakeSource,
  type MissionDecision,
  type MissionStepRecord,
  type MissionWakeKind,
  type MissionWakeSource,
} from './types'

/**
 * THE CONTINUATION DECIDER.
 *
 * After every step, Freya must decide one of eight things. This file is that decision,
 * as a pure function of durable facts and a clock — no model call, no network, no
 * I/O. That purity is not a simplification: it is what makes "no hidden continuous
 * inference" a *structural* property rather than a promise, because there is no code
 * path here in which reasoning could continue without something calling it.
 *
 * ## One decision per wake, and a wake per decision
 *
 * Nothing here runs on a timer. `decide` is called once, with a reason it was called —
 * a manual tick, an event, a clock arriving, or reconciliation at startup — and it
 * returns exactly one decision. A caller that wants to keep deciding must keep calling,
 * which means each call is a visible event with a journalled reason.
 *
 * ## The decision order, and why it is fixed
 *
 * ```
 * STOP ALL → terminal → awaiting owner → deadline → verification
 *          → approval → budget → blocker → failure → outcome
 * ```
 *
 * Every branch is a *refusal to proceed* before any branch that would proceed. A
 * Mission that is both out of budget and needs an approval is reported as needing the
 * approval, because that is the action a person can take; "out of budget" would be
 * reported instead only when the approval was already resolved. Getting this order
 * backwards produces a Mission that blocks forever on a budget it could have stopped
 * spending by being told no.
 *
 * ## Why `complete` is a request and not an outcome
 *
 * `complete` means "ask the verifier". It does not mean done. The verifier is the only
 * thing that can move a Mission to `completed`, and it is reached through the engine's
 * existing `requestCompletion` — so a decision here can propose completion but cannot
 * perform it. That separation is what stops the decider from being the authority.
 */

/** Why the decider was called. Recorded, so "why did this happen now" is answerable. */
export type DecisionTrigger =
  /** The owner or a window asked. */
  | 'manual'
  /** A named event arrived. */
  | 'event'
  /** The clock reached a scheduled wake. */
  | 'time'
  /** Startup reconciliation. */
  | 'recovery'
  /** A step or evidence item landed. */
  | 'progress'

export interface DecisionInput {
  readonly mission: MissionRecord
  readonly now: Date
  readonly trigger: DecisionTrigger
  /** What the decider is allowed to observe. STOP ALL, budgets, and the clock. */
  readonly stopped: boolean
  /** Remaining budget, as the runtime measured it. */
  readonly remaining: {
    readonly actions: number
    readonly retries: number
    readonly delegations: number
    readonly planRevisions: number
  }
  /**
   * How many delegations are open right now.
   *
   * Read rather than derived from the steps, because the runtime knows about delegations
   * a fold cannot see (one made, one not yet reflected in a step event).
   */
  readonly openDelegations: number
  /**
   * Whether this Mission is the only live one.
   *
   * Read live at the moment of the decision. Two live Missions are a reason to be
   * careful, not a reason to refuse: the concurrency ceiling exists to bound the swarm,
   * and this is where it is consulted.
   */
  readonly siblingMissions: number
}

export interface DecisionResult {
  readonly decision: MissionDecision
  readonly reason: MissionReason
  /** Which step the decision is about, when it is about one. */
  readonly stepId: string | null
  /**
   * The instant at which this decision expires.
   *
   * Required when `decision` is `wait` and forbidden otherwise. `assertWakeBounded`
   * below is what enforces it, so a caller cannot construct an open-ended wait by
   * hand — the decider is not the only thing that has to be careful.
   */
  readonly nextWakeAt: string | null
}

/**
 * How long a Mission waits before it re-decides, when it is waiting on a clock.
 *
 * A real bound, derived from the Mission's own deadline rather than being a constant:
 * the wake is "no later than the deadline", because at the deadline the Mission is
 * settled regardless and a later wake would be a wake for a Mission that no longer
 * exists.
 */
export function defaultWaitMs(mission: MissionRecord, now: Date): number {
  const remaining = Date.parse(mission.deadlineAt) - now.getTime()
  // At or past the deadline there is nothing left to wait for. Returning 0 makes the
  // caller decide immediately rather than scheduling a wake in the past, which would be
  // a wake that fires instantly forever.
  return remaining > 0 ? Math.min(remaining, 60_000) : 0
}

/**
 * Decide what to do next.
 *
 * Pure. `now` is a parameter, so every branch is reachable in a test by choosing the
 * instant rather than by waiting for it.
 *
 * The nine steps below are in a fixed order and each one is a complete answer. There is
 * no fallthrough: a function that decided "probably wait, unless…" would need a
 * `probably`, and this one does not get to have opinions.
 */
export function decide(input: DecisionInput): DecisionResult {
  const { mission, now, remaining } = input
  // `trigger` is deliberately *not* read by any branch below.
  //
  // It is a parameter because every decision needs to be attributable to what caused it,
  // and because `wakeKindFor` and `wakeSourceFor` take it. Reading it in `decide` itself
  // would mean one wake could produce different decisions depending on which event
  // happened to arrive — so the same facts would be interpreted differently depending on
  // timing, which is the opposite of deterministic. Facts decide; the trigger only
  // explains.
  const steps = mission.activePlan?.steps ?? []

  // 1. STOP ALL. The panic button outranks everything, including a Mission that would
  //    otherwise complete. "It finished anyway" is the worst possible answer to a panic.
  if (input.stopped || mission.status === 'stopped') {
    return { decision: 'wait', reason: 'stopped', stepId: null, nextWakeAt: later(now, defaultWaitMs(mission, now)) }
  }

  // 2. Terminal. A settled Mission has nothing to decide, and asking is not harmless:
  //    it would write a decision onto a journal that says the Mission ended.
  if (mission.status === 'completed' || mission.status === 'failed' || mission.status === 'cancelled') {
    return { decision: 'fail', reason: 'shutdown', stepId: null, nextWakeAt: null }
  }

  // 3. Awaits the owner. An ambiguous correction means Freya does not know what the
  //    goal is, and continuing anyway would be executing a guess. Only an owner can
  //    clear this, so it outranks every "can I make progress" question below.
  if (mission.awaitingOwner) {
    return { decision: 'ask_owner', reason: 'intent_ambiguous', stepId: null, nextWakeAt: null }
  }

  // 4. Deadline. A wall, discovered rather than watched.
  if (Date.parse(now.toISOString()) >= Date.parse(mission.deadlineAt)) {
    return { decision: 'fail', reason: 'deadline_expired', stepId: null, nextWakeAt: null }
  }

// 5. A Mission waiting on a Work approval. Parked, with a durable wake so the gate's own
  //    TTL can still elapse even if nothing else ever arrives.
  //
  //    This reads the Mission's *pointer*, not a gate of its own. It is the same question
  //    as before with one fewer moving part: there is no `status === 'pending'` to scan
  //    for, because there is no Mission-side lifecycle to be in. If `outcome` is already
  //    set, Work has told us how it went and the Mission is no longer waiting — the
  //    blocker it raised is handled below, and the next decision reads the step's truth.
  const pendingApproval = mission.approval
  if (pendingApproval !== null && pendingApproval.outcome === null) {
    return {
      decision: 'request_approval',
      reason: 'approval_pending',
      stepId: pendingApproval.stepId,
      // Bounded by the deadline. Work's own TTL expires the gate; this wake is how the Mission
      // notices that it did, rather than sitting on a pointer forever because nobody
      // happened to look.
      nextWakeAt: later(now, defaultWaitMs(mission, now)),
    }
  }

  // 6. Budget, before any progress question. A Mission with no actions left cannot make
  //    progress, and saying "out of budget" is more useful than naming the step it
  //    cannot run.
  if (remaining.actions <= 0 && !(steps.length > 0 && steps.every(step => step.status === 'verified') && mission.blockers.length === 0)) {
    return { decision: 'wait', reason: 'budget_exhausted', stepId: null, nextWakeAt: later(now, defaultWaitMs(mission, now)) }
  }
  if (remaining.planRevisions <= 0 && steps.length === 0) {
    // Replanning is unavailable, so a plan that would have been replaced cannot be.
    // Reported as waiting rather than failing: the Mission may still complete on the
    // plan it has.
    return { decision: 'wait', reason: 'replan_ceiling', stepId: null, nextWakeAt: later(now, defaultWaitMs(mission, now)) }
  }

  // 7. A failed step. **Before the generic blocker branch**, and that order is the point.
  //
  //    A failed step raises a `step_failed` blocker, so checking blockers first would
  //    report "waiting" for a Mission that has a perfectly good retry available — and the
  //    retry ceiling would then be reached by parking rather than by trying, which is the
  //    opposite of what a bounded retry is for.
  //
  //    A failure is also *not* a Mission failure. One attempt failing says nothing about
  //    the outcome, which is why this branch retries rather than concluding.
  const failed = steps.find((step) => step.status === 'failed')
  if (failed !== undefined) {
    if (failed.attempts < mission.budget.maxRetries && remaining.retries > 0) {
      return { decision: 'retry', reason: 'retrying', stepId: failed.stepId, nextWakeAt: null }
    }
    // Out of retries. Parked, not failed: a person still decides what happens next.
    return { decision: 'wait', reason: 'retry_ceiling', stepId: failed.stepId, nextWakeAt: later(now, defaultWaitMs(mission, now)) }
  }

  // 8. A blocker. If it is one a person can clear, ask; if it is one Freya can clear by
  //    replanning, replan; otherwise park.
  const blocker = mission.blockers[0]
  if (blocker !== undefined) {
    if (blocker.code === 'intent_ambiguous') {
      return { decision: 'ask_owner', reason: 'intent_ambiguous', stepId: blocker.stepId, nextWakeAt: null }
    }
    if (isReplannable(blocker.code) && remaining.planRevisions > 0) {
      return { decision: 'replan', reason: blocker.code, stepId: blocker.stepId, nextWakeAt: null }
    }
    return { decision: 'wait', reason: blockerReason(blocker.code), stepId: blocker.stepId, nextWakeAt: later(now, defaultWaitMs(mission, now)) }
  }

  // 8b. A step the planner could not resolve.
  //
  //     Checked here rather than in the blocker branch because a planner-blocked step has
  //     no blocker record *yet* — the runtime raises one the first time it sees the step.
  //     Without this branch, such a Mission would find no runnable step, fall through to
  //     "nothing to do", and report `waiting_event` — which is a lie about why it stopped.
  const stuck = steps.find((step) => step.status === 'blocked')
  if (stuck !== undefined) {
    return {
      decision: 'wait',
      reason: blockerReason(stuck.reason === 'unknown_capability' ? 'unknown_capability' : stuck.reason ?? 'step_failed'),
      stepId: stuck.stepId,
      nextWakeAt: later(now, defaultWaitMs(mission, now)),
    }
  }

  // 9. An unknown external effect. A step interrupted mid-action may or may not have
  //    taken effect, and re-running it could duplicate something real. This is the one
  //    place where "try again" is the *wrong* answer, so it parks and asks.
  const interrupted = steps.find((step) => step.status === 'blocked' && step.reason === 'interrupted')
  if (interrupted !== undefined) {
    return { decision: 'wait', reason: 'interrupted', stepId: interrupted.stepId, nextWakeAt: later(now, defaultWaitMs(mission, now)) }
  }

  // 10. **No plan at all → plan one.** Before any progress question, because without a plan
  //     there is nothing to make progress *on*, and a Mission that never plans can only
  //     ever reach the last line of this function and wait for an event that will never come.
  //
  //     This is the GOAL → PLAN edge, and it is the one place `decide` proposes building
  //     something rather than reacting to what already exists. It sits after STOP ALL, the
  //     terminal check, the deadline and the budget, so a stopped or out-of-budget Mission
  //     still does not plan — building a plan would be work, and work for a Mission that
  //     may not act is waste.
  if (steps.length === 0) {
    return { decision: 'plan', reason: 'goal_needs_a_plan', stepId: null, nextWakeAt: null }
  }

  // 11. Steps still to run. The concurrency ceiling is consulted here rather than in
  //     `mayBeginStep`, because the *decision* is about whether to try at all — and a
  //     Mission at its delegation ceiling with steps pending is waiting, not finished.
  const runnable = firstRunnable(steps)
  if (runnable !== null) {
    if (input.openDelegations >= mission.budget.maxConcurrentDelegations) {
      return { decision: 'wait', reason: 'concurrency_ceiling', stepId: runnable.stepId, nextWakeAt: later(now, defaultWaitMs(mission, now)) }
    }
    if (input.siblingMissions > 0 && input.openDelegations >= mission.budget.maxConcurrentDelegations - 1) {
      // The swarm guard. Two Missions each at one-below their ceiling would both
      // delegate and together hold eight open delegations, which is the explosion this
      // arithmetic exists to prevent. Holding back the last slot is a cost worth paying
      // for a bound nobody had to notice being breached.
      return { decision: 'wait', reason: 'concurrency_ceiling', stepId: runnable.stepId, nextWakeAt: later(now, defaultWaitMs(mission, now)) }
    }
    return { decision: 'continue', reason: 'delegated', stepId: runnable.stepId, nextWakeAt: null }
  }

  // 11. Every step terminal. Whether that *establishes* anything is a verifier's
  //     question, not this file's — so this proposes completion and stops.
  //
  //     `verifying` is not entered from here either. The runtime does that immediately
  //     before calling `requestCompletion`, so there is no window in which the Mission's
  //     status claims verification is under way while no verification is.
  if (steps.length > 0 && steps.every((step) => step.status === 'verified')) {
    return { decision: 'complete', reason: 'steps_executed', stepId: null, nextWakeAt: null }
  }

  // 12. A plan with steps that are all terminal but *not* all verified. The Mission ran
  //     its plan and the plan did not achieve the goal. Parked rather than failed: a
  //     failed step is an attempt that did not work, and a person still owns the
  //     decision about what happens next.
  if (steps.length > 0 && steps.some((step) => step.status === 'cancelled' || step.status === 'skipped')) {
    return { decision: 'wait', reason: 'step_failed', stepId: null, nextWakeAt: later(now, defaultWaitMs(mission, now)) }
  }

  // 13. Nothing to do and no plan. Waiting on an event is the honest default: there is
  //     no work in flight and nothing in this Mission that could create some.
  return { decision: 'wait', reason: 'waiting_event', stepId: null, nextWakeAt: later(now, defaultWaitMs(mission, now)) }
}

/**
 * Whether a wake may act on this Mission.
 *
 * Four things must line up, and all four are checked here rather than in the runtime so
 * that a caller cannot skip one by constructing the wake differently:
 *
 * - The source must be one Freya grants herself: the durable journal, the clock, or the
 *   owner. A model, a capability, a page or a worker is **not** in that list, so a wake
 *   claiming such a source is refused rather than honoured.
 * - The wake must not already have fired.
 * - An event wake must name an event, and the event delivered must match it.
 * - The wake's instant must not have passed without being consumed, because a missed
 *   wake is *evidence* and is recorded as such rather than silently re-armed.
 *
 * Matching is exact. `mission.completed` satisfies a wake for `mission.completed` and
 * nothing else — no prefixes, no wildcards — because a prefix match would let an
 * unrelated event wake a Mission that was waiting for something specific.
 */
export function mayWake(
  wake: MissionRecord['wake'],
  delivered: { readonly type: string } | null,
  source: MissionWakeSource,
  now: Date,
): { ok: true } | { ok: false; reason: string; code: MissionReason } {
  if (wake === null) return { ok: false, reason: 'this Mission has no scheduled wake', code: 'wake_unmatched' }
  if (!isMissionWakeSource(source)) {
    return { ok: false, reason: `${source} may not wake a Mission`, code: 'wake_unmatched' }
  }
  if (wake.firedAt !== null) {
    return { ok: false, reason: 'that wake has already fired', code: 'wake_unmatched' }
  }

  if (wake.kind === 'event') {
    if (delivered === null) {
      return { ok: false, reason: 'no event was delivered', code: 'wake_unmatched' }
    }
    // The source of an event wake must be the journal itself. A caller claiming to be
    // `time` while delivering an event is delivering something the journal never said.
    if (source !== 'fabric') {
      return { ok: false, reason: 'only the durable journal may satisfy an event wake', code: 'wake_unmatched' }
    }
    if (delivered.type !== wake.eventType) {
      return { ok: false, reason: `that wake is waiting for ${wake.eventType}`, code: 'wake_unmatched' }
    }
    return { ok: true }
  }

  if (wake.kind === 'time') {
    // The clock may satisfy a clock wake, and only the clock. An owner pressing resume is
    // a `manual` wake and is allowed to release a Mission early — which is a different
    // and more powerful statement, and belongs in its own path.
    if (source !== 'time') {
      return { ok: false, reason: 'only the clock may satisfy a timed wake', code: 'wake_unmatched' }
    }
    // A timed wake fires when its instant passes, **not before**. A wake whose `dueAt`
    // is still in the future being satisfied by an early clock read would be a timer that
    // fires early, and "early" is not a concept a bound can have.
    //
    // Note that firing *late* is allowed and is not an error: a wake that came due while
    // the process was down is reconciled at startup and the lateness is recorded by
    // `wakeIsOverdue` rather than refused here.
    if (Date.parse(now.toISOString()) < Date.parse(wake.dueAt)) {
      return { ok: false, reason: 'that wake is not due yet', code: 'wake_unmatched' }
    }
    return { ok: true }
  }

  // `manual`: only the owner.
  return source === 'owner'
    ? { ok: true }
    : { ok: false, reason: 'only the owner may resume a Mission by hand', code: 'wake_unmatched' }
}

/**
 * Whether a wake's instant has passed without being consumed.
 *
 * A *fact*, not a decision. When it is true the runtime records `wake_missed` and
 * re-decides — so "nothing happened" becomes durable evidence rather than silence, and a
 * Mission that waited on an event that never arrived says so.
 */
export function wakeIsOverdue(wake: MissionRecord['wake'], now: Date): boolean {
  return wake !== null && wake.firedAt === null && Date.parse(now.toISOString()) >= Date.parse(wake.dueAt)
}

/** What kind of wake a decision implies. Derived, so the two cannot disagree. */
export function wakeKindFor(decision: MissionDecision, trigger: DecisionTrigger): MissionWakeKind | null {
  if (decision === 'wait' || decision === 'request_approval') {
    // `request_approval` waits on the clock, not on an event: an unanswered gate has to
    // be discovered as expired on time, and nothing in the world announces that.
    return 'time'
  }
  // A decision that is not a wait schedules **no** wake at all. Returning `null` rather
  // than `'manual'` is the load-bearing part: a `manual` wake attached to an autonomous
  // decision would let anything release a Mission by claiming a person had asked.
  //
  // `trigger` is accepted and deliberately unused, for the same reason `decide` does not
  // read it — the trigger explains a decision, it never changes one.
  void trigger
  return null
}

/** The source a wake may legitimately be attributed to, given what woke the runtime. */
export function wakeSourceFor(trigger: DecisionTrigger): MissionWakeSource {
  if (trigger === 'event') return 'fabric'
  if (trigger === 'manual') return 'owner'
  return 'time'
}

/* ------------------------------------------------------------------ helpers */

/**
 * The first step that may run: `pending`, with every dependency `verified`.
 *
 * Plan order, deliberately. See `nextRunnableStep` in `planner.ts` for why
 * predictability is worth more here than urgency.
 */
function firstRunnable(steps: readonly MissionStepRecord[]): MissionStepRecord | null {
  const byId = new Map(steps.map((step) => [step.stepId, step] as const))
  for (const step of steps) {
    if (step.status !== 'pending') continue
    const satisfied = step.dependsOn.every((dependency) => byId.get(dependency)?.status === 'verified')
    if (satisfied) return step
  }
  return null
}

/**
 * Blockers a replan can plausibly clear.
 *
 * A deliberately short list. `no_capable_worker` is *not* on it, because replanning will
 * not conjure a worker — and a Mission that replanned forever waiting for a worker to
 * appear is the infinite-replanning failure the revision ceiling exists to catch. The
 * ceiling is the backstop; this is the front door.
 */
function isReplannable(code: string): boolean {
  return code === 'unknown_capability' || code === 'dependency_unverified'
}

/** The reason code a parked Mission reports for a blocker it cannot clear. */
/**
 * A blocker code's reportable reason.
 *
 * A function rather than a map because the mapping is not the identity — `no_capable_worker`
 * and `worker_mismatch` are distinct blocker codes that are the same *situation* to a
 * person, and a board that showed the internal code would be showing Freya's
 * vocabulary rather than the situation.
 */
function blockerReason(code: string): MissionReason {
  switch (code) {
    case 'no_capable_worker':
    case 'worker_mismatch':
      return 'no_capable_worker'
    case 'budget_exhausted':
      return 'budget_exhausted'
    case 'retry_ceiling':
      return 'retry_ceiling'
    case 'approval_denied':
      return 'approval_denied'
    case 'approval_expired':
      return 'approval_expired'
    case 'capability_unavailable':
      return 'capability_unavailable'
    case 'concurrency_ceiling':
      return 'concurrency_ceiling'
    case 'unknown_capability':
    case 'dependency_unverified':
      return 'unknown_capability'
    case 'interrupted':
      return 'interrupted'
    default:
      return 'step_failed'
  }
}

/** An instant `ms` from now, always a valid instant even when `ms` is 0. */
export function later(now: Date, ms: number): string {
  return new Date(now.getTime() + Math.max(0, ms)).toISOString()
}

/**
 * Whether an evidence item is fresh as of `now`.
 *
 * Shared with the projection and the verifier through `evidenceCounts`, so there is one
 * definition of "expired" in the codebase. Two definitions would be two answers to
 * "is this still valid", and they would eventually disagree.
 */
export function isFresh(expiresAt: string | null, now: Date): boolean {
  return expiresAt === null || Date.parse(expiresAt) > now.getTime()
}
