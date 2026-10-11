import { randomUUID } from 'node:crypto'
import type { EventFabric } from '../../events/fabric'
import type { PrincipalId } from '../../../shared/contracts/identity'
import type { WorkRisk } from '../../work/types'
import type { MissionEngine } from '../engine'
import {
  isLiveMissionStatus,
  isTerminalMissionStatus,
  MISSION_REASONS,
  type MissionCommandOutcome,
  type MissionReason,
  type MissionRecord,
} from '../types'
import {
  asksForGate,
  chargeBudget,
  mayBeginStep,
  readApprovalState,
  type MissionAuthorityPort,
} from './authority'
import {
  decide,
  defaultWaitMs,
  later,
  mayWake,
  wakeIsOverdue,
  wakeKindFor,
  wakeSourceFor,
  type DecisionResult,
  type DecisionTrigger,
} from './continuation'
import { applyCorrection, type CorrectionOutcome } from './correction'
import { isSafeToContinue, planRecovery, type RecoveryAction } from './recovery'
import { plan as buildPlan, type PlanRequest, type PlanStepRequest } from './planner'
import {
  assertWakeBounded,
  type MissionBlockerCode,
  type MissionBudget,
  type MissionCapabilityPort,
  type MissionCorrectionAmbiguity,
  type MissionCorrectionInput,
  type MissionDecision,
  type MissionIntentShape,
  type MissionStepRecord,
} from './types'

/**
 * THE AUTONOMY RUNTIME.
 *
 * ```
 * GOAL → PLAN → DELEGATE → EXECUTE → VERIFY → CONTINUE / WAIT / ASK / COMPLETE
 * ```
 *
 * One `step()` call advances a Mission by at most one decision. It is **never** called on
 * a timer by this file: the caller supplies a trigger, and the only triggers that exist
 * are a manual tick, a matching authenticated event, the clock reaching a scheduled wake,
 * a change in the Mission's own state, and startup reconciliation. That list is the whole
 * answer to "no hidden continuous inference" — there is no loop here to run continuously.
 *
 * ## What this file may do, and what it may not
 *
 * It may: plan, delegate to registered workers, execute steps through Work, record
 * evidence, request approvals, ask the owner, wait on bounded wakes, request completion,
 * conclude, and reconcile after a restart.
 *
 * It may not: grant a capability, decide an approval, complete a Mission without a
 * verifier's verdict, spend money, bypass Guard, or create a grant. Every one of those is
 * a *call* out to a port that this file does not own, and the ports themselves have no
 * such method. The runtime's authority is exactly the intersection of what its ports
 * allow, and it holds none of its own.
 *
 * ## One decision per call, always journalled
 *
 * Every step ends in a `MissionDecision`, and every decision is written to the journal
 * before the call returns. A caller cannot observe a Mission in a state that exists only
 * in memory: if the process died between deciding and recording, the next startup would
 * re-decide from durable facts rather than resume from a half-written intention.
 *
 * That is also why `decide` being pure matters here. The runtime does not *store* a
 * decision and act on it later; it decides, records, and acts in one call, so there is no
 * window in which a stored decision could be acted on twice.
 */

/** What the runtime needs from the Mission engine, and nothing more. */
export interface MissionEnginePort {
  /** The durable record, for reading. Never a live object to mutate. */
  record(missionId: string): MissionRecord | undefined
  /** Commit a plan, or refuse it. The engine owns the revision counter. */
  commitPlan(input: {
    missionId: string
    planId: string
    revision: number
    supersedes: string | null
    reason: string | null
    steps: readonly MissionStepRecord[]
  }): Promise<MissionCommandOutcome>
  /** Move a step. Refuses an illegal transition. */
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
  /** Record evidence. The engine owns `resultCount`. */
  recordEvidence(input: {
    missionId: string
    evidenceId: string
    stepId: string | null
    kind: 'result' | 'observation' | 'report' | 'refusal'
    origin: 'observed' | 'reported'
    summaryLength: number
    expiresAt: string | null
  }): Promise<MissionCommandOutcome>
  /** Raise or clear a blocker. */
  setBlocker(input: {
    missionId: string
    code: string
    stepId: string | null
    raised: boolean
  }): Promise<MissionCommandOutcome>
  /**
   * Record that this step is waiting on a Work approval.
   *
   * A pointer, not a gate: `approvalId` is Work's own. There is deliberately **no**
   * `decideApproval` and **no** `expireApproval` on this port — a Mission cannot decide
   * or expire an approval, because those are decisions and only a person, through
   * `work.approval.decide`, gets to make one.
   */
  noteApprovalRequested(input: {
    missionId: string
    stepId: string
    approvalId: string
    source: 'requested' | 'observed'
    /** The Work Run the gate belongs to. Carried so a parked Mission can poll it. */
    runId: string | null
    requestedAt: string
  }): Promise<MissionCommandOutcome>
  /**
   * Record what **Work** reported about the gate. `outcome` is read back from Work's
   * `ApprovalRecord`, never inferred here.
   */
  noteApprovalOutcome(input: {
    missionId: string
    approvalId: string
    outcome: 'approved' | 'denied' | 'expired' | 'cancelled'
  }): Promise<MissionCommandOutcome>
  /** Schedule the next wake. `dueAt` is required. */
  scheduleWake(input: {
    missionId: string
    wakeId: string
    kind: 'event' | 'time' | 'manual'
    source: 'fabric' | 'time' | 'owner'
    dueAt: string
    eventType: string | null
  }): Promise<MissionCommandOutcome>
  /** Record that a wake fired. A fact, and never an authorisation. */
  fireWake(input: { missionId: string; wakeId: string }): Promise<MissionCommandOutcome>
  /** Journal the decision. */
  recordDecision(input: {
    missionId: string
    decision: MissionDecision
    reason: string
    stepId: string | null
    nextWakeAt: string | null
  }): Promise<MissionCommandOutcome>
  /** Charge a budget dimension. */
  charge(input: {
    missionId: string
    modelCalls: number
    actions: number
    externalRequests: number
    retries: number
    delegations: number
  }): Promise<MissionCommandOutcome>
  /** Record that a ceiling was reached, so a restart cannot hide one. */
  noteBudgetExceeded(input: { missionId: string; budget: string }): Promise<MissionCommandOutcome>
  /**
   * Change the requested quantity.
   *
   * Separate from `noteBudgetExceeded` on purpose. A quantity is a fact about the *goal*
   * ("100 videos"), not a ceiling on Freya's work, and routing it through a budget event
   * would put it in `limitsHit` where it would be reported as an exhausted resource —
   * a Mission that had found 40 of 100 would display as though it had run out of
   * something.
   *
   * Bounded by the engine to `MAX_REQUESTED_QUANTITY` and to positive integers. A
   * correction may not widen a Mission's *authority*; changing how much the owner wants
   * is a different thing entirely, and it is the owner's call.
   */
  setRequestedQuantity(input: { missionId: string; requestedQuantity: number | null }): Promise<MissionCommandOutcome>
  /**
   * A lifecycle transition. The table decides whether it is legal.
   *
   * `reason` is a **closed code**, not a string. That is the property worth having in the
   * type rather than in a validator: there is no shape of this call through which free
   * text could reach the journal, so "the journal holds only codes" holds because the
   * port is typed that way and not because something downstream remembers to check.
   */
  transition(input: {
    missionId: string
    to: MissionRecord['status']
    reason: MissionReason
  }): Promise<MissionCommandOutcome>
  /** Record an applied correction. Field names and counts only. */
  recordCorrection(input: {
    missionId: string
    correctionId: string
    kind: 'patch'
    changedFields: readonly string[]
    settledSteps: number
    preservedEvidence: number
    replannedFrom: string | null
    /**
     * The new quantity, when the correction changed it.
     *
     * Bound to `'quantity'` appearing in `changedFields`, and checked both here and in
     * the validator: a correction that changes the quantity without saying what it
     * became cannot be recorded, because the fold would have nothing to apply and the
     * Mission would keep asking for the old one after a restart.
     */
    requestedQuantity?: number | null
  }): Promise<MissionCommandOutcome>
  /** Record that a correction was ambiguous. Nothing else changed. */
  recordAmbiguity(input: {
    missionId: string
    correctionId: string
    ambiguity: string
  }): Promise<MissionCommandOutcome>
  /** Record that a step's action was in flight when the process stopped. */
  interruptStep(input: {
    missionId: string
    planId: string
    stepId: string
    consequential: boolean
  }): Promise<MissionCommandOutcome>
  /** Request completion. This is the *only* route to `completed`, and it verifies. */
  requestCompletion(missionId: string, options?: { verifierId?: string; requiredRunIds?: readonly string[] }): Promise<MissionCommandOutcome>
  /**
   * Write the private intent. Never journalled. */
  writeIntent(missionId: string, intent: MissionIntentShape): Promise<void>
  /** Read the private intent. */
  readIntent(missionId: string): Promise<MissionIntentShape | null>
}

