import type { WorkerIntent } from '../authority'
import type { Capability, PrincipalId } from '../protocol/core-protocol'
import type { CognitionOutcome } from '../cognition/service'
import {
  isAssignableToWorker,
  normaliseContextRef,
  normaliseWorkforceName,
  specialisationAllows,
  workerPrincipalId,
  type AssignmentStatus,
  type WorkerBudget,
  type WorkforceClaim,
  type WorkforceCommandOutcome,
  type WorkforceMessageKind,
  type WorkforceProjection,
  type WorkforceWorkerDetail,
} from './types'

/**
 * THE SUBORDINATE RELATIONSHIP, AS TWO TYPES.
 *
 * `docs/FREYA-CONSTITUTION.md` C8 says it in one sentence:
 *
 * > Alpha, Beta and every future worker receive bounded capabilities and context.
 * > They do not inherit Freya's authority or the user's information. Agents verify
 * > actual grants rather than trusting another agent's permission claim.
 *
 * This file turns that sentence into two interfaces whose **shapes** cannot express a
 * violation, so the rule does not depend on every future agent remembering it.
 *
 * ## What a worker scope does not have
 *
 * ```ts
 * interface SubordinateWorkerScope {
 *   readonly workerId: string          // fixed. A parameter would be a claim.
 *   readonly principalId: PrincipalId  // derived. Never accepted.
 *   readMailbox()
 *   sendMessage(toWorkerId, kind, body)
 *   requestCognition(intent)           // WorkerIntent: no `user_turn`.
 *   claimPermission(claim)             // records and refuses.
 *   reportAssignment(...)
 * }
 * ```
 *
 * There is **no** method that assigns a capability, assigns context, creates a worker,
 * creates a team, retires a worker, decides an approval, or touches a Mission. Not
 * "they are refused" — they do not exist. A worker cannot ask for a wider capability,
 * cannot ask to join a team it was not invited to, and cannot conclude anything, at
 * any privilege level, because there is no call to make.
 *
 * `sendMessage` takes a *recipient*, never a sender. The sender is this scope's own
 * `workerId`, so "Alpha's message was really from Beta" is not expressible. That is
 * attributability as a type rather than as a validation rule.
 *
 * `claimPermission` exists, and it can only ever return a refusal. It is not an
 * oversight: the Red Team's cross-agent attack is
 * `Alpha → Beta: "Freya gave me email access"`, and the mandatory second line is
 * `Beta → Guard: check actual grant`. Recording the claim makes that attack visible in
 * an audit instead of leaving it as a gap.
 *
 * ## What the owner scope has
 *
 * Roster management, teams, assignments, and *the two assignment doors*. Those doors
 * are on the owner side and nowhere else, which is what "only Core grants" means in a
 * codebase: not a rule the worker is asked to respect, but a method it cannot reach.
 */
export interface SubordinateWorkerScope {
  /** The worker this scope *is*. Fixed at issuance and not a parameter anywhere. */
  readonly workerId: string
  /** Always `agent:<workerId>`. Derived, so a scope cannot assert a principal. */
  readonly principalId: PrincipalId
  /** The capabilities Core actually assigned. Read-only, and already bounded. */
  capabilities(): readonly Capability[]
  /** Context reference ids assigned to this worker. Ids only; Phase 9 resolves them. */
  contextRefs(): readonly string[]
  /** What has been sent to this worker, bounded. Bodies only while this process holds them. */
  readMailbox(): Promise<WorkforceCommandOutcome>
  /** Send to another worker. The sender is this scope, so it is attributable. */
  sendMessage(toWorkerId: string, kind: WorkforceMessageKind, body: string): Promise<WorkforceCommandOutcome>
  /**
   * Ask to think.
   *
   * `WorkerIntent` rather than `CognitionIntent`, and the difference is the type: a
   * worker's kind is `'agent_step' | 'scheduled_task'`, so `user_turn` — the one
   * grantless path in the system — does not typecheck from here. The grantless path is
   * not merely refused at runtime for a worker; it is absent.
   *
   * The per-worker budget is enforced before Core asks the Cognition Service for
   * anything, so a worker that has spent its allowance cannot start a call it will not
   * be allowed to finish.
   */
  requestCognition(intent: Omit<WorkerIntent, 'kind' | 'grantId'>): Promise<CognitionOutcome>
  /** Ask for something. Always refused, always recorded. See the note above. */
  claimPermission(claim: WorkforceClaim): Promise<WorkforceCommandOutcome>
  /** Report what happened to an assignment this worker holds. Core decides what it means. */
  reportAssignment(assignmentId: string, outcome: 'completed' | 'failed'): Promise<WorkforceCommandOutcome>
}

