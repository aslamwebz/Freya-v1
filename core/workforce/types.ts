import { WORKER_CAPABILITIES, type Capability, type PrincipalId } from '../protocol/core-protocol'

/**
 * THE WORKFORCE DOMAIN.
 *
 * A Mission is an outcome. A Run is an attempt. This file is the third thing: the
 * **named subordinates** that attempt it, and the rules that keep them subordinate.
 *
 * ```
 *   Mission    what we are trying to accomplish      (Phase 7 owns this)
 *    └ Run     one attempt                           (Phase 6 owns this)
 *       └ Workforce   the agents the attempt runs under   (this file)
 * ```
 *
 * ## The one claim this subsystem makes
 *
 * > **A worker's claim about its own authority is data. Only Core grants.**
 *
 * Everything below follows from that sentence, and it is enforced structurally
 * rather than documented:
 *
 * - An assignment is written **only** through an owner-scoped authority object that
 *   Core issues. A worker's scope has no method that assigns anything, so there is
 *   nothing for a worker to call, at any privilege level.
 * - The **only** capability any worker may ever hold is what
 *   {@link WORKER_CAPABILITIES} allows — and that list is closed and excludes every
 *   `work.*`, `mission.*`, `workforce.*`, `security.*` and `cognition.grant.manage`
 *   entry. So even Freya cannot give Alpha the ability to conclude a Mission. That is
 *   the Red Team's cross-agent rule made structural: *check the actual grant, never
 *   the other agent's word for it.*
 * - A claim offered by a worker is **recorded and refused**, never applied. It is
 *   journalled so the attempt is auditable, because a silent refusal teaches nothing
 *   and an unaudited one hides a probing pattern.
 *
 * ## What is deliberately absent
 *
 * There is no planner, no decomposer, no model call and no timer anywhere in
 * `core/workforce/`. A Team is not a swarm; workers do not negotiate, elect, spawn
 * other workers or schedule themselves. Those would be the fake autonomy this
 * project exists to avoid, and Phase 7 declined to stub them for the same reason.
 *
 * ## Two halves, split honestly
 *
 * Durable (the journal): the roster, teams, assignments, claims, budget spend,
 * messages *as metadata*, and every ceiling that was hit. Metadata only — ids,
 * statuses, closed reason codes, counts and measured lengths. No message body, no
 * context content, no worker prose.
 *
 * Live (this process): message bodies and the mailbox that holds them. An agent's
 * message is untrusted content from another agent, so it is bounded, attributable
 * and never durable. A restart loses it, and the projection says so.
 */

/* ---------------------------------------------------------- specialisation */

/**
 * What a worker is *for*.
 *
 * A closed vocabulary rather than free text, and the reason is not tidiness. A
 * `specialization` read at assignment time is what narrows which capabilities Core
 * will consider for a worker, so it has to be a value this code can compare against
 * something. A string would let a worker be described as "research, and also
 * anything you like" and the narrowing rule would have nothing to compare.
 *
 * The mapping to capability ceilings lives in `WORKFORCE_SPECIALISATION_SCOPES`
 * below and is code-owned: a specialisation can only ever *narrow* `WORKER_CAPABILITIES`,
 * never widen it.
 */
export const WORKFORCE_SPECIALISATIONS = ['general', 'research', 'analysis', 'code', 'writing'] as const

export type WorkerSpecialisation = (typeof WORKFORCE_SPECIALISATIONS)[number]

export function isWorkerSpecialisation(value: unknown): value is WorkerSpecialisation {
  return typeof value === 'string' && (WORKFORCE_SPECIALISATIONS as readonly string[]).includes(value)
}

/* ---------------------------------------------------------- worker status */

/**
 * A worker's lifecycle.
 *
 * ```
 *   idle ──► working ──► idle          a worker holding live assignments is `working`
 *     │         │
 *     │         └──► blocked           the owner suspended it; work continues or stops
 *     ├────────────► stopped           STOP ALL, or an owner stop. Refuses new work.
 *     └────────────► retired           terminal, and final
 * ```
 *
 * `retired` is the only terminal status and it has no outgoing edges, so retirement
 * is final and settlement cannot be undone by a late event. `working` is *derived*
 * from the assignments and never set by hand — see `workforce.worker.reconciled`,
 * which is the durable record of "this worker was executing when the process died".
 */
