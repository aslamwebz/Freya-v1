import { randomUUID } from 'node:crypto'
import type { EventFabric } from '../events/fabric'
import type { PrincipalId } from '../../shared/contracts/identity'
import type { RunStatus } from '../work/types'
import { isMissionPriority, missionBudget } from './autonomy/types'
import { chargeBudget } from './autonomy/authority'
import type {
  MissionBudget,
  MissionDecision,
  MissionIntentShape,
  MissionPriority,
  MissionStepRecord,
} from './autonomy/types'
import { countChildren, liveChildCount, missionProjection, summarise, type WorkTruthPort } from './projection'
import { buildMissionVerificationContext } from './verification-context'
import { reduceMissionState, initialMissionState } from './state'
import type { MissionStore } from './store'
import type { MissionExecutionPlan } from '../mind/mission-planning'
import type { ChatMissionBinding } from './chat-types'
import { MissionVerifierRegistry } from './verifier'
import {
  DEFAULT_MISSION_LIMITS,
  MAX_REQUESTED_QUANTITY,
  MISSION_REASONS,
  canTransitionMission,
  isLiveMissionStatus,
  isTerminalMissionStatus,
  missionLimits,
  normaliseMissionContent,
  normaliseStoredIntentShape,
  type MissionCommandOutcome,
  type MissionContent,
  type MissionContentInput,
  type MissionDetail,
  type MissionLimits,
  type MissionProjection,
  type MissionReason,
  type MissionRecord,
  type MissionState,
  type MissionStatus,
  type MissionVerificationContext,
  type MissionVerifier,
} from './types'

/**
 * THE MISSION ENGINE.
 *
 * Holds a Mission aggregate: an outcome, the Runs attempted toward it, and the
 * rules for when it may start another Run and when it may be declared achieved.
 *
 * It does **not** own execution. A Run, a Step, an Action, an Observation and a
 * Verification belong to Work, and this engine reaches them only through the two
 * narrow ports below. That is what stops the two aggregates collapsing into each
 * other, and it is why Phase 7 needed no changes to the Work engine's machinery.
 *
 * ## Serialisation, not luck
 *
 * Every state-changing operation on a given Mission runs inside a per-Mission
 * queue, and the terminal-transition check happens **inside** that queue rather
 * than before it. So a cancel racing a completion verifier cannot interleave: one
 * of them observes a terminal status and refuses. Nothing here depends on which
 * call happens to start first.
 *
 * ## Zero idle inference
 *
 * Nothing in this file contacts a provider. Completion asks a verifier, and the one
 * verifier Phase 7 ships is deterministic. A Mission that is created, activated,
 * paused, resumed, cancelled or merely listed costs nothing, and an idle Freya
 * spends nothing.
 */

/** What the engine needs from Work, and nothing more. */
export interface WorkPort extends WorkTruthPort {
  /** Pause a child Run. Resolves to whether the Run actually paused. */
  pauseRun(runId: string, reason: string): Promise<boolean>
  /** Cancel a child Run. Resolves to whether the Run was running and is now cancelled. */
  cancelRun(runId: string, reason: string): Promise<boolean>
}

export interface MissionEngineOptions {
  fabric: EventFabric
  store: MissionStore
  work: WorkPort
  verifiers?: MissionVerifierRegistry
  /**
   * The principal that owns Missions.
   *
   * Baked in by Core and never taken from a command payload, for the same reason
   * `cognition.grant.created` records the owner regardless of what the payload
   * claims: a caller must not be able to say who they are.
   */
  principalId: PrincipalId
  now?: () => Date
  newId?: () => string
  onChange?: () => void
  /** Live facts read at the moment of each decision, never copied into state. */
  stopAll?: () => boolean
}

/** How long shutdown waits for an in-flight verification to settle. */
const CLOSE_DRAIN_MS = 1_000

export class MissionEngine {
  private state: MissionState = initialMissionState()
  private readonly locks = new Map<string, Promise<unknown>>()
  /** Missions with a verification in flight. Guards duplicate requests. */
  private readonly verifying = new Set<string>()
  private readonly inflight = new Set<Promise<unknown>>()
  private closed = false

  constructor(private readonly options: MissionEngineOptions) {}

  /* -------------------------------------------------------------- lifecycle */

  async open(): Promise<void> {
    this.state = await this.options.fabric.replay(initialMissionState(), (draft, event) =>
      reduceMissionState(draft, event),
    )
    // Live appends fold through the *same* reducer as replay, so the state a window
    // sees cannot drift from the state a restart would rebuild. Without this the
    // engine would hold an empty Mission state after writing its first event, which
    // is the bug this line exists to prevent.
    this.dispose = this.options.fabric.subscribe((event) => {
      this.state = reduceMissionState(this.state, event)
    })
    await this.reconcileAfterRecovery()
  }

  private dispose: () => void = () => {}

  /**
   * Reconcile what a restart should have changed and what it must not.
   *
   * - **Expired Missions are settled.** The lifetime is a wall, not a check between
   *   operations, so an expired Mission is discovered here rather than watched.
   * - **Nothing is resumed.** A `mission.verification.requested` in the journal
   *   does not mean verification is running: a crash mid-verification leaves a
   *   Mission non-completed, which is the honest outcome.
   * - **A `verification.requested` record is left as `requested`.** Resolving it as
   *   `timeout` on the next start would be honest; resolving it as `passed` would be
   *   a fabricated outcome, and that is the one thing this file will not do.
   *
   * This is asynchronous because it writes events, but it is awaited from `open`,
   * so a Mission's expiry is visible before any projection is served.
   */
  private async reconcileAfterRecovery(): Promise<void> {
    const now = this.options.now?.() ?? new Date()
    const expired = [...this.state.missions.values()].filter(
      (mission) =>
        !isTerminalMissionStatus(mission.status) &&
        Date.parse(now.toISOString()) >= Date.parse(mission.deadlineAt),
    )
    // Serialised like any other transition, so a reconcile cannot race a command that
    // arrived between `open` and this loop. Awaited rather than fired and forgotten:
    // a caller that saw "started" must not then be told about an expired Mission as
    // though it were still live.
    await Promise.all(
      expired.map((mission) => this.settle(mission.missionId, 'failed', MISSION_REASONS.deadline_expired)),
    )
  }

