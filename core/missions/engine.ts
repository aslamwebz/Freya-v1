import { randomUUID } from 'node:crypto'
import type { EventFabric } from '../events/fabric'
import type { PrincipalId } from '../protocol/core-protocol'
import type { RunRecord, RunStatus, StepRecord } from '../work/types'
import { countChildren, liveChildCount, missionProjection, summarise, type WorkTruthPort } from './projection'
import { reduceMissionState, initialMissionState } from './state'
import type { MissionStore } from './store'
import { MissionVerifierRegistry } from './verifier'
import {
  DEFAULT_MISSION_LIMITS,
  MISSION_REASONS,
  canTransitionMission,
  isTerminalMissionStatus,
  missionLimits,
  normaliseMissionContent,
  type MissionCommandOutcome,
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

/** The shape a Work Run status takes in a verification context. */
type VerificationRunStatus = 'completed' | 'failed' | 'cancelled' | 'verified_steps' | 'non_terminal'

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
  async create(input: MissionContentInput, limits?: Partial<MissionLimits>): Promise<MissionCommandOutcome> {
    if (this.closed) return refused('created', 'missions are shutting down')
    const content = normaliseMissionContent(input)
    if (!content.ok) return refused('created', content.reason)

    let resolved: MissionLimits
    try {
      resolved = missionLimits(limits)
    } catch (error) {
      return refused('created', error instanceof Error ? error.message : 'the requested limits are malformed')
    }

    const missionId = this.options.newId?.() ?? randomUUID()
    const now = (this.options.now?.() ?? new Date()).toISOString()
    const deadlineAt = new Date(Date.parse(now) + resolved.lifetimeMs).toISOString()

    try {
      await this.options.store.write({
        missionId,
        title: content.value.title,
        intent: content.value.intent,
        successCriteria: content.value.successCriteria,
        createdAt: now,
      })
    } catch (error) {
      return refused('created', `Mission content could not be stored: ${describe(error)}`)
    }

    try {
      // Metadata only. The title and intent are deliberately absent here and the
      // validator rejects them if a future change tried to add them.
      await this.emit('mission.created', { missionId, status: 'draft', createdAt: now, deadlineAt, limits: resolved })
    } catch (error) {
      await this.options.store.remove(missionId).catch(() => false)
      return refused('created', `the Mission could not be recorded: ${describe(error)}`)
    }

    this.options.onChange?.()
    return { operation: 'created', ok: true, missionId, status: 'draft' }
  }

  async activate(missionId: string): Promise<MissionCommandOutcome> {
    return this.transition(missionId, 'draft', 'active', 'activated')
  }

  async resume(missionId: string): Promise<MissionCommandOutcome> {
    return this.transition(missionId, 'paused', 'active', 'resumed')
  }

  /**
   * Pause a Mission and propagate to its live children.
   *
   * The Mission settles as `paused` first, then the propagation happens. That order
   * is deliberate: once the Mission is paused, admission of a new child Run refuses,
   * so a Run that arrives mid-pause cannot slip in behind the propagation and then
   * be missed by it.
   *
   * A child that could not be paused is reported rather than hidden. Fabricating a
   * clean pause while a Run kept going would be the single most misleading thing
   * this engine could do.
   */
  async pause(missionId: string): Promise<MissionCommandOutcome> {
    const settled = await this.transition(missionId, 'active', 'paused', 'paused')
    if (!settled.ok) return settled

    const blocked = await this.propagate(missionId, 'pause')
    this.options.onChange?.()
    return blocked.length === 0
      ? { operation: 'paused', ok: true, missionId, status: 'paused' }
      : {
          operation: 'paused',
          ok: true,
          missionId,
          status: 'paused',
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
      if (mission.status !== 'active') {
        return {
          kind: 'refused',
          outcome: refused(
            'verification-not-established',
            isTerminalMissionStatus(mission.status)
              ? 'that Mission has already settled'
              : 'only an active Mission can be completed',
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
      const required = [...(options.requiredRunIds ?? mission.childRuns)]
      if (required.length === 0) {
        // Nothing has been attempted. Establishing a Mission that has never executed
        // anything would be establishing a plan.
        return {
          kind: 'refused',
          outcome: refused('verification-not-established', 'no Work has been attached to this Mission', missionId),
        }
      }

      // Claimed only once the request is certain to be recorded, so a refusal never
      // leaves the Mission permanently stuck behind a claim nobody owns.
      this.verifying.add(missionId)
      await this.emit('mission.verification.requested', { missionId, verifierId, runIds: required })

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
      if (current.status !== 'active') {
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
        this.options.onChange?.()
        return {
          operation: outcome.kind === 'timeout' ? 'verification-timeout' : 'verification-not-established',
          ok: false,
          missionId,
          status: current.status,
          reason: outcome.reason,
        }
      }

      await this.emit('mission.completed', {
        missionId,
        from: 'active',
        to: 'completed',
        reason: MISSION_REASONS.verification_passed,
        verifierId,
      })
      this.options.onChange?.()
      return { operation: 'verification-passed', ok: true, missionId, status: 'completed' }
    })
  }

  /**
   * Attach a child Run.
   *
   * The only door to a new Run, and it enforces admission before anything happens:
   * the Mission must exist, must be `active`, must not have expired, and must be
   * under both ceilings. Once pause wins admission, a child Run arriving later
   * cannot start under stale state, because the status is re-read inside the
   * per-Mission queue rather than before it.
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
      if (mission.status !== 'active') {
        return refused(
          'run-attached',
          `only an active Mission may attach Work; this one is ${mission.status}`,
          missionId,
        )
      }
      if (mission.childRuns.includes(runId)) {
        // Idempotent. Re-attaching would double the child count and could make a
        // Mission look like it had hit a ceiling it had not.
        return { operation: 'run-attached', ok: true, missionId, runId }
      }

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
        return refused('run-attached', 'this Mission has reached its concurrent child Run ceiling', missionId)
      }
      if (this.options.stopAll?.() === true) {
        return refused('run-attached', 'Freya is stopped', missionId)
      }

      await this.emit('mission.run.attached', { missionId, runId, taskId })
      this.options.onChange?.()
      return { operation: 'run-attached', ok: true, missionId, runId }
    })
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
      if (this.options.stopAll?.() === true && to === 'active') {
        return refused(operation, 'Freya is stopped', missionId)
      }

      await this.emit(eventTypeFor(mission.status, to), {
        missionId,
        from: mission.status,
        to,
        reason: reasonFor(to),
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
    void result.finally(() => this.inflight.delete(result))
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

  private verificationContext(
    missionId: string,
    mission: MissionRecord,
    requiredRunIds: readonly string[],
  ): MissionVerificationContext {
    const runStatuses: Record<string, VerificationRunStatus> = {}
    const runStepStatuses: Record<string, { verified: number; total: number; failed: number; other: number }> = {}

    for (const runId of requiredRunIds) {
      const run: RunRecord | undefined = this.options.work.run(runId)
      const steps: readonly StepRecord[] = this.options.work.stepsOf(runId)
      const verified = steps.filter((step) => step.status === 'verified').length
      const failed = steps.filter((step) => step.status === 'failed').length
      runStepStatuses[runId] = {
        verified,
        total: steps.length,
        failed,
        other: steps.length - verified - failed,
      }

      if (run === undefined) {
        runStatuses[runId] = 'cancelled'
        continue
      }
      if (this.options.work.isSettled(run.status)) {
        runStatuses[runId] = run.status === 'failed' ? 'failed' : run.status === 'cancelled' ? 'cancelled' : 'completed'
        continue
      }
      runStatuses[runId] = 'non_terminal'
    }

    return {
      missionId,
      status: mission.status,
      requiredRunIds: [...requiredRunIds],
      runStatuses,
      runStepStatuses,
    }
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
function eventTypeFor(from: MissionStatus, to: MissionStatus): string {
  if (to === 'active') return from === 'paused' ? 'mission.resumed' : 'mission.activated'
  if (to === 'paused') return 'mission.paused'
  if (to === 'completed') return 'mission.completed'
  if (to === 'failed') return 'mission.failed'
  return 'mission.cancelled'
}

function reasonFor(to: MissionStatus): MissionReason {
  // A completion is always a verifier's verdict, never the owner's say-so. The
  // verifier's own reason is recorded by the caller, so this is the fallback for
  // the edges that nobody else reaches.
  if (to === 'completed') return MISSION_REASONS.verification_passed
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

/** Re-exported so Core can name the limits it forwards without reaching into types. */
export { DEFAULT_MISSION_LIMITS }
export type { RunStatus }
export { countChildren }