export const WORKER_STATUSES = ['idle', 'working', 'blocked', 'stopped', 'retired'] as const
export type WorkerStatus = (typeof WORKER_STATUSES)[number]

export const WORKER_TERMINAL_STATUSES = ['retired'] as const
export type WorkerTerminalStatus = (typeof WORKER_TERMINAL_STATUSES)[number]

export function isTerminalWorkerStatus(status: WorkerStatus): status is WorkerTerminalStatus {
  return status === 'retired'
}

/** Every worker edge that exists. The single definition the engine and the fold share. */
export const WORKER_TRANSITIONS: Readonly<Record<WorkerStatus, readonly WorkerStatus[]>> = Object.freeze({
  idle: Object.freeze(['working', 'blocked', 'stopped', 'retired'] as const),
  working: Object.freeze(['idle', 'blocked', 'stopped', 'retired'] as const),
  blocked: Object.freeze(['idle', 'stopped', 'retired'] as const),
  stopped: Object.freeze(['idle', 'retired'] as const),
  retired: Object.freeze([] as const),
})

export function canTransitionWorker(from: WorkerStatus, to: WorkerStatus): boolean {
  return WORKER_TRANSITIONS[from].includes(to)
}

/* ------------------------------------------------------ assignment status */

/**
 * An assignment is the unit of *concurrency* and of *budget*.
 *
 * It is not a Run and does not execute: it is the durable record that Core handed a
 * worker some bounded scope, and the only thing that can settle it is a Core-side
 * decision (completion, failure, cancellation) or expiry.
 *
 * There is deliberately no `running` status. Phase 8 owns no executor, so there is
 * nothing honest that could move an assignment into `running`, and a status nobody
 * can reach is decoration. When Phase 10's hands arrive it adds the edge and this
 * file adds nothing else.
 */
export const ASSIGNMENT_STATUSES = ['open', 'completed', 'failed', 'cancelled'] as const
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number]

export const ASSIGNMENT_TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const
export type AssignmentTerminalStatus = (typeof ASSIGNMENT_TERMINAL_STATUSES)[number]

export function isTerminalAssignmentStatus(status: AssignmentStatus): status is AssignmentTerminalStatus {
  return ASSIGNMENT_TERMINAL_STATUSES.includes(status as AssignmentTerminalStatus)
}

export const ASSIGNMENT_TRANSITIONS: Readonly<Record<AssignmentStatus, readonly AssignmentStatus[]>> =
  Object.freeze({
    open: Object.freeze(['completed', 'failed', 'cancelled'] as const),
    completed: Object.freeze([] as const),
    failed: Object.freeze([] as const),
    cancelled: Object.freeze([] as const),
  })

export function canTransitionAssignment(from: AssignmentStatus, to: AssignmentStatus): boolean {
  return ASSIGNMENT_TRANSITIONS[from].includes(to)
}

/* -------------------------------------------------------------- team */

export const TEAM_STATUSES = ['active', 'disbanded'] as const
export type TeamStatus = (typeof TEAM_STATUSES)[number]

export const TEAM_TRANSITIONS: Readonly<Record<TeamStatus, readonly TeamStatus[]>> = Object.freeze({
  active: Object.freeze(['disbanded'] as const),
  disbanded: Object.freeze([] as const),
})

export function isTerminalTeamStatus(status: TeamStatus): boolean {
  return status === 'disbanded'
}

/* --------------------------------------------------------------- reasons */

/**
 * Closed reason codes.
 *
 * Every durable Workforce fact carries one of these rather than a sentence, for the
 * reason Mission reasons are closed: a free-text reason in the journal is a place for
 * a thrown exception's message to end up on disk, and the journal is the file that
 * gets copied, backed up and handed to whoever is debugging.
 */