export interface MissionRuntimeOptions {
  fabric: EventFabric
  principalId: PrincipalId
  missions: MissionEnginePort
  capabilities: MissionCapabilityPort
  authority: MissionAuthorityPort
  /**
   * Register a worker for a capability.
   *
   * Returns whether a capable worker was found. **Never** creates one: a planner that
   * could spawn a worker to satisfy a capability would be able to widen itself past the
   * workforce's roster, which is the boundary Phase 8 drew.
   */
  delegate(input: {
    missionId: string
    stepId: string
    capability: string
  }): Promise<{ ok: true; workerId: string; assignmentId: string } | { ok: false; reason: string }>
  /** Execute one step through Work. Returns a verdict; it never decides anything. */
  execute(input: {
    missionId: string
    stepId: string
    capability: string
    /**
     * The registered verifier the step was planned with.
     *
     * Passed explicitly rather than looked up here, so the executor runs *the check the
     * plan named* and not one it finds convenient. An executor that chose its own verifier
     * could pick one that always passes.
     */
    verifier: string
    risk: WorkRisk
    /**
     * Whether the **plan** asked for a gate on this step.
     *
     * A *request*, carried to the executor so it can set `requiresApproval` on the Run —
     * which is how a Mission asks Work for a gate. It is not the capability's own gate
     * requirement and it cannot lower it: the executor ORs this against the registered
     * capability's risk, so a plan may make a step more gated and never less.
     */
    requiresApproval: boolean
    signal: AbortSignal
  }): Promise<
    | {
        readonly ok: true
        readonly runId: string
        readonly verified: boolean
        readonly observedResults: number
        readonly reportedResults: number
        readonly summaryLength: number
        /**
         * Work parked this Run at one of **its own** gates, so nothing ran.
         *
         * `ok: true` with this set is deliberate: the executor did its job — it created
         * the Run, handed it to Work and Work answered — and the answer was "a person has
         * to decide first". It is not a failure and not a success, so the runtime reads
         * the gate through `authority.approvalState` rather than guessing. It is reported
         * here rather than inferred from `ok: false` so that a genuinely failed Run and a
         * parked one can never be confused.
         */
        readonly awaitingApproval: boolean
      }
    | { readonly ok: false; readonly reason: string }
  >
  now?: () => Date
  newId?: () => string
  onChange?: () => void
  /** STOP ALL, read live. */
  stopAll?: () => boolean
  /** How many Missions are currently live, for the swarm guard. */
  liveMissionCount?: () => number
}

/** What one `step()` did. Enough for a caller to render, and nothing it could act on. */
export interface StepOutcome {
  readonly missionId: string
  readonly decision: MissionDecision
  readonly reason: string
  readonly stepId: string | null
  readonly nextWakeAt: string | null
  /** Status after the step. For display; never a permission. */
  readonly status: MissionRecord['status']
  /** What was refused, if anything. A closed code plus a sentence for a person. */
  readonly refusals: readonly string[]
  /** Whether the loop may run again unattended. */
  readonly quiescent: boolean
}

/**
 * Reasons that mean "something is in the way" rather than "nothing is due yet".
 *
 * Written out rather than derived, because the distinction is a judgement about what a
 * person should see on a board and therefore has to be reviewable. A reason added to
 * `MISSION_REASONS` is *not* automatically one of these: it parks as `waiting` until
 * somebody decides it means `blocked`, and that is the correct default — understating a
 * problem is better than inventing one.
 */
const PARKING_AS_BLOCKED: ReadonlySet<MissionReason> = new Set<MissionReason>([
  MISSION_REASONS.budget_exhausted,
  MISSION_REASONS.retry_ceiling,
  MISSION_REASONS.unknown_capability,
  MISSION_REASONS.no_capable_worker,
  MISSION_REASONS.worker_mismatch,
  MISSION_REASONS.capability_unavailable,
  MISSION_REASONS.dependency_unverified,
  MISSION_REASONS.approval_denied,
  MISSION_REASONS.approval_expired,
  MISSION_REASONS.step_failed,
  MISSION_REASONS.concurrency_ceiling,
  MISSION_REASONS.replan_ceiling,
  MISSION_REASONS.interrupted,
])

/**
 * Which blocker code a parking reason corresponds to, where one exists.
 *
 * A **partial** map, and the omissions are the interesting part. `budget_exhausted` and
 * `concurrency_ceiling` are absent because neither is something *in the way* — they are
 * properties of the Mission's own ceilings, and a board rendering "blocked by its action
 * budget" would be stating a true fact that nobody can act on. `waiting_event` and
 * `waiting_time` are absent for the same reason: nothing is wrong.
 */
const BLOCKER_FOR_REASON: Readonly<Partial<Record<MissionReason, MissionBlockerCode>>> = Object.freeze({
  unknown_capability: 'unknown_capability',
  capability_unavailable: 'capability_unavailable',
  dependency_unverified: 'dependency_unverified',
  no_capable_worker: 'no_capable_worker',
  worker_mismatch: 'worker_mismatch',
  approval_denied: 'approval_denied',
  approval_expired: 'approval_expired',
  step_failed: 'step_failed',
  interrupted: 'step_failed',
  replan_ceiling: 'budget_exhausted',
})

export class MissionAutonomyRuntime {
  private closed = false
  /** Missions with a step in flight. Guards against two concurrent steps. */
  private readonly stepping = new Set<string>()

  constructor(private readonly options: MissionRuntimeOptions) {}

  async open(): Promise<void> {
    this.closed = false
    this.stepping.clear()
  }

  async close(): Promise<void> {
    this.closed = true
  }

  /**
   * Reconcile every live Mission after a restart.
   *
   * Deterministic and idempotent: it applies {@link planRecovery}'s conclusions and
   * nothing else. It does **not** resume execution, does **not** re-run an interrupted
   * step, and does **not** invent a wake — a Mission whose wake passed is recorded as
   * missed and then re-decided from scratch, which is the only way to avoid replaying a
   * decision that was made for reasons that no longer hold.
   *
   * Returns one outcome per Mission, in the order it was given, so a caller can show
   * what recovery did.
   */
  async reconcile(missionIds: readonly string[]): Promise<StepOutcome[]> {
    const outcomes: StepOutcome[] = []
    for (const missionId of missionIds) {
      const mission = this.options.missions.record(missionId)
      if (mission === undefined) continue
      const report = planRecovery(mission, this.clock())
      if (!report.quiescent) {
        await this.applyRecovery(mission, report.actions)
      }
      // Recovery always re-decides afterwards, even when quiescent: a Mission whose wake
      // fired before the crash needs its next decision made from current facts.
      outcomes.push(await this.step(missionId, 'recovery', null))
    }
    return outcomes
  }

  /**
   * Advance one Mission by at most one decision.
   *
   * The whole loop, in one call. Concurrent calls for the same Mission are refused
   * rather than queued: queueing would let a caller pile up work against a Mission that
   * may be stopped or settled by the time its turn came, and the refusal says so
   * immediately.
   */
  async step(missionId: string, trigger: DecisionTrigger, delivered: { type: string } | null): Promise<StepOutcome> {
    if (this.closed) return this.idle(missionId, 'shutdown')
    if (this.stepping.has(missionId)) return this.idle(missionId, 'verification_in_progress')

    this.stepping.add(missionId)
    try {
      return await this.advance(missionId, trigger, delivered)
    } finally {
      this.stepping.delete(missionId)
    }
  }

