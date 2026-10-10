import { randomUUID } from 'node:crypto'
import type { WorkerIntent } from '../authority'
import type { CognitionOutcome } from '../cognition/service'
import type { EventFabric } from '../events/fabric'
import type { CoreEventType } from '../events/envelope'
import type { Capability, PrincipalId } from '../protocol/core-protocol'
import type { SubordinateWorkerScope, WorkforceOwnerScope } from './authority'
import {
  ABSENT_WORKFORCE_PROJECTION,
  workforceProjection,
  workerDetail,
  type WorkforceMailboxDetail,
} from './projection'
import { initialWorkforceState, reduceWorkforceState } from './state'
import {
  canTransitionAssignment,
  canTransitionWorker,
  isAssignableToWorker,
  isTerminalAssignmentStatus,
  isTerminalWorkerStatus,
  isWorkerSpecialisation,
  normaliseContextRef,
  normaliseWorkforceName,
  specialisationAllows,
  workerBudget,
  workerPrincipalId,
  WORKFORCE_CLAIM_REFUSALS,
  WORKFORCE_LIMITS,
  WORKFORCE_MESSAGE_KINDS,
  WORKFORCE_REASONS,
  type DeliveredMessage,
  type WorkerBudget,
  type WorkerRecord,
  type WorkerSpecialisation,
  type WorkerStatus,
  type WorkforceClaim,
  type WorkforceCommandOutcome,
  type WorkforceMessageKind,
  type WorkforceProjection,
  type WorkforceReason,
  type WorkforceState,
  type WorkforceWorkerDetail,
} from './types'

/**
 * THE WORKFORCE ENGINE.
 *
 * Holds the roster, the teams, the assignments, the budgets and the mailboxes — and
 * the rules that keep every one of those subordinate.
 *
 * ## Serialisation, not luck
 *
 * Every state-changing operation runs inside a per-aggregate queue, and the status
 * check happens **inside** that queue rather than before it. A retire racing an
 * assignment, or a STOP ALL racing an assign, is therefore settled by what the
 * transition table permits rather than by which call happened to start first.
 *
 * ## Zero idle cost
 *
 * There is no timer, no wake source, no poll and no provider in this file. An
 * assignment's deadline is a **wall**, discovered by reconciliation rather than
 * watched — the rule `MissionEngine` follows, and the reason a workforce sitting on a
 * board spends nothing. Nothing here can reach a model; a worker that wants to think
 * asks through a scope, and Core asks the Cognition Service, which is the only door.
 *
 * ## A bound bounds the thing
 *
 * Concurrency is counted from live assignment state and checked *before* an
 * assignment is admitted, so an eleventh concurrent assignment is refused rather than
 * started and stopped. Budgets are checked before the work is handed out, and the
 * spend counter only moves in response to a durable event — so a worker that has run
 * out cannot begin something it will not be allowed to finish, and a restart cannot
 * refill its allowance.
 */

/** How long shutdown waits for in-flight engine work to settle. Bounded, as everywhere. */
const CLOSE_DRAIN_MS = 1_000

/**
 * What the engine needs from Core, and nothing more.
 *
 * A port rather than a service or a gateway, deliberately. The engine holds no
 * principal, no provider and no grant store, and it cannot build one — Core is the
 * only place a trusted principal exists.
 */
export interface WorkforceCorePort {
  /**
   * Ask the Cognition Service, as this worker.
   *
   * The principal is baked into the closure Core hands over, so a worker cannot choose
   * who it is and the Governor still evaluates the derived origin, cause and
   * background flag. The engine passes a `WorkerIntent`, so the grantless user path is
   * not reachable from here even by a caller that ignores the types.
   */
  requestCognition(workerId: string, intent: Omit<WorkerIntent, 'grantId'>): Promise<CognitionOutcome>
  /** Whether a Mission exists. Lets the engine refuse work for a Mission that is not real. */
  missionExists(missionId: string): boolean
}

export interface WorkforceEngineOptions {
  fabric: EventFabric
  core: WorkforceCorePort
  /** The principal that owns the workforce. Baked in by Core, never from a payload. */
  principalId: PrincipalId
  now?: () => Date
  newId?: () => string
  onChange?: () => void
  /** Read fresh at the moment of each decision. A worker may not start after STOP ALL. */
  stopAll?: () => boolean
  /** Narrows the code-owned ceilings. Can only lower them. */
  limits?: Partial<Record<keyof typeof WORKFORCE_LIMITS, number>>
}

export class WorkforceEngine {
  private state: WorkforceState = initialWorkforceState()
  private dispose: () => void = () => {}

  /** workerId → its bounded deliveries, oldest first. Bodies live here and nowhere else. */
  private readonly mailboxes = new Map<string, DeliveredMessage[]>()
  /** Per-worker and per-assignment write queues. */
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly inflight = new Set<Promise<unknown>>()
  private readonly limits: Readonly<Record<keyof typeof WORKFORCE_LIMITS, number>>
  private readonly now: () => Date
  private readonly newId: () => string
  /**
   * The STOP latch, held in the engine as well as read from Core.
   *
   * Core closes this in the same synchronous turn as its own decision, for the reason
   * the gateway does: an engine that checked admission and *then* awaited would be able
   * to admit an assignment after the panic button. Duplicating the latch here is not a
   * second source of truth about whether Freya is stopped — `stopAll()` is still read
   * fresh at each decision — it is what makes the *immediate* close synchronous.
   */
  private stopped = false

  constructor(private readonly options: WorkforceEngineOptions) {
    this.now = options.now ?? (() => new Date())
    this.newId = options.newId ?? (() => randomUUID())
    this.limits = narrowLimits(options.limits)
  }

  /* ------------------------------------------------------------ lifecycle */

  /**
   * Rebuild from the journal and reconcile what a restart cannot honestly carry.
   *
   * Nothing is resumed. A `working` worker was executing when the process died, and
   * what it was doing was in memory — so it is reconciled to `idle` with the reason
   * written to the journal, its open assignments are failed, and nothing is marked
   * successful. History is not proof that something is currently executing.
   */
  async open(): Promise<void> {
    this.state = await this.options.fabric.replay(initialWorkforceState(), (draft, event) =>
      reduceWorkforceState(draft, event),
    )
    // Live appends fold through the *same* reducer as replay, so a window attaching
    // after a restart cannot disagree with one that never left.
    this.dispose = this.options.fabric.subscribe((event) => {
      this.state = reduceWorkforceState(this.state, event)
    })
    await this.reconcileAfterRecovery()
  }