  async close(): Promise<void> {
    this.closed = true
    this.dispose()
    await Promise.race([
      Promise.allSettled([...this.inflight]),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CLOSE_DRAIN_MS)
        timer.unref?.()
      }),
    ])
  }

  /* ---------------------------------------------------------------- commands */

  /**
   * Create a Mission.
   *
   * The private content is written first, because a Mission without its content is
   * an empty box: the journal would hold an id and nothing anybody could act on. If
   * the journal write then fails, the content is removed again rather than leaving
   * an orphan behind that no Mission points at.
   */
  async create(
    input: MissionContentInput,
    limits?: Partial<MissionLimits>,
    options: {
      /** Phase 47 autonomy ceilings. Narrowed only; a raise is refused. */
      readonly budget?: Partial<MissionBudget>
      readonly priority?: MissionPriority
      /** How many results the owner asked for. Null when they named no number. */
      readonly requestedQuantity?: number | null
      readonly chatBinding?: ChatMissionBinding
    } = {},
  ): Promise<MissionCommandOutcome> {
    if (this.closed) return refused('created', 'missions are shutting down')
    const content = normaliseMissionContent(input)
    if (!content.ok) return refused('created', content.reason)

    let resolved: MissionLimits
    try {
      resolved = missionLimits(limits)
    } catch (error) {
      return refused('created', error instanceof Error ? error.message : 'the requested limits are malformed')
    }

    // The autonomy ceilings. Narrowed here with exactly the same four refusals
    // `missionLimits` makes — unknown key, non-integer, non-positive, above the
    // code-owned ceiling — and for the same reason: a clamp would silently accept a
    // caller trying to raise a limit.
    let budget: MissionBudget
    try {
      budget = missionBudget(options.budget)
    } catch (error) {
      return refused('created', error instanceof Error ? error.message : 'the requested budget is malformed')
    }

    // An unrecognised priority reads as `routine`, the *lowest* level. Reading it as
    // anything else would mean a typo could escalate a Mission's standing.
    const priority = isMissionPriority(options.priority) ? options.priority : 'routine'

    // Null when the owner named no number, which is a different thing from naming zero
    // — and zero is not a request, it is an absence, so it is refused.
    const requestedQuantity =
      options.requestedQuantity === undefined || options.requestedQuantity === null
        ? null
        : typeof options.requestedQuantity === 'number' &&
            Number.isInteger(options.requestedQuantity) &&
            options.requestedQuantity > 0 &&
            options.requestedQuantity <= MAX_REQUESTED_QUANTITY
          ? options.requestedQuantity
          : null

    const missionId = this.options.newId?.() ?? randomUUID()
    const now = (this.options.now?.() ?? new Date()).toISOString()
    const deadlineAt = new Date(Date.parse(now) + resolved.lifetimeMs).toISOString()

    try {
      await this.options.store.write({
        missionId,
        title: content.value.title,
        intent: content.value.intent,
        intentShape: content.value.intentShape,
        successCriteria: content.value.successCriteria,
        createdAt: now,
        ...(options.chatBinding ? { chatBinding: options.chatBinding } : {}),
      })
    } catch (error) {
      return refused('created', `Mission content could not be stored: ${describe(error)}`)
    }

    try {
      // Metadata only. The title and intent are deliberately absent here and the
      // validator rejects them if a future change tried to add them.
      //
      // `budget`, `priority` and `requestedQuantity` are Phase 47's additions and the
      // only numbers about the goal itself. They are counts and bounds, not content:
      // progress has to be computable, and refusing to store them would force the
      // projection to invent a percentage instead.
      await this.emit('mission.created', {
        missionId,
        status: 'draft',
        createdAt: now,
        deadlineAt,
        limits: resolved,
        budget,
        priority,
        requestedQuantity,
      })
    } catch (error) {
      await this.options.store.remove(missionId).catch(() => false)
      return refused('created', `the Mission could not be recorded: ${describe(error)}`)
    }

    this.options.onChange?.()
    return { operation: 'created', ok: true, missionId, status: 'draft' }
  }

  /**
   * Start a Mission: `draft → active`.
   *
   * Unchanged from Phase 7, deliberately. An owner pressing "activate" means "begin", and
   * a Mission that answered by landing in `ready` — a state with no way forward except
   * through the autonomy loop — would be a button that appears to do nothing on a machine
   * where the loop is not running.
   *
   * `ready` therefore exists for the *autonomous* path: a Mission whose goal has been
   * understood but not yet planned sits there, and `decide` moves it on. Both edges are
   * in the table, and an owner may reach `ready` too, but the default meaning of
   * "activate" stays "run it".
   */
  async update(missionId: string, input: MissionContentInput): Promise<MissionCommandOutcome> {
    if (this.closed) return refused('updated', 'missions are shutting down')
    return this.serialise(missionId, async () => {
      const record = this.state.missions.get(missionId)
      if (!record) return refused('updated', 'no such mission', missionId)
      if (record.status !== 'draft') return refused('updated', 'only a draft Mission can be edited', missionId)
      const normalised = normaliseMissionContent(input)
      if (!normalised.ok) return refused('updated', normalised.reason, missionId)
      const old = await this.options.store.read(missionId)
      if (!old.ok) return refused('updated', old.reason, missionId)
      try {
        await this.options.store.write({ ...old.value, ...normalised.value })
        try { await this.emit('mission.content.updated', { missionId }) }
        catch (error) { await this.options.store.write(old.value); throw error }
      } catch (error) { return refused('updated', describe(error), missionId) }
      this.options.onChange?.()
      return { operation: 'updated', ok: true, missionId, status: 'draft' }
    })
  }

  async delete(missionId: string): Promise<MissionCommandOutcome> {
    if (this.closed) return refused('deleted', 'missions are shutting down')
    return this.serialise(missionId, async () => {
      const record = this.state.missions.get(missionId)
      if (!record) return refused('deleted', 'no such mission', missionId)
      if (record.status !== 'draft' && !isTerminalMissionStatus(record.status)) {
        return refused('deleted', 'cancel or finish the Mission before deleting it', missionId)
      }
      const old = await this.options.store.read(missionId)
      try {
        await this.options.store.remove(missionId)
        try { await this.emit('mission.deleted', { missionId }) }
        catch (error) { if (old.ok) await this.options.store.write(old.value); throw error }
      } catch (error) { return refused('deleted', describe(error), missionId) }
      this.options.onChange?.()
      return { operation: 'deleted', ok: true, missionId }
    })
  }

  async activate(missionId: string): Promise<MissionCommandOutcome> {
    return this.transition(missionId, 'draft', 'active', 'activated')
  }

  /**
   * Mark a Mission's goal as understood: `draft → ready`.
   *
   * The first half of the autonomous handshake, and the state a plan is built from.
   * Separate from {@link activate} because the two answer different questions — "is this
   * understood?" and "shall it run?" — and a caller that had to guess which one it was
   * getting would eventually press the wrong button.
   */
  async markGoalReady(missionId: string): Promise<MissionCommandOutcome> {
    return this.transition(missionId, 'draft', 'ready', 'activated')
  }

  /**
   * `stopped → active`.
   *
   * Phase 7's meaning, unchanged: the owner pressed resume, so the Mission runs. An
   * earlier version of this phase landed on `ready` instead, which was more expressive and
   * less true — "carry on" that leaves a Mission waiting for somebody else to start it is
   * not carrying on.
   *
   * `stopped → ready` remains in the table for the autonomous path, where "the owner has
   * reopened the gate" and "the Mission is now running" are genuinely two different facts.
   * The distinction is who asked: a window's Resume button means the first and the second;
   * autonomy, after a wake, means the first.
   *
   * The autonomous counterpart is {@link resumeToReady}, which is deliberately not this
   * method: one says "run it" and the other says "the gate is open again".
   *
   * It is still a narrow door. It only works from `stopped`, so a `blocked` or
   * `approval-required` Mission cannot be waved through by a resume — those need their own
   * resolution, because "carry on regardless" is exactly what those states prevent.
   */
  async resume(missionId: string): Promise<MissionCommandOutcome> {
    return this.transition(missionId, 'stopped', 'active', 'resumed')
  }

  /**
   * `stopped → ready`: the owner reopened the gate without starting the work.
   *
   * The autonomous resume. Separate from {@link resume} because "I am no longer stopped" and
   * "run it" are different answers to different questions, and a caller that had to guess
   * which one it was asking for would eventually press the wrong button.
   *
   * Autonomy uses this one. After a wake it knows the gate is open; it does **not** know
   * that a plan exists, never mind that one is running, so `ready` — understood, not yet
   * running — is the only state it can honestly report.
   */
  async resumeToReady(missionId: string): Promise<MissionCommandOutcome> {
    return this.transition(missionId, 'stopped', 'ready', 'resumed')
  }

  /**
   * Stop a Mission and propagate to its live children.
   *
   * The Mission settles as `stopped` first, then the propagation happens. That order
   * is deliberate: once the Mission is stopped, admission of a new child Run refuses,
   * so a Run that arrives mid-stop cannot slip in behind the propagation and then
   * be missed by it.
   *
   * A child that could not be stopped is reported rather than hidden. Fabricating a
   * clean stop while a Run kept going would be the single most misleading thing
   * this engine could do.
   *
   * Accepted from every live status, because STOP ALL and an owner pressing the button
   * must be able to stop a Mission wherever it happens to be — including mid-verification
   * and mid-approval, which is precisely when someone is most likely to reach for it.
   */
  async pause(missionId: string): Promise<MissionCommandOutcome> {
    // `transitioned` rather than `paused` as the internal operation: this method is
    // "stop the Mission", and the journal event it writes is named by `eventTypeFor`
    // from the actual edge. The reported operation stays `paused` so a window's
    // optimistic update still matches the Phase 7 contract.
    const settled = await this.transition(missionId, null, 'stopped', 'transitioned')
    if (!settled.ok) return settled

    const blocked = await this.propagate(missionId, 'pause')
    this.options.onChange?.()
    return blocked.length === 0
      ? { operation: 'paused', ok: true, missionId, status: 'stopped' }
      : {
          operation: 'paused',
          ok: true,
          missionId,
          status: 'stopped',
          reason: `${blocked.length} child Run(s) could not be paused: ${blocked.join(', ')}`,
        }
  }

  /**
   * Cancel a Mission.
   *
   * Settles first, then cancels children, then reports. Settling first is what makes
   * cancellation race-safe: once the Mission is terminal, a late verifier result and
   * a late Run completion are both discarded rather than applied.
   */
  async cancel(missionId: string): Promise<MissionCommandOutcome> {
    const settled = await this.transition(missionId, null, 'cancelled', 'cancelled')
    if (!settled.ok) return settled

    const blocked = await this.propagate(missionId, 'cancel')
    this.options.onChange?.()
    return blocked.length === 0
      ? { operation: 'cancelled', ok: true, missionId, status: 'cancelled' }
      : {
          operation: 'cancelled',
          ok: true,
          missionId,
          status: 'cancelled',
          reason: `${blocked.length} child Run(s) could not be cancelled: ${blocked.join(', ')}`,
        }
  }

  /**
   * Conclude a Mission as unable to continue.
   *
   * This is a person concluding a Mission. It is explicitly **not** what happens when
   * a child Run fails: a failed attempt is not a failed outcome, and Freya making
   * that inference would end a Mission on the first bad day.
   */
  async fail(missionId: string): Promise<MissionCommandOutcome> {
    return this.transition(missionId, null, 'failed', 'settled-failed')
  }

  /**
   * An autonomy transition, from the runtime.
   *
   * The same `transition` as every other command, and therefore the same table and the
   * same refusals — which is the point. The autonomy runtime has no privileged way to
   * move a Mission: it proposes a `to`, the transition table decides, and an illegal edge
   * is refused here exactly as it would be for a renderer.
   *
   * Separate from `fail` and `cancel` only in that it is not an owner action. There is
   * deliberately **no** reason parameter a caller can free-form: `reason` must be a code
   * in `MISSION_REASONS`, which the event validator checks, so a Mission's journal cannot
   * acquire free text through the autonomy path either.
   */
  async autonomyTransition(input: {
    missionId: string
    to: MissionStatus
    reason: MissionReason
  }): Promise<MissionCommandOutcome> {
    return this.transition(input.missionId, null, input.to, 'transitioned', input.reason)
  }

  /**
   * Request completion.
   *
   * This is not a status setter. It asks a verifier whether the outcome was
   * established, and completes the Mission **only if the verifier says so**. A Run
   * completing, a capability returning success, a model saying "done", and this
   * command returning `ok: true` are four different facts.
   */
  async requestCompletion(
    missionId: string,
    options: { verifierId?: string; requiredRunIds?: readonly string[] } = {},
  ): Promise<MissionCommandOutcome> {
    // Admission, under the Mission's own lock.
    //
    // Everything that decides *whether* to verify happens here: status, the
    // single-verification claim, and the `requested` event. Deciding outside the lock
    // is what would let a cancel slip between the check and the request, and would
    // let two callers verify the same Mission at once.
    const admission = await this.serialise(missionId, async (): Promise<
      | { kind: 'refused'; outcome: MissionCommandOutcome }
      | { kind: 'admitted'; verifierId: string; verifier: MissionVerifier; context: MissionVerificationContext; deadlineMs: number }
    > => {
      const mission = this.state.missions.get(missionId)
      if (mission === undefined) {
        return { kind: 'refused', outcome: refused('verification-not-established', 'no such mission') }
      }
      if (this.closed) {
        return { kind: 'refused', outcome: refused('verification-not-established', 'missions are shutting down') }
      }
      // Completion is reached from `verifying` and nowhere else.
      //
      // The state exists so that "we are checking" and "it is done" are two facts rather
      // than one. A Mission that could go straight from live to completed would have a
      // window — however small — in which its status said `completed` while nothing had
      // been established, and that window is where a fabricated outcome would live.
      //
      // A live Mission is therefore *admitted* here and moved into `verifying` before the
      // verifier runs, rather than refused for not being there already. The transition
      // goes through the same table and the same refusals as every other command, so
      // admitting it is not a shortcut — it is the honest first half of a completion.
      if (!isLiveMissionStatus(mission.status) && mission.status !== 'verifying') {
        return {
          kind: 'refused',
          outcome: refused(
            'verification-not-established',
            isTerminalMissionStatus(mission.status)
              ? 'that Mission has already settled'
              : `a Mission cannot be completed from ${mission.status}`,
            missionId,
          ),
        }
      }
      // One verification in flight per Mission. A second request while the first is
      // running would emit a second `requested` event for one question and run the
      // verifier twice for one answer.
      if (this.verifying.has(missionId)) {
        return {
          kind: 'refused',
          outcome: refused('verification-in-progress', 'this Mission is already being verified', missionId),
        }
      }

      const verifierId = options.verifierId ?? this.defaultVerifierId()
      const verifier = this.options.verifiers?.get(verifierId) ?? new MissionVerifierRegistry().get(verifierId)
      if (verifier === undefined) {
        return { kind: 'refused', outcome: refused('verification-not-established', 'no such Mission verifier', missionId) }
      }

// Required Runs default to every child attached so far: the Mission's own
      // history is what this completion request is about.
      //
      // Phase 47: this is no longer the gate on whether a Mission may complete. A
      // Mission can establish an outcome with no child Runs at all — "find 100 cat
      // videos" is established by observed evidence, not by a Run having completed — so
      // an empty default list is deliberately *not* refused here. What a Mission with no
      // Runs and no evidence means is decided by the verifier, which can see the
      // evidence counts this engine cannot judge on its own.
      //
      // A caller that explicitly named required Runs has asserted those Runs matter, so
      // an empty *named* list is still refused: that is a contradiction in the request
      // rather than an absence of work.
      const named = options.requiredRunIds
      const required = [...(named ?? mission.childRuns)]
      if (named !== undefined && named.length === 0) {
        return {
          kind: 'refused',
          outcome: refused('verification-not-established', 'no required Work was named for this request', missionId),
        }
      }
      // Into `verifying`, before anything else is written.
      //
      // Inside this Mission's queue and *before* the request, so the status says
      // "checking" strictly earlier than the journal records that a check was asked for.
      // There is therefore no instant at which a Mission is `verifying` without a request
      // behind it, and none at which a request exists without the status having been
      // honest about it.
      if (mission.status !== 'verifying') {
        await this.emit('mission.transitioned', {
          missionId,
          from: mission.status,
          to: 'verifying',
          reason: MISSION_REASONS.verification_requested,
          verifierId: null,
        })
      }

      // The claim and the write that could fail are the reason this needs a `catch`
      // rather than just a comment: taking the claim and *then* having the journal
      // throw would otherwise strand the Mission for the life of the process, because
      // the release is further down and never reached. Measured before this: one
      // simulated disk failure, and every later request refused with
      // `verification-in-progress` for good.
      this.verifying.add(missionId)
      try {
        await this.emit('mission.verification.requested', { missionId, verifierId, runIds: required })
      } catch (error) {
        this.verifying.delete(missionId)
        throw error
      }

      return {
        kind: 'admitted',
        verifierId,
        verifier,
        context: this.verificationContext(missionId, mission, required),
        deadlineMs: mission.limits.verificationDeadlineMs,
      }
    })

    if (admission.kind === 'refused') return admission.outcome

    const { verifierId, verifier, context, deadlineMs } = admission
    const controller = new AbortController()

    // The verifier runs outside the lock on purpose: a Mission's other commands must
    // stay responsive while verification waits, or a cancel could not interrupt it.
    let outcome: Awaited<ReturnType<MissionEngine['runVerifier']>>
    try {
      outcome = await this.runVerifier(verifier, context, controller, deadlineMs)
    } finally {
      this.verifying.delete(missionId)
    }

    // Re-read the Mission *after* awaiting the verifier. A cancel that landed while
    // verification was in flight has already settled the Mission, and a late `passed`
    // must not resurrect it.
    return this.serialise(missionId, async () => {
      const current = this.state.missions.get(missionId)
      if (current === undefined) {
        return refused('verification-not-established', 'no such mission')
      }
      // Re-read *and* re-check after awaiting the verifier. A stop or cancel that landed while
      // verification was in flight has already moved the Mission, and a late `passed` must
      // not resurrect it.
      //
      // Still `verifying`, and that is the property: nothing but this code path moves a
      // Mission out of it, so a `passed` cannot arrive after something else decided the
      // Mission's fate.
      if (current.status !== 'verifying') {
        return refused(
          'verification-not-established',
          `this Mission is ${current.status} and its verification result was discarded`,
          missionId,
        )
      }

      await this.emit('mission.verification.completed', {
        missionId,
        verifierId,
        outcome:
          outcome.kind === 'passed'
            ? 'passed'
            : outcome.kind === 'timeout'
              ? 'timeout'
              : outcome.kind === 'cancelled'
                ? 'cancelled'
                : 'not_established',
        reason: outcome.reason,
      })

      if (outcome.kind !== 'passed') {
        // Back to `active` on a verdict, and **stay** in `verifying` on a timeout or a
        // cancellation.
        //
        // The distinction is about what kind of answer arrived. "The verifier said no" is
        // an answer, and a Mission that got one is live again — it may try a different
        // approach. "The verifier never answered" is not an answer, so the Mission stays
        // exactly where it was: still checking, still owning an open question. Leaving a
        // timed-out Mission in `active` would say "we finished looking", which is not what
        // happened.
        const resting = outcome.kind === 'timeout' || outcome.kind === 'cancelled' ? 'verifying' : 'active'
        if (current.status !== resting) {
          await this.emit('mission.transitioned', {
            missionId,
            from: current.status,
            to: resting,
            reason: outcome.reason,
            verifierId,
          })
        }
        this.options.onChange?.()
        return {
          operation: outcome.kind === 'timeout' ? 'verification-timeout' : 'verification-not-established',
          ok: false,
          missionId,
          status: resting,
          reason: outcome.reason,
        }
      }

      // `from` is `verifying`, and the transition table has no other edge into
      // `completed` — so this line is the only way a Mission ever completes, and the
      // reducer refuses it independently unless a passed verification is already
      // recorded under this same verifier id.
      await this.emit('mission.completed', {
        missionId,
        from: 'verifying',
        to: 'completed',
        reason: MISSION_REASONS.verification_passed,
        verifierId,
      })
      this.options.onChange?.()
      return { operation: 'verification-passed', ok: true, missionId, status: 'completed' }
    })
  }

  /**
   * Whether a Mission with this id exists.
   *
   * Lets Core give a window an exact "no such Mission" refusal *cheaply*, before
   * building a Run at all. It is not the admission decision — whether a
   * mission-parented Run may durably exist is settled by
   * {@link attachChildRunWhileCreating} inside the per-Mission queue — so this
   * says nothing about status, ceilings or deadlines, and must never be used as
   * permission by itself.
   */
  exists(missionId: string): boolean {
    return this.state.missions.has(missionId)
  }

  /**
   * Attach a child Run.
   *
   * The only door to an *already created* Run, and it enforces admission before
   * anything happens: the Mission must exist, must be `active`, must not have
   * expired, and must be under both ceilings. Once pause wins admission, a child
   * Run arriving later cannot start under stale state, because the status is
   * re-read inside the per-Mission queue rather than before it.
   */
  async attachChildRun(
    missionId: string,
    runId: string,
    taskId: string | null = null,
  ): Promise<MissionCommandOutcome> {
    if (this.closed) return refused('run-attached', 'missions are shutting down')
    if (typeof runId !== 'string' || runId.length === 0) {
      return refused('run-attached', 'a run id is required', missionId)
    }

    return this.serialise(missionId, async () => {
      const mission = this.state.missions.get(missionId)
      if (mission === undefined) return refused('run-attached', 'no such mission')
      // Live statuses, not `active` specifically. A `planning` or `ready` Mission may attach
      // Work, because attaching is how a plan gets executed at all; what it may **not**
      // do is attach while parked, which is the entire reason `waiting`, `blocked`,
      // `approval-required` and `stopped` exist as distinct states.
      if (!isLiveMissionStatus(mission.status)) {
        return refused(
          'run-attached',
          `only a live Mission may attach Work; this one is ${mission.status}`,
          missionId,
        )
      }
      if (mission.childRuns.includes(runId)) {
        // Idempotent. Re-attaching would double the child count and could make a
        // Mission look like it had hit a ceiling it had not.
        return { operation: 'run-attached', ok: true, missionId, runId }
      }
      const refusal = await this.admissionRefusal(missionId, mission)
      if (refusal !== null) return refusal
      await this.emit('mission.run.attached', { missionId, runId, taskId })
      this.options.onChange?.()
      return { operation: 'run-attached', ok: true, missionId, runId }
    })
  }

  /**
   * Attach a child Run that is created *as part of* the admission decision.
   *
   * This is the door Core's `work.run.create` takes when a renderer names a
   * missionId. `create` is Work's own run creation, handed over as a callback so
   * the Mission engine — the one authority on admission — decides *whether* a
   * mission-parented Run may be durably written at all, while Work still owns
   * how Runs are made.
   *
   * The whole sequence is admission check → `work.run.created` →
   * `mission.run.attached`, and it all runs inside this one Mission's queue.
   * Nothing that refuses attachment — a pause, a cancel, a deadline settlement,
   * another attach filling the last ceiling slot — can interleave, because every
   * one of those joins the same queue. A refusal therefore happens strictly
   * before `create` is ever called, and the journal never records a
   * mission-parented Work Run without a `mission.run.attached` beside it. The
   * reverse arrangement — create first, attach after — is exactly the defect
   * this replaces: a `work.run.created` with a parent the Mission could not
   * corroborate, and no event to say otherwise.
   */
  async attachChildRunWhileCreating(
    missionId: string,
    create: () => Promise<string>,
    taskId: string | null = null,
  ): Promise<MissionCommandOutcome> {
    if (this.closed) return refused('run-attached', 'missions are shutting down')
    return this.serialise(missionId, async () => {
      const mission = this.state.missions.get(missionId)
      if (mission === undefined) return refused('run-attached', 'no such mission')
      if (!isLiveMissionStatus(mission.status)) {
        return refused(
          'run-attached',
          `only a live Mission may attach Work; this one is ${mission.status}`,
          missionId,
        )
      }
      // The Run does not exist yet, so none of these readings can be made stale
      // by its creation: the queue is held across `work.run.created`, and count
      // ceilings are read against the children that are already there. `create`
      // resolving to a run id means Work accepted the plan *and* recorded the
      // parent — the corroboration below is emitted immediately, without the
      // queue ever being released between the two writes.
      const refusal = await this.admissionRefusal(missionId, mission)
      if (refusal !== null) return refusal
      const runId = await create()
      await this.emit('mission.run.attached', { missionId, runId, taskId })
      this.options.onChange?.()
      return { operation: 'run-attached', ok: true, missionId, runId }
    })
  }

  /**
   * The house rules for one more child Run, decided inside the queue.
   *
   * Shared by {@link attachChildRun} and {@link attachChildRunWhileCreating} so
   * there is exactly one copy of the ceilings. Resolves to null when the Mission
   * may take another child, and to the refusal — having already emitted the
   * matching `mission.limit.exceeded` — when it may not.
   */
  private async admissionRefusal(
    missionId: string,
    mission: MissionRecord,
  ): Promise<MissionCommandOutcome | null> {
    const now = this.options.now?.() ?? new Date()
    if (Date.parse(now.toISOString()) >= Date.parse(mission.deadlineAt)) {
      await this.emit('mission.limit.exceeded', { missionId, limit: 'lifetimeMs' })
      return refused('run-attached', 'this Mission has passed its deadline', missionId)
    }
    if (mission.childRuns.length >= mission.limits.maxChildRuns) {
      await this.emit('mission.limit.exceeded', { missionId, limit: 'maxChildRuns' })
      this.options.onChange?.()
      return refused('run-attached', 'this Mission has reached its child Run ceiling', missionId)
    }
    if (liveChildCount(mission, this.options.work) >= mission.limits.maxConcurrentChildRuns) {
      await this.emit('mission.limit.exceeded', { missionId, limit: 'maxConcurrentChildRuns' })
      this.options.onChange?.()
      return refused(
        'run-attached',
        'this Mission has reached its concurrent child Run ceiling',
        missionId,
      )
    }
    if (this.options.stopAll?.() === true) {
      return refused('run-attached', 'Freya is stopped', missionId)
    }
    return null
  }

  /* ------------------------------------------------------------- projection */

  projection(): MissionProjection {
    return missionProjection(
      this.state,
      this.options.work,
      {
        mode: this.options.store.mode === 'encrypted' ? 'encrypted' : this.closed ? 'unavailable' : 'ephemeral',
        reason: this.options.store.faultReason,
      },
      this.options.now?.() ?? new Date(),
    )
  }

  /**
   * One Mission with its private content.
   *
   * Content is read on demand and never included in the listing: a listing is
   * something a person scans, and making it carry every Mission's intent would put
   * the private text in the one place a window holds by default.
   */
  async detail(missionId: string): Promise<MissionDetail | null> {
    const mission = this.state.missions.get(missionId)
    if (mission === undefined) return null
    const summary = summarise(mission, this.options.work, this.options.now?.() ?? new Date())
    const read = await this.options.store.read(missionId)
    return {
      ...summary,
      content: read.ok ? read.value : null,
      contentReason: read.ok ? null : read.reason,
    }
  }

  /** The Durable record, for recovery and tests. Never content. */
  snapshot(): MissionState {
    return this.state
  }

  limits(): MissionLimits {
    return DEFAULT_MISSION_LIMITS
  }

  /* ------------------------------------------ Phase 47: the autonomy writer */

  /**
   * Read one Mission's durable record.
   *
   * The whole of what the autonomy runtime needs to read. It is `readonly` by
   * construction — a `MissionRecord` has no method and every field is frozen — so a
   * caller cannot mutate Mission state by holding a reference to it, which is what makes
   * it safe to hand one out at all.
   */
  record(missionId: string): MissionRecord | undefined {
    return this.state.missions.get(missionId)
  }

  async privateContent(missionId: string, requireDurable = false): Promise<MissionContent | null> {
    if (requireDurable && !this.options.store.durable) return null
    const read = await this.options.store.read(missionId).catch(() => null)
    return read?.ok ? read.value : null
  }

  async updateChatContent(missionId: string, update: (content: MissionContent) => MissionContent): Promise<void> {
    await this.serialise(missionId, async () => {
      const content = await this.privateContent(missionId, true)
      if (this.closed || !content?.chatBinding) throw new Error('Durable chat Mission content is unavailable.')
      await this.options.store.write(update(content))
      this.options.onChange?.()
    })
  }

  async persistExecutionPlan(missionId: string, executionPlan: MissionExecutionPlan, expectedIntent: string, previousPlanId?: string): Promise<void> {
    await this.serialise(missionId, async () => {
      if (!this.options.store.durable || this.closed || this.options.stopAll?.()
        || this.record(missionId)?.status !== 'planning') throw new Error('Durable mission planning is unavailable.')
      const content = await this.privateContent(missionId, true)
      if (!content || (previousPlanId ? content.executionPlan?.planId !== previousPlanId : !!content.executionPlan) || content.intent !== expectedIntent) throw new Error('Mission content changed.')
      await this.options.store.write({ ...content, executionPlan })
    })
  }

  /**
   * Write the private intent.
   *
   * The only path from the runtime to the encrypted store. It reads the existing content,
   * replaces `intentShape`, and writes it back — deliberately **not** a partial update,
   * because a partial update would need to know which fields the caller meant to leave
   * alone, and a correction that silently dropped the media constraint would be the worst
   * possible outcome for "in the barn".
   *
   * Free text is not accepted here. The runtime passes a normalised
   * `MissionIntentShape`, and this re-normalises it before writing, so a caller that
   * bypassed `normaliseIntentShape` cannot get an unbounded subject into the store.
   */
  async writeIntent(missionId: string, intent: MissionIntentShape): Promise<void> {
    // The *stored* normaliser, not the input one. The two shapes have different field
    // names, and an intent written back through the wrong normaliser loses every field it
    // does not recognise — a successful write of the wrong thing, which is worse than a
    // refusal because nothing reports it.
    const normalised = normaliseStoredIntentShape(intent)
    if (!normalised.ok) throw new Error(`mission intent is malformed: ${normalised.reason}`)
    const existing = await this.options.store.read(missionId)
    if (!existing.ok) return
    await this.options.store.write({
      ...existing.value,
      // A correction must not execute inputs generated for the previous goal.
      executionPlan: undefined,
      intentShape: normalised.value,
      // The free-text intent is regenerated from the shape so the two cannot disagree.
      // A store holding "find 100 cat videos" beside a shape saying quantity 40 would be
      // two sources of truth, and the private text is the one a person reads.
      intent: describeIntent(normalised.value),
    })
  }

  /**
   * Read the private intent.
   *
   * Null on any fault rather than throwing: a Mission whose content store is unavailable
   * is *degraded*, not broken, and refusing to read means a correction will be treated as
   * ambiguous — which parks the Mission and asks. That is the right failure direction.
   */
  async readIntent(missionId: string): Promise<MissionIntentShape | null> {
    const existing = await this.options.store.read(missionId).catch(() => null)
    return existing?.ok === true ? existing.value.intentShape : null
  }

  /**
   * Commit a plan.
   *
   * Serialised under the Mission's queue and delegating to the same fold the replay uses,
   * so a plan committed live and a plan read from the journal are the same object. The
   * revision number is **not** trusted from the caller: it is checked against the record's
   * own count inside the fold, and a mismatch refuses the whole commit.
   */
  async commitPlan(input: {
    missionId: string
    planId: string
    revision: number
    supersedes: string | null
    reason: string | null
    steps: readonly MissionStepRecord[]
    expectedStatus?: MissionStatus
    expectedPreviousPlanId?: string
  }): Promise<MissionCommandOutcome> {
    if (this.closed) return refused('plan-committed', 'missions are shutting down')
    return this.serialise(input.missionId, async () => {
      if (this.state.missions.get(input.missionId) === undefined) {
        return refused('plan-committed', 'no such mission', input.missionId)
      }
      if (input.expectedStatus !== undefined && (this.closed || this.options.stopAll?.()
        || this.record(input.missionId)?.status !== input.expectedStatus || (input.expectedPreviousPlanId ? this.record(input.missionId)?.activePlan?.planId !== input.expectedPreviousPlanId : !!this.record(input.missionId)?.activePlan))) {
        return refused('plan-committed', 'mission planning was interrupted', input.missionId)
      }
      // The steps are spread field by field rather than passed through with `...input`.
      // `MissionStepRecord.status` and `.reason` are narrow closed enums while the
      // envelope's are `string`, so a direct pass would be a type error *because* the two
      // layers are honestly independent — and the spread is where each record field is
      // listed, so a new one cannot be silently dropped on its way to the journal.
      await this.emit('mission.plan.committed', {
        missionId: input.missionId,
        planId: input.planId,
        revision: input.revision,
        supersedes: input.supersedes,
        reason: input.reason,
        steps: input.steps.map((step) => ({
          stepId: step.stepId,
          index: step.index,
          capability: step.capability,
          verifier: step.verifier,
          dependsOn: [...step.dependsOn],
          status: step.status,
          workerId: step.workerId,
          runId: step.runId,
          attempts: step.attempts,
          risk: step.risk,
          requiresApproval: step.requiresApproval,
          approvalId: step.approvalId,
          reason: step.reason,
          startedAt: step.startedAt,
          settledAt: step.settledAt,
        })),
      })
      this.options.onChange?.()
      return { operation: 'plan-committed', ok: true, missionId: input.missionId }
    })
  }

  /**
   * Move a step.
   *
   * The legality of the move is decided by `reduceAutonomyEvent`, not here — so the live
   * path and the replay path cannot disagree about which transitions exist. That means
   * this method *appears* not to check: the check happens in the fold, and if the fold
   * refuses, `readIntent`'s caller re-reads the record and sees the step unmoved.
   *
   * To make that observable rather than silent, the outcome reports the step's actual
   * status after the write.
   */
  async transitionStep(input: {
    missionId: string
    planId: string
    stepId: string
    to: MissionStepRecord['status']
    workerId?: string | null
    runId?: string | null
    attempts?: number
    reason?: string | null
  }): Promise<MissionCommandOutcome> {
    if (this.closed) return refused('step-transitioned', 'missions are shutting down')
    return this.serialise(input.missionId, async () => {
      const mission = this.state.missions.get(input.missionId)
      if (mission === undefined) return refused('step-transitioned', 'no such mission', input.missionId)
      const step = mission.activePlan?.steps.find((candidate) => candidate.stepId === input.stepId)
      if (step === undefined) {
        return refused('step-transitioned', `no such step: ${input.stepId}`, input.missionId)
      }
      await this.emit('mission.step.transitioned', {
        missionId: input.missionId,
        planId: input.planId,
        stepId: input.stepId,
        from: step.status,
        to: input.to,
        workerId: input.workerId ?? null,
        runId: input.runId ?? null,
        attempts: input.attempts ?? step.attempts,
        reason: input.reason ?? null,
      })
      const after = this.state.missions.get(input.missionId)?.activePlan?.steps.find((c) => c.stepId === input.stepId)
      if (after?.status !== input.to) {
        // The fold refused. Reported rather than thrown: a refused step is a normal
        // outcome of an illegal request, and the caller decides what to do about it.
        return {
          operation: 'step-transitioned',
          ok: false,
          missionId: input.missionId,
          reason: `a step cannot go from ${step.status} to ${input.to}`,
        }
      }
      this.options.onChange?.()
      return { operation: 'step-transitioned', ok: true, missionId: input.missionId }
    })
  }

  /** Record that a step's action was in flight when the process stopped. */
  async interruptStep(input: {
    missionId: string
    planId: string
    stepId: string
    consequential: boolean
  }): Promise<MissionCommandOutcome> {
    if (this.closed) return refused('step-interrupted', 'missions are shutting down')
    return this.serialise(input.missionId, async () => {
      if (this.state.missions.get(input.missionId) === undefined) {
        return refused('step-interrupted', 'no such mission', input.missionId)
      }
      await this.emit('mission.step.interrupted', { ...input })
      this.options.onChange?.()
      return { operation: 'step-interrupted', ok: true, missionId: input.missionId }
    })
  }

  /**
   * Record evidence.
   *
   * `resultCount` is the fold's business, not this method's: a caller cannot say "add 40
   * results", it can only say "this one observation happened". That is what makes the
   * progress number trustworthy — it is derived from events that each correspond to
   * something, and never from a total a caller supplied.
   */
  async recordEvidence(input: {
    missionId: string
    evidenceId: string
    stepId: string | null
    kind: 'result' | 'observation' | 'report' | 'refusal'
    origin: 'observed' | 'reported'
    summaryLength: number
    expiresAt: string | null
  }): Promise<MissionCommandOutcome> {
    if (this.closed) return refused('evidence-recorded', 'missions are shutting down')
    return this.serialise(input.missionId, async () => {
      if (this.state.missions.get(input.missionId) === undefined) {
        return refused('evidence-recorded', 'no such mission', input.missionId)
      }
      await this.emit('mission.evidence.recorded', { ...input })
      this.options.onChange?.()
      return { operation: 'evidence-recorded', ok: true, missionId: input.missionId }
    })
  }

  /** Raise or clear a blocker. Idempotent in the fold. */
  async setBlocker(input: {
    missionId: string
    code: string
    stepId: string | null
    raised: boolean
  }): Promise<MissionCommandOutcome> {
    if (this.closed) return refused('blocker-changed', 'missions are shutting down')
    return this.serialise(input.missionId, async () => {
      if (this.state.missions.get(input.missionId) === undefined) {
        return refused('blocker-changed', 'no such mission', input.missionId)
      }
      await this.emit('mission.blocker.changed', { ...input })
      this.options.onChange?.()
      return { operation: 'blocker-changed', ok: true, missionId: input.missionId }
    })
  }

  /**
   * Record that this step is now waiting on a Work approval.
   *
   * **A pointer, not a gate.** `approvalId` is Work's own id, from
   * `work.approval.requested`, and there is no `decideApproval` and no `expireApproval`
   * beside this method — their absence is the design.
   *
   * A Mission used to open, decide and expire its own approval gates, which made it a
   * second approval system inside Core: a second id sequence, a second lifecycle, and a
   * second surface nobody was answering. Now Work's Guard opens gates when a Run executes,
   * a person answers on Work's surface through `work.approval.decide`, and this method
   * records only that the Mission is waiting on a particular one. The Mission reads the
   * outcome back from Work; it never writes one.
   *
   * `source` distinguishes a gate the plan anticipated from one Guard demanded, because
   * "this is how this kind of step works" and "this surprised the planner" are different
   * things to tell a person.
   */
  async noteApprovalRequested(input: {
    missionId: string
    stepId: string
    approvalId: string
    source: 'requested' | 'observed'
    /** The Work Run the gate belongs to, so the Mission can poll it later. */
    runId: string | null
    requestedAt: string
  }): Promise<MissionCommandOutcome> {
    if (this.closed) return refused('approval-requested', 'missions are shutting down')
    return this.serialise(input.missionId, async () => {
      if (this.state.missions.get(input.missionId) === undefined) {
        return refused('approval-requested', 'no such mission', input.missionId)
      }
      await this.emit('mission.approval.requested', { ...input })
      this.options.onChange?.()
      return { operation: 'approval-requested', ok: true, missionId: input.missionId }
    })
  }

  /**
   * Record what Work said about the gate this Mission was parked on.
   *
   * The outcome is **Work's**, read back from its `ApprovalRecord`; Core never decides it
   * and never infers it. There is no `decidedBy` parameter because there is no actor to
   * record — `work.approval.decided` already wrote who answered, after Guard evaluated the
   * owner, and a second copy here would be one more fact Core cannot vouch for.
   *
   * It writes a **blocker**, not an approval event, and the fold settles the reference from
   * that same event. That is why the envelope has no `mission.approval.decided`: the durable
   * record of "this Mission stopped because a person said no" is exactly what a blocker is,
   * and reusing it means the board cannot show a Mission as waiting on an approval that has
   * already been answered — there is one event, so there is nothing to disagree.
   *
   * Only the outcomes that stopped the Mission raise anything. `approved` is deliberately
   * **not** handled: when a gate is approved, Work's own engine resumes the Run and
   * completes the step, and the next `step()` observes a verified step. Writing a
   * "Mission was approved" event would be Core claiming a step it did not run.
   */
  async noteApprovalOutcome(input: {
    missionId: string
    approvalId: string
    outcome: 'approved' | 'denied' | 'expired' | 'cancelled'
  }): Promise<MissionCommandOutcome> {
    if (this.closed) return refused('approval-outcome', 'missions are shutting down')
    return this.serialise(input.missionId, async () => {
      const mission = this.state.missions.get(input.missionId)
      if (mission === undefined) return refused('approval-outcome', 'no such mission', input.missionId)
      const reference = mission.approval
      if (reference === null || reference.approvalId !== input.approvalId) {
        return refused('approval-outcome', 'this Mission is not waiting on that approval', input.missionId)
      }
      if (reference.outcome !== null) {
        return refused('approval-outcome', `that approval is already ${reference.outcome}`, input.missionId)
      }
      if (input.outcome === 'approved') {
        // **Nothing to record.** Work has already resumed the Run, and the step will settle
        // on its own; a Mission writing "approved" here would be claiming a step it did not
        // run. The reference stays open until the step settles, which is exactly how long
        // the question was outstanding.
        return { operation: 'approval-outcome', ok: true, missionId: input.missionId }
      }
      // `denied`, `expired` and `cancelled` all mean the same thing to this Mission: the
      // step did not run and nobody is going to make it run without a person. Which of the
      // three it was is Work's record to keep, not the Mission's — and the fold is the only
      // thing that settles the reference, which is why there is no approval event here.
      const code = input.outcome === 'denied' ? 'approval_denied' : 'approval_expired'
      await this.emit('mission.blocker.changed', {
        missionId: input.missionId,
        code,
        stepId: reference.stepId,
        raised: true,
      })
      this.options.onChange?.()
      return { operation: 'approval-outcome', ok: true, missionId: input.missionId }
    })
  }
  /**
   * Schedule the next wake.
   *
   * `dueAt` is required by the event schema and there is no default, so a caller cannot
   * omit it and get an open-ended wait. The instant is additionally **clamped to the
   * Mission's deadline** here, so a wake cannot outlive the Mission it belongs to — which
   * would be a scheduled callback for something that no longer exists.
   */
  async scheduleWake(input: {
    missionId: string
    wakeId: string
    kind: 'event' | 'time' | 'manual'
    source: 'fabric' | 'time' | 'owner'
    dueAt: string
    eventType: string | null
  }): Promise<MissionCommandOutcome> {
    if (this.closed) return refused('wake-scheduled', 'missions are shutting down')
    return this.serialise(input.missionId, async () => {
      const mission = this.state.missions.get(input.missionId)
      if (mission === undefined) return refused('wake-scheduled', 'no such mission', input.missionId)
      const bound = Math.min(Date.parse(input.dueAt), Date.parse(mission.deadlineAt))
      await this.emit('mission.wake.scheduled', {
        ...input,
        dueAt: new Date(bound).toISOString(),
        eventType: input.kind === 'event' ? input.eventType : null,
      })
      this.options.onChange?.()
      return { operation: 'wake-scheduled', ok: true, missionId: input.missionId }
    })
  }

  /** Record that a wake fired. Idempotent in the fold. */
  async fireWake(input: { missionId: string; wakeId: string }): Promise<MissionCommandOutcome> {
    if (this.closed) return refused('wake-fired', 'missions are shutting down')
    return this.serialise(input.missionId, async () => {
      if (this.state.missions.get(input.missionId) === undefined) {
        return refused('wake-fired', 'no such mission', input.missionId)
      }
      await this.emit('mission.wake.fired', { ...input })
      this.options.onChange?.()
      return { operation: 'wake-fired', ok: true, missionId: input.missionId }
    })
  }

  /**
   * Journal a continuation decision.
   *
   * The fold enforces the invariant that a `wait` names an instant and nothing else does.
   * Passing an ill-formed pair here therefore *fails* rather than being written, which is
   * what stops an open-ended wait from reaching disk by a path other than the decider's.
   */
  async recordDecision(input: {
    missionId: string
    decision: MissionDecision
    reason: string
    stepId: string | null
    nextWakeAt: string | null
  }): Promise<MissionCommandOutcome> {
    if (this.closed) return refused('continuation-decided', 'missions are shutting down')
    if (input.decision === 'wait' && input.nextWakeAt === null) {
      return refused('continuation-decided', 'a wait must name an instant', input.missionId)
    }
    if (input.decision !== 'wait' && input.nextWakeAt !== null) {
      return refused('continuation-decided', 'only a wait may name a next wake', input.missionId)
    }
    return this.serialise(input.missionId, async () => {
      if (this.state.missions.get(input.missionId) === undefined) {
        return refused('continuation-decided', 'no such mission', input.missionId)
      }
      await this.emit('mission.continuation.decided', { ...input })
      this.options.onChange?.()
      return { operation: 'continuation-decided', ok: true, missionId: input.missionId }
    })
  }

  /**
   * Charge a budget.
   *
   * Five **deltas**, never totals. The fold adds them to the record's own counts, so a
   * caller cannot set spend to a number it likes and a restart cannot reset it. The
   * ceiling check happens in the fold's arithmetic as well as in `chargeBudget`, so a
   * caller that skipped the latter still cannot overdraw.
   */
  async charge(input: {
    missionId: string
    modelCalls: number
    actions: number
    externalRequests: number
    retries: number
    delegations: number
  }): Promise<MissionCommandOutcome> {
    if (this.closed) return refused('budget-spent', 'missions are shutting down')
    return this.serialise(input.missionId, async () => {
      const mission = this.state.missions.get(input.missionId)
      if (mission === undefined) return refused('budget-spent', 'no such mission', input.missionId)
      const charged = chargeBudget(mission.spend, mission.budget, {
        modelCalls: input.modelCalls,
        actions: input.actions,
        externalRequests: input.externalRequests,
        retries: input.retries,
        delegations: input.delegations,
      })
      if (!charged.ok) {
        await this.emit('mission.budget.exceeded', { missionId: input.missionId, budget: charged.dimension })
        this.options.onChange?.()
        return { operation: 'budget-exceeded', ok: false, missionId: input.missionId, reason: charged.reason }
      }
      await this.emit('mission.budget.spent', { ...input })
      this.options.onChange?.()
      return { operation: 'budget-spent', ok: true, missionId: input.missionId }
    })
  }

  /**
   * Record that a ceiling was reached.
   *
   * Separate from `charge` because most ceilings are hit by a *refusal* rather than by a
   * spend: no capable worker means the delegation ceiling stopped mattering, and that is
   * worth recording so a restart cannot hide why a Mission stopped progressing.
   */
  async noteBudgetExceeded(input: { missionId: string; budget: string }): Promise<MissionCommandOutcome> {
    if (this.closed) return refused('budget-exceeded', 'missions are shutting down')
    return this.serialise(input.missionId, async () => {
      if (this.state.missions.get(input.missionId) === undefined) {
        return refused('budget-exceeded', 'no such mission', input.missionId)
      }
      await this.emit('mission.budget.exceeded', { ...input })
      this.options.onChange?.()
      return { operation: 'budget-exceeded', ok: true, missionId: input.missionId }
    })
  }

  /**
   * Change the requested quantity.
   *
   * A fact about the goal, not a budget. Emitted through `mission.intent.corrected`'s
   * sibling path rather than as budget spend, and refused above `MAX_REQUESTED_QUANTITY` —
   * an owner correction may change *how much they want*, and it may not change how much
   * Freya may do.
   */
  async setRequestedQuantity(input: {
    missionId: string
    requestedQuantity: number | null
  }): Promise<MissionCommandOutcome> {
    if (this.closed) return refused('intent-corrected', 'missions are shutting down')
    const quantity = input.requestedQuantity
    if (quantity !== null && (!Number.isInteger(quantity) || quantity <= 0 || quantity > MAX_REQUESTED_QUANTITY)) {
      return refused('intent-corrected', 'a requested quantity must be a positive whole number')
    }
    return this.serialise(input.missionId, async () => {
      if (this.state.missions.get(input.missionId) === undefined) {
        return refused('intent-corrected', 'no such mission', input.missionId)
      }
      const mission = this.state.missions.get(input.missionId)
      await this.emit('mission.intent.corrected', {
        missionId: input.missionId,
        correctionId: this.options.newId?.() ?? randomUUID(),
        kind: 'patch',
        changedFields: ['quantity'],
        settledSteps: 0,
        // The evidence a correction preserves is the evidence still standing afterwards,
        // which is read **before** anything is settled. Nothing is settled here, so this
        // is what the Mission already had.
        preservedEvidence: mission?.evidence.length ?? 0,
        replannedFrom: null,
        // The number rides on the event, and the fold applies it. An earlier version
        // recorded the field *name* here and then wrote the number straight into the
        // in-memory record — which meant a corrected quantity lasted until the process
        // restarted and then quietly reverted, because nothing in the journal said what
        // it had become. A quantity is a count, not content: `mission.created` already
        // carries one, and this is the same field moving.
        requestedQuantity: quantity,
      })
      this.options.onChange?.()
      return { operation: 'intent-corrected', ok: true, missionId: input.missionId }
    })
  }

  /**
   * Record an applied correction.
   *
   * Field names and counts only. There is no parameter through which a value could
   * travel, which is what makes "a correction cannot widen authority" structural rather
   * than a validation rule.
   */
  async recordCorrection(input: {
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
     * Read from the corrected intent by the caller rather than from the record, because
     * the record's number is the *old* one at this point — the correction's whole job is
     * to replace it. Omitted rather than sent as `null` when the quantity did not change,
     * since "no longer asking for a quantity" and "did not touch the quantity" are
     * different corrections and the journal has to be able to tell them apart on replay.
     */
    requestedQuantity?: number | null
  }): Promise<MissionCommandOutcome> {
    if (this.closed) return refused('intent-corrected', 'missions are shutting down')
    const changed = input.changedFields.includes('quantity')
    if (changed !== Object.hasOwn(input, 'requestedQuantity')) {
      // The binding is enforced here as well as in the validator, so a caller cannot
      // record a correction that claims to have changed the quantity without saying what
      // it became, or attach a number to a correction that did not change one.
      return refused('intent-corrected', changed ? 'a corrected quantity must say what it became' : 'an unchanged quantity must be left out')
    }
    return this.serialise(input.missionId, async () => {
      if (this.state.missions.get(input.missionId) === undefined) {
        return refused('intent-corrected', 'no such mission', input.missionId)
      }
      await this.emit('mission.intent.corrected', { ...input })
      this.options.onChange?.()
      return { operation: 'intent-corrected', ok: true, missionId: input.missionId }
    })
  }

  /**
   * Record that a correction was ambiguous.
   *
   * The only outcome on this path. Nothing is merged, no step is settled, and no evidence
   * is discarded — the Mission keeps running exactly as it was and only the owner can
   * change that.
   */
  async recordAmbiguity(input: {
    missionId: string
    correctionId: string
    ambiguity: string
  }): Promise<MissionCommandOutcome> {
    if (this.closed) return refused('correction-ambiguous', 'missions are shutting down')
    return this.serialise(input.missionId, async () => {
      if (this.state.missions.get(input.missionId) === undefined) {
        return refused('correction-ambiguous', 'no such mission', input.missionId)
      }
      await this.emit('mission.correction.ambiguous', { ...input })
      this.options.onChange?.()
      return { operation: 'correction-ambiguous', ok: true, missionId: input.missionId }
    })
  }

  /* ------------------------------------------------------------- internals */

  /**
   * Run one transition, inside the Mission's queue.
   *
   * `from` is `null` for a transition that may start from any non-terminal status —
   * cancel and fail — and an exact status for one that requires it. The table decides
   * either way; this only narrows what the caller *asked* for.
   */
  private async transition(
    missionId: string,
    from: MissionStatus | null,
    to: MissionStatus,
    operation: MissionCommandOutcome['operation'],
    /**
     * A specific closed code, for a caller that knows why.
     *
     * Every command has a real reason — a deadline, a budget, an approval, an owner — and
     * defaulting all of them to `owner` would mean a Mission that failed on a budget
     * reported that a person stopped it. Supplied by `settle` and `autonomyTransition`,
     * omitted by the plain lifecycle commands, which are genuinely the owner's say-so.
     *
     * Checked against `MISSION_REASONS` before the write, so an unknown code is refused
     * rather than reaching the journal.
     */
    reason?: MissionReason,
  ): Promise<MissionCommandOutcome> {
    if (this.closed) return refused(operation, 'missions are shutting down')

    return this.serialise(missionId, async () => {
      const mission = this.state.missions.get(missionId)
      if (mission === undefined) return refused(operation, 'no such mission')
      // Settlement is reported first and in a person's words, because "it has
      // already settled" is the answer somebody needs and the table's edge list is
      // not. The table still decides what happens next.
      if (isTerminalMissionStatus(mission.status)) {
        return refused(operation, `that Mission has already settled as ${mission.status}`, missionId)
      }
      if (from !== null && mission.status !== from) {
        return refused(operation, `that Mission is ${mission.status}, not ${from}`, missionId)
      }
      // The transition table, not this code, decides. A terminal Mission has no
      // outgoing edge, so this is what makes settlement final.
      if (!canTransitionMission(mission.status, to)) {
        return refused(operation, `a Mission cannot go from ${mission.status} to ${to}`, missionId)
      }
      // STOP ALL closes every door that would let work begin, which is now three statuses
      // rather than one: a Mission may be `ready`, `planning` or `active` and none of
      // them may start anything new while the panic button is latched.
      //
      // Read fresh at the moment of the decision rather than cached, so a Mission
      // activated a microsecond after the button is refused. A gate that could be
      // stale is not a gate.
      if (this.options.stopAll?.() === true && isLiveMissionStatus(to)) {
        return refused(operation, 'Freya is stopped', missionId)
      }

      if (reason !== undefined && !Object.hasOwn(MISSION_REASONS, reason)) {
        return refused(operation, `not a mission reason: ${reason}`, missionId)
      }

      await this.emit(eventTypeFor(mission.status, to), {
        missionId,
        from: mission.status,
        to,
        reason: reason ?? reasonFor(mission.status, to),
        verifierId: null,
      })
      this.options.onChange?.()
      return { operation, ok: true, missionId, status: to }
    })
  }

  /** Settle a Mission, tolerating any non-terminal status. */
  private settle(missionId: string, to: 'failed' | 'cancelled', reason: MissionReason): Promise<MissionCommandOutcome> {
    return this.serialise(missionId, async () => {
      const mission = this.state.missions.get(missionId)
      if (mission === undefined) return refused('refused', 'no such mission')
      if (!canTransitionMission(mission.status, to)) return refused('refused', `a Mission cannot go from ${mission.status} to ${to}`, missionId)
      // `reason` is passed through rather than `reasonFor`, because `settle` was called
      // with a *specific* reason by whoever knew it — a deadline expiry, a ceiling, a
      // verification timeout — and deriving one here would overwrite the real cause with
      // "the owner".
      await this.emit(eventTypeFor(mission.status, to), {
        missionId,
        from: mission.status,
        to,
        reason,
        verifierId: null,
      })
      this.options.onChange?.()
      return { operation: to === 'failed' ? 'settled-failed' : 'cancelled', ok: true, missionId, status: to }
    })
  }

  /**
   * Serialise per Mission.
   *
   * The queue is what makes cancel-versus-complete deterministic rather than
   * timing-dependent: whichever call enters second observes a terminal status and
   * refuses. Creating the queue entry eagerly means a second caller joins the
   * existing chain instead of starting a parallel one.
   */
  private serialise<T>(missionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(missionId) ?? Promise.resolve()
    const result = previous.then(work, work)
    this.locks.set(
      missionId,
      result.catch(() => undefined),
    )
    void result.catch(() => undefined)
    this.inflight.add(result)
    // `.finally` returns a *new* promise, so handling `result` above does not handle
    // this one — and a rejected `result` would leave it rejected with nobody listening,
    // which Node treats as an unhandled rejection and, by default, a process exit. A
    // journal write failing is exactly the situation this engine goes to such lengths
    // to degrade gracefully from, so it must not take the process down instead.
    void result.finally(() => this.inflight.delete(result)).catch(() => undefined)
    return result
  }

  /**
   * Race a verifier against its deadline and against shutdown.
   *
   * Aborting only *asks*. A verifier that ignores its signal must not be able to
   * hold a Mission open for ever, so the engine stops waiting at the deadline — and
   * a late answer is discarded rather than applied, which is what stops a `passed`
   * arriving after the wall clock said the Mission was timed out.
   */
  private async runVerifier(
    verifier: {
      id: string
      verify(
        context: MissionVerificationContext,
        signal: AbortSignal,
      ): Promise<{ established: boolean; reason: MissionReason }>
    },
    context: MissionVerificationContext,
    controller: AbortController,
    deadlineMs: number,
  ): Promise<
    | { kind: 'passed'; reason: MissionReason }
    | { kind: 'not_established'; reason: MissionReason }
    | { kind: 'timeout'; reason: MissionReason }
    | { kind: 'cancelled'; reason: MissionReason }
  > {
    // Shaped so the timeout is a sibling of the other three outcomes rather than a
    // bare string, so `answered` and `expired` cannot be collapsed by accident.
    const timer = new Promise<{ kind: 'timeout' }>((resolve) => {
      const handle = setTimeout(() => resolve({ kind: 'timeout' }), deadlineMs)
      handle.unref?.()
    })

    try {
      const verdict = await Promise.race([
        verifier
          .verify(context, controller.signal)
          .then(
            (value) => ({ kind: 'verdict' as const, value }),
            // A verifier that throws is not a verifier that passed. Its message is
            // deliberately not recorded.
            () => ({ kind: 'threw' as const }),
          ),
        timer,
      ])

      if (verdict.kind === 'timeout') {
        controller.abort()
        return { kind: 'timeout', reason: MISSION_REASONS.verification_timeout }
      }
      if (verdict.kind === 'threw') {
        return { kind: 'not_established', reason: MISSION_REASONS.verification_not_established }
      }
      if (verdict.value.established) return { kind: 'passed', reason: MISSION_REASONS.verification_passed }
      return { kind: 'not_established', reason: verdict.value.reason }
    } finally {
      // A verifier that answered before the deadline must not be able to keep the
      // process alive, and the timer must not outlive the call.
      controller.abort()
    }
  }

  /**
   * What a verifier is shown, and what it is not.
   *
   * The context is built from **counts, statuses and ids**. It carries no title, no
   * intent, no success criterion and no evidence body, and the same is true of
   * `MissionVerificationOutcome`, so there is no field a verifier could put private
   * text into. A verifier that needs to know what the Mission is must ask for that
   * deliberately through the encrypted store, under its own capability.
   *
   * The Phase 47 additions exist because mission-level completion is about evidence
   * and steps, not about child Runs. `observedResults` and `expiredObservedResults` are
   * separate numbers precisely so a verifier can tell fresh evidence from stale
   * evidence — a Mission backed entirely by expired observations is not established,
   * and a verifier that could only see a total could not know that.
   */
  private verificationContext(
    missionId: string,
    mission: MissionRecord,
    requiredRunIds: readonly string[],
  ): MissionVerificationContext {
    return buildMissionVerificationContext({
      missionId,
      mission,
      requiredRunIds,
      work: this.options.work,
      now: this.options.now ?? (() => new Date()),
    })
  }
  /**
   * Push a lifecycle change to live children.
   *
   * Returns the Runs that would not follow. Reported rather than hidden: a Mission
   * that says it paused while a Run kept going is the most misleading thing this
   * engine could do, and a partial pause is a fact a person needs.
   */
  private async propagate(missionId: string, action: 'pause' | 'cancel'): Promise<string[]> {
    const mission = this.state.missions.get(missionId)
    if (mission === undefined) return []
    const blocked: string[] = []
    for (const runId of mission.childRuns) {
      const run = this.options.work.run(runId)
      if (run === undefined || this.options.work.isSettled(run.status)) continue
      try {
        const followed =
          action === 'pause'
            ? await this.options.work.pauseRun(runId, 'its Mission was paused')
            : await this.options.work.cancelRun(runId, 'its Mission was cancelled')
        if (!followed) blocked.push(runId)
      } catch {
        blocked.push(runId)
      }
    }
    return blocked
  }

  private defaultVerifierId(): string {
    const ids = this.options.verifiers?.ids() ?? new MissionVerifierRegistry().ids()
    return ids[0] ?? 'mission.work.verified'
  }

  private async emit(type: string, payload: Record<string, unknown>): Promise<void> {
    await this.options.fabric.append(type as never, payload as never, { actor: this.options.principalId })
  }
}