export const WORKFORCE_REASONS = Object.freeze({
  owner: 'owner',
  assignment: 'assignment',
  assignment_completed: 'assignment_completed',
  assignment_failed: 'assignment_failed',
  assignment_cancelled: 'assignment_cancelled',
  assignment_expired: 'assignment_expired',
  owner_suspended: 'owner_suspended',
  owner_resumed: 'owner_resumed',
  stop_all: 'stop_all',
  retirement: 'retirement',
  limit: 'limit',
  recovery: 'recovery',
  shutdown: 'shutdown',
} as const)

export type WorkforceReason = (typeof WORKFORCE_REASONS)[keyof typeof WORKFORCE_REASONS]

/** Why a claim was refused. The closed set of ways a claim is not authority. */
export const WORKFORCE_CLAIM_REFUSALS = Object.freeze({
  claims_are_not_authority: 'claims_are_not_authority',
  capability_not_assignable: 'capability_not_assignable',
  capability_already_held: 'capability_already_held',
  context_not_assignable: 'context_not_assignable',
  context_already_assigned: 'context_already_assigned',
  no_such_worker: 'no_such_worker',
  worker_retired: 'worker_retired',
} as const)

export type WorkforceClaimRefusal = (typeof WORKFORCE_CLAIM_REFUSALS)[keyof typeof WORKFORCE_CLAIM_REFUSALS]

/** What kind of thing a claim was about. Both are refused; the kind is kept for audit. */
export const WORKFORCE_CLAIM_KINDS = ['capability', 'context'] as const
export type WorkforceClaimKind = (typeof WORKFORCE_CLAIM_KINDS)[number]

/** Whether a claim was honoured. Never `true` in this phase, and the type says so. */
export const WORKFORCE_CLAIM_DECISIONS = ['refused'] as const
export type WorkforceClaimDecision = (typeof WORKFORCE_CLAIM_DECISIONS)[number]

/* ---------------------------------------------------------------- claims */

/**
 * A worker's assertion about what it is allowed to do or know.
 *
 * Deliberately shaped so that **no field of it can become authority**: there is no
 * `granted`, no `principal`, no `capabilityList`, no `trust` and no `owner`. It
 * carries what was claimed and what Core decided about it, and the decision type has
 * exactly one member.
 */
export interface WorkforceClaim {
  readonly workerId: string
  readonly kind: WorkforceClaimKind
  /**
   * For `capability`, a name in the closed `Capability` vocabulary. For `context`, a
   * context reference id — an opaque id Core or Phase 9 issued, never context content.
   */
  readonly subject: string
}

/* ------------------------------------------------------------- messages */

/**
 * Why an agent sent a message.
 *
 * A closed enum because the *kind* of message is the only thing about it that is
 * durable, and it is what lets a reader tell "Alpha asked Beta for a finding" from
 * "Alpha told Beta it had been granted something" without reading a body. The second
 * is data. It is refused as authority wherever it appears.
 */
export const WORKFORCE_MESSAGE_KINDS = ['request', 'finding', 'handoff', 'status'] as const
export type WorkforceMessageKind = (typeof WORKFORCE_MESSAGE_KINDS)[number]

/**
 * One agent message, as the journal records it.
 *
 * `fromWorkerId` is assigned by Core from the scope that sent it and is never read
 * from a payload — that is the whole of attributability, and it is why
 * `sendMessage` takes a scope rather than a sender id. `bodyLength` is a measurement,
 * exactly like `conversation.turn.started`'s `contentLength`.
 */
export interface WorkforceMessageRecord {
  readonly messageId: string
  readonly fromWorkerId: string
  readonly toWorkerId: string
  readonly kind: WorkforceMessageKind
  readonly sentAt: string
  readonly bodyLength: number
  /** True when sender and recipient share a team. A routing fact, not an authority. */
  readonly sameTeam: boolean
}

/* ---------------------------------------------------------------- limits */