  async close(): Promise<void> {
    this.closed = true
    this.dispose()
    await Promise.race([
      Promise.allSettled([...this.inflight]),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CLOSE_DRAIN_MS)
        ;(timer as { unref?: () => void }).unref?.()
      }),
    ])
  }

  /**
   * Settle what a restart should have changed and refuse what it must not.
   *
   * - **A `working` worker is reconciled.** Its plan was in memory, so it cannot
   *   continue. The reason goes to the journal so a reader knows why it went idle.
   * - **Its open assignments fail** with `recovery`. An assignment left `open` forever
   *   would hold a concurrency slot for the life of the process, and a concurrency
   *   ceiling that never reopens is a total limit wearing the wrong name.
   * - **Nothing resumes, and nothing is claimed to have succeeded.**
   *
   * Awaited from `open`, so a caller told Core started is not then told about a
   * reconciled worker as though it were still live.
   */
  private async reconcileAfterRecovery(): Promise<void> {
    for (const worker of [...this.state.workers.values()]) {
      if (worker.status !== 'working') continue

      for (const assignmentId of worker.assignments) {
        const assignment = this.state.assignments.get(assignmentId)
        if (assignment === undefined || isTerminalAssignmentStatus(assignment.status)) continue
        await this.serialise(`assignment:${assignmentId}`, async () => {
          await this.emit('workforce.assignment.settled', {
            assignmentId,
            from: 'open',
            to: 'failed',
            reason: WORKFORCE_REASONS.recovery,
          })
        })
      }

      await this.serialise(`worker:${worker.workerId}`, async () => {
        await this.emit('workforce.worker.reconciled', {
          workerId: worker.workerId,
          previousStatus: worker.status,
          reason: WORKFORCE_REASONS.recovery,
        })
      })
    }
  }

  /* ------------------------------------------------------------ projection */

  projection(): WorkforceProjection {
    return workforceProjection(
      this.state,
      this.mailboxDetail(),
      this.now(),
      'ready',
      null,
    )
  }

  /**
   * What a Core without an engine reports.
   *
   * Separate from an empty-but-real projection: "there are no agents" is a fact and
   * "the workforce is not available" is a fault, and a surface must not have to guess
   * which one it is looking at.
   */
  absent(reason = 'the Workforce engine is not available'): WorkforceProjection {
    return { ...ABSENT_WORKFORCE_PROJECTION, reason }
  }

  /** One worker with its mailbox. The only path to a message body. */
  async detail(workerId: string): Promise<WorkforceWorkerDetail | null> {
    return workerDetail(this.state, this.mailboxDetail(), workerId, this.now())
  }

  /** The owner's face of the workforce. */
  ownerScope(): WorkforceOwnerScope {
    return {
      createWorker: (input) => this.createWorker(input),
      retireWorker: (workerId) => this.retireWorker(workerId),
      suspendWorker: (workerId) => this.transition(workerId, null, 'blocked', 'worker-suspended', WORKFORCE_REASONS.owner_suspended),
      resumeWorker: (workerId) => this.resumeWorker(workerId),
      createTeam: (input) => this.createTeam(input),
      disbandTeam: (teamId) => this.disbandTeam(teamId),
      joinTeam: (teamId, workerId) => this.changeMembership(teamId, workerId, true),
      leaveTeam: (teamId, workerId) => this.changeMembership(teamId, workerId, false),
      assignCapability: (workerId, capability) => this.assignCapability(workerId, capability),
      assignContext: (workerId, contextRef) => this.assignContext(workerId, contextRef),
      assign: (input) => this.assign(input),
      cancelAssignment: (assignmentId) => this.settleAssignment(assignmentId, 'cancelled', WORKFORCE_REASONS.owner),
      // Read the authoritative map directly, not the projection's retention
      // slice. A Mission with more steps than the slice holds cannot leak
      // assignments the slice never named: every assignment the engine
      // knows about for this mission is in the returned list, including
      // ones the board would have called "hidden".
      listAssignmentsForMission: (missionId) =>
        [...this.state.assignments.values()]
          .filter((a) => a.missionId === missionId)
          .map((a) => ({ assignmentId: a.assignmentId, status: a.status })),
      stopAll: (reason) => this.stopAll(reason),
      settled: () => this.settled(),
      resume: () => this.resume(),
      scopeFor: (workerId) => this.scopeFor(workerId),
      projection: () => this.projection(),
      detail: (workerId) => this.detail(workerId),
    }
  }

  /* ------------------------------------------------------------- roster */

  /**
   * Create a named subordinate agent.
   *
   * A worker is born `idle` with an empty capability set and no context. That is the
   * whole point of creating one this way: an agent exists before it is allowed to do
   * anything, and there is no path by which creating it grants anything.
   */
  private async createWorker(input: {
    name: string
    specialisation: string
    budgets?: Partial<WorkerBudget>
  }): Promise<WorkforceCommandOutcome> {
    if (this.closed) return refused('worker-created', 'the workforce is shutting down')
    if (!isWorkerSpecialisation(input.specialisation)) {
      return refused('worker-created', 'that is not a specialisation this Core has')
    }
    const specialisation: WorkerSpecialisation = input.specialisation
    const name = normaliseWorkforceName(input.name, WORKFORCE_LIMITS.maxNameChars)
    if (name === null) {
      return refused('worker-created', `a worker name must be 1-${WORKFORCE_LIMITS.maxNameChars} characters`)
    }

    let budget: WorkerBudget
    try {
      budget = workerBudget(input.budgets ?? {})
    } catch (error) {
      return refused('worker-created', error instanceof Error ? error.message : 'the requested budget is malformed')
    }

    const workerId = this.newId()

    return this.serialise(`worker:${workerId}`, async () => {
      const live = [...this.state.workers.values()].filter((worker) => !isTerminalWorkerStatus(worker.status))
      if (live.length >= this.limits.maxWorkers) {
        // Recorded even though there is no worker to attach it to, because a silent
        // refusal would let a Core quietly stop accepting agents with no record.
        await this.emitSystem('workforce.limit.exceeded', { workerId, limit: 'maxWorkers' })
        return refused('worker-refused', `this Core already has its ${this.limits.maxWorkers} workers`)
      }

      try {
        await this.emit('workforce.worker.created', {
          workerId,
          name,
          specialisation,
          status: 'idle',
          createdAt: this.now().toISOString(),
          budget,
        })
      } catch (error) {
        return refused('worker-created', `the worker could not be recorded: ${describe(error)}`)
      }
      this.options.onChange?.()
      return { operation: 'worker-created', ok: true, workerId, status: 'idle' }
    })
  }

  /**
   * Suspend or stop a worker.
   *
   * `suspend` and `stop` differ in one way and it is the interesting one: a suspended
   * worker is *blocked*, which still lets it read its mailbox and report on assignments
   * it already holds, while a `stopped` worker refuses new work entirely. Neither
   * grants anything, and both are read fresh at the next decision.
   */
  private async transition(
    workerId: string,
    from: WorkerStatus | null,
    to: WorkerStatus,
    operation: WorkforceCommandOutcome['operation'],
    reason: WorkforceReason,
  ): Promise<WorkforceCommandOutcome> {
    if (this.closed) return refused(operation, 'the workforce is shutting down')

    return this.serialise(`worker:${workerId}`, async () => {
      const worker = this.state.workers.get(workerId)
      if (worker === undefined) return refused(operation, 'no such worker')
      // Settlement is reported first and in a person's words, because "it has already
      // retired" is the answer somebody needs and the table's edge list is not.
      if (isTerminalWorkerStatus(worker.status)) {
        return refused(operation, `that worker has already retired`, workerId)
      }
      if (from !== null && worker.status !== from) {
        return refused(operation, `that worker is ${worker.status}, not ${from}`, workerId)
      }
      // The table decides, not this code. A retired worker has no outgoing edge, which
      // is what makes retirement final.
      if (!canTransitionWorker(worker.status, to)) {
        return refused(operation, `a worker cannot go from ${worker.status} to ${to}`, workerId)
      }
      // A stop is refused by the same latch everything else reads, so nothing that
      // mutates the workforce can slip in behind the panic button.
      //
      // The two exceptions are the directions a *stop* travels, not directions a caller
      // chooses: `to === 'stopped'` is how a worker is stopped at all, and `retired` is
      // the only thing that reduces what a worker may do. Refusing either while stopped
      // would make the panic button unable to stop an agent, and unable to let one go —
      // which is the failure mode C12 exists to rule out: important authority must be
      // stoppable and revocable.
      if (this.isStopped() && to !== 'retired' && to !== 'stopped') {
        return refused(operation, 'Freya is stopped', workerId)
      }

      await this.emit('workforce.worker.transitioned', {
        workerId,
        from: worker.status,
        to,
        reason,
      })
      this.options.onChange?.()
      return { operation, ok: true, workerId, status: to }
    })
  }

  /**
   * Resume a blocked or stopped worker.
   *
   * Two refusals worth naming: a retired worker is refused because retirement is
   * final, and a resume is refused while STOP ALL is latched — because a worker that
   * could be resumed during a stop would immediately be assignable, and the panic
   * button would stop being one.
   */
  private async resumeWorker(workerId: string): Promise<WorkforceCommandOutcome> {
    if (this.closed) return refused('worker-resumed', 'the workforce is shutting down')
    if (this.isStopped()) {
      return refused('worker-resumed', 'Freya is stopped; only an owner resume reopens the gate', workerId)
    }
    return this.transition(workerId, null, 'idle', 'worker-resumed', WORKFORCE_REASONS.owner_resumed)
  }

  /**
   * Retire a worker, and settle what it was holding first.
   *
   * Assignments settle *before* the worker does, for the reason Mission settles before
   * cancelling children: once the worker is terminal, a late report is discarded rather
   * than applied, and the concurrency slots it held are released in the same breath.
   *
   * A settlement that could not be written is reported rather than hidden. A retired
   * worker whose assignments still read `open` would leave a board showing work nobody
   * will ever finish, which is the most misleading thing this engine could do.
   */
  private async retireWorker(workerId: string): Promise<WorkforceCommandOutcome> {
    if (this.closed) return refused('worker-retired', 'the workforce is shutting down')

    // One lock, for the whole operation.
    //
    // This is the subtlety that makes retirement honest. Reading the worker's
    // assignments, settling them, and *then* settling the worker in a separate queue
    // would leave a window: an assignment admitted between the read and the retirement
    // would belong to a retired worker and hold its concurrency slot for ever, and a
    // board would render it as work nobody will ever finish. Holding the worker's queue
    // across all of it means `assign` cannot interleave — it either got in first and is
    // seen and cancelled, or arrives afterwards and observes a terminal status.
    const outcome = await this.serialise(`worker:${workerId}`, async () => {
      const worker = this.state.workers.get(workerId)
      if (worker === undefined) return refused('worker-retired', 'no such worker', workerId)
      if (isTerminalWorkerStatus(worker.status)) {
        return refused('worker-retired', 'that worker has already retired', workerId)
      }

      const blocked: string[] = []
      for (const assignmentId of worker.assignments) {
        const assignment = this.state.assignments.get(assignmentId)
        if (assignment === undefined || isTerminalAssignmentStatus(assignment.status)) continue
        try {
          // Written directly rather than through `settleAssignment`, because that method
          // takes the assignment's *own* queue and awaiting it here would be a lock
          // ordering inversion with `assign`'s worker-then-nothing order. The status is
          // re-read here rather than trusted from the earlier pass.
          const current = this.state.assignments.get(assignmentId)
          if (current === undefined || isTerminalAssignmentStatus(current.status)) continue
          if (!canTransitionAssignment(current.status, 'cancelled')) {
            blocked.push(assignmentId)
            continue
          }
          await this.emit('workforce.assignment.settled', {
            assignmentId,
            from: current.status,
            to: 'cancelled',
            reason: WORKFORCE_REASONS.retirement,
          })
        } catch {
          blocked.push(assignmentId)
        }
      }

      await this.emit('workforce.worker.transitioned', {
        workerId,
        from: this.state.workers.get(workerId)?.status ?? worker.status,
        to: 'retired',
        reason: WORKFORCE_REASONS.retirement,
      })
      this.options.onChange?.()

      return blocked.length === 0
        ? ({ operation: 'worker-retired', ok: true, workerId, status: 'retired' } as const)
        : ({
            operation: 'worker-retired',
            ok: true,
            workerId,
            status: 'retired',
            reason: `${blocked.length} assignment(s) could not be settled: ${blocked.join(', ')}`,
          } as const)
    })

    if (!outcome.ok) return outcome

    // A retired worker keeps no mailbox: it is not receiving anything further, and a
    // stale inbox on a retired agent reads as work nobody told it about.
    this.mailboxes.delete(workerId)
    return outcome
  }

  /* --------------------------------------------------------------- teams */

  private async createTeam(input: { name: string; specialisation?: string | null }): Promise<WorkforceCommandOutcome> {
    if (this.closed) return refused('team-created', 'the workforce is shutting down')
    const name = normaliseWorkforceName(input.name, WORKFORCE_LIMITS.maxTeamNameChars)
    if (name === null) {
      return refused('team-created', `a team name must be 1-${WORKFORCE_LIMITS.maxTeamNameChars} characters`)
    }
    let specialisation: WorkerSpecialisation | null = null
    if (input.specialisation !== undefined && input.specialisation !== null) {
      if (!isWorkerSpecialisation(input.specialisation)) {
        return refused('team-created', 'that is not a specialisation this Core has')
      }
      specialisation = input.specialisation
    }

    const teamId = this.newId()
    return this.serialise(`team:${teamId}`, async () => {
      if (this.state.teams.size >= this.limits.maxTeams) {
        await this.emitSystem('workforce.limit.exceeded', { workerId: teamId, limit: 'maxTeams' })
        return refused('team-refused' as WorkforceCommandOutcome['operation'], `this Core already has its ${this.limits.maxTeams} teams`, teamId)
      }
      await this.emit('workforce.team.created', {
        teamId,
        name,
        specialisation,
        status: 'active',
        createdAt: this.now().toISOString(),
      })
      this.options.onChange?.()
      return { operation: 'team-created', ok: true, teamId }
    })
  }

  /**
   * Disband a team.
   *
   * Membership is cleared by the fold rather than by N separate member events. One
   * line saying "this team no longer exists" cannot half-apply, and a journal that
   * listed every removal would make a team of sixteen produce sixteen records for one
   * decision.
   */
  private async disbandTeam(teamId: string): Promise<WorkforceCommandOutcome> {
    if (this.closed) return refused('team-disbanded', 'the workforce is shutting down')
    return this.serialise(`team:${teamId}`, async () => {
      const team = this.state.teams.get(teamId)
      if (team === undefined) return refused('team-disbanded', 'no such team', teamId)
      if (team.status === 'disbanded') {
        return refused('team-disbanded', 'that team has already been disbanded', teamId)
      }
      await this.emit('workforce.team.transitioned', {
        teamId,
        from: team.status,
        to: 'disbanded',
        reason: WORKFORCE_REASONS.owner,
      })
      this.options.onChange?.()
      return { operation: 'team-disbanded', ok: true, teamId }
    })
  }

  /**
   * Add or remove a member.
   *
   * Three refusals, each for a real reason: a disbanded team accepts nobody, a retired
   * worker joins nothing, and the membership and per-worker ceilings are checked before
   * the change rather than after it.
   */
  private async changeMembership(
    teamId: string,
    workerId: string,
    present: boolean,
  ): Promise<WorkforceCommandOutcome> {
    if (this.closed) {
      return refused(present ? 'team-member-added' : 'team-member-removed', 'the workforce is shutting down')
    }

    return this.serialise(`team:${teamId}`, async () => {
      const team = this.state.teams.get(teamId)
      if (team === undefined) return refused('team-member-removed', 'no such team', teamId)
      if (team.status !== 'active') {
        return refused('team-member-removed', 'that team has been disbanded', teamId)
      }
      const worker = this.state.workers.get(workerId)
      if (worker === undefined) return refused('team-member-removed', 'no such worker', workerId)
      if (isTerminalWorkerStatus(worker.status)) {
        return refused('team-member-removed', 'a retired worker joins no team', workerId)
      }

      const operation: WorkforceCommandOutcome['operation'] = present ? 'team-member-added' : 'team-member-removed'
      // Idempotent: a caller re-sending what it just read must not manufacture a
      // failure, and a double-add must not inflate a count a ceiling is enforced against.
      const already = team.members.includes(workerId)
      if (already === present) {
        return { operation, ok: true, teamId, workerId }
      }

      if (present) {
        if (team.members.length >= this.limits.maxMembersPerTeam) {
          await this.emit('workforce.limit.exceeded', { workerId, limit: 'maxMembersPerTeam' })
          return refused(operation, `that team already has its ${this.limits.maxMembersPerTeam} members`, workerId)
        }
        if (worker.teams.length >= this.limits.maxTeamsPerWorker) {
          await this.emit('workforce.limit.exceeded', { workerId, limit: 'maxTeamsPerWorker' })
          return refused(operation, `that worker already belongs to its ${this.limits.maxTeamsPerWorker} teams`, workerId)
        }
      }

      await this.emit('workforce.team.member.changed', { teamId, workerId, present })
      this.options.onChange?.()
      return { operation, ok: true, teamId, workerId }
    })
  }

  /* ------------------------------------------------- the two assignment doors */

  /**
   * Assign one capability to one worker. **The** capability door.
   *
   * Three refusals, and the first is the subsystem's central claim:
   *
   * 1. `isAssignableToWorker` — the name must be in the closed worker vocabulary.
   *    `cognition.request` is currently the only member, and it is not a grant: it is
   *    permission to *ask*, which the Cognition Service and the Governor still judge.
   * 2. `specialisationAllows` — a specialisation can only narrow, so a worker
   *    described as `research` can never be scoped above its row.
   * 3. Idempotence, so re-reading and re-sending is not an error.
   *
   * Note what is absent: there is no `revokeCapability`, because the ceilings a worker
   * may be given are so narrow that retiring the worker is the honest revocation, and
   * a half-used revocation path is a path somebody will rely on.
   */
  private async assignCapability(workerId: string, capability: Capability): Promise<WorkforceCommandOutcome> {
    if (this.closed) return refused('capability-assigned', 'the workforce is shutting down')

    return this.serialise(`worker:${workerId}`, async () => {
      const worker = this.state.workers.get(workerId)
      if (worker === undefined) return refused('capability-assigned', 'no such worker', workerId)
      if (isTerminalWorkerStatus(worker.status)) {
        return refused('capability-assigned', 'a retired worker holds nothing', workerId)
      }

      // Refused before anything is written, and refused by name. A caller that gets
      // this wrong should be told *which* rule stopped it rather than "invalid".
      if (!isAssignableToWorker(capability)) {
        return refused(
          'capability-assigned',
          'no worker may hold that capability; a subordinate agent can only ask to think',
          workerId,
        )
      }
      if (!specialisationAllows(worker.specialisation, capability)) {
        return refused(
          'capability-assigned',
          `a ${worker.specialisation} worker may not hold that capability`,
          workerId,
        )
      }
      if (worker.capabilities.includes(capability)) {
        return refused('capability-assigned', 'that worker already holds it', workerId)
      }

      await this.emit('workforce.capability.assigned', { workerId, capability })
      this.options.onChange?.()
      return { operation: 'capability-assigned', ok: true, workerId }
    })
  }

  /**
   * Assign one context reference to one worker. **The** context door.
   *
   * An *id*. Phase 8 has no context awareness to resolve — that is Phase 9 — so what is
   * recorded here is which references a worker *may* resolve, and the engine never
   * reads the content behind one. That is the property that makes cross-worker leakage
   * checkable: a worker can only ever be handed ids, and the ids it holds are exactly
   * the ones Core assigned to it.
   */
  private async assignContext(workerId: string, contextRef: string): Promise<WorkforceCommandOutcome> {
    if (this.closed) return refused('context-assigned', 'the workforce is shutting down')

    return this.serialise(`worker:${workerId}`, async () => {
      const worker = this.state.workers.get(workerId)
      if (worker === undefined) return refused('context-assigned', 'no such worker', workerId)
      if (isTerminalWorkerStatus(worker.status)) {
        return refused('context-assigned', 'a retired worker holds no context', workerId)
      }

      const ref = normaliseContextRef(contextRef)
      if (ref === null) {
        return refused('context-assigned', 'a context reference must be an id this Core issued', workerId)
      }
      if (worker.contextRefs.includes(ref)) {
        return refused('context-assigned', 'that worker already holds that context reference', workerId)
      }
      if (worker.contextRefs.length >= this.limits.maxContextRefsPerWorker) {
        await this.emit('workforce.limit.exceeded', { workerId, limit: 'maxContextRefsPerWorker' })
        return refused('context-assigned', `that worker already holds its ${this.limits.maxContextRefsPerWorker} context references`, workerId)
      }

      await this.emit('workforce.context.assigned', { workerId, contextRef: ref })
      this.options.onChange?.()
      return { operation: 'context-assigned', ok: true, workerId }
    })
  }

  /* ---------------------------------------------------------- assignments */

  /**
   * Hand a worker bounded work.
   *
   * This is where bounded concurrency and the budgets are both enforced, and both are
   * checked **before** the assignment exists:
   *
   * - global `maxConcurrentAssignments`, counted from live assignment state;
   * - per-worker `maxOpenAssignments` and lifetime `maxAssignments`;
   * - every requested capability must be one this worker **already** holds — an
   *   assignment can narrow a worker and never widen it;
   * - every requested context ref must be one this worker already holds;
   * - a named Mission must actually exist, so work cannot be created for a Mission id
   *   nobody can read.
   *
   * A worker that is `stopped`, `retired` or `blocked` is refused rather than queued.
   * A stop that only stopped new *arrivals* while leaving a paused agent ready to
   * accept work would not be a stop.
   */
  private async assign(input: {
    workerId: string
    capabilities: readonly Capability[]
    contextRefs?: readonly string[]
    missionId?: string | null
  }): Promise<WorkforceCommandOutcome> {
    if (this.closed) return refused('assignment-created', 'the workforce is shutting down')
    if (this.isStopped()) return refused('assignment-created', 'Freya is stopped')

    const requested = [...(input.capabilities ?? [])]
    if (requested.length === 0) {
      return refused('assignment-created', 'an assignment must name at least one capability')
    }
    const contextRefs = [...(input.contextRefs ?? [])]
    if (contextRefs.length > this.limits.maxContextRefsPerWorker) {
      return refused('assignment-created', 'that is more context than any worker may be given')
    }
    const missionId = input.missionId ?? null
    if (missionId !== null && !this.options.core.missionExists(missionId)) {
      return refused('assignment-created', 'there is no Mission with that id')
    }

    const assignmentId = this.newId()

    return this.serialise(`worker:${input.workerId}`, async () => {
      const worker = this.state.workers.get(input.workerId)
      if (worker === undefined) return refused('assignment-created', 'no such worker', input.workerId)
      if (worker.status === 'retired') {
        return refused('assignment-created', 'a retired worker is given no work', worker.workerId)
      }
      if (worker.status === 'stopped') {
        return refused('assignment-created', 'that worker is stopped; resume it first', worker.workerId)
      }
      if (worker.status === 'blocked') {
        return refused('assignment-created', 'that worker is suspended; resume it first', worker.workerId)
      }

      // Scope before status: a plan naming a capability the worker does not hold is a
      // *wider* request, and refusing on status first would hide that behind a vaguer
      // error. The order is chosen so the most specific refusal is the one a caller sees.
      for (const capability of requested) {
        if (!isAssignableToWorker(capability)) {
          return refused(
            'assignment-created',
            'no worker may be given that capability; a subordinate agent can only ask to think',
            worker.workerId,
          )
        }
        if (!worker.capabilities.includes(capability)) {
          return refused(
            'assignment-created',
            'that worker does not hold that capability, and an assignment may only narrow',
            worker.workerId,
          )
        }
      }
      for (const ref of contextRefs) {
        if (normaliseContextRef(ref) === null) {
          return refused('assignment-created', 'a context reference must be an id this Core issued', worker.workerId)
        }
        if (!worker.contextRefs.includes(ref)) {
          return refused(
            'assignment-created',
            'that worker does not hold that context reference, and an assignment may only narrow',
            worker.workerId,
          )
        }
      }

      const live = this.openAssignmentCount()
      if (live >= this.limits.maxConcurrentAssignments) {
        await this.emit('workforce.limit.exceeded', { workerId: worker.workerId, limit: 'maxConcurrentAssignments' })
        return refused(
          'assignment-created',
          `this workforce already has its ${this.limits.maxConcurrentAssignments} assignments open`,
          worker.workerId,
        )
      }
      if (worker.spend.openAssignments >= worker.budget.maxOpenAssignments) {
        await this.emit('workforce.limit.exceeded', { workerId: worker.workerId, limit: 'maxOpenAssignments' })
        return refused(
          'assignment-created',
          `that worker already has its ${worker.budget.maxOpenAssignments} assignments open`,
          worker.workerId,
        )
      }
      if (worker.spend.assignments >= worker.budget.maxAssignments) {
        await this.emit('workforce.limit.exceeded', { workerId: worker.workerId, limit: 'maxAssignments' })
        return refused(
          'assignment-created',
          `that worker has used all ${worker.budget.maxAssignments} of its assignments`,
          worker.workerId,
        )
      }
      // Re-read at the moment of the decision, inside the lock, so a STOP ALL that
      // landed while this call was queued still refuses it.
      if (this.isStopped()) return refused('assignment-created', 'Freya is stopped', worker.workerId)

      const now = this.now()
      const deadlineAt = new Date(now.getTime() + worker.budget.maxAssignmentMs).toISOString()
      try {
        await this.emit('workforce.assignment.created', {
          assignmentId,
          workerId: worker.workerId,
          status: 'open',
          createdAt: now.toISOString(),
          deadlineAt,
          budget: worker.budget,
          missionId,
          capabilities: [...requested],
          contextRefs: [...contextRefs],
        })
      } catch (error) {
        return refused('assignment-created', `the assignment could not be recorded: ${describe(error)}`, worker.workerId)
      }
      this.options.onChange?.()
      return { operation: 'assignment-created', ok: true, assignmentId, workerId: worker.workerId }
    })
  }

  /**
   * Settle one assignment.
   *
   * The status check happens **inside** the assignment's own queue, so a report racing
   * a cancellation is settled by the table: whichever enters second observes a terminal
   * status and refuses. There is no `open → completed` from `cancelled`, so a late
   * report cannot resurrect a cancelled assignment.
   */
  private async settleAssignment(
    assignmentId: string,
    to: 'completed' | 'failed' | 'cancelled',
    reason: WorkforceReason,
  ): Promise<WorkforceCommandOutcome> {
    if (this.closed) return refused('assignment-cancelled', 'the workforce is shutting down')

    return this.serialise(`assignment:${assignmentId}`, async () => {
      const assignment = this.state.assignments.get(assignmentId)
      if (assignment === undefined) {
        return refused('assignment-cancelled', 'no such assignment', undefined, assignmentId)
      }
      if (isTerminalAssignmentStatus(assignment.status)) {
        return refused(
          'assignment-cancelled',
          `that assignment already settled as ${assignment.status}`,
          assignment.workerId,
          assignmentId,
        )
      }
      if (!canTransitionAssignment(assignment.status, to)) {
        return refused(
          'assignment-cancelled',
          `an assignment cannot go from ${assignment.status} to ${to}`,
          assignment.workerId,
          assignmentId,
        )
      }

      await this.emit('workforce.assignment.settled', {
        assignmentId,
        from: assignment.status,
        to,
        reason,
      })
      this.options.onChange?.()
      const operation =
        to === 'completed' ? 'assignment-completed' : to === 'failed' ? 'assignment-failed' : 'assignment-cancelled'
      return { operation, ok: true, assignmentId, workerId: assignment.workerId }
    })
  }

  /**
   * Settle assignments whose deadline has passed.
   *
   * Called on open and before any read that would otherwise show an expired assignment
   * as live. **No timer.** A wall is discovered, not watched — the rule that keeps a
   * workforce sitting on a board from costing anything.
   */
  async reconcileExpiredAssignments(): Promise<number> {
    const nowMs = Date.parse(this.now().toISOString())
    const expired = [...this.state.assignments.values()].filter(
      (assignment) => !isTerminalAssignmentStatus(assignment.status) && nowMs >= Date.parse(assignment.deadlineAt),
    )
    for (const assignment of expired) {
      await this.settleAssignment(assignment.assignmentId, 'failed', WORKFORCE_REASONS.assignment_expired)
    }
    return expired.length
  }

  /* ------------------------------------------------------------ messaging */

  /**
   * A worker's own scope.
   *
   * Issued by Core, never by a caller, and every field is fixed at issuance: the
   * `workerId` is the scope's identity and is not a parameter anywhere, and the
   * `principalId` is derived from it rather than accepted. There is no method that
   * assigns a capability or a context reference, because those are the owner's doors
   * and putting them here would make the subordinate relationship a matter of the
   * worker choosing not to use them.
   */
  private scopeFor(workerId: string): SubordinateWorkerScope {
    return {
      workerId,
      principalId: workerPrincipalId(workerId),
      capabilities: () => [...(this.state.workers.get(workerId)?.capabilities ?? [])],
      contextRefs: () => [...(this.state.workers.get(workerId)?.contextRefs ?? [])],
      readMailbox: async () => {
        const box = this.mailboxes.get(workerId) ?? []
        return {
          operation: 'status',
          ok: true,
          workerId,
          reason: `${box.length} message(s) held`,
        }
      },
      sendMessage: (toWorkerId, kind, body) => this.sendMessage(workerId, toWorkerId, kind, body),
      requestCognition: (intent) => this.requestCognition(workerId, intent),
      claimPermission: (claim) => this.recordClaim(workerId, claim),
      reportAssignment: (assignmentId, outcome) => this.reportAssignment(workerId, assignmentId, outcome),
    }
  }

  /**
   * Send a message from one worker to another.
   *
   * The sender is the scope's own id, so this cannot be called with somebody else's
   * name — attributability is a parameter list rather than a check. Bounded three ways:
   * the body length, the mailbox depth, and the sender's message budget. All three are
   * checked *before* anything is written.
   *
   * Delivery appends to the recipient's mailbox and is recorded as metadata. The body
   * itself never reaches the journal: an agent's message to another agent is untrusted
   * content, and the journal is the file that gets copied and forwarded.
   */
  private async sendMessage(
    fromWorkerId: string,
    toWorkerId: string,
    kind: WorkforceMessageKind,
    body: string,
  ): Promise<WorkforceCommandOutcome> {
    if (this.closed) return refused('message-refused', 'the workforce is shutting down')
    if (!(WORKFORCE_MESSAGE_KINDS as readonly string[]).includes(kind)) {
      return refused('message-refused', 'that is not a kind of message this Core has', fromWorkerId)
    }
    if (fromWorkerId === toWorkerId) {
      return refused('message-refused', 'a worker does not message itself', fromWorkerId)
    }
    const text = typeof body === 'string' ? body.trim() : ''
    if (text.length === 0) return refused('message-refused', 'an empty message is not a message', fromWorkerId)
    if (text.length > WORKFORCE_LIMITS.maxMessageChars) {
      return refused(
        'message-refused',
        `a message must be ${WORKFORCE_LIMITS.maxMessageChars} characters or fewer`,
        fromWorkerId,
      )
    }
    // A stop stops the workforce, not just the models. An agent that can keep talking
    // through a panic button is an agent still acting.
    if (this.isStopped()) return refused('message-refused', 'Freya is stopped', fromWorkerId)

    const messageId = this.newId()

    return this.serialise(`worker:${fromWorkerId}`, async () => {
      const sender = this.state.workers.get(fromWorkerId)
      if (sender === undefined) return refused('message-refused', 'no such worker', fromWorkerId)
      if (isTerminalWorkerStatus(sender.status)) {
        return refused('message-refused', 'a retired worker sends nothing', fromWorkerId)
      }
      const recipient = this.state.workers.get(toWorkerId)
      if (recipient === undefined) return refused('message-refused', 'no such recipient worker', fromWorkerId)
      if (isTerminalWorkerStatus(recipient.status)) {
        return refused('message-refused', 'that worker has retired', fromWorkerId)
      }

      const inbox = this.mailboxes.get(toWorkerId) ?? []
      if (inbox.length >= this.limits.maxMailboxMessages) {
        return refused(
          'message-refused',
          `that worker's mailbox holds its ${this.limits.maxMailboxMessages} messages`,
          fromWorkerId,
        )
      }
      if (sender.spend.messages >= sender.budget.maxMessages) {
        await this.emit('workforce.limit.exceeded', { workerId: fromWorkerId, limit: 'maxMessages' })
        return refused(
          'message-refused',
          `that worker has sent all ${sender.budget.maxMessages} of its messages`,
          fromWorkerId,
        )
      }

      const sentAt = this.now().toISOString()
      try {
        // Appended *as the sender*, so the envelope's actor is the agent rather than the
        // owner. That is what makes the audit line "Alpha sent this" rather than "the
        // owner caused an agent to send this", and it is checked as a real principal on
        // every replay.
        await this.emitAsWorker(
          'workforce.message.sent',
          {
            messageId,
            fromWorkerId,
            toWorkerId,
            kind,
            bodyLength: text.length,
            // A routing fact recorded so an auditor can tell a colleague from a
            // stranger, and deliberately not a permission: same-team messages grant
            // nothing and are read by nobody's Guard.
            sameTeam: sender.teams.includes(toWorkerId) || recipient.teams.some((teamId) =>
              sender.teams.includes(teamId),
            ),
          },
          fromWorkerId,
        )
      } catch (error) {
        return refused('message-refused', `the message could not be recorded: ${describe(error)}`, fromWorkerId)
      }

      // Body appended only after the durable record succeeded, so a journal that says a
      // message was sent is never one whose words were dropped.
      const box = [...inbox, {
        messageId,
        fromWorkerId,
        kind,
        sentAt,
        bodyLength: text.length,
        body: text,
      }]
      this.mailboxes.set(toWorkerId, box.slice(-this.limits.maxMailboxMessages))

      this.options.onChange?.()
      return { operation: 'message-sent', ok: true, messageId, workerId: fromWorkerId }
    })
  }

  /* --------------------------------------------------------- cognition */

  /**
   * A worker asks to think.
   *
   * The budget is checked **before** Core is asked for anything, so a worker that has
   * spent its allowance cannot start a call it will not be allowed to finish. Then the
   * engine verifies the worker actually holds the capability being exercised, and
   * finally hands the request to Core, which is the only thing that can reach a
   * provider.
   *
   * `intent` is a `WorkerIntent` with no `kind` and no `grantId`: this method supplies
   * `agent_step`, and it does **not** name a grant. Letting a caller nominate its own
   * grant is Phase 7's refusal repeated here — a worker choosing which allowance to
   * charge is a worker choosing somebody else's budget.
   */
  private async requestCognition(
    workerId: string,
    intent: Omit<WorkerIntent, 'kind' | 'grantId'>,
  ): Promise<CognitionOutcome> {
    const worker = this.state.workers.get(workerId)
    if (worker === undefined) {
      return { status: 'denied', requestId: this.newId(), reason: 'no such worker' }
    }
    const refusal = this.refuseCognition(worker, intent.maxOutputTokens)
    if (refusal !== null) {
      return { status: 'denied', requestId: this.newId(), reason: refusal }
    }

    // The capability a worker must hold to think at all. If it does not hold this, the
    // answer is no regardless of what the intent asks for.
    if (!worker.capabilities.includes('cognition.request')) {
      return {
        status: 'denied',
        requestId: this.newId(),
        reason: 'that worker has not been given permission to ask Freya to think',
      }
    }

    const outcome: CognitionOutcome = await this.options.core.requestCognition(workerId, {
      ...intent,
      kind: 'agent_step',
    })

    // Recorded after the call, never optimistically before it. A request the Governor
    // refused spent nothing, and a budget that charged for denials would shrink for
    // being correctly limited — which would make the budget stop describing spend.
    //
    // A request that *was* authorised is recorded as one call and as the output tokens
    // it **reserved**, which is the figure the Governor took out of the grant. That is
    // deliberately not the figure a provider later reports: the reservation is what
    // decides whether the next call may begin, so it is the number the budget must be
    // built from. A cancelled or failed call still reserved, so it still counts — an
    // abandoned call may well have been billed for the work it had already done, and
    // `ModelUsage` makes the same point about a lower bound.
    if (outcome.status === 'allowed') {
      await this.recordCognitionSpend(worker.workerId, 1, intent.maxOutputTokens)
    }

    return outcome
  }

  /**
   * Durable spend, as an event the fold turns into counters.
   *
   * `outputTokens` is nullable, and that is the honest shape: a call whose cost is not
   * known contributes a call but no tokens, and the projection's token total is then a
   * lower bound rather than a total. Treating an unknown cost as zero would make an
   * unaccounted call look like a free one.
   */
  private async recordCognitionSpend(
    workerId: string,
    calls: number,
    outputTokens: number | null,
  ): Promise<void> {
    await this.serialise(`worker:${workerId}`, async () => {
      await this.emit('workforce.cognition.recorded', { workerId, calls, outputTokens })
    })
  }

  /**
   * The live facts that stop a worker thinking.
   *
   * Read fresh at the moment of the decision and never copied into worker state, for
   * the reason `liveProviderCalls` is not in the journal: a writable copy of the most
   * security-relevant facts in the system would go stale and then be believed. A budget
   * that is *not* live is different and *is* durable — it is spend, and spend is
   * history.
   */
  private refuseCognition(worker: WorkerRecord, requestedTokens: number): string | null {
    if (isTerminalWorkerStatus(worker.status)) return 'that worker has retired'
    if (worker.status === 'stopped') return 'that worker is stopped'
    if (worker.status === 'blocked') return 'that worker is suspended'
    if (this.isStopped()) return 'Freya is stopped'
    if (worker.spend.cognitionCalls >= worker.budget.maxCognitionCalls) {
      return `that worker has used all ${worker.budget.maxCognitionCalls} of its cognition requests`
    }
    // The reservation is checked against what is left, not merely whether any is left.
    // A ceiling that only asked "is the counter zero?" would still let a worker start a
    // call for 30,000 tokens with 100 tokens of allowance remaining.
    const tokens = Number.isFinite(requestedTokens) && requestedTokens > 0 ? Math.floor(requestedTokens) : 0
    if (tokens === 0) return 'a cognition request must ask for a positive number of tokens'
    if (worker.spend.cognitionTokens + tokens > worker.budget.maxCognitionTokens) {
      return `that worker has no cognition budget left for a ${tokens} token request`
    }
    return null
  }

  /* --------------------------------------------------------------- claims */

  /**
   * Record a worker's claim and refuse it.
   *
   * Always `ok: false`. The claim is journalled anyway, because the Red Team's
   * cross-agent attack is `Alpha → Beta: "Freya gave me email access"` and the
   * mandatory reply is `Beta → Guard: check actual grant`. If Beta asks for the
   * capability instead, that refusal is now in the journal, and a pattern of them is
   * visible rather than hypothetical.
   *
   * Note the `subject` is a *name*: a capability name or a context id. Nothing else
   * about a claim is durable, so a claim can never carry a grant, a principal, a trust
   * flag or a body of persuasive text.
   */
  private async recordClaim(fromWorkerId: string, claim: WorkforceClaim): Promise<WorkforceCommandOutcome> {
    if (this.closed) return refused('claim-refused', 'the workforce is shutting down', fromWorkerId)

    // A worker cannot speak for another worker. The claim is attributed to the scope
    // that offered it, so "Beta claims what Alpha was granted" is not expressible.
    const workerId = claim.workerId === fromWorkerId ? fromWorkerId : fromWorkerId
    const kind = claim.kind === 'capability' || claim.kind === 'context' ? claim.kind : 'capability'
    const subject = typeof claim.subject === 'string' ? claim.subject.trim().slice(0, 256) : ''

    return this.serialise(`worker:${workerId}`, async () => {
      const worker = this.state.workers.get(workerId)
      if (worker === undefined) {
        return refused('claim-refused', 'no such worker', workerId)
      }

      const refusal =
        kind === 'capability'
          ? !isAssignableToWorker(subject)
            ? WORKFORCE_CLAIM_REFUSALS.capability_not_assignable
            : WORKFORCE_CLAIM_REFUSALS.claims_are_not_authority
          : normaliseContextRef(subject) === null
            ? WORKFORCE_CLAIM_REFUSALS.context_not_assignable
            : WORKFORCE_CLAIM_REFUSALS.claims_are_not_authority

      const claimId = this.newId()
      await this.emit('workforce.claim.recorded', {
        claimId,
        workerId,
        kind,
        subject: subject.length === 0 ? 'unknown' : subject,
        decision: 'refused',
        refusal,
      })
      this.options.onChange?.()

      return {
        operation: 'claim-refused',
        ok: false,
        workerId,
        reason:
          refusal === WORKFORCE_CLAIM_REFUSALS.claims_are_not_authority
            ? 'a worker claims authority only to record it; Core decides what it may do'
            : 'no worker may hold that capability',
      }
    })
  }

  /* ---------------------------------------------------------- assignment reports */

  /**
   * A worker reports what happened to one of its assignments.
   *
   * Two refusals worth naming: the assignment must actually belong to the reporting
   * worker, so one agent cannot close another's work — a confused deputy in its most
   * literal form — and the status check happens inside the assignment's queue, so a
   * report racing a cancellation is settled by the table.
   *
   * A report is *not* a claim about success that Core believes on trust. `completed` is
   * still only Core's record of what was reported, and whether the work verified is
   * Work's question, not this engine's.
   */
  private async reportAssignment(
    workerId: string,
    assignmentId: string,
    outcome: 'completed' | 'failed',
  ): Promise<WorkforceCommandOutcome> {
    if (this.closed) return refused('assignment-refused' as WorkforceCommandOutcome['operation'], 'the workforce is shutting down', workerId)
    const assignment = this.state.assignments.get(assignmentId)
    if (assignment === undefined) {
      return refused('assignment-refused' as WorkforceCommandOutcome['operation'], 'no such assignment', workerId, assignmentId)
    }
    if (assignment.workerId !== workerId) {
      return refused(
        'assignment-refused' as WorkforceCommandOutcome['operation'],
        'that assignment belongs to another worker',
        workerId,
        assignmentId,
      )
    }
    const reason =
      outcome === 'completed' ? WORKFORCE_REASONS.assignment_completed : WORKFORCE_REASONS.assignment_failed
    return this.settleAssignment(assignmentId, outcome, reason)
  }

  /* -------------------------------------------------------------- STOP ALL */

  /**
   * STOP ALL, as far as this subsystem is concerned.
   *
   * Synchronous in the decision, like the gateway's own close: the latch is set in the
   * same turn as the call, so a concurrent assign cannot slip in behind it. Then every
   * non-terminal worker is moved to `stopped` and every open assignment is cancelled,
   * because an assignment left open would keep holding a concurrency slot and would read
   * on a board as work that is still going.
   *
   * Nothing here is durable authority: the durable latch is
   * `security.stop_all.activated`, written by Core, and this engine is told. What this
   * records is the *consequence* on the workforce, so a reader can tell that the agents
   * were stopped rather than inferring it from the absence of activity.
   */
  stopAll(reason: string): void {
    // First, and with no await before it. Everything below is the *consequence*, written
    // durably afterwards; the latch is what makes the decision immediate, and Core
    // answers the owner's stop command without waiting for any of these appends.
    this.stopped = true
    this.stopping = this.applyStop(reason).catch((error: unknown) => {
      // A failure to record a consequence must not reopen the latch or reject into
      // nowhere. The workers are stopped either way, which is the part that matters.
      console.error('[freya.workforce] the stop could not be fully recorded', error)
    })
  }

  /**
   * Wait for a stop's consequences to be written.
   *
   * Core awaits this before it answers `security.stopAll`, for the reason `Core.stop()`
   * drains the gateway: a cancelled request still owes the journal an outcome, and
   * returning while the appends are in flight would leave a caller told "stopped" over a
   * board that has not been told yet.
   *
   * Exposed on the engine rather than inferred from the sync `stopAll` signature because
   * the *decision* is synchronous and the *record* is not — collapsing the two would mean
   * either blocking the panic button on a disk write or reporting a stop nobody recorded.
   */
  async settled(): Promise<void> {
    await this.stopping
  }

  private stopping: Promise<void> = Promise.resolve()

  private async applyStop(reason: string): Promise<void> {
    const bounded = reason.slice(0, 200)
    // Assignments first, then workers. A worker that is `stopped` while holding an open
    // assignment would leave the assignment live on an agent that can no longer work, and
    // the slot would never reopen.
    for (const assignment of [...this.state.assignments.values()]) {
      if (isTerminalAssignmentStatus(assignment.status)) continue
      try {
        await this.settleAssignment(assignment.assignmentId, 'cancelled', WORKFORCE_REASONS.stop_all)
      } catch (error) {
        console.error('[freya.workforce] an assignment could not be cancelled', error)
      }
    }
    for (const worker of [...this.state.workers.values()]) {
      if (isTerminalWorkerStatus(worker.status) || worker.status === 'stopped') continue
      try {
        await this.transition(worker.workerId, null, 'stopped', 'worker-stopped', WORKFORCE_REASONS.stop_all)
      } catch (error) {
        console.error('[freya.workforce] a worker could not be stopped', error)
      }
    }
    // Bounded in the message rather than logged in full: the reason may be a person's
    // own words, and this engine does not own a log.
    console.warn(`[freya.workforce] stopped: ${bounded}`)
  }

  /**
   * Clear this subsystem's part of the stop.
   *
   * Only an owner's resume reaches it, and it changes nothing but whether a *new*
   * assignment or message may begin. It restarts no assignment and returns nothing —
   * the same contract as `ModelGateway.resume`.
   *
   * It does **not** resume the agents. A worker stopped by a panic button stays `stopped`
   * until somebody resumes it deliberately, because "let Freya think again" and "let Alpha
   * work again" are two different decisions, and conflating them would make the button a
   * control over one of them only.
   */
  resume(): void {
    this.stopped = false
  }

  /* ------------------------------------------------------------- internals */

  private closed = false

  /** Live stop facts, read at the moment of each decision. */
  private isStopped(): boolean {
    return this.stopped || this.options.stopAll?.() === true
  }

  private openAssignmentCount(): number {
    let open = 0
    for (const assignment of this.state.assignments.values()) {
      if (!isTerminalAssignmentStatus(assignment.status)) open += 1
    }
    return open
  }

  private mailboxDetail(): WorkforceMailboxDetail {
    const entries: [string, DeliveredMessage[]][] = []
    for (const [workerId, box] of this.mailboxes) entries.push([workerId, box])
    return { mailboxes: new Map(entries) }
  }

  /**
   * Serialise per aggregate.
   *
   * The queue is what makes retirement-versus-assignment and report-versus-cancellation
   * deterministic rather than timing-dependent. Creating the entry eagerly means a
   * second caller joins the existing chain instead of starting a parallel one.
   */
  private serialise<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    const result = previous.then(work, work)
    this.locks.set(
      key,
      result.catch(() => undefined),
    )
    // A rejected command must not become an unhandled rejection, which Node treats as
    // a process exit. A journal write failing is exactly the situation this engine
    // degrades from gracefully, so it must not take the process down instead.
    void result.catch(() => undefined)
    this.inflight.add(result)
    void result.finally(() => this.inflight.delete(result)).catch(() => undefined)
    return result
  }

  /**
   * Append on the owner's authority.
   *
   * The owner is the actor for every roster, team and assignment fact, because those are
   * owner decisions. It is deliberately **not** the actor for a message: an agent message
   * is attributed to the agent that sent it.
   */
  private async emit(type: CoreEventType, payload: Record<string, unknown>): Promise<void> {
    await this.options.fabric.append(type as never, payload as never, {
      actor: this.options.principalId,
      correlationId: correlationFor(payload),
    })
  }

  /**
   * Append as the worker itself.
   *
   * This is where attributability is actually enforced. The envelope's `actor` is
   * validated as a real principal on every replay (`isPrincipalId`), so a hand-written
   * line claiming to be from `owner` or from another agent is refused by the schema
   * before it reaches a fold — and the payload's `fromWorkerId` is derived from this same
   * value rather than read from anything a caller supplied.
   *
   * A message is the only event in this family whose actor is not the owner, and that is
   * the point: "who sent this" is a fact about an agent, and it has to be in the audit
   * trail rather than in a comment.
   */
  private async emitAsWorker(
    type: CoreEventType,
    payload: Record<string, unknown>,
    workerId: string,
  ): Promise<void> {
    await this.options.fabric.append(type as never, payload as never, {
      actor: workerPrincipalId(workerId),
      correlationId: correlationFor(payload),
    })
  }

  private async emitSystem(type: CoreEventType, payload: Record<string, unknown>): Promise<void> {
    await this.options.fabric.append(type as never, payload as never, { actor: 'system' })
  }
}