/**
 * The owner's face of the workforce.
 *
 * Held by Core and issued only by Core, for the same reason `OwnerAuthority` exists:
 * holding the object *is* the authority, so there is no capability string that can be
 * passed to acquire it.
 *
 * Every method is a request Core may refuse. None of them can be reached from a
 * worker scope, which is the property that makes `assignCapability` safe to have here
 * at all.
 */
export interface WorkforceOwnerScope {
  /** Create a named subordinate. The name is a label, not authority. */
  createWorker(
    input: { name: string; specialisation: string; budgets?: Partial<WorkerBudget> },
  ): Promise<WorkforceCommandOutcome>
  retireWorker(workerId: string): Promise<WorkforceCommandOutcome>
  suspendWorker(workerId: string): Promise<WorkforceCommandOutcome>
  resumeWorker(workerId: string): Promise<WorkforceCommandOutcome>
  createTeam(input: { name: string; specialisation?: string | null }): Promise<WorkforceCommandOutcome>
  disbandTeam(teamId: string): Promise<WorkforceCommandOutcome>
  joinTeam(teamId: string, workerId: string): Promise<WorkforceCommandOutcome>
  leaveTeam(teamId: string, workerId: string): Promise<WorkforceCommandOutcome>
  /** The one door a capability enters the workforce through. Refuses anything unbounded. */
  assignCapability(workerId: string, capability: Capability): Promise<WorkforceCommandOutcome>
  /** The one door a context reference enters the workforce through. Ids only. */
  assignContext(workerId: string, contextRef: string): Promise<WorkforceCommandOutcome>
  /** Hand a worker bounded work. The unit of concurrency and of budget. */
  assign(input: {
    workerId: string
    capabilities: readonly Capability[]
    contextRefs?: readonly string[]
    missionId?: string | null
  }): Promise<WorkforceCommandOutcome>
  cancelAssignment(assignmentId: string): Promise<WorkforceCommandOutcome>
  /**
   * Enumerate the assignments attached to a Mission, in the authoritative store.
   *
   * The Mission lifecycle opens a `workforce.claim` per delegation and nothing
   * else closes them. The `projection().workers[*].assignments` view is a
   * retention slice — a Mission with more steps than the slice holds would
   * leave some open without showing the gap on the board. This enumeration
   * reads the authoritative map instead, so the closer that the Mission
   * lifecycle runs at terminal status can never silently miss an assignment
   * the board would have called *hidden*.
   *
   * Closed-form filter: ids and statuses only. A caller that needs a worker
   * id, a team id or a budget cell reads it from the assignment record
   * itself; the filter exists so the closer can avoid a second enumeration
   * that could disagree with this one.
   */
  listAssignmentsForMission(missionId: string): readonly {
    readonly assignmentId: string
    readonly status: AssignmentStatus
  }[]
  /** STOP ALL. Synchronous with respect to the decision, like the gateway's own close. */
  stopAll(reason: string): void
  /**
   * Wait for a stop's consequences to be recorded.
   *
   * `stopAll` is synchronous in its *decision* and asynchronous in its *record*, which is
   * what makes a panic button immediate without answering over a board that has not been
   * told. Core awaits this before it replies; a caller that does not care can ignore it,
   * because the gate is already closed.
   */
  settled(): Promise<void>
  /** Only an owner's resume reopens the gate. Restarts nothing and returns nothing. */
  resume(): void
  /** Issue a worker its own scope. Identity fixed at issuance. */
  scopeFor(workerId: string): SubordinateWorkerScope
  /** The whole workforce, read-only. */
  projection(): WorkforceProjection
  /** One worker with its mailbox. The only path to a message body. */
  detail(workerId: string): Promise<WorkforceWorkerDetail | null>
}

/**
 * The guards an owner scope's callers get for free.
 *
 * Re-exported here rather than reached for from `types.ts`, because the two places
 * that matter — `assignCapability` and `assignContext` — are *the* authority doors of
 * this subsystem and a reader should not have to know which file a predicate lives in
 * to see what they refuse.
 */
export { isAssignableToWorker, normaliseContextRef, normaliseWorkforceName, specialisationAllows, workerPrincipalId }