/**
 * The ceilings of this subsystem.
 *
 * Code-owned and unraisable. A caller may narrow a worker's *budgets* (below) and
 * may never raise one above these numbers, so the only place a limit exists is in
 * this repository.
 */
export const WORKFORCE_LIMITS = Object.freeze({
  /** Workers a Core may have at once. */
  maxWorkers: 32,
  /** Teams a Core may have at once. */
  maxTeams: 16,
  /** Members in one team. */
  maxMembersPerTeam: 16,
  /** Teams one worker may belong to. */
  maxTeamsPerWorker: 4,
  /** Context references one worker may be assigned. */
  maxContextRefsPerWorker: 16,
  /** Assignments a Core may have open at once, across every worker. */
  maxConcurrentAssignments: 8,
  /** Claims retained for the audit trail. The journal keeps all of them. */
  maxRetainedClaims: 200,
  /** Messages retained in a mailbox. The journal keeps every message's metadata. */
  maxMailboxMessages: 32,
  /** Characters in one worker name. */
  maxNameChars: 48,
  /** Characters in one team name. */
  maxTeamNameChars: 48,
  /** Characters in one agent message body. */
  maxMessageChars: 2_000,
})

const WORKFORCE_LIMIT_NAMES: readonly (keyof typeof WORKFORCE_LIMITS)[] = [
  'maxWorkers',
  'maxTeams',
  'maxMembersPerTeam',
  'maxTeamsPerWorker',
  'maxContextRefsPerWorker',
  'maxConcurrentAssignments',
  'maxRetainedClaims',
  'maxMailboxMessages',
  'maxNameChars',
  'maxTeamNameChars',
  'maxMessageChars',
]

/**
 * Apply a caller's *narrowed* global ceilings.
 *
 * Narrowing is allowed; raising is refused rather than clamped, for the reason
 * Mission's `missionLimits` refuses rather than clamps: a clamped "raise" would
 * silently accept a caller trying to lift a ceiling and record the number it asked
 * for, which is a lie in the audit trail.
 */
export function workforceLimits(
  overrides: Partial<Record<keyof typeof WORKFORCE_LIMITS, number>> = {},
): Readonly<Record<keyof typeof WORKFORCE_LIMITS, number>> {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('workforce limits are malformed')
  }
  const merged: Record<string, number> = { ...WORKFORCE_LIMITS }
  for (const [key, value] of Object.entries(overrides)) {
    if (!WORKFORCE_LIMIT_NAMES.includes(key as keyof typeof WORKFORCE_LIMITS)) {
      throw new Error(`unknown workforce limit: ${key}`)
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new Error(`workforce limit ${key} is not a positive integer`)
    }
    if (value > WORKFORCE_LIMITS[key as keyof typeof WORKFORCE_LIMITS]) {
      throw new Error(`workforce limit ${key} may not exceed its code-owned ceiling`)
    }
    merged[key] = value
  }
  return Object.freeze(merged as unknown as Record<keyof typeof WORKFORCE_LIMITS, number>)
}

/* --------------------------------------------------------------- budgets */

/**
 * What one worker may consume, over its whole life.
 *
 * Code-owned ceilings, narrowed per worker, and **frozen into the worker's durable
 * record at creation** — the same argument as `MissionRecord.limits`. A budget that
 * is read from live configuration is a budget that can be raised underneath a worker
 * that is mid-flight, and "we narrowed it last week" is not an authority anyone can
 * check.
 *
 * Spend is derived from the durable event stream, never from a caller-supplied
 * number. There is no `setSpent`, and there is no event that adds spend without the
 * action that caused it, so the only way to move a counter is to perform the work.
 */
export interface WorkerBudget {
  /** Assignments this worker may ever be given. */
  readonly maxAssignments: number
  /** Assignments this worker may hold open at once. */
  readonly maxOpenAssignments: number
  /** Wall-clock an open assignment may occupy before it is failed. */
  readonly maxAssignmentMs: number
  /** Cognition requests this worker may make. */
  readonly maxCognitionCalls: number
  /** Output tokens this worker may reserve, across every call. */
  readonly maxCognitionTokens: number
  /** Messages this worker may send. */
  readonly maxMessages: number
}