  /* ----------------------------------------------------------------- the loop */

  private async advance(missionId: string, trigger: DecisionTrigger, delivered: { type: string } | null): Promise<StepOutcome> {
    const refusals: string[] = []
    const mission = this.options.missions.record(missionId)
    if (mission === undefined) return this.idle(missionId, 'no such mission')

    // STOP ALL, checked before anything and read live. A Mission cannot even *decide*
    // while the panic button is latched, which is stricter than not acting — and is the
    // right reading: a decision that recorded "I will continue" and then did not is
    // worse than no decision, because it looks like one.
    //
    // The Mission is also *moved* to `stopped`, not merely left where it was. That is the
    // difference between a gate and a pause: a Mission that reads `active` while Freya is
    // stopped looks like it is still doing something, and a person checking the board
    // would be told a falsehood by omission.
    if (this.options.stopAll?.() === true) {
      const status = await this.to(missionId, 'stopped', 'stopped', refusals)
      return this.park(missionId, { ...mission, status }, 'stopped', refusals, 'STOP ALL is active')
    }

    // Wake gating. A Mission that scheduled a wake may only be advanced by that wake,
    // or by a manual step. This is what stops an unrelated event from nudging a Mission
    // out of a wait it has not finished.
    if (mission.wake !== null && trigger !== 'manual') {
      const allowed = mayWake(mission.wake, delivered, wakeSourceFor(trigger), this.clock())
      if (!allowed.ok) {
        // An overdue wake is recorded and the Mission re-decided, rather than refused
        // for ever: a wake that came due while nothing was listening is exactly the case
        // "missed deadline becomes evidence" is about.
        if (wakeIsOverdue(mission.wake, this.clock())) {
          await this.options.missions.fireWake({ missionId, wakeId: mission.wake.wakeId }).catch(() => undefined)
        }
        return this.park(missionId, mission, allowed.code, refusals, allowed.reason)
      }
      await this.options.missions.fireWake({ missionId, wakeId: mission.wake.wakeId }).catch(() => undefined)
    }

    const now = this.clock()
    const decision = decide({
      mission,
      now,
      trigger,
      stopped: this.options.stopAll?.() === true,
      remaining: this.remaining(mission),
      openDelegations: this.openDelegations(mission),
      siblingMissions: this.siblings(missionId),
    })

    // Journal the decision **before** acting on it. If the process dies between the two,
    // startup re-decides from durable facts — which is safe, because `decide` is pure —
    // rather than resuming a half-written intention.
    await this.options.missions.recordDecision({
      missionId,
      decision: decision.decision,
      reason: decision.reason,
      stepId: decision.stepId,
      nextWakeAt: decision.nextWakeAt,
    })

    const applied = await this.apply(missionId, mission, decision, refusals)
    const record = this.options.missions.record(missionId) ?? mission

    // The **reported** decision may differ from the one that was asked about, because
    // acting on `continue` can discover that an approval is needed.
    //
    // That has to be reported, not swallowed. A caller reading `decision: 'continue'` next
    // to a Mission that has just parked in `approval-required` would be reading two
    // contradictory facts, and the contradiction is exactly the kind of thing this
    // subsystem exists to avoid. So `apply` returns what actually happened and that is
    // what the outcome carries; the *journalled* decision stays the one `decide` reached,
    // which is the honest record of the reasoning.
    const reported = applied.decision === decision.decision ? decision : { ...decision, ...applied }

    // A parked Mission schedules its wake, and **only** a parked one.
    //
    // The trigger is `reported.decision`, not `decision.decision`, and the difference is
    // load-bearing: `decide` may have said `continue` and the attempt may have parked it
    // on a blocker. A Mission parked without a scheduled wake would never be looked at
    // again — nothing due, nothing running, no event expected — which is how a Mission
    // that blocked on "no capable worker" becomes silent.
    //
    // Conversely, a decision that is *not* a wait schedules nothing, and `wakeKindFor`
    // returns null for those. So there is no path by which an autonomous decision ends up
    // holding a `manual` wake a person could release.
    const kind = wakeKindFor(reported.decision, trigger)
    let parkedAt = reported.nextWakeAt
    if (reported.decision === 'wait' && kind !== null) {
      // A parked Mission that was not already waiting on something needs its own instant.
      // `decide` supplied one for a genuine `wait`; a correction applied during `continue`
      // did not, so it is derived here rather than left null — an unbounded wait is the one
      // shape this subsystem must not be able to record.
      parkedAt = reported.nextWakeAt ?? later(this.clock(), this.waitMs(record))
      await this.scheduleWake(missionId, record, kind, wakeSourceFor(trigger), parkedAt, null)
    }

    this.options.onChange?.()
    return {
      missionId,
      decision: reported.decision,
      reason: reported.reason,
      stepId: reported.stepId,
      // `parkedAt`, not `reported.nextWakeAt`: when the applied result discovered the park
      // (a `continue` that turned into a `wait` on a blocker), the instant was derived
      // rather than decided, and the outcome has to report the instant the Mission was
      // *actually* scheduled for. Reporting `null` there while a wake exists on the record
      // would be two contradictory facts about the same Mission.
      nextWakeAt: parkedAt,
      status: applied.status,
      refusals: Object.freeze([...refusals]),
      quiescent: reported.decision === 'wait' || reported.decision === 'ask_owner',
    }
  }