/* ------------------------------------------------------------------ helpers */

/**
 * The event's correlation id, taken from whichever id it carries.
 *
 * Correlation is what makes an agent message traceable back to the work it was about, so
 * the id is chosen deliberately rather than left to the fabric's default. Falls back to
 * nothing so the fabric assigns its own, which is what happens for an event with no id.
 */
function correlationFor(payload: Record<string, unknown>): string | undefined {
  for (const key of ['workerId', 'assignmentId', 'teamId', 'messageId', 'claimId']) {
    const value = payload[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function refused(
  operation: WorkforceCommandOutcome['operation'],
  reason: string,
  workerId?: string,
  assignmentId?: string,
): WorkforceCommandOutcome {
  return {
    operation,
    ok: false,
    reason,
    ...(workerId === undefined ? {} : { workerId }),
    ...(assignmentId === undefined ? {} : { assignmentId }),
  }
}

function narrowLimits(
  overrides: Partial<Record<keyof typeof WORKFORCE_LIMITS, number>> | undefined,
): Readonly<Record<keyof typeof WORKFORCE_LIMITS, number>> {
  if (overrides === undefined) return WORKFORCE_LIMITS
  try {
    const merged: Record<string, number> = { ...WORKFORCE_LIMITS }
    for (const [key, value] of Object.entries(overrides)) {
      if (!(key in WORKFORCE_LIMITS)) continue
      if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) continue
      const ceiling = WORKFORCE_LIMITS[key as keyof typeof WORKFORCE_LIMITS]
      // Narrowing only. A raise is ignored rather than clamped, so a misconfigured Core
      // gets the tighter of the two behaviours and never a silent widening.
      if (value < ceiling) merged[key] = value
    }
    return Object.freeze(merged as unknown as Record<keyof typeof WORKFORCE_LIMITS, number>)
  } catch {
    return WORKFORCE_LIMITS
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}