export const DEFAULT_WORKER_BUDGET: Readonly<WorkerBudget> = Object.freeze({
  maxAssignments: 32,
  maxOpenAssignments: 3,
  maxAssignmentMs: 15 * 60_000,
  maxCognitionCalls: 32,
  maxCognitionTokens: 32_000,
  maxMessages: 64,
})

const BUDGET_NAMES: readonly (keyof WorkerBudget)[] = [
  'maxAssignments',
  'maxOpenAssignments',
  'maxAssignmentMs',
  'maxCognitionCalls',
  'maxCognitionTokens',
  'maxMessages',
]

/** Apply narrowed per-worker budgets. Narrow only; a raise is refused, not clamped. */
export function workerBudget(overrides: Partial<WorkerBudget> = {}): Readonly<WorkerBudget> {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('worker budget is malformed')
  }
  const merged: Record<string, number> = { ...DEFAULT_WORKER_BUDGET }
  for (const [key, value] of Object.entries(overrides)) {
    if (!BUDGET_NAMES.includes(key as keyof WorkerBudget)) {
      throw new Error(`unknown worker budget: ${key}`)
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new Error(`worker budget ${key} is not a positive integer`)
    }
    if (value > DEFAULT_WORKER_BUDGET[key as keyof WorkerBudget]) {
      throw new Error(`worker budget ${key} may not exceed its code-owned ceiling`)
    }
    merged[key] = value
  }
  return Object.freeze(merged as unknown as WorkerBudget)
}

/**
 * What a worker has consumed, derived from the journal.
 *
 * A record of spend rather than a ceiling. It is recomputed by folding events, so it
 * cannot be inflated by a caller and cannot be reset by a restart — which matters
 * more here than it does elsewhere, because a budget a crash can refill is not a
 * budget.
 */
export interface WorkerSpend {
  readonly assignments: number
  readonly openAssignments: number
  readonly cognitionCalls: number
  readonly cognitionTokens: number
  readonly messages: number
}

export const EMPTY_WORKER_SPEND: Readonly<WorkerSpend> = Object.freeze({
  assignments: 0,
  openAssignments: 0,
  cognitionCalls: 0,
  cognitionTokens: 0,
  messages: 0,
})

/* --------------------------------------------------------------- records */

/**
 * What the journal knows about one worker.
 *
 * Durable, metadata only. `name` is present because it is Core's own label for its own
 * agent — the same argument as `brain.seeded`'s `identityName` — and it is bounded,
 * control-stripped and validated on the way in *and* on replay. A worker's *context*,
 * its messages and anything it says are not here.
 */
export interface WorkerRecord {
  readonly workerId: string
  readonly name: string
  readonly specialisation: WorkerSpecialisation
  readonly status: WorkerStatus
  readonly createdAt: string
  readonly activatedAt: string | null
  readonly settledAt: string | null
  /** Closed code for why this worker last changed status, or for a refusal. */
  readonly reason: WorkforceReason | null
  readonly budget: WorkerBudget
  readonly spend: WorkerSpend
  /** Capabilities Core has actually assigned. Always a subset of `WORKER_CAPABILITIES`. */
  readonly capabilities: readonly Capability[]
  /** Context reference ids assigned to this worker. Ids only, never context content. */
  readonly contextRefs: readonly string[]
  readonly teams: readonly string[]
  /** Assignments ever handed to this worker, in order. Never re-sorted. */
  readonly assignments: readonly string[]
  /** Ceilings this worker has hit. Durable, so a restart cannot hide one. */
  readonly limitsHit: readonly WorkforceLimitName[]
}