  /**
   * Carry out one decision. Each branch is one decision and nothing else.
   *
   * Returns the status the Mission reached **and** any correction to the decision that
   * turned out to be the honest one. The correction matters because acting on a decision
   * can reveal something the decision did not know — the common case being `continue`
   * discovering that the step needs a person's signature, which is `request_approval` and
   * not `continue`.
   */
  private async apply(
    missionId: string,
    mission: MissionRecord,
    decision: DecisionResult,
    refusals: string[],
  ): Promise<AppliedDecision> {
    switch (decision.decision) {
      case 'wait':
        // Parked. The status depends on *why*, and the four are genuinely different
        // things to a person: `blocked` is "something is in the way", `waiting` is
        // "nothing is due yet", `approval-required` is "you must decide", `stopped` is
        // "the gate is shut".
        //
        // The mapping is a **function of the reason**, not a guess, and every reason a
        // decision can park with appears in one of the two lists. A reason in neither
        // falls through to `waiting`, which is the more forgiving of the two — and that
        // default is deliberate, because "waiting" understates a problem and "blocked"
        // overstates one.
        if (mission.status === 'stopped') return applied(mission.status)
        if (decision.reason === 'stopped') {
          return applied(await this.to(missionId, 'stopped', decision.reason, refusals))
        }
        if (PARKING_AS_BLOCKED.has(decision.reason)) {
          // A blocker a step *caused* is recorded here as well as parked on.
          //
          // `decide` can discover a blocked step the planner produced and there is no
          // blocker record for it yet — the planner writes the step, and the blocker is
          // raised the first time somebody looks. Without this the Mission would report
          // `blocked` with an empty blocker list, and a board rendering that list would
          // show a Mission that is stuck for no stated reason.
          await this.raiseBlockerFor(missionId, decision.reason, decision.stepId)
          return asParked(
            await this.to(missionId, 'blocked', decision.reason, refusals),
            decision.reason,
            decision.stepId,
          )
        }
        if (mission.awaitingOwner) return applied(mission.status)
        return asParked(
          await this.to(missionId, 'waiting', decision.reason, refusals),
          decision.reason,
          decision.stepId,
        )

      case 'ask_owner':
        // `awaitingOwner` was set by the fold of the journalled decision. Only the status
        // is left to move.
        return applied(
          mission.awaitingOwner ? mission.status : await this.to(missionId, 'blocked', 'intent_ambiguous', refusals),
        )

      case 'continue':
        return this.advanceStep(missionId, mission, decision.stepId, refusals)

      case 'retry':
        return applied(await this.retryStep(missionId, mission, decision.stepId, refusals))

      case 'plan':
        return applied(await this.planMission(missionId, mission, refusals))

      case 'replan':
        return applied(await this.replanMission(missionId, mission, decision.stepId, refusals))

      case 'request_approval': {
        const step = this.stepById(mission, decision.stepId)
        if (step === null) return applied(await this.to(missionId, 'blocked', 'step_failed', refusals))

        // **Polling, not re-running.** A Mission already parked on a gate has nothing to do
        // but ask Work what happened to it, and `decide` reaches this branch every time it
        // is woken while the gate is open.
        //
        // Delegating and executing again here would be the worst available mistake: it would
        // create a *second* Work Run for one step, so the step would have two Runs, one
        // action's worth of budget charged twice, and a gate on the first Run that nobody
        // would ever look at again. So the parked path reads the gate and nothing else.
        if (mission.status === 'approval-required' && mission.approval !== null) {
          const polled = await this.observeApproval(
            missionId,
            step,
            mission.approval.runId,
            // The source is already on the reference; re-deriving it could disagree with
            // what was recorded when the gate was first seen.
            mission.approval.source,
            refusals,
          )
          // Still open: report `wait`, because `request_approval` would read as "we just
          // asked again" and the point of this branch is that nobody asked anything.
          return polled === 'approval-required'
            ? asParked(polled, 'approval_pending', step.stepId)
            : applied(polled)
        }

        // Not parked yet: hand the step to Work and read back whatever gate Work opened.
        // `decide` choosing `request_approval` is a request to *run*; it is not permission,
        // and only Work decides whether a gate appears.
        const gate = mayBeginStep(
          step,
          mission.status as 'ready' | 'planning' | 'active' | 'waiting' | 'blocked' | 'approval-required' | 'stopped',
          mission.budget,
          this.remaining(mission),
          this.options.authority,
        )
        if (!gate.ok) {
          refusals.push(gate.reason)
          return asParked(
            await this.to(missionId, gate.code === 'stopped' ? 'stopped' : 'blocked', gate.code, refusals),
            gate.code,
            step.stepId,
          )
        }
        const delegation = await this.options.delegate({
          missionId,
          stepId: step.stepId,
          capability: step.capability,
        })
        if (!delegation.ok) {
          refusals.push(delegation.reason)
          const code = /concurren/i.test(delegation.reason) ? 'concurrency_ceiling' : 'no_capable_worker'
          await this.options.missions.setBlocker({ missionId, code, stepId: step.stepId, raised: true })
          await this.noteBudget(missionId, code)
          return asParked(await this.to(missionId, 'blocked', code, refusals), code, step.stepId)
        }
        await this.options.missions.transitionStep({
          missionId,
          planId: mission.activePlan?.planId ?? '',
          stepId: step.stepId,
          to: 'delegated',
          workerId: delegation.workerId,
          attempts: step.attempts,
        })
        await this.options.missions.charge({
          missionId,
          modelCalls: 0,
          actions: 0,
          externalRequests: 0,
          retries: 0,
          delegations: 1,
        })
        const applied_ = await this.executeStep(
          missionId,
          mission,
          step,
          delegation.workerId,
          delegation.assignmentId,
          refusals,
        )
        // Only *becoming* `approval-required` makes this a `request_approval` outcome. A
        // step that ran, or that Work refused for some other reason, reports what actually
        // happened — reporting `request_approval` beside an `active` Mission would be two
        // contradictory facts in one row.
        return applied_.status === 'approval-required' ? asApproval(applied_.status, step.stepId) : applied_
      }

      case 'complete':
        return applied(await this.requestCompletion(missionId, refusals))

      case 'fail':
        return applied(await this.to(missionId, 'failed', decision.reason, refusals))

      default:
        return applied(mission.status)
    }
  }

  /* -------------------------------------------------------------- operations */

  /**
   * Delegate and run the next step.
   *
   * Five gates, in order, and each one is checked at the moment it applies:
   *
   * 1. The Mission must be live. `waiting`, `blocked`, `approval-required` and `stopped`
   *    are all refusals, which is what makes those states mean something.
   * 2. Budget. Checked by `mayBeginStep` before anything is created, so a Mission at its
   *    ceiling allocates no worker and opens no Run.
   * 3. Delegation. A **registered** worker holding the capability, at bounded
   *    concurrency. No match is a blocker, not a fallback to doing it inline.
   * 4. Execution. Through Work, with the Run attached to the Mission, asking Work for a
   *    gate when the step's capability is gated. **There is no Mission-level gate.**
   *    A step that needs a signature gets a Work Run, Work's Guard opens the gate inside
   *    `drive()`, and the Mission parks on the id Work reports — see `executeStep` and
   *    `observeApproval`. A person answers once, on Work's surface.
   * 5. Approval read-back. If Work parked the Run, the Mission parks in
   *    `approval-required` pointing at that gate. If a person has since denied it or let
   *    it expire, the Mission says so and blocks — truthfully, from Work's own record.
   *
   * Step 4's "no match is a blocker, not a fallback" is worth stating: doing the work
   * Freya's own principal would have done is exactly how a bounded delegation system
   * becomes an unbounded one, and it would also mean the work ran without the
   * concurrency accounting that makes the ceiling meaningful.
   */
  private async advanceStep(
    missionId: string,
    mission: MissionRecord,
    stepId: string | null,
    refusals: string[],
  ): Promise<AppliedDecision> {
    const step = this.stepById(mission, stepId)
    if (step === null) return applied(await this.to(missionId, 'blocked', 'step_failed', refusals))

    if (!isLiveMissionStatus(mission.status)) {
      refusals.push(`${mission.status}`)
      return applied(
        await this.to(missionId, mission.status === 'blocked' ? 'blocked' : 'waiting', 'waiting_event', refusals),
      )
    }

    // The gate takes the status it is *allowed* to act from, which is the live set. Passing
    // `mission.status` here would need a cast, because `MissionStatus` is the wider union
    // and the point of the narrower parameter is that `mayBeginStep` itself cannot be
    // asked about a terminal Mission. The guard above has already established liveness.
    const gate = mayBeginStep(
      step,
      mission.status as 'ready' | 'planning' | 'active' | 'waiting' | 'blocked' | 'approval-required' | 'stopped',
      mission.budget,
      this.remaining(mission),
      this.options.authority,
    )
    if (!gate.ok) {
      refusals.push(gate.reason)
      return asParked(
        await this.to(missionId, gate.code === 'stopped' ? 'stopped' : 'blocked', gate.code, refusals),
        gate.code,
        step.stepId,
      )
    }

    const delegation = await this.options.delegate({
      missionId,
      stepId: step.stepId,
      capability: step.capability,
    })
    if (!delegation.ok) {
      refusals.push(delegation.reason)
      const code = /concurren/i.test(delegation.reason) ? 'concurrency_ceiling' : 'no_capable_worker'
      await this.options.missions.setBlocker({ missionId, code, stepId: step.stepId, raised: true })
      await this.noteBudget(missionId, code)
      return asParked(await this.to(missionId, 'blocked', code, refusals), code, step.stepId)
    }

    await this.options.missions.transitionStep({
      missionId,
      planId: mission.activePlan?.planId ?? '',
      stepId: step.stepId,
      to: 'delegated',
      workerId: delegation.workerId,
      attempts: step.attempts,
    })
    await this.options.missions.charge({
      missionId,
      modelCalls: 0,
      actions: 0,
      externalRequests: 0,
      retries: 0,
      delegations: 1,
    })

    return this.executeStep(missionId, mission, step, delegation.workerId, delegation.assignmentId, refusals)
  }