/**
 * Which event an edge emits.
 *
 * `from` is required rather than inferred, because two edges land on `active` and
 * they are not the same event: a Mission that was activated for the first time and
 * one that was resumed are different facts, and a journal that cannot tell them
 * apart cannot answer "was this ever paused?".
 */
/**
 * Which event an edge emits.
 *
 * Six named lifecycle events and one general one. The named six survive because they
 * are *specific historical facts* — a Mission was activated, was stopped, settled — and
 * a journal that cannot distinguish them cannot answer "was this ever stopped?".
 *
 * The twelve-status machine has far more edges than that, and inventing a named event
 * per edge would mean a `mission.waiting` / `mission.blocked` / `mission.verifying`
 * vocabulary that is really just `mission.transitioned` fourteen times. So every other
 * edge emits `mission.transitioned`, and the reducer reads it through the same
 * `MISSION_TRANSITIONS` table and the same refusals.
 */
function eventTypeFor(from: MissionStatus, to: MissionStatus): string {
  // Six named lifecycle events and one general one. The named six survive because they are
  // *specific historical facts* — a Mission was activated, was stopped, was resumed — and a
  // journal that could not tell them apart could not answer "was this ever stopped, and
  // did it ever carry on again?".
  if (to === 'active' && from === 'draft') return 'mission.activated'
  // **Both** resumes are `mission.resumed`, and that is the point. `stopped → active` and
  // `stopped → ready` are different destinations, and the payload's `from`/`to` say which —
  // so naming them differently would have meant a journal that could not answer the two
  // questions from the event *type* alone. One event, read through `MISSION_TRANSITIONS`.
  if (to === 'ready' && from === 'stopped') return 'mission.resumed'
  if (to === 'active' && from === 'stopped') return 'mission.resumed'
  if (to === 'stopped') return 'mission.paused'
  if (to === 'completed') return 'mission.completed'
  if (to === 'failed') return 'mission.failed'
  if (to === 'cancelled') return 'mission.cancelled'
  return 'mission.transitioned'
}