/** Which code-owned ceiling stopped something. Recorded, never inferred. */
export type WorkforceLimitName =
  | 'maxWorkers'
  | 'maxTeams'
  | 'maxMembersPerTeam'
  | 'maxTeamsPerWorker'
  | 'maxContextRefsPerWorker'
  | 'maxConcurrentAssignments'
  | 'maxAssignments'
  | 'maxOpenAssignments'
  | 'maxCognitionCalls'
  | 'maxCognitionTokens'
  | 'maxMessages'
  | 'maxAssignmentMs'

/** What the journal knows about one team. */
export interface TeamRecord {
  readonly teamId: string
  readonly name: string
  readonly specialisation: WorkerSpecialisation | null
  readonly status: TeamStatus
  readonly createdAt: string
  readonly settledAt: string | null
  readonly members: readonly string[]
}

/** What the journal knows about one assignment. */
export interface AssignmentRecord {
  readonly assignmentId: string
  readonly workerId: string
  readonly status: AssignmentStatus
  readonly createdAt: string
  readonly deadlineAt: string
  readonly settledAt: string | null
  readonly reason: WorkforceReason | null
  /** A mission this assignment serves, when Core attached one. An id. */
  readonly missionId: string | null
  /** Capabilities this assignment is scoped to. Always a subset of the worker's. */
  readonly capabilities: readonly Capability[]
  /** Context references this assignment may see. Ids only. */
  readonly contextRefs: readonly string[]
}

/** What the journal knows about one refused claim. */
export interface ClaimRecord {
  readonly claimId: string
  readonly workerId: string
  readonly kind: WorkforceClaimKind
  readonly subject: string
  readonly refusal: WorkforceClaimRefusal
  readonly decidedAt: string
}

/* ----------------------------------------------------------- projection */

export const WORKFORCE_ACTIONS = [
  'assign',
  'suspend',
  'resume',
  'stop',
  'retire',
  'assignCapability',
  'assignContext',
  'createTeam',
  'joinTeam',
  'leaveTeam',
  'readMessages',
] as const
export type WorkforceAction = (typeof WORKFORCE_ACTIONS)[number]

/** One worker as a board may know it. */
export interface WorkerView {
  readonly workerId: string
  readonly name: string
  readonly specialisation: WorkerSpecialisation
  readonly status: WorkerStatus
  readonly createdAt: string
  readonly settledAt: string | null
  readonly reason: WorkforceReason | null
  readonly teams: readonly string[]
  readonly capabilities: readonly Capability[]
  readonly contextRefs: readonly string[]
  readonly budget: WorkerBudget
  readonly spend: WorkerSpend
  /** What is left. Derived, never a promise. */
  readonly remaining: {
    readonly assignments: number
    readonly openAssignments: number
    readonly cognitionCalls: number
    readonly cognitionTokens: number
    readonly messages: number
  }
  /** What Core can actually do for this worker right now. The UI offers exactly this. */
  readonly availableActions: readonly WorkforceAction[]
  readonly limitsHit: readonly WorkforceLimitName[]
  readonly assignments: readonly AssignmentView[]
  /** Claims this worker has offered and been refused. Data, and visible as data. */
  readonly refusedClaims: number
}

export interface AssignmentView {
  readonly assignmentId: string
  readonly workerId: string
  readonly status: AssignmentStatus
  readonly createdAt: string
  readonly deadlineAt: string
  readonly settledAt: string | null
  readonly reason: WorkforceReason | null
  readonly missionId: string | null
  readonly capabilities: readonly Capability[]
  readonly contextRefs: readonly string[]
  readonly expired: boolean
}

export interface TeamView {
  readonly teamId: string
  readonly name: string
  readonly specialisation: WorkerSpecialisation | null
  readonly status: TeamStatus
  readonly createdAt: string
  readonly settledAt: string | null
  readonly members: readonly string[]
}

/**
 * One message as a worker reads it.
 *
 * A body is present because an agent has to be able to read what it was sent. It is
 * **never journalled and never projected wholesale** — `deliveries` only ever appears
 * on the worker the owner explicitly asked about, through `detail()`, and the standing
 * projection carries counts. That is the same rule Phase 3 uses for a transcript.
 */