  /**
   * Run a delegated step and record what it found.
   *
   * The step's outcome comes from Work and is treated as **evidence, not truth**:
   * `verified: false` becomes a `failed` step, and a `true` becomes a `verified` step only
   * when the executor says so. There is no path here where a step reaches `verified`
   * without the executor having run it.
   */
  private async executeStep(
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
    await this.options.missions.transitionStep({
      missionId,
      planId,
      stepId: step.stepId,
      to: 'running',
      workerId,
      attempts: step.attempts + 1,
    })
    await this.options.missions.charge({
      missionId,
      modelCalls: 0,
      actions: 1,
      externalRequests: step.risk === 'consequential' ? 1 : 0,
      retries: 0,
      delegations: 0,
    })

    const outcome = await this.options.execute({
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
        await this.observeApproval(
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
      await this.options.missions.transitionStep({
        missionId,
        planId,
        stepId: step.stepId,
        to: 'failed',
        workerId,
        attempts: step.attempts + 1,
        reason: MISSION_REASONS.step_failed,
      })
      await this.options.missions.setBlocker({ missionId, code: 'step_failed', stepId: step.stepId, raised: true })
      return applied(await this.to(missionId, 'blocked', 'step_failed', refusals))
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
      await this.options.missions.recordEvidence({
        missionId,
        evidenceId: this.newId(),
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
      await this.options.missions.recordEvidence({
        missionId,
        evidenceId: this.newId(),
        stepId: step.stepId,
        kind: 'report',
        origin: 'reported',
        summaryLength: outcome.summaryLength,
        expiresAt: null,
      })
    }

    await this.options.missions.transitionStep({
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
      await this.options.missions.setBlocker({ missionId, code: 'step_failed', stepId: step.stepId, raised: false })
      return applied('active')
    }
    await this.options.missions.setBlocker({ missionId, code: 'step_failed', stepId: step.stepId, raised: true })
    return applied(await this.to(missionId, 'blocked', 'step_failed', refusals))
  }

  /**
   * Retry a failed step, while the ceiling allows.
   *
   * The charge is made **before** the attempt, not after, so a retry that crashes cannot
   * be retried for free. A budget that is only charged on success is not a budget.
   */
  private async retryStep(
    missionId: string,
    mission: MissionRecord,
    stepId: string | null,
    refusals: string[],
  ): Promise<MissionRecord['status']> {
    const step = this.stepById(mission, stepId)
    if (step === null) return this.to(missionId, 'blocked', 'step_failed', refusals)

    const charge = chargeBudget(
      mission.spend,
      mission.budget,
      { retries: 1 },
    )
    if (!charge.ok) {
      refusals.push(charge.reason)
      await this.noteBudget(missionId, charge.dimension)
      return this.to(missionId, 'blocked', 'retry_ceiling', refusals)
    }
    await this.options.missions.charge({
      missionId,
      modelCalls: 0,
      actions: 0,
      externalRequests: 0,
      retries: 1,
      delegations: 0,
    })

    const planId = mission.activePlan?.planId ?? ''
    // `failed → pending` is not a legal step transition, so the retry is expressed as
    // clearing the blocker and letting the next `decide` pick the step up again. That
    // keeps one definition of "a step is runnable" — in `decide` — rather than two.
    await this.options.missions.setBlocker({ missionId, code: 'step_failed', stepId: step.stepId, raised: false })
    void planId
    return this.to(missionId, 'active', 'retrying', refusals)
  }

  /**
   * Replan, within the revision ceiling.
   *
   * The ceiling is checked **here** as well as in `replan`, because this is the function
   * a caller reaches for and a ceiling enforced only in a helper would be one refactor
   * from being unbounded.
   *
   * A replan carries no new capabilities of its own: the request is built from the
   * Mission's existing plan, so replanning can re-order, drop or re-decompose work but
   * cannot introduce a capability the previous plan did not name. That is what stops
   * "the plan was wrong" from becoming "the plan wanted more than before".
   */
  private async replanMission(
    missionId: string,
    mission: MissionRecord,
    stepId: string | null,
    refusals: string[],
  ): Promise<MissionRecord['status']> {
    const current = mission.activePlan
    if (current === null) return this.to(missionId, 'blocked', 'replan_ceiling', refusals)
    if (mission.planRevisions >= mission.budget.maxPlanRevisions) {
      refusals.push('the replan ceiling has been reached')
      await this.noteBudget(missionId, 'maxPlanRevisions')
      return this.to(missionId, 'blocked', 'replan_ceiling', refusals)
    }

    // The only structural change a replan makes here is to **cancel** the step that
    // caused the block and keep the rest. That is deliberately modest: it is enough to
    // recover from a bad step without inventing a plan, and it cannot widen anything
    // because every surviving step keeps the capability it already had.
    const request: PlanRequest = {
      missionId,
      steps: current.steps
        .filter((step) => step.stepId !== stepId)
        .map((step) => ({
          stepId: step.stepId,
          capability: step.capability,
          // Carried from the step being replanned. A replan that had to invent a verifier
          // would be choosing the check that judges its own work, so the existing one
          // travels with the step and is re-resolved against the same registry.
          verifier: step.verifier,
          dependsOn: [...step.dependsOn],
          requiresApproval: step.requiresApproval,
        })),
      supersedes: current.planId,
    }
    const outcome = buildPlan(request, this.options.capabilities, mission.budget, this.clock())
    if (!outcome.ok) {
      refusals.push(outcome.reason)
      await this.noteBudget(missionId, 'maxPlanRevisions')
      return this.to(missionId, 'blocked', 'replan_ceiling', refusals)
    }

    await this.options.missions.commitPlan({
      missionId,
      planId: `${missionId}-p${mission.planRevisions + 1}`,
      revision: mission.planRevisions + 1,
      supersedes: current.planId,
      reason: MISSION_REASONS.plan_revised,
      steps: outcome.plan.steps.map((step) => ({ ...step })),
    })
    for (const blockedStepId of outcome.blocked) {
      await this.options.missions.setBlocker({
        missionId,
        code: 'unknown_capability',
        stepId: blockedStepId,
        raised: true,
      })
    }
    return outcome.blocked.length > 0
      ? this.to(missionId, 'blocked', 'unknown_capability', refusals)
      : this.to(missionId, 'active', 'plan_revised', refusals)
  }

  /**
   * Read Work's gate and park the Mission truthfully on it.
   *
   * This is the *only* approval code path in the runtime, and it is a read plus a
   * transition. It cannot open a gate and cannot decide one: the id it records is the one
   * Work's `work.approval.requested` carried, and the decision on that gate belongs to
   * `work.approval.decide` behind a Guard evaluation of the owner.
   *
   * Three answers, and the third is the one that matters most:
   *
   * - `open` → record the pointer, park in `approval-required`. The step has not run.
   * - `settled` as `approved` → Work's own engine already resumed the Run, so there is
   *   nothing to park on. The Mission reports the truth, which is that it is no longer
   *   waiting; the next `step()` observes whatever the step became.
   * - `settled` as denied / expired / cancelled → the step will not run, so the Mission
   *   blocks with the reason Work reported. Not a failure, and emphatically not consent:
   *   expiry is silence, and this is the line that refuses to read it as agreement.
   */
  private async observeApproval(
    missionId: string,
    step: MissionStepRecord,
    runId: string | null,
    source: 'requested' | 'observed',
    refusals: string[],
  ): Promise<MissionRecord['status']> {
    const read = await readApprovalState(step, missionId, runId, this.options.authority)
    if (!read.ok) {
      // Unable to ask is not a denial and not a pass. It blocks, and it says why.
      refusals.push(read.reason)
      return this.to(missionId, 'blocked', 'approval_expired', refusals)
    }

    const state = read.state
    if (state.kind === 'none') {
      // The executor said the Run was parked on a gate and Work says it has none. One of
      // them is wrong and Core cannot tell which, so it says so rather than proceeding —
      // proceeding on a disagreement about whether a person is needed is exactly how a
      // consequential action runs unasked.
      refusals.push('Work reported the step was waiting for approval, but no approval was found')
      return this.to(missionId, 'blocked', 'approval_expired', refusals)
    }

    // **Both** branches record the pointer first, including the settled one.
    //
    // Not tidiness: it is what makes the outcome recordable. The Mission learns "I am
    // waiting on gate X" and "gate X came back denied" as two observations of the same Work
    // event, and `noteApprovalOutcome` refuses an outcome for a gate the record does not
    // already name. Without this, a denial that landed between two decisions would be
    // dropped — and a dropped denial is a gated step that quietly carries on.
    await this.options.missions.noteApprovalRequested({
      missionId,
      stepId: step.stepId,
      approvalId: state.approvalId,
      source,
      runId,
      requestedAt: state.requestedAt,
    })

    if (state.kind === 'open') {
      return this.to(missionId, 'approval-required', 'approval_pending', refusals)
    }

    // Settled. Record what Work said, then park on the consequence.
    await this.options.missions.noteApprovalOutcome({
      missionId,
      approvalId: state.approvalId,
      outcome: state.outcome,
    })
    if (state.outcome === 'approved') {
      // Work resumed the Run itself. Nothing to block on and nothing to invent: the next
      // decision reads the step's real status.
      refusals.push('the approval was granted and the Run is proceeding')
      return this.to(missionId, 'active', 'approval_granted', refusals)
    }
    const code = state.outcome === 'denied' ? 'approval_denied' : 'approval_expired'
    return asParked(await this.to(missionId, 'blocked', code, refusals), code, step.stepId).status
  }

  /**
   * Build the first plan. The GOAL → PLAN edge.
   *
   * Distinct from `replanMission` in the two ways that matter:
   *
   * - **Revision 1 is free.** `maxPlanRevisions` bounds *replacements*, and a Mission that
   *   had to pay for its own first plan could never be planned at all. The ceiling exists to
   *   catch a loop where a plan is repeatedly wrong, not to tax the first attempt.
   * - **The plan comes from the goal, not from a previous plan.** There is no existing plan
   *   to carry steps forward from, so this one is genuinely new work — which is also why it
   *   is the one place a Mission may name capabilities the registry offers.
   *
   * A step the planner could not resolve becomes a blocker rather than being silently
   * dropped: a plan that quietly omitted the hard part would report progress on the easy part
   * and call it done.
   */
  private async planMission(
    missionId: string,
    mission: MissionRecord,
    refusals: string[],
  ): Promise<MissionRecord['status']> {
    if (mission.activePlan !== null) {
      // A plan already exists, so `plan` is stale by the time it was acted on. Re-deciding is
      // the honest answer rather than replacing a plan nobody said was wrong.
      return this.to(missionId, 'active', 'plan_committed', refusals)
    }
    await this.options.missions.transition({ missionId, to: 'planning', reason: MISSION_REASONS.plan_started })

    const proposal = await this.proposeSteps(missionId, mission, refusals)
    if (proposal === null) {
      return this.to(missionId, 'blocked', 'unknown_capability', refusals)
    }
    const outcome = buildPlan(
      { missionId, steps: proposal, supersedes: null },
      this.options.capabilities,
      mission.budget,
      this.clock(),
    )
    if (!outcome.ok) {
      refusals.push(outcome.reason)
      return this.to(missionId, 'blocked', 'replan_ceiling', refusals)
    }
    await this.options.missions.commitPlan({
      missionId,
      planId: `${missionId}-p1`,
      revision: 1,
      supersedes: null,
      reason: MISSION_REASONS.goal_needs_a_plan,
      steps: outcome.plan.steps.map((step) => ({ ...step })),
    })
    for (const blockedStepId of outcome.blocked) {
      await this.options.missions.setBlocker({
        missionId,
        code: 'unknown_capability',
        stepId: blockedStepId,
        raised: true,
      })
    }
    return outcome.blocked.length > 0
      ? this.to(missionId, 'blocked', 'unknown_capability', refusals)
      : this.to(missionId, 'active', 'plan_committed', refusals)
  }

  /**
   * Choose what the first plan should be.
   *
   * ## The problem, stated plainly
   *
   * `planner.ts` deliberately takes **capability names** and not prose — handing a planner
   * sentences would let its output be sentences, and its output goes into a journal. So the
   * planner cannot derive steps from a goal by itself, and something has to say which
   * registered capabilities this goal should be pursued with. Core has no model call to ask.
   *
   * ## The rule: one capability, the least risky one
   *
   * A single step, naming the registered capability with the **lowest risk**, tie-broken by
   * name so two runs of the same Core plan the same work.
   *
   * Both halves of that are deliberate:
   *
   * - **One step.** A plan is a set of claims, and the Mission verifier requires *every* step
   *   to be verified before the goal is established. So a plan is only worth committing if
   *   all of it can succeed — and Core cannot know that about a capability it has never run.
   *   Proposing one step makes the plan a single bet whose outcome the next `step()` learns
   *   from, and a Mission that gets it wrong *replans* rather than being permanently poisoned
   *   by a sibling step it never had a chance at.
   * - **Lowest risk first.** `risk` is Core's own registration, not a guess: `none` before
   *   `routine` before `consequential`. Starting with the least consequential thing is the
   *   right default when nothing is known about which capability suits the goal, because the
   *   alternative is to open with a step that may need a person's signature.
   *
   * An earlier version proposed **every** registered capability, on the reasoning that
   * over-broad was safer than under-broad. It was not safer in any useful sense: a plan
   * containing an unfalsifiable step can never complete as a whole, so almost every Mission
   * blocked on `step_failed` with nothing to show. Failing safe means not committing to work
   * Core has no reason to believe, and one cautious step is that.
   *
   * ## What this does not do
   *
   * It does not narrow what Freya may do. `planner.ts` still resolves the name against the
   * table, `mayBeginStep` still asks the authority port, and the executor still goes through
   * Work's Guard. The rule picks *what to try first*, never *what is permitted*.
   *
   * Returns `null` when nothing at all is registered, so the caller blocks rather than
   * committing an empty plan.
   */
  private async proposeSteps(
    missionId: string,
    mission: MissionRecord,
    refusals: string[],
  ): Promise<PlanStepRequest[] | null> {
    const known = [...this.options.capabilities.known()].sort()
    if (known.length === 0) {
      refusals.push('no capability is registered, so there is nothing to plan')
      return null
    }
    if (this.options.capabilities.verifiers().length === 0) {
      // A step with no way to be checked can only ever complete on the strength of its
      // action, which is exactly what a mandatory verifier exists to prevent.
      refusals.push('no verifier is registered, so no step could ever be checked')
      return null
    }
    // **Only capabilities that declare their own verifier are planned.**
    //
    // The alphabetical-first verifier is `test.always-fails` — registered precisely to show
    // that verification can fail — so a planner that picked one would build a plan that
    // retries to its ceiling and blocks, which is indistinguishable from work that kept
    // failing. Leaving unpaired capabilities out is the conservative error: the Mission plans
    // less, and what it does plan has a check that was written for it.
    const paired = known
      .map((capability) => ({ capability, binding: this.options.capabilities.lookup(capability) }))
      .filter(
        (entry): entry is { capability: string; binding: NonNullable<ReturnType<MissionCapabilityPort['lookup']>> } =>
          entry.binding !== null && entry.binding.verifier !== null,
      )
    if (paired.length === 0) {
      refusals.push('no registered capability declares a verifier that could check it')
      return null
    }
    const rank: Readonly<Record<WorkRisk, number>> = { none: 0, routine: 1, consequential: 2 }
    // Lowest risk first, name as the tie-break, so the order is total and two runs of the
    // same Core plan the same work.
    const first = paired.sort(
      (a, b) =>
        rank[a.binding.risk] - rank[b.binding.risk] || a.capability.localeCompare(b.capability),
    )[0]
    if (first === undefined) {
      refusals.push('no registered capability could be planned')
      return null
    }
    void mission
    return [
      {
        stepId: `${missionId}-s1`,
        capability: first.capability,
        // The capability's own declared pairing. Never chosen here.
        verifier: first.binding.verifier as string,
        dependsOn: [],
      },
    ]
  }
  /**
   * Ask the verifier whether the outcome was established.
   *
   * The only route from a decision to `completed`, and it goes through the engine's
   * `requestCompletion`, which enters `verifying` and runs a registered verifier. A
   * verifier can say no, and when it does the Mission returns to `active` — a failed
   * verification is not a failed Mission, because the outcome may be one step away.
   */
  private async requestCompletion(
    missionId: string,
    refusals: string[],
  ): Promise<MissionRecord['status']> {
    // **No pre-checks here.** An earlier version refused on expired evidence and on "no
    // evidence at all" before asking the verifier — duplicating the verifier's own rules
    // in a second place, which is how two answers to "is this established?" drift apart.
    //
    // The verifier is the single authority on that question, so it is asked every time,
    // and its verdict is recorded either way. The cost is one cheap deterministic call;
    // the benefit is that adding a rule to the verifier cannot be silently bypassed by a
    // caller that forgot to mirror it here.
    await this.options.missions.transition({ missionId, to: 'verifying', reason: MISSION_REASONS.verification_requested })
    const currentMission = this.options.missions.record(missionId)
    const requiredRunIds = currentMission?.activePlan
      ? currentMission.activePlan.steps.map((s) => s.runId).filter((id): id is string => typeof id === 'string' && id.length > 0)
      : undefined
    const outcome = await this.options.missions.requestCompletion(missionId, requiredRunIds && requiredRunIds.length > 0 ? { requiredRunIds } : {})
    if (outcome.ok) return 'completed'
    refusals.push(outcome.reason ?? 'verification did not establish the outcome')
    // Back to `active` rather than `failed`: the verification did not establish it, and
    // that is a statement about the evidence rather than about the goal.
    return this.to(missionId, 'active', 'verification_not_established', refusals)
  }

  /* -------------------------------------------------------------- corrections */

  /**
   * Apply an owner correction to a Mission.
   *
   * The critical acceptance case, and the branch that matters most is the one that
   * changes **nothing**:
   *
   * - **Unambiguous** → settle the incompatible steps, keep the compatible evidence,
   *   write the new intent to the encrypted store, journal the *field names* that moved,
   *   and let the next `step()` replan from what survived.
   * - **Ambiguous** → record the ambiguity, set `awaitingOwner`, raise an
   *   `intent_ambiguous` blocker, and **do not touch the intent, the steps or the
   *   evidence**. The Mission keeps running exactly as it was, and only the owner can
   *   change that.
   *
   * There is no third branch. In particular there is no "apply what I can and ask about
   * the rest", because that would half-change a goal the owner has not fully specified —
   * and a Mission half-changed is one that is confidently doing the wrong thing.
   */
  async correct(missionId: string, input: string | MissionCorrectionInput, correctionId?: string): Promise<CorrectionResult> {
    const mission = this.options.missions.record(missionId)
    const id = correctionId ?? this.newId()
    if (mission === undefined) {
      return rejected('no_active_mission', 'I could not find that mission.')
    }

    // The private intent, or null if the store cannot be read. A null here makes
    // `applyCorrection` return `ambiguous` rather than patching into a goal Freya cannot
    // currently see — which is the right direction: unable to read the goal must not mean
    // free to overwrite it.
    const intent = await this.options.missions.readIntent(missionId).catch(() => null)
    const outcome: CorrectionOutcome = applyCorrection(mission, intent, input, id)

    if (!outcome.ok) {
      // **Nothing but the question is recorded.** No field merged, no step settled, no
      // evidence discarded, no wake cleared.
      if (outcome.kind === 'rejected') {
        return rejected(outcome.ambiguity, outcome.question)
      }
      await this.options.missions.recordAmbiguity({ missionId, correctionId: id, ambiguity: outcome.ambiguity })
      await this.options.missions.setBlocker({ missionId, code: 'intent_ambiguous', stepId: null, raised: true })
      await this.options.missions.transition({ missionId, to: 'blocked', reason: MISSION_REASONS.intent_ambiguous })
      this.options.onChange?.()
      return {
        ok: false,
        kind: 'ambiguous',
        ambiguity: outcome.ambiguity,
        changedFields: Object.freeze([]),
        settledSteps: 0,
        preservedEvidence: 0,
        question: outcome.question,
        paused: false,
      }
    }

    const plan = outcome.plan
    // Settle the steps the new intent made wrong. Verified work and in-flight work are
    // never settled — `effectOf` has already decided which, and this only performs it.
    for (const stepId of outcome.effect.settledStepIds) {
      await this.options.missions.transitionStep({
        missionId,
        planId: mission.activePlan?.planId ?? '',
        stepId,
        to: 'cancelled',
        reason: MISSION_REASONS.intent_corrected,
      })
    }
    await this.options.missions.setBlocker({ missionId, code: 'intent_ambiguous', stepId: null, raised: false })

    // The new intent goes to the encrypted store, never to the journal. The journal
    // learns only *which fields* moved.
    await this.options.missions.writeIntent(missionId, plan.next)
    await this.options.missions.recordCorrection({
      missionId,
      correctionId: id,
      kind: 'patch',
      changedFields: plan.changedFields,
      settledSteps: outcome.effect.settledStepIds.length,
      preservedEvidence: outcome.effect.preservedEvidenceIds.length,
      replannedFrom: mission.activePlan?.planId ?? null,
      // Carried **only** when the correction changed the quantity, and read from the
      // *new* intent rather than the record. The record still holds the old number — that
      // is what this call exists to replace — so a correction that is not about the
      // quantity leaves the key off entirely, and the fold can tell "did not change it"
      // from "removed it".
      ...(plan.changedFields.includes('quantity')
        ? { requestedQuantity: plan.next.requestedQuantity }
        : {}),
    })

    // A quantity correction moves the journal's one goal number, so the board stops
    // reporting the old target immediately. It is a *narrowing or widening of the goal*,
    // not of the budget — and it is the only number about the goal a correction can
    // change, which is why it has its own method rather than riding on a budget event.
    if (plan.changedFields.includes('quantity')) {
      await this.options.missions
        .setRequestedQuantity({ missionId, requestedQuantity: plan.next.requestedQuantity })
        .catch(() => undefined)
    }

    if (outcome.pauseRequested) {
      await this.options.missions.transition({ missionId, to: 'stopped', reason: MISSION_REASONS.intent_paused })
    }
    this.options.onChange?.()

    return {
      ok: true,
      kind: 'patch',
      ambiguity: null,
      changedFields: plan.changedFields,
      settledSteps: outcome.effect.settledStepIds.length,
      preservedEvidence: outcome.effect.preservedEvidenceIds.length,
      question: null,
      paused: outcome.pauseRequested,
    }
  }

  /* ---------------------------------------------------------------- internals */

  /**
   * Apply recovery conclusions.
   *
   * Only `automatic` actions are applied here. A `mark_interrupted` on a consequential
   * step is recorded but **not acted on** — the distinction being that recording the
   * uncertainty is safe while deciding what to do about it is a person's job.
   */
  private async applyRecovery(mission: MissionRecord, actions: readonly RecoveryAction[]): Promise<void> {
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
          await this.options.missions.transition({ missionId: mission.missionId, to: 'failed', reason: 'deadline_expired' })
          break
        case 'mark_interrupted':
          // Recorded even when not acted on. The uncertainty becomes durable, which is
          // what stops a later restart from treating the step as merely unfinished.
          await this.options.missions.interruptStep({
            missionId: mission.missionId,
            planId: mission.activePlan?.planId ?? '',
            stepId: action.stepId ?? '',
            consequential: !action.automatic,
          })
          break
        case 'release_undelegated':
          await this.options.missions.setBlocker({ missionId: mission.missionId, code: 'step_failed', stepId: action.stepId, raised: false })
          break
        case 'retry_safe_running':
          await this.options.missions.setBlocker({ missionId: mission.missionId, code: 'step_failed', stepId: action.stepId, raised: false })
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

  private async scheduleWake(
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
    await this.options.missions.scheduleWake({
      missionId,
      wakeId: this.newId(),
      kind,
      source,
      dueAt: new Date(bound).toISOString(),
      eventType: kind === 'event' ? eventType : null,
    })
  }

  /**
   * Move a Mission, and report the status it actually reached.
   *
   * `reason` is a closed code because that is what the port accepts — which is what makes
   * "the journal holds no free text" a property of the type rather than of a check.
   *
   * A **refused** transition is not swallowed. A Mission in `verifying` cannot be moved to
   * `waiting` while a verification is in flight, and a caller that reported success would
   * be reporting a status the Mission is not in. So the refusal is pushed into `refusals`
   * and the *actual* current status is returned, which is what the caller's next decision
   * reads.
   */
  private async to(
    missionId: string,
    status: MissionRecord['status'],
    reason: MissionReason,
    refusals: string[],
  ): Promise<MissionRecord['status']> {
    const outcome = await this.options.missions.transition({ missionId, to: status, reason })
    if (isTerminalMissionStatus(status) && outcome.ok) return status
    if (!outcome.ok) {
      refusals.push(outcome.reason ?? `cannot move to ${status}`)
      return this.options.missions.record(missionId)?.status ?? status
    }
    return status
  }

  /**
   * Record the blocker a parked Mission's step actually represents.
   *
   * Only the reasons that name a **specific, actionable situation** are raised. Budget
   * exhaustion and an exhausted concurrency ceiling are deliberately *not* raised: they
   * are properties of the Mission's whole budget rather than of anything in its way, and
   * listing them as blockers would leave a board showing a Mission "blocked by its action
   * budget" — which is a true fact and a useless one, because there is nothing to clear.
   *
   * Skipped silently for any reason not in the table. Adding a reason to `MISSION_REASONS`
   * therefore parks a Mission without inventing a blocker for it, which is the correct
   * default: understating is better than inventing.
   */
  private async raiseBlockerFor(missionId: string, reason: MissionReason, stepId: string | null): Promise<void> {
    const code = BLOCKER_FOR_REASON[reason]
    if (code === undefined) return
    await this.options.missions.setBlocker({ missionId, code, stepId, raised: true })
  }

  private async noteBudget(missionId: string, dimension: string): Promise<void> {
    await this.options.missions.noteBudgetExceeded({ missionId, budget: dimension }).catch(() => undefined)
  }

  private stepById(mission: MissionRecord, stepId: string | null): MissionStepRecord | null {
    if (stepId === null) return null
    return (mission.activePlan?.steps ?? []).find((step) => step.stepId === stepId) ?? null
  }

  private remaining(mission: MissionRecord): {
    actions: number
    retries: number
    delegations: number
    planRevisions: number
  } {
    return {
      actions: Math.max(0, mission.budget.maxActions - mission.spend.actions),
      retries: Math.max(0, mission.budget.maxRetries - mission.spend.retries),
      delegations: Math.max(0, mission.budget.maxDelegations - mission.spend.delegations),
      planRevisions: Math.max(0, mission.budget.maxPlanRevisions - mission.planRevisions),
    }
  }

  private openDelegations(mission: MissionRecord): number {
    let open = 0
    for (const step of mission.activePlan?.steps ?? []) {
      if (step.status === 'delegated' || step.status === 'running') open += 1
    }
    return open
  }

  /**
   * How many *other* Missions are live.
   *
   * The swarm guard in `decide` holds back the last concurrency slot when this is
   * non-zero, so two Missions cannot each fill their roster and jointly hold eight open
   * delegations. Read live, and only ever used to make things *more* cautious.
   */
  /**
   * How long a Mission waits before it re-decides, bounded by its own deadline.
   *
   * Delegated to `decide`'s `defaultWaitMs` so there is **one** definition of how long a
   * wait lasts. Two would mean a Mission could be told to wait sixty seconds by one path
   * and thirty by another, and the shorter one would silently win.
   */
  private waitMs(mission: MissionRecord): number {
    return defaultWaitMs(mission, this.clock())
  }

  private siblings(_missionId: string): number {
    const total = this.options.liveMissionCount?.() ?? 0
    // `total - 1` rather than `total`: the caller is asking how many *other* Missions are
    // live, and counting itself would make a lone Mission look like it had a sibling and
    // hold back its last concurrency slot for no reason.
    return Math.max(0, total - 1)
  }

  private idle(missionId: string, reason: string): StepOutcome {
    return {
      missionId,
      decision: 'wait',
      reason,
      stepId: null,
      nextWakeAt: null,
      status: this.options.missions.record(missionId)?.status ?? 'draft',
      refusals: Object.freeze([reason]),
      quiescent: true,
    }
  }

  private park(
    missionId: string,
    mission: MissionRecord,
    reason: string,
    refusals: string[],
    detail: string,
  ): StepOutcome {
    refusals.push(detail)
    return {
      missionId,
      decision: 'wait',
      reason,
      stepId: null,
      nextWakeAt: mission.wake?.dueAt ?? null,
      status: mission.status,
      refusals: Object.freeze([...refusals]),
      quiescent: true,
    }
  }

  private clock(): Date {
    return this.options.now?.() ?? new Date()
  }

  private newId(): string {
    return this.options.newId?.() ?? randomUUID()
  }
}

/** What an owner correction produced. */
/**
 * What an owner correction produced.
 *
 * `ambiguity` is the closed code *and* `question` the private sentence, and they are both
 * present on the failure paths and absent on success. Only the code reaches the journal;
 * only the question reaches a person. Keeping them in one type is what makes it obvious
 * that a caller must handle both — a caller that read `question` alone would display the
 * private text without knowing it was unresolved, and one that read `ambiguity` alone
 * would know to ask without knowing what.
 */
export interface CorrectionResult {
  readonly ok: boolean
  readonly kind: 'patch' | 'ambiguous' | 'rejected'
  readonly ambiguity: MissionCorrectionAmbiguity | null
  readonly changedFields: readonly string[]
  readonly settledSteps: number
  readonly preservedEvidence: number
  /** The question to put to the owner, or null when none was needed. */
  readonly question: string | null
  readonly paused: boolean
}



/* ------------------------------------------------------------ applied result */

/**
 * What carrying out a decision actually did.
 *
 * `decision` and `reason` are present only when the applied result **corrects** the
 * decision `decide` reached — which happens when acting on `continue` discovers that a
 * person must decide first. Omitted otherwise, so `undefined` reads as "no correction"
 * rather than as "correction to undefined".
 *
 * The distinction between what was *decided* and what *happened* is recorded in both
 * places, deliberately: the journal keeps the decision (that is the honest record of the
 * reasoning) and the outcome carries the result (that is what a caller acts on). Merging
 * them would make one of the two a lie.
 */
export interface AppliedDecision {
  readonly status: MissionRecord['status']
  readonly decision?: MissionDecision
  readonly reason?: MissionReason
  /**
   * `null` and `undefined` are different, and both occur.
   *
   * A correction that is about a *specific* step names it. A correction that is about the
   * Mission as a whole — a blocker with no step behind it, a gate Freya cannot open at all —
   * says `stepId: null`, which is a fact. And `undefined` means "no correction", which is
   * why the field is optional rather than nullable: `null` has to stay distinguishable
   * from "not stated".
   */
  readonly stepId?: string | null
}

/** An applied result that changed nothing about the decision. */
function applied(status: MissionRecord['status']): AppliedDecision {
  return { status }
}

/**
 * An applied result that learned something new — an approval gate, discovered by trying.
 *
 * The correction is explicit rather than inferred, so a reader can see exactly why the
 * reported decision differs from the journalled one.
 */
function asApproval(status: MissionRecord['status'], stepId: string): AppliedDecision {
  return { status, decision: 'request_approval', reason: 'approval_pending', stepId }
}

/**
 * An applied result that left the Mission **parked** rather than working.
 *
 * `decide` said `continue`; trying revealed that nothing could proceed — no capable
 * worker, a refused budget, a capability Freya may not use. The honest report is `wait`,
 * and it is also what makes the caller schedule a bounded next wake.
 *
 * That second part is the reason this exists rather than reporting `continue` and leaving
 * the status to speak for itself. A parked Mission with **no** scheduled wake is a Mission
 * that is never looked at again: nothing is due, nothing is running, and no event is
 * expected. So the reported decision and the wake scheduling have to agree, and both are
 * derived from this one value.
 */
function asParked(status: MissionRecord['status'], reason: MissionReason, stepId: string | null): AppliedDecision {
  return { status, decision: 'wait', reason, stepId }
}

/** A refused correction, with every field a caller must handle explicitly set. */
function rejected(ambiguity: MissionCorrectionAmbiguity, question: string): CorrectionResult {
  return {
    ok: false,
    kind: 'rejected',
    ambiguity,
    changedFields: Object.freeze([]),
    settledSteps: 0,
    preservedEvidence: 0,
    question,
    paused: false,
  }
}

/** Re-exported so a caller wiring a step does not need three imports. */
export type { MissionBudget, MissionCapabilityPort, MissionEngine, DecisionTrigger }
export { assertWakeBounded, isSafeToContinue, later }