function reasonFor(from: MissionStatus, to: MissionStatus): MissionReason {
  // A completion is always a verifier's verdict, never the owner's say-so. The
  // verifier's own reason is recorded by the caller, so this is the fallback for
  // the edges that nobody else reaches.
  if (to === 'completed') return MISSION_REASONS.verification_passed
  // Leaving or entering `stopped` is a statement about the gate rather than about the
  // goal, and saying so is what lets a reader tell "the owner paused this" from "the
  // owner walked away from it".
  if (to === 'stopped') return MISSION_REASONS.stopped
  if (from === 'stopped') return MISSION_REASONS.resumed
  return MISSION_REASONS.owner
}

function refused(
  operation: MissionCommandOutcome['operation'],
  reason: string,
  missionId?: string,
): MissionCommandOutcome {
  return {
    operation: operation === 'run-attached' ? 'run-refused' : operation === 'refused' ? 'refused' : operation,
    ok: false,
    reason,
    ...(missionId === undefined ? {} : { missionId }),
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}






/**
 * Render a structured intent as the free-text line a person reads.
 *
 * Private, and written to the encrypted store beside the shape rather than replacing it —
 * the shape is what a correction patches, and the text is what somebody looks at. Keeping
 * both, with the text *derived*, is what stops them drifting into two different goals.
 *
 * Field values appear here and nowhere else. This string lives in the encrypted store; the
 * journal never receives it, and `mission.intent.corrected` receives only the names of the
 * fields that changed.
 */
function describeIntent(shape: MissionIntentShape): string {
  const parts: string[] = []
  const quantity = shape.requestedQuantity === null ? null : `${shape.requestedQuantity}`
  parts.push(shape.subject)
  if (quantity !== null) parts.push(`× ${quantity}`)
  if (shape.mediaConstraints.length > 0) parts.push(`(${shape.mediaConstraints.join(', ')})`)
  if (shape.contextConstraints.length > 0) parts.push(`in ${shape.contextConstraints.join(', ')}`)
  if (shape.exclusions.length > 0) parts.push(`excluding ${shape.exclusions.join(', ')}`)
  return parts.join(' ').slice(0, DEFAULT_MISSION_LIMITS.maxIntentChars)
}

/* ----------------------------------------------------------------- derived */

/** Re-exported so Core can name the limits it forwards without reaching into types. */
export { DEFAULT_MISSION_LIMITS }
export type { RunStatus }
export { countChildren }