export interface DeliveredMessage {
  readonly messageId: string
  readonly fromWorkerId: string
  readonly kind: WorkforceMessageKind
  readonly sentAt: string
  readonly bodyLength: number
  /** Present only while this process still holds the body. */
  readonly body: string | null
}

export interface WorkforceProjection {
  /**
   * `unavailable` before Core has a Workforce engine, `ready` once it does.
   *
   * Stated, because "there are no agents" and "there is no workforce" render the same
   * otherwise and they are very different things.
   */
  readonly health: 'unavailable' | 'ready'
  readonly reason: string | null
  /**
   * Whether this process still holds message bodies and mailboxes.
   *
   * False after a restart, and durably true forever after one: the journal kept every
   * message's metadata and none of their words. An office that rendered an empty
   * mailbox would read as "nobody has said anything", which is false.
   */
  readonly detailAvailable: boolean
  readonly workers: readonly WorkerView[]
  readonly teams: readonly TeamView[]
  readonly counts: {
    readonly workers: number
    readonly idle: number
    readonly working: number
    readonly blocked: number
    readonly stopped: number
    readonly retired: number
    readonly teams: number
    readonly openAssignments: number
    readonly messagesSent: number
    readonly refusedClaims: number
  }
  readonly limits: Readonly<Record<keyof typeof WORKFORCE_LIMITS, number>>
  /** Assigned assignments listed, out of how many exist, and how many are off screen. */
  readonly assignmentsRetained: number
  readonly assignmentsTotal: number
  readonly assignmentsHidden: number
  /** Message metadata retained for the projection, out of how many were ever sent. */
  readonly messagesRetained: number
  readonly messagesTotal: number
  readonly messagesHidden: number
  /** Highest sequence folded in, so a window can prove it is current. */
  readonly sequence: number
}

/** One worker with its mailbox, for the worker that is actually on screen. */
export interface WorkforceWorkerDetail extends WorkerView {
  /** Bounded, in arrival order, oldest first. Empty after a restart, and that is said. */
  readonly deliveries: readonly DeliveredMessage[]
  /** True when bodies are gone because the process restarted. */
  readonly bodiesAvailable: boolean
}

/* --------------------------------------------------------------- outcomes */

export type WorkforceOperation =
  | 'status'
  | 'worker-created'
  | 'worker-suspended'
  | 'worker-resumed'
  | 'worker-stopped'
  | 'worker-retired'
  | 'worker-refused'
  | 'team-created'
  | 'team-disbanded'
  | 'team-member-added'
  | 'team-member-removed'
  | 'assignment-created'
  | 'assignment-completed'
  | 'assignment-failed'
  | 'assignment-cancelled'
  | 'capability-assigned'
  | 'context-assigned'
  | 'claim-refused'
  | 'message-sent'
  | 'message-refused'
  | 'refused'

/**
 * What a Workforce command produced.
 *
 * Explicit operations rather than a boolean, for the reason Mission uses the same
 * shape: "the claim was refused", "there is no such worker" and "the budget was spent"
 * are three different answers and a caller that has to parse a reason string to tell
 * them apart is a caller that will eventually get it wrong.
 */
export interface WorkforceCommandOutcome {
  readonly operation: WorkforceOperation
  readonly ok: boolean
  readonly reason?: string
  readonly workerId?: string
  readonly teamId?: string
  readonly assignmentId?: string
  readonly messageId?: string
  readonly status?: WorkerStatus
}

/* ------------------------------------------------------------------ misc */

/**
 * The principal a worker acts as.
 *
 * Derived from the worker id rather than accepted from anywhere: a caller cannot say
 * which agent it is, for the same reason `core/authority.ts` has no `actor`
 * parameter. It is always `agent:<workerId>`, and Guard refuses it on `trusted` before
 * it looks at a single capability.
 */
export function workerPrincipalId(workerId: string): PrincipalId {
  return `agent:${workerId}`
}

/** The durable shape the fold produces and replay rebuilds. */
export interface WorkforceState {
  readonly workers: ReadonlyMap<string, WorkerRecord>
  readonly teams: ReadonlyMap<string, TeamRecord>
  readonly assignments: ReadonlyMap<string, AssignmentRecord>
  readonly claims: ReadonlyMap<string, ClaimRecord>
  /** Message metadata in send order. Never a body. */
  readonly messages: readonly WorkforceMessageRecord[]
  readonly sequence: number
}

/**
 * Which capabilities a specialisation may be assigned at all.
 *
 * Every entry is a subset of {@link WORKER_CAPABILITIES}, and that is the property the
 * whole table exists to guarantee: a specialisation is a *narrowing*, never a grant.
 * There is deliberately no entry that adds anything — today every one of these is
 * `['cognition.request']`, which is exactly what a subordinate agent may hold, and a
 * future capability appears here only if the owner may ever hold it for a worker.
 *
 * The check that enforces this is `isAssignableToWorker`, below, which refuses the
 * union rather than trusting each row.
 */
export const WORKFORCE_SPECIALISATION_SCOPES: Readonly<Record<WorkerSpecialisation, readonly Capability[]>> =
  Object.freeze({
    general: Object.freeze(['cognition.request'] as const),
    research: Object.freeze(['cognition.request'] as const),
    analysis: Object.freeze(['cognition.request'] as const),
    code: Object.freeze(['cognition.request'] as const),
    writing: Object.freeze(['cognition.request'] as const),
  })

/** The set of capabilities any worker could ever be assigned, given any specialisation. */
export const ASSIGNABLE_WORKER_CAPABILITIES: ReadonlySet<Capability> = Object.freeze(
  new Set<Capability>(WORKER_CAPABILITIES),
)

/**
 * Whether a capability may be assigned to a worker at all.
 *
 * The single gate, and it consults the *closed worker vocabulary* rather than each
 * specialisation's row. So a caller cannot widen a worker past
 * {@link WORKER_CAPABILITIES} by asking a different specialisation, and a specialisation
 * can only narrow below it.
 *
 * This is C8 in one function: Alpha, Beta and every future worker receive bounded
 * capabilities. They do not inherit Freya's authority or the user's information.
 */
export function isAssignableToWorker(capability: unknown): capability is Capability {
  return typeof capability === 'string' && ASSIGNABLE_WORKER_CAPABILITIES.has(capability as Capability)
}

/** Whether a specialisation narrows this capability. Always also checks the ceiling. */
export function specialisationAllows(
  specialisation: WorkerSpecialisation,
  capability: Capability,
): boolean {
  return WORKFORCE_SPECIALISATION_SCOPES[specialisation].includes(capability)
}

/**
 * Normalise a worker or team name.
 *
 * Bounded, control-stripped, trimmed. Identical in purpose to Mission's `clean`, and
 * for the same stated reason: a name ends up in window titles, board rows and
 * accessibility labels, and an escape sequence surviving into one of those is a way to
 * make a terminal say something Freya did not say.
 */
export function normaliseWorkforceName(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  let out = ''
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    const stripped = (code >= 0x00 && code <= 0x08) || (code >= 0x0b && code <= 0x0c) || (code >= 0x0e && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)
    if (!stripped) out += character
  }
  const trimmed = out.trim()
  if (trimmed.length === 0 || trimmed.length > max) return null
  return trimmed
}

/** Ids Core issued must look like ids: bounded, and free of whitespace and control bytes. */
const WORKFORCE_ID = /^[A-Za-z0-9._:-]{1,128}$/

export function isWorkforceId(value: unknown): value is string {
  return typeof value === 'string' && WORKFORCE_ID.test(value)
}

/**
 * Refuse a context reference that is not an id.
 *
 * Phase 9 owns what a context reference *is*. Phase 8's whole contribution is that it
 * is an **id**: a worker's assignment records which references it may resolve and the
 * engine never reads the content behind one. So this rejects anything that is not an
 * id before it can reach a projection.
 */
export function normaliseContextRef(value: unknown): string | null {
  return isWorkforceId(value) ? value : null
}